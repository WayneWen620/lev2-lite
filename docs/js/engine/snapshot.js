// 月度快照：本月自動記錄（每次開 App 更新），跨月後用「當月最後一個交易日收盤價」定案。
// 純函式，不碰畫面與儲存。
import { SYMBOLS } from './constants.js';
import { summarize } from './engine.js';

// 快照來源
//   AUTO     本月自動記錄（未定案）
//   MONTH_END 已用月底收盤價定案
//   LAST_OPEN 無法取得月底收盤價，以當月最後一次開啟時的價格定案
//   MANUAL   舊版手動存檔
//   IMPORT   使用者補登

const round = (x) => (x == null || !isFinite(x) ? null : Math.round(x));
const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

function totalsFrom(summary) {
  return {
    marketValue: round(summary.marketValue),
    leverageValue: round(summary.leverageValue),
    cashValue: round(summary.cashValue),
    financialAssets: round(summary.financialAssets),
    totalLiabilities: round(summary.totalLiabilities),
    netWorth: round(summary.netWorth),
    annualExpense: round(summary.annualExpense),
    multiple: r4(summary.multiple),
    tierCode: summary.tier.code,
    beta: r4(summary.beta),
    principalLeverage: r4(summary.principalLeverage),
    totalExposure: r4(summary.totalExposure),
  };
}

// 由目前資料產生本月的自動快照（保存股數，跨月時才能用月底收盤價重算）
export function buildAutoSnapshot(data, summary, { ym, ymd }) {
  const holdings = {};
  const prices = {};
  for (const i of summary.items) {
    if (i.shares > 0) { holdings[i.symbol] = i.shares; prices[i.symbol] = i.price; }
  }
  const L = data.liabilities || {};
  return {
    yearMonth: ym,
    ...totalsFrom(summary),
    holdings,
    prices,
    deposits: round(summary.deposits),
    liabilities: { loan: L.loan || 0, personal: L.personal || 0, homeEquity: L.homeEquity || 0, pledge: L.pledge || 0 },
    asOf: ymd,
    source: 'AUTO',
  };
}

// 數字有變才需要寫入（避免每次開 App 都寫）
export function snapshotChanged(prev, next) {
  if (!prev) return true;
  const keys = ['financialAssets', 'netWorth', 'marketValue', 'leverageValue', 'cashValue', 'tierCode', 'asOf'];
  if (keys.some((k) => prev[k] !== next[k])) return true;
  return JSON.stringify(prev.holdings || {}) !== JSON.stringify(next.holdings || {});
}

// 把快照還原成計算用的資料（用快照當時的股數、存款、負債、年開銷）
function dataFromSnapshot(snap, settings) {
  return {
    settings: { ...(settings || {}), manualTierCode: settings?.manualTierCode ?? null },
    holdings: SYMBOLS.map((s) => ({ symbol: s, shares: snap.holdings?.[s] || 0 })),
    cashAccounts: [{ type: 'DEMAND', amount: snap.deposits || 0 }],
    liabilities: snap.liabilities || { loan: 0, personal: 0, homeEquity: 0, pledge: 0 },
    expense: { monthlyLiving: 0, extras: [], annualOverride: snap.annualExpense || 0 },
  };
}

// 用月底收盤價定案。closes: { symbol: { close, date } }
// 缺少某檔收盤價時，該檔沿用快照當時的價格，並記在 missing。
export function finalizeSnapshot(snap, closes, settings) {
  const prices = {};
  const missing = [];
  let lastDate = null;
  for (const s of Object.keys(snap.holdings || {})) {
    const c = closes?.[s];
    if (c?.close > 0) {
      prices[s] = c.close;
      if (!lastDate || c.date > lastDate) lastDate = c.date;
    } else {
      prices[s] = snap.prices?.[s];
      missing.push(s);
    }
  }
  const summary = summarize(dataFromSnapshot(snap, settings), prices);
  const allMissing = missing.length === Object.keys(snap.holdings || {}).length && missing.length > 0;
  return {
    ...snap,
    ...totalsFrom(summary),
    prices,
    asOf: allMissing ? snap.asOf : lastDate || snap.asOf,
    source: allMissing ? 'LAST_OPEN' : 'MONTH_END',
    missing: missing.length ? missing : undefined,
  };
}

export function needsFinalize(snap, currentYm) {
  return snap.source === 'AUTO' && snap.yearMonth < currentYm;
}

// 每月增減、今年以來、累積（以每月最後一筆數字計）
export function monthlyTable(snapshots) {
  const rows = [...snapshots]
    .filter((s) => s.financialAssets > 0)
    .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
  const first = rows[0];
  return rows.map((s, i) => {
    const prev = rows[i - 1];
    const year = s.yearMonth.slice(0, 4);
    // 今年以來：對比去年 12 月；沒有就對比今年第一筆
    const base = rows.filter((x) => x.yearMonth.slice(0, 4) < year).pop()
      || rows.find((x) => x.yearMonth.slice(0, 4) === year);
    const chg = (a, b) => (b ? { amount: a.financialAssets - b.financialAssets, pct: b.financialAssets ? (a.financialAssets - b.financialAssets) / b.financialAssets : null } : null);
    return {
      ...s,
      monthChange: chg(s, prev),
      ytdChange: base && base !== s ? chg(s, base) : null,
      cumulative: first && first !== s ? chg(s, first) : null,
      gapMonths: prev ? monthDiff(prev.yearMonth, s.yearMonth) : 0,
    };
  });
}

export function monthDiff(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}
