import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker, { generateCode, isTaipeiMarketTime, runCheck, runPriceAlert, getMonthClose } from '../worker/src/index.js';
import { encryptAppData, decryptEnvelope, createTransfer, fetchTransfer } from '../docs/js/backup.js';
import { buildWatch } from '../docs/js/engine/watch.js';
import { summarize } from '../docs/js/engine/engine.js';
import { sampleData } from '../docs/js/data.js';

const ORIGIN = 'https://holmes.github.io';
const BASE = 'https://lev2-worker.example.workers.dev';
const PW = '我家貓叫阿肥2026';

function mockKV() {
  const m = new Map();
  return {
    m, writes: 0,
    async get(k) { const v = m.get(k); return v && v.exp > Date.now() ? v.val : null; },
    async put(k, val, o = {}) { this.writes++; m.set(k, { val, exp: Date.now() + (o.expirationTtl || 1e9) * 1000, ttl: o.expirationTtl }); },
    async delete(k) { m.delete(k); },
  };
}

// 模擬外部服務：證交所、Yahoo、Telegram
let market = {};
let telegram = [];
let mails = [];
let twseDown = false;
const realFetch = globalThis.fetch;
function externalFetch(url, init = {}) {
  const u = String(url);
  if (u.startsWith('https://mis.twse.com.tw/')) {
    if (twseDown) return Promise.resolve(new Response('err', { status: 500 }));
    const list = decodeURIComponent(u.match(/ex_ch=([^&]+)/)[1]).split('|');
    const msgArray = list
      .map((x) => x.match(/^(tse|otc)_(.+)\.tw$/))
      .filter((m) => market[m[2]] && (m[1] === 'otc') === (m[2] === '00865B'))
      .map((m) => ({ c: m[2], z: String(market[m[2]]), y: String(market[m[2]] - 0.5), b: '1_', tlong: String(Date.now()) }));
    return Promise.resolve(Response.json({ msgArray }));
  }
  if (u.startsWith('https://query1.finance.yahoo.com/')) {
    const sym = u.match(/chart\/([^.]+)\.(TWO?)\?/);
    const p = market[sym[1]];
    if (!p || (sym[2] === 'TWO') !== (sym[1] === '00865B')) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(Response.json({ chart: { result: [{ meta: { regularMarketPrice: p, chartPreviousClose: p - 1, regularMarketTime: 1 } }] } }));
  }
  if (u.startsWith('https://api.resend.com/')) {
    mails.push({ auth: init.headers.Authorization, ...JSON.parse(init.body) });
    return Promise.resolve(Response.json({ id: 'm1' }));
  }
  if (u.startsWith('https://api.telegram.org/')) {
    telegram.push(JSON.parse(init.body));
    return Promise.resolve(Response.json({ ok: true }));
  }
  throw new Error('unexpected fetch ' + u);
}

let kv, env;
beforeEach(() => {
  kv = mockKV();
  env = {
    LEV2: kv, ALLOWED_ORIGIN: ORIGIN, APP_URL: 'https://holmes.github.io/lev2-lite/',
    NOTIFY_KEY: 'secret-key-123456', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '42', RESEND_API_KEY: 're_test',
  };
  market = { '00662': 124.10, '00631L': 36.88, '00685L': 37.67, '00865B': 43.05, '0050': 200 };
  telegram = [];
  mails = [];
  twseDown = false;
  globalThis.fetch = externalFetch;
});

// 網頁呼叫 Worker：把 fetch 導到 worker.fetch，並帶上 Origin
function asBrowser() {
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith(BASE)) {
      const headers = new Headers(init.headers); headers.set('Origin', ORIGIN);
      return worker.fetch(new Request(url, { ...init, headers }), env);
    }
    return externalFetch(url, init);
  };
}
const call = (path, init = {}) => worker.fetch(new Request(BASE + path, init), env);
const auth = { Authorization: 'Bearer secret-key-123456', 'Content-Type': 'application/json' };

test('/health、/quotes：上市、上櫃都抓得到', async () => {
  assert.equal((await call('/health')).status, 200);
  const r = await (await call('/quotes?codes=0050,00631L,00865B,XXXX')).json();
  assert.deepEqual(Object.keys(r.quotes).sort(), ['0050', '00631L', '00865B']);
  assert.equal(r.quotes['00631L'].price, 36.88);
  assert.equal(r.quotes['00865B'].source, 'TWSE');
  assert.ok(Math.abs(r.quotes['0050'].changePct - 0.5 / 199.5) < 1e-9);
});

