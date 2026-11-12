// Backup & restore. A "notes" backup is a small JSON file: settings, folders, custom-font list, the glossary and
// text rules, and every book's bookmarks, highlights, notes, ink, reading position, ratings, chapter marks and links
// (keyed by file name + size so they re-attach to the same files; a book from an online source by its source and id). A "full" backup is a ZIP with that JSON plus the
// book files, covers and the books' translations (paid for, at times: kept with the books, not in the small file).
// No backup carries a credential (API keys, tokens, passwords): see scrubSettings.
import JSZip from 'jszip';
import { db, stampAfter, type Book, type Folder, type TagDef } from './db';
import { globalSettings, updateSettings, allBookSettings, setBookSettings, type VisualSettings } from './settings';
import { buttonsMigrated } from './readbuttons';
import { listFonts, type CustomFont } from './fonts';
import { shareFile } from './ui/share';
import { importFiles } from './library';
import { t } from './i18n';
import { terms as glossTerms, saveTerms, type Term, type Folder as GlossFolder } from './glossary';
import { textRules, saveTextRules, type TextRule } from './textrules';
import { whenStill } from './still';

type CustomApi = NonNullable<VisualSettings['aiCustomApis']>[number];
interface BookRecord {
  key: string; title: string; author?: string; fileName: string; size: number; format: string; folderName?: string; tags?: string[]; tagsAt?: number; done?: boolean; doneAt?: number;
  addedAt: number; lastOpenedAt?: number; progress?: Book['progress']; bookmarks: Book['bookmarks']; highlights: Book['highlights']; pins?: Book['pins']; pdfHighlights?: Book['pdfHighlights']; prefs?: Book['prefs']; stats?: Book['stats'];
  id?: string;
  // (version 2)
  progressAt?: number; ink?: Book['ink']; rating?: number; ratingAt?: number; review?: string; reviewAt?: number; readToc?: number; readTocAt?: number;
  chapterMarks?: Book['chapterMarks']; chapterMarksAt?: number; chapterStars?: Book['chapterStars']; chapters?: number; chaptersAt?: number;
  track?: Book['track']; series?: Book['series']; remote?: Book['remote']; description?: string; language?: string;
  /** The book's own settings (kr.bookVisual), its Anki progress, its audiobook place. */
  visual?: Partial<VisualSettings>; anki?: unknown; audio?: unknown;
}
interface Manifest {
  app: 'KurokawaReader'; version: number; createdAt: number; full: boolean;
  settings: VisualSettings; local: Record<string, string>; folders: Folder[]; tags?: TagDef[]; fonts: CustomFont[]; books: BookRecord[];
  // (version 2; an older app reading this file passes them by)
  /** The custom AI services without their keys and headers (kept apart from the settings: an older app restoring
   *  this file then leaves the device's own list, keys and all, as it is). */
  customApis?: CustomApi[];
  glossary?: { terms: Term[]; folders: GlossFolder[]; links: Record<string, string[]>; dest: Record<string, unknown> };
  textRules?: TextRule[]; vocab?: unknown[];
}
export const BACKUP_VERSION = 2;

const LOCAL_KEYS = ['kr.lang', 'kr.dir', 'kr.sort', 'kr.translateTo'];
const keyOf = (b: { fileName: string; size: number }) => `${b.fileName}:${b.size}`;
const readLocal = <T>(k: string, d: T): T => { try { return (JSON.parse(localStorage.getItem(k) ?? 'null') as T) ?? d; } catch { return d; } };

