// Sharing and saving. Native share sheets (Capacitor Share plugin) on
// Android/iOS, the Web Share API where it exists, downloads otherwise; images
// go to the device gallery on Android (Pictures/<folder>).
import { toast } from './dom';
import { t } from '../i18n';
import { getSettings } from '../settings';

export interface FsPlugin { writeFile(o: { path: string; data: string; directory: string; recursive?: boolean }): Promise<{ uri: string }>; appendFile?(o: { path: string; data: string; directory: string }): Promise<void> }
interface SharePlugin { share(o: { title?: string; text?: string; url?: string; files?: string[]; dialogTitle?: string }): Promise<unknown> }
interface KrPlugin { processText(o: { text: string; readonly?: boolean }): Promise<void>; saveToGallery?(o: { data: string; name: string; folder: string }): Promise<{ path: string }>; saveToDownloads?(o: { path: string; name: string; mime: string }): Promise<{ path: string }> }
interface Cap { getPlatform?(): string; isNativePlatform?(): boolean; Plugins?: { Filesystem?: FsPlugin; Share?: SharePlugin; Kurokawa?: KrPlugin } }
const cap = (): Cap | undefined => (window as unknown as { Capacitor?: Cap }).Capacitor;
const platform = (): string => cap()?.getPlatform?.() ?? 'web';

/**
 * Save a file to the device. The PC and the web: the browser's download (a save dialog on the PC). Android: the
 * Downloads folder (an app's web view does nothing with a download link, which is why "save" did nothing there).
 * iOS: the share sheet, whose "Save to Files" is the way to keep a file.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const c = cap();
  if (platform() === 'android' && c?.Plugins?.Kurokawa?.saveToDownloads) { void saveNative(blob, filename); return; }
  if (platform() === 'ios' && c?.Plugins?.Share) { void shareFile(blob, filename, filename); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

async function saveNative(blob: Blob, filename: string): Promise<void> {
  try {
    const uri = await writeCache(blob, `save-${Date.now()}`, filename);
    const res = await cap()!.Plugins!.Kurokawa!.saveToDownloads!({ path: uri!, name: filename, mime: blob.type || 'application/octet-stream' });
    toast(t('savedTo', { f: res.path }));
  } catch (e) {
    console.warn('[kurokawa] save to Downloads failed', e);
    // (Saving cannot be done here: the share sheet can still put it somewhere.)
    await shareFile(blob, filename, filename);
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
}

/**
 * Write a file into the app's cache, a few megabytes at a time: one call with a whole 50 MB PDF as text (what this
 * did before) can stall or crash the app on a phone — which is when sharing a big scan did nothing.
 */
async function writeCache(blob: Blob, dir: string, filename: string): Promise<string | null> {
  const fs = cap()?.Plugins?.Filesystem;
  return fs ? writeChunked(fs, `kr-share/${dir}/${filename}`, blob, 'CACHE') : null;
}

/** Write `blob` to `path` with the Filesystem plugin, a few megabytes per call. Returns the file's URI. */
export async function writeChunked(fs: FsPlugin, path: string, blob: Blob, directory: string): Promise<string> {
  const CHUNK = 3 * 1024 * 1024; // (a multiple of 3: each piece's base64 stands alone)
  const { uri } = await fs.writeFile({ path, data: await blobToBase64(blob.slice(0, CHUNK)), directory, recursive: true });
  for (let at = CHUNK; at < blob.size; at += CHUNK) {
    if (!fs.appendFile) throw new Error('appendFile unavailable');
    await fs.appendFile({ path, data: await blobToBase64(blob.slice(at, at + CHUNK)), directory });
  }
  return uri;
}

