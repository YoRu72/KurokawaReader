// What is new at the sources: chapters that arrived for the novels of the library, and newer versions of the
// extensions in the repos. Checked when the app starts or comes back (not more than every few hours), and
// on demand from the bell in Sources; the result is kept, shown as a count on the bell and a mark on the
// book, and told once as a notification of the system's.
import { db, type Book } from '../db';
import { pool } from './http';
import { listRepos, refreshRepo, extensionUpdates, autoUpdateExtensions, type Repo, type ExtItem } from './repos';
import { checkNovel } from './ext/source';
import { t, countChapters, countNovels, countVolumes, countSeries } from '../i18n';

export interface UpdateReport {
  at: number;
  chapters: { bookId: string; title: string; n: number }[];      // this check's new chapters
  extensions: { repoKey: string; repoName: string; pluginId: string; name: string; from: string; to: string; done?: boolean }[];
  /** New volumes in the web folders, for the series the reader follows (has a volume of in the library). */
  volumes?: { repoKey: string; repoName: string; series: string; name: string; n: number }[];
  /** What could not be asked, and why: the book or source, to ask it again on its own. */
  failed: { title: string; error: string; bookId?: string; repoKey?: string }[];
}
const META = 'sources:updates';
const EVERY = 6 * 3600000;
/** How often the checks run by themselves, in hours (0: never) — the reader's choice, 6 by default. */
export function checkEvery(): number {
  try {
    if (localStorage.getItem('kr.sources.autoCheck') === 'off') return 0;
    const v = Number(localStorage.getItem('kr.updates.every') ?? 6); return [0, 1, 3, 6, 12, 24].includes(v) ? v : 6;
  } catch { return 6; }
}
export function setCheckEvery(h: number): void { try { localStorage.setItem('kr.updates.every', String(h)); localStorage.setItem('kr.sources.autoCheck', h ? 'on' : 'off'); } catch { /* private mode */ } }
let running: Promise<UpdateReport> | null = null;
const listeners = new Set<() => void>();
export function onUpdatesChanged(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
const emit = () => { for (const fn of listeners) fn(); };

/** The reader's choices for the checks (kept in localStorage: kr.updates.*). */
export function updatePrefs(): { wifiOnly: boolean; onlyOngoing: boolean; autoFetch: boolean } {
  const g = (k: string) => { try { return localStorage.getItem(`kr.updates.${k}`) === 'on'; } catch { return false; } };
  return { wifiOnly: g('wifiOnly'), onlyOngoing: g('onlyOngoing'), autoFetch: g('autoFetch') };
}
export function setUpdatePref(k: 'wifiOnly' | 'onlyOngoing' | 'autoFetch', on: boolean): void { try { localStorage.setItem(`kr.updates.${k}`, on ? 'on' : 'off'); } catch { /* private mode */ } }

export async function lastReport(): Promise<UpdateReport | null> { return (await db.getMeta<UpdateReport>(META)) ?? null; }
export function isChecking(): boolean { return !!running; }

/** The novels of the library that came from an extension and still have a site to ask. */
export async function trackedNovels(): Promise<Book[]> {
  return (await db.allBooks()).filter((b) => b.format === 'webnovel' && b.remote?.source);
}

/** What is waiting to be seen: chapters not yet opened (summed over the books) and extension updates. */
export async function pendingCounts(): Promise<{ chapters: number; books: number; extensions: number; series: number }> {
  const books = (await trackedNovels()).filter((b) => (b.remote?.newChapters ?? 0) > 0);
  const ext = await extensionUpdates().catch(() => []);
  return { chapters: books.reduce((n, b) => n + (b.remote?.newChapters ?? 0), 0), books: books.length, extensions: ext.length, series: (await folderNews()).length };
}
/** The series with new volumes in every web folder, newest first. */
export async function folderNews(): Promise<{ repoKey: string; repoName: string; series: string; name: string; n: number; at: number; names: string[] }[]> {
  const out: { repoKey: string; repoName: string; series: string; name: string; n: number; at: number; names: string[] }[] = [];
  const { newsOf } = await import('./folder');
  for (const r of await listRepos().catch(() => [] as Repo[])) {
    if (r.kind !== 'folder') continue;
    for (const [series, v] of Object.entries(await newsOf(r))) out.push({ repoKey: r.key, repoName: r.name, series, name: (() => { try { return decodeURIComponent(series).replace(/^!+\s*/, ''); } catch { return series; } })(), n: v.n, at: v.at, names: v.names });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Ask every source: the novels' sites for chapters, the repos for versions. One check at a time. */
export function checkAll(opts: { quiet?: boolean; onProgress?: (done: number, total: number, title: string) => void; notify?: boolean; force?: boolean } = {}): Promise<UpdateReport> {
  if (running) return running;
  running = (async () => {
    const report: UpdateReport = { at: Date.now(), chapters: [], extensions: [], volumes: [], failed: [] };
    // (The reader's restrictions, as Mihon and Shosetsu offer them: a check of its own accord waits for Wi-Fi
    // when asked; finished novels can be left out; new chapters can be fetched as soon as they are found.)
    const pref = updatePrefs();
    const cellular = (() => { const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection; return !!(c?.type === 'cellular' || c?.saveData); })();
    let novels = opts.force || !pref.wifiOnly || !cellular ? await trackedNovels() : [];
    if (pref.onlyOngoing) {
      const { readNovelFile } = await import('./ext/source');
      const keep: Book[] = [];
      for (const b of novels) { const f = await readNovelFile(b.id).catch(() => null); if (!f?.status || !/^(completed|finished|complete|ended|مكتمل|منته)/i.test(f.status.trim())) keep.push(b); }
      novels = keep;
    }
    let done = 0;
    await pool(novels, 2, async (b) => {
      opts.onProgress?.(done, novels.length, b.title);
      try {
        const n = await checkNovel(b, opts.quiet !== false);
        if (n > 0) {
          report.chapters.push({ bookId: b.id, title: b.title, n });
          if (pref.autoFetch && !(pref.wifiOnly && cellular)) {
            const { readNovelFile, downloadNovel } = await import('./ext/source');
            const f = await readNovelFile(b.id); const fresh = new Set((f?.chapters ?? []).slice(-n).map((c) => c.path));
            await downloadNovel(b, () => undefined, undefined, fresh).catch(() => false);
          }
        }
      }
      catch (e) { report.failed.push({ title: b.title, error: String((e as Error).message ?? e), bookId: b.id }); }
      opts.onProgress?.(++done, novels.length, b.title);
    });
    // The repos: their indexes again (an hour old at least), then the versions against what is on the device.
    // The web folders an h5ai server keeps: their index made again (one request each), the new volumes of
    // the series followed told.
    const { refreshIndex } = await import('./folder');
    for (const repo of await listRepos()) {
      if (repo.kind !== 'folder' || repo.flavor !== 'h5ai') continue;
      try { for (const v of await refreshIndex(repo, opts.force ? 0 : EVERY)) report.volumes!.push({ repoKey: repo.key, repoName: repo.name, ...v }); }
      catch (e) { report.failed.push({ title: repo.name, error: String((e as Error).message ?? e), repoKey: repo.key }); }
    }
    for (const repo of await listRepos()) {
      if (repo.kind === 'folder') continue;
      if (!opts.force && repo.fetchedAt && Date.now() - repo.fetchedAt < 3600000) continue;
      try { await refreshRepo(repo.key); } catch (e) { report.failed.push({ title: repo.name, error: String((e as Error).message ?? e), repoKey: repo.key }); }
    }
    // (Extensions update by themselves unless the reader turned that off; the rest wait for a tap.)
    const auto = await autoUpdateExtensions().catch(() => [] as { repo: Repo; item: ExtItem; from: string }[]);
    for (const u of auto) report.extensions.push({ repoKey: u.repo.key, repoName: u.repo.name, pluginId: u.item.id, name: u.item.name, from: u.from, to: u.item.version, done: true });
    for (const u of await extensionUpdates().catch(() => [] as { repo: Repo; item: ExtItem; from: string }[])) report.extensions.push({ repoKey: u.repo.key, repoName: u.repo.name, pluginId: u.item.id, name: u.item.name, from: u.from, to: u.item.version });
    await db.setMeta(META, report);
    localStorage.setItem('kr.sources.checkedAt', String(report.at));
    emit();
    if (opts.notify !== false && (report.chapters.length || report.extensions.length || report.volumes?.length)) await announce(report).catch(() => undefined);
    return report;
  })();
  running.finally(() => { running = null; });
  return running;
}

/** A notification of the system's, when there is something new (and the platform allows one). */
async function announce(r: UpdateReport): Promise<void> {
  const seen = (await db.getMeta<{ key: string }>('sources:announced'))?.key;
  const key = JSON.stringify([r.chapters.map((c) => `${c.bookId}:${c.n}`), r.extensions.map((e) => `${e.pluginId}:${e.to}`), (r.volumes ?? []).map((v) => `${v.series}:${v.n}`)]);
  if (seen === key) return;
  await db.setMeta('sources:announced', { key });
  const total = r.chapters.reduce((n, c) => n + c.n, 0);
  const lines: string[] = [];
  if (r.chapters.length === 1) lines.push(t('notifyChaptersOne', { title: r.chapters[0].title, n: countChapters(r.chapters[0].n) }));
  else if (r.chapters.length) lines.push(t('notifyChaptersMany', { n: countChapters(total), books: countNovels(r.chapters.length) }));
  const vols = r.volumes ?? [];
  if (vols.length === 1) lines.push(t('notifyVolumesOne', { series: vols[0].name, n: countVolumes(vols[0].n) }));
  else if (vols.length) lines.push(t('notifyVolumesMany', { n: countVolumes(vols.reduce((n, v) => n + v.n, 0)), series: countSeries(vols.length) }));
  if (r.extensions.length) lines.push(t('notifyExtensions', { n: r.extensions.length }));
  const title = r.chapters.length ? t('notifyTitleChapters') : vols.length ? t('notifyTitleVolumes') : t('notifyTitleExtensions');
  const body = lines.join(' · ');
  const hash = r.chapters.length === 1 ? `/read/${r.chapters[0].bookId}` : !r.chapters.length && vols.length === 1 ? `/sources/dir:${vols[0].repoKey}?shelf=${encodeURIComponent(vols[0].series)}` : '/sources';
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?(): boolean; Plugins?: { Kurokawa?: { notify?(o: { id: number; title: string; body: string; hash: string }): Promise<unknown> } } } }).Capacitor;
  if (cap?.isNativePlatform?.() && cap.Plugins?.Kurokawa?.notify) { await cap.Plugins.Kurokawa.notify({ id: 7100, title, body, hash }); return; }
  const desk = (window as unknown as { kurokawaDesktop?: { notify?(o: { title: string; body: string; hash: string }): Promise<unknown> } }).kurokawaDesktop;
  if (desk?.notify) { await desk.notify({ title, body, hash }); return; }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    const n = new Notification(title, { body, tag: 'kr-updates' });
    n.onclick = () => { window.focus(); location.hash = hash; };
  }
}

