import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { decodeQrPixels } from '../src/qr-decoder.ts';
import { imageScanSizes, isRasterImageHeader, MAX_IMAGE_BYTES, parseQrPayload, validateImageFile } from '../src/qr.ts';

const uri = 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example&algorithm=SHA256&digits=8&period=60';
function pixelsFor(text: string, inverted = false, rotated = false) {
  const matrix = QRCode.create(text, { errorCorrectionLevel: 'M' }).modules;
  const scale = 5;
  const width = (matrix.size + 8) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const row = Math.floor(y / scale) - 4;
    const col = Math.floor(x / scale) - 4;
    const black = row >= 0 && col >= 0 && row < matrix.size && col < matrix.size && matrix.get(row, col);
    const value = (inverted ? !black : black) ? 0 : 255;
    const index = (rotated ? (x * width + width - 1 - y) : (y * width + x)) * 4;
    pixels[index] = pixels[index + 1] = pixels[index + 2] = value;
  }
  return { pixels, width, height: width };
}

test('real QR pixels decode in normal, inverted and rotated orientations', () => {
  for (const [inverted, rotated] of [[false, false], [true, false], [false, true], [true, true]]) assert.equal(decodeQrPixels(pixelsFor(uri, inverted, rotated)), uri);
});
test('blank images and invalid pixel dimensions do not produce account data', () => {
  assert.equal(decodeQrPixels({ pixels: new Uint8ClampedArray(100 * 100 * 4).fill(255), width: 100, height: 100 }), null);
  assert.throws(() => decodeQrPixels({ pixels: new Uint8ClampedArray(3), width: 1, height: 1 }));
  assert.throws(() => decodeQrPixels({ pixels: new Uint8ClampedArray(), width: 5000, height: 5000 }));
});
test('recognized TOTP QR reuses strict URI validation and retains custom parameters', () => {
  const parsed = parseQrPayload(uri);
  assert.equal(parsed.uri, uri);
  assert.deepEqual(parsed.account, { name: 'alice', issuer: 'Example', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60 });
  assert.equal(parseQrPayload('otpauth://totp/%E7%A4%BA%E4%BE%8B%3Aalice?secret=JBSWY3DPEHPK3PXP').account.issuer, '示例');
  for (const value of ['https://example.com', 'JBSWY3DPEHPK3PXP', 'javascript:alert(1)', 'otpauth://hotp/alice?secret=MY&counter=1', 'otpauth://totp/alice?secret=MY&secret=MA', uri.replace('SHA256', 'MD5')]) assert.throws(() => parseQrPayload(value));
  assert.throws(() => parseQrPayload('otpauth-migration://offline?data=test'), /批量迁移/);
});
test('image type, file size and dimensions are bounded before scanning', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) validateImageFile({ name: 'image', size: 100, type });
  validateImageFile({ name: 'screenshot.PNG', size: 100, type: '' });
  for (const file of [{ name: 'image.svg', size: 100, type: 'image/svg+xml' }, { name: 'image.gif', size: 100, type: 'image/gif' }, { name: 'image.png', size: MAX_IMAGE_BYTES + 1, type: 'image/png' }, { name: 'image.png', size: 0, type: 'image/png' }]) assert.throws(() => validateImageFile(file));
  assert.deepEqual(imageScanSizes(300, 300), [{ width: 300, height: 300 }]);
  for (const [width, height] of [[1170, 2532], [4000, 6000], [8000, 2000]]) {
    const sizes = imageScanSizes(width, height);
    for (const size of sizes) { assert.ok(size.width * size.height <= 4_000_000); assert.ok(Math.max(size.width, size.height) <= 3200); }
  }
  for (const [width, height] of [[0, 1], [1, -1], [5000, 5000], [9000, 1], [1.5, 2]]) assert.throws(() => imageScanSizes(width, height));
});
test('raster signatures reject SVG or arbitrary content renamed as PNG', () => {
  assert.equal(isRasterImageHeader(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])), true);
  assert.equal(isRasterImageHeader(new Uint8Array([255, 216, 255, 224])), true);
  assert.equal(isRasterImageHeader(new TextEncoder().encode('RIFF1234WEBP')), true);
  assert.equal(isRasterImageHeader(new TextEncoder().encode('<svg></svg>')), false);
  assert.equal(isRasterImageHeader(new Uint8Array()), false);
});
