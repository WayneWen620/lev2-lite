// 正二資產配置 Lite — 加密匯出 / 匯入 / 轉移碼模組
// 不依賴任何套件：使用瀏覽器內建 Web Crypto（Node 18+ 亦可執行，方便測試）
//
// 加密方式：PBKDF2-SHA256（600,000 次）從密碼導出金鑰 → AES-256-GCM 加密
// GCM 會驗證完整性：密碼錯誤或檔案被改過都會解密失敗，不會讀到錯誤資料

export const APP_ID = 'lev2-lite';
export const ENVELOPE_VERSION = 1;
export const CURRENT_SCHEMA = 1;
export const PBKDF2_ITERATIONS = 600000;
export const MIN_PASSWORD_LENGTH = 8;

import { SYMBOLS } from './engine/constants.js';
export const KNOWN_SYMBOLS = SYMBOLS;

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new BackupError('NO_CRYPTO', '這個瀏覽器不支援加密功能，請改用 HTTPS 網址或更新瀏覽器');
  return c.subtle;
};

export class BackupError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ---------- base64 ----------
export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
export function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

// ---------- 資料檢查 ----------
// 回傳 { ok, errors[] }；匯入前一定先檢查，避免壞檔覆蓋掉好資料
export function validateAppData(d) {
  const errors = [];
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const nonNeg = (x) => isNum(x) && x >= 0;

  if (!isObj(d)) return { ok: false, errors: ['內容不是有效的資料'] };
  if (d.schemaVersion !== CURRENT_SCHEMA) errors.push(`不支援的資料版本：${d.schemaVersion}`);

  if (!Array.isArray(d.holdings)) errors.push('缺少持股 holdings');
  else d.holdings.forEach((h, i) => {
    if (!KNOWN_SYMBOLS.includes(h?.symbol)) errors.push(`持股第 ${i + 1} 筆代號無效：${h?.symbol}`);
    if (!Number.isInteger(h?.shares) || h.shares < 0) errors.push(`持股 ${h?.symbol} 股數無效`);
  });

  if (!Array.isArray(d.cashAccounts)) errors.push('缺少現金 cashAccounts');
  else d.cashAccounts.forEach((c, i) => {
    if (!['DEMAND', 'TIME_DEPOSIT'].includes(c?.type)) errors.push(`現金第 ${i + 1} 筆類型無效`);
    if (!nonNeg(c?.amount)) errors.push(`現金第 ${i + 1} 筆金額無效`);
  });

  if (!isObj(d.liabilities)) errors.push('缺少負債 liabilities');
  else ['loan', 'personal', 'homeEquity', 'pledge'].forEach((k) => {
    if (!nonNeg(d.liabilities[k])) errors.push(`負債 ${k} 金額無效`);
  });

  if (!isObj(d.expense) || !nonNeg(d.expense.monthlyLiving)) errors.push('缺少或無效的月生活費');
  if (d.peaks != null && !Array.isArray(d.peaks)) errors.push('高點 peaks 格式錯誤');
  if (d.snapshots != null && !Array.isArray(d.snapshots)) errors.push('快照 snapshots 格式錯誤');
  if (d.settings != null && !isObj(d.settings)) errors.push('設定 settings 格式錯誤');

  return { ok: errors.length === 0, errors };
}

// 匯入前給使用者看的摘要（不顯示金額明細，只顯示大概內容）
export function summarizeForPreview(d) {
  const held = (d.holdings || []).filter((h) => h.shares > 0);
  return {
    exportedAt: d.updatedAt || null,
    holdingCount: held.length,
    holdings: held.map((h) => `${h.symbol} ${h.shares.toLocaleString('zh-TW')} 股`),
    cashAccountCount: (d.cashAccounts || []).length,
    snapshotCount: (d.snapshots || []).length,
  };
}

// ---------- 加解密 ----------
async function deriveKey(password, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new BackupError('WEAK_PASSWORD', `密碼至少 ${MIN_PASSWORD_LENGTH} 個字元；建議用一句好記的長句`);
  }
}

