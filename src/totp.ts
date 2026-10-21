export type Algorithm = 'SHA1' | 'SHA256' | 'SHA512';
export interface TotpParameters {
  secret: string;
  algorithm: Algorithm;
  digits: 6 | 8;
  period: number;
}
export interface Account extends TotpParameters {
  id: string;
  name: string;
  issuer: string;
}
export const MAX_ACCOUNTS = 200;
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Accept common space/hyphen formatting, but never guess an invalid Base32 key. */
export function normalizeSecret(input: string): string {
  const value = input.replace(/[\s-]/g, '').toUpperCase();
  if (value.length > 1024 || !/^[A-Z2-7]+={0,6}$/.test(value)) {
    throw new Error('密钥应为 Base32 字符（A–Z、2–7），请检查是否粘贴完整。');
  }
  const raw = value.replace(/=+$/, '');
  const padding = [0, -1, 6, -1, 4, 3, -1, 1][raw.length % 8];
  if (padding < 0 || (value.includes('=') && value.length - raw.length !== padding)) {
    throw new Error('Base32 密钥长度或补位不正确。');
  }
  let bits = 0;
  let buffer = 0;
  for (const char of raw) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) bits -= 8;
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0) throw new Error('Base32 密钥末尾包含无效补位。');
  return raw;
}

export function decodeBase32(input: string): Uint8Array<ArrayBuffer> {
  const secret = normalizeSecret(input);
  const bytes = new Uint8Array(Math.floor(secret.length * 5 / 8));
  let bits = 0;
  let buffer = 0;
  let index = 0;
  for (const char of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 255;
    }
    buffer &= (1 << bits) - 1;
  }
  return bytes;
}

export function validateParameters(value: TotpParameters): TotpParameters {
  if (!['SHA1', 'SHA256', 'SHA512'].includes(value.algorithm)) throw new Error('只支持 SHA-1、SHA-256 和 SHA-512。');
  if (value.digits !== 6 && value.digits !== 8) throw new Error('验证码位数应为 6 或 8。');
  if (!Number.isInteger(value.period) || value.period < 1 || value.period > 300) throw new Error('更新周期应为 1–300 秒的整数。');
  return { secret: normalizeSecret(value.secret), algorithm: value.algorithm, digits: value.digits, period: value.period };
}

export function parseInput(input: string): TotpParameters & { name: string; issuer: string } {
  const trimmed = input.trim();
  if (!/^otpauth:/i.test(trimmed)) {
    return { ...validateParameters({ secret: trimmed, algorithm: 'SHA1', digits: 6, period: 30 }), name: '', issuer: '' };
  }
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('otpauth 链接格式不正确。'); }
  if (url.protocol !== 'otpauth:' || url.hostname !== 'totp' || url.username || url.password || url.port || url.hash) {
    throw new Error('只支持 otpauth://totp/ 链接，不支持 HOTP 或其他类型。');
  }
  for (const key of ['secret', 'issuer', 'algorithm', 'digits', 'period']) {
    if (url.searchParams.getAll(key).length > 1) throw new Error(`链接中的 ${key} 参数重复。`);
  }
  let label: string;
  try { label = decodeURIComponent(url.pathname.slice(1)); } catch { throw new Error('链接中的账号名称编码不正确。'); }
  const colon = label.indexOf(':');
  const issuer = (url.searchParams.get('issuer') ?? (colon < 0 ? '' : label.slice(0, colon))).trim();
  const name = (colon < 0 ? label : label.slice(colon + 1)).trim();
  const digitsText = url.searchParams.get('digits') ?? '6';
  const periodText = url.searchParams.get('period') ?? '30';
  if (!/^(6|8)$/.test(digitsText) || !/^\d{1,3}$/.test(periodText)) throw new Error('链接中的验证码位数或周期不正确。');
  const parameters = validateParameters({
    secret: url.searchParams.get('secret') ?? '',
    algorithm: (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase() as Algorithm,
    digits: Number(digitsText) as 6 | 8,
    period: Number(periodText),
  });
  if (name.length > 128 || issuer.length > 128) throw new Error('账号或服务名称不能超过 128 个字符。');
  return { ...parameters, name, issuer };
}

export async function prepareKey(parameters: TotpParameters): Promise<CryptoKey> {
  const checked = validateParameters(parameters);
  return crypto.subtle.importKey('raw', decodeBase32(checked.secret), { name: 'HMAC', hash: checked.algorithm.replace('SHA', 'SHA-') }, false, ['sign']);
}

export async function codeAt(key: CryptoKey, parameters: Pick<TotpParameters, 'period' | 'digits'>, now = Date.now()): Promise<string> {
  if (!Number.isFinite(now) || now < 0) throw new Error('设备时间无效。');
  const counter = BigInt(Math.floor(now / 1000 / parameters.period));
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, counter);
  const hash = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  const offset = hash[hash.length - 1] & 15;
  const binary = new DataView(hash.buffer).getUint32(offset) & 0x7fffffff;
  return String(binary % (10 ** parameters.digits)).padStart(parameters.digits, '0');
}

export function remaining(period: number, now = Date.now()): number {
  return period - (Math.floor(now / 1000) % period);
}