test('/quotes：證交所失敗時改用 Yahoo', async () => {
  twseDown = true;
  const r = await (await call('/quotes?codes=00685L,00865B')).json();
  assert.equal(r.quotes['00685L'].source, 'YAHOO');
  assert.equal(r.quotes['00865B'].price, 43.05);
});

test('其他網站來的請求一律拒絕', async () => {
  const r = await call('/quotes?codes=0050', { headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
});

test('轉移碼：傳出 → 取回 → 解密；只能用一次', async () => {
  asBrowser();
  const d = sampleData();
  const { code } = await createTransfer(BASE, await encryptAppData(d, PW, { iterations: 100000 }));
  assert.equal(kv.m.get('t:' + code).ttl, 600);
  const env1 = await fetchTransfer(BASE, code.toLowerCase());
  assert.deepEqual(await decryptEnvelope(env1, PW), d);
  await assert.rejects(fetchTransfer(BASE, code), (e) => e.code === 'CODE_NOT_FOUND');
  for (let i = 0; i < 100; i++) assert.match(generateCode(), /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
});

test('轉移碼：拒絕未加密資料', async () => {
  const r = await call('/transfer', { method: 'POST', headers: { Origin: ORIGIN }, body: JSON.stringify(sampleData()) });
  assert.equal(r.status, 400);
});

function sampleWatch() {
  const d = sampleData();
  const p = Object.fromEntries(d.holdings.filter((h) => h.manualPrice).map((h) => [h.symbol, h.manualPrice]));
  return buildWatch(d, summarize(d, p), p);
}

test('/watch：需要通知密鑰；拒絕夾帶金額', async () => {
  const w = sampleWatch();
  assert.equal((await call('/watch', { method: 'PUT', body: JSON.stringify(w) })).status, 401);
  assert.equal((await call('/watch', { method: 'PUT', headers: { ...auth, Authorization: 'Bearer wrong' }, body: JSON.stringify(w) })).status, 401);
  const bad = { ...w, shares: { '00631L': 150000 } };
  assert.equal((await call('/watch', { method: 'PUT', headers: auth, body: JSON.stringify(bad) })).status, 400);
  assert.equal((await call('/watch', { method: 'PUT', headers: auth, body: JSON.stringify(w) })).status, 200);
  const g = await (await call('/watch', { headers: auth })).json();
  assert.deepEqual(g.watch.weights, w.weights);
});

test('排程：非盤中不檢查；盤中判斷時間正確', () => {
  assert.equal(isTaipeiMarketTime(new Date('2026-10-29T01:00:00Z')), true);  // 週四 09:00
  assert.equal(isTaipeiMarketTime(new Date('2026-10-29T05:36:00Z')), false); // 13:36
  assert.equal(isTaipeiMarketTime(new Date('2026-10-31T02:00:00Z')), false); // 週六
});

test('排程：偏離 → 發一次 Telegram；不重複發；恢復後再偏離會再發', async () => {
  await kv.put('watch', JSON.stringify(sampleWatch()));
  const at = (iso) => ({ now: new Date(iso) });
  let r = await runCheck(env, at('2026-10-29T02:00:00Z'));
  assert.equal(r.out, true);
  assert.equal(telegram.length, 1);
  assert.match(telegram[0].text, /正二 33%（目標 65%）/);
  assert.match(telegram[0].text, /00631L 從高點回檔 11%，達第 1 階/);
  const noSymbols = telegram[0].text.replace(/https?:\S+/, '').replace(/00631L|00685L|00675L|00662|00865B|0050|2330/g, '');
  assert.ok(!/萬|元|\d{4,}/.test(noSymbols), '訊息不含金額或股數');
  assert.equal(telegram[0].chat_id, '42');

  r = await runCheck(env, at('2026-10-29T02:10:00Z'));
  assert.equal(telegram.length, 1, '同一事件不重複');

  r = await runCheck(env, at('2026-10-29T05:50:00Z'));
  assert.equal(r.skipped, 'market-closed');
});

test('排程：正二跨過新的加碼階才通知；創新高更新高點', async () => {
  // 配置剛好在目標（163＋加碼 0）：原型 10%、正二 60%、現金 30%
  const w = sampleWatch();
  w.weights = { '0050': 0.1, '00631L': 0.6, DEPOSIT: 0.3 };
  w.refPrices = { '0050': 200, '00631L': 40 };
  w.peaks = { '00631L': { price: 40, locked: false } };
  await kv.put('watch', JSON.stringify(w));
  market['00631L'] = 39;
  await runCheck(env, { now: new Date('2026-10-29T02:00:00Z') });
  assert.equal(telegram.length, 0, '小跌不通知');

  market['00631L'] = 35.5; // 回檔 -11.25% → 第 1 階
  delete market['00685L']; delete market['00675L'];
  const r = await runCheck(env, { now: new Date('2026-10-29T02:10:00Z') });
  assert.equal(r.steps, 1);
  assert.equal(telegram.length, 1);
  assert.match(telegram[0].text, /00631L 從高點回檔 11%，達第 1 階/);

  await runCheck(env, { now: new Date('2026-10-29T02:20:00Z') });
  assert.equal(telegram.length, 1, '同一階不重複');

  market['00631L'] = 42; // 創新高
  await runCheck(env, { now: new Date('2026-10-29T02:30:00Z') });
  assert.equal(JSON.parse(kv.m.get('watch').val).peaks['00631L'].price, 42);
  assert.equal(JSON.parse(kv.m.get('alertState').val).addStep, 0);
});

test('/watch/test：寄測試訊息並回傳檢查結果', async () => {
  await kv.put('watch', JSON.stringify(sampleWatch()));
  const r = await (await call('/watch/test', { method: 'POST', headers: auth })).json();
  assert.equal(r.ok, true);
  assert.match(telegram[0].text, /測試通知/);
  assert.equal(r.result.out, true);
});

// ---------------- 股價下跌提醒（Email） ----------------
const paCfg = (over = {}) => ({
  v: 1, enabled: true, email: 'me@example.com', mode: 'TIMES', times: ['10:00'],
  rules: [{ symbol: '00631L', dropPct: 0.03 }, { symbol: '0050', dropPct: 0.02 }], ...over,
});

test('/price-alert：需要密鑰；驗證設定；可讀回', async () => {
  assert.equal((await call('/price-alert', { method: 'PUT', body: JSON.stringify(paCfg()) })).status, 401);
  const bad = await call('/price-alert', { method: 'PUT', headers: auth, body: JSON.stringify(paCfg({ email: 'x' })) });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /信箱/);
  assert.equal((await call('/price-alert', { method: 'PUT', headers: auth, body: JSON.stringify(paCfg()) })).status, 200);
  const g = await (await call('/price-alert', { headers: auth })).json();
  assert.equal(g.config.email, 'me@example.com');
});

test('排程：10:00 時 00631L 今日跌 4% → 寄一封 Email；同一時間不重寄', async () => {
  await kv.put('priceAlert', JSON.stringify(paCfg()));
  market['00631L'] = 35.0; // 模擬：昨收 = 現價 − 0.5 → 改成真正下跌
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    if (String(url).startsWith('https://mis.twse.com.tw/')) {
      return Promise.resolve(Response.json({ msgArray: [
        { c: '00631L', z: '35.00', y: '36.50', tlong: String(Date.now()) },
        { c: '0050', z: '199.00', y: '200.00', tlong: String(Date.now()) },
      ] }));
    }
    return origFetch(url, init);
  };
  let r = await runPriceAlert(env, { now: new Date('2026-10-29T09:50:00+08:00') });
  assert.equal(r.skipped, 'not-scheduled');
  r = await runPriceAlert(env, { now: new Date('2026-10-29T10:02:00+08:00') });
  assert.deepEqual(r.sent, ['00631L']);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ['me@example.com']);
  assert.equal(mails[0].auth, 'Bearer re_test');
  assert.match(mails[0].from, /onboarding@resend\.dev/);
  assert.match(mails[0].subject, /00631L 今日下跌 4\.1%/);
  r = await runPriceAlert(env, { now: new Date('2026-10-29T10:08:00+08:00') });
  assert.equal(r.skipped, 'already-sent');
  assert.equal(mails.length, 1);
});

