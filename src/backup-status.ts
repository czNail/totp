/** Export receipts contain no account data and never change the vault/backup format. */
export const EXPORT_RECEIPT_KEY = 'cznail-totp:backup-export:v1';
export interface ExportReceipt { revision: string; exportedAt: number }

export function readExportReceipt(): ExportReceipt | null {
  try {
    const value = JSON.parse(localStorage.getItem(EXPORT_RECEIPT_KEY) ?? 'null');
    if (!value || typeof value.revision !== 'string' || !/^[\da-f-]{36}$/.test(value.revision) ||
        !Number.isSafeInteger(value.exportedAt) || value.exportedAt < 0 || !Number.isFinite(new Date(value.exportedAt).getTime())) return null;
    return { revision: value.revision, exportedAt: value.exportedAt };
  } catch { return null; }
}

export function recordExport(receipt: ExportReceipt): boolean {
  try { localStorage.setItem(EXPORT_RECEIPT_KEY, JSON.stringify(receipt)); return true; }
  catch { return false; }
}

export function clearExportReceipt(): void {
  try { localStorage.removeItem(EXPORT_RECEIPT_KEY); } catch { /* Export receipts are optional. */ }
}
