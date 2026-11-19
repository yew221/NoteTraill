#!/usr/bin/env python3
"""T01-A: run the locked extractor on eight fixed public fixtures, without a model."""

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/public/t00'
CASES = ROOT / 'tests/conversion_cases.json'
LOCK = ROOT / 'scripts/conversion-requirements.lock'
MAX_INPUT = 20 * 1024 * 1024
MAX_OUTPUT = 5 * 1024 * 1024
TIMEOUT = 60


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def checked_input(base, case, record):
    relative = Path(case['path'])
    if relative.is_absolute() or '..' in relative.parts or record['path'] != case['path']:
        raise ValueError('fixture path is outside the fixed manifest')
    path = base
    for part in relative.parts:
        path = path / part
        if path.is_symlink():
            raise ValueError('fixture symlinks are not allowed')
    if not path.is_file() or not path.resolve().is_relative_to(base.resolve()):
        raise ValueError('fixture is not a regular file in the public sample directory')
    if path.stat().st_size > MAX_INPUT:
        raise ValueError('fixture exceeds the 20 MiB input limit')
    data = path.read_bytes()
    if len(data) != record['bytes'] or sha256(data) != record['sha256']:
        raise ValueError('fixture content differs from the T00 version')
    return path


def create_run_dir(root, run_id):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}', run_id):
        raise ValueError('run ID must be 1-64 letters, digits, underscores or hyphens')
    directory = root
    for part in ('outputs', 't01', 'conversion'):
        directory = directory / part
        if directory.is_symlink():
            raise ValueError('output directory must not be a symlink')
        directory.mkdir(exist_ok=True)
    directory = directory / run_id
    directory.mkdir(exist_ok=False)
    return directory


def environment_inventory():
    if sys.version_info[:2] != (3, 12):
        raise ValueError('run this check with Python 3.12 and the locked MarkItDown environment')
    packages = []
    for line in LOCK.read_text().splitlines():
        if not line or line.startswith('#'):
            continue
        name, pinned = line.split('==')
        installed = metadata.version(name)
        if installed != pinned:
            raise ValueError(f'{name}: expected {pinned}, found {installed}')
        info = metadata.metadata(name)
        license_name = info.get('License-Expression') or info.get('License')
        if not license_name:
            license_name = '; '.join(x for x in info.get_all('Classifier', []) if x.startswith('License ::')) or 'not declared in metadata'
        packages.append({'name': name, 'version': installed, 'license_metadata': license_name.splitlines()[0][:200]})
    return {'python': sys.version.split()[0], 'platform': sys.platform, 'architecture': os.uname().machine,
            'packages': packages, 'plugins': False, 'cloud_clients': False}


def worker(path):
    from markitdown import MarkItDown, UnsupportedFormatException

    try:
        result = MarkItDown(enable_plugins=False).convert_local(path)
        text = result.markdown
        if len(text.encode('utf-8')) > MAX_OUTPUT:
            return {'status': 'output_limit', 'text': ''}
        return {'status': 'converted' if text.strip() else 'empty', 'text': text}
    except UnsupportedFormatException as exc:
        return {'status': 'unsupported', 'text': '', 'error_type': type(exc).__name__}
    except Exception as exc:
        # Keep parser exception text/tracebacks out of the protocol; sample context is in the report.
        return {'status': 'failed', 'text': '', 'error_type': type(exc).__name__}


def run_worker(path, timeout=TIMEOUT):
    command = [sys.executable, '-I', '-B', str(Path(__file__).resolve()), '--worker', str(path)]
    # No inherited model credentials, proxy configuration, Python paths or optional cloud endpoints.
    environment = {'PATH': os.defpath, 'LANG': 'en_US.UTF-8'}
    started = time.monotonic()
    try:
        proc = subprocess.run(command, capture_output=True, text=True, encoding='utf-8',
                              errors='replace', timeout=timeout, env=environment, check=False)
        if proc.returncode:
            result = {'status': 'worker_error', 'text': '', 'exit_code': proc.returncode}
        else:
            result = json.loads(proc.stdout)
            if not isinstance(result.get('text'), str) or result.get('status') not in {
                'converted', 'empty', 'unsupported', 'failed', 'output_limit'
            }:
                raise ValueError('invalid worker result')
            if len(result['text'].encode('utf-8')) > MAX_OUTPUT:
                result = {'status': 'output_limit', 'text': ''}
    except subprocess.TimeoutExpired:
        result = {'status': 'timeout', 'text': ''}
    except (ValueError, TypeError, AttributeError):
        result = {'status': 'invalid_protocol', 'text': ''}
    result['elapsed_ms'] = round((time.monotonic() - started) * 1000)
    return result


def compact(text):
    return re.sub(r'\s+', '', text)


def table_rows(text):
    rows = []
    for line in text.splitlines():
        if line.strip().startswith('|'):
            cells = [compact(cell) for cell in line.strip().strip('|').split('|')]
            cells = [cell[2:-2] if cell.startswith('**') and cell.endswith('**') else cell for cell in cells]
            rows.append([re.sub(r'^(\d+)\.0+$', r'\1', cell) for cell in cells])
    return rows


