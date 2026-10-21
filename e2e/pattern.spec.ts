import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const baseURL = 'http://127.0.0.1:4173/totp/';
const first = '14789';
const second = '12369';
async function setup(page: Page) {
  await page.goto(baseURL);
  await page.getByLabel('设置 PIN', { exact: true }).fill('123456');
  await page.getByLabel('再次输入 PIN', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '创建账号库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible();
}
async function draw(page: Page, pattern: string) {
  const box = await page.locator('.pattern-pad').boundingBox();
  if (!box) throw new Error('Pattern pad not visible');
  const points = Array.from(pattern, digit => {
    const i = Number(digit) - 1;
    return { x: box.x + box.width * ((i % 3 + .5) / 3), y: box.y + box.height * ((Math.floor(i / 3) + .5) / 3) };
  });
  await page.mouse.move(points[0].x, points[0].y); await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 1 });
  await page.mouse.up();
}
async function enable(page: Page, pattern = first) {
  await page.getByLabel('设置', { exact: true }).click();
  await page.getByRole('button', { name: /^设置手势密码/ }).click();
  await draw(page, pattern);
  await expect(page.getByText('再次绘制相同手势', { exact: true })).toBeVisible();
  await draw(page, pattern);
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function pinUnlock(page: Page, pin = '123456') {
  const toggle = page.getByRole('button', { name: 'PIN 解锁', exact: true });
  if (await toggle.count()) await toggle.click();
  await page.getByLabel('解锁 PIN', { exact: true }).fill(pin);
  await page.getByRole('button', { name: '解锁', exact: true }).click();
}
async function add(page: Page, name: string, secret: string) {
  await page.getByRole('button', { name: '添加账号', exact: true }).first().click();
  await page.getByLabel('验证器密钥或 otpauth 链接').fill(secret);
  await page.getByLabel('账号名称', { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function record(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('cznail-totp-v1', 1); r.onsuccess = () => resolve(r.result); });
    return new Promise<{ revision: string; envelope: { version: number; unlocks?: { pattern?: unknown } } }>(resolve => {
      const r = db.transaction('vault').objectStore('vault').get('main'); r.onsuccess = () => { db.close(); resolve(r.result); };
    });
  });
}

