import fs from 'node:fs';
import path from 'node:path';

export function assetPath(url, root) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'notetrail:' || parsed.host !== 'app' || parsed.search || parsed.hash ||
      parsed.username || parsed.password || !/^\/(?:index\.html|assets\/[A-Za-z0-9_-]+\.(?:js|css))$/.test(parsed.pathname)) return null;
  const file = path.join(root, parsed.pathname);
  try { return fs.realpathSync(file) === file && fs.statSync(file).isFile() ? file : null; }
  catch { return null; }
}
export const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