/* ---------- what never goes into a backup ---------- */
// A backup is shared, kept in Downloads, put in a cloud folder: it carries no credential. The device keeps its own,
// and a restore never takes one away (restoreSettings). ONE list, used by every backup (notes, full, automatic,
// the automatic ones already kept): a setting whose name looks like a credential is left out unless it is named
// here as not one — so a new key or token added to the settings cannot slip into backups unnoticed.
const SECRET_NAME = /key|token|secret|pass|auth|cookie|refresh/i;
export const NOT_SECRET = new Set<string>(['volumeKeys']);
/** Settings that are credentials though their names do not say so. */
const SECRET_SETTINGS = new Set<string>(['syncWebdavUser']);
/** Addresses that may carry a user:password@ or a ?key= — left out when they do. */
const URL_SETTINGS = ['syncWebdavUrl', 'localServer', 'aiBaseUrl'] as const;
export const isSecretSetting = (k: string): boolean => SECRET_SETTINGS.has(k) || (SECRET_NAME.test(k) && !NOT_SECRET.has(k));
/** Whether an address carries a credential (a user or password in it, a key-like query parameter). */
export function urlHasSecret(u: unknown): boolean {
  if (typeof u !== 'string' || !u) return false;
  try { const x = new URL(u); return !!(x.username || x.password) || [...x.searchParams.keys()].some((k) => SECRET_NAME.test(k) || /^(sig|signature|code)$/i.test(k)); } catch { return /\/\/[^/@\s]+@/.test(u); }
}
/** The settings as a backup keeps them: credentials, addresses carrying one and the custom services left out. */
export function scrubSettings<T extends object>(s: T): Partial<T> {
  const out = { ...s } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (isSecretSetting(k) || ((URL_SETTINGS as readonly string[]).includes(k) && urlHasSecret(out[k]))) delete out[k];
  delete out.aiCustomApis;
  return out as Partial<T>;
}
/** The custom services as a backup keeps them: no key, no headers (where services put their tokens). */
export const scrubApis = (list: unknown): CustomApi[] => (Array.isArray(list) ? (list as CustomApi[]) : []).map((a) => { const { key: _k, headers: _h, ...rest } = a; void _k; void _h; return { ...rest, key: '', base: urlHasSecret(rest.base) ? '' : rest.base }; });
/** A manifest made safe (also one an earlier version wrote, with the keys in it). */
function scrubManifest(m: Manifest): Manifest {
  const apis = m.customApis ?? (m.settings as Partial<VisualSettings>)?.aiCustomApis;
  return { ...m, settings: scrubSettings(m.settings ?? {}) as VisualSettings, customApis: scrubApis(apis), books: (m.books ?? []).map((r) => ({ ...r, ...(r.prefs ? { prefs: scrubSettings(r.prefs) } : {}), ...(r.visual ? { visual: scrubSettings(r.visual) } : {}) })) };
}

async function manifest(full: boolean): Promise<Manifest> {
  const books = await db.allBooks();
  const folders = (await db.getMeta<Folder[]>('folders')) ?? [];
  const local: Record<string, string> = {};
  for (const k of LOCAL_KEYS) { const v = localStorage.getItem(k); if (v) local[k] = v; }
  const visual = allBookSettings();
  const settings = globalSettings();
  const out: Manifest = {
    app: 'KurokawaReader', version: BACKUP_VERSION, createdAt: Date.now(), full,
    settings: settings as VisualSettings, customApis: settings.aiCustomApis, local, folders, tags: (await db.getMeta<TagDef[]>('tags')) ?? [], fonts: await listFonts(),
    glossary: { terms: readLocal<Term[]>('kr.glossary', []), folders: readLocal<GlossFolder[]>('kr.glossaryFolders', []), links: readLocal<Record<string, string[]>>('kr.glossaryLinks', {}), dest: readLocal<Record<string, unknown>>('kr.glossaryDest', {}) },
    textRules: readLocal<TextRule[]>('kr.textRules', []), vocab: readLocal<unknown[]>('kr.vocab', []),
    books: [],
  };
  for (const b of books) out.books.push({
    key: keyOf(b), id: b.id, title: b.title, author: b.author, fileName: b.fileName, size: b.size, format: b.format,
    folderName: folders.find((f) => f.id === b.folderId)?.name, tags: b.tags, tagsAt: b.tagsAt, done: b.done, doneAt: b.doneAt, addedAt: b.addedAt, lastOpenedAt: b.lastOpenedAt,
    progress: b.progress, progressAt: b.progressAt, bookmarks: b.bookmarks, highlights: b.highlights, pins: b.pins, pdfHighlights: b.pdfHighlights, ink: b.ink, prefs: b.prefs, stats: b.stats,
    rating: b.rating, ratingAt: b.ratingAt, review: b.review, reviewAt: b.reviewAt, readToc: b.readToc, readTocAt: b.readTocAt, chapterMarks: b.chapterMarks, chapterMarksAt: b.chapterMarksAt, chapterStars: b.chapterStars, chapters: b.chapters, chaptersAt: b.chaptersAt,
    track: b.track, series: b.series, remote: b.remote, description: b.description, language: b.language,
    visual: visual[b.id], anki: await db.getMeta(`anki:${b.id}`), audio: await db.getMeta(`audio:${b.id}`),
  });
  return scrubManifest(out);
}

const stamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

export async function backupNotes(): Promise<void> {
  const m = await manifest(false);
  await shareFile(new Blob([JSON.stringify(m, null, 1)], { type: 'application/json' }), `KurokawaReader-backup-${stamp()}.json`, t('backup'));
}

export async function backupFull(onProgress?: (done: number, total: number) => void): Promise<void> {
  const m = await manifest(true);
  const zip = new JSZip();
  zip.file('kurokawa-backup.json', JSON.stringify(m, null, 1));
  const books = await db.allBooks();
  let i = 0;
  for (const b of books) {
    const file = await db.getFile(b.id);
    if (file) zip.file(`books/${b.id}/${b.fileName}`, file);
    if (b.cover) zip.file(`books/${b.id}/cover`, b.cover);
    // (Its translations: made chapter by chapter, by a paid service at times — kept with the book.)
    const tr = await db.getMeta<Record<string, string>>(`tr:${b.id}`), trs = await db.getMeta<Record<string, string>>(`trs:${b.id}`);
    if ((tr && Object.keys(tr).length) || (trs && Object.keys(trs).length)) zip.file(`books/${b.id}/translations.json`, JSON.stringify({ tr: tr ?? {}, trs: trs ?? {} }));
    onProgress?.(++i, books.length);
  }
  for (const f of m.fonts) { const blob = await db.getFile(`font:${f.id}`); if (blob) zip.file(`fonts/${f.id}`, blob); }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  await shareFile(blob, `KurokawaReader-full-backup-${stamp()}.zip`, t('backup'));
}

/* ---------- automatic backups (Mihon's): the notes backup made every few days, the last few kept ---------- */
const AUTO = 'autobackup:'; const AUTO_INDEX = 'autobackup:index';
export interface AutoBackup { key: string; at: number; size: number; books: number }
export function autoBackupEvery(): number { try { return Number(localStorage.getItem('kr.autoBackup.days') ?? '1') || 0; } catch { return 1; } }
export function setAutoBackupEvery(days: number): void { try { localStorage.setItem('kr.autoBackup.days', String(days)); } catch { /* private mode */ } }
export function autoBackupKeep(): number { try { return Math.min(20, Math.max(1, Number(localStorage.getItem('kr.autoBackup.keep') ?? '5') || 5)); } catch { return 5; } }
export function setAutoBackupKeep(n: number): void { try { localStorage.setItem('kr.autoBackup.keep', String(n)); } catch { /* private mode */ } }
export async function autoBackups(): Promise<AutoBackup[]> { return ((await db.getMeta<AutoBackup[]>(AUTO_INDEX)) ?? []).sort((a, b) => b.at - a.at); }
/** One made now, the oldest beyond the number kept let go. `background` (made by itself, not asked for): its big
 *  steps — the library read, the backup written — each wait for the reader to be still (src/still.ts). */
export async function makeAutoBackup(o: { background?: boolean } = {}): Promise<AutoBackup> {
  const still = o.background ? () => whenStill() : () => Promise.resolve();
  await still();
  const m = await manifest(false);
  await still();
  const text = JSON.stringify(m);
  const e: AutoBackup = { key: `${AUTO}${m.createdAt}`, at: m.createdAt, size: text.length, books: m.books.length };
  await db.setMeta(e.key, text);
  // (The list changed in one transaction: two made at once both listed.)
  let drop: AutoBackup[] = [];
  await db.updateMeta<AutoBackup[]>(AUTO_INDEX, (cur) => { const list = [e, ...(cur ?? []).filter((x) => x.key !== e.key)].sort((a, b) => b.at - a.at); drop = list.slice(autoBackupKeep()); return list.slice(0, autoBackupKeep()); });
  for (const x of drop) await db.deleteMeta(x.key).catch(() => undefined);
  return e;
}
/** Once after the update: the automatic backups kept on the device rewritten without the keys earlier versions
 *  put in them. (Files already shared or saved elsewhere cannot be reached: those keys are to be changed.) */
