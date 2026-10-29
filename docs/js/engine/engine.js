// 計算引擎：純函式，不碰畫面與儲存。公式同設計稿第 5 節，並以 Excel 2026/09 驗算值測試。
import {
  SECURITIES, TIERS, DEFAULT_SETTINGS, LEVERAGE_SYMBOLS, security,
  FEE_RATE, MIN_FEE, TAX_RATE_ETF, TAX_RATE_STOCK, CATEGORY_LABEL,
} from './constants.js';

const EPS = 1e-9;
const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

export function settingsOf(data) {
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

// ---------- 級距 ----------
export function resolveTier(multiple, manualCode) {
  if (manualCode) {
    const t = TIERS.find((x) => x.code === manualCode);
    if (t) return { ...t, manual: true };
  }
  if (multiple == null || !isFinite(multiple)) return { ...TIERS[0] };
  const t = TIERS.find((x) => !x.custom && multiple >= x.min && multiple < x.max);
  return { ...(t || TIERS[0]) };
}

export function nextTier(multiple) {
  if (multiple == null || !isFinite(multiple)) return null;
  return TIERS.find((x) => !x.custom && x.min > multiple) || null;
}

export function annualExpense(expense = {}) {
  if (expense.annualOverride > 0) return expense.annualOverride;
  return (Number(expense.monthlyLiving) || 0) * 12 + sum(expense.extras || [], (e) => e.annualAmount);
}

// ---------- 資產總覽（設計稿 5.2） ----------
// prices: { symbol: number }
export function summarize(data, prices = {}) {
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
export function drawdownSteps(dd, step) {
  if (dd == null || !(step > 0)) return 0;
  return Math.floor(Math.max(0, -dd) / step + EPS);
}

export function addTarget(tierCashPct, st, steps) {
  const cap = Math.max(0, tierCashPct - st.cashReserve);
  return { cap, targetAdded: Math.min(steps * st.addPerStep, cap) };
}

export function targetsFor(tier, targetAdded) {
  return {
    MARKET: tier.marketPct,
    LEVERAGE: tier.leveragePct + targetAdded,
    CASH: tier.cashPct - targetAdded,
  };
}

export function pickBenchmark(levs, benchmark) {
  if (benchmark === 'MAX') {
    return levs.filter((x) => x.dd != null).sort((a, b) => a.dd - b.dd)[0] || null;
  }
  return levs.find((x) => x.symbol === benchmark) || null;
}

export function evaluateAdd(summary, data, prices = {}) {
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
export function deviationOf(current, target, threshold) {
  const dev = {};
  for (const k of Object.keys(target)) dev[k] = current[k] - target[k];
  const out = Object.values(dev).some((d) => Math.abs(d) > threshold + EPS);
  return { dev, out };
}

export function evaluateRebalance(summary, add, st) {
  const target = targetsFor(summary.tier, add.targetAdded);
  const current = { MARKET: summary.marketPct, LEVERAGE: summary.leveragePct, CASH: summary.cashPct };
  const { dev, out } = deviationOf(current, target, st.rebalanceThreshold);
  return { target, current, dev, out: summary.financialAssets > 0 && out };
}

// ---------- 推薦標的＋股數（設計稿 13.3） ----------
export function lotSplit(amount, price, allowOddLot, maxShares = Infinity) {
  if (!(price > 0) || !(amount > 0)) return { shares: 0, lots: 0, odd: 0, amount: 0 };
  let shares = Math.floor(amount / price + EPS);
  if (!allowOddLot) shares = Math.floor(shares / 1000) * 1000;
  shares = Math.max(0, Math.min(shares, maxShares));
  return { shares, lots: Math.floor(shares / 1000), odd: shares % 1000, amount: shares * price };
}

export function estimateCost(side, amount, symbol) {
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
export function advise(data, prices = {}) {
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

export function explain(mode, summary, add, reb) {
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
