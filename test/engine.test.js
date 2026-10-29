import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, advise, resolveTier, lotSplit, drawdownSteps } from '../docs/js/engine/engine.js';
import { buildWatch, evaluateWatch, validateWatch, alertMessage } from '../docs/js/engine/watch.js';
import { sampleData, emptyData, normalize } from '../docs/js/data.js';

const pricesOf = (d) => Object.fromEntries(d.holdings.filter((h) => h.manualPrice).map((h) => [h.symbol, h.manualPrice]));
const near = (a, b, tol = 1e-4) => assert.ok(Math.abs(a - b) < tol, `${a} ≠ ${b}`);

test('Excel 2026/09 驗算值（設計稿 0.4）', () => {
  const d = sampleData();
  const s = summarize(d, pricesOf(d));
  near(s.marketValue / 1000, 7197.80, 0.005);
  near(s.leverageValue / 1000, 7227.15, 0.005);
  near(s.cashValue / 1000, 7305.00, 0.005);
  near(s.financialAssets / 1000, 21729.95, 0.005);
  near(s.totalLiabilities / 1000, -6000, 0.005);
  near(s.netWorth / 1000, 15729.95, 0.005);
  near(s.annualExpense / 1000, 1900, 0.005);
  near(s.multiple, 11.4368);
  assert.equal(s.tier.code, '163');
  near(s.principalLeverage, 1.3814);
  near(s.beta, 0.9964);
  near(s.totalExposure, 1.3765);
});

test('各檔 Beta 貢獻加總 = 組合 Beta；正二篩選小計', () => {
  const d = sampleData();
  const s = summarize(d, pricesOf(d));
  near(s.items.reduce((a, i) => a + i.betaContribution, 0), s.beta, 1e-9);
  const lev = s.items.filter((i) => i.category === 'LEVERAGE' && i.shares > 0);
  assert.deepEqual(lev.map((i) => i.symbol), ['00631L', '00685L']);
  near(lev.reduce((a, i) => a + i.betaContribution, 0), s.leveragePct * 2, 1e-9);
});

test('級距邊界：min ≤ M < max；自訂配置優先', () => {
  assert.equal(resolveTier(9.999).code, '073');
  assert.equal(resolveTier(10).code, '163');
  assert.equal(resolveTier(29.99).code, '333');
  assert.equal(resolveTier(50).code, '703');
  assert.equal(resolveTier(-3).code, '073');
  assert.equal(resolveTier(25, '433').code, '433');
});

test('信貸會從生活費倍數分子扣除', () => {
  const d = sampleData();
  d.liabilities.personal = 1900000;
  const s = summarize(d, pricesOf(d));
  near(s.multiple, (21729950 - 1900000) / 1900000);
});

test('回檔階數：-10.7% → 第 1 階；-20% 剛好 → 第 2 階', () => {
  assert.equal(drawdownSteps((36.88 - 41.32) / 41.32, 0.1), 1);
  assert.equal(drawdownSteps(-0.2, 0.1), 2);
  assert.equal(drawdownSteps(0.05, 0.1), 0);
});

test('範例情境：紅燈，賣 00662 買 00631L，執行後回到目標', () => {
  const d = sampleData();
  const a = advise(d, pricesOf(d));
  assert.equal(a.add.steps, 1);
  near(a.add.targetAdded, 0.05);
  assert.equal(a.mode, 'REBALANCE');
  assert.equal(a.light, 'RED');
  const sell = a.lines.find((l) => l.side === 'SELL');
  const buy = a.lines.find((l) => l.side === 'BUY');
  assert.equal(sell.symbol, '00662');
  assert.equal(sell.lots, 40); assert.equal(sell.odd, 489);
  assert.equal(buy.symbol, '00631L');
  assert.equal(buy.lots, 186); assert.equal(buy.odd, 754);
  near(a.after.MARKET, 0.10, 0.002);
  near(a.after.LEVERAGE, 0.65, 0.002);
  near(a.after.CASH, 0.25, 0.003);
});