/** Ask for the web's notification permission (the apps ask on their own the first time). */
export async function askNotifyPermission(): Promise<boolean> {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?(): boolean; Plugins?: { Kurokawa?: { notifyPermission?(o: { ask: boolean }): Promise<{ granted: boolean }> } } } }).Capacitor;
  if (cap?.isNativePlatform?.() && cap.Plugins?.Kurokawa?.notifyPermission) return (await cap.Plugins.Kurokawa.notifyPermission({ ask: true })).granted;
  if ((window as unknown as { kurokawaDesktop?: unknown }).kurokawaDesktop) return true;
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

/** Checks on their own: a while after the app starts, and when it comes back to the front, when the last
 *  check is old enough — only when there is something to check and the device is online. */
export function scheduleUpdateChecks(): void {
  const due = () => { const h = checkEvery(); return h > 0 && Date.now() - Number(localStorage.getItem('kr.sources.checkedAt') ?? 0) > h * 3600000; };
  const maybe = async () => {
    if (!due() || navigator.onLine === false) return;
    const repos = await listRepos().catch(() => []); if (!repos.length) return;
    const novels = await trackedNovels().catch(() => []);
    if (!novels.length && !repos.some((r) => r.items.some((i) => i.runnable) || (r.kind === 'folder' && r.flavor === 'h5ai'))) return;
    void checkAll({ quiet: true }).catch(() => undefined);
  };
  setTimeout(() => void maybe(), 25000);
  // (And while the app stays open: looked at every half hour, checked when the time has come.)
  setInterval(() => { if (document.visibilityState === 'visible') void maybe(); }, 30 * 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(() => void maybe(), 3000); });
}