test('排程：盤中即時模式每檔每天一次；收盤後不檢查', async () => {
  await kv.put('priceAlert', JSON.stringify(paCfg({ mode: 'INSTANT', times: [] })));
  globalThis.fetch = (url, init) => (String(url).startsWith('https://mis.twse.com.tw/')
    ? Promise.resolve(Response.json({ msgArray: [{ c: '00631L', z: '35.00', y: '36.50' }, { c: '0050', z: '199', y: '200' }] }))
    : externalFetch(url, init));
  await runPriceAlert(env, { now: new Date('2026-10-29T09:30:00+08:00') });
  await runPriceAlert(env, { now: new Date('2026-10-29T09:40:00+08:00') });
  assert.equal(mails.length, 1);
  const r = await runPriceAlert(env, { now: new Date('2026-10-29T14:10:00+08:00') });
  assert.equal(r.skipped, 'market-closed');
});

test('/price-alert/test：寄測試信並回傳各檔今日漲跌', async () => {
  await kv.put('priceAlert', JSON.stringify(paCfg()));
  const r = await (await call('/price-alert/test', { method: 'POST', headers: auth })).json();
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 2);
  assert.match(mails[0].subject, /測試信/);
});

test('沒設定 RESEND_API_KEY 時回傳清楚的錯誤', async () => {
  await kv.put('priceAlert', JSON.stringify(paCfg()));
  delete env.RESEND_API_KEY;
  const res = await call('/price-alert/test', { method: 'POST', headers: auth });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /RESEND_API_KEY/);
});

