// 正二資產配置 Lite — Cloudflare Worker（單一檔案版，由 scripts/build-worker.mjs 產生，請勿手動修改）
// 產生時間：2026-10-29T05:54:31.860Z

// ===== docs/js/engine/constants.js =====
// 標的、級距、預設參數（同設計稿 7.2 / 7.3）

const SECURITIES = [
  { symbol: '00662', name: '富邦NASDAQ', category: 'MARKET', leverageFactor: 1 },
  { symbol: '2330', name: '台積電', category: 'MARKET', leverageFactor: 1 },
  { symbol: '0050', name: '元大台灣50', category: 'MARKET', leverageFactor: 1 },
  { symbol: '00631L', name: '元大台灣50正2', category: 'LEVERAGE', leverageFactor: 2 },
  { symbol: '00685L', name: '群益臺灣加權正2', category: 'LEVERAGE', leverageFactor: 2 },
  { symbol: '00675L', name: '富邦臺灣加權正2', category: 'LEVERAGE', leverageFactor: 2 },
  { symbol: '00865B', name: '國泰US短期公債', category: 'CASH_LIKE', leverageFactor: 0 },
];

const SYMBOLS = SECURITIES.map((s) => s.symbol);
const LEVERAGE_SYMBOLS = SECURITIES.filter((s) => s.category === 'LEVERAGE').map((s) => s.symbol);

function security(symbol) {
  return SECURITIES.find((s) => s.symbol === symbol) || null;
}

const CATEGORY_LABEL = { MARKET: '市值型', LEVERAGE: '正二', CASH_LIKE: '類現金', CASH: '現金' };

// 原型（市值型）／正二／現金；min ≤ M < max
const TIERS = [
  { code: '073', min: 0, max: 10, marketPct: 0, leveragePct: 0.7, cashPct: 0.3 },
  { code: '163', min: 10, max: 13, marketPct: 0.1, leveragePct: 0.6, cashPct: 0.3 },
  { code: '253', min: 13, max: 16, marketPct: 0.2, leveragePct: 0.5, cashPct: 0.3 },
  { code: '343', min: 16, max: 20, marketPct: 0.3, leveragePct: 0.4, cashPct: 0.3 },
  { code: '333', min: 20, max: 30, marketPct: 1 / 3, leveragePct: 1 / 3, cashPct: 1 / 3 },
  { code: '523', min: 30, max: 40, marketPct: 0.5, leveragePct: 0.2, cashPct: 0.3 },
  { code: '613', min: 40, max: 50, marketPct: 0.6, leveragePct: 0.1, cashPct: 0.3 },
  { code: '703', min: 50, max: Infinity, marketPct: 0.7, leveragePct: 0, cashPct: 0.3 },
  { code: '433', custom: true, marketPct: 0.4, leveragePct: 0.3, cashPct: 0.3 },
  { code: '262', custom: true, marketPct: 0.2, leveragePct: 0.6, cashPct: 0.2 },
];

const DEFAULT_SETTINGS = {
  uiMode: 'SIMPLE',
  workerUrl: '',
  rebalanceThreshold: 0.05,
  drawdownBenchmark: '00631L', // 或 'MAX'＝三檔最大跌幅
  drawdownStep: 0.1,
  addPerStep: 0.05,
  cashReserve: 0.1,
  buyTargetLeverage: '00631L',
  buyTargetMarket: '0050',
  manualTierCode: null,
  allowOddLot: true,
  notifyEnabled: false,
  notifyKey: '',
};

const FEE_RATE = 0.001425;
const MIN_FEE = 20;
const TAX_RATE_ETF = 0.001;
const TAX_RATE_STOCK = 0.003;

// ===== docs/js/engine/engine.js =====
// 計算引擎：純函式，不碰畫面與儲存。公式同設計稿第 5 節，並以 Excel 2026/09 驗算值測試。

const EPS = 1e-9;
const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

