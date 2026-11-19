import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bundle as bundleCss, browserslistToTargets } from 'lightningcss';
import { rolldown } from 'rolldown';

// Keep both renderers on the existing browser support baseline.
const browsers = ['chrome 111', 'edge 111', 'firefox 114', 'safari 16.4', 'ios_saf 16.4'];

export async function buildRenderer(sourceDir, outputDir, base) {
  const html = fs.readFileSync(path.join(sourceDir, 'index.html'), 'utf8');
  const script = `src="${base}main.tsx"`;
  const stylesheet = `href="${base}style.css"`;
  if (!html.includes(script) || !html.includes(stylesheet)) throw new Error('渲染页面缺少构建入口。');

  const parent = path.dirname(outputDir);
  if (fs.realpathSync(parent) !== parent) throw new Error('渲染输出目录路径异常。');
  const staging = fs.mkdtempSync(path.join(parent, '.renderer-'));
  try {
    const builder = await rolldown({
      cwd: sourceDir,
      input: { index: path.join(sourceDir, 'main.tsx') },
      platform: 'browser',
      tsconfig: path.join(sourceDir, 'tsconfig.json'),
      transform: {
        target: browsers.map(browser => browser.replace('ios_saf', 'ios').replace(' ', '')),
        define: { 'process.env.NODE_ENV': '"production"' },
      },
    });
    let entry;
    try {
      const { output } = await builder.write({
        dir: staging, format: 'esm', entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js', minify: true, sourcemap: false,
      });
      entry = output.find(file => file.type === 'chunk' && file.isEntry)?.fileName;
    } finally {
      await builder.close();
    }
    if (!entry) throw new Error('渲染页面没有生成脚本。');

    const css = bundleCss({
      filename: path.join(sourceDir, 'style.css'), minify: true, targets: browserslistToTargets(browsers),
    }).code;
    const hash = createHash('sha256').update(css).digest('hex').slice(0, 12);
    const cssFile = `assets/style-${hash}.css`;
    fs.writeFileSync(path.join(staging, cssFile), css);
    fs.writeFileSync(path.join(staging, 'index.html'), html
      .replace(script, `src="${base}${entry}"`)
      .replace(stylesheet, `href="${base}${cssFile}"`));
    // mkdtemp is owner-only. Publish with the same mode as a normal build directory.
    fs.chmodSync(staging, 0o777 & ~process.umask());

    if (fs.existsSync(outputDir)) {
      if (!fs.lstatSync(outputDir).isDirectory()) throw new Error('渲染输出目录异常。');
      fs.rmSync(outputDir, { recursive: true });
    }
    fs.renameSync(staging, outputDir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
