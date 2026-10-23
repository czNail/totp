import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearExportReceipt, EXPORT_RECEIPT_KEY, readExportReceipt, recordExport } from '../src/backup-status.ts';

test('export receipts persist only a revision and time; invalid/unavailable storage is harmless', () => {
  const values = new Map<string, string>();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  try {
    assert.equal(readExportReceipt(), null);
    const receipt = { revision: '12345678-1234-1234-1234-123456789abc', exportedAt: 123_456 };
    assert.equal(recordExport(receipt), true);
    assert.deepEqual(readExportReceipt(), receipt);
    for (const bad of ['{', 'null', '{}', JSON.stringify({ ...receipt, exportedAt: -1 }), JSON.stringify({ ...receipt, exportedAt: Number.MAX_SAFE_INTEGER }), JSON.stringify({ ...receipt, revision: '<script>' })]) {
      values.set(EXPORT_RECEIPT_KEY, bad);
      assert.equal(readExportReceipt(), null);
    }
    recordExport(receipt); clearExportReceipt(); assert.equal(readExportReceipt(), null);
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('storage disabled'); } });
    assert.equal(readExportReceipt(), null);
    assert.equal(recordExport(receipt), false);
    assert.doesNotThrow(clearExportReceipt);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
