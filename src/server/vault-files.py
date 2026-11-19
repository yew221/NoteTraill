"""Read-only, descriptor-relative vault access. No paths or native exceptions in errors."""
import base64
from contextlib import contextmanager
import errno
import hashlib
import json
import os
import re
import stat
import sys
import time
import unicodedata

MAX_FILE = 100 * 1024 * 1024
DEFAULT_EXCLUSIONS = ('.obsidian', '.git', '.trash', '助手资料/提取文本')
FORMATS = {'.md': 'text/markdown', '.markdown': 'text/markdown', '.txt': 'text/plain', '.pdf': 'application/pdf',
           '.html': 'text/html', '.htm': 'text/html',
           '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
           '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
           '.xls': 'application/vnd.ms-excel'}


class Denied(Exception):
    def __init__(self, code):
        self.code = code


def relative(value, directory=False):
    if not isinstance(value, str) or not 1 <= len(value) <= 1024 or re.search(r'[\\\x00-\x1f\x7f\ud800-\udfff]', value):
        return False
    if directory and value.endswith('/'):
        value = value[:-1]
    return all(part not in ('', '.', '..') for part in value.split('/'))


def absolute(value):
    return isinstance(value, str) and value.startswith('/') and relative(value[1:])


def identity(info):
    return {'device': str(info.st_dev), 'inode': str(info.st_ino)}


def excluded(value, rules):
    canonical = lambda p: unicodedata.normalize('NFC', p.rstrip('/')).lower()
    value = canonical(value)
    if any(part in ('.obsidian', '.git', '.trash', '.ds_store') for part in value.split('/')):
        return True
    if any(part.startswith('.notetrail-') for part in value.split('/')):
        return True
    return any(value == canonical(rule) or value.startswith(canonical(rule) + '/')
               for rule in (*DEFAULT_EXCLUSIONS, *rules))


class Directories:
    """Keep every ancestor open so a later symlink swap cannot redirect a file open."""
    def __init__(self, root):
        self.chain = []
        try:
            self.chain.append(('', os.open('/', os.O_RDONLY | os.O_DIRECTORY)))
            for part in root[1:].split('/'):
                self.push(part)
        except BaseException:
            self.close()
            raise

    @property
    def fd(self):
        return self.chain[-1][1]

    def push(self, name):
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=self.fd)
        self.chain.append((name, fd))

    def pop(self):
        os.close(self.chain.pop()[1])

    def check(self):
        for i in range(1, len(self.chain)):
            name, fd = self.chain[i]
            current = os.stat(name, dir_fd=self.chain[i - 1][1], follow_symlinks=False)
            if not stat.S_ISDIR(current.st_mode) or identity(current) != identity(os.fstat(fd)):
                raise Denied('SOURCE_CHANGED')

    def close(self):
        while self.chain:
            self.pop()


@contextmanager
def opened_root(request):
    tree = Directories(request['root'])
    try:
        actual = identity(os.fstat(tree.fd))
        if request.get('identity') is not None and request['identity'] != actual:
            raise Denied('VAULT_ACCESS_DENIED')
        for protected in request['forbiddenRoots']:
            other = Directories(protected)
            try:
                # Check physical ancestors too: case/Unicode aliases must not bypass overlap checks.
                if actual in [identity(os.fstat(fd)) for _, fd in other.chain] or \
                        identity(os.fstat(other.fd)) in [identity(os.fstat(fd)) for _, fd in tree.chain]:
                    raise Denied('PATH_OUTSIDE_SCOPE')
                other.check()
            finally:
                other.close()
        tree.check()
        yield tree, actual
        tree.check()
    finally:
        tree.close()


def read_file(tree, name):
    tree.check()
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=tree.fd)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise Denied('PATH_OUTSIDE_SCOPE')
        if before.st_size > MAX_FILE:
            raise Denied('FILE_TOO_LARGE')
        parts, size = [], 0
        while chunk := os.read(fd, 64 * 1024):
            size += len(chunk)
            if size > MAX_FILE:
                raise Denied('FILE_TOO_LARGE')
            parts.append(chunk)
        signature = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)
        if signature(before) != signature(os.fstat(fd)) or \
                signature(before) != signature(os.stat(name, dir_fd=tree.fd, follow_symlinks=False)):
            raise Denied('SOURCE_CHANGED')
        tree.check()
        return b''.join(parts)
    finally:
        os.close(fd)


def fingerprint(info):
    return hashlib.sha256(str((info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                               info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)).encode()).hexdigest()


