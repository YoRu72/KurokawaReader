// Sharing and saving helpers. Native share sheet when the platform offers one
// (Android/iOS/Windows PWA, Capacitor WebView), otherwise a download.
import { toast } from './dom';
import { t } from '../i18n';

export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export async function shareFile(blob: Blob, filename: string, title?: string): Promise<'shared' | 'saved'> {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try { await nav.share({ files: [file], title }); return 'shared'; } catch (e) { if ((e as Error).name === 'AbortError') return 'shared'; }
  }
  downloadBlob(blob, filename);
  toast(t('shareUnavailable'));
  return 'saved';
}

export async function shareText(text: string, title?: string): Promise<boolean> {
  if (navigator.share) {
    try { await navigator.share({ text, title }); return true; } catch (e) { return (e as Error).name === 'AbortError'; }
  }
  try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { /* ignore */ }
  return false;
}

interface SystemTextPlugin { processText(o: { text: string; readonly?: boolean }): Promise<void> }
function systemTextPlugin(): SystemTextPlugin | undefined {
  return (window as unknown as { Capacitor?: { Plugins?: { SystemText?: SystemTextPlugin } } }).Capacitor?.Plugins?.SystemText;
}

/** Hand the text to another app for translation: Android's PROCESS_TEXT chooser
 *  (Google Translate, dictionaries…) when running natively, else the share sheet. */
export async function translateWithSystem(text: string): Promise<void> {
  const plugin = systemTextPlugin();
  if (plugin) { try { await plugin.processText({ text, readonly: true }); return; } catch { /* fall through */ } }
  await shareText(text);
}

export function hasSystemText(): boolean { return !!systemTextPlugin() || !!navigator.share; }

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, quality));
}

export async function fetchAsBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  return r.blob();
}
