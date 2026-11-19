import { useEffect, useState } from 'react';
import type { Source } from '../../shared/vault.js';
import { contentPath } from '../../shared/presentation.js';
import { ClientError, errorText } from './client.js';
import { Dialog } from './common.js';

const readableSourceText = (text: string, extracted: boolean) =>
  extracted ? text.replace(/^---\nnotetrail: \{[^\n]+\}\n---\n\n/, '') : text;

export function SourceReader({ source, onClose, readContent }: { source: Source; onClose: () => void; readContent: (source: Source) => Promise<string> }) {
  const [text, setText] = useState<string | null>(null), [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        if (!source.version) throw new ClientError('这份资料没有可读取的版本。');
        const body = await readContent(source);
        if (!abort.signal.aborted) setText(readableSourceText(body, source.readableRepresentation?.kind === 'extracted_markdown'));
      } catch (error) { if (!abort.signal.aborted) setError(errorText(error)); }
    })(); return () => abort.abort();
  }, [source.id, source.version]);
  const extracted = source.readableRepresentation?.kind === 'extracted_markdown';
  const original = source.originalSaved && source.version ? contentPath(source.id, source.version, 'original') : null;
  return <Dialog title={source.title} onClose={onClose} wide>
    {(extracted || original) && <div className="row between">
      {extracted && <p className="subtle">提取文本，可能省略图片或复杂排版。</p>}
      {original && <a className="button secondary" href={original}>下载原件</a>}
    </div>}
    {error ? <p role="alert" className="error-text">{error}</p> : text !== null ? <pre className="source-text">{text || '这份资料没有可显示的正文。'}</pre> : <p role="status">正在读取资料…</p>}
  </Dialog>;
}
