// Cloud sync of reading state across devices: progress, bookmarks, highlights,
// notes, PDF pins and folders, merged newest-wins. One JSON file lives in the
// user's own storage — Dropbox (OAuth, PKCE), any WebDAV server (Nextcloud,
// Koofr, Box…) or, on the desktop, a folder that Google Drive / OneDrive /
// Dropbox already keep in sync. Runs at launch, when the device comes back
// online, and a minute after reading progress changes (automatically, or after
// asking — a setting).
import { db, type Book, type Folder, type TagDef, type Bookmark, type Highlight, type PdfNote, type InkStroke, type Locator, type StatsPart } from './db';
import { combineStats, emptyPart, partOf, withCounters } from './stats';
import { getSettings, updateSettings } from './settings';
import { nativePlatform } from './native';
import { t } from './i18n';
import { toast } from './ui/dom';

export type SyncProvider = 'none' | 'dropbox' | 'webdav' | 'folder';
const FILE = 'kurokawa-sync.json';

interface BookState {
  title: string; progress?: Locator; progressAt: number; lastOpenedAt?: number; bookmarks: Bookmark[]; highlights: Highlight[]; pins: PdfNote[]; ink?: InkStroke[]; pdfHighlights?: Book['pdfHighlights']; folderName?: string; tags?: string[]; tagsAt?: number; stats?: Book['stats']; done?: boolean; doneAt?: number; rating?: number; ratingAt?: number; review?: string; reviewAt?: number; track?: Book['track']; readToc?: number; readTocAt?: number; chapters?: number; chaptersAt?: number; chapterMarks?: Book['chapterMarks']; chapterMarksAt?: number;
  // (version 2; an earlier version passes them by)
  /** When the book was put in its folder or taken out (none: before this was kept). */
  folderAt?: number;
  /** The reading statistics made up by device (Book.statsSync): what came before, and each device's own. `stats`
   *  stays the whole, for an earlier version. */
  statsBase?: StatsPart; statsBy?: Record<string, StatsPart>;
  /** Set on a copy of a book's entry kept under its earlier key (file name and size) for an earlier version: the
   *  entry's own key. */
  alias?: string;
}
/** Version 2: books from an online source keyed by where they came from (`remote:<source>:<id>`), a second copy of
 *  one file by `#2`…; folders moved with a time (`folderAt`) and deleted with a tombstone (`deleted['folder:<name>']`);
 *  statistics made up by device (`statsBase`, `statsBy`). Version 1 files are read as they are. */
export const SYNC_VERSION = 2;
interface SyncState { app: 'KurokawaReader'; version: number; updatedAt: number; device: string; folders: { name: string; createdAt: number }[]; tags?: { name: string; createdAt: number }[]; books: Record<string, BookState>; deleted: Record<string, number> }

const deviceId = (): string => { let d = localStorage.getItem('kr.device'); if (!d) { d = `${nativePlatform()}-${Math.random().toString(36).slice(2, 8)}`; localStorage.setItem('kr.device', d); } return d; };

/* ---------- which entry is which book ---------- */
// A book is matched across devices by its file's name and size — except a book from an online source (a web novel,
// whose file grows with every chapter that arrives; a download whose file was fetched again), matched by its
// source and id there. Two copies of one file: the first (by when added) by the key, the next by `key#2`…
// An earlier version keyed every book by name and size: those entries are still read (and merged into the new
// one), and a copy of the entry is kept under that key for an earlier version still syncing.
const legacyKeyOf = (b: { fileName: string; size: number }) => `${b.fileName}:${b.size}`;
const baseKeyOf = (b: Book) => (b.remote?.source && b.remote.id ? `remote:${b.remote.source}:${b.remote.id}` : legacyKeyOf(b));
interface Links { keys: Map<string, { key: string; legacy?: string }>; primary: Set<string>; byName: Map<string, number> }
function linksOf(books: Book[]): Links {
  const groups = new Map<string, Book[]>();
  for (const b of books) { const k = baseKeyOf(b); groups.set(k, [...(groups.get(k) ?? []), b]); }
  const keys = new Map<string, { key: string; legacy?: string }>();
  for (const [k, list] of groups) {
    list.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    list.forEach((b, i) => keys.set(b.id, { key: i ? `${k}#${i + 1}` : k, legacy: !i && k !== legacyKeyOf(b) ? legacyKeyOf(b) : undefined }));
  }
  const primary = new Set([...keys.values()].map((x) => x.key));
  const legacyCount = new Map<string, number>(); for (const x of keys.values()) if (x.legacy) legacyCount.set(x.legacy, (legacyCount.get(x.legacy) ?? 0) + 1);
  // (A legacy key that is another book's own key, or two books': neither reads nor writes it.)
  for (const x of keys.values()) if (x.legacy && (primary.has(x.legacy) || legacyCount.get(x.legacy)! > 1)) delete x.legacy;
  const byName = new Map<string, number>();
  for (const b of books) if (keys.get(b.id)?.legacy) { const n = `${b.fileName}\u0000${b.title}`; byName.set(n, (byName.get(n) ?? 0) + 1); }
  return { keys, primary, byName };
}
/** The remote entries that are this book's: its own, and those under its earlier key (its file's name and size; for
 *  a web novel any size — chapters arrived since — with the same title, unless another of this device's books has
 *  that name and title, or the entry is another book's copy). */
