interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Program availability only: no secrets, account data or background clipboard work. */
export function mountOffline(beforeUpdate: () => boolean): void {
  const host = document.querySelector<HTMLElement>('#app-tools')!;
  host.innerHTML = `<div class="offline-tools"><span id="offline-status" role="status">正在准备离线资源…</span><button id="offline-retry" class="text-button" hidden>重试离线准备</button><button id="install-app" class="text-button" hidden>安装到设备</button><button id="update-app" class="text-button" hidden>更新并重新打开</button></div><details class="install-help"><summary>添加到设备</summary><p>电脑：使用浏览器地址栏的安装入口。<br />iPhone / iPad：在 Safari 分享菜单中选择「添加到主屏幕」。<br />安卓：在浏览器菜单中选择「安装应用」或「添加到主屏幕」。<br />首次联网打开并显示「离线资源已就绪」后，即可断网重新打开。清理站点数据仍会删除本地账号，请保留备份。</p></details>`;
  const status = host.querySelector<HTMLElement>('#offline-status')!;
  const retry = host.querySelector<HTMLButtonElement>('#offline-retry')!;
  const update = host.querySelector<HTMLButtonElement>('#update-app')!;
  const install = host.querySelector<HTMLButtonElement>('#install-app')!;
  const help = host.querySelector<HTMLElement>('.install-help')!;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone;
  if (standalone()) help.hidden = true;
  let prompt: InstallPrompt | null = null;
  let registration: ServiceWorkerRegistration | undefined;
  let ready = false;
  let reloadForUpdate = false;
  let checking = 0;
  function display() {
    status.textContent = ready ? (navigator.onLine ? '离线资源已就绪' : '离线可用 · 使用设备时间') : '离线资源未就绪，请联网后重试';
    retry.hidden = ready;
    update.hidden = !registration?.waiting;
  }
  async function checkReady(repair = false) {
    const worker = navigator.serviceWorker.controller;
    if (!worker || worker.scriptURL !== new URL('sw.js', location.href).href) return;
    const check = ++checking;
    const result = await new Promise<boolean>(resolve => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); resolve(false); }, 10_000);
      channel.port1.onmessage = event => { clearTimeout(timeout); channel.port1.close(); resolve(event.data?.ready === true); };
      try { worker.postMessage({ type: repair ? 'PREPARE_OFFLINE' : 'CHECK_OFFLINE' }, [channel.port2]); }
      catch { clearTimeout(timeout); channel.port1.close(); resolve(false); }
    });
    if (check !== checking) return;
    ready = result; display();
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); prompt = event as InstallPrompt; install.hidden = !!standalone();
  });
  install.addEventListener('click', async () => {
    const current = prompt;
    if (!current) return;
    prompt = null; install.hidden = true;
    try { await current.prompt(); await current.userChoice; } catch { help.hidden = false; help.setAttribute('open', ''); }
  });
  window.addEventListener('appinstalled', () => { prompt = null; install.hidden = true; help.hidden = true; });
  if (!('serviceWorker' in navigator)) {
    status.textContent = '此浏览器暂不支持离线打开';
    return;
  }
  function watch(worker: ServiceWorker | null) {
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'redundant') { if (!ready) display(); }
      else if (worker.state === 'activated') void checkReady();
      if (worker.state === 'installed') display();
    });
  }
  async function register() {
    retry.hidden = true;
    if (!ready) status.textContent = '正在准备离线资源…';
    try {
      registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL, updateViaCache: 'none' });
      watch(registration.installing);
      registration.addEventListener('updatefound', () => watch(registration!.installing));
      if (registration.active) {
        await checkReady();
        if (!ready && navigator.onLine) await checkReady(true);
      }
      if (registration.waiting) display();
      if (!registration.active && !registration.installing && !registration.waiting) display();
    } catch { display(); }
  }
  retry.addEventListener('click', () => { void register(); });
  window.addEventListener('online', () => { if (ready) display(); else void register(); });
  window.addEventListener('offline', display);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadForUpdate) location.reload(); else void checkReady();
  });
  update.addEventListener('click', () => {
    if (!registration?.waiting || !beforeUpdate()) return;
    reloadForUpdate = true; update.disabled = true;
    registration.waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
    setTimeout(() => { reloadForUpdate = false; update.disabled = false; }, 10_000);
  });
  void register();
}
