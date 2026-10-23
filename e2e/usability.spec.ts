import { test, expect, type Page } from '@playwright/test';
import QRCode from 'qrcode';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
async function setup(page: Page) {
  await page.goto('./');
  await page.getByLabel('设置 PIN', { exact: true }).fill('123456');
  await page.getByLabel('再次输入 PIN', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '创建账号库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible();
  await page.getByRole('button', { name: '添加账号', exact: true }).first().click();
  await page.getByLabel('验证器密钥或 otpauth 链接').fill(secret);
  await page.getByLabel('账号名称', { exact: true }).fill('alice');
  await page.getByRole('dialog').getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.locator('.account-card')).toHaveCount(1);
}
async function unlock(page: Page) {
  await page.getByLabel('解锁 PIN', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '解锁', exact: true }).click();
  await expect(page.locator('.account-card')).toHaveCount(1);
}

test('cached app reopens offline, keeps the vault locked, and can scan an image after reopening', async ({ page, context }) => {
  await page.clock.setFixedTime(new Date(59_000));
  await setup(page);
  await expect(page.locator('#offline-status')).toHaveText('离线资源已就绪');
  const manifest = await page.evaluate(async () => {
    // SW scope and precache must stay within this tool's path.
    const registration = await navigator.serviceWorker.getRegistration();
    const entries = (await Promise.all((await caches.keys()).filter(name => name.startsWith('cznail-totp-static-')).map(async name => (await (await caches.open(name)).keys()).map(request => request.url)))).flat();
    return { scope: registration?.scope, entries };
  });
  expect(manifest.scope).toBe('http://127.0.0.1:4173/totp/');
  expect(manifest.entries.length).toBeGreaterThan(5);
  expect(manifest.entries.every(url => url.startsWith('http://127.0.0.1:4173/totp/'))).toBe(true);
  expect(manifest.entries.join(' ')).not.toMatch(/alice|123456|GEZDG/);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: '解锁你的验证码' })).toBeVisible();
  await expect(page.locator('.account-card')).toHaveCount(0);
  await unlock(page);
  await expect(page.locator('[data-code]')).toHaveText('287 082');
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('./');
  await expect(reopened.getByRole('heading', { name: '解锁你的验证码' })).toBeVisible();
  await unlock(reopened);
  // Some Chromium versions keep navigator.onLine=true in a newly opened tab
  // under emulated offline mode. Successful reopening/unlocking and the cache
  // integrity handshake establish availability, independent of that OS hint.
  await expect(reopened.locator('#offline-status')).toHaveText(/^(离线资源已就绪|离线可用 · 使用设备时间)$/);
  await expect(reopened.getByRole('button', { name: '重试离线准备', exact: true })).toBeHidden();
  const qr = await QRCode.toBuffer('otpauth://totp/Test:bob?secret=JBSWY3DPEHPK3PXP&issuer=Test');
  await reopened.getByRole('button', { name: '添加账号', exact: true }).click();
  await reopened.getByLabel('选择二维码图片', { exact: true }).setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: qr });
  await expect(reopened.locator('.qr-status')).toContainText('已识别二维码');
  await expect(reopened.getByLabel('账号名称', { exact: true })).toHaveValue('bob');
  await context.setOffline(false);
});

test('backup status survives reopening, becomes stale after edits and PIN changes, and synchronizes tabs', async ({ page, context }) => {
  await setup(page);
  const summary = page.locator('#app [data-backup-summary]');
  await expect(summary).toContainText('尚未记录备份导出');
  const firstDownload = page.waitForEvent('download');
  await summary.getByRole('button', { name: '导出备份', exact: true }).click();
  const first = await firstDownload;
  const file = await first.path();
  const { readFile } = await import('node:fs/promises');
  const exported = JSON.parse(await readFile(file!, 'utf8'));
  expect(exported.format).toBe('cznail-totp-vault');
  expect(exported.version).toBe(2);
  expect(Object.keys(exported).sort()).toEqual(['cipher', 'ciphertext', 'format', 'unlocks', 'version']);
  await expect(summary).toContainText('当前版本已发起备份导出');
  const second = await context.newPage(); await second.goto('./'); await unlock(second);
  await expect(second.locator('#app [data-backup-summary]')).toContainText('当前版本已发起备份导出');
  await page.getByLabel('编辑 alice', { exact: true }).click();
  await page.getByLabel('账号名称', { exact: true }).fill('renamed');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(summary).toContainText('有变更');
  await expect(second.getByRole('heading', { name: '解锁你的验证码' })).toBeVisible();
  await unlock(second);
  const nextDownload = page.waitForEvent('download');
  await summary.getByRole('button', { name: '导出备份', exact: true }).click();
  expect((await nextDownload).suggestedFilename()).not.toBe(first.suggestedFilename());
  await expect(second.locator('#app [data-backup-summary]')).toContainText('当前版本已发起备份导出');
  await page.reload(); await unlock(page);
  await expect(summary).toContainText('当前版本已发起备份导出');
  await page.getByLabel('设置', { exact: true }).click();
  await page.getByRole('button', { name: /修改解锁 PIN/ }).click();
  await page.getByLabel('当前 PIN', { exact: true }).fill('123456');
  await page.getByLabel('新 PIN', { exact: true }).fill('654321');
  await page.getByLabel('再次输入新 PIN', { exact: true }).fill('654321');
  await page.getByRole('button', { name: '修改 PIN', exact: true }).click();
  await expect(summary).toContainText('有变更');
});

test('expiring copy reports remaining time; waiting never writes the clipboard until another click', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.clock.setFixedTime(new Date(57_000));
  await setup(page);
  await page.getByRole('button', { name: '复制 alice 的验证码', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('约剩 3 秒，即将更新');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('287082');
  await page.evaluate(() => navigator.clipboard.writeText('leave my clipboard alone'));
  await page.getByRole('button', { name: '等更新后再复制', exact: true }).click();
  await expect(page.locator('[data-wait-copy]')).toBeDisabled();
  await page.clock.setFixedTime(new Date(60_000));
  await expect(page.locator('[data-code]')).toHaveText('359 152');
  await expect(page.getByRole('button', { name: '复制新验证码', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('leave my clipboard alone');
  await page.getByRole('button', { name: '复制新验证码', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('359152');
  await expect(page.locator('#toast')).toHaveText('已复制 · 约剩 30 秒');
  await expect(page.locator('[data-wait-copy]')).toBeHidden();
  await page.clock.setFixedTime(new Date(89_000));
  await page.getByRole('button', { name: '等更新后再复制', exact: true }).click();
  await page.getByLabel('锁定账号库', { exact: true }).click();
  await unlock(page);
  await expect(page.getByRole('button', { name: '等更新后再复制', exact: true })).toBeEnabled();
});

test('export still works without receipt storage; failed clipboard write offers manual copy', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'cznail-totp:backup-export:v1') throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  await download;
  await expect(page.locator('#toast')).toContainText('无法记录导出时间');
  await expect(page.locator('[data-backup-summary]')).toContainText('尚未记录');
  await page.getByRole('button', { name: '复制 alice 的验证码', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('手动复制');
});
