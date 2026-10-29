// 資料結構、預設值、範例資料、本機儲存
import { SYMBOLS, DEFAULT_SETTINGS } from './engine/constants.js';
import { defaultPriceAlert } from './engine/priceAlert.js';

export const STORAGE_KEY = 'lev2.appData';
export const QUOTE_CACHE_KEY = 'lev2.quoteCache';
export const UI_KEY = 'lev2.ui';

export function emptyData() {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_SETTINGS },
    holdings: SYMBOLS.map((symbol) => ({ symbol, shares: 0, manualPrice: null })),
    cashAccounts: [{ id: 'c1', type: 'DEMAND', bankName: '活存', amount: 0 }],
    liabilities: { loan: 0, personal: 0, homeEquity: 0, pledge: 0 },
    expense: { monthlyLiving: 0, extras: [], annualOverride: null },
    peaks: [
      { symbol: '00631L', peakPrice: null, peakDate: null, locked: false },
      { symbol: '00685L', peakPrice: null, peakDate: null, locked: false },
      { symbol: '00675L', peakPrice: null, peakDate: null, locked: false },
    ],
    addCycle: null,
    snapshots: [],
    lastBackupAt: null,
    isSample: false,
    priceAlert: defaultPriceAlert(),
  };
}

// 設計稿 7.2 範例：可算出 Excel 2026/09 驗算值。股價為假設值（manualPrice）
export function sampleData() {
  const d = emptyData();
  const set = (s, shares, price) => Object.assign(d.holdings.find((h) => h.symbol === s), { shares, manualPrice: price });
  set('00662', 58000, 124.10);
  set('00631L', 150000, 36.88);
  set('00685L', 45000, 37.67);
  set('00865B', 100000, 43.05);
  d.cashAccounts = [{ id: 'c1', type: 'DEMAND', bankName: '活存', amount: 3000000 }];
  d.liabilities = { loan: 0, personal: 0, homeEquity: 3000000, pledge: 3000000 };
  d.expense = { monthlyLiving: 150000, extras: [{ name: '旅遊', annualAmount: 100000 }], annualOverride: null };
  d.peaks[0] = { symbol: '00631L', peakPrice: 41.32, peakDate: '2026-07-15', locked: false };
  d.peaks[1] = { symbol: '00685L', peakPrice: 41.80, peakDate: '2026-07-15', locked: false };
  d.snapshots = [
    ['2026-04', 15620000, 9620000], ['2026-05', 16350000, 10350000], ['2026-06', 17480000, 11480000],
    ['2026-07', 18900000, 12900000], ['2026-08', 16000000, 10000000], ['2026-09', 21729950, 15729950],
  ].map(([yearMonth, fa, nw]) => ({
    yearMonth, financialAssets: fa, netWorth: nw, totalLiabilities: -6000000, source: 'IMPORT',
  }));
  d.isSample = true;
  return d;
}

// 舊資料補上新欄位，避免程式更新後讀不到
export function normalize(d) {
  const base = emptyData();
  const out = { ...base, ...d };
  out.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  out.liabilities = { ...base.liabilities, ...(d.liabilities || {}) };
  out.expense = { ...base.expense, ...(d.expense || {}) };
  const hs = Array.isArray(d.holdings) ? d.holdings : [];
  out.holdings = SYMBOLS.map((s) => {
    const h = hs.find((x) => x.symbol === s) || {};
    return { symbol: s, shares: Number.isInteger(h.shares) && h.shares >= 0 ? h.shares : 0, manualPrice: h.manualPrice > 0 ? h.manualPrice : null };
  });
  out.peaks = base.peaks.map((p) => ({ ...p, ...((d.peaks || []).find((x) => x.symbol === p.symbol) || {}) }));
  out.cashAccounts = Array.isArray(d.cashAccounts) ? d.cashAccounts : base.cashAccounts;
  out.snapshots = Array.isArray(d.snapshots) ? d.snapshots : [];
  const pa = { ...base.priceAlert, ...(d.priceAlert || {}) };
  pa.times = Array.isArray(pa.times) ? pa.times : [];
  pa.rules = base.priceAlert.rules.map((r) => ({ ...r, ...((d.priceAlert?.rules || []).find((x) => x.symbol === r.symbol) || {}) }));
  out.priceAlert = pa;
  return out;
}

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

export function loadData() {
  const raw = ls.get(STORAGE_KEY);
  if (!raw) return null;
  try { return normalize(JSON.parse(raw)); } catch { return null; }
}
export function saveData(d) {
  d.updatedAt = new Date().toISOString();
  return ls.set(STORAGE_KEY, JSON.stringify(d));
}
export function clearData() { ls.del(STORAGE_KEY); ls.del(QUOTE_CACHE_KEY); }

export function loadQuoteCache() {
  try { return JSON.parse(ls.get(QUOTE_CACHE_KEY)) || null; } catch { return null; }
}
export function saveQuoteCache(c) { ls.set(QUOTE_CACHE_KEY, JSON.stringify(c)); }

export function loadUi() { try { return JSON.parse(ls.get(UI_KEY)) || {}; } catch { return {}; } }
export function saveUi(u) { ls.set(UI_KEY, JSON.stringify(u)); }

// 讓瀏覽器盡量不要自動清除資料（支援的瀏覽器才有效）
export async function requestPersist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}