test('confirm gesture twice, prefer gesture, recover with PIN and save accounts through either method', async ({ page }) => {
  await setup(page);
  await add(page, 'before', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  await page.getByLabel('设置', { exact: true }).click();
  await page.getByRole('button', { name: /^设置手势密码/ }).click();
  await draw(page, '12'); await expect(page.getByRole('alert')).toContainText('至少连接 4');
  await draw(page, first); await expect(page.getByText('再次绘制相同手势', { exact: true })).toBeVisible();
  const original = await record(page);
  await draw(page, second); await expect(page.getByRole('alert')).toContainText('不一致');
  expect(await record(page)).toEqual(original);
  await draw(page, first); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await record(page)).envelope.unlocks?.pattern).toBeTruthy();
  await page.reload();
  await expect(page.getByRole('button', { name: '手势解锁', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('解锁 PIN', { exact: true })).toHaveCount(0);
  const unchanged = await record(page);
  await draw(page, second); await expect(page.getByRole('alert')).toContainText('手势不正确');
  expect(await record(page)).toEqual(unchanged);
  await pinUnlock(page); await expect(page.locator('.account-card')).toHaveCount(1);
  await page.getByLabel('锁定账号库', { exact: true }).click();
  await draw(page, first); await expect(page.locator('.account-card')).toHaveCount(1);
  await add(page, 'after', 'JBSWY3DPEHPK3PXP');
  await page.reload(); await pinUnlock(page);
  await expect(page.locator('.account-card')).toHaveCount(2);
  await page.getByLabel('锁定账号库', { exact: true }).click();
  await draw(page, first); await expect(page.locator('.account-card')).toHaveCount(2);
});

test('PIN changes preserve gesture; changing and disabling gesture preserves current PIN', async ({ page }) => {
  await setup(page); await enable(page);
  await page.getByLabel('设置', { exact: true }).click();
  await page.getByRole('button', { name: /^修改解锁 PIN/ }).click();
  await page.getByLabel('当前 PIN', { exact: true }).fill('123456');
  await page.getByLabel('新 PIN', { exact: true }).fill('654321');
  await page.getByLabel('再次输入新 PIN', { exact: true }).fill('654321');
  await page.getByRole('button', { name: '修改 PIN', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload(); await draw(page, first);
  await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible();
  await page.getByLabel('设置', { exact: true }).click();
  await page.getByRole('button', { name: /^修改手势密码/ }).click();
  await draw(page, second); await expect(page.getByText('再次绘制相同手势', { exact: true })).toBeVisible();
  await draw(page, second); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload(); await draw(page, first); await expect(page.getByRole('alert')).toContainText('手势不正确');
  await draw(page, second); await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible();
  await page.getByLabel('设置', { exact: true }).click();
  await page.getByRole('button', { name: '关闭手势解锁', exact: true }).click();
  await page.getByRole('button', { name: '确认关闭', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await page.reload();
  await expect(page.locator('.pattern-pad')).toHaveCount(0);
  await pinUnlock(page, '123456'); await expect(page.getByRole('alert')).toContainText('PIN 不正确');
  await pinUnlock(page, '654321'); await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible();
});

test('encrypted backup restores both unlock methods using either one, with no separate gesture file', async ({ page, browser }) => {
  await setup(page); await add(page, 'backed up', 'JBSWY3DPEHPK3PXP'); await enable(page);
  await page.getByRole('button', { name: '备份', exact: true }).click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: /导出加密备份/ }).click();
  const path = (await (await download).path())!;
  const exported = readFileSync(path, 'utf8');
  for (const plaintext of ['123456', 'JBSWY3DPEHPK3PXP', 'backed up']) expect(exported).not.toContain(plaintext);
  for (const method of ['pattern', 'pin']) {
    const context = await browser.newContext(); const restored = await context.newPage();
    await restored.goto(baseURL); await restored.getByRole('button', { name: '从备份恢复', exact: true }).click();
    await restored.getByLabel('加密备份文件').setInputFiles(path);
    await expect(restored.getByRole('button', { name: '手势解锁', exact: true })).toHaveAttribute('aria-pressed', 'true');
    if (method === 'pattern') await draw(restored, first);
    else {
      await restored.getByRole('button', { name: 'PIN 解锁', exact: true }).click();
      await restored.getByLabel('这份备份的 PIN').fill('123456');
      await restored.getByRole('button', { name: '恢复账号库', exact: true }).click();
    }
    await expect(restored.getByRole('dialog')).toHaveCount(0);
    await expect(restored.locator('.account-card')).toHaveCount(1);
    await restored.reload(); await draw(restored, first); await expect(restored.locator('.account-card')).toHaveCount(1);
    await restored.getByLabel('锁定账号库', { exact: true }).click(); await pinUnlock(restored);
    await expect(restored.locator('.account-card')).toHaveCount(1); await context.close();
  }
});

test('v1 account migration is atomic; original PIN backups still restore', async ({ page }) => {
  const path = new URL('../tests/fixtures/vault-v1.json', import.meta.url);
  const legacy = JSON.parse(readFileSync(path, 'utf8'));
  await page.goto(baseURL); await expect(page.getByRole('heading', { name: '创建你的本地账号库' })).toBeVisible();
  await page.evaluate(async envelope => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('cznail-totp-v1', 1); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>(resolve => { const t = db.transaction('vault', 'readwrite'); t.objectStore('vault').put({ id: 'main', revision: 'legacy-test', envelope }); t.oncomplete = () => { db.close(); resolve(); }; });
  }, legacy);
  await page.reload(); await pinUnlock(page, '999999'); await expect(page.getByRole('alert')).toContainText('PIN 不正确');
  expect((await record(page)).envelope.version).toBe(1);
  await page.evaluate(() => { const put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) { const r = put.apply(this, args); this.transaction.abort(); return r; }; });
  await pinUnlock(page); await expect(page.getByRole('alert')).toContainText('保存失败');
  expect((await record(page)).envelope).toEqual(legacy);
  await page.reload(); await pinUnlock(page); await expect(page.locator('.account-card')).toHaveCount(1);
  expect((await record(page)).envelope.version).toBe(2);
  await enable(page);
  await page.getByRole('button', { name: '备份', exact: true }).click();
  await page.getByRole('button', { name: /从备份恢复/ }).click();
  await page.getByLabel('加密备份文件').setInputFiles({ name: 'legacy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
  await page.getByLabel('这份备份的 PIN').fill('123456'); await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '恢复账号库', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await page.reload();
  await expect(page.locator('.pattern-pad')).toHaveCount(0); await pinUnlock(page);
  await expect(page.getByText('legacy@example.com', { exact: true })).toBeVisible();
});

test('touch, skipped dots, cancelled strokes and keyboard input agree on a small screen', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 740 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(); await setup(page);
  const cdp = await context.newCDPSession(page);
  async function touch(pattern: string, cancel = false) {
    const box = (await page.locator('.pattern-pad').boundingBox())!;
    const points = Array.from(pattern, digit => { const i = Number(digit) - 1; return { x: box.x + box.width * ((i % 3 + .5) / 3), y: box.y + box.height * ((Math.floor(i / 3) + .5) / 3) }; });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] });
    for (const point of points.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
  }
  await page.getByLabel('设置', { exact: true }).click(); await page.getByRole('button', { name: /^设置手势密码/ }).click();
  await touch('1397'); await expect(page.getByText('再次绘制相同手势', { exact: true })).toBeVisible();
  await touch('1397'); await expect(page.getByRole('dialog')).toHaveCount(0); await page.reload();
  await expect(page.locator('.pattern-pad')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await touch('13', true); await expect(page.locator('.pattern-node.selected')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '解锁你的验证码' })).toBeVisible();
  await touch('1397'); await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible();
  await page.getByLabel('锁定账号库', { exact: true }).click();
  await page.locator('.pattern-pad').focus(); await page.keyboard.type('1397'); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible(); await context.close();
});
