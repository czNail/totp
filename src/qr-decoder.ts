import jsQR from 'jsqr';
import type { ScanRequest } from './qr.ts';

export function decodeQrPixels({ pixels, width, height }: ScanRequest): string | null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 4_000_000 || pixels.length !== width * height * 4) throw new Error('二维码图像尺寸无效。');
  return jsQR(pixels, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
}
