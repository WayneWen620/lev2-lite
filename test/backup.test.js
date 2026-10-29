import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptAppData, decryptEnvelope, validateAppData, createTransfer, fetchTransfer,
  normalizeCode, formatCode, BackupError,
} from '../docs/js/backup.js';

// 設計稿 7.2 的範例資料（可算出 Excel 驗算值）
const sample = () => ({
  schemaVersion: 1,
  updatedAt: '2026-10-29T03:00:00Z',
  settings: { uiMode: 'SIMPLE' },
  holdings: [
    { symbol: '00662', shares: 58000, manualPrice: null },
    { symbol: '00631L', shares: 150000, manualPrice: null },
    { symbol: '00685L', shares: 45000, manualPrice: null },
    { symbol: '00865B', shares: 100000, manualPrice: null },
  ],
  cashAccounts: [{ id: 'c1', type: 'DEMAND', bankName: '中信', amount: 3000000 }],
  liabilities: { loan: 0, personal: 0, homeEquity: 3000000, pledge: 3000000 },
  expense: { monthlyLiving: 150000, extras: [{ name: '旅遊', annualAmount: 100000 }], annualOverride: null },
  peaks: [{ symbol: '00631L', peakPrice: 41.32, peakDate: '2026-07-15', locked: false }],
  addCycle: null,
  snapshots: [],
});
const PW = '我家貓叫阿肥2026';
const FAST = { iterations: 100000 }; // 測試用較少次數，加快速度

test('加密後再解密，資料完全相同', async () => {
  const env = await encryptAppData(sample(), PW, FAST);
  const back = await decryptEnvelope(env, PW);
  assert.deepEqual(back, sample());
});

test('密文中看不到股數或金額', async () => {
  const env = await encryptAppData(sample(), PW, FAST);
  const s = JSON.stringify(env);
  for (const leak of ['58000', '150000', '3000000', '00631L', '中信']) assert.ok(!s.includes(leak), leak);
});

test('同樣資料每次加密結果都不同（隨機 salt / iv）', async () => {
  const a = await encryptAppData(sample(), PW, FAST);
  const b = await encryptAppData(sample(), PW, FAST);
  assert.notEqual(a.data, b.data);
  assert.notEqual(a.kdf.salt, b.kdf.salt);
});

test('密碼錯誤 → BAD_PASSWORD', async () => {
  const env = await encryptAppData(sample(), PW, FAST);
  await assert.rejects(decryptEnvelope(env, 'wrong-password'), (e) => e.code === 'BAD_PASSWORD');
});

test('密文被竄改 → 解密失敗', async () => {
  const env = await encryptAppData(sample(), PW, FAST);
  const bytes = Buffer.from(env.data, 'base64'); bytes[10] ^= 1;
  await assert.rejects(decryptEnvelope({ ...env, data: bytes.toString('base64') }, PW), (e) => e.code === 'BAD_PASSWORD');
});

test('標頭被竄改 → 解密失敗', async () => {
  const env = await encryptAppData(sample(), PW, FAST);
  await assert.rejects(decryptEnvelope({ ...env, schema: 2 }, PW), (e) => e.code === 'BAD_PASSWORD');
});

test('密碼太短 → 拒絕', async () => {
  await assert.rejects(encryptAppData(sample(), '1234567', FAST), (e) => e.code === 'WEAK_PASSWORD');
});

test('壞資料不能匯出', async () => {
  const d = sample(); d.holdings[0].shares = -5;
  await assert.rejects(encryptAppData(d, PW, FAST), (e) => e.code === 'INVALID_DATA');
});

test('不是備份檔 → NOT_BACKUP', async () => {
  await assert.rejects(decryptEnvelope({ hello: 1 }, PW), (e) => e.code === 'NOT_BACKUP');
});

test('資料檢查：抓出各種錯誤', () => {
  assert.equal(validateAppData(sample()).ok, true);
  const d = sample(); d.holdings.push({ symbol: '9999', shares: 1 }); d.liabilities.loan = 'x';
  const r = validateAppData(d);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
});

test('轉移碼格式', () => {
  assert.equal(normalizeCode(' k7p4-qx9m '), 'K7P4QX9M');
  assert.equal(formatCode('K7P4QX9M'), 'K7P4-QX9M');
});

