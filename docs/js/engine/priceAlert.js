// 股價「當日」下跌提醒：今日跌幅 =（現價 − 昨收）÷ 昨收
// 只用公開股價與你設定的代號／門檻，不需要持股或金額。網站與 Worker 共用。
import { SYMBOLS, security } from './constants.js';

export const SLOT_MINUTES = 10; // 雲端排程每 10 分鐘一次
export const MARKET_OPEN = 9 * 60;
export const MARKET_CLOSE = 13 * 60 + 30;

// 09:10、09:20 … 13:30 可選的提醒時間
export function timeOptions() {
  const out = [];
  for (let m = MARKET_OPEN + SLOT_MINUTES; m <= MARKET_CLOSE; m += SLOT_MINUTES) out.push(minutesToHHMM(m));
  return out;
}
export function minutesToHHMM(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function defaultPriceAlert() {
  return {
    enabled: false,
    email: '',
    mode: 'TIMES', // TIMES＝指定時間檢查；INSTANT＝盤中每 10 分鐘，跌破就寄
    times: ['13:20'],
    rules: SYMBOLS.map((symbol) => ({
      symbol,
      enabled: security(symbol).category === 'LEVERAGE',
      dropPct: security(symbol).category === 'LEVERAGE' ? 0.04 : 0.02,
    })),
  };
}

// 上傳到雲端的內容（只有信箱、時間、代號與門檻）
export function buildPriceAlertConfig(pa) {
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    enabled: !!pa.enabled,
    email: String(pa.email || '').trim(),
    mode: pa.mode === 'INSTANT' ? 'INSTANT' : 'TIMES',
    times: [...new Set(pa.times || [])].sort(),
    rules: (pa.rules || []).filter((r) => r.enabled).map((r) => ({ symbol: r.symbol, dropPct: r.dropPct })),
  };
}

const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

export function validatePriceAlert(c) {
  const errs = [];
  const allowed = ['v', 'updatedAt', 'enabled', 'email', 'mode', 'times', 'rules'];
  if (!c || c.v !== 1) errs.push('版本錯誤');
  for (const k of Object.keys(c || {})) if (!allowed.includes(k)) errs.push('不允許的欄位 ' + k);
  if (c?.enabled && !EMAIL_RE.test(c.email || '')) errs.push('收件信箱格式錯誤');
  if (!['TIMES', 'INSTANT'].includes(c?.mode)) errs.push('提醒方式錯誤');
  const valid = timeOptions();
  if (!Array.isArray(c?.times) || c.times.some((t) => !valid.includes(t))) errs.push('提醒時間需為 09:10–13:30 之間、每 10 分鐘');
  if (c?.enabled && c?.mode === 'TIMES' && !c.times.length) errs.push('至少設定一個提醒時間');
  if (!Array.isArray(c?.rules)) errs.push('追蹤清單錯誤');
  else for (const r of c.rules) {
    if (!SYMBOLS.includes(r?.symbol)) errs.push('代號錯誤 ' + r?.symbol);
    if (!(typeof r?.dropPct === 'number' && r.dropPct > 0 && r.dropPct <= 0.2)) errs.push(`${r?.symbol} 跌幅需在 0.1%–20%`);
  }
  if (c?.enabled && c?.rules?.length === 0) errs.push('至少追蹤一檔');
  return errs;
}

// 台北時間，向下取到 10 分鐘
export function taipeiSlot(now = new Date()) {
  const t = new Date(now.getTime() + 8 * 3600 * 1000);
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  return {
    date: t.toISOString().slice(0, 10),
    day: t.getUTCDay(),
    minutes,
    slot: minutesToHHMM(Math.floor(minutes / SLOT_MINUTES) * SLOT_MINUTES),
  };
}

// quotes: { symbol: { price, prevClose, changePct } }
export function evaluatePriceAlert(c, quotes) {
  const rows = [];
  for (const r of c.rules || []) {
    const q = quotes[r.symbol];
    const prev = q?.prevClose;
    const price = q?.price;
    const changePct = q?.changePct ?? (prev > 0 && price > 0 ? (price - prev) / prev : null);
    rows.push({
      symbol: r.symbol,
      name: security(r.symbol)?.name || r.symbol,
      price: price ?? null,
      prevClose: prev ?? null,
      changePct,
      dropPct: r.dropPct,
      hit: changePct != null && changePct <= -r.dropPct + 1e-12,
    });
  }
  return { rows, hits: rows.filter((x) => x.hit) };
}

