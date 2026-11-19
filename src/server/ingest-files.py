"""Stage bytes privately and publish a new original without replacing any existing file."""
import base64
from contextlib import contextmanager
import ctypes
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

spec = importlib.util.spec_from_file_location('vault_files', Path(__file__).with_name('vault-files.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
Denied = gateway.Denied
MAX_FILE = gateway.MAX_FILE
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'


def write_new(tree, name, content):
    tree.check()
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=tree.fd)
    try:
        remaining = memoryview(content)
        while remaining:
            size = os.write(fd, remaining)
            remaining = remaining[size:]
        os.fsync(fd)
        tree.check()
    finally:
        os.close(fd)


def owned_directory(tree, name, marker, content, create):
    try:
        tree.push(name)
    except FileNotFoundError:
        if not create:
            return False
        os.mkdir(name, 0o700, dir_fd=tree.fd)
        os.fsync(tree.fd)
        tree.push(name)
    try:
        saved = gateway.read_file(tree, marker)
    except FileNotFoundError:
        if not create or os.listdir(tree.fd):
            raise Denied('VAULT_ACCESS_DENIED')
        write_new(tree, marker, content)
        os.fsync(tree.fd)
        saved = content
    if saved != content:
        raise Denied('VAULT_ACCESS_DENIED')
    return True


@contextmanager
def staging(request, create=False):
    tree = gateway.Directories(request['storageRoot'])
    try:
        fcntl.flock(tree.fd, fcntl.LOCK_EX)
        info = os.fstat(tree.fd)
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700 or \
                gateway.read_file(tree, '.notetrail-data') != b'NoteTrail application data v1\n':
            raise Denied('VAULT_ACCESS_DENIED')
        if not owned_directory(tree, 'staging', '.notetrail-staging', b'NoteTrail staging v1\n', create):
            raise Denied('SOURCE_MISSING')
        yield tree
        tree.check()
    finally:
        tree.close()


def digest(content):
    return hashlib.sha256(content).hexdigest()


def publish_new(tree, name, content):
    temporary = '.notetrail-temp-' + str(uuid.uuid4())
    write_new(tree, temporary, content)
    tree.check()
    # macOS SDK sys/stdio.h: RENAME_EXCL = 0x4; fail if the destination exists.
    rename = ctypes.CDLL(None, use_errno=True).renameatx_np
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(tree.fd, os.fsencode(temporary), tree.fd, os.fsencode(name), 0x4) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    os.fsync(tree.fd)
    tree.check()


def publish(request):
    location = {key: request[key] for key in ('root', 'identity', 'exclusions', 'forbiddenRoots')}
    target = f"助手资料/原件/{request['sourceId']}/{request['filename']}"
    if gateway.excluded(target, request['exclusions']):
        raise Denied('SOURCE_EXCLUDED')
    create = request['op'] == 'publish'
    with gateway.opened_root(location) as (tree, _):
        fcntl.flock(tree.fd, fcntl.LOCK_EX)
        marker = json.dumps({'vaultId': request['vaultId']}, sort_keys=True).encode()
        if not owned_directory(tree, '助手资料', '.notetrail-managed', marker, create):
            return {'saved': False}
        try:
            tree.push('原件')
        except FileNotFoundError:
            if not create:
                return {'saved': False}
            os.mkdir('原件', 0o700, dir_fd=tree.fd)
            os.fsync(tree.fd)
            tree.push('原件')
        receipt = json.dumps({key: request[key] for key in ('vaultId', 'sourceId', 'operationId', 'version', 'filename')}, sort_keys=True).encode()
        if not owned_directory(tree, request['sourceId'], '.notetrail-source', receipt, create):
            return {'saved': False}
        try:
            existing = gateway.read_file(tree, request['filename'])
        except FileNotFoundError:
            existing = None
        if existing is not None:
            if digest(existing) != request['version']:
                raise Denied('SOURCE_CHANGED')
            return {'saved': True}
        if not create:
            return {'saved': False}
        with staging(request) as stage:
            content = gateway.read_file(stage, request['operationId'] + '.bin')
        if digest(content) != request['version']:
            raise Denied('SOURCE_CHANGED')
        publish_new(tree, request['filename'], content)
        if digest(gateway.read_file(tree, request['filename'])) != request['version']:
            raise Denied('SOURCE_CHANGED')
        return {'saved': True}


def operate(request):
    common = {'op', 'storageRoot', 'operationId', 'version', 'forbiddenRoots'}
    if not isinstance(request, dict) or request.get('op') not in ('stage', 'discard', 'publish', 'recover'):
        raise Denied('BAD_REQUEST')
    fields = common | ({'base64'} if request['op'] == 'stage' else set()) | \
        ({'root', 'identity', 'exclusions', 'vaultId', 'sourceId', 'filename'} if request['op'] in ('publish', 'recover') else set())
    if set(request) != fields or not gateway.absolute(request['storageRoot']) or \
            not isinstance(request['operationId'], str) or not re.fullmatch('op_' + UUID, request['operationId']) or \
            not isinstance(request['version'], str) or not re.fullmatch(r'[0-9a-f]{64}', request['version']) or \
            not isinstance(request['forbiddenRoots'], list) or not 1 <= len(request['forbiddenRoots']) <= 4 or \
            not all(gateway.absolute(root) for root in request['forbiddenRoots']):
        raise Denied('BAD_REQUEST')
    if sys.version_info[:2] != (3, 12) or sys.platform != 'darwin':
        raise Denied('SERVICE_UNAVAILABLE')
    if request['op'] in ('publish', 'recover'):
        if not gateway.absolute(request['root']) or \
                not isinstance(request['identity'], dict) or set(request['identity']) != {'device', 'inode'} or \
                not all(isinstance(v, str) and re.fullmatch(r'[0-9]{1,30}', v) for v in request['identity'].values()) or \
                not isinstance(request['exclusions'], list) or len(request['exclusions']) > 50 or \
                not all(gateway.relative(rule, True) for rule in request['exclusions']) or \
                not isinstance(request['vaultId'], str) or not re.fullmatch('v_' + UUID, request['vaultId']) or \
                not isinstance(request['sourceId'], str) or not re.fullmatch('s_' + UUID, request['sourceId']) or \
                not gateway.relative(request['filename']) or '/' in request['filename'] or \
                request['filename'].lower().startswith('.notetrail-'):
            raise Denied('BAD_REQUEST')
        return publish(request)
    if request['op'] == 'stage':
        if not isinstance(request['base64'], str):
            raise Denied('BAD_REQUEST')
        try:
            content = base64.b64decode(request['base64'], validate=True)
        except ValueError:
            raise Denied('BAD_REQUEST')
        if len(content) > MAX_FILE:
            raise Denied('FILE_TOO_LARGE')
        if digest(content) != request['version']:
            raise Denied('BAD_REQUEST')
        with staging(request, True) as tree:
            write_new(tree, request['operationId'] + '.bin', content)
            os.fsync(tree.fd)
        return {'staged': True}
    with staging(request) as tree:
        name = request['operationId'] + '.bin'
        try:
            content = gateway.read_file(tree, name)
        except FileNotFoundError:
            return {'discarded': True}
        if digest(content) != request['version']:
            raise Denied('SOURCE_CHANGED')
        os.unlink(name, dir_fd=tree.fd)
        os.fsync(tree.fd)
    return {'discarded': True}


def main():
    try:
        raw = sys.stdin.buffer.read(140 * 1024 * 1024 + 1)
        if len(sys.argv) != 1 or len(raw) > 140 * 1024 * 1024:
            raise Denied('BAD_REQUEST')
        result = {'ok': True, 'value': operate(json.loads(raw))}
    except Denied as error:
        result = {'ok': False, 'error': error.code}
    except OSError as error:
        code = 'SOURCE_MISSING' if error.errno == errno.ENOENT else \
            'PATH_OUTSIDE_SCOPE' if error.errno in (errno.ELOOP, errno.ENOTDIR) else \
            'SOURCE_CHANGED' if error.errno == errno.EEXIST else 'VAULT_ACCESS_DENIED'
        result = {'ok': False, 'error': code}
    except Exception:
        result = {'ok': False, 'error': 'SERVICE_UNAVAILABLE'}
    sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
