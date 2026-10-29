import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('單一檔案 Worker 可以產生並正常回應', async () => {
  execFileSync(process.execPath, ['scripts/build-worker.mjs']);
  const src = readFileSync('worker/dist/worker.js', 'utf8');
  assert.ok(!/^import\s/m.test(src), '不能有 import');
  const mod = await import('../worker/dist/worker.js?t=' + Date.now());
  const res = await mod.default.fetch(new Request('https://x.workers.dev/health'), { LEV2: {} });
  assert.equal(res.status, 200);
  assert.equal(typeof mod.default.scheduled, 'function');
});