function entryKeys(remote: SyncState | null, b: Book, L: Links): string[] {
  const k = L.keys.get(b.id); if (!remote || !k) return [];
  const out = [k.key];
  if (k.legacy && L.byName.get(`${b.fileName}\u0000${b.title}`) === 1) {
    for (const [rk, e] of Object.entries(remote.books ?? {})) {
      if (rk === k.key || L.primary.has(rk) || !e || (e.alias && e.alias !== k.key)) continue;
      if (rk === k.legacy) { out.push(rk); continue; }
      if (b.format !== 'webnovel') continue;
      const m = /^(.*):(\d+)$/.exec(rk);
      if (m && m[1] === b.fileName && e.title === b.title) out.push(rk);
    }
  }
  return out.filter((x) => remote.books?.[x]);
}

/* ---------- tombstones (ids removed locally, so they are not resurrected by the merge) ---------- */
export async function markDeleted(id: string): Promise<void> {
  // (In one transaction: several marked at once — ink strokes erased together — all kept.)
  const at = Date.now();
  await db.updateMeta<Record<string, number>>('sync.deleted', (cur) => ({ ...(cur ?? {}), [id]: at }));
  scheduleSync();
}
const maxTimes = (a?: Record<string, number>, b?: Record<string, number>): Record<string, number> => {
  const out = { ...(a ?? {}) }; for (const [k, v] of Object.entries(b ?? {})) if (typeof v === 'number' && !(v <= (out[k] ?? -Infinity))) out[k] = v; return out;
};
/** A folder or tag deleted after it was made. */
const goneIn = (deleted: Record<string, number>, kind: 'folder' | 'tag') => (x: { name: string; createdAt: number }) => (deleted[`${kind}:${x.name}`] ?? 0) > (x.createdAt ?? 0);

/* ---------- reading statistics: each device's own counted apart ---------- */
const maxPart = (a: StatsPart | undefined, b: StatsPart | undefined): StatsPart | undefined => (a || b ? combineStats(a, b, 'max') : undefined);
/** The remote entries' statistics merged into the book's (Book.statsSync): each device's part the larger of what
 *  is known of it, the total base + every part — so a merge done twice counts nothing twice. */
