import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import verify_conversion as conversion


CASES = {c['id']: c for c in json.loads(conversion.CASES.read_text())['cases']}


class InputAndOutputBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        (self.base / 'sample.pdf').write_bytes(b'fixed sample')
        self.case = {'path': 'sample.pdf'}
        self.record = {'path': 'sample.pdf', 'bytes': 12,
                       'sha256': hashlib.sha256(b'fixed sample').hexdigest()}

    def test_hash_change_is_rejected(self):
        conversion.checked_input(self.base, self.case, self.record)
        (self.base / 'sample.pdf').write_bytes(b'edited sample')
        with self.assertRaisesRegex(ValueError, 'differs'):
            conversion.checked_input(self.base, self.case, self.record)

    def test_escape_and_symlink_are_rejected(self):
        for relative in ('../sample.pdf', str(self.base / 'sample.pdf')):
            with self.subTest(relative=relative), self.assertRaises(ValueError):
                conversion.checked_input(self.base, {'path': relative}, {**self.record, 'path': relative})
        (self.base / 'alias.pdf').symlink_to(self.base / 'sample.pdf')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            conversion.checked_input(self.base, {'path': 'alias.pdf'}, {**self.record, 'path': 'alias.pdf'})

    def test_input_size_is_rejected_before_conversion(self):
        with patch.object(conversion, 'MAX_INPUT', 4), self.assertRaisesRegex(ValueError, 'input limit'):
            conversion.checked_input(self.base, self.case, self.record)

    def test_existing_run_and_output_symlink_are_not_overwritten(self):
        output = conversion.create_run_dir(self.base, 'run-1')
        (output / 'proof').write_text('keep')
        with self.assertRaises(FileExistsError):
            conversion.create_run_dir(self.base, 'run-1')
        self.assertEqual((output / 'proof').read_text(), 'keep')
        (self.base / 'other').mkdir()
        (self.base / 'other/outputs').symlink_to(self.base / 'outputs', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            conversion.create_run_dir(self.base / 'other', 'run-2')

    def test_invalid_run_id_writes_nothing(self):
        with self.assertRaises(ValueError):
            conversion.create_run_dir(self.base, '../escape')
        self.assertFalse((self.base / 'outputs').exists())


class EvidenceChecksTests(unittest.TestCase):
    def test_bold_headers_are_content_equivalent(self):
        case = CASES['F08']
        text = '\n'.join(case['contains']) + '\n|**设备编号**|**温度**|**状态**|\n|SL-A01|24|合格|\n|SL-B02|29|待复查|'
        self.assertTrue(conversion.assess(case, {'status': 'converted', 'text': text})['passed'])

    def test_table_value_swap_fails_even_with_all_keywords_present(self):
        case = CASES['F07']
        text = '\n'.join(case['contains']) + '\n|设备编号|温度|状态|\n|SL-A01|29|待复查|\n|SL-B02|24|合格|'
        self.assertFalse(conversion.assess(case, {'status': 'converted', 'text': text})['passed'])

    def test_worksheet_mixing_fails(self):
        case = CASES['F09']
        preface = '\n'.join(case['contains'])
        table = lambda rows: '\n'.join('|' + '|'.join(row) + '|' for row in rows)
        good = preface + '\n## 东区\n' + table(case['sheets']['东区']) + '\n## 西区\n' + table(case['sheets']['西区'])
        self.assertTrue(conversion.assess(case, {'status': 'converted', 'text': good})['passed'])
        mixed = good.replace('## 东区', '## TEMP').replace('## 西区', '## 东区').replace('## TEMP', '## 西区')
        self.assertFalse(conversion.assess(case, {'status': 'converted', 'text': mixed})['passed'])

    def test_known_partial_is_never_classified_complete(self):
        result = conversion.assess(CASES['F14'], {'status': 'converted', 'text': '正文记录数量为 8。'})
        self.assertTrue(result['passed'])
        self.assertEqual(result['quality'], 'partial')
        self.assertIn('T00', result['warning'])

    def test_empty_and_unexpected_worker_error_are_distinct(self):
        self.assertTrue(conversion.assess(CASES['F11'], {'status': 'empty'})['passed'])
        self.assertFalse(conversion.assess(CASES['F11'], {'status': 'worker_error'})['passed'])
        self.assertFalse(conversion.assess(CASES['F13'], {'status': 'failed', 'error_type': 'MissingDependencyException'})['passed'])
        self.assertTrue(conversion.assess(CASES['F13'], {'status': 'failed', 'error_type': 'FileConversionException'})['passed'])


class WorkerProtocolTests(unittest.TestCase):
    @patch.object(conversion.subprocess, 'run')
    def test_timeout_is_reported_without_success(self, run):
        run.side_effect = subprocess.TimeoutExpired(['worker'], 0.01)
        result = conversion.run_worker(Path('sample.pdf'), timeout=0.01)
        self.assertEqual(result['status'], 'timeout')
        self.assertEqual(result['text'], '')
        self.assertEqual(run.call_args.kwargs['timeout'], 0.01)

    @patch.object(conversion.subprocess, 'run')
    def test_invalid_protocol_and_nonzero_exit_are_not_empty_success(self, run):
        for payload in ('not json', '[]', '{"status":"ready","text":"x"}'):
            run.return_value = subprocess.CompletedProcess([], 0, payload, '')
            self.assertEqual(conversion.run_worker(Path('sample.pdf'))['status'], 'invalid_protocol')
        run.return_value = subprocess.CompletedProcess([], 3, '', 'diagnostic')
        self.assertEqual(conversion.run_worker(Path('sample.pdf'))['status'], 'worker_error')

    @patch.object(conversion.subprocess, 'run')
    def test_output_limit_and_sanitized_environment(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, json.dumps({'status': 'converted', 'text': '12345'}), '')
        with patch.dict('os.environ', {'TEST_MODEL_SECRET': 'sentinel'}), patch.object(conversion, 'MAX_OUTPUT', 4):
            self.assertEqual(conversion.run_worker(Path('sample.pdf'))['status'], 'output_limit')
        self.assertNotIn('TEST_MODEL_SECRET', run.call_args.kwargs['env'])
        self.assertIn('-I', run.call_args.args[0])
        self.assertIn('-B', run.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
