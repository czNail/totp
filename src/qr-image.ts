import QrWorker from './qr-worker.ts?worker&inline';
import { imageScanSizes, isRasterImageHeader, parseQrPayload, validateImageFile, type ScanRequest, type ScanResult } from './qr.ts';

const aborted = () => new DOMException('图片识别已取消', 'AbortError');
const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw aborted(); };

async function loadImage(file: File, signal: AbortSignal): Promise<{ image: HTMLImageElement; release: () => void }> {
  checkAbort(signal);
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  const release = () => { image.onload = null; image.onerror = null; image.src = 'data:,'; URL.revokeObjectURL(url); };
  try {
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { release(); reject(aborted()); };
      signal.addEventListener('abort', cancel, { once: true });
      image.onload = () => { signal.removeEventListener('abort', cancel); resolve(); };
      image.onerror = () => { signal.removeEventListener('abort', cancel); reject(new Error('无法读取这张图片，请选择清晰的 PNG、JPEG 或 WebP 图片。')); };
      image.src = url;
    });
    checkAbort(signal);
    return { image, release };
  } catch (error) { release(); throw error; }
}

function decode(worker: Worker, request: ScanRequest, signal: AbortSignal): Promise<string | null> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      worker.onmessage = null; worker.onerror = null;
    };
    const cancel = () => { finish(); reject(aborted()); };
    const timer = setTimeout(() => { finish(); reject(new Error('识别时间较长，请截取单个二维码区域后重试。')); }, 12_000);
    signal.addEventListener('abort', cancel, { once: true });
    worker.onerror = event => { event.preventDefault(); finish(); reject(new Error('无法启动本地图片识别，请刷新页面后重试。')); };
    worker.onmessage = ({ data }: MessageEvent<ScanResult>) => {
      finish();
      if (data.error || (data.payload !== null && typeof data.payload !== 'string')) reject(new Error('图片识别失败，请换一张清晰的截图重试。'));
      else resolve(data.payload ?? null);
    };
    try { worker.postMessage(request, [request.pixels.buffer]); }
    catch { finish(); reject(new Error('无法处理这张图片，请重新截图后重试。')); }
  });
}

/** Inline worker contains its decoder: no CDN, camera or clipboard-read permissions. */
export async function readQrImage(file: File, signal: AbortSignal): Promise<ReturnType<typeof parseQrPayload>> {
  validateImageFile(file);
  checkAbort(signal);
  if (!isRasterImageHeader(new Uint8Array(await file.slice(0, 12).arrayBuffer()))) throw new Error('无法读取这张图片，请选择 PNG、JPEG 或 WebP 图片。');
  const { image, release } = await loadImage(file, signal);
  const canvas = document.createElement('canvas');
  let worker: Worker | null = null;
  const cancel = () => { worker?.terminate(); worker = null; };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const attempts = imageScanSizes(image.naturalWidth, image.naturalHeight);
    checkAbort(signal);
    try { worker = new QrWorker(); }
    catch { throw new Error('无法启动本地图片识别，请刷新页面后重试。'); }
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('浏览器暂不支持图片识别，请手动输入密钥。');
    for (const size of attempts) {
      checkAbort(signal);
      canvas.width = size.width; canvas.height = size.height;
      context.fillStyle = '#fff'; context.fillRect(0, 0, size.width, size.height);
      context.drawImage(image, 0, 0, size.width, size.height);
      const pixels = context.getImageData(0, 0, size.width, size.height).data;
      const payload = await decode(worker, { pixels, ...size }, signal);
      checkAbort(signal);
      if (payload !== null) return parseQrPayload(payload);
    }
    throw new Error('没有识别到二维码，请截取完整、清晰的单个二维码后重试。');
  } finally {
    signal.removeEventListener('abort', cancel);
    worker?.terminate();
    release(); canvas.width = 0; canvas.height = 0;
  }
}