def file_record(tree, name, relative_path, info, metadata_only=False):
    result = {'relativePath': relative_path, 'bytes': info.st_size, 'fingerprint': fingerprint(info)}
    if metadata_only:
        return result
    extension = os.path.splitext(name)[1].lower()
    media = FORMATS.get(extension, 'application/octet-stream')
    version, warning, state = None, None, 'pending'
    try:
        content = read_file(tree, name)
        version = hashlib.sha256(content).hexdigest()
        if media in ('text/markdown', 'text/plain'):
            try:
                text = content.decode('utf-8-sig')
                if '\x00' in text:
                    raise UnicodeError()
                state, warning = ('ready', None) if text.strip() else ('failed', 'EXTRACTION_EMPTY')
            except UnicodeError:
                state, warning = 'failed', 'UNSUPPORTED_FORMAT'
        elif extension not in FORMATS:
            state, warning = 'unsupported', 'UNSUPPORTED_FORMAT'
    except Denied as error:
        if error.code != 'FILE_TOO_LARGE':
            raise
        state, warning = 'failed', error.code
    if fingerprint(os.stat(name, dir_fd=tree.fd, follow_symlinks=False)) != result['fingerprint']:
        raise Denied('SOURCE_CHANGED')
    return {**result, 'version': version, 'state': state, 'mediaType': media, 'warningCode': warning}


def derived_fingerprints(tree):
    """Stat owned artifacts only; unchanged stamps can reuse a previous full verification."""
    depth, parents, result = len(tree.chain), [], {}
    deadline, entries = time.monotonic() + 290, 0
    try:
        for name, marker in [('助手资料', '.notetrail-managed'), ('提取文本', '.notetrail-derived')]:
            tree.push(name)
            info = os.fstat(tree.fd)
            parents.append([identity(info), info.st_mode, info.st_uid, info.st_gid,
                            fingerprint(os.stat(marker, dir_fd=tree.fd, follow_symlinks=False))])
        with os.scandir(tree.fd) as listing:
            for entry in listing:
                entries += 1
                if entries > 100000 or time.monotonic() > deadline:
                    raise Denied('BUDGET_EXCEEDED')
                if not re.fullmatch(r's_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', entry.name):
                    continue
                source_depth = len(tree.chain)
                try:
                    tree.push(entry.name)
                    stamps = [parents, fingerprint(os.fstat(tree.fd))]
                    with os.scandir(tree.fd) as files:
                        names = []
                        for item in files:
                            entries += 1
                            if entries > 100000 or len(names) >= 10000 or time.monotonic() > deadline:
                                raise Denied('BUDGET_EXCEEDED')
                            names.append([item.name, fingerprint(os.stat(item.name, dir_fd=tree.fd, follow_symlinks=False))])
                    tree.check()
                    stamps.append(sorted(names))
                    result[entry.name] = hashlib.sha256(json.dumps(stamps, sort_keys=True).encode()).hexdigest()
                except OSError:
                    pass  # No stamp means the caller must perform the full check.
                finally:
                    while len(tree.chain) > source_depth:
                        tree.pop()
        tree.check()
    except OSError:
        return {}
    finally:
        while len(tree.chain) > depth:
            tree.pop()
    return result


