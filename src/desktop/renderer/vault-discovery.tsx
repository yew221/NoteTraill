import { useEffect, useState } from 'react';
import type { Vault } from '../../shared/vault.js';
import type { VaultDiscovery } from '../../shared/vault-discovery.js';
import { data, type VaultWorkspacesView } from './api.js';

export function VaultDiscoveryPanel({ vault, libraries, onSelect, onAdd, disabled }: {
  vault: Vault | null; libraries: VaultWorkspacesView; onSelect: (path: string) => void; onAdd: () => void; disabled: boolean;
}) {
  const [found, setFound] = useState<VaultDiscovery>({ items: [], warnings: [] }), [busy, setBusy] = useState(true), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void data(window.notetrail.discoverVaults()).then(result => { if (active) setFound(result); })
      .catch(() => { if (active) setError('自动检测暂时不可用，请使用选择文件夹。'); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  async function detect(scan = false) {
    if (busy) return; setBusy(true); setError('');
    try { const result = await data(scan ? window.notetrail.scanVaults() : window.notetrail.discoverVaults()); if (result) setFound(result); }
    catch { setError('检测暂时不可用，请使用选择文件夹。'); } finally { setBusy(false); }
  }
  return <div className="vault-discovery">
    <div className="row between"><h3>发现的知识库</h3><div className="row">
      <button className="text-button" disabled={busy || disabled} onClick={() => void detect()}>重新检测</button>
      {vault && <button className="button secondary" disabled={disabled} onClick={onAdd}>添加知识库</button>}
    </div></div>
    {busy && <p role="status">正在查找知识库…</p>}
    {!busy && !found.items.length && <p role="status">暂未发现知识库。</p>}
    {found.items.map(item => {
      const connected = !!item.locationKey && item.locationKey === vault?.locationKey;
      const registered = libraries.items.some(library => library.key === item.locationKey);
      return <div className="vault-candidate" key={item.absolutePath} title={item.absolutePath}>
        <strong>{item.name}</strong>
        {connected ? <span>已连接</span> : item.state !== 'available' ? <span>{item.state === 'missing' ? '目录已不存在' : '无法访问'}</span> :
          <button className="button secondary" aria-description={item.absolutePath} disabled={busy || disabled} onClick={() => onSelect(item.absolutePath)}>
            {registered ? '切换' : vault ? '添加并切换' : '选择此库'}
          </button>}</div>;
    })}
    {found.warnings.map(message => <p role="status" key={message}>{message}</p>)}
    {error && <p role="alert">{error}</p>}
    <button className="text-button" disabled={busy || disabled} onClick={() => void detect(true)}>扫描其他位置</button>
  </div>;
}
