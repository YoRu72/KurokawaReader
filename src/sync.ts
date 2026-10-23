// Cloud sync of reading state across devices: progress, bookmarks, highlights,
// notes, PDF pins and folders, merged newest-wins. One JSON file lives in the
// user's own storage — Dropbox (OAuth, PKCE), any WebDAV server (Nextcloud,
// Koofr, Box…) or, on the desktop, a folder that Google Drive / OneDrive /
// Dropbox already keep in sync. Runs at launch, when the device comes back
// online, and a minute after reading progress changes (automatically, or after
// asking — a setting).
import { db, type Book, type Folder, type Bookmark, type Highlight, type PdfNote, type Locator } from './db';
import { getSettings, updateSettings } from './settings';
import { nativePlatform } from './native';
import { t } from './i18n';
import { toast } from './ui/dom';

export type SyncProvider = 'none' | 'dropbox' | 'webdav' | 'folder';
const FILE = 'kurokawa-sync.json';

interface BookState { title: string; progress?: Locator; progressAt: number; lastOpenedAt?: number; bookmarks: Bookmark[]; highlights: Highlight[]; pins: PdfNote[]; pdfHighlights?: Book['pdfHighlights']; folderName?: string; tags?: string[]; tagsAt?: number; stats?: Book['stats'] }
interface SyncState { app: 'KurokawaReader'; version: 1; updatedAt: number; device: string; folders: { name: string; createdAt: number }[]; tags?: { name: string; createdAt: number }[]; books: Record<string, BookState>; deleted: Record<string, number> }

const keyOf = (b: { fileName: string; size: number }) => `${b.fileName}:${b.size}`;
const deviceId = (): string => { let d = localStorage.getItem('kr.device'); if (!d) { d = `${nativePlatform()}-${Math.random().toString(36).slice(2, 8)}`; localStorage.setItem('kr.device', d); } return d; };

/* ---------- tombstones (ids removed locally, so they are not resurrected by the merge) ---------- */
export async function markDeleted(id: string): Promise<void> {
  const tomb = (await db.getMeta<Record<string, number>>('sync.deleted')) ?? {};
  tomb[id] = Date.now();
  await db.setMeta('sync.deleted', tomb);
  scheduleSync();
}

/* ---------- local state ---------- */
async function localState(): Promise<SyncState> {
  const books = await db.allBooks();
  const folders = (await db.getMeta<Folder[]>('folders')) ?? [];
  const deleted = (await db.getMeta<Record<string, number>>('sync.deleted')) ?? {};
  const out: SyncState = { app: 'KurokawaReader', version: 1, updatedAt: Date.now(), device: deviceId(), folders: folders.map((f) => ({ name: f.name, createdAt: f.createdAt })), tags: (await db.getMeta<{ name: string; createdAt: number }[]>('tags')) ?? [], books: {}, deleted };
  for (const b of books) out.books[keyOf(b)] = { title: b.title, progress: b.progress, progressAt: b.progressAt ?? b.lastOpenedAt ?? 0, lastOpenedAt: b.lastOpenedAt, bookmarks: b.bookmarks, highlights: b.highlights, pins: b.pins ?? [], pdfHighlights: b.pdfHighlights ?? [], folderName: folders.find((f) => f.id === b.folderId)?.name, tags: b.tags ?? [], tagsAt: b.tagsAt, stats: b.stats };
  return out;
}

