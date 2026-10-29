// 正二資產配置 Lite — Cloudflare Worker
//
// GET    /health
// GET    /quotes?codes=0050,00631L          即時報價（證交所 MIS，失敗改 Yahoo）
// GET    /month-close?codes=..&ym=2026-10    該月最後一個交易日收盤價（月底快照定案用）
// POST   /transfer                          暫存「已加密」備份 10 分鐘，回傳轉移碼
// GET    /transfer/{code}                   取回一次即刪除
// GET    /watch            （需通知密鑰）    查看雲端存的比例與上次檢查結果
// PUT    /watch            （需通知密鑰）    上傳比例（沒有股數、沒有金額）
// DELETE /watch            （需通知密鑰）    刪除比例、停止提醒
// POST   /watch/test       （需通知密鑰）    立即檢查一次並寄 Telegram 測試訊息
// GET    /price-alert      （需通知密鑰）    查看股價下跌提醒設定與今天寄送紀錄
// PUT    /price-alert      （需通知密鑰）    儲存下跌提醒設定（信箱、時間、代號、跌幅門檻）
// DELETE /price-alert      （需通知密鑰）    刪除設定
// POST   /price-alert/test （需通知密鑰）    寄一封測試信，並回傳目前各檔今日漲跌
// 排程（盤中每 10 分鐘）：① 比例偏離 → Telegram ② 當日跌幅達門檻 → Email
import { evaluateWatch, validateWatch, alertMessage, DEPOSIT_KEY } from '../../docs/js/engine/watch.js';
import { SYMBOLS } from '../../docs/js/engine/constants.js';
import {
  validatePriceAlert, evaluatePriceAlert, decidePriceAlert, buildPriceAlertEmail,
} from '../../docs/js/engine/priceAlert.js';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LEN = 8;
const TRANSFER_TTL = 600;
const MAX_BODY = 256 * 1024;
const QUOTE_TTL_MS = 15000;
const REBALANCE_REPEAT_MS = 3 * 24 * 3600 * 1000;
const UA = 'Mozilla/5.0 (compatible; lev2-lite/1.0)';

// ---------------- 共用 ----------------
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const list = allowedOrigins(env);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (list.includes('*')) h['Access-Control-Allow-Origin'] = '*';
  else if (origin && list.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}
async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return { error: 413 };
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: 413 };
  try { return { text, body: JSON.parse(text) }; } catch { return { error: 400 }; }
}
function timingSafeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
function authorized(request, env) {
  if (!env.NOTIFY_KEY) return false;
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') && timingSafeEqual(h.slice(7), env.NOTIFY_KEY);
}

// 台北時間：週一至週五 09:00–13:35 視為盤中（國定假日以來源回傳的收盤價為準）
export function isTaipeiMarketTime(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  const day = t.getUTCDay();
  const m = t.getUTCHours() * 60 + t.getUTCMinutes();
  return day >= 1 && day <= 5 && m >= 540 && m <= 815;
}

// ---------------- 報價 ----------------
const quoteCache = new Map(); // 同一個 Worker 執行個體內快取 15 秒

const num = (v) => {
  if (v == null || v === '-' || v === '') return null;
  const n = parseFloat(String(v).split('_')[0]);
  return n > 0 ? n : null;
};

async function fromTwse(symbols) {
  // 同時查上市 tse_ 與上櫃 otc_，不用事先知道市場別
  const exCh = symbols.flatMap((s) => [`tse_${s}.tw`, `otc_${s}.tw`]).join('|');
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://mis.twse.com.tw/stock/index.jsp', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`TWSE ${res.status}`);
  const j = await res.json();
  const out = {};
  for (const m of j.msgArray || []) {
    const symbol = m.c;
    if (!symbols.includes(symbol)) continue;
    const last = num(m.z);
    const prevClose = num(m.y);
    const price = last ?? num(m.b) ?? prevClose;
    if (!price) continue;
    out[symbol] = {
      price, prevClose,
      change: prevClose ? price - prevClose : null,
      changePct: prevClose ? (price - prevClose) / prevClose : null,
      quotedAt: m.tlong ? new Date(Number(m.tlong)).toISOString() : new Date().toISOString(),
      source: 'TWSE',
      traded: last != null,
    };
  }
  return out;
}