test('配置正常但正二回檔 → 黃燈加碼', () => {
  const d = sampleData();
  // 調成剛好符合 163＋加碼 0：原型 10%、正二 60%、現金 30%
  const fa = 20000000;
  d.holdings.forEach((h) => { h.shares = 0; });
  d.holdings.find((h) => h.symbol === '0050').shares = 10000; d.holdings.find((h) => h.symbol === '0050').manualPrice = 200; // 200 萬
  d.holdings.find((h) => h.symbol === '00631L').shares = 300000; d.holdings.find((h) => h.symbol === '00631L').manualPrice = 40; // 1200 萬
  d.cashAccounts = [{ id: 'c1', type: 'DEMAND', bankName: '活存', amount: 6000000 }];
  d.expense = { monthlyLiving: 140000, extras: [], annualOverride: null }; // 倍數 11.9 → 163
  d.peaks[0].peakPrice = 40;
  let a = advise(d, pricesOf(d));
  assert.equal(a.summary.financialAssets, fa);
  assert.equal(a.light, 'GREEN');
  // 跌 12%：正二比例自然下降，但仍在門檻內 → 觸發第 1 階加碼
  d.holdings.find((h) => h.symbol === '00631L').manualPrice = 35.2;
  a = advise(d, pricesOf(d));
  assert.equal(a.add.steps, 1);
  assert.ok(a.add.addNowPct > 0);
  assert.equal(a.light, a.rebalance.out ? 'RED' : 'YELLOW');
});

test('零股關閉時只買整張、不超賣', () => {
  assert.deepEqual(lotSplit(1000000, 36.88, false), { shares: 27000, lots: 27, odd: 0, amount: 27000 * 36.88 });
  assert.equal(lotSplit(1e9, 10, true, 5000).shares, 5000);
});

test('雲端比例：上傳內容沒有股數與金額', () => {
  const d = sampleData();
  const p = pricesOf(d);
  const w = buildWatch(d, summarize(d, p), p);
  assert.deepEqual(validateWatch(w), []);
  const s = JSON.stringify(w);
  for (const leak of ['58000', '150000', '3000000', '21729950', 'shares', 'amount']) assert.ok(!s.includes(leak), leak);
});

test('雲端比例：價格不變時，推算結果與手機端完全一致', () => {
  const d = sampleData();
  const p = pricesOf(d);
  const a = advise(d, p);
  const r = evaluateWatch(buildWatch(d, a.summary, p), p);
  near(r.current.LEVERAGE, a.summary.leveragePct, 1e-5);
  near(r.current.CASH, a.summary.cashPct, 1e-5);
  assert.equal(r.out, a.rebalance.out);
  assert.equal(r.steps, a.add.steps);
});

test('雲端比例：股價變動後，推算比例 = 用真實股數重算的比例', () => {
  const d = sampleData();
  const p0 = pricesOf(d);
  const w = buildWatch(d, summarize(d, p0), p0);
  const p1 = { ...p0, '00631L': 46.1, '00662': 118.0, '00865B': 43.2 };
  const real = summarize(d, p1);
  const r = evaluateWatch(w, p1);
  near(r.current.MARKET, real.marketPct, 1e-5);
  near(r.current.LEVERAGE, real.leveragePct, 1e-5);
  near(r.current.CASH, real.cashPct, 1e-5);
  assert.equal(r.newPeaks[0].symbol, '00631L');
  assert.match(alertMessage(r, 'https://x.github.io/lev2-lite/'), /正二 \d+%（目標 \d+%）/);
});

test('缺股價時不上傳；normalize 補齊舊資料', () => {
  const d = sampleData();
  assert.equal(buildWatch(d, summarize(d, {}), {}), null);
  const n = normalize({ schemaVersion: 1, holdings: [{ symbol: '0050', shares: 5 }] });
  assert.equal(n.holdings.length, 7);
  assert.equal(n.settings.rebalanceThreshold, 0.05);
  assert.equal(summarize(emptyData(), {}).financialAssets, 0);
});
