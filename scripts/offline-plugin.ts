import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Precache the actual release, including shared UI and the bundled QR decoder. */
export function offlinePlugin(): Plugin {
  return {
    name: 'totp-offline',
    apply: 'build',
    async writeBundle(options) {
      const dir = resolve(options.dir ?? 'dist');
      async function filesAt(path = ''): Promise<string[]> {
        const entries = await readdir(join(dir, path), { withFileTypes: true });
        const groups = await Promise.all(entries.map(entry => {
          const name = path ? `${path}/${entry.name}` : entry.name;
          return entry.isDirectory() ? filesAt(name) : Promise.resolve([name]);
        }));
        return groups.flat().filter(name => name !== 'sw.js').sort();
      }
      const files = await filesAt();
      const hash = createHash('sha256');
      for (const file of files) hash.update(file).update('\0').update(await readFile(join(dir, file)));
      const cacheName = `cznail-totp-static-${hash.digest('hex').slice(0, 20)}`;
      await writeFile(join(dir, 'sw.js'), `/* Generated from this release's static assets. No vault data enters this cache. */
const CACHE = ${JSON.stringify(cacheName)};
const FILES = ${JSON.stringify(files)};
const URLS = FILES.map(file => new URL(file, self.registration.scope).href);
const INDEX = new URL('index.html', self.registration.scope).href;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(URLS.map(url => new Request(url, { cache: 'reload' })))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('cznail-totp-static-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return;
  const navigation = request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === new URL(INDEX).pathname);
  const key = navigation ? INDEX : request.url;
  if (!navigation && !URLS.includes(key)) return;
  event.respondWith(caches.open(CACHE).then(async cache => (await cache.match(key)) || fetch(request)));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'ACTIVATE_UPDATE') { self.skipWaiting(); return; }
  if (!['CHECK_OFFLINE', 'PREPARE_OFFLINE'].includes(event.data?.type) || !event.ports[0]) return;
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      if (event.data.type === 'PREPARE_OFFLINE') await cache.addAll(URLS.map(url => new Request(url, { cache: 'reload' })));
      const ready = (await Promise.all(URLS.map(url => cache.match(url)))).every(Boolean);
      event.ports[0].postMessage({ ready });
    } catch { event.ports[0].postMessage({ ready: false }); }
  })());
});
`);
    },
  };
}
