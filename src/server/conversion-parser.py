"""Untrusted format parsing. Launched only inside the macOS conversion sandbox."""
import base64
from contextlib import redirect_stdout
from importlib import metadata
import io
import json
import mimetypes
from pathlib import Path
import re
import resource
import sys
import zipfile

MAX_OUTPUT = 20 * 1024 * 1024
class Denied(Exception):
    def __init__(self, code):
        self.code = code

def extraction(content, extension):
    if extension not in ('.pdf', '.docx', '.xlsx', '.xls', '.html', '.htm'):
        raise Denied('UNSUPPORTED_FORMAT')
    for line in Path(__file__).with_name('conversion-requirements.lock').read_text().splitlines():
        if line and not line.startswith('#'):
            name, version = line.split('==')
            if metadata.version(name) != version:
                raise Denied('SERVICE_UNAVAILABLE')

    # No converter receives credentials, URLs, plugin configuration or external-process access.
    def prohibit_external(event, _args):
        if event in ('socket.connect', 'socket.bind', 'socket.getaddrinfo', 'subprocess.Popen', 'os.system'):
            raise PermissionError('External access disabled')
    sys.addaudithook(prohibit_external)
    try:
        # Use the standard MIME table, never ambient host configuration.
        mimetypes.knownfiles = []
        mimetypes.init(files=[])
        from markitdown import MarkItDown, StreamInfo
        from markitdown.converters import PdfConverter, DocxConverter, XlsxConverter, XlsConverter, HtmlConverter
        partial = False
        if extension in ('.docx', '.xlsx'):
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                entries = archive.infolist()
                if len(entries) > 10000 or sum(entry.file_size for entry in entries) > 100 * 1024 * 1024:
                    raise Denied('BUDGET_EXCEEDED')
                partial = any('/media/' in entry.filename or '/embeddings/' in entry.filename or
                              '/charts/' in entry.filename for entry in entries)
        if extension == '.pdf':
            import pdfplumber
            with pdfplumber.open(io.BytesIO(content)) as pdf:
                partial = any(page.images for page in pdf.pages)
        if extension in ('.html', '.htm'):
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(content, 'html.parser')
            # A password form is an access gate, not the requested article.
            if soup.find('input', attrs={'type': re.compile('^password$', re.I)}) is not None:
                raise Denied('URL_FETCH_FAILED')
            partial = soup.find('img') is not None
        converter = MarkItDown(enable_builtins=False, enable_plugins=False)
        converter.register_converter({'.pdf': PdfConverter, '.docx': DocxConverter,
                                      '.xlsx': XlsxConverter, '.xls': XlsConverter,
                                      '.html': HtmlConverter, '.htm': HtmlConverter}[extension]())
        result = converter.convert_stream(io.BytesIO(content), stream_info=StreamInfo(extension=extension))
        text = result.markdown
        if not isinstance(text, str) or not text.strip() or '\x00' in text:
            raise Denied('EXTRACTION_EMPTY')
        state = 'partial' if partial else 'ready'
        warnings = ['EXTRACTION_PARTIAL'] if partial else []
        output = text.encode('utf-8')
        if len(output) > MAX_OUTPUT:
            raise Denied('FILE_TOO_LARGE')
        return {'state': state, 'warningCodes': warnings, 'textBase64': base64.b64encode(output).decode('ascii')}
    except Denied:
        raise
    except Exception:
        raise Denied('CONVERSION_FAILED')


def main():
    try:
        if len(sys.argv) != 3 or sys.version_info[:2] != (3, 12) or sys.platform != 'darwin':
            raise Denied('SERVICE_UNAVAILABLE')
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT, MAX_OUTPUT))
        with open(sys.argv[1], 'rb') as source:
            content = source.read(100 * 1024 * 1024 + 1)
        if len(content) > 100 * 1024 * 1024:
            raise Denied('FILE_TOO_LARGE')
        with redirect_stdout(sys.stderr):
            result = {'ok': True, 'value': extraction(content, sys.argv[2])}
    except Denied as error:
        result = {'ok': False, 'error': error.code}
    except Exception:
        result = {'ok': False, 'error': 'CONVERSION_FAILED'}
    print(json.dumps(result, ensure_ascii=True))

if __name__ == '__main__':
    main()
