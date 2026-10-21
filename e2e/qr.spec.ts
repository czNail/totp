import { test, expect, type Page } from '@playwright/test';
import QRCode from 'qrcode';

const uri = 'otpauth://totp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&issuer=Example&algorithm=SHA256&digits=8&period=30';
const secondUri = 'otpauth://totp/Other:bob?secret=JBSWY3DPEHPK3PXP&issuer=Other';
const qrFile = async (text = uri, inverted = false) => ({ name: 'qr.png', mimeType: 'image/png', buffer: await QRCode.toBuffer(text, { width: 360, margin: 4, color: inverted ? { dark: '#ffffffff', light: '#000000ff' } : undefined }) });
async function setup(page: Page) {
  await page.goto('./');
  await page.getByLabel('设置 PIN', { exact: true }).fill('123456');
  await page.getByLabel('再次输入 PIN', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '创建账号库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible();
}
async function openAdd(page: Page) {
  await page.getByRole('button', { name: '添加账号', exact: true }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
async function saved(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('cznail-totp-v1', 1); r.onsuccess = () => resolve(r.result); });
    return new Promise<unknown>(resolve => { const r = db.transaction('vault').objectStore('vault').get('main'); r.onsuccess = () => { db.close(); resolve(r.result); }; });
  });
}

test('select PNG, fill all URI parameters, explicitly confirm and preserve after reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.clock.setFixedTime(new Date(59_000)); await setup(page);
  const before = await saved(page); await openAdd(page);
  await page.getByLabel('选择二维码图片', { exact: true }).setInputFiles(await qrFile());
  await expect(page.locator('.qr-status')).toContainText('已识别二维码');
  await expect(page.getByLabel('验证器密钥或 otpauth 链接')).toHaveValue(uri);
  await expect(page.getByLabel('验证器密钥或 otpauth 链接')).toHaveAttribute('type', 'password');
  await expect(page.getByLabel('账号名称', { exact: true })).toHaveValue('alice');
  await expect(page.getByLabel('服务名称')).toHaveValue('Example');
  await expect(page.getByLabel('算法', { exact: true })).toHaveValue('SHA256');
  await expect(page.getByLabel('位数', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('周期（秒）', { exact: true })).toHaveValue('30');
  expect(await saved(page)).toEqual(before);
  await page.getByRole('dialog').getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.locator('[data-code]')).toHaveText('4611 9246');
  const serialized = JSON.stringify(await saved(page));
  for (const plaintext of [uri, 'alice', 'Example', 'GEZDGNBVGY3TQOJQ']) expect(serialized).not.toContain(plaintext);
  await page.reload(); await page.getByLabel('解锁 PIN', { exact: true }).fill('123456'); await page.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(page.locator('[data-code]')).toHaveText('4611 9246'); expect(errors).toEqual([]);
});

test('native clipboard image paste works on the drop zone; plain text paste stays available', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); await setup(page); await openAdd(page);
  const file = await qrFile();
  await page.evaluate(async bytes => {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]);
  }, Array.from(file.buffer));
  await page.getByRole('group', { name: '二维码图片识别', exact: true }).focus(); await page.keyboard.press('Control+V');
  await expect(page.locator('.qr-status')).toContainText('已识别二维码'); await expect(page.getByLabel('账号名称', { exact: true })).toHaveValue('alice');
  await page.getByRole('button', { name: '取消', exact: true }).click(); await openAdd(page);
  await page.evaluate(text => navigator.clipboard.writeText(text), secondUri);
  await page.getByLabel('验证器密钥或 otpauth 链接').focus(); await page.keyboard.press('Control+V');
  await expect(page.getByLabel('验证器密钥或 otpauth 链接')).toHaveValue(secondUri);
  await expect(page.getByLabel('账号名称', { exact: true })).toHaveValue('bob');
  await page.getByRole('dialog').getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.locator('.account-card')).toHaveCount(1);
});

test('JPEG and WebP drag/drop and inverted PNG decode locally without navigating', async ({ page }) => {
  await setup(page); await openAdd(page);
  const file = await qrFile(); const png = file.buffer.toString('base64'); const before = await saved(page);
  for (const mime of ['image/jpeg', 'image/webp']) {
    const transfer = await page.evaluateHandle(async ({ base64, mime }) => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; canvas.getContext('2d')!.drawImage(image, 0, 0);
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), mime, 1));
      const dt = new DataTransfer(); dt.items.add(new File([blob], `qr.${mime.split('/')[1]}`, { type: mime })); return dt;
    }, { base64: png, mime });
    const zone = page.locator('.qr-dropzone'); await zone.dispatchEvent('dragenter', { dataTransfer: transfer });
    await expect(zone).toHaveClass(/is-dragging/); await zone.dispatchEvent('dragover', { dataTransfer: transfer });
    await zone.dispatchEvent('drop', { dataTransfer: transfer }); await expect(zone).not.toHaveClass(/is-dragging/);
    await expect(page.locator('.qr-status')).toContainText('已识别二维码'); await expect(page.getByLabel('账号名称', { exact: true })).toHaveValue('alice');
    await transfer.dispose();
  }
  await page.getByLabel('选择二维码图片', { exact: true }).setInputFiles(await qrFile(secondUri, true));
  await expect(page.getByLabel('账号名称', { exact: true })).toHaveValue('bob'); expect(await saved(page)).toEqual(before); await expect(page).toHaveURL(/\/totp\/$/);
});

