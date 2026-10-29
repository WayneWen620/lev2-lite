// 正二資產配置 Lite — 畫面
import { SECURITIES, LEVERAGE_SYMBOLS, SYMBOLS, CATEGORY_LABEL, TIERS, security } from './engine/constants.js';
import { advise, annualExpense, settingsOf } from './engine/engine.js';
import { buildWatch } from './engine/watch.js';
import { buildPriceAlertConfig, validatePriceAlert, timeOptions } from './engine/priceAlert.js';
import { buildAutoSnapshot, snapshotChanged, finalizeSnapshot, needsFinalize, monthlyTable } from './engine/snapshot.js';
import {
  emptyData, sampleData, normalize, loadData, saveData, clearData,
  loadQuoteCache, saveQuoteCache, loadUi, saveUi, requestPersist,
} from './data.js';
import { QuotePoller, isMarketOpen, taipeiParts } from './quotes.js';
import {
  encryptAppData, decryptEnvelope, downloadEnvelope, readEnvelopeFile,
  createTransfer, fetchTransfer, summarizeForPreview, formatCode, BackupError,
} from './backup.js';

const APP_VERSION = '1.2.0';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------- 狀態 ----------------
const S = {
  data: loadData(),
  quotes: {},
  qstate: { state: 'idle' },
  ui: { page: 'home', filter: 'ALL', range: '1Y', sendTab: 'send', sel: null, ...loadUi() },
  result: null,
  installPrompt: null,
  pendingImport: null,
  transferCache: null,
};
const FIRST_RUN = !S.data;
if (!S.data) S.data = emptyData();
{
  const c = loadQuoteCache();
  if (c?.quotes) { S.quotes = c.quotes; S.qstate = { state: 'cache', at: c.fetchedAt }; }
}