def snapshot(tree, rules, emit=None, metadata_only=False, paths=None):
    items, skipped, entries, total = [], 0, 0, 0
    deadline = time.monotonic() + 290
    if paths is not None:
        for relative_path in paths:
            if excluded(relative_path, rules):
                raise Denied('SOURCE_EXCLUDED')
            depth = len(tree.chain)
            try:
                parts = relative_path.split('/')
                for part in parts[:-1]:
                    tree.push(part)
                info = os.stat(parts[-1], dir_fd=tree.fd, follow_symlinks=False)
                items.append(file_record(tree, parts[-1], relative_path, info))
            finally:
                while len(tree.chain) > depth:
                    tree.pop()
        return {'items': items, 'skipped': 0, 'derived': {}}

    def walk(prefix='', depth=0):
        nonlocal skipped, entries, total, items
        if depth > 64 or time.monotonic() > deadline:
            raise Denied('DEADLINE_EXCEEDED')
        tree.check()
        with os.scandir(tree.fd) as listing:
            for entry in listing:
                entries += 1
                if entries > 100000 or time.monotonic() > deadline:
                    raise Denied('BUDGET_EXCEEDED')
                relative_path = prefix + entry.name
                if not relative(relative_path) or excluded(relative_path, rules):
                    skipped += 1
                    continue
                info = os.stat(entry.name, dir_fd=tree.fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    tree.push(entry.name)
                    try:
                        walk(relative_path + '/', depth + 1)
                    finally:
                        tree.pop()
                    continue
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    skipped += 1
                    continue
                total += 1
                if total > 50000:
                    raise Denied('BUDGET_EXCEEDED')
                items.append(file_record(tree, entry.name, relative_path, info, metadata_only))
                if emit and len(items) == 100:
                    emit(items)
                    items = []
        tree.check()
    walk()
    return {'items': sorted(items, key=lambda item: item['relativePath']), 'skipped': skipped, 'derived': derived_fingerprints(tree)}


def operate(request, emit=None):
    common = {'op', 'root', 'forbiddenRoots', 'exclusions'}
    if not isinstance(request, dict) or request.get('op') not in ('inspect', 'snapshot', 'inventory', 'read', 'missing'):
        raise Denied('BAD_REQUEST')
    required = common | ({'identity'} if request['op'] != 'inspect' else set()) | \
        ({'relativePath', 'expectedVersion'} if request['op'] == 'read' else
         {'relativePath'} if request['op'] == 'missing' else set())
    if request['op'] == 'snapshot' and 'paths' in request:
        required.add('paths')
        if not isinstance(request['paths'], list) or not 1 <= len(request['paths']) <= 16 or \
                not all(relative(p) for p in request['paths']) or len(set(request['paths'])) != len(request['paths']):
            raise Denied('BAD_REQUEST')
    if set(request) != required or not absolute(request['root']) or \
            not isinstance(request['forbiddenRoots'], list) or not 1 <= len(request['forbiddenRoots']) <= 4 or \
            not all(absolute(p) for p in request['forbiddenRoots']) or \
            not isinstance(request['exclusions'], list) or len(request['exclusions']) > 50 or \
            not all(relative(p, True) for p in request['exclusions']):
        raise Denied('BAD_REQUEST')
    if request['op'] != 'inspect' and (not isinstance(request['identity'], dict) or
            set(request['identity']) != {'device', 'inode'} or
            not all(isinstance(x, str) and re.fullmatch(r'[0-9]{1,30}', x) for x in request['identity'].values())):
        raise Denied('BAD_REQUEST')
    if request['op'] == 'read' and (not relative(request['relativePath']) or
            not isinstance(request['expectedVersion'], str) or not re.fullmatch(r'[0-9a-f]{64}', request['expectedVersion'])):
        raise Denied('BAD_REQUEST')
    if request['op'] == 'missing' and not relative(request['relativePath']):
        raise Denied('BAD_REQUEST')
    if sys.version_info[:2] != (3, 12) or os.open not in os.supports_dir_fd or os.scandir not in os.supports_fd:
        raise Denied('SERVICE_UNAVAILABLE')
    with opened_root(request) as (tree, actual):
        if request['op'] == 'inspect':
            return actual
        if request['op'] in ('snapshot', 'inventory'):
            return snapshot(tree, request['exclusions'], emit, request['op'] == 'inventory', request.get('paths'))
        if excluded(request['relativePath'], request['exclusions']):
            raise Denied('SOURCE_EXCLUDED')
        parts = request['relativePath'].split('/')
        if request['op'] == 'missing':
            try:
                for part in parts[:-1]:
                    tree.push(part)
                os.stat(parts[-1], dir_fd=tree.fd, follow_symlinks=False)
                return False
            except OSError as error:
                if error.errno == errno.ENOENT:
                    return True
                if error.errno in (errno.ELOOP, errno.ENOTDIR):
                    return False
                raise
        for part in parts[:-1]:
            tree.push(part)
        content = read_file(tree, parts[-1])
        version = hashlib.sha256(content).hexdigest()
        if version != request['expectedVersion']:
            raise Denied('SOURCE_CHANGED')
        return {'version': version, 'base64': base64.b64encode(content).decode('ascii')}


def main():
    try:
        raw = sys.stdin.buffer.read(131073)
        if len(sys.argv) != 1 or len(raw) > 131072:
            raise Denied('BAD_REQUEST')
        def emit(items):
            sys.stdout.write(json.dumps({'batch': items}, ensure_ascii=True, separators=(',', ':')) + '\n')
            sys.stdout.flush()
        result = {'ok': True, 'value': operate(json.loads(raw), emit)}
    except Denied as error:
        result = {'ok': False, 'error': error.code}
    except OSError as error:
        code = 'SOURCE_MISSING' if error.errno == errno.ENOENT else \
            'PATH_OUTSIDE_SCOPE' if error.errno in (errno.ELOOP, errno.ENOTDIR) else 'VAULT_ACCESS_DENIED'
        result = {'ok': False, 'error': code}
    except Exception:
        result = {'ok': False, 'error': 'SERVICE_UNAVAILABLE'}
    sys.stdout.write(json.dumps(result, ensure_ascii=True, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
