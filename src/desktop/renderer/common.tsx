import { useEffect, useRef, type ReactNode } from 'react';
import type { Run } from '../../shared/run.js';
import { isTerminalRunState } from '../../shared/contracts.js';
import type { SourceState } from '../../shared/vault.js';

export function Icon({ name }: { name: 'note' | 'plus' | 'chat' | 'files' | 'settings' | 'arrow' | 'close' | 'attach' | 'stop' }) {
  const paths = { note: 'M5 3h10l4 4v14H5V3m9 0v5h5M8 12h8M8 16h6', plus: 'M12 5v14M5 12h14', chat: 'M4 4h16v12H9l-5 4V4',
    files: 'M3 6h7l2 3h9v11H3V6m2-3h7l2 3h5', settings: 'M4 7h16M4 17h16M9 4v6M15 14v6',
    arrow: 'M12 19V5m-6 6 6-6 6 6', close: 'm6 6 12 12M18 6 6 18', attach: 'm9 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8', stop: 'M6 6h12v12H6V6' };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function Dialog({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => { if (dialog.open) dialog.close(); }; }, []);
  return <dialog ref={ref} className={wide ? 'dialog wide' : 'dialog'} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="dialog-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></header>
    <div className="dialog-content">{children}</div>
  </dialog>;
}
export const sourceLabel: Record<SourceState, string> = { pending: '等待处理', processing: '正在提取', ready: '可用于问答', partial: '部分可读',
  failed: '处理失败', unsupported: '暂不支持正文', stale: '等待更新', missing: '原件已移除', excluded: '已排除', needs_review: '需要检查' };
export function runLabel(run: Run): string {
  if (run.state === 'queued') return '等待处理';
  if (run.state === 'cancelling') return '正在停止…';
  if (run.state === 'cancelled') return '已停止';
  if (run.state === 'interrupted') return '服务重启后已中断';
  if (run.state === 'failed') return '未完成';
  if (run.state === 'succeeded') return '已完成';
  const labels = { preparing: '准备中', searching: '正在查找资料', reading: '正在读取资料', generating: run.kind === 'model_probe' ? '正在测试连接' : '正在生成回答',
    validating: '正在核对出处', fetching: '正在获取网页', saving: '正在保存原件', converting: '正在提取正文', checking: '正在检查资料', publishing: '正在登记资料', scanning: '正在更新资料列表' };
  return run.stage ? labels[run.stage] : '处理中';
}
export function Usage({ run }: { run: Run }) {
  if (!run.usage.modelRequests) return null;
  const { inputTokens, outputTokens } = run.usage;
  if (inputTokens === null || outputTokens === null) return <span className="subtle usage">Token {isTerminalRunState(run.state) ? '统计不完整' : '统计中…'}</span>;
  const count = (n: number) => n.toLocaleString('zh-CN');
  return <details className="subtle usage"><summary>本轮消耗 {count(inputTokens + outputTokens)} Token</summary>
    <span>输入 {count(inputTokens)} · 输出 {count(outputTokens)} · 包含本轮全部模型请求
      {!!run.usage.searchRequests && ` · 联网搜索 ${run.usage.searchRequests} 次（另按次计费）`}</span></details>;
}
export function timeLabel(value: string): string {
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}
