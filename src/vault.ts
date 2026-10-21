import { MAX_ACCOUNTS, validateParameters, type Account } from './totp.ts';
import { normalizePattern } from './pattern.ts';

export const ITERATIONS = 600_000;
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
export interface VaultData { version: 1; accounts: Account[] }
export type UnlockMethod = 'pin' | 'pattern';
interface Kdf { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string }
interface Cipher { name: 'AES-GCM'; iv: string }
interface KeySlot { kdf: Kdf; cipher: Cipher; ciphertext: string }
export interface LegacyEnvelope extends KeySlot { format: 'cznail-totp-vault'; version: 1 }
export interface ModernEnvelope {
  format: 'cznail-totp-vault';
  version: 2;
  unlocks: { pin: KeySlot; pattern?: KeySlot };
  cipher: Cipher;
  ciphertext: string;
}
export type Envelope = LegacyEnvelope | ModernEnvelope;
const encoder = new TextEncoder();
const encode = (value: unknown): Uint8Array<ArrayBuffer> => encoder.encode(JSON.stringify(value));
function base64(bytes: Uint8Array<ArrayBuffer>): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
}
function unbase64(input: unknown, length?: number): Uint8Array<ArrayBuffer> {
  if (typeof input !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) throw new Error('备份包含无效编码。');
  const decoded = Uint8Array.from(atob(input), char => char.charCodeAt(0));
  if (base64(decoded) !== input || (length !== undefined && decoded.length !== length)) throw new Error('备份字段长度或编码不正确。');
  return decoded;
}
export function validatePin(pin: string): void {
  if (!/^\d{6}$/.test(pin)) throw new Error('请输入 6 位数字 PIN。');
}
export function validateData(input: unknown): VaultData {
  if (!input || typeof input !== 'object') throw new Error('账号库内容无效。');
  const data = input as VaultData;
  if (data.version !== 1 || !Array.isArray(data.accounts) || data.accounts.length > MAX_ACCOUNTS) throw new Error('账号库版本或账号数量不支持。');
  const ids = new Set<string>();
  const accounts = data.accounts.map(account => {
    if (!account || typeof account !== 'object' || typeof account.id !== 'string' || !/^[0-9a-f-]{36}$/.test(account.id) || ids.has(account.id)) throw new Error('账号标识无效或重复。');
    ids.add(account.id);
    if (typeof account.name !== 'string' || !account.name.trim() || account.name.length > 128 || typeof account.issuer !== 'string' || account.issuer.length > 128 || typeof account.secret !== 'string') throw new Error('账号名称或密钥无效。');
    return { id: account.id, name: account.name.trim(), issuer: account.issuer.trim(), ...validateParameters(account) };
  });
  return { version: 1, accounts };
}
function validateKdf(kdf: Kdf): Kdf {
  if (kdf?.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || !Number.isInteger(kdf.iterations) || kdf.iterations < ITERATIONS || kdf.iterations > 2_000_000) throw new Error('备份的密钥派生参数不支持。');
  unbase64(kdf.salt, 16);
  return { name: kdf.name, hash: kdf.hash, iterations: kdf.iterations, salt: kdf.salt };
}
function validateCipher(cipher: Cipher): Cipher {
  if (cipher?.name !== 'AES-GCM') throw new Error('备份的加密算法不支持。');
  unbase64(cipher.iv, 12);
  return { name: cipher.name, iv: cipher.iv };
}
function validateCiphertext(text: string, length?: number) {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_BYTES || unbase64(text, length).length < 16) throw new Error('加密内容无效。');
  return text;
}
function validateSlot(slot: KeySlot): KeySlot {
  if (!slot || typeof slot !== 'object') throw new Error('备份的解锁方式无效。');
  return { kdf: validateKdf(slot.kdf), cipher: validateCipher(slot.cipher), ciphertext: validateCiphertext(slot.ciphertext, 48) };
}
export function validateEnvelope(input: unknown): Envelope {
  if (!input || typeof input !== 'object') throw new Error('这不是支持的加密备份。');
  const e = input as Envelope;
  if (e.format !== 'cznail-totp-vault') throw new Error('这不是支持的加密备份。');
  const cipher = validateCipher(e.cipher);
  const ciphertext = validateCiphertext(e.ciphertext);
  if (e.version === 1) return { format: e.format, version: 1, kdf: validateKdf(e.kdf), cipher, ciphertext };
  if (e.version !== 2 || !e.unlocks) throw new Error('备份版本不支持。');
  const unlocks: ModernEnvelope['unlocks'] = { pin: validateSlot(e.unlocks.pin) };
  if (e.unlocks.pattern !== undefined) unlocks.pattern = validateSlot(e.unlocks.pattern);
  return { format: e.format, version: 2, unlocks, cipher, ciphertext };
}
export function hasPattern(envelope: Envelope | null | undefined): boolean {
  return envelope?.version === 2 && !!envelope.unlocks?.pattern;
}
export function parseBackup(text: string): Envelope {
  if (text.length > MAX_BACKUP_BYTES) throw new Error('备份文件过大，请选择本工具导出的 JSON 文件。');
  try { return validateEnvelope(JSON.parse(text)); } catch (error) {
    if (error instanceof SyntaxError) throw new Error('无法读取备份，请选择本工具导出的 JSON 文件。');
    throw error;
  }
}
function legacyAad(e: LegacyEnvelope) { return encode([e.format, 1, e.kdf.name, e.kdf.hash, e.kdf.iterations, e.kdf.salt]); }
function dataAad(unlocks: ModernEnvelope['unlocks']) { return encode(['cznail-totp-vault', 2, 'accounts', unlocks]); }
function slotAad(method: UnlockMethod, kdf: Kdf) { return encode(['cznail-totp-vault', 2, 'key-wrap', method, kdf.name, kdf.hash, kdf.iterations, kdf.salt]); }
function newKdf(): Kdf { return { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: base64(crypto.getRandomValues(new Uint8Array(16))) }; }
async function derive(credential: string, kdf: Kdf, method: UnlockMethod, legacy = false): Promise<CryptoKey> {
  if (method === 'pin') validatePin(credential); else credential = normalizePattern(credential);
  const bytes = encoder.encode(legacy ? credential : `totp-${method}-v2:${credential}`);
  try {
    const source = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unbase64(kdf.salt, 16), iterations: kdf.iterations }, source, { name: 'AES-GCM', length: 256 }, false, legacy ? ['decrypt'] : ['wrapKey', 'unwrapKey']);
  } finally { bytes.fill(0); }
}
async function wrapKey(key: CryptoKey, credential: string, method: UnlockMethod): Promise<KeySlot> {
  const kdf = newKdf();
  const wrappingKey = await derive(credential, kdf, method);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.wrapKey('raw', key, wrappingKey, { name: 'AES-GCM', iv, additionalData: slotAad(method, kdf), tagLength: 128 });
  return { kdf, cipher: { name: 'AES-GCM', iv: base64(iv) }, ciphertext: base64(new Uint8Array(bytes)) };
}
export async function sealVault(data: VaultData, key: CryptoKey, envelope: Pick<ModernEnvelope, 'unlocks'>): Promise<ModernEnvelope> {
  const checked = validateData(data);
  // Normalize metadata order before authenticating it, including both key slots.
  const unlocks: ModernEnvelope['unlocks'] = { pin: validateSlot(envelope.unlocks.pin) };
  if (envelope.unlocks.pattern) unlocks.pattern = validateSlot(envelope.unlocks.pattern);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encode(checked);
  try {
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: dataAad(unlocks), tagLength: 128 }, key, plaintext);
    return { format: 'cznail-totp-vault', version: 2, unlocks, cipher: { name: 'AES-GCM', iv: base64(iv) }, ciphertext: base64(new Uint8Array(encrypted)) };
  } finally { plaintext.fill(0); }
}
export async function createVault(pin: string, data: VaultData = { version: 1, accounts: [] }): Promise<{ key: CryptoKey; envelope: ModernEnvelope }> {
  validatePin(pin);
  // Extractability permits wrapping by either credential. Only wrapped keys are
  // persisted; the derived wrapping keys themselves remain nonextractable.
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const pinSlot = await wrapKey(key, pin, 'pin');
  return { key, envelope: await sealVault(data, key, { unlocks: { pin: pinSlot } }) };
}
export async function setPattern(data: VaultData, key: CryptoKey, envelope: ModernEnvelope, pattern: string | null): Promise<ModernEnvelope> {
  const unlocks: ModernEnvelope['unlocks'] = { pin: envelope.unlocks.pin };
  if (pattern !== null) unlocks.pattern = await wrapKey(key, pattern, 'pattern');
  return sealVault(data, key, { unlocks });
}
export async function changePin(data: VaultData, key: CryptoKey, envelope: ModernEnvelope, pin: string): Promise<ModernEnvelope> {
  return sealVault(data, key, { unlocks: { ...envelope.unlocks, pin: await wrapKey(key, pin, 'pin') } });
}
export async function openVault(credential: string, input: unknown, method: UnlockMethod = 'pin'): Promise<{ key: CryptoKey; data: VaultData; envelope: ModernEnvelope }> {
  const envelope = validateEnvelope(input);
  let key: CryptoKey;
  let bytes: ArrayBuffer;
  if (envelope.version === 1) {
    if (method !== 'pin') throw new Error('这份旧版账号库只支持 PIN 解锁。');
    key = await derive(credential, envelope.kdf, 'pin', true);
  } else {
    const slot = envelope.unlocks[method];
    if (!slot) throw new Error('这份账号库尚未设置手势密码，请使用 PIN。');
    const wrappingKey = await derive(credential, slot.kdf, method);
    try {
      key = await crypto.subtle.unwrapKey('raw', unbase64(slot.ciphertext, 48), wrappingKey, { name: 'AES-GCM', iv: unbase64(slot.cipher.iv, 12), additionalData: slotAad(method, slot.kdf), tagLength: 128 }, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    } catch { throw unlockError(method); }
  }
  try {
    bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(envelope.cipher.iv, 12), additionalData: envelope.version === 1 ? legacyAad(envelope) : dataAad(envelope.unlocks), tagLength: 128 }, key, unbase64(envelope.ciphertext));
  } catch { throw unlockError(method); }
  let data: VaultData;
  try { data = validateData(JSON.parse(new TextDecoder().decode(bytes))); }
  finally { new Uint8Array(bytes).fill(0); }
  if (envelope.version === 1) {
    const upgraded = await createVault(credential, data);
    return { ...upgraded, data };
  }
  return { key, data, envelope };
}
function unlockError(method: UnlockMethod) { return new Error(`${method === 'pin' ? 'PIN 不正确' : '手势不正确'}，或账号库已损坏。请重试，原有数据不会被覆盖。`); }