/** Merge remote into local storage; returns how many books changed locally. */
async function applyRemote(remote: SyncState): Promise<number> {
  const books = await db.allBooks();
  let folders = (await db.getMeta<Folder[]>('folders')) ?? [];
  const deletedLocal = (await db.getMeta<Record<string, number>>('sync.deleted')) ?? {};
  const deleted = { ...remote.deleted, ...deletedLocal };
  for (const f of remote.folders ?? []) if (!folders.some((x) => x.name === f.name)) folders = [...folders, { id: `f-${Math.random().toString(36).slice(2, 10)}`, name: f.name, createdAt: f.createdAt }];
  await db.setMeta('folders', folders);
  await db.setMeta('sync.deleted', deleted);
  // Tags the user created (also empty ones): union by name; a deletion newer than the tag wins.
  const gone = (tg: { name: string; createdAt: number }) => (deleted[`tag:${tg.name}`] ?? 0) > tg.createdAt;
  const localTags = (await db.getMeta<{ name: string; createdAt: number }[]>('tags')) ?? [];
  const mergedTags = localTags.filter((tg) => !gone(tg));
  for (const tg of remote.tags ?? []) if (!gone(tg) && !mergedTags.some((x) => x.name === tg.name)) mergedTags.push(tg);
  if (mergedTags.length !== localTags.length || mergedTags.some((x, i) => x !== localTags[i])) await db.setMeta('tags', mergedTags);
  let changed = 0;
  for (const b of books) {
    const r = remote.books[keyOf(b)];
    if (!r) continue;
    let dirty = false;
    await db.updateBook(b.id, (x) => {
      const merge = <T extends { id: string; createdAt: number }>(mine: T[], theirs: T[]): T[] => {
        const ids = new Set(mine.map((m) => m.id));
        const add = theirs.filter((y) => !ids.has(y.id) && !deleted[y.id]);
        const keep = mine.filter((m) => !deleted[m.id] || (deleted[m.id] < m.createdAt));
        if (add.length || keep.length !== mine.length) dirty = true;
        return [...keep, ...add];
      };
      x.bookmarks = merge(x.bookmarks, r.bookmarks ?? []);
      // highlights: remote note edits win when newer
      const mergedHl = merge(x.highlights, r.highlights ?? []);
      for (const rh of r.highlights ?? []) { const lh = mergedHl.find((y) => y.id === rh.id); if (lh && rh.note !== lh.note && (rh.noteAt ?? 0) > (lh.noteAt ?? 0)) { lh.note = rh.note; lh.noteAt = rh.noteAt; dirty = true; } }
      x.highlights = mergedHl;
      x.pins = merge(x.pins ?? [], r.pins ?? []);
      x.pdfHighlights = merge(x.pdfHighlights ?? [], r.pdfHighlights ?? []);
      if (r.progress && (r.progressAt ?? 0) > (x.progressAt ?? x.lastOpenedAt ?? 0)) { x.progress = { ...r.progress, bookId: x.id }; x.progressAt = r.progressAt; x.lastOpenedAt = Math.max(x.lastOpenedAt ?? 0, r.lastOpenedAt ?? 0); dirty = true; }
      if (r.folderName && !x.folderId) { const f = folders.find((y) => y.name === r.folderName); if (f) { x.folderId = f.id; dirty = true; } }
      if ((r.tagsAt ?? 0) > (x.tagsAt ?? 0)) { if (r.tags?.length) x.tags = [...new Set(r.tags)]; else delete x.tags; x.tagsAt = r.tagsAt; dirty = true; }
      if ((r.stats?.sessionAt ?? 0) > (x.stats?.sessionAt ?? 0)) { x.stats = r.stats; dirty = true; }
    });
    if (dirty) changed++;
  }
  return changed;
}

function mergeStates(local: SyncState, remote: SyncState | null): SyncState {
  if (!remote) return local;
  const out: SyncState = { ...local, updatedAt: Date.now(), deleted: { ...remote.deleted, ...local.deleted }, folders: [...local.folders], books: { ...remote.books } };
  for (const f of remote.folders ?? []) if (!out.folders.some((x) => x.name === f.name)) out.folders.push(f);
  for (const [k, l] of Object.entries(local.books)) {
    const r = remote.books[k];
    if (!r) { out.books[k] = l; continue; }
    const uniq = <T extends { id: string }>(a: T[], b: T[]) => { const seen = new Set<string>(); return [...a, ...b].filter((x) => !out.deleted[x.id] && !seen.has(x.id) && seen.add(x.id)); };
    const tags = (l.tagsAt ?? 0) >= (r.tagsAt ?? 0) ? l : r;
    out.books[k] = {
      ...(l.progressAt >= (r.progressAt ?? 0) ? l : r),
      bookmarks: uniq(l.bookmarks, r.bookmarks ?? []), highlights: uniq(l.highlights, r.highlights ?? []), pins: uniq(l.pins, r.pins ?? []),
      pdfHighlights: uniq(l.pdfHighlights ?? [], r.pdfHighlights ?? []),
      folderName: l.folderName ?? r.folderName,
      tags: tags.tags ?? [], tagsAt: tags.tagsAt,
      stats: (l.stats?.sessionAt ?? 0) >= (r.stats?.sessionAt ?? 0) ? l.stats : r.stats,
    };
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
      const changed = remote ? await applyRemote(remote) : 0;
      const merged = mergeStates(await localState(), remote);
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
  if (location.search.includes('code=') && localStorage.getItem('kr.dbx.verifier')) { void handleOAuthRedirect(location.href).then(() => history.replaceState(null, '', location.pathname + location.hash)).catch((e) => toast(String((e as Error).message ?? e), 'error')); }
}
export function disconnectSync(): void {
  updateSettings({ syncProvider: 'none', syncDropboxRefresh: '', syncLastAt: 0 });
  localStorage.removeItem('kr.dbx.access'); localStorage.removeItem('kr.sync.pending');
}
export async function pickSyncFolder(): Promise<void> { const p = await desk()?.pickFolder?.(); if (p) updateSettings({ syncFolder: p, syncProvider: 'folder' }); }

export type { Book };
