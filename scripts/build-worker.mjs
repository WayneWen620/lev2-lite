// 把 Worker 與共用計算檔案合併成單一檔案 worker/dist/worker.js，
// 方便直接貼到 Cloudflare 網頁編輯器（不需要安裝 Node 或 wrangler）。
// 用法：node scripts/build-worker.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const parts = [
  'docs/js/engine/constants.js',
  'docs/js/engine/engine.js',
  'docs/js/engine/watch.js',
  'docs/js/engine/priceAlert.js',
  'worker/src/index.js',
];

const IMPORT_RE = /^import\s[\s\S]*?\sfrom\s+['"][^'"]+['"];[ \t]*\r?\n/gm;
let out = `// 正二資產配置 Lite — Cloudflare Worker（單一檔案版，由 scripts/build-worker.mjs 產生，請勿手動修改）\n// 產生時間：${new Date().toISOString()}\n\n`;
for (const p of parts) {
  let src = readFileSync(join(root, p), 'utf8').replace(IMPORT_RE, '');
  const isEntry = p === 'worker/src/index.js';
  // 共用檔案的 export 改成一般宣告；入口檔保留 export default，並保留具名 export 供測試使用
  if (!isEntry) src = src.replace(/^export (const|function|class|async function) /gm, '$1 ');
  out += `// ===== ${p} =====\n${src}\n`;
}
if (/^import\s/m.test(out)) throw new Error('bundle still contains import statements');
mkdirSync(join(root, 'worker/dist'), { recursive: true });
writeFileSync(join(root, 'worker/dist/worker.js'), out);
console.log(`worker/dist/worker.js（${out.length.toLocaleString()} 字元）`);