test('invalid images or QR content preserve existing inputs and account storage', async ({ page }) => {
  await setup(page); await openAdd(page);
  await page.getByLabel('验证器密钥或 otpauth 链接').fill('JBSWY3DPEHPK3PXP'); await page.getByLabel('账号名称', { exact: true }).fill('keep this');
  const before = await saved(page);
  const files = [
    { file: { name: 'bad.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') }, error: '请选择 PNG' },
    { file: { name: 'renamed.png', mimeType: 'image/png', buffer: Buffer.from('<svg><image href="https://example.com/"/></svg>') }, error: '无法读取' },
    { file: await qrFile('https://example.com/?do-not-open'), error: '不是 TOTP' },
    { file: await qrFile('otpauth://hotp/test?secret=MY&counter=0'), error: '不支持 HOTP' },
    { file: await qrFile('otpauth-migration://offline?data=test'), error: '批量迁移' },
  ];
  for (const { file, error } of files) {
    await page.getByLabel('选择二维码图片', { exact: true }).setInputFiles(file); await expect(page.locator('.qr-status')).toContainText(error);
    await expect(page.getByLabel('验证器密钥或 otpauth 链接')).toHaveValue('JBSWY3DPEHPK3PXP'); await expect(page.getByLabel('账号名称', { exact: true })).toHaveValue('keep this');
    expect(await saved(page)).toEqual(before); await expect(page.getByRole('dialog').getByRole('button', { name: '添加账号', exact: true })).toBeEnabled();
  }
  const blank = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 200; const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 200, 200); return c.toDataURL().split(',')[1]; });
  await page.getByLabel('选择二维码图片', { exact: true }).setInputFiles({ name: 'blank.png', mimeType: 'image/png', buffer: Buffer.from(blank, 'base64') });
  await expect(page.locator('.qr-status')).toContainText('没有识别到二维码'); expect(await saved(page)).toEqual(before);
  const transfer = await page.evaluateHandle(() => { const d = new DataTransfer(); for (let i = 0; i < 2; i++) d.items.add(new File(['x'], `${i}.png`, { type: 'image/png' })); return d; });
  await page.locator('.qr-dropzone').dispatchEvent('drop', { dataTransfer: transfer }); await expect(page.locator('.qr-status')).toContainText('一张二维码图片'); await transfer.dispose();
});

test('newest image wins; manual edits, close and lock cancel pending recognition', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { qrStarts: number; qrStops: number }; state.qrStarts = state.qrStops = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private pending: ReturnType<typeof setTimeout> | undefined;
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); state.qrStarts++; }
      postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        this.pending = setTimeout(() => { if (Array.isArray(transfer)) super.postMessage(message, transfer); else super.postMessage(message, transfer); }, 350);
      }
      terminate() { clearTimeout(this.pending); state.qrStops++; super.terminate(); }
    };
  });
  await setup(page); await openAdd(page);
  const a = await qrFile(), b = await qrFile(secondUri);
  const starts = () => page.evaluate(() => (window as unknown as { qrStarts: number }).qrStarts);
  const stops = () => page.evaluate(() => (window as unknown as { qrStops: number }).qrStops);
  await page.getByLabel('选择二维码图片', { exact: true }).setInputFiles(a); await expect.poll(starts).toBe(1);
  await page.getByLabel('选择二维码图片', { exact: true }).setInputFiles(b); await expect(page.getByLabel('账号名称', { exact: true })).toHaveValue('bob');
  await page.getByLabel('选择二维码图片', { exact: true }).setInputFiles(a); await expect.poll(starts).toBe(3);
  await page.getByLabel('账号名称', { exact: true }).fill('manual name'); await expect(page.locator('.qr-status')).toContainText('已取消');
  await page.waitForTimeout(450); await expect(page.getByLabel('账号名称', { exact: true })).toHaveValue('manual name');
  await expect(page.getByLabel('验证器密钥或 otpauth 链接')).toHaveValue(secondUri);
  await page.getByLabel('选择二维码图片', { exact: true }).setInputFiles(a); await expect.poll(starts).toBe(4);
  await page.getByLabel('关闭', { exact: true }).click(); await expect.poll(stops).toBe(4); await openAdd(page);
  await expect(page.getByLabel('验证器密钥或 otpauth 链接')).toHaveValue('');
  await page.getByLabel('选择二维码图片', { exact: true }).setInputFiles(a); await expect.poll(starts).toBe(5);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide'))); await expect.poll(stops).toBe(5);
  await expect(page.getByRole('heading', { name: '解锁你的验证码' })).toBeVisible(); await expect(page.locator('.qr-import')).toHaveCount(0);
});

test('mobile selection and first QR scan work offline with no upload or external request', async ({ page, context }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await setup(page);
  const external: string[] = [], uploads: string[] = [], errors: string[] = [];
  page.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:4173/') && !r.url().startsWith('blob:')) external.push(r.url()); if (r.method() !== 'GET') uploads.push(r.url()); });
  page.on('pageerror', e => errors.push(e.message));
  await context.setOffline(true); await openAdd(page);
  await page.getByLabel('选择二维码图片', { exact: true }).setInputFiles(await qrFile(secondUri));
  await expect(page.locator('.qr-status')).toContainText('已识别二维码'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('dialog').getByRole('button', { name: '添加账号', exact: true }).click(); await expect(page.locator('.account-card')).toHaveCount(1);
  expect(external).toEqual([]); expect(uploads).toEqual([]); expect(errors).toEqual([]); await context.setOffline(false);
});
