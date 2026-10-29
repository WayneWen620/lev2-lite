import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultPriceAlert, buildPriceAlertConfig, validatePriceAlert, evaluatePriceAlert,
  decidePriceAlert, buildPriceAlertEmail, taipeiSlot, timeOptions,
} from '../docs/js/engine/priceAlert.js';

const cfg = (over = {}) => ({
  v: 1, enabled: true, email: 'me@example.com', mode: 'TIMES', times: ['10:00', '13:20'],
  rules: [{ symbol: '00631L', dropPct: 0.03 }, { symbol: '0050', dropPct: 0.02 }],
  ...over,
});
const quotes = {
  '00631L': { price: 35.0, prevClose: 36.6, changePct: (35 - 36.6) / 36.6 }, // -4.37%
  '0050': { price: 199, prevClose: 200, changePct: -0.005 },                 // -0.5%
};
const at = (hhmm, date = '2026-10-29') => new Date(`${date}T${hhmm}:00+08:00`);

test('可選時間：09:10–13:30 每 10 分鐘', () => {
  const t = timeOptions();
  assert.equal(t[0], '09:10');
  assert.equal(t[t.length - 1], '13:30');
  assert.equal(t.length, 27);
});

test('預設：追蹤三檔正二、門檻 4%；上傳內容沒有持股', () => {
  const d = defaultPriceAlert();
  const c = buildPriceAlertConfig({ ...d, enabled: true, email: 'me@example.com' });
  assert.deepEqual(c.rules.map((r) => r.symbol), ['00631L', '00685L', '00675L']);
  assert.deepEqual(validatePriceAlert(c), []);
  assert.ok(!/shares|amount|holdings/.test(JSON.stringify(c)));
});

test('設定檢查：信箱、時間、門檻、多餘欄位', () => {
  assert.ok(validatePriceAlert(cfg({ email: 'abc' })).length);
  assert.ok(validatePriceAlert(cfg({ times: ['08:00'] })).length);
  assert.ok(validatePriceAlert(cfg({ times: ['10:05'] })).length);
  assert.ok(validatePriceAlert(cfg({ rules: [{ symbol: '00631L', dropPct: 0 }] })).length);
  assert.ok(validatePriceAlert({ ...cfg(), shares: 1 }).length);
});

test('今日跌幅：只抓跌幅 ≥ 門檻的股票', () => {
  const e = evaluatePriceAlert(cfg(), quotes);
  assert.deepEqual(e.hits.map((h) => h.symbol), ['00631L']);
  assert.ok(Math.abs(e.hits[0].changePct + 0.0437) < 1e-3);
  // 剛好等於門檻也算
  const e2 = evaluatePriceAlert(cfg({ rules: [{ symbol: '0050', dropPct: 0.005 }] }), quotes);
  assert.equal(e2.hits.length, 1);
  // 沒有 changePct 時用現價與昨收計算
  const e3 = evaluatePriceAlert(cfg(), { '00631L': { price: 35, prevClose: 36.6 } });
  assert.equal(e3.hits.length, 1);
});

test('指定時間：只在設定的時間寄，同一時間不重複', () => {
  const ev = evaluatePriceAlert(cfg(), quotes);
  let r = decidePriceAlert(cfg(), ev, null, at('09:50'));
  assert.equal(r.reason, 'not-scheduled');
  r = decidePriceAlert(cfg(), ev, null, at('10:03')); // 排程延遲幾分鐘仍屬 10:00 這一輪
  assert.equal(r.send.length, 1);
  const again = decidePriceAlert(cfg(), ev, r.state, at('10:06'));
  assert.equal(again.reason, 'already-sent');
  const later = decidePriceAlert(cfg(), ev, again.state, at('13:20'));
  assert.equal(later.send.length, 1, '13:20 仍下跌就再寄一次');
});

test('指定時間：沒有跌破就不寄', () => {
  const ev = evaluatePriceAlert(cfg(), { '00631L': { price: 36.5, prevClose: 36.6 } });
  const r = decidePriceAlert(cfg(), ev, null, at('10:00'));
  assert.equal(r.send.length, 0);
  assert.equal(r.reason, 'no-drop');
});

test('盤中即時：每檔每天只寄一次；隔天重新計算', () => {
  const c = cfg({ mode: 'INSTANT' });
  const ev = evaluatePriceAlert(c, quotes);
  let r = decidePriceAlert(c, ev, null, at('09:40'));
  assert.deepEqual(r.send.map((h) => h.symbol), ['00631L']);
  r = decidePriceAlert(c, ev, r.state, at('09:50'));
  assert.equal(r.send.length, 0);
  const bigger = evaluatePriceAlert(c, { ...quotes, '0050': { price: 195, prevClose: 200 } });
  r = decidePriceAlert(c, bigger, r.state, at('10:00'));
  assert.deepEqual(r.send.map((h) => h.symbol), ['0050'], '新跌破的才寄');
  r = decidePriceAlert(c, ev, r.state, at('09:40', '2026-10-30'));
  assert.equal(r.send.length, 1, '隔天重新開始');
});

test('非交易時間、關閉時不寄', () => {
  const ev = evaluatePriceAlert(cfg({ mode: 'INSTANT' }), quotes);
  assert.equal(decidePriceAlert(cfg({ mode: 'INSTANT' }), ev, null, at('14:00')).reason, 'market-closed');
  assert.equal(decidePriceAlert(cfg({ mode: 'INSTANT' }), ev, null, at('10:00', '2026-10-31')).reason, 'market-closed');
  assert.equal(decidePriceAlert(cfg({ enabled: false }), ev, null, at('10:00')).reason, 'disabled');
});

test('Email 內容：主旨寫跌幅，內容沒有持股金額', () => {
  const ev = evaluatePriceAlert(cfg(), quotes);
  const m = buildPriceAlertEmail(ev.hits, { now: at('13:20'), appUrl: 'https://x.github.io/lev2-lite/' });
  assert.equal(m.subject, '【正二配置】00631L 今日下跌 4.4%');
  assert.match(m.text, /2026-10-29 13:20/);
  assert.match(m.text, /現價 35\.00，昨收 36\.60，今日 -4\.37%（門檻 -3\.0%）/);
  assert.match(m.html, /開啟 App 查看/);
  assert.equal(taipeiSlot(at('13:27')).slot, '13:20');
});
