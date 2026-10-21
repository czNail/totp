import { readQrImage } from './qr-image.ts';

export function mountQrImport(modal: HTMLDialogElement, form: HTMLFormElement, onResult: (result: Awaited<ReturnType<typeof readQrImage>>) => void, isBusy: () => boolean) {
  const area = document.createElement('section');
  area.className = 'qr-import';
  area.innerHTML = `<div class="qr-dropzone" tabindex="0" role="group" aria-label="二维码图片识别"><svg aria-hidden="true" width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path d="M7 7h3v3H7zm7 0h3v3h-3zM7 14h3v3H7zm7 0h3v3h-3z"/></svg><div><strong>粘贴截图，或拖入二维码图片</strong><span>支持 PNG / JPEG / WebP</span></div><button class="button secondary qr-pick" type="button">选择图片</button><input id="qr-image-file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="选择二维码图片" hidden /></div><p class="qr-status" role="status" aria-live="polite">图片仅在本机识别，识别后请确认添加。</p>`;
  form.prepend(area);
  const zone = area.querySelector<HTMLElement>('.qr-dropzone')!;
  const status = area.querySelector<HTMLElement>('.qr-status')!;
  const fileInput = area.querySelector<HTMLInputElement>('#qr-image-file')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  let controller: AbortController | null = null;
  let job = 0;
  let dragDepth = 0;

  function message(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  }
  function cancel(edited = false) {
    job++;
    const wasScanning = !!controller;
    controller?.abort(); controller = null;
    area.classList.remove('is-scanning');
    submit.disabled = isBusy();
    if (edited && wasScanning) message('图片识别已取消，保留你的输入。');
  }
  function scan(files: File[]) {
    if (isBusy()) return;
    cancel();
    if (files.length !== 1) { message('请一次选择或粘贴一张二维码图片。', true); return; }
    const active = new AbortController();
    controller = active;
    const token = job;
    area.classList.add('is-scanning'); submit.disabled = true;
    message('正在本机识别二维码…');
    void readQrImage(files[0], active.signal).then(result => {
      if (token !== job || active.signal.aborted || !modal.isConnected) return;
      onResult(result);
      message('已识别二维码，请核对账号信息后点击「添加账号」。');
    }).catch(error => {
      if (token !== job || active.signal.aborted || !modal.isConnected) return;
      message(error instanceof Error ? error.message : '图片识别失败，请重新截图后重试。', true);
    }).finally(() => {
      if (token !== job) return;
      controller = null; area.classList.remove('is-scanning'); submit.disabled = isBusy(); fileInput.value = '';
    });
  }
  area.querySelector('.qr-pick')!.addEventListener('click', () => { if (!isBusy()) fileInput.click(); }, options);
  zone.addEventListener('keydown', event => {
    if (event.target === zone && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (!isBusy()) fileInput.click(); }
  }, options);
  fileInput.addEventListener('change', () => { if (fileInput.files?.length) scan(Array.from(fileInput.files)); }, options);
  modal.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length) {
      for (const item of Array.from(event.clipboardData?.items ?? [])) {
        if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file); }
      }
    }
    if (files.length) { event.preventDefault(); scan(files); }
  }, options);
  form.addEventListener('input', event => {
    if (!area.contains(event.target as Node)) cancel(true);
  }, options);
  const fileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  document.addEventListener('dragenter', event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); dragDepth++; zone.classList.add('is-dragging');
  }, options);
  document.addEventListener('dragover', event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, options);
  document.addEventListener('dragleave', event => {
    if (!fileDrag(event)) return;
    dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) zone.classList.remove('is-dragging');
  }, options);
  document.addEventListener('drop', event => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    const types = Array.from(event.dataTransfer?.types ?? []);
    if (!files.length && !types.includes('text/uri-list') && !types.includes('text/html')) return;
    event.preventDefault(); dragDepth = 0; zone.classList.remove('is-dragging');
    if (files.length) scan(files);
    else message('请先复制图片或截图后粘贴，也可以选择本地图片。', true);
  }, options);
  return {
    get isScanning() { return controller !== null; },
    dispose() { listeners.abort(); cancel(); fileInput.value = ''; },
  };
}