// 排程這一輪要寄哪些（state 記錄今天已寄過的時間／代號，避免重複）
export function decidePriceAlert(c, evaluation, state, now = new Date()) {
  const { date, day, minutes, slot } = taipeiSlot(now);
  const s = state && state.date === date ? state : { date, slots: [], symbols: [] };
  const result = { send: [], state: s, reason: '' };
  if (!c?.enabled) { result.reason = 'disabled'; return result; }
  if (day === 0 || day === 6 || minutes < MARKET_OPEN || minutes > MARKET_CLOSE + 5) { result.reason = 'market-closed'; return result; }

  if (c.mode === 'TIMES') {
    if (!c.times.includes(slot)) { result.reason = 'not-scheduled'; return result; }
    if (s.slots.includes(slot)) { result.reason = 'already-sent'; return result; }
    s.slots = [...s.slots, slot];
    result.send = evaluation.hits;
    if (!result.send.length) result.reason = 'no-drop';
  } else {
    const fresh = evaluation.hits.filter((h) => !s.symbols.includes(h.symbol));
    s.symbols = [...s.symbols, ...fresh.map((h) => h.symbol)];
    result.send = fresh;
    if (!fresh.length) result.reason = evaluation.hits.length ? 'already-sent' : 'no-drop';
  }
  return result;
}

const pct = (x, d = 2) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const px = (x) => (x == null ? '—' : x.toFixed(2));
const escHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

export function buildPriceAlertEmail(hits, { now = new Date(), appUrl = '', test = false } = {}) {
  const { date, slot } = taipeiSlot(now);
  const first = hits[0];
  const subject = test
    ? '【正二配置】股價下跌提醒：測試信'
    : hits.length === 1
      ? `【正二配置】${first.symbol} 今日下跌 ${pct(-first.changePct, 1)}`
      : `【正二配置】${hits.length} 檔今日跌幅達提醒（${hits.map((h) => h.symbol).join('、')}）`;
  const intro = test
    ? '這是測試信。設定成功後，追蹤的股票當日跌幅達到門檻時，會寄信到這個信箱。'
    : `${date} ${slot}（台北時間）以下股票今日跌幅已達你設定的門檻：`;
  const lines = hits.map((h) => `${h.symbol} ${h.name}：現價 ${px(h.price)}，昨收 ${px(h.prevClose)}，今日 ${pct(h.changePct)}（門檻 -${pct(h.dropPct, 1)}）`);
  const text = [intro, '', ...lines, '', appUrl ? `開啟 App 查看：${appUrl}` : '', '', '試算工具，非投資建議。若要停止，請到 App「設定 → 股價下跌提醒」關閉。'].join('\n');

  const tr = hits.map((h) => `<tr>
    <td style="padding:8px 10px;border-bottom:1px solid #eee"><b>${escHtml(h.symbol)}</b><br><span style="color:#777;font-size:12px">${escHtml(h.name)}</span></td>
    <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${px(h.price)}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right">${px(h.prevClose)}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;color:#1c8a4e;font-weight:700">${pct(h.changePct)}</td>
    <td style="padding:8px 10px;border-bottom:1px solid #eee;text-align:right;color:#777">-${pct(h.dropPct, 1)}</td></tr>`).join('');
  const html = `<div style="font-family:-apple-system,'PingFang TC','Noto Sans TC','Microsoft JhengHei',sans-serif;max-width:560px;color:#1b1f27">
  <h2 style="font-size:18px;margin:0 0 8px">${escHtml(subject.replace('【正二配置】', ''))}</h2>
  <p style="margin:0 0 14px;color:#4a505c">${escHtml(intro)}</p>
  ${hits.length ? `<table style="border-collapse:collapse;width:100%;font-size:14px">
    <tr style="color:#777;font-size:12px"><td style="padding:6px 10px">股票</td><td style="padding:6px 10px;text-align:right">現價</td><td style="padding:6px 10px;text-align:right">昨收</td><td style="padding:6px 10px;text-align:right">今日</td><td style="padding:6px 10px;text-align:right">門檻</td></tr>
    ${tr}</table>` : ''}
  ${appUrl ? `<p style="margin:18px 0"><a href="${escHtml(appUrl)}" style="background:#284a7e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">開啟 App 查看</a></p>` : ''}
  <p style="color:#999;font-size:12px">台股慣例：跌為綠色。試算工具，非投資建議。若要停止，請到 App「設定 → 股價下跌提醒」關閉。</p></div>`;
  return { subject, text, html };
}