/** One thing that could not be checked, asked again: a novel's site, or a source's index. Resolves to what was
 *  learnt (new chapters, volumes); the report keeps it, or the failure again with its new reason. */
export async function retryFailed(i: number): Promise<number> {
  const rep = await lastReport(); const f = rep?.failed[i]; if (!rep || !f) return 0;
  let found = 0;
  try {
    if (f.bookId) { const b = await db.getBook(f.bookId); if (b) { found = await checkNovel(b, false); if (found) rep.chapters.push({ bookId: b.id, title: b.title, n: found }); } }
    else if (f.repoKey) {
      const repo = (await listRepos()).find((r) => r.key === f.repoKey);
      if (repo?.kind === 'folder') { const { refreshIndex } = await import('./folder'); const vs = await refreshIndex(repo, 0); for (const v of vs) (rep.volumes ??= []).push({ repoKey: repo.key, repoName: repo.name, ...v }); found = vs.length; }
      else if (repo) await refreshRepo(repo.key);
    }
    rep.failed.splice(i, 1);
  } catch (e) { f.error = String((e as Error).message ?? e); await db.setMeta(META, rep); emit(); throw e; }
  await db.setMeta(META, rep); emit();
  return found;
}
/** A novel's new chapters marked seen (as opening it does). */
export async function dismissChapters(bookId: string): Promise<void> { await db.updateBook(bookId, (b) => { if (b.remote) b.remote.newChapters = 0; }); emit(); }
/** A series' new volumes marked seen (as opening its page does). */
export async function dismissVolumes(repoKey: string, series: string): Promise<void> { const { seenSeries } = await import('./folder'); await seenSeries(repoKey, series); emit(); }