// ---------------- 格式 ----------------
const tz = { timeZone: 'Asia/Taipei', hour12: false };
function fmtWan(yuan, d) {
  if (yuan == null || !isFinite(yuan)) return '—';
  const w = yuan / 1e4;
  const digits = d ?? (Math.abs(w) >= 1000 ? 0 : 1);
  return w.toLocaleString('zh-TW', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
const fmtPct = (x, d = 0) => (x == null || !isFinite(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const fmtSignedPct = (x, d = 1) => (x == null || !isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const fmtPrice = (p) => (p == null || !isFinite(p) ? '—' : p.toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const fmtInt = (n) => (Number(n) || 0).toLocaleString('zh-TW');
const fmtNum = (x, d = 2) => (x == null || !isFinite(x) ? '—' : x.toFixed(d));
const upDown = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : 'flat');
const arrow = (x) => (x > 0 ? '▲' : x < 0 ? '▼' : '');
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('zh-TW', { ...tz, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { ...tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
function sharesText(lots, odd) {
  const p = [];
  if (lots) p.push(`${fmtInt(lots)} 張`);
  if (odd) p.push(`${fmtInt(odd)} 股`);
  return p.join(' ') || '0 股';
}
const ymLabel = (ym) => ym.replace('-', '/');

// ---------------- 價格 ----------------
function prices() {
  const p = {};
  for (const h of S.data.holdings) {
    const q = S.quotes[h.symbol];
    if (q?.price > 0) p[h.symbol] = q.price;
    else if (h.manualPrice > 0) p[h.symbol] = h.manualPrice;
  }
  return p;
}
function priceInfo(symbol) {
  const q = S.quotes[symbol];
  const h = S.data.holdings.find((x) => x.symbol === symbol);
  if (q?.price > 0) {
    const label = S.qstate.state === 'cache' ? '快取' : isMarketOpen() ? '即時' : '收盤';
    return { price: q.price, change: q.change, changePct: q.changePct, label };
  }
  if (h?.manualPrice > 0) return { price: h.manualPrice, change: null, changePct: null, label: S.data.isSample ? '範例' : '手動' };
  return { price: null, change: null, changePct: null, label: '無股價' };
}

// ---------------- 儲存 ----------------
let persistAsked = false;
function save({ watch = true } = {}) {
  saveData(S.data);
  if (!persistAsked) { persistAsked = true; requestPersist(); }
  if (watch) scheduleWatchUpload();
}
function compute() { S.result = advise(S.data, prices()); return S.result; }

// ---------------- 提示 / 對話框 ----------------
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}
function openDialog(html, onMount) {
  const d = $('#dialog');
  $('#dialog-body').innerHTML = html;
  if (!d.open) d.showModal();
  onMount?.($('#dialog-body'));
}
function closeDialog() { const d = $('#dialog'); if (d.open) d.close(); }
$('#dialog').addEventListener('click', (e) => { if (e.target.id === 'dialog') closeDialog(); });

// ---------------- 頁首 ----------------
const TITLES = { home: '正二資產配置', chart: '月度走勢', assets: '我的資產', settings: '設定' };
function renderHeader() {
  $('#page-title').textContent = TITLES[S.ui.page];
  const st = settingsOf(S.data);
  const el = $('#status');
  const q = S.qstate;
  let cls = q.state, text;
  if (q.state === 'loading') text = '更新中…';
  else if (q.state === 'live') text = `盤中 ${fmtTime(q.at)}`;
  else if (q.state === 'close') text = `收盤 ${fmtDateTime(q.at)}`;
  else if (q.state === 'cache') text = `快取 ${fmtDateTime(q.at)}`;
  else if (q.state === 'error') text = '報價失敗';
  else { cls = 'manual'; text = S.data.isSample ? '範例股價' : st.workerUrl ? '等待報價' : '手動股價'; }
  el.className = 'status ' + cls;
  $('#status-text').textContent = text;
  el.title = q.error || '';
  $('#refresh').classList.toggle('spin', q.state === 'loading');
}
function renderNav() {
  for (const b of $$('.nav button')) b.toggleAttribute('aria-current', b.dataset.page === S.ui.page);
  for (const b of $$('.nav button')) if (b.dataset.page === S.ui.page) b.setAttribute('aria-current', 'page');
}

function go(page) {
  S.ui.page = page; saveUi(S.ui);
  render();
  window.scrollTo({ top: 0 });
}

function render() {
  compute();
  autoSnapshot();
  renderHeader();
  renderNav();
  const page = $('#page');
  if (S.ui.page === 'home') page.innerHTML = homeHtml();
  else if (S.ui.page === 'chart') page.innerHTML = chartPageHtml();
  else if (S.ui.page === 'assets') page.innerHTML = assetsHtml();
  else page.innerHTML = settingsHtml();
}

// ================= 首頁 =================
function homeHtml() {
  const r = S.result, s = r.summary, adv = r.settings.uiMode === 'ADVANCED';
  const anyHolding = s.items.some((i) => i.shares > 0) || s.deposits > 0;
  let h = '';
  if (!anyHolding) {
    h += `<section class="card banner-card span-2">
      <h2>開始使用</h2>
      <p class="hint">輸入你持有的股數、現金、負債與生活費，系統會算出 Beta、建議配置，並告訴你要買賣哪幾檔。資料只存在這台裝置。</p>
      <div class="btns">
        <button class="btn" data-action="go" data-to="assets">輸入我的持股</button>
        <button class="btn secondary" data-action="load-sample">先看範例</button>
        <button class="btn secondary" data-action="go-receive">從另一台裝置搬過來</button>
      </div></section>`;
  }
  if (S.data.isSample) {
    h += `<div class="banner-card span-2"><div class="banner"><span class="grow">目前是<b>範例資料</b>，股價為假設值（可算出 Excel 驗算值）。</span>
      <button class="btn secondary" data-action="clear-sample">改成我的資料</button></div></div>`;
  }
  if (s.missingPrices.length) {
    h += `<div class="banner-card span-2"><div class="banner warn"><span class="grow">缺少 ${s.missingPrices.map(esc).join('、')} 的股價，這幾檔暫不計入。請到「設定」填入報價服務網址，或在「資產」輸入手動股價。</span></div></div>`;
  }
  const lastBackup = S.data.lastBackupAt ? new Date(S.data.lastBackupAt).getTime() : 0;
  if (anyHolding && !S.data.isSample && Date.now() - lastBackup > 30 * 864e5) {
    h += `<div class="banner-card span-2"><div class="banner"><span class="grow">資料只存在這台裝置，建議定期匯出加密備份。</span>
      <button class="btn secondary" data-action="go-backup">去備份</button></div></div>`;
  }
  h += heroHtml(s);
  h += allocHtml(r, adv);
  h += adviceHtml(r, adv);
  h += debtHtml(r);
  h += levHtml(r, adv);
  h += holdingsHtml(r);
  return `<div class="grid home">${h}</div>`;
}

function previousSnapshot() {
  const ym = taipeiParts().ym;
  return [...S.data.snapshots].filter((x) => x.yearMonth < ym && x.financialAssets > 0)
    .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth)).pop() || null;
}

function heroHtml(s) {
  const prev = previousSnapshot();
  const diff = prev ? s.financialAssets - prev.financialAssets : null;
  const diffPct = prev && prev.financialAssets ? diff / prev.financialAssets : null;
  return `<section class="card hero">
    <div class="label">總金融資產</div>
    <div class="big num">${fmtWan(s.financialAssets, 0)}<small>萬</small></div>
    <div class="line num">
      <span>淨值 ${fmtWan(s.netWorth, 0)} 萬</span>
      <span>借貸 ${fmtWan(s.totalLiabilities, 0)} 萬</span>
      ${prev ? `<span class="${upDown(diff)}">比 ${ymLabel(prev.yearMonth)} 月底 ${arrow(diff)} ${fmtWan(Math.abs(diff), 0)} 萬（${fmtSignedPct(diffPct)}）</span>` : ''}
    </div></section>`;
}

const LIGHT_TEXT = { GREEN: '配置正常，不用動作', YELLOW: '正二回檔，可以加碼', RED: '配置跑掉了，建議調整' };

function barHtml(m, l, c, cls = '') {
  const w = (x) => `${Math.max(0, Math.min(100, x * 100)).toFixed(2)}%`;
  return `<div class="bar ${cls}"><span class="m" style="width:${w(m)}"></span><span class="l" style="width:${w(l)}"></span><span class="c" style="width:${w(c)}"></span></div>`;
}

function allocHtml(r, adv) {
  const s = r.summary, t = r.rebalance.target, cur = r.rebalance.current;
  const legend = [['MARKET', '原型', 'var(--market)'], ['LEVERAGE', '正二', 'var(--lev)'], ['CASH', '現金', 'var(--cash)']].map(([k, label, color]) => {
    const dev = r.rebalance.dev[k];
    const warn = Math.abs(dev) > r.settings.rebalanceThreshold;
    return `<div><div class="k"><i style="background:${color}"></i>${label}</div>
      <div class="v num">${fmtPct(cur[k])}</div>
      <div class="t num">目標 <b>${fmtPct(t[k])}</b>${adv || warn ? ` <span class="${warn ? 'up' : ''}">${dev > 0 ? '+' : ''}${(dev * 100).toFixed(0)}</span>` : ''}</div></div>`;
  }).join('');
  const tier = s.tier;
  const nextHint = adv && s.nextTier && s.amountToNextTier > 0
    ? `<p class="hint">距離下一級 ${s.nextTier.code}（${s.nextTier.min} 倍）還差約 ${fmtWan(s.amountToNextTier, 0)} 萬</p>` : '';
  const metrics = `<div class="metrics two">
      <div class="metric"><div class="k">生活費倍數</div><div class="v num">${fmtNum(s.multiple, 1)}<small> 倍 → ${tier.code}</small></div></div>
      <div class="metric"><div class="k">年開銷</div><div class="v num">${fmtWan(s.annualExpense)}<small> 萬</small></div></div>
    </div>`;
  return `<section class="card alloc">
    <h2>資產配置<span class="sub">建議 ${tier.code}${tier.manual ? '（自訂）' : ''}${r.add.targetAdded > 0 ? `・含加碼 ${fmtPct(r.add.targetAdded)}` : ''}</span></h2>
    <div class="light ${r.light}"><span class="lamp"></span><span>${LIGHT_TEXT[r.light]}</span></div>
    <div class="bar-row"><span>目前</span>${barHtml(cur.MARKET, cur.LEVERAGE, cur.CASH)}</div>
    <div class="bar-row"><span>目標</span>${barHtml(t.MARKET, t.LEVERAGE, t.CASH, 'target')}</div>
    <div class="legend">${legend}</div>
    ${metrics}${nextHint}
  </section>`;
}

// 借貸與槓桿：簡易版、進階版都顯示
function debtHtml(r) {
  const s = r.summary;
  const L = { loan: 0, personal: 0, homeEquity: 0, pledge: 0, ...S.data.liabilities };
  const debt = -s.totalLiabilities;
  const debtRatio = s.financialAssets > 0 ? debt / s.financialAssets : null;
  const t = r.rebalance.target;
  const targetBeta = t.MARKET + t.LEVERAGE * 2;
  const rows = [['loan', '借貸'], ['personal', '信貸'], ['homeEquity', '房增貸'], ['pledge', '質押']].map(([k, label]) => {
    const v = L[k] || 0;
    const w = s.financialAssets > 0 ? v / s.financialAssets : 0;
    return `<div class="debt-row num${v ? '' : ' zero'}"><span>${label}${k === 'personal' ? '<small>計入生活費倍數</small>' : ''}</span>
      <b>${v ? `-${fmtWan(v)}` : '0'} 萬</b><span class="w">${v ? fmtPct(w, 1) : '—'}</span></div>`;
  }).join('');
  const level = s.totalExposure == null ? '' : s.totalExposure > targetBeta + 0.15 ? 'up' : '';
  return `<section class="card debt">
    <h2>借貸與槓桿<span class="sub">總借貸 ${debt ? `-${fmtWan(debt, 0)}` : '0'} 萬</span></h2>
    <div class="metrics four">
      <div class="metric"><div class="k">本金槓桿</div><div class="v num">${fmtNum(s.principalLeverage)}<small> 倍</small></div><div class="f">總金融資產 ÷ 淨值</div></div>
      <div class="metric"><div class="k">曝險 Beta</div><div class="v num">${fmtNum(s.beta)}</div><div class="f">目標配置 ${fmtNum(targetBeta)}</div></div>
      <div class="metric"><div class="k">總曝險</div><div class="v num ${level}">${fmtNum(s.totalExposure)}<small> 倍</small></div><div class="f">本金槓桿 × Beta</div></div>
      <div class="metric"><div class="k">負債比</div><div class="v num">${fmtPct(debtRatio, 1)}</div><div class="f">總借貸 ÷ 總金融資產</div></div>
    </div>
    <div class="debt-list">
      <div class="debt-row head"><span>負債</span><span>金額</span><span>占資產</span></div>
      ${rows}
      <div class="debt-row total num"><span>總借貸</span><b>${debt ? `-${fmtWan(debt)}` : '0'} 萬</b><span class="w">${fmtPct(debtRatio, 1)}</span></div>
    </div>
    <p class="hint num">市場曝險金額＝市值型＋正二×2＝<b>${fmtWan(s.exposureAmount, 0)} 萬</b>，約為淨值 ${fmtWan(s.netWorth, 0)} 萬的 <b>${fmtNum(s.totalExposure)}</b> 倍；市場漲跌 1%，淨值約變動 ${fmtNum(s.totalExposure)}%。</p>
    <div class="btns"><button class="btn secondary" data-action="go" data-to="assets">修改借貸</button></div>
  </section>`;
}

function adviceHtml(r, adv) {
  const s = r.summary;
  if (!r.lines.length) {
    const nx = r.add.nextTriggerPrice && r.add.bench
      ? `<p class="hint">下一次加碼：${esc(r.add.bench.symbol)} 跌到 <b class="num">${fmtPrice(r.add.nextTriggerPrice)}</b>（${fmtPct(-(r.add.steps + 1) * r.settings.drawdownStep)}）</p>` : '';
    return `<section class="card advice"><h2>今天建議</h2>
      <p>${s.financialAssets > 0 ? '目前配置在範圍內，不用動作。' : '輸入資產後，這裡會告訴你要買賣哪幾檔。'}</p>${nx}</section>`;
  }
  const rows = r.lines.map((x) => {
    const sec = security(x.symbol);
    return `<div class="trade">
      <span class="side ${x.side}">${x.side === 'BUY' ? '買' : '賣'}</span>
      <div class="what"><b>${esc(x.symbol)}</b><div>${esc(sec.name)} · ${x.priceMissing ? '缺少股價' : `約 ${fmtWan(x.amount)} 萬 @ ${fmtPrice(x.price)}`}</div></div>
      <div class="qty num">${x.lots ? `${fmtInt(x.lots)} 張` : `${fmtInt(x.odd)} 股`}${x.lots && x.odd ? `<div>＋${fmtInt(x.odd)} 股</div>` : ''}</div>
    </div>`;
  }).join('');
  const a = r.after;
  const after = a ? `<div class="after num">執行後 → 原型 ${fmtPct(a.MARKET)}・正二 ${fmtPct(a.LEVERAGE)}・現金 ${fmtPct(a.CASH)}${adv ? `　預估費用 ${fmtInt(Math.round(r.lines.reduce((x, l) => x + l.cost, 0)))} 元` : ''}</div>` : '';
  return `<section class="card advice"><h2>今天建議<span class="sub">${r.mode === 'ADD' ? '正二加碼' : '再平衡'}</span></h2>
    ${rows}${after}
    <p class="explain">${esc(r.text)}</p>
    <div class="btns"><button class="btn" data-action="done">我已完成</button></div>
  </section>`;
}

function holdingsHtml(r) {
  const s = r.summary;
  const f = S.ui.filter;
  const held = s.items.filter((i) => i.shares > 0);
  const count = (c) => held.filter((i) => i.category === c).length;
  const chips = [['ALL', '全部', held.length + (s.deposits > 0 ? 1 : 0)], ['MARKET', '市值型', count('MARKET')], ['LEVERAGE', '正二', count('LEVERAGE')], ['CASH_LIKE', '類現金', count('CASH_LIKE') + (S.data.cashAccounts.filter((c) => c.amount > 0).length)]]
    .map(([k, label, n]) => `<button class="chip" data-action="filter" data-f="${k}" aria-pressed="${f === k}">${label}<span class="n">${n}</span></button>`).join('');

  const list = (f === 'ALL' ? held : held.filter((i) => i.category === f)).sort((a, b) => b.value - a.value);
  let subtotal;
  if (f === 'ALL') {
    subtotal = `<span>總金融資產 <b class="num">${fmtWan(s.financialAssets, 0)}</b> 萬</span><span>組合 Beta <b class="num">${fmtNum(s.beta)}</b></span>`;
  } else if (f === 'CASH_LIKE') {
    subtotal = `<span>現金合計 <b class="num">${fmtWan(s.cashValue, 0)}</b> 萬</span><span>占 <b class="num">${fmtPct(s.cashPct, 1)}</b></span><span class="hint">00865B＋定存＋活存</span>`;
  } else {
    const v = list.reduce((a, i) => a + i.value, 0);
    const b = list.reduce((a, i) => a + i.betaContribution, 0);
    subtotal = `<span>${CATEGORY_LABEL[f]}：持有 <b>${list.length}</b> 檔</span><span><b class="num">${fmtWan(v, 0)}</b> 萬</span><span>占 <b class="num">${fmtPct(s.financialAssets ? v / s.financialAssets : 0, 1)}</b></span><span>Beta 貢獻 <b class="num">${fmtNum(b)}</b></span>`;
  }

  const lev = new Map(r.add.levs.map((x) => [x.symbol, x]));
  const rows = list.map((i) => {
    const p = priceInfo(i.symbol);
    const chg = p.changePct != null ? `<span class="${upDown(p.change)}">${arrow(p.change)}${fmtPrice(Math.abs(p.change))}（${fmtSignedPct(p.changePct)}）</span>` : `<span class="flat">${esc(p.label)}</span>`;
    const dd = (i.category === 'LEVERAGE' && lev.get(i.symbol)?.dd != null ? ` · 回檔 ${fmtSignedPct(lev.get(i.symbol).dd)}` : '')
      + (priceAlertHit(i.symbol) ? ' · <span class="alert-tag">⚠ 跌幅達提醒</span>' : '');
    return `<div class="hold">
      <div class="sym"><b>${esc(i.symbol)}</b>${f === 'ALL' ? `<span class="tag ${i.category}">${CATEGORY_LABEL[i.category]}</span>` : ''}<div class="nm">${esc(i.name)}${dd}</div></div>
      <div class="px num"><b>${fmtPrice(p.price)}</b>${p.changePct != null ? `<div class="chg">${chg}</div>` : ''}<div class="src">${esc(p.label)}</div></div>
      <div class="chg-col num">${chg}</div>
      <div class="c-sh num">${fmtInt(i.shares)}</div>
      <div class="val num"><b>${fmtWan(i.value)}</b> 萬<div>${fmtPct(i.weight, 1)} · β ${fmtNum(i.betaContribution)}</div></div>
      <div class="c-w num">${fmtPct(i.weight, 1)}</div>
      <div class="c-b num">${fmtNum(i.betaContribution)}</div>
    </div>`;
  });
  if (f === 'ALL' || f === 'CASH_LIKE') {
    for (const c of S.data.cashAccounts.filter((x) => x.amount > 0)) {
      const w = s.financialAssets ? c.amount / s.financialAssets : 0;
      rows.push(`<div class="hold">
        <div class="sym"><b>${esc(c.bankName || '存款')}</b>${f === 'ALL' ? '<span class="tag CASH">現金</span>' : ''}<div class="nm">${c.type === 'TIME_DEPOSIT' ? '定存' : '活存'}</div></div>
        <div class="px num"><b>—</b></div><div class="chg-col"></div><div class="c-sh"></div>
        <div class="val num"><b>${fmtWan(c.amount)}</b> 萬<div>${fmtPct(w, 1)} · β 0.00</div></div>
        <div class="c-w num">${fmtPct(w, 1)}</div><div class="c-b num">0.00</div></div>`);
    }
  }
  const unheld = s.items.filter((i) => i.shares === 0 && (f === 'ALL' || i.category === f));
  const unheldHtml = unheld.length && f !== 'ALL'
    ? `<div class="unheld">未持有：${unheld.map((i) => esc(i.symbol)).join('、')} <button data-action="go" data-to="assets">輸入股數</button></div>` : '';
  const empty = !rows.length ? `<p class="hint">${f === 'ALL' ? '還沒有持股。' : `目前沒有持有${CATEGORY_LABEL[f]}。`}</p>` : '';

  return `<section class="card holdings"><h2>持股與即時股價</h2>
    <div class="chips" role="group" aria-label="類別篩選">${chips}</div>
    <div class="subtotal">${subtotal}</div>
    ${rows.length ? `<div class="hold-head"><span>標的</span><span>現價</span><span>漲跌</span><span>股數</span><span>市值（萬）</span><span>權重</span><span>β 貢獻</span></div>` : ''}
    ${rows.join('')}${empty}${unheldHtml}
  </section>`;
}

function levHtml(r, adv) {
  const a = r.add, st = r.settings;
  const withPeak = a.levs.filter((x) => x.peak);
  if (!withPeak.length) {
    return `<section class="card levcard"><h2>正二回檔與加碼</h2><p class="hint">還沒有設定正二高點。到「資產 → 正二高點」輸入，或設定報價服務後會自動帶入。</p></section>`;
  }
  const progress = a.cap > 0 ? Math.min(1, a.targetAdded / a.cap) : 0;
  const summary = a.bench
    ? `<div class="lev-top"><span>基準 <b>${esc(a.bench.symbol)}</b></span><span class="dd ${upDown(a.bench.dd)} num">回檔 ${fmtSignedPct(a.bench.dd)}・第 ${a.steps} 階</span></div>
       <div class="progress"><span style="width:${(progress * 100).toFixed(1)}%"></span></div>
       <div class="hint num">已觸發加碼 ${fmtPct(a.targetAdded)} ／ 上限 ${fmtPct(a.cap)}${a.nextTriggerPrice ? `　下一階：${fmtPrice(a.nextTriggerPrice)}` : ''}</div>`
    : '<p class="hint">基準標的沒有股價或高點。</p>';
  const rows = a.levs.map((x) => `<div class="lev-row">
      <div class="lev-top"><span><b>${esc(x.symbol)}</b> <span class="hint">${esc(x.name)}${x.held ? '' : '（未持有）'}</span></span>
        <span class="dd num ${upDown(x.dd)}">${x.dd != null ? fmtSignedPct(x.dd) : '—'}</span></div>
      <div class="hint num">現價 ${fmtPrice(x.price)} ・ 高點 ${fmtPrice(x.peak)}${x.peakDate ? `（${esc(x.peakDate)}）` : ''}${x.locked ? ' 🔒' : ''}</div>
      ${adv && x.ladder.length ? `<div class="ladder num">${x.ladder.map((l) => `<span class="${x.dd != null && x.dd <= l.pct + 1e-9 ? 'hit' : ''}">${fmtPct(l.pct)} ${fmtPrice(l.price)}</span>`).join('')}</div>` : ''}
    </div>`).join('');
  return `<section class="card levcard"><h2>正二回檔與加碼<span class="sub">每跌 ${fmtPct(st.drawdownStep)} 加 ${fmtPct(st.addPerStep)}</span></h2>${summary}<h3>三檔正二</h3>${rows}</section>`;
}

// ---------- 我已完成 ----------
function openDone() {
  const r = S.result;
  const changes = new Map();
  let cashDelta = 0;
  for (const l of r.lines) {
    const h = S.data.holdings.find((x) => x.symbol === l.symbol);
    const cur = changes.get(l.symbol)?.to ?? h.shares;
    changes.set(l.symbol, { from: h.shares, to: Math.max(0, cur + (l.side === 'BUY' ? l.shares : -l.shares)) });
    cashDelta += l.side === 'BUY' ? -(l.amount + l.cost) : (l.amount - l.cost);
  }
  let acct = S.data.cashAccounts.find((c) => c.type === 'DEMAND');
  const curCash = acct ? acct.amount : 0;
  const newCash = Math.max(0, curCash + cashDelta);
  const rows = [...changes].map(([sym, c]) => `<div class="field-row"><div><b>${esc(sym)}</b><div class="meta num">原本 ${fmtInt(c.from)} 股</div></div>
    <input type="number" inputmode="numeric" min="0" step="1" data-done-sym="${esc(sym)}" value="${c.to}" aria-label="${esc(sym)} 新股數"></div>`).join('');
  openDialog(`<h2>更新持股</h2><p class="hint">依實際成交的股數修改後再確認。</p>
    ${rows}
    <div class="field-row"><div><b>${esc(acct?.bankName || '活存')}</b><div class="meta num">原本 ${fmtWan(curCash)} 萬（已扣估計手續費、稅）</div></div>
      <input type="number" inputmode="decimal" min="0" step="0.1" id="done-cash" value="${(newCash / 1e4).toFixed(1)}" aria-label="活存（萬元）"></div>
    <div class="btns"><button class="btn secondary" data-action="close-dialog">取消</button><button class="btn" data-action="done-confirm">確認更新</button></div>`);
}
function confirmDone() {
  for (const el of $$('[data-done-sym]', $('#dialog-body'))) {
    const h = S.data.holdings.find((x) => x.symbol === el.dataset.doneSym);
    h.shares = Math.max(0, Math.floor(Number(el.value) || 0));
  }
  let acct = S.data.cashAccounts.find((c) => c.type === 'DEMAND');
  if (!acct) { acct = { id: 'c' + Date.now(), type: 'DEMAND', bankName: '活存', amount: 0 }; S.data.cashAccounts.unshift(acct); }
  acct.amount = Math.max(0, Math.round((Number($('#done-cash').value) || 0) * 1e4));
  S.data.isSample = false;
  save();
  closeDialog();
  render();
  toast('已更新持股');
}

// ================= 走勢 =================
// ---------- 月度快照：本月自動記錄、跨月以月底收盤價定案 ----------
function autoSnapshot() {
  if (S.data.isSample) return;
  const s = S.result.summary;
  if (!(s.financialAssets > 0) || s.missingPrices.length) return;
  const { ym, ymd } = taipeiParts();
  const cur = S.data.snapshots.find((x) => x.yearMonth === ym);
  if (cur && cur.source === 'IMPORT') return; // 使用者補登的本月不覆蓋
  const next = buildAutoSnapshot(S.data, s, { ym, ymd });
  if (cur && !snapshotChanged(cur, next)) return;
  S.data.snapshots = S.data.snapshots.filter((x) => x.yearMonth !== ym).concat(next);
  saveData(S.data);
}

let finalizing = false;
async function finalizePastMonths() {
  if (finalizing) return;
  const { ym } = taipeiParts();
  const pending = S.data.snapshots.filter((x) => needsFinalize(x, ym));
  if (!pending.length) return;
  finalizing = true;
  const url = settingsOf(S.data).workerUrl;
  const done = [];
  try {
    for (const snap of pending) {
      let closes = {};
      if (url) {
        try {
          const u = new URL('/month-close', url);
          u.searchParams.set('codes', Object.keys(snap.holdings || {}).join(','));
          u.searchParams.set('ym', snap.yearMonth);
          const res = await fetch(u, { cache: 'no-store' });
          if (!res.ok) throw new Error(String(res.status));
          closes = (await res.json()).closes || {};
        } catch { continue; } // 網路失敗：下次開啟再試
      }
      const f = finalizeSnapshot(snap, closes, S.data.settings);
      S.data.snapshots = S.data.snapshots.map((x) => (x.yearMonth === snap.yearMonth ? f : x));
      done.push(f);
    }
  } finally { finalizing = false; }
  if (done.length) {
    saveData(S.data);
    const f = done[done.length - 1];
    toast(f.source === 'MONTH_END'
      ? `已用 ${ymLabel(f.yearMonth)} 月底收盤價（${f.asOf.slice(5).replace('-', '/')}）記錄該月資產`
      : `${ymLabel(f.yearMonth)} 以最後一次開啟時的價格記錄`);
    render();
  }
}

const SRC_LABEL = (x, ym) => {
  if (x.source === 'AUTO') return x.yearMonth === ym ? `本月・自動更新（${(x.asOf || '').slice(5).replace('-', '/')}）` : '待定案';
  if (x.source === 'MONTH_END') return `月底收盤 ${(x.asOf || '').slice(5).replace('-', '/')}${x.missing ? '・部分沿用舊價' : ''}`;
  if (x.source === 'LAST_OPEN') return `最後開啟 ${(x.asOf || '').slice(5).replace('-', '/')}`;
  if (x.source === 'IMPORT') return '補登';
  return '手動存檔';
};

// 走勢資料：快照＋（範例或缺本月時）本月即時點
function chartRows() {
  const { ym } = taipeiParts();
  const snaps = S.data.snapshots.filter((x) => x.financialAssets > 0);
  const s = S.result.summary;
  if (s.financialAssets > 0 && !snaps.some((x) => x.yearMonth === ym)) {
    snaps.push({ yearMonth: ym, financialAssets: Math.round(s.financialAssets), netWorth: Math.round(s.netWorth), source: 'LIVE' });
  }
  return monthlyTable(snaps).map((r) => ({ ...r, ym: r.yearMonth, fa: r.financialAssets, nw: r.netWorth ?? null, live: r.yearMonth === ym && (r.source === 'AUTO' || r.source === 'LIVE') }));
}

function niceStep(range, ticks) {
  const raw = range / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const r = raw / mag;
  return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 2.5 ? 2.5 : r <= 5 ? 5 : 10) * mag;
}

function chartSvg(pts, sel) {
  const W = 640, H = 260, L = 56, R = 16, T = 14, B = 30;
  if (!pts.length) return '<p class="hint">還沒有資料。輸入資產後按「存本月快照」，或在下方補登過去月份。</p>';
  const vals = pts.flatMap((p) => [p.fa, p.nw]).filter((v) => v != null).map((v) => v / 1e4);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { hi += 1; lo -= 1; }
  const step = niceStep(hi - lo, 4);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1));
  const y = (v) => T + (1 - (v / 1e4 - lo) / (hi - lo)) * (H - T - B);
  let g = '';
  for (let v = lo; v <= hi + 1e-9; v += step) {
    const yy = T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    g += `<line class="grid-line" x1="${L}" x2="${W - R}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}"/><text class="axis" x="${L - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end">${v.toLocaleString('zh-TW', { maximumFractionDigits: 1 })}</text>`;
  }
  const every = Math.max(1, Math.ceil(pts.length / 7));
  pts.forEach((p, i) => {
    if (i % every === 0 || i === pts.length - 1) {
      const [yy, mm] = p.ym.split('-');
      const label = i === 0 || mm === '01' ? `${yy.slice(2)}/${mm}` : mm;
      g += `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${label}</text>`;
    }
  });
  const solid = pts.filter((p) => !p.live);
  const idx = (p) => pts.indexOf(p);
  const line = (arr, key) => arr.filter((p) => p[key] != null).map((p, k) => `${k ? 'L' : 'M'}${x(idx(p)).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  let body = '';
  if (solid.length > 1) {
    const d = line(solid, 'fa');
    body += `<path class="area" d="${d} L${x(idx(solid[solid.length - 1])).toFixed(1)},${H - B} L${x(idx(solid[0])).toFixed(1)},${H - B} Z"/>`;
    body += `<path class="fa" d="${d}"/>`;
  }
  const nw = line(solid, 'nw');
  if (nw.includes('L')) body += `<path class="nw" d="${nw}"/>`;
  const live = pts.find((p) => p.live);
  if (live && solid.length) {
    const last = solid[solid.length - 1];
    body += `<path class="live" d="M${x(idx(last)).toFixed(1)},${y(last.fa).toFixed(1)} L${x(idx(live)).toFixed(1)},${y(live.fa).toFixed(1)}"/>`;
  }
  if (sel != null && pts[sel]) body += `<line class="cursor" x1="${x(sel)}" x2="${x(sel)}" y1="${T}" y2="${H - B}"/>`;
  pts.forEach((p, i) => { body += `<circle class="pt${i === sel ? ' sel' : ''}" cx="${x(i).toFixed(1)}" cy="${y(p.fa).toFixed(1)}" r="${i === sel ? 5 : 3.5}"${p.live ? ' stroke-dasharray="2 2"' : ''}/>`; });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="月度總金融資產折線圖" data-action="chart-tap" data-l="${L}" data-r="${R}" data-w="${W}" data-n="${pts.length}">${g}${body}</svg>`;
}

function changeHtml(c) {
  if (!c) return '<span class="flat">—</span>';
  return `<span class="${upDown(c.amount)}">${arrow(c.amount)} ${fmtWan(Math.abs(c.amount), 0)} 萬${c.pct != null ? `<small>${fmtSignedPct(c.pct)}</small>` : ''}</span>`;
}

function chartPageHtml() {
  const { ym } = taipeiParts();
  const all = chartRows();
  const n = S.ui.range === '6M' ? 6 : S.ui.range === '1Y' ? 12 : Infinity;
  const pts = all.slice(-n);
  const sel = S.ui.sel != null && S.ui.sel < pts.length ? S.ui.sel : pts.length - 1;
  const p = pts[sel];
  const ranges = [['6M', '6 個月'], ['1Y', '1 年'], ['ALL', '全部']].map(([k, l]) => `<button class="chip" data-action="range" data-r="${k}" aria-pressed="${S.ui.range === k}">${l}</button>`).join('');
  const sum = p ? `<div class="chart-sum num">
      <div><div class="k">${ymLabel(p.ym)}${p.live ? '（本月）' : ' 月底'}</div><div class="v">${fmtWan(p.fa, 0)} 萬</div></div>
      <div><div class="k">月增減</div><div class="v">${changeHtml(p.monthChange)}</div></div>
      <div><div class="k">今年以來</div><div class="v">${changeHtml(p.ytdChange)}</div></div>
      <div><div class="k">累積（自 ${ymLabel(all[0].ym)}）</div><div class="v">${changeHtml(p.cumulative)}</div></div>
    </div>${p.nw != null ? `<p class="hint num">淨值 ${fmtWan(p.nw, 0)} 萬${p.gapMonths > 1 ? `・與前一筆相隔 ${p.gapMonths} 個月` : ''}</p>` : ''}` : '';

  const list = [...all].reverse().map((x) => `<div class="snap num">
      <b>${ymLabel(x.ym)}</b>
      <div>${fmtWan(x.fa, 0)} 萬 <span class="mchg">${changeHtml(x.monthChange)}</span>
        <div class="src">${esc(SRC_LABEL(x, ym))}${x.netWorth != null ? `・淨值 ${fmtWan(x.netWorth, 0)} 萬` : ''}${x.tierCode ? `・${esc(x.tierCode)}` : ''}</div></div>
      ${x.source === 'LIVE' ? '<span></span>' : `<button class="x" data-action="del-snap" data-ym="${esc(x.ym)}" aria-label="刪除 ${esc(x.ym)}">×</button>`}
    </div>`).join('') || '<p class="hint">還沒有資料。輸入資產後，本月會自動記錄。</p>';

  return `<div class="grid chartpage">
    <section class="card chart-card span-2"><h2>月度總金融資產<span class="sub">單位：萬</span></h2>
      <div class="chips">${ranges}</div>
      <div class="chart-wrap">${chartSvg(pts, sel)}</div>
      <p class="hint">實線：月底總金融資產・灰線：淨值・虛線：本月（每次開啟自動更新）</p>
      ${sum}
    </section>
    <section class="card snap-card"><h2>每月紀錄</h2>
      <p class="hint" style="margin:0 0 8px">每月自動保留<b>最後一個交易日</b>的資產：本月每次開啟自動更新，跨月後以該月最後一個交易日收盤價定案。</p>
      ${list}
    </section>
    <section class="card add-card"><h2>補登過去月份</h2>
      <label class="f" for="imp-ym">月份</label><input type="month" id="imp-ym" max="${ym}">
      <div class="row2">
        <div><label class="f" for="imp-fa">總金融資產（萬）</label><input type="number" inputmode="decimal" id="imp-fa" min="0"></div>
        <div><label class="f" for="imp-nw">淨值（萬，選填）</label><input type="number" inputmode="decimal" id="imp-nw"></div>
      </div>
      <button class="btn secondary block" style="margin-top:12px" data-action="import-snap">新增</button>
      <div class="msg" id="imp-msg"></div>
    </section>
  </div>`;
}

function importSnapshot() {
  const ym = $('#imp-ym').value;
  const fa = Number($('#imp-fa').value);
  const nwRaw = $('#imp-nw').value;
  const msg = $('#imp-msg');
  if (!/^\d{4}-\d{2}$/.test(ym)) { msg.className = 'msg err'; msg.textContent = '請選擇月份'; return; }
  if (!(fa > 0)) { msg.className = 'msg err'; msg.textContent = '請輸入總金融資產'; return; }
  if (S.data.snapshots.some((x) => x.yearMonth === ym) && !confirm(`${ymLabel(ym)} 已有資料，要覆蓋嗎？`)) return;
  S.data.snapshots = S.data.snapshots.filter((x) => x.yearMonth !== ym).concat({
    yearMonth: ym, financialAssets: Math.round(fa * 1e4), netWorth: nwRaw === '' ? null : Math.round(Number(nwRaw) * 1e4), source: 'IMPORT',
  });
  save({ watch: false });
  render();
  toast(`已補登 ${ymLabel(ym)}`);
}

// ================= 資產 =================
function numIn(bind, value, { type = 'wan', step = 'any', label = '', placeholder = '' } = {}) {
  let v = '';
  if (value != null && value !== '' && !(type !== 'price' && value === 0 && placeholder)) {
    v = type === 'wan' ? +(value / 1e4).toFixed(4) : type === 'pct' ? +(value * 100).toFixed(4) : value;
  }
  const mode = 'decimal';
  return `<input type="number" inputmode="${mode}" step="${step}" min="0" data-bind="${bind}" data-type="${type}" value="${v}" placeholder="${esc(placeholder)}" aria-label="${esc(label)}">`;
}

function assetsSummaryInner() {
  const s = compute().summary;
  return `<span>總金融資產 <b class="num">${fmtWan(s.financialAssets, 0)}</b> 萬</span><span>淨值 <b class="num">${fmtWan(s.netWorth, 0)}</b> 萬</span><span>年開銷 <b class="num">${fmtWan(s.annualExpense)}</b> 萬</span><span>生活費 <b class="num">${fmtNum(s.multiple, 1)}</b> 倍 → <b>${s.tier.code}</b></span>`;
}

function assetsHtml() {
  const d = S.data;
  const holdRows = SECURITIES.map((sec, i) => {
    const h = d.holdings[i];
    const p = priceInfo(sec.symbol);
    return `<div class="field-row wide">
      <div><b>${sec.symbol}</b><span class="tag ${sec.category}">${CATEGORY_LABEL[sec.category]}</span>
        <div class="meta num">${esc(sec.name)} · ${p.price != null ? `${fmtPrice(p.price)}（${esc(p.label)}）` : '無股價'}</div></div>
      ${numIn(`holdings.${i}.shares`, h.shares || '', { type: 'int', step: 'any', label: `${sec.symbol} 股數`, placeholder: '0' })}
      ${numIn(`holdings.${i}.manualPrice`, h.manualPrice, { type: 'price', step: '0.01', label: `${sec.symbol} 手動股價`, placeholder: '手動價' })}
    </div>`;
  }).join('');

  const cashRows = d.cashAccounts.map((c, i) => `<div class="list-row">
      <input type="text" data-bind="cashAccounts.${i}.bankName" data-type="text" value="${esc(c.bankName)}" placeholder="銀行／名稱" aria-label="帳戶名稱">
      <select data-bind="cashAccounts.${i}.type" data-type="select" aria-label="類型">
        <option value="DEMAND"${c.type === 'DEMAND' ? ' selected' : ''}>活存</option>
        <option value="TIME_DEPOSIT"${c.type === 'TIME_DEPOSIT' ? ' selected' : ''}>定存</option></select>
      ${numIn(`cashAccounts.${i}.amount`, c.amount, { label: '金額（萬）', placeholder: '萬' })}
      <button class="x" data-action="del-cash" data-i="${i}" aria-label="刪除">×</button></div>`).join('');

  const L = [['loan', '借貸'], ['personal', '信貸'], ['homeEquity', '房增貸'], ['pledge', '質押']].map(([k, label]) => `<div class="field-row">
      <div>${label}${k === 'personal' ? '<div class="meta">會從生活費倍數扣除</div>' : ''}</div>
      ${numIn(`liabilities.${k}`, d.liabilities[k], { label: `${label}（萬）`, placeholder: '0' })}</div>`).join('');

  const extras = d.expense.extras.map((e, i) => `<div class="list-row two">
      <input type="text" data-bind="expense.extras.${i}.name" data-type="text" value="${esc(e.name)}" placeholder="例如：旅遊" aria-label="項目">
      ${numIn(`expense.extras.${i}.annualAmount`, e.annualAmount, { label: '每年（萬）', placeholder: '萬／年' })}
      <button class="x" data-action="del-extra" data-i="${i}" aria-label="刪除">×</button></div>`).join('');

  const peaks = d.peaks.map((p, i) => {
    const pr = priceInfo(p.symbol).price;
    const dd = pr && p.peakPrice ? (pr - p.peakPrice) / p.peakPrice : null;
    return `<div class="field-row wide">
      <div><b>${p.symbol}</b><div class="meta num">現價 ${fmtPrice(pr)}${dd != null ? ` · 回檔 ${fmtSignedPct(dd)}` : ''}</div>
        <label class="check" style="margin:4px 0 0"><input type="checkbox" data-bind="peaks.${i}.locked" data-type="bool"${p.locked ? ' checked' : ''}>鎖定，不自動更新</label></div>
      ${numIn(`peaks.${i}.peakPrice`, p.peakPrice, { type: 'price', step: '0.01', label: `${p.symbol} 高點`, placeholder: '高點' })}
      <input type="date" data-bind="peaks.${i}.peakDate" data-type="text" value="${esc(p.peakDate || '')}" aria-label="${p.symbol} 高點日期">
    </div>`;
  }).join('');

  return `<div class="grid assets">
    <section class="card span-2"><div class="subtotal" id="assets-sum" style="margin:0">${assetsSummaryInner()}</div>
      <p class="hint">修改後自動儲存在這台裝置。金額單位為「萬元」。</p></section>
    <section class="card span-2"><h2>持股股數<span class="sub">股數 ／ 手動股價（沒有報價時用）</span></h2>${holdRows}</section>
    <section class="card"><h2>現金（定存・活存）</h2>${cashRows}
      <button class="btn secondary" data-action="add-cash">＋ 新增帳戶</button></section>
    <section class="card"><h2>負債（萬元）</h2>${L}</section>
    <section class="card"><h2>生活開銷</h2>
      <div class="field-row"><div>每月生活費（萬）</div>${numIn('expense.monthlyLiving', d.expense.monthlyLiving, { label: '每月生活費', placeholder: '0' })}</div>
      <h3>其他年度開銷</h3>${extras || '<p class="hint">例如旅遊、保險、紅包。</p>'}
      <button class="btn secondary" data-action="add-extra">＋ 新增項目</button>
      <div class="field-row" style="margin-top:8px"><div>年開銷直接指定（萬）<div class="meta">空白＝月生活費 × 12 ＋ 其他開銷</div></div>
        ${numIn('expense.annualOverride', d.expense.annualOverride, { label: '年開銷覆寫', placeholder: '自動' })}</div></section>
    <section class="card"><h2>正二高點<span class="sub">高點 ／ 日期</span></h2>${peaks}
      <p class="hint">有報價時，價格創新高會自動更新（鎖定的除外）。</p></section>
  </div>`;
}

// ================= 設定 =================
function pctIn(bind, v, label) { return numIn(bind, v, { type: 'pct', step: '0.5', label }); }
function selectHtml(bind, value, options, label) {
  return `<select data-bind="${bind}" data-type="select" aria-label="${esc(label)}">${options.map(([v, t]) => `<option value="${esc(v)}"${String(value ?? '') === v ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
}

function settingsHtml() {
  const st = settingsOf(S.data);
  const watch = compute() && buildWatch(S.data, S.result.summary, prices());
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const recv = S.ui.sendTab === 'recv';
  return `<div class="grid settings">
    <section class="card"><h2>顯示</h2>
      <div class="seg" role="group" aria-label="介面模式">
        <button data-action="mode" data-m="SIMPLE" aria-pressed="${st.uiMode !== 'ADVANCED'}">簡易版</button>
        <button data-action="mode" data-m="ADVANCED" aria-pressed="${st.uiMode === 'ADVANCED'}">進階版</button></div>
      <p class="hint">進階版多顯示本金槓桿、總曝險、三檔正二階梯與預估費用。</p>
      <div class="btns"><a class="btn secondary" href="guide.png" target="_blank" rel="noopener">看使用教學圖</a></div></section>

    <section class="card"><h2>報價與雲端服務</h2>
      <label class="f" for="worker-url">Worker 網址</label>
      <input type="url" id="worker-url" data-bind="settings.workerUrl" data-type="url" value="${esc(st.workerUrl)}" placeholder="https://lev2-worker.你的帳號.workers.dev" autocomplete="off">
      <label class="f" for="notify-key">雲端密鑰（Worker 的 NOTIFY_KEY，提醒功能用）</label>
      <input type="password" id="notify-key" data-bind="settings.notifyKey" data-type="text" value="${esc(st.notifyKey)}" autocomplete="off" placeholder="只用即時股價可以不填">
      <div class="btns"><button class="btn secondary" data-action="test-worker">測試連線</button></div>
      <div class="msg" id="worker-msg"></div>
      <p class="hint">即時股價、轉移碼、Telegram 與 Email 提醒都透過這個網址。部署方式見 README。</p></section>

    <section class="card"><h2>配置規則</h2>
      <div class="row2">
        <div><label class="f">再平衡門檻（±%）</label>${pctIn('settings.rebalanceThreshold', st.rebalanceThreshold, '再平衡門檻')}</div>
        <div><label class="f">回檔基準</label>${selectHtml('settings.drawdownBenchmark', st.drawdownBenchmark, [...LEVERAGE_SYMBOLS.map((s) => [s, s]), ['MAX', '三檔最大跌幅']], '回檔基準')}</div>
        <div><label class="f">每跌（%）</label>${pctIn('settings.drawdownStep', st.drawdownStep, '加碼步距')}</div>
        <div><label class="f">加碼（%）</label>${pctIn('settings.addPerStep', st.addPerStep, '每步加碼')}</div>
        <div><label class="f">保留現金（%）</label>${pctIn('settings.cashReserve', st.cashReserve, '保留現金')}</div>
        <div><label class="f">指定配置</label>${selectHtml('settings.manualTierCode', st.manualTierCode, [['', '依生活費倍數自動'], ...TIERS.map((t) => [t.code, `${t.code}${t.custom ? '（自訂）' : ''}`])], '指定配置')}</div>
        <div><label class="f">正二買入標的</label>${selectHtml('settings.buyTargetLeverage', st.buyTargetLeverage, LEVERAGE_SYMBOLS.map((s) => [s, s]), '正二買入標的')}</div>
        <div><label class="f">市值型買入標的</label>${selectHtml('settings.buyTargetMarket', st.buyTargetMarket, SECURITIES.filter((s) => s.category === 'MARKET').map((s) => [s.symbol, s.symbol]), '市值型買入標的')}</div>
      </div>
      <label class="check"><input type="checkbox" data-bind="settings.allowOddLot" data-type="bool"${st.allowOddLot ? ' checked' : ''}>建議股數可以含零股</label></section>

    ${priceAlertHtml(st)}

    <section class="card"><h2>配置提醒（Telegram）</h2>
      <p class="hint">App 沒開也能收到「配置需要調整」通知。雲端只收到各檔<b>比例</b>，沒有股數與金額。</p>
      <label class="check"><input type="checkbox" data-bind="settings.notifyEnabled" data-type="bool"${st.notifyEnabled ? ' checked' : ''}>開啟雲端提醒</label>
      <div class="btns">
        <button class="btn secondary" data-action="watch-upload">上傳目前比例</button>
        <button class="btn secondary" data-action="watch-test">寄測試通知</button>
        <button class="btn secondary" data-action="watch-delete">刪除雲端比例</button></div>
      <div class="msg" id="watch-msg">${S.data.watchUploadedAt ? `上次上傳：${fmtDateTime(S.data.watchUploadedAt)}` : ''}</div>
      <details><summary>雲端會收到的內容</summary><pre class="code">${esc(watch ? JSON.stringify(watch, null, 2) : '（目前沒有資產或缺少股價，不會上傳）')}</pre></details></section>

    <section class="card"><h2>搬到另一台裝置</h2>
      <div class="seg" role="group" aria-label="傳出或接收">
        <button data-action="send-tab" data-t="send" aria-pressed="${!recv}">從這台傳出</button>
        <button data-action="send-tab" data-t="recv" aria-pressed="${recv}">在這台接收</button></div>
      <div ${recv ? 'hidden' : ''}>
        <label class="f" for="pw1">設定一組密碼（至少 8 字）</label><input type="password" id="pw1" autocomplete="new-password" placeholder="例如：我家貓叫阿肥2026">
        <label class="f" for="pw2">再輸入一次</label><input type="password" id="pw2" autocomplete="new-password">
        <div class="btns"><button class="btn" data-action="make-code">產生轉移碼</button><button class="btn secondary" data-action="download-backup">下載加密備份檔</button></div>
        <div id="code-box" hidden><div class="big-code" id="code"></div><p class="hint" id="code-hint"></p></div>
        <div class="msg" id="send-msg"></div>
      </div>
      <div ${recv ? '' : 'hidden'}>
        <label class="f" for="in-code">轉移碼</label><input type="text" id="in-code" autocapitalize="characters" autocomplete="off" placeholder="XXXX-XXXX">
        <label class="f" for="pw3">密碼</label><input type="password" id="pw3" autocomplete="current-password">
        <div class="btns"><button class="btn" data-action="fetch-code">取回資料</button><button class="btn secondary" data-action="pick-file">選擇備份檔</button></div>
        <input type="file" id="file" accept=".lev2,application/json" hidden>
        <div class="msg" id="recv-msg"></div>
        <div id="import-preview"></div>
      </div>
      <p class="hint">資料用你的密碼加密（AES-256）。轉移碼 10 分鐘內有效、只能用一次。</p></section>

    <section class="card"><h2>安裝成 App</h2>
      ${standalone ? '<p>✅ 已經以 App 模式開啟。</p>' : isIOS
        ? '<p>iPhone／iPad：用 Safari 開啟這個網頁 → 點下方「分享」→「加入主畫面」。</p>'
        : `<p>Android／電腦 Chrome：點網址列右邊的安裝圖示，或選單中的「安裝應用程式」。</p>${S.installPrompt ? '<div class="btns"><button class="btn" data-action="install">安裝到這台裝置</button></div>' : ''}`}
      <p class="hint">安裝後資料比較不會被瀏覽器自動清除。每台裝置的資料各自獨立。</p></section>

    <section class="card"><h2>資料</h2>
      <div class="btns"><button class="btn secondary" data-action="load-sample">載入範例資料</button>
        <button class="btn danger" data-action="clear-all">清除這台裝置的資料</button></div>
      <p class="hint">版本 ${APP_VERSION} · 試算工具，非投資建議。</p></section>
  </div>`;
}

// ---------- 股價下跌提醒（Email） ----------
function todayChange(symbol) {
  const q = S.quotes[symbol];
  if (q?.changePct != null) return q.changePct;
  if (q?.price > 0 && q?.prevClose > 0) return (q.price - q.prevClose) / q.prevClose;
  return null;
}
function priceAlertHit(symbol) {
  const pa = S.data.priceAlert;
  const r = pa?.rules?.find((x) => x.symbol === symbol);
  const c = todayChange(symbol);
  return !!(pa?.enabled && r?.enabled && c != null && c <= -r.dropPct + 1e-12);
}
function priceAlertHtml(st) {
  const pa = S.data.priceAlert;
  const times = pa.mode === 'TIMES'
    ? `<label class="f">提醒時間（台北時間，交易日）</label>
       <div class="time-chips">${pa.times.length ? pa.times.map((t) => `<span class="tchip num">${t}<button data-action="pa-del-time" data-t="${t}" aria-label="刪除 ${t}">×</button></span>`).join('') : '<span class="hint">尚未設定時間</span>'}</div>
       <div class="inline"><select id="pa-time" aria-label="選擇時間">${timeOptions().filter((t) => !pa.times.includes(t)).map((t) => `<option${t === '13:20' ? ' selected' : ''}>${t}</option>`).join('')}</select>
       <button class="btn secondary" data-action="pa-add-time">＋ 加入</button></div>`
    : '<p class="hint">盤中每 10 分鐘檢查一次，跌幅一達門檻就寄信；同一檔每天只寄一次。</p>';
  const rows = pa.rules.map((r, i) => {
    const sec = security(r.symbol);
    const c = todayChange(r.symbol);
    const hit = c != null && c <= -r.dropPct + 1e-12;
    return `<div class="pa-row${r.enabled ? '' : ' off'}">
      <label class="check"><input type="checkbox" data-bind="priceAlert.rules.${i}.enabled" data-type="bool"${r.enabled ? ' checked' : ''}>
        <span><b>${r.symbol}</b> <span class="tag ${sec.category}">${CATEGORY_LABEL[sec.category]}</span><br><small>${esc(sec.name)}</small></span></label>
      <span class="today num ${c == null ? 'flat' : upDown(c)}">${c == null ? '今日 —' : `今日 ${fmtSignedPct(c, 2)}`}${hit ? ' ⚠' : ''}</span>
      <span class="pct-in">跌 ${numIn(`priceAlert.rules.${i}.dropPct`, r.dropPct, { type: 'pct', step: '0.5', label: `${r.symbol} 跌幅門檻` })} %</span>
    </div>`;
  }).join('');
  const preview = buildPriceAlertConfig(pa);
  const ready = st.workerUrl && st.notifyKey;
  return `<section class="card pa-card"><h2>股價下跌提醒（Email）</h2>
    <p class="hint">追蹤的股票<b>今日跌幅</b>（現價對昨收）達到門檻時寄信給你。雲端只收到信箱、時間、代號與門檻，沒有持股金額。</p>
    <label class="check"><input type="checkbox" data-bind="priceAlert.enabled" data-type="bool"${pa.enabled ? ' checked' : ''}>開啟下跌提醒</label>
    <label class="f" for="pa-email">收件信箱</label>
    <input type="email" id="pa-email" data-bind="priceAlert.email" data-type="text" value="${esc(pa.email)}" placeholder="you@gmail.com" autocomplete="email">
    <label class="f">提醒方式</label>
    <div class="seg" role="group" aria-label="提醒方式">
      <button data-action="pa-mode" data-m="TIMES" aria-pressed="${pa.mode !== 'INSTANT'}">指定時間</button>
      <button data-action="pa-mode" data-m="INSTANT" aria-pressed="${pa.mode === 'INSTANT'}">盤中即時</button></div>
    ${times}
    <h3>追蹤股票與跌幅門檻</h3>
    ${rows}
    <div class="btns">
      <button class="btn" data-action="pa-save">儲存到雲端</button>
      <button class="btn secondary" data-action="pa-test">寄測試信</button></div>
    <div class="msg" id="pa-msg">${!ready ? '需要先在「報價與雲端服務」填入 Worker 網址與雲端密鑰。' : S.data.priceAlert.savedAt ? `已儲存到雲端：${fmtDateTime(S.data.priceAlert.savedAt)}` : ''}</div>
    <details><summary>雲端會收到的內容</summary><pre class="code">${esc(JSON.stringify(preview, null, 2))}</pre></details>
  </section>`;
}
function paMsg(text, kind = '') { const m = $('#pa-msg'); if (m) { m.textContent = text; m.className = 'msg ' + kind; } }
async function uploadPriceAlert(force) {
  const st = settingsOf(S.data);
  if (!st.workerUrl || !st.notifyKey) throw new Error('請先在「報價與雲端服務」填入 Worker 網址與雲端密鑰');
  const c = buildPriceAlertConfig(S.data.priceAlert);
  const errs = validatePriceAlert(c);
  if (errs.length) throw new Error(errs.join('；'));
  const key = JSON.stringify({ ...c, updatedAt: 0 });
  if (!force && key === S.ui.paHash) return false;
  const j = await cloudCall('PUT', '/price-alert', c);
  S.ui.paHash = key; saveUi(S.ui);
  S.data.priceAlert.savedAt = new Date().toISOString();
  save({ watch: false });
  paMsg(`已儲存到雲端：${fmtDateTime(S.data.priceAlert.savedAt)}${j.mail === false ? '（Worker 尚未設定 RESEND_API_KEY，還不會寄信）' : ''}`, j.mail === false ? 'err' : 'ok');
  return true;
}
let paTimer;
function schedulePaUpload() {
  const st = settingsOf(S.data);
  if (!st.workerUrl || !st.notifyKey || (!S.data.priceAlert.enabled && !S.ui.paHash)) return;
  clearTimeout(paTimer);
  paTimer = setTimeout(() => uploadPriceAlert(false).catch((e) => paMsg(e.message, 'err')), 2000);
}

// ---------- 雲端比例上傳 ----------
let watchTimer;
function watchConfig() {
  const st = settingsOf(S.data);
  return st.notifyEnabled && st.workerUrl && st.notifyKey ? st : null;
}
function scheduleWatchUpload() {
  if (!watchConfig()) return;
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => uploadWatch(false).catch(() => {}), 3000);
}
function watchMsg(text, kind = '') { const m = $('#watch-msg'); if (m) { m.textContent = text; m.className = 'msg ' + kind; } }
async function cloudCall(method, path, body) {
  const st = settingsOf(S.data);
  if (!st.workerUrl) throw new Error('請先填入 Worker 網址');
  if (!st.notifyKey) throw new Error('請先在「報價與雲端服務」填入雲端密鑰');
  const res = await fetch(new URL(path, st.workerUrl), {
    method, headers: { Authorization: `Bearer ${st.notifyKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `錯誤 ${res.status}`);
  return j;
}
async function uploadWatch(force) {
  if (!force && !watchConfig()) return;
  compute();
  const w = buildWatch(S.data, S.result.summary, prices());
  if (!w) { watchMsg('目前沒有資產或缺少股價，暫不上傳', 'err'); return; }
  const key = JSON.stringify({ ...w, updatedAt: 0 });
  if (!force && key === S.ui.watchHash) return;
  await cloudCall('PUT', '/watch', w);
  S.ui.watchHash = key; saveUi(S.ui);
  S.data.watchUploadedAt = new Date().toISOString();
  save({ watch: false });
  watchMsg(`已上傳比例：${fmtDateTime(S.data.watchUploadedAt)}`, 'ok');
}

// ---------- 資料搬移 ----------
function errText(e) { return e instanceof BackupError ? e.message : (e?.message || String(e)); }
function setMsg(id, text, kind = '') { const m = $('#' + id); if (m) { m.textContent = text; m.className = 'msg ' + kind; } }
async function busy(btn, label, fn) {
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}
function sendPassword() {
  if ($('#pw1').value !== $('#pw2').value) throw new BackupError('MISMATCH', '兩次密碼不一樣');
  return $('#pw1').value;
}
let codeTimer;
async function makeCode(btn) {
  await busy(btn, '加密中…', async () => {
    try {
      const url = settingsOf(S.data).workerUrl;
      if (!url) throw new BackupError('NO_ENDPOINT', '請先在「報價與雲端服務」填入 Worker 網址，或改用備份檔');
      const env = await encryptAppData(S.data, sendPassword());
      const { code, expiresAt } = await createTransfer(url, env);
      $('#code').textContent = formatCode(code);
      $('#code-box').hidden = false;
      clearInterval(codeTimer);
      const end = new Date(expiresAt).getTime();
      const tick = () => {
        const s = Math.max(0, Math.round((end - Date.now()) / 1000));
        const h = $('#code-hint');
        if (!h) { clearInterval(codeTimer); return; }
        h.textContent = s ? `在新裝置輸入這組碼和密碼。剩 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}，只能使用一次。` : '轉移碼已過期，請重新產生。';
        if (!s) clearInterval(codeTimer);
      };
      tick(); codeTimer = setInterval(tick, 1000);
      setMsg('send-msg', '');
    } catch (e) { setMsg('send-msg', errText(e), 'err'); }
  });
}
async function downloadBackup(btn) {
  await busy(btn, '加密中…', async () => {
    try {
      const env = await encryptAppData(S.data, sendPassword());
      downloadEnvelope(env);
      S.data.lastBackupAt = new Date().toISOString();
      save({ watch: false });
      setMsg('send-msg', '已下載加密備份檔。可用 AirDrop、雲端硬碟或 Email 傳到新裝置；沒有密碼打不開。', 'ok');
    } catch (e) { setMsg('send-msg', errText(e), 'err'); }
  });
}
function showImportPreview(d) {
  S.pendingImport = d;
  const p = summarizeForPreview(d);
  $('#import-preview').innerHTML = `<div class="after" style="margin-top:12px"><b>解密成功，確認內容：</b>
    <div>${p.holdings.map(esc).join('<br>') || '沒有持股'}</div>
    <div class="hint">現金帳戶 ${p.cashAccountCount} 筆 · 月度快照 ${p.snapshotCount} 筆${p.exportedAt ? ` · 資料時間 ${fmtDateTime(p.exportedAt)}` : ''}</div></div>
    <div class="btns"><button class="btn secondary" data-action="import-cancel">取消</button><button class="btn" data-action="import-apply">覆蓋這台的資料</button></div>`;
  setMsg('recv-msg', '');
}
function needPassword() {
  if (!$('#pw3').value) { setMsg('recv-msg', '請先輸入密碼', 'err'); $('#pw3').focus(); return false; }
  return true;
}
async function fetchCode(btn) {
  if (!needPassword()) return;
  await busy(btn, '取回中…', async () => {
    $('#import-preview').innerHTML = '';
    try {
      const url = settingsOf(S.data).workerUrl;
      if (!url) throw new BackupError('NO_ENDPOINT', '新裝置也要先填 Worker 網址（設定 → 報價與雲端服務），或改用備份檔');
      let env;
      try { env = await fetchTransfer(url, $('#in-code').value); S.transferCache = env; }
      catch (e) { if (e.code === 'CODE_NOT_FOUND' && S.transferCache) env = S.transferCache; else throw e; }
      showImportPreview(await decryptEnvelope(env, $('#pw3').value));
    } catch (e) { setMsg('recv-msg', errText(e), 'err'); }
  });
}
async function importFile(file) {
  $('#import-preview').innerHTML = '';
  try {
    const env = await readEnvelopeFile(file);
    showImportPreview(await decryptEnvelope(env, $('#pw3').value));
  } catch (e) { setMsg('recv-msg', errText(e), 'err'); }
}
function applyImport() {
  if (!S.pendingImport) return;
  const keepUrl = settingsOf(S.data).workerUrl;
  S.data = normalize(S.pendingImport);
  if (!S.data.settings.workerUrl && keepUrl) S.data.settings.workerUrl = keepUrl;
  S.pendingImport = null; S.transferCache = null;
  save();
  S.ui.sendTab = 'send';
  toast('匯入完成，這台裝置已是最新資料');
  poller.refresh();
  go('home');
}

// ---------------- 事件 ----------------
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
  o[keys[keys.length - 1]] = value;
}
function parseInput(el) {
  const t = el.dataset.type;
  if (t === 'bool') return el.checked;
  if (t === 'text') return el.value;
  if (t === 'url') return el.value.trim().replace(/\/+$/, '');
  if (t === 'select') return el.value === '' ? null : el.value;
  const raw = el.value.trim();
  if (raw === '') return t === 'price' || el.dataset.bind === 'expense.annualOverride' ? null : 0;
  const n = Number(raw);
  if (!isFinite(n) || n < 0) return undefined;
  if (t === 'int') return n;
  if (t === 'wan') return Math.round(n * 1e4);
  if (t === 'pct') return n / 100;
  if (t === 'price') return n > 0 ? n : null;
  return n;
}

$('#page').addEventListener('input', (e) => {
  const el = e.target;
  if (!el.dataset.bind || el.type === 'checkbox' || el.tagName === 'SELECT') return;
  const v = parseInput(el);
  if (v === undefined) return;
  setPath(S.data, el.dataset.bind, v);
  if (el.dataset.bind.startsWith('holdings') || el.dataset.bind.startsWith('cash')) S.data.isSample = false;
  save();
  if (el.dataset.bind.startsWith('priceAlert')) schedulePaUpload();
  const sum = $('#assets-sum');
  if (sum) sum.innerHTML = assetsSummaryInner();
});
$('#page').addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'file') { const f = el.files[0]; el.value = ''; if (f) importFile(f); return; }
  if (!el.dataset.bind) return;
  const v = parseInput(el);
  if (v === undefined) return;
  setPath(S.data, el.dataset.bind, v);
  save();
  if (el.dataset.bind === 'settings.workerUrl') { poller.refresh(); finalizePastMonths(); }
  if (el.dataset.bind === 'settings.notifyEnabled' && v) uploadWatch(true).catch((err) => watchMsg(err.message, 'err'));
  if (el.dataset.bind.startsWith('priceAlert')) schedulePaUpload();
  if (el.type === 'checkbox' || el.tagName === 'SELECT') { if (S.ui.page !== 'settings' || !el.dataset.bind.startsWith('settings.notify')) render(); }
});

document.addEventListener('click', async (e) => {
  const navBtn = e.target.closest('.nav button');
  if (navBtn) { go(navBtn.dataset.page); return; }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  switch (a) {
    case 'go': go(el.dataset.to); break;
    case 'go-receive': S.ui.sendTab = 'recv'; go('settings'); break;
    case 'go-backup': S.ui.sendTab = 'send'; go('settings'); break;
    case 'filter': S.ui.filter = el.dataset.f; saveUi(S.ui); render(); break;
    case 'range': S.ui.range = el.dataset.r; S.ui.sel = null; saveUi(S.ui); render(); break;
    case 'chart-tap': {
      const svg = el; const rect = svg.getBoundingClientRect();
      const W = +svg.dataset.w, L = +svg.dataset.l, R = +svg.dataset.r, n = +svg.dataset.n;
      const xv = ((e.clientX - rect.left) / rect.width) * W;
      S.ui.sel = n <= 1 ? 0 : Math.max(0, Math.min(n - 1, Math.round(((xv - L) / (W - L - R)) * (n - 1))));
      render(); break;
    }
    case 'load-sample':
      if (S.data.holdings.some((h) => h.shares > 0) && !S.data.isSample && !confirm('載入範例會覆蓋這台裝置目前的資料，確定嗎？')) return;
      { const url = settingsOf(S.data).workerUrl; S.data = sampleData(); S.data.settings.workerUrl = url; }
      save({ watch: false }); go('home'); break;
    case 'clear-sample': {
      const url = settingsOf(S.data).workerUrl;
      S.data = emptyData(); S.data.settings.workerUrl = url; save({ watch: false }); go('assets'); break;
    }
    case 'clear-all':
      if (!confirm('確定清除這台裝置上的全部資料？建議先下載加密備份。')) return;
      clearData(); S.data = emptyData(); S.quotes = {}; S.qstate = { state: 'idle' }; go('home'); break;
    case 'done': openDone(); break;
    case 'done-confirm': confirmDone(); break;
    case 'close-dialog': closeDialog(); break;
    case 'import-snap': importSnapshot(); break;
    case 'del-snap':
      if (!confirm(`刪除 ${ymLabel(el.dataset.ym)} 的快照？`)) return;
      S.data.snapshots = S.data.snapshots.filter((x) => x.yearMonth !== el.dataset.ym); S.ui.sel = null; save({ watch: false }); render(); break;
    case 'add-cash': S.data.cashAccounts.push({ id: 'c' + Date.now(), type: 'DEMAND', bankName: '', amount: 0 }); save(); render(); break;
    case 'del-cash': S.data.cashAccounts.splice(+el.dataset.i, 1); save(); render(); break;
    case 'add-extra': S.data.expense.extras.push({ name: '', annualAmount: 0 }); save(); render(); break;
    case 'del-extra': S.data.expense.extras.splice(+el.dataset.i, 1); save(); render(); break;
    case 'mode': S.data.settings.uiMode = el.dataset.m; save({ watch: false }); render(); break;
    case 'send-tab': S.ui.sendTab = el.dataset.t; render(); break;
    case 'test-worker': await busy(el, '測試中…', testWorker); break;
    case 'watch-upload': await busy(el, '上傳中…', async () => { try { await uploadWatch(true); } catch (err) { watchMsg(err.message, 'err'); } }); break;
    case 'watch-test': await busy(el, '寄送中…', async () => {
      try { await uploadWatch(true); await cloudCall('POST', '/watch/test'); watchMsg('已寄出測試通知，請查看 Telegram', 'ok'); } catch (err) { watchMsg(err.message, 'err'); }
    }); break;
    case 'watch-delete':
      if (!confirm('刪除雲端上的比例資料並停止提醒？')) return;
      await busy(el, '刪除中…', async () => {
        try { await cloudCall('DELETE', '/watch'); S.data.settings.notifyEnabled = false; S.ui.watchHash = null; saveUi(S.ui); save({ watch: false }); render(); toast('已刪除雲端比例，提醒已關閉'); } catch (err) { watchMsg(err.message, 'err'); }
      }); break;
    case 'pa-mode': S.data.priceAlert.mode = el.dataset.m; save({ watch: false }); render(); schedulePaUpload(); break;
    case 'pa-add-time': {
      const t = $('#pa-time')?.value;
      if (t && !S.data.priceAlert.times.includes(t)) { S.data.priceAlert.times = [...S.data.priceAlert.times, t].sort(); save({ watch: false }); render(); schedulePaUpload(); }
      break;
    }
    case 'pa-del-time': S.data.priceAlert.times = S.data.priceAlert.times.filter((t) => t !== el.dataset.t); save({ watch: false }); render(); schedulePaUpload(); break;
    case 'pa-save': await busy(el, '儲存中…', async () => { try { await uploadPriceAlert(true); } catch (err) { paMsg(err.message, 'err'); } }); break;
    case 'pa-test': await busy(el, '寄送中…', async () => {
      try {
        await uploadPriceAlert(true);
        const j = await cloudCall('POST', '/price-alert/test');
        const brief = (j.rows || []).map((r) => `${r.symbol} ${r.changePct == null ? '—' : fmtSignedPct(r.changePct, 2)}`).join('、');
        paMsg(`已寄出測試信到 ${S.data.priceAlert.email}。目前今日漲跌：${brief}`, 'ok');
      } catch (err) { paMsg(err.message, 'err'); }
    }); break;
    case 'make-code': await makeCode(el); break;
    case 'download-backup': await downloadBackup(el); break;
    case 'fetch-code': await fetchCode(el); break;
    case 'pick-file': if (needPassword()) $('#file').click(); break;
    case 'import-cancel': S.pendingImport = null; $('#import-preview').innerHTML = ''; setMsg('recv-msg', '已取消，這台的資料沒有變動。'); break;
    case 'import-apply': applyImport(); break;
    case 'install': if (S.installPrompt) { S.installPrompt.prompt(); S.installPrompt = null; render(); } break;
    default: break;
  }
});

async function testWorker() {
  const url = settingsOf(S.data).workerUrl;
  if (!url) { setMsg('worker-msg', '請先填入網址', 'err'); return; }
  try {
    const h = await (await fetch(new URL('/health', url), { cache: 'no-store' })).json();
    await poller.refresh();
    const n = Object.keys(S.quotes).length;
    setMsg('worker-msg', `連線成功：取得 ${n} 檔股價${h.notify ? '，雲端提醒已設定' : '（雲端提醒尚未設定 Telegram）'}`, n ? 'ok' : 'err');
  } catch (e) { setMsg('worker-msg', `連不上：${e.message}。請確認網址，以及 Worker 的 ALLOWED_ORIGIN 是否為這個網站`, 'err'); }
}

$('#refresh').addEventListener('click', () => {
  if (!settingsOf(S.data).workerUrl) { toast('尚未設定報價服務，請到「設定」填入 Worker 網址'); return; }
  poller.refresh();
});

// ---------------- 報價 ----------------
function updatePeaksFromQuotes() {
  let changed = false;
  const today = taipeiParts().ymd;
  for (const p of S.data.peaks) {
    const q = S.quotes[p.symbol];
    if (!(q?.price > 0)) continue;
    if (!(p.peakPrice > 0)) { p.peakPrice = q.price; p.peakDate = today; changed = true; }
    else if (q.price > p.peakPrice && !p.locked) { p.peakPrice = q.price; p.peakDate = today; changed = true; }
  }
  if (changed) save({ watch: false });
}

const poller = new QuotePoller({
  getUrl: () => settingsOf(S.data).workerUrl,
  getSymbols: () => SYMBOLS,
  onData: (j) => {
    S.quotes = { ...S.quotes, ...(j.quotes || {}) };
    saveQuoteCache({ quotes: S.quotes, fetchedAt: j.fetchedAt });
    updatePeaksFromQuotes();
  },
  onState: (st) => {
    S.qstate = st.state === 'loading' ? { ...S.qstate, state: 'loading' } : st;
    if (st.state === 'loading') { renderHeader(); return; }
    // 正在輸入時不重畫整頁，避免游標跳掉
    const typing = document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
    if (typing) { compute(); renderHeader(); } else render();
  },
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installPrompt = e; if (S.ui.page === 'settings') render(); });

// ---------------- 啟動 ----------------
if (FIRST_RUN) S.ui.page = 'home';
render();
poller.refresh();
finalizePastMonths();
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
