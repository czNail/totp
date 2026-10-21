import { validateEnvelope, type Envelope } from './vault.ts';

export interface StoredVault { id: 'main'; revision: string; envelope: Envelope }
export class ConflictError extends Error {
  constructor() { super('账号库已在另一个标签页发生变化，请重新解锁后再操作。'); }
}
let connection: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  if (!connection) connection = new Promise((resolve, reject) => {
    const request = indexedDB.open('cznail-totp-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('vault', { keyPath: 'id' });
    request.onerror = () => { connection = undefined; reject(new Error('无法打开浏览器存储，请检查浏览器是否允许本站保存数据。')); };
    request.onblocked = () => { connection = undefined; reject(new Error('存储升级被其他标签页阻塞，请关闭其他验证器页面后重试。')); };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); connection = undefined; };
      resolve(request.result);
    };
  });
  return connection;
}
export async function readVault(): Promise<StoredVault | null> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('vault', 'readonly');
    const request = transaction.objectStore('vault').get('main');
    let record: StoredVault | null = null;
    request.onsuccess = () => { record = request.result ?? null; };
    transaction.oncomplete = () => {
      try {
        if (record && (record.id !== 'main' || typeof record.revision !== 'string')) throw new Error('本地账号库格式损坏，请从备份恢复。');
        // Decryption validates the envelope. Keep damaged ciphertext accessible to
        // export/reset/restore rather than trapping the user on the startup screen.
        resolve(record);
      } catch (error) { reject(error); }
    };
    transaction.onerror = () => reject(new Error('读取本地账号库失败，请重试。'));
    transaction.onabort = () => reject(new Error('读取本地账号库已中断，请重试。'));
  });
}
/** Compare and write inside one IndexedDB transaction: stale tabs cannot overwrite data. */
export async function writeVault(expected: string | null, envelope: Envelope | null): Promise<StoredVault | null> {
  const database = await db();
  const next: StoredVault | null = envelope ? { id: 'main', revision: crypto.randomUUID(), envelope: validateEnvelope(envelope) } : null;
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('vault', 'readwrite');
    const store = transaction.objectStore('vault');
    const request = store.get('main');
    let conflict = false;
    request.onsuccess = () => {
      const current = request.result as StoredVault | undefined;
      if ((current?.revision ?? null) !== expected) { conflict = true; transaction.abort(); return; }
      if (next) store.put(next); else store.delete('main');
    };
    transaction.oncomplete = () => resolve(next);
    transaction.onabort = () => reject(conflict ? new ConflictError() : new Error('保存失败，原有账号库未被更改。请检查浏览器存储空间后重试。'));
    transaction.onerror = () => { /* onabort reports the final result. */ };
  });
}