export async function scrubAutoBackups(): Promise<number> {
  if (await db.getMeta('backup.scrubbed')) return 0;
  let n = 0;
  for (const e of await autoBackups()) {
    const text = await db.getMeta<string>(e.key); if (!text) continue;
    try { const clean = JSON.stringify(scrubManifest(JSON.parse(text) as Manifest)); if (clean !== text) { await db.setMeta(e.key, clean); n++; } } catch { /* not readable: left */ }
  }
  await db.setMeta('backup.scrubbed', Date.now());
  return n;
}
/** Made when the last is older than the reader's interval (called a while after the app starts). */
export async function autoBackupIfDue(): Promise<void> {
  const days = autoBackupEvery(); if (!days) return;
  const last = (await autoBackups())[0];
  if (last && Date.now() - last.at < days * 86400000 - 3600000) return;
  await whenStill();
  if (!(await db.allBooks()).length) return;
  await makeAutoBackup({ background: true });
}
/** An automatic backup as a file (to restore from, or to keep elsewhere). */
export async function autoBackupFile(e: AutoBackup): Promise<File | null> {
  let text = await db.getMeta<string>(e.key); if (!text) return null;
  // (One made before the keys were left out is handed over without them.)
  try { text = JSON.stringify(scrubManifest(JSON.parse(text) as Manifest)); } catch { /* as it is */ }
  const d = new Date(e.at); const p = (n: number) => String(n).padStart(2, '0');
  return new File([text], `KurokawaReader-auto-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`, { type: 'application/json' });
}

/** What a restore brings back (Mihon's restore options): every part unless told otherwise. */
export interface RestoreParts { settings?: boolean; reading?: boolean; books?: boolean; fonts?: boolean }