function settingsOf(data) {
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

// ---------- 級距 ----------
function resolveTier(multiple, manualCode) {
  if (manualCode) {
    const t = TIERS.find((x) => x.code === manualCode);
    if (t) return { ...t, manual: true };
  }
  if (multiple == null || !isFinite(multiple)) return { ...TIERS[0] };
  const t = TIERS.find((x) => !x.custom && multiple >= x.min && multiple < x.max);
  return { ...(t || TIERS[0]) };
}

function nextTier(multiple) {
  if (multiple == null || !isFinite(multiple)) return null;
  return TIERS.find((x) => !x.custom && x.min > multiple) || null;
}

function annualExpense(expense = {}) {
  if (expense.annualOverride > 0) return expense.annualOverride;
  return (Number(expense.monthlyLiving) || 0) * 12 + sum(expense.extras || [], (e) => e.annualAmount);
}

// ---------- 資產總覽（設計稿 5.2） ----------
// prices: { symbol: number }
function summarize(data, prices = {}) {
  const st = settingsOf(data);
  const holdings = data.holdings || [];
  const rawItems = SECURITIES.map((s) => {
    const h = holdings.find((x) => x.symbol === s.symbol);
    const shares = h ? Number(h.shares) || 0 : 0;
    const price = prices[s.symbol] ?? null;
    const value = price != null ? shares * price : 0;
    return { ...s, shares, price, value, missingPrice: shares > 0 && price == null };
  });

  const deposits = sum(data.cashAccounts || [], (c) => c.amount);
  const byCat = (c) => sum(rawItems.filter((i) => i.category === c), (i) => i.value);
  const marketValue = byCat('MARKET');
  const leverageValue = byCat('LEVERAGE');
  const cashLikeValue = byCat('CASH_LIKE');
  const cashValue = cashLikeValue + deposits;
  const financialAssets = marketValue + leverageValue + cashValue;

  const L = { loan: 0, personal: 0, homeEquity: 0, pledge: 0, ...(data.liabilities || {}) };
  const liabilitySum = L.loan + L.personal + L.homeEquity + L.pledge;
  const totalLiabilities = -liabilitySum;
  const netWorth = financialAssets - liabilitySum;

  const annual = annualExpense(data.expense);
  // Excel：(總金融資產 + 信貸[負數]) ÷ 年開銷；信貸以正數儲存，故相減
  const multiple = annual > 0 ? (financialAssets - L.personal) / annual : null;
  const tier = resolveTier(multiple, st.manualTierCode);
  const next = st.manualTierCode ? null : nextTier(multiple);
  const amountToNextTier = next && annual > 0 ? next.min * annual - (financialAssets - L.personal) : null;

  const exposureAmount = sum(rawItems, (i) => i.value * i.leverageFactor);
  const principalLeverage = netWorth > 0 ? financialAssets / netWorth : null;
  const beta = financialAssets > 0 ? exposureAmount / financialAssets : 0;
  const totalExposure = principalLeverage != null ? principalLeverage * beta : null;
  const pct = (x) => (financialAssets > 0 ? x / financialAssets : 0);

  const items = rawItems.map((i) => ({
    ...i,
    weight: pct(i.value),
    betaContribution: pct(i.value * i.leverageFactor),
  }));

  return {
    items, deposits,
    marketValue, leverageValue, cashLikeValue, cashValue, financialAssets,
    totalLiabilities, netWorth, annualExpense: annual, multiple,
    tier, nextTier: next, amountToNextTier,
    exposureAmount, principalLeverage, beta, totalExposure,
    marketPct: pct(marketValue), leveragePct: pct(leverageValue), cashPct: pct(cashValue),
    missingPrices: items.filter((i) => i.missingPrice).map((i) => i.symbol),
  };
}

// ---------- 加碼（設計稿 5.4） ----------
function drawdownSteps(dd, step) {
  if (dd == null || !(step > 0)) return 0;
  return Math.floor(Math.max(0, -dd) / step + EPS);
}

function addTarget(tierCashPct, st, steps) {
  const cap = Math.max(0, tierCashPct - st.cashReserve);
  return { cap, targetAdded: Math.min(steps * st.addPerStep, cap) };
}

function targetsFor(tier, targetAdded) {
  return {
    MARKET: tier.marketPct,
    LEVERAGE: tier.leveragePct + targetAdded,
    CASH: tier.cashPct - targetAdded,
  };
}

function pickBenchmark(levs, benchmark) {
  if (benchmark === 'MAX') {
    return levs.filter((x) => x.dd != null).sort((a, b) => a.dd - b.dd)[0] || null;
  }
  return levs.find((x) => x.symbol === benchmark) || null;
}

function evaluateAdd(summary, data, prices = {}) {
  const st = settingsOf(data);
  const levs = LEVERAGE_SYMBOLS.map((symbol) => {
    const pk = (data.peaks || []).find((p) => p.symbol === symbol) || {};
    const price = prices[symbol] ?? null;
    const peak = pk.peakPrice > 0 ? pk.peakPrice : null;
    const dd = price != null && peak ? (price - peak) / peak : null;
    const steps = drawdownSteps(dd, st.drawdownStep);
    const ladder = peak ? [1, 2, 3, 4, 5].map((k) => ({ pct: -k * st.drawdownStep, price: peak * (1 - k * st.drawdownStep) })) : [];
    const held = (data.holdings || []).find((h) => h.symbol === symbol)?.shares > 0;
    return { symbol, name: security(symbol).name, price, peak, peakDate: pk.peakDate || null, locked: !!pk.locked, dd, steps, ladder, held };
  });

  const bench = pickBenchmark(levs, st.drawdownBenchmark);
  const steps = bench ? bench.steps : 0;
  const tier = summary.tier;
  const { cap, targetAdded } = addTarget(tier.cashPct, st, steps);
  const alreadyAdded = Math.max(0, tier.cashPct - summary.cashPct);
  const addNowPct = Math.max(0, targetAdded - alreadyAdded);
  const nextStep = steps + 1;
  const nextTriggerPrice = bench?.peak && nextStep * st.addPerStep <= cap + EPS
    ? bench.peak * (1 - nextStep * st.drawdownStep) : null;

  return {
    levs, bench, steps, cap, targetAdded, alreadyAdded, addNowPct,
    addNowAmount: addNowPct * summary.financialAssets, nextTriggerPrice,
  };
}

// ---------- 再平衡（設計稿 5.5） ----------
function deviationOf(current, target, threshold) {
  const dev = {};
  for (const k of Object.keys(target)) dev[k] = current[k] - target[k];
  const out = Object.values(dev).some((d) => Math.abs(d) > threshold + EPS);
  return { dev, out };
}

function evaluateRebalance(summary, add, st) {
  const target = targetsFor(summary.tier, add.targetAdded);
  const current = { MARKET: summary.marketPct, LEVERAGE: summary.leveragePct, CASH: summary.cashPct };
  const { dev, out } = deviationOf(current, target, st.rebalanceThreshold);
  return { target, current, dev, out: summary.financialAssets > 0 && out };
}

// ---------- 推薦標的＋股數（設計稿 13.3） ----------
function lotSplit(amount, price, allowOddLot, maxShares = Infinity) {
  if (!(price > 0) || !(amount > 0)) return { shares: 0, lots: 0, odd: 0, amount: 0 };
  let shares = Math.floor(amount / price + EPS);
  if (!allowOddLot) shares = Math.floor(shares / 1000) * 1000;
  shares = Math.max(0, Math.min(shares, maxShares));
  return { shares, lots: Math.floor(shares / 1000), odd: shares % 1000, amount: shares * price };
}

function estimateCost(side, amount, symbol) {
  if (!(amount > 0)) return 0;
  const fee = Math.max(MIN_FEE, amount * FEE_RATE);
  if (side === 'BUY') return fee;
  const tax = amount * (symbol === '2330' ? TAX_RATE_STOCK : TAX_RATE_ETF);
  return fee + tax;
}

function buildLines(summary, plan, st, prices) {
  const lines = [];
  const minAmount = summary.financialAssets * 0.005; // 0.5% 以下不動
  for (const cat of ['MARKET', 'LEVERAGE']) {
    const amt = plan[cat] || 0;
    if (Math.abs(amt) < minAmount) continue;
    if (amt < 0) {
      let need = -amt;
      const held = summary.items
        .filter((i) => i.category === cat && i.shares > 0 && i.price > 0)
        .sort((a, b) => b.value - a.value);
      for (const h of held) {
        if (need <= 0) break;
        const s = lotSplit(Math.min(need, h.value), h.price, st.allowOddLot, h.shares);
        if (!s.shares) continue;
        lines.push({
          side: 'SELL', symbol: h.symbol, category: cat, price: h.price, ...s,
          cost: estimateCost('SELL', s.amount, h.symbol),
          reason: `${CATEGORY_LABEL[cat]}超出目標，持有市值最大者先賣`,
        });
        need -= s.amount;
      }
    } else {
      const symbol = cat === 'LEVERAGE' ? st.buyTargetLeverage : st.buyTargetMarket;
      const price = prices[symbol] ?? null;
      const s = lotSplit(amt / (1 + FEE_RATE), price, st.allowOddLot);
      lines.push({
        side: 'BUY', symbol, category: cat, price, ...s,
        cost: estimateCost('BUY', s.amount, symbol),
        priceMissing: price == null,
        reason: `${CATEGORY_LABEL[cat]}不足，買入設定的標的`,
      });
    }
  }
  return lines;
}

function afterTrade(summary, lines) {
  let m = summary.marketValue, l = summary.leverageValue, c = summary.cashValue;
  for (const x of lines) {
    const signed = x.side === 'BUY' ? x.amount : -x.amount;
    if (x.category === 'MARKET') m += signed; else l += signed;
    c -= signed + x.cost;
  }
  const t = m + l + c;
  return t > 0 ? { MARKET: m / t, LEVERAGE: l / t, CASH: c / t } : null;
}

// 一次算出首頁需要的全部結果
function advise(data, prices = {}) {
  const st = settingsOf(data);
  const summary = summarize(data, prices);
  const add = evaluateAdd(summary, data, prices);
  const rebalance = evaluateRebalance(summary, add, st);

  let mode = 'OK';
  let plan = { MARKET: 0, LEVERAGE: 0 };
  if (rebalance.out) {
    mode = 'REBALANCE';
    plan = { MARKET: -rebalance.dev.MARKET * summary.financialAssets, LEVERAGE: -rebalance.dev.LEVERAGE * summary.financialAssets };
  } else if (add.addNowPct > EPS) {
    mode = 'ADD';
    plan = { MARKET: 0, LEVERAGE: add.addNowAmount };
  }
  const lines = mode === 'OK' ? [] : buildLines(summary, plan, st, prices);
  const after = lines.length ? afterTrade(summary, lines) : null;
  const light = mode === 'REBALANCE' ? 'RED' : mode === 'ADD' ? 'YELLOW' : 'GREEN';

  return { settings: st, summary, add, rebalance, mode, lines, after, light, text: explain(mode, summary, add, rebalance) };
}

const p0 = (x) => `${Math.round(x * 100)}%`;

function explain(mode, summary, add, reb) {
  const t = summary.tier;
  const base = `你的資產約 ${summary.multiple != null ? summary.multiple.toFixed(1) : '—'} 年生活費，建議配置 ${t.code}（原型 ${p0(t.marketPct)}・正二 ${p0(t.leveragePct)}・現金 ${p0(t.cashPct)}）。`;
  if (mode === 'REBALANCE') {
    const dip = add.targetAdded > 0 && add.bench?.dd != null
      ? `${add.bench.symbol} 從高點回檔 ${p0(-add.bench.dd)}（第 ${add.steps} 階），正二目標加碼 ${p0(add.targetAdded)}；` : '';
    const parts = [];
    for (const [k, label] of [['MARKET', '原型'], ['LEVERAGE', '正二'], ['CASH', '現金']]) {
      if (Math.abs(reb.dev[k]) > 0.005) parts.push(`${label}${reb.dev[k] > 0 ? '偏多' : '偏少'} ${p0(Math.abs(reb.dev[k]))}`);
    }
    return base + dip + `目前${parts.join('、')}，建議依下方買賣調整回目標。`;
  }
  if (mode === 'ADD') {
    return base + `${add.bench.symbol} 從高點回檔 ${p0(-add.bench.dd)}，達第 ${add.steps} 階，可用現金加碼正二 ${p0(add.addNowPct)}。`;
  }
  return base + '目前配置在範圍內，不用動作。';
}

// ===== docs/js/engine/watch.js =====
// 「只上傳比例」的雲端提醒：網頁端產生比例，Worker 端用公開股價推算目前比例。
// 上傳內容沒有股數、沒有金額。網頁與 Worker 共用這個檔案，確保算法一致。

const DEPOSIT_KEY = 'DEPOSIT';
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// 網頁端：由實際持股算出要上傳的比例（缺股價時回傳 null，不上傳）
function buildWatch(data, summary, prices) {
  if (!(summary.financialAssets > 0) || summary.missingPrices.length) return null;
  const st = settingsOf(data);
  const weights = {};
  const refPrices = {};
  for (const i of summary.items) {
    if (i.shares > 0 && i.value > 0) {
      weights[i.symbol] = r6(i.weight);
      refPrices[i.symbol] = i.price;
    }
  }
  if (summary.deposits > 0) weights[DEPOSIT_KEY] = r6(summary.deposits / summary.financialAssets);

  const peaks = {};
  for (const s of LEVERAGE_SYMBOLS) {
    const p = (data.peaks || []).find((x) => x.symbol === s);
    if (p?.peakPrice > 0) peaks[s] = { price: p.peakPrice, locked: !!p.locked };
  }
  const t = summary.tier;
  return {
    v: 1,
    updatedAt: new Date().toISOString(),
    weights,
    refPrices,
    tier: { code: t.code, marketPct: t.marketPct, leveragePct: t.leveragePct, cashPct: t.cashPct },
    settings: {
      rebalanceThreshold: st.rebalanceThreshold,
      drawdownBenchmark: st.drawdownBenchmark,
      drawdownStep: st.drawdownStep,
      addPerStep: st.addPerStep,
      cashReserve: st.cashReserve,
    },
    peaks,
  };
}

function validateWatch(w) {
  const errs = [];
  const num01 = (x) => typeof x === 'number' && isFinite(x) && x >= 0 && x <= 1;
  if (!w || w.v !== 1) errs.push('version');
  if (!w?.weights || typeof w.weights !== 'object') errs.push('weights');
  else for (const [k, v] of Object.entries(w.weights)) {
    if (k !== DEPOSIT_KEY && !SYMBOLS.includes(k)) errs.push('symbol ' + k);
    if (!num01(v)) errs.push('weight ' + k);
  }
  for (const [k, v] of Object.entries(w?.refPrices || {})) {
    if (!SYMBOLS.includes(k) || !(v > 0)) errs.push('refPrice ' + k);
  }
  const t = w?.tier;
  if (!t || !num01(t.marketPct) || !num01(t.leveragePct) || !num01(t.cashPct)) errs.push('tier');
  const s = w?.settings;
  if (!s || !num01(s.rebalanceThreshold) || !num01(s.drawdownStep) || !num01(s.addPerStep) || !num01(s.cashReserve)) errs.push('settings');
  // 確認沒有夾帶股數或金額欄位
  const allowed = ['v', 'updatedAt', 'weights', 'refPrices', 'tier', 'settings', 'peaks'];
  for (const k of Object.keys(w || {})) if (!allowed.includes(k)) errs.push('unexpected ' + k);
  return errs;
}

// Worker 端：用目前股價推算比例與是否需要提醒
// 新權重 ∝ 原權重 × 現價 ÷ 基準價；存款不變
function evaluateWatch(w, prices) {
  const cat = { MARKET: 0, LEVERAGE: 0, CASH: 0 };
  let total = 0;
  for (const [k, weight] of Object.entries(w.weights)) {
    let v = weight;
    let c = 'CASH';
    if (k !== DEPOSIT_KEY) {
      const p = prices[k];
      const ref = w.refPrices[k];
      if (p > 0 && ref > 0) v = weight * (p / ref);
      const sc = security(k).category;
      c = sc === 'CASH_LIKE' ? 'CASH' : sc;
    }
    cat[c] += v;
    total += v;
  }
  const current = {
    MARKET: total > 0 ? cat.MARKET / total : 0,
    LEVERAGE: total > 0 ? cat.LEVERAGE / total : 0,
    CASH: total > 0 ? cat.CASH / total : 0,
  };

  const st = w.settings;
  const levs = LEVERAGE_SYMBOLS.map((symbol) => {
    const peak = w.peaks?.[symbol]?.price ?? null;
    const price = prices[symbol] ?? null;
    const dd = peak && price ? (price - peak) / peak : null;
    return { symbol, peak, price, dd, steps: drawdownSteps(dd, st.drawdownStep), locked: !!w.peaks?.[symbol]?.locked };
  });
  const newPeaks = levs.filter((x) => x.peak && x.price > x.peak && !x.locked).map((x) => ({ symbol: x.symbol, price: x.price }));
  const bench = pickBenchmark(levs, st.drawdownBenchmark);
  const steps = bench ? bench.steps : 0;
  const { targetAdded } = addTarget(w.tier.cashPct, st, steps);
  const target = targetsFor(w.tier, targetAdded);
  const { dev, out } = deviationOf(current, target, st.rebalanceThreshold);
  const alreadyAdded = Math.max(0, w.tier.cashPct - current.CASH);
  const addNowPct = Math.max(0, targetAdded - alreadyAdded);

  return { current, target, dev, out, bench, steps, targetAdded, addNowPct, newPeaks };
}

const pc = (x) => `${Math.round(x * 100)}%`;

function alertMessage(r, appUrl) {
  const lines = ['【正二配置】'];
  const dip = r.addNowPct > 0 && r.bench && r.bench.dd != null;
  if (dip) lines.push(`${r.bench.symbol} 從高點回檔 ${pc(-r.bench.dd)}，達第 ${r.steps} 階，可以加碼。`);
  if (r.out) {
    lines.push(`原型 ${pc(r.current.MARKET)}（目標 ${pc(r.target.MARKET)}）`);
    lines.push(`正二 ${pc(r.current.LEVERAGE)}（目標 ${pc(r.target.LEVERAGE)}）`);
    lines.push(`現金 ${pc(r.current.CASH)}（目標 ${pc(r.target.CASH)}）`);
    lines.push(dip ? '目標已含加碼，建議依 App 的建議調整。' : '配置跑掉了，建議調整。');
  }
  if (appUrl) lines.push(`開啟 App 查看：${appUrl}`);
  return lines.join('\n');
}

// ===== docs/js/engine/priceAlert.js =====
// 股價「當日」下跌提醒：今日跌幅 =（現價 − 昨收）÷ 昨收
// 只用公開股價與你設定的代號／門檻，不需要持股或金額。網站與 Worker 共用。

const SLOT_MINUTES = 10; // 雲端排程每 10 分鐘一次
const MARKET_OPEN = 9 * 60;
const MARKET_CLOSE = 13 * 60 + 30;

// 09:10、09:20 … 13:30 可選的提醒時間
function timeOptions() {
  const out = [];
  for (let m = MARKET_OPEN + SLOT_MINUTES; m <= MARKET_CLOSE; m += SLOT_MINUTES) out.push(minutesToHHMM(m));
  return out;
}
function minutesToHHMM(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function defaultPriceAlert() {
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
function buildPriceAlertConfig(pa) {
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

function validatePriceAlert(c) {
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
function taipeiSlot(now = new Date()) {
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
function evaluatePriceAlert(c, quotes) {
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
function decidePriceAlert(c, evaluation, state, now = new Date()) {
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

function buildPriceAlertEmail(hits, { now = new Date(), appUrl = '', test = false } = {}) {
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

// ===== worker/src/index.js =====
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

