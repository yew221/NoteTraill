"""Local extraction and owned derived files; original bytes are only read through the vault gateway."""
import base64
from contextlib import contextmanager, redirect_stdout
import errno
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

spec = importlib.util.spec_from_file_location('intake', Path(__file__).with_name('ingest-files.py'))
intake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(intake)
gateway, Denied = intake.gateway, intake.Denied
MAX_OUTPUT = 20 * 1024 * 1024
EXTRACTOR = 'markitdown/0.1.9;notetrail/1'
HASH = r'[0-9a-f]{64}'


def original(request):
    return gateway.operate({'op': 'read', **{key: request[key] for key in
        ('root', 'identity', 'exclusions', 'forbiddenRoots', 'relativePath', 'expectedVersion')}})




@contextmanager
def derived_directory(request, create):
    with gateway.opened_root(request) as (tree, _):
        fcntl.flock(tree.fd, fcntl.LOCK_EX)
        vault_marker = json.dumps({'vaultId': request['vaultId']}, sort_keys=True).encode()
        source_marker = json.dumps({'vaultId': request['vaultId'], 'sourceId': request['sourceId']}, sort_keys=True).encode()
        for name, marker, content in [('助手资料', '.notetrail-managed', vault_marker),
                                      ('提取文本', '.notetrail-derived', vault_marker),
                                      (request['sourceId'], '.notetrail-derived-source', source_marker)]:
            if not intake.owned_directory(tree, name, marker, content, create):
                yield None
                return
        yield tree


def receipt_name(version):
    return '.notetrail-conversion-' + version + '.json'


def inspect_versions(tree, request):
    """Keep old versions too: changing the original must not bypass protection of edited derivatives."""
    names = os.listdir(tree.fd)
    if len(names) > 10000:
        raise Denied('BUDGET_EXCEEDED')
    results = {}
    for name in names:
        if name.startswith('.notetrail-'):
            continue
        if not re.fullmatch(HASH + r'\.md', name):
            raise Denied('DERIVED_MODIFIED')
        version = name[:-3]
        try:
            receipt = json.loads(gateway.read_file(tree, receipt_name(version)))
            content = gateway.read_file(tree, name)
            if len(content) > MAX_OUTPUT or set(receipt) != {'sourceId', 'sourceVersion', 'state', 'warningCodes', 'hash', 'extractorVersion'} or \
                    receipt['sourceId'] != request['sourceId'] or receipt['sourceVersion'] != version or \
                    receipt['state'] not in ('ready', 'partial') or receipt['extractorVersion'] != EXTRACTOR or \
                    receipt['warningCodes'] != (['EXTRACTION_PARTIAL'] if receipt['state'] == 'partial' else []) or \
                    receipt['hash'] != intake.digest(content):
                raise Denied('DERIVED_MODIFIED')
            results[version] = (receipt, content)
        except (OSError, ValueError, TypeError, KeyError):
            raise Denied('DERIVED_MODIFIED')
    return results


def projection(request, receipt):
    return {key: receipt[key] for key in ('state', 'warningCodes', 'hash', 'extractorVersion')} | \
        {'relativePath': f"助手资料/提取文本/{request['sourceId']}/{request['expectedVersion']}.md"}


def derived(request):
    original(request)  # A derived path never grants access without a live, allowed original.
    create = request['op'] == 'derived_publish'
    with derived_directory(request, create) as tree:
        if tree is None:
            return None
        versions = inspect_versions(tree, request)
        existing = versions.get(request['expectedVersion'])
        if existing:
            receipt, content = existing
            if request['expectedHash'] is not None and receipt['hash'] != request['expectedHash']:
                raise Denied('DERIVED_MODIFIED')
            original(request)
            result = projection(request, receipt)
            if request['op'] == 'derived_read':
                result['base64'] = base64.b64encode(content).decode('ascii')
            return result
        if not create:
            return None
        try:
            content = base64.b64decode(request['base64'], validate=True)
        except ValueError:
            raise Denied('BAD_REQUEST')
        if len(content) > MAX_OUTPUT or intake.digest(content) != request['expectedHash']:
            raise Denied('BAD_REQUEST')
        receipt = {key: request[key] for key in ('sourceId', 'state', 'warningCodes')}
        receipt.update(sourceVersion=request['expectedVersion'], hash=request['expectedHash'], extractorVersion=EXTRACTOR)
        saved = json.dumps(receipt, sort_keys=True).encode()
        name = receipt_name(request['expectedVersion'])
        try:
            old = gateway.read_file(tree, name)
        except FileNotFoundError:
            intake.write_new(tree, name, saved)
            os.fsync(tree.fd)
        else:
            if old != saved:
                raise Denied('DERIVED_MODIFIED')
        original(request)
        intake.publish_new(tree, request['expectedVersion'] + '.md', content)
        original(request)
        if gateway.read_file(tree, request['expectedVersion'] + '.md') != content:
            raise Denied('DERIVED_MODIFIED')
        return projection(request, receipt)


def operate(request):
    common = {'op', 'root', 'identity', 'exclusions', 'forbiddenRoots', 'vaultId', 'sourceId', 'relativePath', 'expectedVersion'}
    if not isinstance(request, dict) or request.get('op') not in ('derived_check', 'derived_read', 'derived_publish'):
        raise Denied('BAD_REQUEST')
    fields = common | {'expectedHash'} | \
        ({'base64', 'state', 'warningCodes'} if request['op'] == 'derived_publish' else set())
    if set(request) != fields or not isinstance(request['vaultId'], str) or not re.fullmatch('v_' + intake.UUID, request['vaultId']) or \
            not isinstance(request['sourceId'], str) or not re.fullmatch('s_' + intake.UUID, request['sourceId']):
        raise Denied('BAD_REQUEST')
    if sys.version_info[:2] != (3, 12) or sys.platform != 'darwin':
        raise Denied('SERVICE_UNAVAILABLE')
    if request['expectedHash'] is not None and \
            (not isinstance(request['expectedHash'], str) or not re.fullmatch(HASH, request['expectedHash'])):
        raise Denied('BAD_REQUEST')
    if request['op'] == 'derived_publish' and (not isinstance(request['base64'], str) or
            request['expectedHash'] is None or request['state'] not in ('ready', 'partial') or
            request['warningCodes'] != (['EXTRACTION_PARTIAL'] if request['state'] == 'partial' else [])):
        raise Denied('BAD_REQUEST')
    return derived(request)


def main():
    try:
        raw = sys.stdin.buffer.read(28 * 1024 * 1024 + 1)
        if len(sys.argv) != 1 or len(raw) > 28 * 1024 * 1024:
            raise Denied('BAD_REQUEST')
        with redirect_stdout(sys.stderr):
            value = operate(json.loads(raw))
        result = {'ok': True, 'value': value}
    except Denied as error:
        result = {'ok': False, 'error': error.code}
    except OSError as error:
        code = 'SOURCE_MISSING' if error.errno == errno.ENOENT else \
            'PATH_OUTSIDE_SCOPE' if error.errno in (errno.ELOOP, errno.ENOTDIR) else \
            'DERIVED_MODIFIED' if error.errno == errno.EEXIST else 'VAULT_ACCESS_DENIED'
        result = {'ok': False, 'error': code}
    except Exception:
        result = {'ok': False, 'error': 'SERVICE_UNAVAILABLE'}
    sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')


if __name__ == '__main__':
    main()