function mergeStats(x: Book, entries: BookState[], me: string, now: number): boolean {
  const before = JSON.stringify(x.stats ?? null);
  const by = new Map<string, StatsPart>();
  for (const r of entries) for (const [d, p] of Object.entries(r.statsBy ?? {})) if (p) by.set(d, combineStats(by.get(d), p, 'max'));
  let ss = x.statsSync;
  if (!ss) {
    // The first merge here: what this device had counted is its share of what came before — less what other
    // devices counted apart since (an earlier version, or a backup, may have copied that into it).
    let others: StatsPart | undefined; for (const [d, p] of by) if (d !== me) others = combineStats(others, p, 'add');
    ss = { dev: me, own: emptyPart(), base: combineStats(partOf(x.stats), others, 'sub'), by: {} };
  } else if (ss.dev !== me) {
    // (This device's id changed — its storage cleared, the database kept: what it counted is kept as the old id's.)
    ss = { ...ss, by: { ...ss.by, [ss.dev]: combineStats(ss.by[ss.dev], ss.own, 'max') }, dev: me, own: emptyPart() };
  }
  for (const r of entries) { if (r.statsBase) ss.base = combineStats(ss.base, r.statsBase, 'max'); if (r.stats) ss.floor = maxPart(ss.floor, partOf(r.stats)); }
  for (const [d, p] of by) if (d === me) ss.own = combineStats(ss.own, p, 'max'); else ss.by[d] = combineStats(ss.by[d], p, 'max');
  let sum = combineStats(ss.base, ss.own, 'add'); for (const p of Object.values(ss.by)) sum = combineStats(sum, p, 'add');
  // (Never less than an earlier version's whole, nor than what was here.)
  const next = withCounters(x.stats, combineStats(combineStats(sum, ss.floor, 'max'), partOf(x.stats), 'max'));
  for (const r of entries) {
    const at = Math.min(r.stats?.sessionAt ?? 0, now); if (at > (next.sessionAt ?? 0)) next.sessionAt = at;
    if (next.bookWords == null && r.stats?.bookWords != null) next.bookWords = r.stats.bookWords;
    if (next.bookChars == null && r.stats?.bookChars != null) next.bookChars = r.stats.bookChars;
  }
  x.statsSync = ss;
  if (!x.stats && !next.ms && !next.words && !Object.keys(next.days).length) return false;
  x.stats = next;
  return JSON.stringify(x.stats) !== before;
}

/* ---------- local state ---------- */
async function localState(remote: SyncState | null): Promise<{ state: SyncState; links: Map<string, { legacy?: string; read: string[] }> }> {
  const books = await db.allBooks(); const L = linksOf(books); const me = deviceId();
  const folders = (await db.getMeta<Folder[]>('folders')) ?? [];
  const deleted = (await db.getMeta<Record<string, number>>('sync.deleted')) ?? {};
  const out: SyncState = { app: 'KurokawaReader', version: SYNC_VERSION, updatedAt: Date.now(), device: me, folders: folders.map((f) => ({ name: f.name, createdAt: f.createdAt })), tags: (await db.getMeta<TagDef[]>('tags')) ?? [], books: {}, deleted };
  const links = new Map<string, { legacy?: string; read: string[] }>();
  for (const b of books) {
    const k = L.keys.get(b.id)!;
    links.set(k.key, { legacy: k.legacy, read: entryKeys(remote, b, L) });
    out.books[k.key] = { title: b.title, progress: b.progress, progressAt: b.progressAt ?? b.lastOpenedAt ?? 0, lastOpenedAt: b.lastOpenedAt, bookmarks: b.bookmarks, highlights: b.highlights, pins: b.pins ?? [], ink: b.ink ?? [], pdfHighlights: b.pdfHighlights ?? [], folderName: folders.find((f) => f.id === b.folderId)?.name, folderAt: b.folderAt, tags: b.tags ?? [], tagsAt: b.tagsAt, stats: b.stats, statsBase: b.statsSync?.base, statsBy: b.statsSync ? { ...b.statsSync.by, [b.statsSync.dev]: b.statsSync.own } : undefined, done: b.done, doneAt: b.doneAt, rating: b.rating, ratingAt: b.ratingAt, review: b.review, reviewAt: b.reviewAt, track: b.track, readToc: b.readToc, readTocAt: b.readTocAt, chapters: b.chapters, chaptersAt: b.chaptersAt, chapterMarks: b.chapterMarks, chapterMarksAt: b.chapterMarksAt };
  }
  return { state: out, links };
}

