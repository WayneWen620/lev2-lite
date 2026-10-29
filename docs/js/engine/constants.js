// 標的、級距、預設參數（同設計稿 7.2 / 7.3）

export const SECURITIES = [
  { symbol: '00662', name: '富邦NASDAQ', category: 'MARKET', leverageFactor: 1 },
  { symbol: '2330', name: '台積電', category: 'MARKET', leverageFactor: 1 },
  { symbol: '0050', name: '元大台灣50', category: 'MARKET', leverageFactor: 1 },
  { symbol: '00631L', name: '元大台灣50正2', category: 'LEVERAGE', leverageFactor: 2 },
  { symbol: '00685L', name: '群益臺灣加權正2', category: 'LEVERAGE', leverageFactor: 2 },
  { symbol: '00675L', name: '富邦臺灣加權正2', category: 'LEVERAGE', leverageFactor: 2 },
  { symbol: '00865B', name: '國泰US短期公債', category: 'CASH_LIKE', leverageFactor: 0 },
];

export const SYMBOLS = SECURITIES.map((s) => s.symbol);
export const LEVERAGE_SYMBOLS = SECURITIES.filter((s) => s.category === 'LEVERAGE').map((s) => s.symbol);

export function security(symbol) {
  return SECURITIES.find((s) => s.symbol === symbol) || null;
}

export const CATEGORY_LABEL = { MARKET: '市值型', LEVERAGE: '正二', CASH_LIKE: '類現金', CASH: '現金' };

// 原型（市值型）／正二／現金；min ≤ M < max
export const TIERS = [
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

export const DEFAULT_SETTINGS = {
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

export const FEE_RATE = 0.001425;
export const MIN_FEE = 20;
export const TAX_RATE_ETF = 0.001;
export const TAX_RATE_STOCK = 0.003;
