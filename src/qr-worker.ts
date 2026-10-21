import { decodeQrPixels } from './qr-decoder.ts';
import type { ScanRequest, ScanResult } from './qr.ts';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ScanRequest>) => void) | null;
  postMessage: (result: ScanResult) => void;
};
scope.onmessage = ({ data }) => {
  try { scope.postMessage({ payload: decodeQrPixels(data) }); }
  catch { scope.postMessage({ error: true }); }
  finally { data.pixels.fill(0); }
};