/** Merge remote into local storage; returns how many books changed locally. */
async function applyRemote(remote: SyncState): Promise<number> {
  const me = deviceId(); const now = Date.now();
  const books = await db.allBooks(); const L = linksOf(books);
  // (Each list read, merged and written in one transaction: a deletion marked, a folder or tag made meanwhile, kept.)
  const deleted = (await db.updateMeta<Record<string, number>>('sync.deleted', (cur) => maxTimes(cur, remote.deleted))) ?? {};
  const folderGone = goneIn(deleted, 'folder'), tagGone = goneIn(deleted, 'tag');
  // Folders: union by name; one deleted after it was made goes (and its books are in none).
  const removed = new Map<string, number>();
  const folders = (await db.updateMeta<Folder[]>('folders', (cur) => {
    const out = (cur ?? []).filter((f) => { if (!folderGone(f)) return true; removed.set(f.id, deleted[`folder:${f.name}`]); return false; });
    for (const f of remote.folders ?? []) if (f?.name && !folderGone(f) && !out.some((x) => x.name === f.name)) out.push({ id: `f-${Math.random().toString(36).slice(2, 10)}`, name: f.name, createdAt: f.createdAt });
    return out;
  })) ?? [];
  // Tags the user created (also empty ones): union by name; a deletion newer than the tag wins.
  await db.updateMeta<TagDef[]>('tags', (cur) => {
    const out = (cur ?? []).filter((tg) => !tagGone(tg));
    for (const tg of remote.tags ?? []) if (tg?.name && !tagGone(tg) && !out.some((x) => x.name === tg.name)) out.push(tg);
    return out;
  });
  let changed = 0;
  for (const b of books) {
    const entries = entryKeys(remote, b, L).map((k) => remote.books[k]);
    // (Every book's statistics made up by device from its first sync on — those of a book not yet read too.)
    if (!entries.length && b.statsSync?.dev === me && !(b.folderId && removed.has(b.folderId))) continue;
    let dirty = false;
    await db.updateBook(b.id, (x) => {
      const merge = <T extends { id: string; createdAt: number }>(mine: T[], theirs: T[]): T[] => {
        const ids = new Set(mine.map((m) => m.id));
        const add = theirs.filter((y) => !ids.has(y.id) && !deleted[y.id]);
        const keep = mine.filter((m) => !deleted[m.id] || (deleted[m.id] < m.createdAt));
        if (add.length || keep.length !== mine.length) dirty = true;
        return [...keep, ...add];
      };
      for (const r of entries) {
        x.bookmarks = merge(x.bookmarks, r.bookmarks ?? []);
        // highlights: remote note edits win when newer
        const mergedHl = merge(x.highlights, r.highlights ?? []);
        for (const rh of r.highlights ?? []) { const lh = mergedHl.find((y) => y.id === rh.id); if (lh && rh.note !== lh.note && (rh.noteAt ?? 0) > (lh.noteAt ?? 0)) { lh.note = rh.note; lh.noteAt = rh.noteAt; dirty = true; } }
        x.highlights = mergedHl;
        x.pins = merge(x.pins ?? [], r.pins ?? []);
        x.ink = merge(x.ink ?? [], r.ink ?? []);
        x.pdfHighlights = merge(x.pdfHighlights ?? [], r.pdfHighlights ?? []);
        // The position: the one stamped later. (A stamp from a device whose clock runs ahead is kept as it is: a
        // position saved here after this one is stamped after it — db.stampAfter — and so wins, here and there.)
        if (r.progress && (r.progressAt ?? 0) > (x.progressAt ?? x.lastOpenedAt ?? 0)) { x.progress = { ...r.progress, bookId: x.id }; x.progressAt = r.progressAt; dirty = true; }
        // (When it was last opened: never later than now here — it orders the history.)
        const opened = Math.min(r.lastOpenedAt ?? 0, now); if (opened > (x.lastOpenedAt ?? 0)) { x.lastOpenedAt = opened; dirty = true; }
        // The folder: the later move (into one, or out of any) wins; an entry from before moves had a time puts the
        // book in its folder only when here it is in none and was never moved.
        const rAt = r.folderAt ?? 0, xAt = x.folderAt ?? 0;
        if (rAt > xAt) {
          const f = r.folderName ? folders.find((y) => y.name === r.folderName) : undefined;
          if ((f?.id ?? undefined) !== x.folderId) { if (f) x.folderId = f.id; else delete x.folderId; dirty = true; }
          x.folderAt = rAt;
        } else if (!rAt && !xAt && r.folderName && !x.folderId) { const f = folders.find((y) => y.name === r.folderName); if (f) { x.folderId = f.id; dirty = true; } }
        if (r.track && (r.track.updatedAt ?? 0) > (x.track?.updatedAt ?? 0)) { x.track = r.track; dirty = true; }
        if ((r.readTocAt ?? 0) > (x.readTocAt ?? 0)) { x.readToc = r.readToc; x.readTocAt = r.readTocAt; dirty = true; }
        if ((r.chaptersAt ?? 0) > (x.chaptersAt ?? 0)) { x.chapters = r.chapters; x.chaptersAt = r.chaptersAt; dirty = true; }
        if ((r.chapterMarksAt ?? 0) > (x.chapterMarksAt ?? 0)) { x.chapterMarks = r.chapterMarks; x.chapterMarksAt = r.chapterMarksAt; dirty = true; }
        if ((r.reviewAt ?? 0) > (x.reviewAt ?? 0)) { if (r.review) x.review = r.review; else delete x.review; x.reviewAt = r.reviewAt; dirty = true; }
        if ((r.ratingAt ?? 0) > (x.ratingAt ?? 0)) { if (r.rating) x.rating = r.rating; else delete x.rating; x.ratingAt = r.ratingAt; dirty = true; }
        if ((r.doneAt ?? 0) > (x.doneAt ?? 0)) { if (r.done === undefined) delete x.done; else x.done = r.done; x.doneAt = r.doneAt; dirty = true; }
        if ((r.tagsAt ?? 0) > (x.tagsAt ?? 0)) { if (r.tags?.length) x.tags = [...new Set(r.tags)]; else delete x.tags; x.tagsAt = r.tagsAt; dirty = true; }
      }
      // Its folder deleted (on another device): in none.
      if (x.folderId && removed.has(x.folderId)) { x.folderAt = Math.max(x.folderAt ?? 0, removed.get(x.folderId)!); delete x.folderId; dirty = true; }
      if (mergeStats(x, entries, me, now)) dirty = true;
    });
    if (dirty) changed++;
  }
  return changed;
}

