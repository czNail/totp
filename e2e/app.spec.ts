import { test, expect, type Page } from '@playwright/test';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const otherSecret = 'JBSWY3DPEHPK3PXP';
async function setup(page: Page) {
  await page.goto('./');
  await page.getByLabel('设置 PIN', { exact: true }).fill('123456');
  await page.getByLabel('再次输入 PIN', { exact: true }).fill('123456');
  await page.getByRole('button', { name: '创建账号库', exact: true }).click();
  await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible();
}
async function unlock(page: Page, pin = '123456') {
  await page.getByLabel('解锁 PIN', { exact: true }).fill(pin);
  await page.getByRole('button', { name: '解锁', exact: true }).click();
}
async function add(page: Page, name = 'work@example.com', key = secret) {
  await page.getByRole('button', { name: '添加账号', exact: true }).first().click();
  await page.getByLabel('验证器密钥或 otpauth 链接').fill(key);
  await page.getByLabel('账号名称', { exact: true }).fill(name);
  await page.getByLabel('服务名称').fill('GitHub');
  await page.getByRole('dialog').getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('cznail-totp-v1', 1);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
    return new Promise<{ revision: string; envelope: unknown } | undefined>((resolve, reject) => {
      const r = db.transaction('vault').objectStore('vault').get('main');
      r.onsuccess = () => { db.close(); resolve(r.result); }; r.onerror = () => reject(r.error);
    });
  });
}

test('create, calculate RFC code, copy, rename, search, delete and reopen', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.clock.setFixedTime(new Date(59_000));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await setup(page); await add(page);
  await expect(page.locator('[data-code]')).toHaveText('287 082');
  await page.getByRole('button', { name: '复制 work@example.com 的验证码' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('287082');
  const serialized = JSON.stringify(await stored(page));
  for (const plaintext of ['123456', secret, 'work@example.com', 'GitHub']) expect(serialized).not.toContain(plaintext);
  await add(page, 'personal', otherSecret);
  await page.getByLabel('搜索账号').fill('personal');
  await expect(page.locator('.account-card')).toHaveCount(1);
  await page.getByLabel('编辑 personal', { exact: true }).click();
  await page.getByLabel('账号名称', { exact: true }).fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('搜索账号').fill('');
  await expect(page.getByText('<img src=x onerror=alert(1)>', { exact: true })).toBeVisible();
  await expect(page.locator('.account-card img')).toHaveCount(0);
  await page.getByLabel('编辑 <img src=x onerror=alert(1)>', { exact: true }).click();
  await page.getByRole('button', { name: '删除账号', exact: true }).click();
  await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.locator('.account-card')).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: '解锁你的验证码' })).toBeVisible();
  await expect(page.getByText('work@example.com', { exact: true })).toHaveCount(0);
  await unlock(page, '999999');
  await expect(page.getByRole('alert')).toContainText('PIN 不正确');
  await expect(page.getByLabel('解锁 PIN')).toHaveValue('');
  await unlock(page);
  await expect(page.locator('[data-code]')).toHaveText('287 082');
  await page.clock.setFixedTime(new Date(60_000));
  await expect(page.locator('[data-code]')).toHaveText('359 152');
  await expect(page.locator('[data-countdown]')).toHaveText('30 秒后更新');
  await page.getByLabel('锁定账号库', { exact: true }).click();
  await expect(page.locator('[data-code]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('URI imports custom parameters; invalid and duplicate keys cannot change storage', async ({ page }) => {
  await page.clock.setFixedTime(new Date(59_000)); await setup(page);
  await page.getByRole('button', { name: '添加账号', exact: true }).first().click();
  const uri = 'otpauth://totp/Example:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&issuer=Example&algorithm=SHA256&digits=8&period=30';
  await page.getByLabel('验证器密钥或 otpauth 链接').fill(uri);
  await expect(page.getByLabel('账号名称', { exact: true })).toHaveValue('alice');
  await expect(page.getByLabel('算法', { exact: true })).toHaveValue('SHA256');
  await page.getByRole('dialog').getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.locator('[data-code]')).toHaveText('4611 9246');
  const original = await stored(page);
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  await page.getByLabel('验证器密钥或 otpauth 链接').fill('NOT-VALID-019');
  await page.getByLabel('账号名称', { exact: true }).fill('bad');
  await page.getByRole('dialog').getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Base32');
  expect(await stored(page)).toEqual(original);
  await page.getByLabel('验证器密钥或 otpauth 链接').fill(uri);
  await page.getByRole('dialog').getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('已经添加');
  expect(await stored(page)).toEqual(original);
});