def assess(case, observed):
    """Compare the known fixture oracle; this is not general production quality detection."""
    kind, status, text = case['expectation'], observed['status'], observed.get('text', '')
    checks = []

    def check(name, passed):
        checks.append({'check': name, 'passed': bool(passed)})

    if kind in ('complete', 'known_partial'):
        check('extractor returned text', status == 'converted')
        for phrase in case.get('contains', []):
            check('text: ' + phrase, compact(phrase) in compact(text))
        for row in case.get('rows', []):
            check('row: ' + ' / '.join(row), [compact(x) for x in row] in table_rows(text))
        headings = list(re.finditer(r'^#{1,6}\s+(.+?)\s*$', text, re.MULTILINE))
        for sheet, rows in case.get('sheets', {}).items():
            matches = [i for i, h in enumerate(headings) if h.group(1).strip() == sheet]
            check('one worksheet: ' + sheet, len(matches) == 1)
            section = ''
            if len(matches) == 1:
                i = matches[0]
                section = text[headings[i].end():headings[i + 1].start() if i + 1 < len(headings) else len(text)]
            for row in rows:
                check(sheet + ': ' + ' / '.join(row), [compact(x) for x in row] in table_rows(section))
        if kind == 'known_partial':
            for phrase in case['unread_image_truth']:
                check('known image content absent: ' + phrase, compact(phrase) not in compact(text))
    elif kind == 'rejected_corrupt':
        check('corrupt input rejected', status in ('unsupported', 'failed') and
              observed.get('error_type') in ('UnsupportedFormatException', 'FileConversionException', 'BadZipFile'))
    else:
        check('expected ' + kind, status == kind)
    passed = all(item['passed'] for item in checks)
    return {'passed': passed, 'quality': ('partial' if kind == 'known_partial' else
            'complete_for_checked_evidence' if kind == 'complete' else 'not_readable') if passed else 'unexpected',
            'checks': checks, 'warning': case.get('warning')}


def write_report(directory, report):
    (directory / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    lines = ['# T01-A 实际转换结果', '', f"运行：{report['run_id']}；Python {report['environment']['python']}。",
             '', '这是固定公开样本的转换验证；不代表问答、入库或全部T01通过。partial来自已知样本比对，不能外推自动检漏能力。',
             '', '| 样本 | 转换器实际结果 | 依据检查 | 内容判断 | 耗时ms | 提取文本 |', '| --- | --- | --- | --- | --- | --- |']
    failures = []
    for r in report['results']:
        link = f"[{r['id']}.md]({r['id']}.md)" if r['text_file'] else '无'
        lines.append(f"| {r['id']} | {r['status']} | {'通过' if r['assessment']['passed'] else '失败'} | {r['assessment']['quality']} | {r['elapsed_ms']} | {link} |")
        for item in r['assessment']['checks']:
            if not item['passed']:
                failures.append(f"{r['id']} 未通过：{item['check']}。")
    if failures:
        lines += ['', *failures]
    lines += ['', '详细指纹、逐项检查、错误类型和环境版本见 [report.json](report.json)。',
              '原始记录按T00规则保留30天后列清理清单；未解决失败证据继续保留。']
    (directory / 'REPORT.md').write_text('\n'.join(lines) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', help='unique name; results stay under outputs/t01/conversion/')
    parser.add_argument('--worker', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    cases = json.loads(CASES.read_text())['cases']
    records = {x['id']: x for x in json.loads((FIXTURES / 'versions.json').read_text())['files']}
    paths = {c['id']: checked_input(FIXTURES, c, records[c['id']]) for c in cases}
    if args.worker:
        if args.worker not in paths.values():
            parser.error('worker accepts only the eight fixed public fixtures')
        print(json.dumps(worker(args.worker), ensure_ascii=False))
        return 0
    environment = environment_inventory()
    run_id = args.run_id or datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    directory = create_run_dir(ROOT, run_id)
    results = []
    for case in cases:
        observed = run_worker(paths[case['id']])
        text = observed.pop('text')
        assessment = assess(case, {**observed, 'text': text})
        unchanged = sha256(paths[case['id']].read_bytes()) == records[case['id']]['sha256']
        assessment['checks'].append({'check': 'source unchanged', 'passed': unchanged})
        assessment['passed'] = assessment['passed'] and unchanged
        if not unchanged:
            assessment['quality'] = 'unexpected'
        text_file = case['id'] + '.md' if observed['status'] in ('converted', 'empty') else None
        if text_file:
            (directory / text_file).write_text(text, encoding='utf-8')
        results.append({'id': case['id'], 'source_path': case['path'],
                        'source_sha256': records[case['id']]['sha256'], **observed,
                        'text_file': text_file, 'text_sha256': sha256(text.encode()) if text_file else None,
                        'assessment': assessment})
    report = {'run_id': run_id, 'environment': environment, 'model_calls': 0,
              'verification_versions': {str(path.relative_to(ROOT)): sha256(path.read_bytes())
                                        for path in (Path(__file__).resolve(), CASES, LOCK, FIXTURES / 'versions.json')},
              'limits': {'input_bytes': MAX_INPUT, 'output_bytes': MAX_OUTPUT, 'timeout_seconds': TIMEOUT},
              'results': results, 'passed': all(r['assessment']['passed'] for r in results)}
    write_report(directory, report)
    print(f"{'PASS' if report['passed'] else 'FAIL'}: {sum(r['assessment']['passed'] for r in results)}/{len(results)} fixture checks")
    print(directory / 'REPORT.md')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError, metadata.PackageNotFoundError) as exc:
        print(f'Preflight failed: {exc}', file=sys.stderr)
        raise SystemExit(2)
