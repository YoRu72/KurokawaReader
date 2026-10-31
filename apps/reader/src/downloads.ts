// Books fetched from the sources: downloads that go on when the page is left or the phone is locked, with their
// speed and how far along they are. The bytes come by the platform's own downloader where there is one — on
// Android a thread of the app's service (several connections at once for a file served in ranges, the file
// written to the cache, the app held alive by the service's notification), on the PC the main process — and
// through the sources' request layer elsewhere. What is under way is kept (localStorage) so that a download the
// app was killed in the middle of is taken up again when it opens; when a file arrives it goes into the library
// whatever view is open, and the view that asked is told through onDownloads.
import { fileFault } from './filecheck';
import { setBusy, clearBusy } from './busy';
import { db } from './db';
import { importFiles } from './library';
import { t, formatBytes, localDigits, countConnections } from './i18n';
import { toast } from './ui/dom';
import { runJob } from './jobs';
import { readContentUri, nativePlatform } from './native';
import type { Book } from './db';

export type Progress = { pct: number; got: number; total: number; speed?: number; connections?: number };
/** What to do with the file once it is here: into the library, remembered as coming from its source. */
export type Then = { srcId: string; itemId: string; title: string; folderId?: string; series?: Book['series']; tags?: string[]; /** Saved to the device (Download), not into the library. */ deviceOnly?: boolean; /** A book of the library whose file this takes the place of (one that came broken). */ replace?: string };
export type DownloadTask = { url: string; name: string; mime?: string; size?: number; headers?: Record<string, string>; title: string; then: Then };
export type Download = DownloadTask & { id: string; got: number; total: number; speed: number; pct: number; state: 'running' | 'done' | 'failed' | 'cancelled'; /** Waiting for its turn (three run at a time). */ queued?: boolean; error?: string; bookId?: string; startedAt: number };