/** Share a file: native sheet on Android/iOS, Web Share where supported, else download. */
export async function shareFile(blob: Blob, filename: string, title?: string): Promise<'shared' | 'saved'> {
  const c = cap();
  if (c?.isNativePlatform?.() && c.Plugins?.Share) {
    try {
      const uri = await writeCache(blob, `share-${Date.now() % 100000}`, filename);
      if (uri) { await c.Plugins.Share.share({ title, files: [uri], dialogTitle: title }); return 'shared'; }
    } catch (e) { if ((e as Error).message?.includes('cancel')) return 'shared'; console.warn('[kurokawa] native share failed', e); }
  }
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
  const c = cap();
  if (c?.isNativePlatform?.() && c.Plugins?.Share) {
    try { await c.Plugins.Share.share({ title, text, dialogTitle: title }); return true; } catch { return false; }
  }
  if (navigator.share) {
    try { await navigator.share({ text, title }); return true; } catch (e) { return (e as Error).name === 'AbortError'; }
  }
  try { await navigator.clipboard.writeText(text); toast(t('copied')); } catch { /* ignore */ }
  return false;
}

/** Save an image to the device: Android gallery (Pictures/<folder>), iOS share sheet ("Save Image"), elsewhere a download. */
export async function saveImage(blob: Blob, filename: string): Promise<void> {
  const c = cap();
  const folder = getSettings().snapFolder.trim() || 'Screenshots';
  if ((platform() === 'android' || platform() === 'ios') && c?.Plugins?.Kurokawa?.saveToGallery) {
    try {
      const res = await c.Plugins.Kurokawa.saveToGallery({ data: await blobToBase64(blob), name: filename, folder });
      toast(t('savedTo', { f: res.path })); return;
    } catch (e) { console.warn('[kurokawa] gallery save failed', e); toast(t('saveFailed'), 'error'); }
  }
  if (platform() === 'ios') { await shareFile(blob, filename); return; }
  downloadBlob(blob, filename);
  toast(t('savedTo', { f: filename }));
}

function systemTextPlugin(): KrPlugin | undefined { return cap()?.Plugins?.Kurokawa; }

/** Hand the text to another app for translation: Android's PROCESS_TEXT chooser
 *  (Google Translate, dictionaries…) when running natively, else the share sheet. */
export async function translateWithSystem(text: string): Promise<void> {
  const plugin = systemTextPlugin();
  if (plugin?.processText) { try { await plugin.processText({ text, readonly: true }); return; } catch { /* fall through */ } }
  await shareText(text);
}

export function hasSystemText(): boolean { return !!systemTextPlugin() || !!cap()?.Plugins?.Share || !!navigator.share; }

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, quality));
}

export async function fetchAsBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  return r.blob();
}

/** Copy an image to the clipboard. Native routes first (they are the ones that
 *  actually reach the system clipboard on Android/iOS/Electron); the async
 *  clipboard API is the web fallback. */
export async function copyImage(blob: Blob): Promise<boolean> {
  const c = cap();
  const kr = c?.Plugins?.Kurokawa as (KrPlugin & { copyImage?(o: { data: string }): Promise<void> }) | undefined;
  if ((platform() === 'android' || platform() === 'ios') && kr) {
    try { await kr.copyImage!({ data: await blobToBase64(blob) }); return true; } catch (e) { console.warn('[kurokawa] native copy failed', e); }
  }
  const desk = (window as unknown as { kurokawaDesktop?: { copyImage?(data: string): Promise<boolean> } }).kurokawaDesktop;
  if (desk?.copyImage) {
    try { if (await desk.copyImage(await blobToBase64(blob))) return true; } catch (e) { console.warn('[kurokawa] desktop copy failed', e); }
  }
  try {
    const CI = (window as unknown as { ClipboardItem?: new (d: Record<string, Blob>) => ClipboardItem }).ClipboardItem;
    if (CI && navigator.clipboard?.write) { await navigator.clipboard.write([new CI({ 'image/png': blob })]); return true; }
  } catch (e) { console.warn('[kurokawa] clipboard image failed', e); }
  toast(t('copyFailed'), 'error');
  return false;
}

/** Files written to be shared or saved are let go of the next time the app starts (by then they have been read). */
export async function clearShareCache(): Promise<void> {
  const fs = cap()?.Plugins?.Filesystem as (FsPlugin & { rmdir?(o: { path: string; directory: string; recursive: boolean }): Promise<void> }) | undefined;
  try { await fs?.rmdir?.({ path: 'kr-share', directory: 'CACHE', recursive: true }); } catch { /* nothing there */ }
}
