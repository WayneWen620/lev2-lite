// 「只上傳比例」的雲端提醒：網頁端產生比例，Worker 端用公開股價推算目前比例。
// 上傳內容沒有股數、沒有金額。網頁與 Worker 共用這個檔案，確保算法一致。
import { security, LEVERAGE_SYMBOLS, SYMBOLS } from './constants.js';
import { settingsOf, drawdownSteps, addTarget, targetsFor, deviationOf, pickBenchmark } from './engine.js';

export const DEPOSIT_KEY = 'DEPOSIT';
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// 網頁端：由實際持股算出要上傳的比例（缺股價時回傳 null，不上傳）
export function buildWatch(data, summary, prices) {
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

export function validateWatch(w) {
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
export function evaluateWatch(w, prices) {
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

export function alertMessage(r, appUrl) {
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