/** Restores a backup file (JSON or ZIP). Returns how many books/notes were applied. */
export async function restoreBackup(file: File, onProgress?: (msg: string) => void, parts: RestoreParts = {}): Promise<number> {
  const want = { settings: parts.settings !== false, reading: parts.reading !== false, books: parts.books !== false, fonts: parts.fonts !== false };
  let m: Manifest; let zip: JSZip | null = null;
  if (/\.zip$/i.test(file.name) || file.type.includes('zip')) {
    zip = await JSZip.loadAsync(file);
    const entry = zip.file('kurokawa-backup.json');
    if (!entry) throw new Error('manifest missing');
    m = JSON.parse(await entry.async('string')) as Manifest;
  } else m = JSON.parse(await file.text()) as Manifest;
  if (m.app !== 'KurokawaReader' || !Array.isArray(m.books)) throw new Error('not a KurokawaReader backup');

  // settings (the backup's; the device's own credentials kept)
  if (want.settings) {
    restoreSettings(m);
    for (const [k, v] of Object.entries(m.local ?? {})) if (LOCAL_KEYS.includes(k)) localStorage.setItem(k, v);
  }

  // folders: merge by name
  // (Each list read, merged and written in one transaction.)
  const folders = (await db.updateMeta<Folder[]>('folders', (cur) => { const out = [...(cur ?? [])]; for (const f of m.folders ?? []) if (!out.some((x) => x.name === f.name)) out.push({ ...f }); return out; })) ?? [];
  // tags the user created (empty ones too): merge by name
  await db.updateMeta<TagDef[]>('tags', (cur) => { const out = [...(cur ?? [])]; for (const tg of m.tags ?? []) if (!out.some((x) => x.name === tg.name)) out.push({ ...tg }); return out; });
  const folderId = (name?: string) => (name ? folders.find((f) => f.name === name)?.id : undefined);

  // fonts (full backups carry the files)
  if (zip && want.fonts && m.fonts?.length) {
    const have = await listFonts();
    const merged = [...have];
    for (const f of m.fonts) {
      const blob = await zip.file(`fonts/${f.id}`)?.async('blob');
      if (!blob || have.some((x) => x.id === f.id)) continue;
      await db.putFile(`font:${f.id}`, blob); merged.push(f);
    }
    await db.setMeta('fonts', merged);
  }

  // books
  const existing = await db.allBooks();
  const byKey = new Map(existing.map((b) => [keyOf(b), b]));
  // (A book from an online source by where it came from: a web novel's file grows with every chapter, so its
  // size — in the key — is not what it was when the backup was made.)
  const remoteKey = (r?: Book['remote']) => (r?.source && r.id ? `${r.source}\u0000${r.id}` : '');
  const byRemote = new Map(existing.filter((b) => remoteKey(b.remote)).map((b) => [remoteKey(b.remote), b]));
  const idMap = new Map<string, string>();   // the backup's book id → this device's
  let applied = 0;
  for (const rec of m.books) {
    onProgress?.(rec.title);
    let book = byRemote.get(remoteKey(rec.remote)) ?? byKey.get(rec.key);
    if (!book && zip && want.books) {
      const entry = zip.file(`books/${rec.id}/${rec.fileName}`);
      if (entry) {
        const blob = await entry.async('blob');
        const [added] = await importFiles([new File([blob], rec.fileName)]);
        if (added) { book = added; const cover = await zip.file(`books/${rec.id}/cover`)?.async('blob'); if (cover) await db.updateBook(added.id, (b) => { b.cover = cover; }); }
      }
    }
    if (!book) continue;
    if (rec.id) idMap.set(rec.id, book.id);
    if (!want.reading) { applied++; continue; }
    await db.updateBook(book.id, (b) => applyRecord(b, rec, folderId(rec.folderName)));
    await restoreBookExtras(book.id, rec, zip);
    applied++;
  }
  if (want.reading) restoreShared(m, idMap);
  return applied;
}

/* ---------- how a restore meets what the device has ----------
 * Restoring is the reader's own choice, so the backup is taken — but nothing the reader made on this device is
 * lost to it:
 *  - notes, highlights, bookmarks, PDF notes and highlights, ink, chapter stars, glossary terms and folders, text
 *    rules, kept words, translations: MERGED (by id; on the same id the device's kept; nothing local deleted);
 *  - the reading position: the one saved LATER (progressAt; a backup from before it was kept goes by when the book
 *    was last opened), and the backup's when the device's is still at the very start or has no time;
 *  - rating, review, chapters read, chapter count, done, AniList entry, reading stats: the one changed LATER (their
 *    own times);
 *  - tags: the union; folder: the backup's when the book is in none;
 *  - where a book came from (a web novel's source, its series), description, language: the device's when it has
 *    them, else the backup's;
 *  - settings, the book's own settings, glossary destinations: the BACKUP's (what restoring them means) — except
 *    credentials (keys, tokens, passwords, addresses carrying them), which stay the device's;
 *  - Anki progress, audiobook place: the device's when it has them, else the backup's. */
function restoreSettings(m: Manifest): void {
  const cur = globalSettings() as unknown as Record<string, unknown>;
  const inc = { ...(m.settings ?? {}) } as Record<string, unknown>;
  const apisIn = (m.customApis ?? inc.aiCustomApis ?? []) as CustomApi[];   // (version 1 kept them in the settings, keys and all)
  delete inc.aiCustomApis;
  for (const k of Object.keys(inc)) {
    const secret = isSecretSetting(k) || (URL_SETTINGS as readonly string[]).includes(k) && (urlHasSecret(cur[k]) || urlHasSecret(inc[k]));
    // (A credential: the device's kept; the backup's — only an old backup has one — where the device has none.)
    if (secret && (cur[k] || !inc[k])) delete inc[k];
  }
  // The custom services: the device's kept as they are (keys and all); the backup's it lacks added.
  const mine = (cur.aiCustomApis ?? []) as CustomApi[];
  const apis = [...mine, ...apisIn.filter((a) => a?.id && !mine.some((x) => x.id === a.id)).map((a) => ({ ...a, key: a.key ?? '' }))];
  // (A backup from before the reader's buttons could be placed: its toolbar's buttons, placed — src/readbuttons.ts.)
  updateSettings({ ...buttonsMigrated(inc as Partial<VisualSettings>), ...(apis.length || mine.length ? { aiCustomApis: apis } : {}) });
}