/** Two entries of one book merged (what is written to the sync file). */
function mergeEntry(l: BookState, r: BookState, deleted: Record<string, number>): BookState {
  const uniq = <T extends { id: string }>(a: T[], b: T[]) => { const seen = new Set<string>(); return [...a, ...b].filter((x) => x && !deleted[x.id] && !seen.has(x.id) && seen.add(x.id)); };
  const tags = (l.tagsAt ?? 0) >= (r.tagsAt ?? 0) ? l : r;
  const lf = l.folderAt ?? 0, rf = r.folderAt ?? 0;
  const folder = lf > rf ? { folderName: l.folderName, folderAt: l.folderAt } : rf > lf ? { folderName: r.folderName, folderAt: r.folderAt } : { folderName: l.folderName ?? r.folderName, folderAt: l.folderAt ?? r.folderAt };
  const newer = (l.stats?.sessionAt ?? 0) >= (r.stats?.sessionAt ?? 0) ? l.stats : r.stats;
  const stats = l.stats || r.stats ? { ...withCounters(newer, combineStats(partOf(l.stats), partOf(r.stats), 'max')), sessionAt: Math.max(l.stats?.sessionAt ?? 0, r.stats?.sessionAt ?? 0) || undefined } : undefined;
  let statsBy: Record<string, StatsPart> | undefined;
  for (const src of [l.statsBy, r.statsBy]) for (const [d, p] of Object.entries(src ?? {})) if (p) (statsBy ??= {})[d] = combineStats(statsBy[d], p, 'max');
  return {
    ...((l.progressAt ?? 0) >= (r.progressAt ?? 0) ? l : r),
    title: l.title,
    lastOpenedAt: Math.max(l.lastOpenedAt ?? 0, r.lastOpenedAt ?? 0) || undefined,
    bookmarks: uniq(l.bookmarks ?? [], r.bookmarks ?? []), highlights: uniq(l.highlights ?? [], r.highlights ?? []), pins: uniq(l.pins ?? [], r.pins ?? []), ink: uniq(l.ink ?? [], r.ink ?? []),
    pdfHighlights: uniq(l.pdfHighlights ?? [], r.pdfHighlights ?? []),
    ...folder,
    tags: tags.tags ?? [], tagsAt: tags.tagsAt,
    stats, statsBase: maxPart(l.statsBase, r.statsBase), statsBy,
    ...((l.doneAt ?? 0) >= (r.doneAt ?? 0) ? { done: l.done, doneAt: l.doneAt } : { done: r.done, doneAt: r.doneAt }),
    ...((l.ratingAt ?? 0) >= (r.ratingAt ?? 0) ? { rating: l.rating, ratingAt: l.ratingAt } : { rating: r.rating, ratingAt: r.ratingAt }),
    ...((l.reviewAt ?? 0) >= (r.reviewAt ?? 0) ? { review: l.review, reviewAt: l.reviewAt } : { review: r.review, reviewAt: r.reviewAt }),
    track: (l.track?.updatedAt ?? 0) >= (r.track?.updatedAt ?? 0) ? l.track : r.track,
    ...((l.readTocAt ?? 0) >= (r.readTocAt ?? 0) ? { readToc: l.readToc, readTocAt: l.readTocAt } : { readToc: r.readToc, readTocAt: r.readTocAt }),
    ...((l.chaptersAt ?? 0) >= (r.chaptersAt ?? 0) ? { chapters: l.chapters, chaptersAt: l.chaptersAt } : { chapters: r.chapters, chaptersAt: r.chaptersAt }),
    ...((l.chapterMarksAt ?? 0) >= (r.chapterMarksAt ?? 0) ? { chapterMarks: l.chapterMarks, chapterMarksAt: l.chapterMarksAt } : { chapterMarks: r.chapterMarks, chapterMarksAt: r.chapterMarksAt }),
  };
}