// ---------------- 月底收盤價 ----------------
function monthMock({ yahooDown = false } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url); calls.push(u);
    if (u.startsWith('https://query1.finance.yahoo.com/')) {
      if (yahooDown) return new Response('x', { status: 500 });
      const sym = u.match(/chart\/([^.]+)\.(TWO?)\?/);
      if ((sym[2] === 'TWO') !== (sym[1] === '00865B')) return new Response('{}', { status: 404 });
      // 10/29、10/30 兩個交易日，10/30 收盤缺值 → 取 10/29；最後一筆是 11/2（不屬於 10 月）
      const ts = [Date.parse('2026-10-29T01:00:00Z') / 1000, Date.parse('2026-10-30T01:00:00Z') / 1000, Date.parse('2026-11-02T01:00:00Z') / 1000];
      const close = sym[1] === '00631L' ? [37.1, null, 40] : [100.123, 101.5, 999];
      return Response.json({ chart: { result: [{ timestamp: ts, indicators: { quote: [{ close }] } }] } });
    }
    if (u.startsWith('https://www.twse.com.tw/exchangeReport/STOCK_DAY')) {
      return Response.json({ stat: 'OK', data: [['115/10/29', '1', '1', '1', '1', '1', '36.50'], ['115/10/30', '1', '1', '1', '1', '1', '1,234.50']] });
    }
    throw new Error('unexpected ' + u);
  };
  return calls;
}

test('月底收盤價：取當月最後一個有收盤價的交易日', async () => {
  monthMock();
  const r = await getMonthClose(['00631L', '0050', '00865B'], '2026-10', new Date('2026-11-05T00:00:00Z'));
  assert.deepEqual(r.closes['00631L'], { close: 37.1, date: '2026-10-29', source: 'YAHOO' });
  assert.deepEqual(r.closes['0050'], { close: 101.5, date: '2026-10-30', source: 'YAHOO' });
  assert.equal(r.closes['00865B'].close, 101.5);
  assert.deepEqual(r.errors, []);
});

test('月底收盤價：Yahoo 失敗改用證交所（民國日期、千分位）', async () => {
  monthMock({ yahooDown: true });
  const r = await getMonthClose(['2330'], '2026-10', new Date('2026-11-05T00:00:00Z'));
  assert.deepEqual(r.closes['2330'], { close: 1234.5, date: '2026-10-30', source: 'TWSE' });
});

test('/month-close：參數檢查、不能查未來月份', async () => {
  assert.equal((await call('/month-close?codes=0050')).status, 400);
  assert.equal((await call('/month-close?codes=0050&ym=2026-13')).status, 400);
  monthMock();
  const res = await call('/month-close?codes=0050&ym=2099-01');
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /未來/);
});

test.after(() => { globalThis.fetch = realFetch; });
