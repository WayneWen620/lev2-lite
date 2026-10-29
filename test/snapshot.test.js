import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../docs/js/engine/engine.js';
import { buildAutoSnapshot, snapshotChanged, finalizeSnapshot, needsFinalize, monthlyTable, monthDiff } from '../docs/js/engine/snapshot.js';
import { sampleData } from '../docs/js/data.js';

const pricesOf = (d) => Object.fromEntries(d.holdings.filter((h) => h.manualPrice).map((h) => [h.symbol, h.manualPrice]));

test('本月自動快照：與 Excel 驗算值相同，並保存股數', () => {
  const d = sampleData();
  const s = buildAutoSnapshot(d, summarize(d, pricesOf(d)), { ym: '2026-10', ymd: '2026-10-29' });
  assert.equal(s.financialAssets, 21729950);
  assert.equal(s.netWorth, 15729950);
  assert.equal(s.tierCode, '163');
  assert.equal(s.beta, 0.9964);
  assert.equal(s.principalLeverage, 1.3814);
  assert.deepEqual(s.holdings, { '00662': 58000, '00631L': 150000, '00685L': 45000, '00865B': 100000 });
  assert.equal(s.deposits, 3000000);
  assert.equal(s.source, 'AUTO');
});

test('數字沒變就不重寫', () => {
  const d = sampleData();
  const a = buildAutoSnapshot(d, summarize(d, pricesOf(d)), { ym: '2026-10', ymd: '2026-10-29' });
  const b = buildAutoSnapshot(d, summarize(d, pricesOf(d)), { ym: '2026-10', ymd: '2026-10-29' });
  assert.equal(snapshotChanged(a, b), false);
  assert.equal(snapshotChanged(a, { ...b, asOf: '2026-10-30' }), true);
  assert.equal(snapshotChanged(null, b), true);
});

test('月底定案：用月底收盤價、當時股數重算', () => {
  const d = sampleData();
  const snap = buildAutoSnapshot(d, summarize(d, pricesOf(d)), { ym: '2026-10', ymd: '2026-10-27' });
  const closes = {
    '00662': { close: 130, date: '2026-10-30' },
    '00631L': { close: 38, date: '2026-10-30' },
    '00685L': { close: 39, date: '2026-10-30' },
    '00865B': { close: 43, date: '2026-10-30' },
  };
  const f = finalizeSnapshot(snap, closes, d.settings);
  const expectFA = 58000 * 130 + 150000 * 38 + 45000 * 39 + 100000 * 43 + 3000000;
  assert.equal(f.financialAssets, expectFA);
  assert.equal(f.netWorth, expectFA - 6000000);
  assert.equal(f.source, 'MONTH_END');
  assert.equal(f.asOf, '2026-10-30');
  assert.equal(f.missing, undefined);
  assert.equal(needsFinalize(snap, '2026-11'), true);
  assert.equal(needsFinalize(snap, '2026-10'), false);
  assert.equal(needsFinalize(f, '2026-11'), false);
});

test('月底定案：缺一檔收盤價時沿用舊價；全部缺少時標記最後開啟價', () => {
  const d = sampleData();
  const snap = buildAutoSnapshot(d, summarize(d, pricesOf(d)), { ym: '2026-10', ymd: '2026-10-27' });
  const f = finalizeSnapshot(snap, { '00662': { close: 130, date: '2026-10-30' } }, d.settings);
  assert.deepEqual(f.missing.sort(), ['00631L', '00685L', '00865B']);
  assert.equal(f.financialAssets, 21729950 + 58000 * (130 - 124.1));
  const g = finalizeSnapshot(snap, {}, d.settings);
  assert.equal(g.source, 'LAST_OPEN');
  assert.equal(g.financialAssets, 21729950);
  assert.equal(g.asOf, '2026-10-27');
});

test('月增減、今年以來、累積', () => {
  const rows = monthlyTable([
    { yearMonth: '2025-11', financialAssets: 900 },
    { yearMonth: '2025-12', financialAssets: 1000 },
    { yearMonth: '2026-01', financialAssets: 1100 },
    { yearMonth: '2026-03', financialAssets: 1210 },
    { yearMonth: '2026-02', financialAssets: 0 }, // 空值略過
  ]);
  assert.deepEqual(rows.map((r) => r.yearMonth), ['2025-11', '2025-12', '2026-01', '2026-03']);
  assert.equal(rows[0].monthChange, null);
  assert.deepEqual(rows[2].monthChange, { amount: 100, pct: 0.1 });
  assert.deepEqual(rows[3].ytdChange, { amount: 210, pct: 0.21 });   // 對比 2025-12
  assert.ok(Math.abs(rows[3].cumulative.pct - 310 / 900) < 1e-12);  // 對比第一筆
  assert.equal(rows[3].gapMonths, 2);
  assert.equal(rows[1].ytdChange.amount, 100);                      // 2025 年：對比當年第一筆
  assert.equal(monthDiff('2025-12', '2026-01'), 1);
});
