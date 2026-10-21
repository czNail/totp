import { MAX_ACCOUNTS, validateParameters, type Account } from './totp.ts';

export const ITERATIONS = 600_000;
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024;
export interface VaultData { version: 1; accounts: Account[] }
export interface Envelope {
  format: 'cznail-totp-vault';
  version: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  ciphertext: string;
}
const encoder = new TextEncoder();

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
export function validateEnvelope(input: unknown): Envelope {
  if (!input || typeof input !== 'object') throw new Error('这不是支持的加密备份。');
  const e = input as Envelope;
  if (e.format !== 'cznail-totp-vault' || e.version !== 1 || e.kdf?.name !== 'PBKDF2' || e.kdf.hash !== 'SHA-256' || !Number.isInteger(e.kdf.iterations) || e.kdf.iterations < ITERATIONS || e.kdf.iterations > 2_000_000 || e.cipher?.name !== 'AES-GCM') throw new Error('备份版本或加密参数不支持。');
  unbase64(e.kdf.salt, 16);
  unbase64(e.cipher.iv, 12);
  if (typeof e.ciphertext !== 'string' || e.ciphertext.length > MAX_BACKUP_BYTES || unbase64(e.ciphertext).length < 16) throw new Error('加密内容无效。');
  return { format: e.format, version: 1, kdf: { ...e.kdf }, cipher: { ...e.cipher }, ciphertext: e.ciphertext };
}
export function parseBackup(text: string): Envelope {
  if (text.length > MAX_BACKUP_BYTES) throw new Error('备份文件过大，请选择本工具导出的 JSON 文件。');
  try { return validateEnvelope(JSON.parse(text)); } catch (error) {
    if (error instanceof SyntaxError) throw new Error('无法读取备份，请选择本工具导出的 JSON 文件。');
    throw error;
  }
}
function aad(e: Pick<Envelope, 'format' | 'version' | 'kdf'>): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify([e.format, e.version, e.kdf.name, e.kdf.hash, e.kdf.iterations, e.kdf.salt]));
}
async function derive(pin: string, kdf: Envelope['kdf']): Promise<CryptoKey> {
  validatePin(pin);
  const source = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unbase64(kdf.salt, 16), iterations: kdf.iterations }, source, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealVault(data: VaultData, key: CryptoKey, kdf: Envelope['kdf']): Promise<Envelope> {
  const checked = validateData(data);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const shell = { format: 'cznail-totp-vault', version: 1, kdf: { ...kdf } } as const;
  const plaintext = encoder.encode(JSON.stringify(checked));
  try {
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(shell), tagLength: 128 }, key, plaintext);
    return { ...shell, cipher: { name: 'AES-GCM', iv: base64(iv) }, ciphertext: base64(new Uint8Array(encrypted)) };
  } finally { plaintext.fill(0); }
}
export async function createVault(pin: string, data: VaultData = { version: 1, accounts: [] }): Promise<{ key: CryptoKey; envelope: Envelope }> {
  const kdf: Envelope['kdf'] = { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: base64(crypto.getRandomValues(new Uint8Array(16))) };
  const key = await derive(pin, kdf);
  return { key, envelope: await sealVault(data, key, kdf) };
}
export async function openVault(pin: string, input: unknown): Promise<{ key: CryptoKey; data: VaultData }> {
  const envelope = validateEnvelope(input);
  const key = await derive(pin, envelope.kdf);
  let bytes: ArrayBuffer;
  try {
    bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(envelope.cipher.iv, 12), additionalData: aad(envelope), tagLength: 128 }, key, unbase64(envelope.ciphertext));
  } catch { throw new Error('PIN 不正确，或账号库已损坏。请重试，原有数据不会被覆盖。'); }
  try { return { key, data: validateData(JSON.parse(new TextDecoder().decode(bytes))) }; }
  finally { new Uint8Array(bytes).fill(0); }
}
