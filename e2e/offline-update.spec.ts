import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

async function releaseServer() {
  let updated = false;
  let failPrecache = false;
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url!, 'http://localhost').pathname;
      const file = pathname === '/totp/' ? 'index.html' : pathname.slice('/totp/'.length);
      if (!pathname.startsWith('/totp/') || file.includes('..')) { response.writeHead(404).end(); return; }
      if (failPrecache && file === 'icons/icon-512.png') { response.writeHead(503).end(); return; }
      let data = await readFile(resolve('dist', file));
      if (file === 'sw.js' && updated) data = Buffer.from(data.toString().replace(/const CACHE = "([^"]+)"/, 'const CACHE = "$1-updated"'));
      const type: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
      response.writeHead(200, { 'Content-Type': type[extname(file)] ?? 'text/plain', 'Cache-Control': 'no-store' });
      response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not start');
  return {
    url: `http://127.0.0.1:${address.port}/totp/`,
    update: () => { updated = true; },
    fail: (value: boolean) => { failPrecache = value; },
    close: () => { server.closeAllConnections(); server.close(); },
  };
}

test('new releases wait for an explicit update, lock first, and preserve other tools caches and the vault', async ({ page }) => {
  const release = await releaseServer();
  try {
    await page.goto(release.url);
    await expect(page.locator('#offline-status')).toHaveText('离线资源已就绪');
    await page.getByLabel('设置 PIN', { exact: true }).fill('123456');
    await page.getByLabel('再次输入 PIN', { exact: true }).fill('123456');
    await page.getByRole('button', { name: '创建账号库', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible();
    await page.evaluate(async () => { await caches.open('other-tool-static'); });
    release.update();
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    await expect(page.getByRole('button', { name: '更新并重新打开', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible();
    // Let the pending release finish; it still must not refresh automatically.
    const next = page.waitForEvent('load');
    await page.getByRole('button', { name: '更新并重新打开', exact: true }).click();
    await next;
    await expect(page.getByRole('heading', { name: '解锁你的验证码' })).toBeVisible();
    expect(await page.evaluate(() => caches.has('other-tool-static'))).toBe(true);
    await page.getByLabel('解锁 PIN', { exact: true }).fill('123456');
    await page.getByRole('button', { name: '解锁', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的验证码' })).toBeVisible();
    await expect(page.locator('#offline-status')).toHaveText('离线资源已就绪');
  } finally { release.close(); }
});

test('a failed precache does not break the tool and can be retried when resources recover', async ({ page }) => {
  const release = await releaseServer();
  release.fail(true);
  try {
    await page.goto(release.url);
    await expect(page.getByRole('heading', { name: '创建你的本地账号库' })).toBeVisible();
    await expect(page.locator('#offline-status')).toContainText('离线资源未就绪');
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
    release.fail(false);
    await page.getByRole('button', { name: '重试离线准备', exact: true }).click();
    await expect(page.locator('#offline-status')).toHaveText('离线资源已就绪');
    // Storage pressure can evict static assets without removing the active SW.
    // Revisiting online must rebuild its cache, not leave an endless retry loop.
    await page.evaluate(async () => {
      for (const name of await caches.keys()) if (name.startsWith('cznail-totp-static-')) await caches.delete(name);
    });
    await page.reload();
    await expect(page.locator('#offline-status')).toHaveText('离线资源已就绪');
  } finally { release.close(); }
});