function mergeStates(local: SyncState, remote: SyncState | null, links: Map<string, { legacy?: string; read: string[] }>): SyncState {
  const deleted = maxTimes(remote?.deleted, local.deleted);
  const folderGone = goneIn(deleted, 'folder');
  const out: SyncState = { ...local, version: SYNC_VERSION, updatedAt: Date.now(), deleted, folders: [...local.folders], books: { ...(remote?.books ?? {}) } };
  for (const f of remote?.folders ?? []) if (f?.name && !out.folders.some((x) => x.name === f.name)) out.folders.push(f);
  out.folders = out.folders.filter((f) => !folderGone(f));
  for (const [k, l] of Object.entries(local.books)) {
    const link = links.get(k);
    let e = l;
    for (const rk of link?.read ?? []) { const r = remote?.books[rk]; if (r) e = mergeEntry(e, r, deleted); if (rk !== k) delete out.books[rk]; }
    delete e.alias;
    out.books[k] = e;
    // (A copy under the earlier key, for an earlier version still syncing: it matches books by file name and size.)
    if (link?.legacy) out.books[link.legacy] = { ...e, alias: k };
  }
  return out;
}

/* ---------- transports ---------- */
interface HttpResult { status: number; headers: Record<string, string>; body: string }
async function http(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; binary?: boolean } = {}): Promise<HttpResult> {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?(): boolean; Plugins?: { Kurokawa?: { httpRequest?(o: unknown): Promise<HttpResult> } } } }).Capacitor;
  if (cap?.isNativePlatform?.() && cap.Plugins?.Kurokawa?.httpRequest) return cap.Plugins.Kurokawa.httpRequest({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null, binary: !!init.binary });
  const desk = (window as unknown as { kurokawaDesktop?: { http?(o: unknown): Promise<HttpResult> } }).kurokawaDesktop;
  if (desk?.http) return desk.http({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null, binary: !!init.binary });
  const r = await fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body });
  const headers: Record<string, string> = {}; r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  return { status: r.status, headers, body: await r.text() };
}