const KEY = 'kr.downloads';
const list: Download[] = [];
const listeners = new Set<() => void>();
const changed = () => { for (const fn of listeners) fn(); };
/** Told when any download moves. */
export function onDownloads(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export const downloadsNow = (): Download[] => list;
/** The download under way (or done) for an item of a source, if any. */
export const downloadOf = (srcId: string, itemId: string, url?: string): Download | undefined => list.find((d) => d.then.srcId === srcId && d.then.itemId === itemId && (!url || d.url === url) && d.state !== 'cancelled');

const waiting = new Map<string, { ok: (b: Book) => void; fail: (e: Error) => void }>();
const cancels = new Map<string, () => void>();

function persist(): void {
  try { localStorage.setItem(KEY, JSON.stringify(list.filter((d) => d.state === 'running').map(({ id, url, name, mime, size, headers, title, then, startedAt }) => ({ id, url, name, mime, size, headers, title, then, startedAt })))); } catch { /* full */ }
}

/** A line for the chip and the notification: "42% · 3.1 MB / 12 MB · 1.8 MB/s". */
export function describeProgress(d: Progress): string {
  const parts: string[] = [];
  if (d.total) parts.push(`${localDigits(d.pct)}%`, `${formatBytes(d.got)} / ${formatBytes(d.total)}`); else if (d.got) parts.push(formatBytes(d.got));
  if (d.speed && d.speed > 0) parts.push(t('perSecond', { n: formatBytes(d.speed) }));
  // (Over how many connections at once: a file the server serves in ranges comes in several pieces together.)
  if ((d.connections ?? 1) > 1) parts.push(countConnections(d.connections!));
  return parts.join(' · ');
}

/** Start a download; resolves with the book once it is in the library. A second ask for the same file joins
 *  the first. */
export function startDownload(task: DownloadTask): Promise<Book> {
  const had = list.find((d) => d.url === task.url && d.state === 'running');
  if (had) return new Promise((ok, fail) => { const w = waiting.get(had.id); waiting.set(had.id, { ok: (b) => { w?.ok(b); ok(b); }, fail: (e) => { w?.fail(e); fail(e); } }); });
  const d: Download = { ...task, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, got: 0, total: task.size ?? 0, speed: 0, pct: 0, state: 'running', startedAt: Date.now() };
  list.unshift(d);
  while (list.length > 40) { const i = list.findIndex((x) => x.state !== 'running'); if (i < 0) break; list.splice(i, 1); }
  persist(); changed();
  const p = new Promise<Book>((ok, fail) => waiting.set(d.id, { ok, fail }));
  void run(d);
  return p;
}

/** A failed or cancelled download asked for again (the same file, the same destination). */
export function retryDownload(id: string): Promise<Book> | null {
  const d = list.find((x) => x.id === id); if (!d || d.state === 'running') return null;
  const i = list.indexOf(d); if (i >= 0) list.splice(i, 1);
  return startDownload({ url: d.url, name: d.name, mime: d.mime, size: d.size, headers: d.headers, title: d.title, then: d.then });
}
/** The finished, failed and cancelled downloads cleared from the list. */
export function clearDownloads(): void { for (let i = list.length - 1; i >= 0; i--) if (list[i].state !== 'running') list.splice(i, 1); persist(); changed(); }

export function cancelDownload(id: string): void {
  const d = list.find((x) => x.id === id); if (!d || d.state !== 'running') return;
  d.state = 'cancelled'; cancels.get(id)?.(); cancels.delete(id);
  persist(); changed();
}

// A few at a time (as download managers do): the rest wait their turn, so a dozen volumes asked for at once
// do not fight for the connection.
const AT_ONCE = 3;
let active = 0; const turns: (() => void)[] = [];
const takeTurn = () => new Promise<void>((ok) => { if (active < AT_ONCE) { active++; ok(); } else turns.push(() => { active++; ok(); }); });
const giveTurn = () => { active--; turns.shift()?.(); };

async function run(d: Download): Promise<void> {
  d.queued = active >= AT_ONCE; if (d.queued) changed();
  await takeTurn();
  d.queued = false; changed();
  if (d.state !== 'running') { giveTurn(); waiting.get(d.id)?.fail(new Error('cancelled')); waiting.delete(d.id); persist(); changed(); return; }
  try { await runNow(d); } finally { giveTurn(); }
}
async function runNow(d: Download): Promise<void> {
  // (In the library meanwhile: a dimmed card with the progress, or the dimmed book whose file this replaces.)
  const shown = !d.then.deviceOnly;
  const mark = () => { if (shown) setBusy({ key: `dl:${d.id}`, title: d.title, pct: d.total ? d.pct : -1, bookId: d.then.replace }); };
  const progress = (p: Progress) => {
    if (d.state !== 'running') return;
    d.got = p.got; if (p.total) d.total = p.total; d.speed = p.speed ?? d.speed; d.pct = d.total ? Math.min(100, Math.round((d.got / d.total) * 100)) : p.pct;
    mark(); changed();
  };
  mark();
  try {
    // (As a job: the service's notification on Android with the speed in it, the chip in the app, full speed
    // while the app is behind others.)
    let book: Book | null = null;
    const out = await runJob(d.title, async (report) => {
      const file = await fetchBytes(d, (p) => { progress(p); report(d.pct, describeProgress(d)); });
      if ((d.state as string) === 'cancelled') return null;
      if (d.then.deviceOnly) { const { downloadBlob } = await import('./ui/share'); downloadBlob(file, file.name); throw new Error('deviceOnly'); }
      if (d.then.replace) {
        const had = await db.getBook(d.then.replace);
        if (had) {
          await db.putFile(had.id, file);
          await db.updateBook(had.id, (b) => { b.size = file.size; });
          d.bookId = had.id; book = (await db.getBook(had.id)) ?? had;
          return { blob: file, name: file.name };
        }
      }
      const added = await importFiles([file]);
      if (!added.length) throw new Error(t('convertFailed'));
      await db.updateBook(added[0].id, (b) => { b.remote = { source: d.then.srcId, id: d.then.itemId }; if (d.then.folderId) b.folderId = d.then.folderId; if (d.then.series) b.series = d.then.series; if (d.then.tags?.length) b.tags = [...new Set([...(b.tags ?? []), ...d.then.tags])]; });
      d.bookId = added[0].id; book = added[0];
      return { blob: file, name: file.name };
    }, () => true, { quiet: true });
    if (!out || !book) { if (d.state === 'running') d.state = 'cancelled'; waiting.get(d.id)?.fail(new Error('cancelled')); }
    else { d.state = 'done'; d.pct = 100; waiting.get(d.id)?.ok(book); }
  } catch (e) {
    if ((e as Error)?.message === 'deviceOnly') { d.state = 'done'; d.pct = 100; toast(t('savedToDevice', { name: d.title }), 'info', 4000); waiting.get(d.id)?.fail(e as Error); }
    else { if (d.state === 'running') { d.state = 'failed'; d.error = String((e as Error)?.message ?? e); } waiting.get(d.id)?.fail(e as Error); }
  } finally { clearBusy(`dl:${d.id}`); waiting.delete(d.id); cancels.delete(d.id); persist(); changed(); }
}

/* ---------- the bytes ---------- */

type AndroidDl = { downloadFile(o: { id: string; url: string; name: string; headers?: Record<string, string>; persist: boolean; connections: number }): Promise<{ path: string; size: number }>; cancelDownload?(o: { id: string }): Promise<void>; deleteDownload?(o: { path: string }): Promise<unknown>; addListener?(ev: string, fn: (p: Progress & { id?: string }) => void): Promise<{ remove(): void }> };
type DesktopDl = { download?(u: string, n: string, id?: string): Promise<string>; addDownloadListener?(cb: (p: Progress & { id?: string }) => void): () => void; onDownloadProgress?(cb: (p: Progress) => void): void; readFile(p: string): Promise<ArrayBuffer>; deleteDownload?(p: string): Promise<boolean> };

/** Sites whose files the downloader was turned away from though a check had been passed: the lane only. */
const laneOnly = new Set<string>();
async function fetchBytes(d: Download, onProgress: (p: Progress) => void): Promise<File> {
  const plat = nativePlatform();
  const safe = d.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim() || 'book';
  if (plat === 'android') {
    const k = (window as unknown as { Capacitor: { Plugins: { Kurokawa: AndroidDl } } }).Capacitor.Plugins.Kurokawa;
    // (Progress from either way of fetching — the plain downloader, or the browser lane after it — under the id.)
    const sub = await k.addListener?.('downloadProgress', (p) => { if (!p.id || p.id === d.id) onProgress(p); });
    cancels.set(d.id, () => void k.cancelDownload?.({ id: d.id }).catch(() => undefined));
    try {
      // (The downloader first, over several connections — as Mihon does, with the cookies a check passed in
      // the app's browser left and the browser's own identity, so a site behind Cloudflare lets it through
      // too. Only a site that turns it away even so — it looks at the connection itself — goes through the
      // browser lane, one connection, the slow way; and is not asked the fast way again this session.)
      const host = new URL(d.url).host;
      if (!laneOnly.has(host)) {
        try {
          const { path } = await k.downloadFile({ id: d.id, url: d.url, name: `${d.id}-${safe}`, headers: d.headers, persist: false, connections: 8 });
          const file = await readContentUri(path, d.name, d.mime ?? '');
          void k.deleteDownload?.({ path }).catch(() => undefined);
          // (Looked at before it is kept: a page in the file's place, or a file cut short, is fetched again the
          // browser's way — which passes a site's check — instead of going into the library broken.)
          const bad = await fileFault(file, d.name, d.size);
          if (!bad) return file;
          if (d.state !== 'running') throw new Error('cancelled');
          const { viaBrowser } = await import('./sources/http');
          if (bad === 'page' && viaBrowser(host)) laneOnly.add(host);
        } catch (e) {
          if (d.state !== 'running' || !/HTTP (403|503|429|401)|Download failed/.test(String((e as Error)?.message ?? e))) throw e;
          const { viaBrowser } = await import('./sources/http');
          if (viaBrowser(host)) laneOnly.add(host);
        }
      }
      const { fetchBytes: lane } = await import('./sources/http');
      const bytes = await lane(d.url, onProgress, { headers: d.headers, downloadId: d.id });
      return checked(new File([bytes.buffer as ArrayBuffer], d.name, { type: d.mime ?? '' }), d);
    } finally { sub?.remove(); }
  }
  const dk = window.kurokawaDesktop as unknown as DesktopDl | undefined;
  if (plat === 'desktop' && dk?.download) {
    const off = dk.addDownloadListener?.((p) => { if (!p.id || p.id === d.id) onProgress(p); });
    try {
      const path = await dk.download(d.url, `${d.id}-${safe}`, d.id);
      const file = new File([await dk.readFile(path)], d.name, { type: d.mime ?? '' });
      void dk.deleteDownload?.(path).catch(() => false);
      if (!(await fileFault(file, d.name, d.size))) return file;
    } catch (e) { if (d.state !== 'running' || (e as Error)?.message === 'cancelled') throw e; }
    finally { off?.(); }
  }
  if (plat === 'ios') {
    const k = (window as unknown as { Capacitor: { Plugins: { Kurokawa: AndroidDl } } }).Capacitor.Plugins.Kurokawa;
    if (k.downloadFile) {
      const sub = await k.addListener?.('downloadProgress', (p) => { if (!p.id || p.id === d.id) onProgress(p); });
      cancels.set(d.id, () => void k.cancelDownload?.({ id: d.id }).catch(() => undefined));
      try {
        const { path } = await k.downloadFile({ id: d.id, url: d.url, name: `${d.id}-${safe}`, headers: d.headers, persist: false, connections: 1 });
        const file = await readContentUri(path, d.name, d.mime ?? '');
        void k.deleteDownload?.({ path }).catch(() => undefined);
        if (!(await fileFault(file, d.name, d.size))) return file;
      } catch (e) { if (d.state !== 'running' || !/HTTP (403|503|429|401)|Download failed/.test(String((e as Error)?.message ?? e))) throw e; }
      finally { sub?.remove(); }
    }
  }
  // Elsewhere (the web, or a site the downloader cannot pass): the sources' own request, in one piece.
  const { fetchBytes: plain } = await import('./sources/http');
  const bytes = await plain(d.url, onProgress, { headers: d.headers });
  return checked(new File([bytes.buffer as ArrayBuffer], d.name, { type: d.mime ?? '' }), d);
}

/** The file as it came, or the reason it cannot be kept. */
async function checked(file: File, d: Download): Promise<File> {
  const bad = await fileFault(file, d.name, d.size);
  if (bad) throw new Error(t(bad === 'page' ? 'downloadGotPage' : 'downloadCut'));
  return file;
}

/* ---------- taken up again ---------- */

/** Downloads the app was closed in the middle of: started again (the platform's downloader starts afresh —
 *  a file is a minute's work; what matters is that it arrives). Called once at start. */
export function resumeDownloads(): void {
  let saved: Omit<Download, 'got' | 'total' | 'speed' | 'pct' | 'state'>[] = [];
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { /* none */ }
  if (!saved.length) return;
  localStorage.removeItem(KEY);
  for (const s of saved) {
    if (!s.url || !s.then) continue;
    void startDownload({ url: s.url, name: s.name, mime: s.mime, size: s.size, headers: s.headers, title: s.title, then: s.then }).then(() => toast(t('downloadResumedDone', { name: s.title }), 'info', 4000)).catch(() => undefined);
  }
}