const mergeById = <T extends { id: string }>(local: T[] | undefined, inc: T[] | undefined): T[] => { const ids = new Set((local ?? []).map((x) => x.id)); return [...(local ?? []), ...(inc ?? []).filter((x) => x && !ids.has(x.id))]; };
const later = (incAt: number | undefined, localAt: number | undefined, localHas: boolean) => incAt !== undefined && (!localHas || incAt > (localAt ?? 0));

function applyRecord(b: Book, rec: BookRecord, fid: string | undefined): void {
  // (A bookmark's place names its book: the backup's id turned into this device's.)
  b.bookmarks = mergeById(b.bookmarks, (rec.bookmarks ?? []).map((x) => (x?.locator && x.locator.bookId === rec.id ? { ...x, locator: { ...x.locator, bookId: b.id } } : x)));
  b.highlights = mergeById(b.highlights, rec.highlights);
  b.pins = mergeById(b.pins, rec.pins);
  b.pdfHighlights = mergeById(b.pdfHighlights, rec.pdfHighlights);
  if (rec.ink?.length) b.ink = mergeById(b.ink, rec.ink);
  if (rec.chapterStars) b.chapterStars = { ...rec.chapterStars, ...b.chapterStars };
  // The position: the later saved; the backup's against one at the very start or with no time.
  const incAt = rec.progressAt ?? rec.lastOpenedAt ?? 0;
  const atStart = !b.progress || (!b.progress.pct && !b.progress.block && !(b.progress.page && b.progress.page > 1) && !b.progress.chapter);
  if (rec.progress && (atStart || !b.progressAt || incAt > b.progressAt)) { b.progress = { ...rec.progress, bookId: b.id }; b.progressAt = incAt || Date.now(); }
  if ((rec.lastOpenedAt ?? 0) > (b.lastOpenedAt ?? 0)) b.lastOpenedAt = rec.lastOpenedAt;
  if (rec.prefs) b.prefs = { ...b.prefs, ...rec.prefs };
  if (rec.stats && (rec.stats.sessionAt ?? 0) > (b.stats?.sessionAt ?? 0)) b.stats = rec.stats;
  if (fid && !b.folderId) { b.folderId = fid; b.folderAt = stampAfter(b.folderAt); }
  if (rec.tags?.length) { b.tags = [...new Set([...(b.tags ?? []), ...rec.tags])]; b.tagsAt = Date.now(); }
  if (rec.done !== undefined && (rec.doneAt ?? 0) > (b.doneAt ?? 0)) { b.done = rec.done; b.doneAt = rec.doneAt; }
  if (rec.rating !== undefined && later(rec.ratingAt, b.ratingAt, b.rating !== undefined)) { b.rating = rec.rating; b.ratingAt = rec.ratingAt; }
  if (rec.review !== undefined && later(rec.reviewAt, b.reviewAt, b.review !== undefined)) { b.review = rec.review; b.reviewAt = rec.reviewAt; }
  if (rec.readToc !== undefined && later(rec.readTocAt, b.readTocAt, b.readToc !== undefined)) { b.readToc = rec.readToc; b.readTocAt = rec.readTocAt; }
  if (rec.chapterMarks && later(rec.chapterMarksAt, b.chapterMarksAt, !!b.chapterMarks)) { b.chapterMarks = rec.chapterMarks; b.chapterMarksAt = rec.chapterMarksAt; }
  if (rec.chapters !== undefined && later(rec.chaptersAt, b.chaptersAt, b.chapters !== undefined)) { b.chapters = rec.chapters; b.chaptersAt = rec.chaptersAt; }
  if (rec.track && (!b.track || (rec.track.updatedAt ?? 0) > (b.track.updatedAt ?? 0))) b.track = rec.track;
  if (rec.remote && !b.remote) b.remote = rec.remote;
  if (rec.series && !b.series) b.series = rec.series;
  if (rec.description && !b.description) b.description = rec.description;
  if (rec.language && !b.language) b.language = rec.language;
}

