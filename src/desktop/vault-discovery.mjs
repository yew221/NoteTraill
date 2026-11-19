import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

// Directory metadata only. Discovery never opens notes or connects a vault.
export async function discoverVaults({ registry, scanRoot, maxDirectories = 2000, maxDepth = 4 }) {
  const items = new Map(), warnings = [];
  async function add(input, registered) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.length > 4096 || /[\x00-\x1f]/.test(input)) return;
    let absolutePath = path.normalize(input), state = 'available', locationKey;
    try {
      absolutePath = await fs.realpath(absolutePath);
      const stat = await fs.stat(absolutePath, { bigint: true });
      if (!stat.isDirectory()) state = 'missing';
      else {
        await fs.access(absolutePath, fs.constants.R_OK | fs.constants.X_OK);
        locationKey = createHash('sha256').update(`${stat.dev}:${stat.ino}`).digest('hex');
      }
    } catch (error) { state = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unreadable'; }
    const old = items.get(absolutePath);
    items.set(absolutePath, { name: path.basename(absolutePath), absolutePath, state, ...(locationKey ? { locationKey } : {}), registered: registered || old?.registered || false });
  }
  if (registry) {
    try {
      const stat = await fs.stat(registry);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error();
      const value = JSON.parse(await fs.readFile(registry, 'utf8'));
      if (!value.vaults || typeof value.vaults !== 'object' || Array.isArray(value.vaults)) throw new Error();
      const entries = Object.values(value.vaults);
      for (const entry of entries.slice(0, 100)) await add(entry?.path, true);
      if (entries.length > 100) warnings.push('知识库记录较多，仅显示前 100 个。');
    } catch (error) {
      warnings.push(error.code === 'ENOENT' ? '未找到 Obsidian 的知识库记录，可扫描其他位置或选择文件夹。' : 'Obsidian 的知识库记录暂时无法读取，可选择文件夹连接。');
    }
  }
  if (scanRoot) {
    const queue = [[await fs.realpath(scanRoot), 0]], deadline = Date.now() + 3000;
    let visited = 0;
    while (queue.length && visited < maxDirectories && Date.now() < deadline) {
      const [directory, depth] = queue.shift(); visited++;
      try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        if (entries.some(entry => entry.name === '.obsidian' && entry.isDirectory())) { await add(directory, false); continue; }
        if (depth >= maxDepth) continue;
        for (const entry of entries) {
          if (queue.length + visited >= maxDirectories) { warnings.push('扫描已达到本次目录上限，可选择更具体的位置继续。'); break; }
          if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') &&
              !['node_modules', 'Library'].includes(entry.name) && !entry.name.endsWith('.app')) queue.push([path.join(directory, entry.name), depth + 1]);
        }
      } catch { warnings.push('部分目录无法访问，已跳过。'); }
    }
    if (queue.length) warnings.push('本次扫描范围有限，可选择更具体的位置继续。');
  }
  return { items: [...items.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings: [...new Set(warnings)] };
}
