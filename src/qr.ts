import { parseInput } from './totp.ts';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 24_000_000;
export interface ScanRequest { pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number }
export interface ScanResult { payload?: string | null; error?: boolean }

export function isRasterImageHeader(bytes: Uint8Array): boolean {
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  return png.every((value, i) => bytes[i] === value)
    || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP');
}

export function validateImageFile(file: Pick<File, 'name' | 'size' | 'type'>) {
  const allowed = ['image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(file.type.toLowerCase()) && !(file.type === '' && /\.(png|jpe?g|webp)$/i.test(file.name))) throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
  if (file.size <= 0) throw new Error('图片为空，请重新截图或选择图片。');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片不能超过 10 MB，请截取二维码区域后重试。');
}
export function imageScanSizes(width: number, height: number): { width: number; height: number }[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8000 || height > 8000 || width * height > MAX_IMAGE_PIXELS) throw new Error('图片分辨率过大或无效，请截取二维码区域后重试。');
  const attempts = [[1600, 1_500_000], [3200, 4_000_000]].map(([edge, pixels]) => {
    const scale = Math.min(1, edge / Math.max(width, height), Math.sqrt(pixels / (width * height)));
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  });
  return attempts.filter((size, i) => i === 0 || size.width !== attempts[i - 1].width || size.height !== attempts[i - 1].height);
}
export function parseQrPayload(payload: string) {
  if (/^otpauth-migration:/i.test(payload.trim())) throw new Error('这是验证器批量迁移二维码，请改用单个账号的绑定二维码或手动输入密钥。');
  if (payload.length > 4096 || !/^otpauth:\/\//i.test(payload.trim())) throw new Error('识别到的不是 TOTP 绑定二维码，请选择服务提供的验证器二维码。');
  const uri = payload.trim();
  return { uri, account: parseInput(uri) };
}