async function restoreBookExtras(id: string, rec: BookRecord, zip: JSZip | null): Promise<void> {
  if (rec.visual) setBookSettings(id, { ...(allBookSettings()[id] ?? {}), ...scrubSettings(rec.visual) });
  if (rec.anki) await db.updateMeta(`anki:${id}`, (cur) => cur ?? rec.anki);
  if (rec.audio) await db.updateMeta(`audio:${id}`, (cur) => cur ?? rec.audio);
  const tr = rec.id ? await zip?.file(`books/${rec.id}/translations.json`)?.async('string') : undefined;
  if (tr) {
    try {
      const got = JSON.parse(tr) as { tr?: Record<string, string>; trs?: Record<string, string> };
      for (const k of ['tr', 'trs'] as const) if (got[k] && Object.keys(got[k]!).length) await db.updateMeta<Record<string, string>>(`${k}:${id}`, (cur) => ({ ...got[k], ...(cur ?? {}) }));
    } catch { /* left out */ }
  }
}

/** The glossary, text rules and kept words: merged, the books' ids turned into this device's. */
function restoreShared(m: Manifest, idMap: Map<string, string>): void {
  const id = (x?: string) => (x ? idMap.get(x) ?? x : x);
  const g = m.glossary;
  if (g) {
    if (g.terms?.length) {
      const local = readLocal<Term[]>('kr.glossary', []); const have = new Set(local.map((x) => x.id));
      // (The backup's first, the device's after: on the same name in the same place the device's is kept.)
      const inc = g.terms.filter((x) => x && !have.has(x.id)).map((x) => (x.book ? { ...x, book: id(x.book) } : x));
      if (inc.length) saveTerms([...inc, ...glossTerms()]);
    }
    if (g.folders?.length) { const f = readLocal<GlossFolder[]>('kr.glossaryFolders', []); const add = g.folders.filter((x) => x && !f.some((y) => y.id === x.id)); if (add.length) localStorage.setItem('kr.glossaryFolders', JSON.stringify([...f, ...add])); }
    if (g.links && Object.keys(g.links).length) { const l = readLocal<Record<string, string[]>>('kr.glossaryLinks', {}); for (const [k, v] of Object.entries(g.links)) { const b = id(k)!; l[b] = [...new Set([...(l[b] ?? []), ...(v ?? [])])]; } localStorage.setItem('kr.glossaryLinks', JSON.stringify(l)); }
    if (g.dest && Object.keys(g.dest).length) { const d = readLocal<Record<string, unknown>>('kr.glossaryDest', {}); for (const [k, v] of Object.entries(g.dest)) d[id(k)!] = v; localStorage.setItem('kr.glossaryDest', JSON.stringify(d)); }
  }
  if (m.textRules?.length) {
    const inc = m.textRules.filter((r) => r && typeof r.find === 'string').map((r) => (r.book ? { ...r, book: id(r.book) } : r));
    const add = inc.filter((r) => !textRules().some((x) => x.id === r.id)); if (add.length) saveTextRules([...textRules(), ...add]);
  }
  if (Array.isArray(m.vocab) && m.vocab.length) {
    const local = readLocal<{ w: string; at: number }[]>('kr.vocab', []); const k = (x: { w: string; at: number }) => `${x.w}\u0000${x.at}`; const have = new Set(local.map(k));
    const add = (m.vocab as { w: string; at: number; book?: string }[]).filter((x) => x?.w && !have.has(k(x))).map((x) => (x.book ? { ...x, book: id(x.book) } : x));
    if (add.length) localStorage.setItem('kr.vocab', JSON.stringify([...local, ...add].sort((a, b) => a.at - b.at).slice(-3000)));
  }
}