test('backup, PIN change, failed restore, explicit replacement, reset and clean restore', async ({ page }) => {
  await setup(page); await add(page);
  await page.getByRole('button', { name: '备份', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出加密备份/ }).click();
  const path = await (await download).path(); expect(path).toBeTruthy();
  await page.getByLabel('关闭', { exact: true }).click();
  await page.getByLabel('设置', { exact: true }).click();
  await page.getByRole('button', { name: /修改解锁 PIN/ }).click();
  await page.getByLabel('当前 PIN', { exact: true }).fill('123456');
  await page.getByLabel('新 PIN', { exact: true }).fill('654321');
  await page.getByLabel('再次输入新 PIN', { exact: true }).fill('654321');
  await page.getByRole('button', { name: '修改 PIN', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await page.reload();
  await unlock(page, '123456'); await expect(page.getByRole('alert')).toContainText('PIN 不正确');
  await unlock(page, '654321'); await expect(page.locator('.account-card')).toHaveCount(1);
  await add(page, 'second', otherSecret);
  await page.getByRole('button', { name: '备份', exact: true }).click();
  await page.getByRole('button', { name: /从备份恢复/ }).click();
  await page.getByLabel('加密备份文件').setInputFiles(path!);
  await page.getByLabel('这份备份的 PIN').fill('654321'); await page.getByRole('checkbox').check();
  const original = await stored(page);
  await page.getByRole('button', { name: '恢复账号库', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('PIN 不正确'); expect(await stored(page)).toEqual(original);
  await page.getByLabel('这份备份的 PIN').fill('123456');
  await page.getByRole('button', { name: '恢复账号库', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('.account-card')).toHaveCount(1);
  await page.getByLabel('设置', { exact: true }).click();
  await page.getByRole('button', { name: '清空本机数据', exact: true }).click();
  await page.getByLabel('输入「清空」确认').fill('清空');
  await page.getByRole('button', { name: '清空本机数据', exact: true }).click();
  await expect(page.getByRole('heading', { name: '创建你的本地账号库' })).toBeVisible();
  expect(await stored(page)).toBeUndefined();
  await page.getByRole('button', { name: '从备份恢复', exact: true }).click();
  await page.getByLabel('加密备份文件').setInputFiles(path!);
  await page.getByLabel('这份备份的 PIN').fill('123456');
  await page.getByRole('button', { name: '恢复账号库', exact: true }).click();
  await expect(page.locator('.account-card')).toHaveCount(1); await page.reload();
  await unlock(page); await expect(page.locator('.account-card')).toHaveCount(1);
});

test('stale saves are rejected even when BroadcastChannel is unavailable', async ({ page, context }) => {
  await context.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: undefined }); });
  await setup(page); await add(page);
  const second = await context.newPage(); await second.goto('./'); await unlock(second);
  await page.getByLabel('编辑 work@example.com', { exact: true }).click();
  await page.getByLabel('账号名称', { exact: true }).fill('stale rename');
  await add(second, 'new account', otherSecret);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('heading', { name: '解锁你的验证码' })).toBeVisible();
  await unlock(page); await expect(page.locator('.account-card')).toHaveCount(2);
  await expect(page.getByText('work@example.com', { exact: true })).toBeVisible();
  await expect(page.getByText('stale rename', { exact: true })).toHaveCount(0);
});

test('aborted IndexedDB commit preserves existing data and rejects unsaved accounts', async ({ page }) => {
  await setup(page); await add(page); const original = await stored(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
      const result = put.apply(this, args); this.transaction.abort(); return result;
    };
  });
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  await page.getByLabel('验证器密钥或 otpauth 链接').fill(otherSecret);
  await page.getByLabel('账号名称', { exact: true }).fill('unsaved account');
  await page.getByRole('dialog').getByRole('button', { name: '添加账号', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('保存失败'); expect(await stored(page)).toEqual(original);
  await page.getByLabel('关闭', { exact: true }).click(); await expect(page.locator('.account-card')).toHaveCount(1);
});

test('mobile layout, dark theme, offline calculation and pagehide lock', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.clock.setFixedTime(new Date(59_000));
  await setup(page); await add(page); await page.getByLabel('切换深色主题').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.setOffline(true); await page.clock.setFixedTime(new Date(60_000));
  await expect(page.locator('[data-code]')).toHaveText('359 152');
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  await page.getByLabel('验证器密钥或 otpauth 链接').fill(otherSecret);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.locator('[data-code]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '解锁你的验证码' })).toBeVisible();
  expect(await page.locator('body').innerHTML()).not.toContain(otherSecret);
  await context.setOffline(false);
});