// 把 AppData 加密成「信封」物件（可存成檔案，也可上傳成轉移碼）
export async function encryptAppData(appData, password, { iterations = PBKDF2_ITERATIONS } = {}) {
  checkPassword(password);
  const v = validateAppData(appData);
  if (!v.ok) throw new BackupError('INVALID_DATA', '資料有誤，無法匯出：' + v.errors.join('；'));

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(password, salt, iterations);
  const header = { app: APP_ID, v: ENVELOPE_VERSION, schema: appData.schemaVersion };
  // 把信封標頭當成附加驗證資料：標頭被改也會解密失敗
  const aad = enc.encode(JSON.stringify(header));
  const plain = enc.encode(JSON.stringify(appData));
  const cipher = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain));

  return {
    ...header,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
    createdAt: new Date().toISOString(),
    data: toBase64(cipher),
  };
}

export function isEnvelope(x) {
  return !!(x && x.app === APP_ID && x.kdf && x.cipher && typeof x.data === 'string');
}

export async function decryptEnvelope(envelope, password) {
  if (!isEnvelope(envelope)) throw new BackupError('NOT_BACKUP', '這不是正二資產配置的備份檔');
  if (envelope.v !== ENVELOPE_VERSION) throw new BackupError('VERSION', `備份格式版本 ${envelope.v} 不支援，請更新網頁`);
  const { iterations, salt } = envelope.kdf;
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 5000000) {
    throw new BackupError('NOT_BACKUP', '備份檔參數異常');
  }
  const key = await deriveKey(password, fromBase64(salt), iterations);
  const aad = enc.encode(JSON.stringify({ app: envelope.app, v: envelope.v, schema: envelope.schema }));
  let plain;
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(envelope.cipher.iv), additionalData: aad },
      key,
      fromBase64(envelope.data),
    );
  } catch {
    throw new BackupError('BAD_PASSWORD', '密碼錯誤，或檔案已損壞');
  }
  let data;
  try {
    data = JSON.parse(dec.decode(plain));
  } catch {
    throw new BackupError('CORRUPT', '檔案內容損壞');
  }
  const v = validateAppData(data);
  if (!v.ok) throw new BackupError('INVALID_DATA', '備份內容有誤：' + v.errors.join('；'));
  return data;
}

// ---------- 檔案（瀏覽器） ----------
export function backupFileName(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return `lev2-backup-${p}.lev2`;
}

export function downloadEnvelope(envelope, fileName = backupFileName()) {
  const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function readEnvelopeFile(file) {
  if (file.size > 2 * 1024 * 1024) throw new BackupError('TOO_LARGE', '檔案太大，不是備份檔');
  let obj;
  try {
    obj = JSON.parse(await file.text());
  } catch {
    throw new BackupError('NOT_BACKUP', '無法讀取檔案，請確認選的是 .lev2 備份檔');
  }
  if (!isEnvelope(obj)) throw new BackupError('NOT_BACKUP', '這不是正二資產配置的備份檔');
  return obj;
}

// ---------- 轉移碼（透過 Worker 暫存密文 10 分鐘，讀取一次即刪除） ----------
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

export function normalizeCode(input) {
  return String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}
export function formatCode(code) {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export async function createTransfer(endpoint, envelope) {
  const res = await fetch(new URL('/transfer', endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new BackupError('TRANSFER_FAILED', j.error || `建立轉移碼失敗（${res.status}）`);
  return { code: j.code, expiresAt: j.expiresAt };
}

export async function fetchTransfer(endpoint, codeInput) {
  const code = normalizeCode(codeInput);
  if (!CODE_RE.test(code)) throw new BackupError('BAD_CODE', '轉移碼格式不對，應為 8 碼英數字');
  const res = await fetch(new URL(`/transfer/${code}`, endpoint), { method: 'GET', cache: 'no-store' });
  const j = await res.json().catch(() => ({}));
  if (res.status === 404) throw new BackupError('CODE_NOT_FOUND', '找不到轉移碼：可能已過期（10 分鐘）或已被使用過');
  if (!res.ok) throw new BackupError('TRANSFER_FAILED', j.error || `讀取轉移碼失敗（${res.status}）`);
  if (!isEnvelope(j.envelope)) throw new BackupError('NOT_BACKUP', '轉移內容格式錯誤');
  return j.envelope;
}
