// 報價客戶端：盤中每 20 秒向 Worker 取一次；頁面在背景時暫停
const POLL_MS = 20000;
const RETRY_MS = 60000;

export function taipeiParts(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return { day: t.getUTCDay(), minutes: t.getUTCHours() * 60 + t.getUTCMinutes(), ymd: t.toISOString().slice(0, 10), ym: t.toISOString().slice(0, 7) };
}
export function isMarketOpen(d = new Date()) {
  const { day, minutes } = taipeiParts(d);
  return day >= 1 && day <= 5 && minutes >= 540 && minutes <= 815; // 09:00–13:35
}

export async function fetchQuotes(workerUrl, symbols) {
  const u = new URL('/quotes', workerUrl);
  u.searchParams.set('codes', symbols.join(','));
  const res = await fetch(u, { cache: 'no-store' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `報價服務錯誤 ${res.status}`);
  return j;
}

export class QuotePoller {
  constructor({ getUrl, getSymbols, onData, onState }) {
    Object.assign(this, { getUrl, getSymbols, onData, onState });
    this.failures = 0;
    this.timer = null;
    this.busy = false;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.refresh();
      else this.stop();
    });
  }
  stop() { clearTimeout(this.timer); this.timer = null; }
  schedule() {
    this.stop();
    if (document.visibilityState !== 'visible' || !isMarketOpen()) return;
    this.timer = setTimeout(() => this.refresh(), this.failures >= 3 ? RETRY_MS : POLL_MS);
  }
  async refresh() {
    const url = this.getUrl();
    if (!url) { this.onState({ state: 'manual' }); return; }
    if (this.busy) return;
    this.busy = true;
    this.onState({ state: 'loading' });
    try {
      const j = await fetchQuotes(url, this.getSymbols());
      this.failures = 0;
      this.onData(j);
      this.onState({ state: isMarketOpen() ? 'live' : 'close', at: j.fetchedAt, errors: j.errors });
    } catch (e) {
      this.failures++;
      this.onState({ state: 'error', error: e.message });
    } finally {
      this.busy = false;
      this.schedule();
    }
  }
}