async function fromYahoo(symbol) {
  for (const suffix of ['.TW', '.TWO']) {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${suffix}?range=1d&interval=1d`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) continue;
    const j = await res.json().catch(() => null);
    const meta = j?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (!(price > 0)) continue;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    return {
      price, prevClose,
      change: prevClose ? price - prevClose : null,
      changePct: prevClose ? (price - prevClose) / prevClose : null,
      quotedAt: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : new Date().toISOString(),
      source: 'YAHOO',
      traded: true,
    };
  }
  return null;
}

export async function getQuotes(symbols, { fresh = false } = {}) {
  const key = [...symbols].sort().join(',');
  const hit = quoteCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.value;

  const errors = [];
  let quotes = {};
  try { quotes = await fromTwse(symbols); } catch (e) { errors.push(String(e.message || e)); }
  const missing = symbols.filter((s) => !quotes[s]);
  await Promise.all(missing.map(async (s) => {
    try { const q = await fromYahoo(s); if (q) quotes[s] = q; } catch (e) { errors.push(`YAHOO ${s}`); }
  }));
  const value = { fetchedAt: new Date().toISOString(), marketOpen: isTaipeiMarketTime(), quotes, errors };
  if (Object.keys(quotes).length) quoteCache.set(key, { at: Date.now(), value });
  return value;
}

// ---------------- 月底收盤價 ----------------
const taipeiDate = (ms) => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);

async function yahooMonthClose(symbol, startMs, endMs) {
  for (const suffix of ['.TW', '.TWO']) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${suffix}?period1=${Math.floor(startMs / 1000)}&period2=${Math.floor(endMs / 1000)}&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) continue;
    const j = await res.json().catch(() => null);
    const r = j?.chart?.result?.[0];
    const ts = r?.timestamp || [];
    const closes = r?.indicators?.quote?.[0]?.close || [];
    for (let i = ts.length - 1; i >= 0; i--) {
      const ms = ts[i] * 1000;
      if (closes[i] > 0 && ms >= startMs && ms < endMs) return { close: Math.round(closes[i] * 100) / 100, date: taipeiDate(ms), source: 'YAHOO' };
    }
  }
  return null;
}

async function twseMonthClose(symbol, y, m) {
  const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${y}${String(m).padStart(2, '0')}01&stockNo=${symbol}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  if (j?.stat !== 'OK' || !Array.isArray(j.data) || !j.data.length) return null;
  for (let i = j.data.length - 1; i >= 0; i--) {
    const row = j.data[i];
    const close = parseFloat(String(row[6]).replace(/,/g, ''));
    const [ry, rm, rd] = String(row[0]).split('/').map(Number); // 民國年
    if (close > 0 && ry) return { close, date: `${ry + 1911}-${String(rm).padStart(2, '0')}-${String(rd).padStart(2, '0')}`, source: 'TWSE' };
  }
  return null;
}

export async function getMonthClose(symbols, ym, now = new Date()) {
  const [y, m] = ym.split('-').map(Number);
  const startMs = Date.UTC(y, m - 1, 1) - 8 * 3600 * 1000; // 台北時間該月 1 日 00:00
  const endMs = Date.UTC(y, m, 1) - 8 * 3600 * 1000;
  if (startMs > now.getTime()) throw new Error('不能查詢未來月份');
  const closes = {};
  const errors = [];
  await Promise.all(symbols.map(async (s) => {
    try { const r = await yahooMonthClose(s, startMs, endMs); if (r) { closes[s] = r; return; } } catch { /* 改用證交所 */ }
    try { const r = await twseMonthClose(s, y, m); if (r) { closes[s] = r; return; } } catch { /* 都失敗 */ }
    errors.push(s);
  }));
  return { ym, closes, errors };
}

// ---------------- 轉移碼 ----------------
export function generateCode() {
  const out = [];
  const buf = new Uint8Array(CODE_LEN * 2);
  while (out.length < CODE_LEN) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 256 - (256 % ALPHABET.length)) out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === CODE_LEN) break;
    }
  }
  return out.join('');
}
function isEnvelope(x) {
  return !!(x && x.app === 'lev2-lite' && x.v === 1 && x.kdf && typeof x.kdf.salt === 'string'
    && x.cipher && typeof x.cipher.iv === 'string' && typeof x.data === 'string');
}

// ---------------- 提醒 ----------------
async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) throw new Error('尚未設定 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID');
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
}

// ---------------- Email（Resend） ----------------
export async function sendEmail(env, to, { subject, text, html }) {
  if (!env.RESEND_API_KEY) throw new Error('尚未設定 RESEND_API_KEY');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || '正二配置 <onboarding@resend.dev>', to: [to], subject, text, html }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(`Email 寄送失敗（${res.status}）${j.message ? '：' + j.message : ''}`);
  }
}

// 股價下跌提醒：每次排程執行一次
export async function runPriceAlert(env, { now = new Date() } = {}) {
  const raw = await env.LEV2.get('priceAlert');
  if (!raw) return { skipped: 'no-config' };
  const cfg = JSON.parse(raw);
  const state = JSON.parse((await env.LEV2.get('priceAlertState')) || 'null');
  // 先用時間判斷，不在時段就不抓股價
  const pre = decidePriceAlert(cfg, { hits: [] }, state ? JSON.parse(JSON.stringify(state)) : null, now);
  if (['disabled', 'market-closed', 'not-scheduled', 'already-sent'].includes(pre.reason) && cfg.mode === 'TIMES') return { skipped: pre.reason };
  if (['disabled', 'market-closed'].includes(pre.reason)) return { skipped: pre.reason };

  const q = await getQuotes(cfg.rules.map((r) => r.symbol), { fresh: true });
  const ev = evaluatePriceAlert(cfg, q.quotes);
  const d = decidePriceAlert(cfg, ev, state, now);
  const result = { checkedAt: now.toISOString(), hits: ev.hits.map((h) => ({ symbol: h.symbol, changePct: h.changePct })), sent: [] };
  if (d.send.length) {
    await sendEmail(env, cfg.email, buildPriceAlertEmail(d.send, { now, appUrl: env.APP_URL }));
    result.sent = d.send.map((h) => h.symbol);
  }
  d.state.last = result;
  if (JSON.stringify(d.state) !== JSON.stringify(state)) await env.LEV2.put('priceAlertState', JSON.stringify(d.state));
  return result;
}

// 檢查一次；force=true 時忽略盤中時間
export async function runCheck(env, { force = false, now = new Date() } = {}) {
  if (!force && !isTaipeiMarketTime(now)) return { skipped: 'market-closed' };
  const raw = await env.LEV2.get('watch');
  if (!raw) return { skipped: 'no-watch' };
  const watch = JSON.parse(raw);

  const symbols = [...new Set([
    ...Object.keys(watch.weights).filter((k) => k !== DEPOSIT_KEY),
    ...Object.keys(watch.peaks || {}),
  ])];
  const q = await getQuotes(symbols, { fresh: true });
  const prices = Object.fromEntries(Object.entries(q.quotes).map(([k, v]) => [k, v.price]));
  if (!Object.keys(prices).length) return { skipped: 'no-quotes', errors: q.errors };

  const r = evaluateWatch(watch, prices);
  const state = JSON.parse((await env.LEV2.get('alertState')) || '{}');
  const before = JSON.stringify(state);

  // 正二創新高：更新高點，加碼週期重新開始
  if (r.newPeaks.length) {
    for (const p of r.newPeaks) watch.peaks[p.symbol] = { ...watch.peaks[p.symbol], price: p.price };
    await env.LEV2.put('watch', JSON.stringify(watch));
    state.addStep = 0;
  }

  const t = now.getTime();
  let send = false;
  if (r.out) {
    if (!state.rebOut || t - (state.rebSentAt || 0) > REBALANCE_REPEAT_MS) { send = true; state.rebSentAt = t; }
    state.rebOut = true;
  } else {
    state.rebOut = false;
  }
  // 加碼：只在跨過「新的一階」時提醒；回升再跌回同一階不重複
  if (r.steps > (state.addStep || 0)) {
    if (r.addNowPct > 0) send = true;
    state.addStep = r.steps;
  }

  const result = {
    checkedAt: now.toISOString(),
    current: r.current, target: r.target, out: r.out, steps: r.steps, addNowPct: r.addNowPct,
    sent: false,
  };
  if (send) {
    await sendTelegram(env, alertMessage(r, env.APP_URL));
    result.sent = true;
  }
  state.last = result;
  if (JSON.stringify(state) !== before) await env.LEV2.put('alertState', JSON.stringify(state));
  return result;
}

// ---------------- 路由 ----------------
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = request.headers.get('Origin');
    // 帶 Origin 但不在允許清單 → 拒絕（直接在網址列打開 /health、/quotes 不帶 Origin，允許）
    if (origin && !cors['Access-Control-Allow-Origin']) return json({ error: '來源網站未被允許' }, 403, cors);

    try {
      if (path === '/health' || path === '/') {
        return json({ ok: true, notify: !!(env.NOTIFY_KEY && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), mail: !!(env.NOTIFY_KEY && env.RESEND_API_KEY), kv: !!env.LEV2 }, 200, cors);
      }

      if (path === '/quotes' && request.method === 'GET') {
        const codes = (url.searchParams.get('codes') || '').split(',').map((s) => s.trim().toUpperCase()).filter((s) => SYMBOLS.includes(s));
        if (!codes.length) return json({ error: '請提供 codes，例如 ?codes=0050,00631L' }, 400, cors);
        return json(await getQuotes(codes), 200, { ...cors, 'Cache-Control': 'no-store' });
      }

      if (path === '/month-close' && request.method === 'GET') {
        const codes = (url.searchParams.get('codes') || '').split(',').map((x) => x.trim().toUpperCase()).filter((x) => SYMBOLS.includes(x));
        const ym = url.searchParams.get('ym') || '';
        if (!codes.length || !/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) return json({ error: '請提供 codes 與 ym，例如 ?codes=0050&ym=2026-10' }, 400, cors);
        return json(await getMonthClose(codes, ym), 200, { ...cors, 'Cache-Control': 'public, max-age=3600' });
      }

      if (path === '/transfer' && request.method === 'POST') {
        if (!origin) return json({ error: '來源網站未被允許' }, 403, cors);
        const { body, text, error } = await readJson(request);
        if (error) return json({ error: error === 413 ? '資料太大' : '格式錯誤' }, error, cors);
        if (!isEnvelope(body)) return json({ error: '只接受加密後的備份' }, 400, cors);
        let code;
        for (let i = 0; i < 5 && !code; i++) {
          const c = generateCode();
          if (!(await env.LEV2.get('t:' + c))) code = c;
        }
        if (!code) return json({ error: '請稍後再試' }, 503, cors);
        await env.LEV2.put('t:' + code, text, { expirationTtl: TRANSFER_TTL });
        return json({ code, expiresAt: new Date(Date.now() + TRANSFER_TTL * 1000).toISOString() }, 201, cors);
      }

      const tm = path.match(/^\/transfer\/([23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8})$/);
      if (tm && request.method === 'GET') {
        if (!origin) return json({ error: '來源網站未被允許' }, 403, cors);
        const text = await env.LEV2.get('t:' + tm[1]);
        if (!text) return json({ error: '找不到或已過期' }, 404, cors);
        await env.LEV2.delete('t:' + tm[1]);
        return json({ envelope: JSON.parse(text) }, 200, cors);
      }

      if (path === '/price-alert' || path === '/price-alert/test') {
        if (!env.NOTIFY_KEY) return json({ error: 'Worker 尚未設定 NOTIFY_KEY' }, 503, cors);
        if (!authorized(request, env)) return json({ error: '雲端密鑰錯誤' }, 401, cors);
        if (path === '/price-alert' && request.method === 'GET') {
          const c = await env.LEV2.get('priceAlert');
          const st = await env.LEV2.get('priceAlertState');
          return json({ config: c ? JSON.parse(c) : null, state: st ? JSON.parse(st) : null }, 200, cors);
        }
        if (path === '/price-alert' && request.method === 'PUT') {
          const { body, error } = await readJson(request);
          if (error) return json({ error: '格式錯誤' }, error, cors);
          const errs = validatePriceAlert(body);
          if (errs.length) return json({ error: errs.join('；'), details: errs }, 400, cors);
          await env.LEV2.put('priceAlert', JSON.stringify(body));
          return json({ ok: true, savedAt: new Date().toISOString(), mail: !!env.RESEND_API_KEY }, 200, cors);
        }
        if (path === '/price-alert' && request.method === 'DELETE') {
          await env.LEV2.delete('priceAlert');
          await env.LEV2.delete('priceAlertState');
          return json({ ok: true }, 200, cors);
        }
        if (path === '/price-alert/test' && request.method === 'POST') {
          const c = await env.LEV2.get('priceAlert');
          if (!c) return json({ error: '請先儲存設定' }, 400, cors);
          const cfg = JSON.parse(c);
          const q = await getQuotes(cfg.rules.map((r) => r.symbol), { fresh: true });
          const ev = evaluatePriceAlert(cfg, q.quotes);
          await sendEmail(env, cfg.email, buildPriceAlertEmail(ev.rows, { appUrl: env.APP_URL, test: true }));
          return json({ ok: true, rows: ev.rows }, 200, cors);
        }
      }

      if (path === '/watch' || path === '/watch/test') {
        if (!env.NOTIFY_KEY) return json({ error: 'Worker 尚未設定 NOTIFY_KEY' }, 503, cors);
        if (!authorized(request, env)) return json({ error: '通知密鑰錯誤' }, 401, cors);

        if (path === '/watch' && request.method === 'GET') {
          const w = await env.LEV2.get('watch');
          const s = await env.LEV2.get('alertState');
          return json({ watch: w ? JSON.parse(w) : null, last: s ? JSON.parse(s).last || null : null }, 200, cors);
        }
        if (path === '/watch' && request.method === 'PUT') {
          const { body, error } = await readJson(request);
          if (error) return json({ error: '格式錯誤' }, error, cors);
          const errs = validateWatch(body);
          if (errs.length) return json({ error: '比例資料格式錯誤', details: errs }, 400, cors);
          await env.LEV2.put('watch', JSON.stringify(body));
          return json({ ok: true, savedAt: new Date().toISOString() }, 200, cors);
        }
        if (path === '/watch' && request.method === 'DELETE') {
          await env.LEV2.delete('watch');
          await env.LEV2.delete('alertState');
          return json({ ok: true }, 200, cors);
        }
        if (path === '/watch/test' && request.method === 'POST') {
          await sendTelegram(env, '【正二配置】測試通知：設定成功，之後配置需要調整時會在這裡通知你。');
          const result = await runCheck(env, { force: true }).catch((e) => ({ error: String(e.message || e) }));
          return json({ ok: true, result }, 200, cors);
        }
      }

      return json({ error: 'Not found' }, 404, cors);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([
      runCheck(env).catch((e) => console.log('allocation check failed', e.message)),
      runPriceAlert(env).catch((e) => console.log('price alert failed', e.message)),
    ]));
  },
};