/* Dropbox (PKCE) */
const DBX_AUTH = 'https://www.dropbox.com/oauth2/authorize';
const DBX_TOKEN = 'https://api.dropboxapi.com/oauth2/token';
export function dropboxRedirectUri(): string { return nativePlatform() === 'web' ? `${location.origin}${location.pathname}` : 'kurokawareader://oauth'; }
async function sha256b64url(s: string): Promise<string> { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export async function dropboxConnect(): Promise<void> {
  const key = getSettings().syncDropboxKey.trim();
  if (!key) throw new Error(t('syncNeedsAppKey'));
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(48)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 66]).join('');
  localStorage.setItem('kr.dbx.verifier', verifier);
  const url = `${DBX_AUTH}?client_id=${encodeURIComponent(key)}&response_type=code&code_challenge=${await sha256b64url(verifier)}&code_challenge_method=S256&token_access_type=offline&redirect_uri=${encodeURIComponent(dropboxRedirectUri())}`;
  window.open(url, '_blank', 'noopener');
}
/** Called with the redirect URL (web: location; native/desktop: kurokawareader://oauth?code=…). */
export async function handleOAuthRedirect(url: string): Promise<boolean> {
  // (A sign-in to وصلة الشاملة comes back the same way, told apart by its state.)
  { const m = await import('./sources/shamelalink'); if (m.isOurRedirect(url)) { const ok = await m.finishSignIn(url); if (ok) { const { toast } = await import('./ui/dom'); toast('تم تسجيل الدخول إلى وصلة الشاملة'); } return ok; } }
  const code = new URL(url.replace(/^kurokawareader:\/\//, 'https://x/')).searchParams.get('code');
  const verifier = localStorage.getItem('kr.dbx.verifier');
  if (!code || !verifier) return false;
  const body = new URLSearchParams({ code, grant_type: 'authorization_code', code_verifier: verifier, client_id: getSettings().syncDropboxKey.trim(), redirect_uri: dropboxRedirectUri() }).toString();
  const r = await http(DBX_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (r.status !== 200) throw new Error(`Dropbox ${r.status}`);
  const j = JSON.parse(r.body) as { access_token: string; refresh_token?: string; expires_in?: number };
  updateSettings({ syncDropboxRefresh: j.refresh_token ?? '', syncProvider: 'dropbox' });
  localStorage.setItem('kr.dbx.access', JSON.stringify({ token: j.access_token, exp: Date.now() + (j.expires_in ?? 14000) * 1000 }));
  localStorage.removeItem('kr.dbx.verifier');
  toast(t('syncConnected'));
  void syncNow();
  return true;
}
async function dropboxToken(): Promise<string> {
  try { const c = JSON.parse(localStorage.getItem('kr.dbx.access') ?? 'null') as { token: string; exp: number } | null; if (c && c.exp > Date.now() + 60000) return c.token; } catch { /* refresh */ }
  const refresh = getSettings().syncDropboxRefresh;
  if (!refresh) throw new Error(t('syncNotConnected'));
  const r = await http(DBX_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: getSettings().syncDropboxKey.trim() }).toString() });
  if (r.status !== 200) throw new Error(`Dropbox ${r.status}`);
  const j = JSON.parse(r.body) as { access_token: string; expires_in?: number };
  localStorage.setItem('kr.dbx.access', JSON.stringify({ token: j.access_token, exp: Date.now() + (j.expires_in ?? 14000) * 1000 }));
  return j.access_token;
}
async function dropboxRead(): Promise<SyncState | null> {
  const tok = await dropboxToken();
  const r = await http('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'Dropbox-API-Arg': JSON.stringify({ path: `/${FILE}` }) } });
  if (r.status === 409) return null; // not found
  if (r.status !== 200) throw new Error(`Dropbox ${r.status}`);
  return JSON.parse(r.body) as SyncState;
}
async function dropboxWrite(state: SyncState): Promise<void> {
  const tok = await dropboxToken();
  const r = await http('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ path: `/${FILE}`, mode: 'overwrite', mute: true }) }, body: JSON.stringify(state) });
  if (r.status !== 200) throw new Error(`Dropbox ${r.status}`);
}

/* WebDAV */
function davUrl(): string { const s = getSettings(); return `${s.syncWebdavUrl.replace(/\/+$/, '')}/${FILE}`; }
function davAuth(): Record<string, string> { const s = getSettings(); return s.syncWebdavUser ? { authorization: `Basic ${btoa(`${s.syncWebdavUser}:${s.syncWebdavPass}`)}` } : {}; }
async function davRead(): Promise<SyncState | null> { const r = await http(davUrl(), { headers: davAuth() }); if (r.status === 404) return null; if (r.status >= 400) throw new Error(`WebDAV ${r.status}`); return JSON.parse(r.body) as SyncState; }
async function davWrite(state: SyncState): Promise<void> { const r = await http(davUrl(), { method: 'PUT', headers: { ...davAuth(), 'content-type': 'application/json' }, body: JSON.stringify(state) }); if (r.status >= 400) throw new Error(`WebDAV ${r.status}`); }

/* Desktop folder (inside a Drive / OneDrive / Dropbox folder) */
const desk = () => (window as unknown as { kurokawaDesktop?: { pickFolder?(): Promise<string | null>; readTextFile?(p: string): Promise<string | null>; writeTextFile?(p: string, t: string): Promise<boolean> } }).kurokawaDesktop;
const folderFile = () => `${getSettings().syncFolder.replace(/[\\/]+$/, '')}${getSettings().syncFolder.includes('\\') ? '\\' : '/'}${FILE}`;
async function folderRead(): Promise<SyncState | null> { const txt = await desk()?.readTextFile?.(folderFile()); return txt ? (JSON.parse(txt) as SyncState) : null; }
async function folderWrite(state: SyncState): Promise<void> { await desk()?.writeTextFile?.(folderFile(), JSON.stringify(state, null, 1)); }

/* ---------- the sync itself ---------- */
let running: Promise<SyncResult> | null = null;
let timer = 0;
export interface SyncResult { ok: boolean; changed: number; error?: string; at: number }
const listeners = new Set<(r: SyncResult | 'running') => void>();
export function onSyncStatus(fn: (r: SyncResult | 'running') => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
export function syncConfigured(): boolean {
  const s = getSettings();
  return (s.syncProvider === 'dropbox' && !!s.syncDropboxRefresh) || (s.syncProvider === 'webdav' && !!s.syncWebdavUrl) || (s.syncProvider === 'folder' && !!s.syncFolder && !!desk()?.readTextFile);
}

export function syncNow(): Promise<SyncResult> {
  if (running) return running;
  running = (async (): Promise<SyncResult> => {
    listeners.forEach((f) => f('running'));
    try {
      if (!syncConfigured()) throw new Error(t('syncNotConnected'));
      if (!navigator.onLine && getSettings().syncProvider !== 'folder') throw new Error(t('offlineService'));
      const p = getSettings().syncProvider;
      const read = p === 'dropbox' ? dropboxRead : p === 'webdav' ? davRead : folderRead;
      const write = p === 'dropbox' ? dropboxWrite : p === 'webdav' ? davWrite : folderWrite;
      const remote = await read();
      // (No file yet: nothing to merge, but this device's books set up for the next — see mergeStats.)
      const changed = await applyRemote(remote ?? { app: 'KurokawaReader', version: SYNC_VERSION, updatedAt: 0, device: '', folders: [], tags: [], books: {}, deleted: {} });
      const { state, links } = await localState(remote);
      const merged = mergeStates(state, remote, links);
      await write(merged);
      const res: SyncResult = { ok: true, changed, at: Date.now() };
      updateSettings({ syncLastAt: res.at });
      localStorage.removeItem('kr.sync.pending');
      listeners.forEach((f) => f(res));
      document.dispatchEvent(new CustomEvent('kr:synced', { detail: res }));
      return res;
    } catch (err) {
      const res: SyncResult = { ok: false, changed: 0, error: String((err as Error).message ?? err), at: Date.now() };
      listeners.forEach((f) => f(res));
      return res;
    } finally { running = null; }
  })();
  return running;
}

/** Something changed locally: sync a minute later (auto) or remember that a sync is due. */
export function scheduleSync(delayMs = 60000): void {
  if (!syncConfigured()) return;
  localStorage.setItem('kr.sync.pending', '1');
  if (!getSettings().syncAuto) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => { if (navigator.onLine || getSettings().syncProvider === 'folder') void syncNow(); }, delayMs);
}

/** Launch / back-online behaviour. */
export function initSync(onAsk: () => void): void {
  const kick = () => {
    if (!syncConfigured()) return;
    if (getSettings().syncAuto) void syncNow();
    else if (localStorage.getItem('kr.sync.pending') || Date.now() - (getSettings().syncLastAt || 0) > 6 * 3600 * 1000) onAsk();
  };
  setTimeout(kick, 2500);
  window.addEventListener('online', () => setTimeout(kick, 1500));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && localStorage.getItem('kr.sync.pending') && getSettings().syncAuto) void syncNow(); });
  // OAuth redirects
  if (location.search.includes('code=') && (localStorage.getItem('kr.dbx.verifier') || localStorage.getItem('kr.shamelalink.flow'))) { void handleOAuthRedirect(location.href).then(() => history.replaceState(null, '', location.pathname + location.hash)).catch((e) => toast(String((e as Error).message ?? e), 'error')); }
}
export function disconnectSync(): void {
  updateSettings({ syncProvider: 'none', syncDropboxRefresh: '', syncLastAt: 0 });
  localStorage.removeItem('kr.dbx.access'); localStorage.removeItem('kr.sync.pending');
}
export async function pickSyncFolder(): Promise<void> { const p = await desk()?.pickFolder?.(); if (p) updateSettings({ syncFolder: p, syncProvider: 'folder' }); }

export type { Book };
