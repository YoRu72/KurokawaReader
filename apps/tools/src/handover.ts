// The hand-over between the computer's two builds (Tools' stage P9; desktop-tauri/PORTING.md «P9 — the hand-over»): the
// last Electron build writes everything the person keeps in this app — every localStorage key (settings, the anime /
// TV / video lists and watch progress, the player's memory and subtitle choices, follows, notes, the Files page's
// bookmarks, add-on choices, sign-ins and keys), the app's database (add-on manifests and versions, kept files —
// add-ons, fonts, providers —, saved subtitle translations, the history), this shell's own files and the download
// engine's state — into a folder on the computer before the Rust (Tauri) build is installed; the Rust build, whose
// web view starts with an empty profile, puts the engine's files in place before its engine first starts
// (src-tauri/src/handover.rs engine_prestart) and brings the rest back here on its first start. Nothing is deleted
// from the old data folder, and the hand-over folder goes only when the person asks (after a restore that worked).
// The Reader's src/handover.ts (stage R6a) is the model: the same folder, marker and checks; Tools keeps no books.
//
// The folder (desktop/handover.cjs writes it; desktop-tauri/src-tauri/src/handover.rs finds and reads it):
//   handover/local.json          every localStorage key but the hand-over's own and a downloaded update's path
//   handover/idb.jsonl           every record of the database, one per line: { store, key, value }
//   handover/files.json          the database's kept files (store «files»), by the key they are kept under
//   files/<n>, blobs/<n>         those files, and pictures or bytes inside records
//   engine/…                     aria2's session, notes on each download, engine settings, DHT, video jobs, moving.json
//   shell/…                      the Electron shell's own files: the icon, window states, the screen translator's
//   marker.json                  written last, by the shell: each file's size and SHA-256
// Unlike the settings backup the person shares (src/backup.ts leaves keys and tokens out), a hand-over keeps the
// sign-ins and keys: it never leaves this computer and its user's own data folder.

/* ---------- the shells' halves (desktop/preload.cjs, desktop-tauri/handover-bridge.js) ---------- */
export interface MarkerFile { rel: string; size: number; sha256: string }
export interface Counts { local: number; records: number; files: number; history: number; addons: number; downloads: number; moving: number; videos: number; lists: number; bytes: number }
export interface Marker { app: string; kind: 'handover'; format: number; id: string; createdAt: number; from?: { shell?: string; version?: string; platform?: string; portable?: boolean; userData?: string }; counts?: Partial<Counts>; bytes: number; files: MarkerFile[] }
/** What became of the engine's files at the Rust build's first start (handover.rs engine_prestart). */
export interface EngineNote { id: string; state: 'carried' | 'kept-own' | 'damaged' | 'error'; downloads?: number; moving?: number; videos?: number; fonts?: number; why?: string }
export interface Found { found: boolean; dir?: string; marker?: Marker; state?: { id: string; state: string; at: number } | null; engine?: EngineNote | null; dataDir?: string | null; problems?: string[]; looked?: string[]; /** none found: the earlier (Electron) copy's data still in its data folder, its program still installed */ electron?: { library: boolean; program: boolean } }
export interface HandoverApi {
  shell: 'electron' | 'tauri';
  // the writing half (the Electron build)
  begin?(o: { need: number; unknownOk?: boolean }): Promise<{ ok: boolean; reason?: string; free?: number; need?: number; profile?: number; part?: string }>;
  write?(rel: string, data: Uint8Array, append: boolean): Promise<{ size: number }>;
  shellFiles?(): Promise<{ rel: string; size: number }[]>;
  engineFiles?(): Promise<{ files: { rel: string; size: number }[]; moving: number; saved: boolean | null }>;
  readPart?(rel: string): Promise<ArrayBuffer>;
  verify?(list: { rel: string; size: number }[]): Promise<{ ok: boolean; bad?: string[]; files?: number; bytes?: number }>;
  finish?(info: { counts: Counts }): Promise<{ ok: boolean; dir?: string; id?: string; bytes?: number; files?: number }>;
  abort?(): Promise<boolean>;
  status?(): Promise<{ dir: string; marker: Marker } | null>;
  switchInfo?(o?: { beta?: boolean }): Promise<{ version: string; name: string; size: number; page: string; portable: boolean; os: string } | null>;
  // the reading half (the Rust build)
  find?(dir?: string): Promise<Found>;
  verifyDir?(dir: string): Promise<{ ok: boolean; bad?: string[] }>;
  read?(dir: string, rel: string): Promise<ArrayBuffer>;
  readRange?(dir: string, rel: string, at: number, len: number): Promise<ArrayBuffer>;
  mark?(o: { id: string; state: 'restored' | 'declined'; counts?: Partial<Counts> }): Promise<boolean>;
  free?(dir: string): Promise<{ freed: number }>;
  openOld?(): Promise<boolean>;
}
/** The piece a large file of a hand-over is brought in (8 MiB), as the Electron build wrote it. */
export const HANDOVER_PIECE = 8 * 1024 * 1024;
export const handoverApi = (): HandoverApi | undefined => (window as unknown as { kurokawaHandover?: HandoverApi }).kurokawaHandover;

/** Kept in localStorage: the hand-over brought back here (its id), and one under way (a broken-off restore is taken
 *  up again, as a copy into an empty profile, the next time). Neither crosses. */
export const DONE_KEY = 'kt.handover.done'; export const PROGRESS_KEY = 'kt.handover.progress';
/** localStorage keys that do not cross: the hand-over's own state, the switch's «not now», an update installer this
 *  build downloaded (a path in the old build's temp folder). */
export const localSkipped = (k: string): boolean => k.startsWith('kt.handover.') || k.startsWith('kt.rustSwitch.') || k === 'kt.update.file';
/** The lists a person keeps (a profile with any of them is not empty: a hand-over then merges). */
const LISTS = ['kt.anime.listStatus', 'kt.anime.diary', 'kt.tv.watchlist', 'kt.tv.seen', 'kt.follows', 'kt.notes', 'kt.files.bookmarks', 'kt.courses', 'kt.player.memory', 'kt.watchedTasks', 'kt.trackers', 'kt.grab.projects'];

/* ---------- the database, read whole ---------- */
const DB_NAME = 'kurokawa-tools';
const STORES = ['meta', 'files', 'history'] as const;
type Store = typeof STORES[number];
async function rawDb(): Promise<IDBDatabase> {
  const { db } = await import('./db');
  await db.getMeta('__open__').catch(() => undefined);   // (db.ts opens — and on a new profile makes — the database at its own version first)
  return new Promise((resolve, reject) => { const r = indexedDB.open(DB_NAME); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function req<T>(d: IDBDatabase, store: string, fn: (s: IDBObjectStore) => IDBRequest, mode: IDBTransactionMode = 'readonly'): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!d.objectStoreNames.contains(store)) { resolve(undefined as T); return; }
    const t = d.transaction(store, mode); const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result as T); r.onerror = () => reject(r.error);
  });
}
const keysOf = async (d: IDBDatabase, store: string): Promise<IDBValidKey[]> => (await req<IDBValidKey[]>(d, store, (s) => s.getAllKeys())) ?? [];
const valueOf = <T>(d: IDBDatabase, store: string, key: IDBValidKey): Promise<T> => req<T>(d, store, (s) => s.get(key));
/** A record put: `history` keeps its key in the record (keyPath «id»), the others beside it. */
const putRec = (d: IDBDatabase, store: string, key: IDBValidKey, value: unknown): Promise<unknown> => req(d, store, (s) => (s.keyPath ? s.put(value) : s.put(value, key)), 'readwrite');

/* ---------- records as text: pictures and bytes kept beside them ---------- */
// (A record is turned into JSON with every Blob in it written as a file of its own and named by a {"$kt":"blob"}
// stand-in; bytes, dates and numbers JSON has not are named the same way. Turned back, each is what it was.)
type Tagged = { $kt: string; [k: string]: unknown };
function blobsIn(v: unknown, out: Blob[]): void {
  if (!v || typeof v !== 'object') return;
  if (v instanceof Blob) { out.push(v); return; }
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Date) return;
  for (const x of Array.isArray(v) ? v : Object.values(v)) blobsIn(x, out);
}
function b64(u: Uint8Array): string { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s: string): Uint8Array { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
export function encode(v: unknown, rels: Map<Blob, string>): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $kt: 'num', v: String(v) };
  if (typeof v === 'bigint') return { $kt: 'bigint', v: String(v) };
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Blob) return { $kt: 'blob', rel: rels.get(v), type: v.type, size: v.size, ...(v instanceof File ? { name: v.name, lastModified: v.lastModified } : {}) };
  if (v instanceof Date) return { $kt: 'date', v: v.getTime() };
  if (v instanceof ArrayBuffer) return { $kt: 'bytes', b64: b64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { $kt: 'bytes', view: v.constructor.name, b64: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : encode(x, rels)));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encode(x, rels);
  return '$kt' in out ? { $kt: 'obj', v: out } : out;
}
function tagsIn(v: unknown, out: Tagged[]): void {
  if (!v || typeof v !== 'object') return;
  const t = v as Tagged;
  if (typeof t.$kt === 'string') { if (t.$kt === 'blob') out.push(t); else if (t.$kt === 'obj' && t.v && typeof t.v === 'object') for (const x of Object.values(t.v)) tagsIn(x, out); return; }
  for (const x of Array.isArray(v) ? v : Object.values(v)) tagsIn(x, out);
}
function decode(v: unknown, blobs: Map<Tagged, Blob>): unknown {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => decode(x, blobs));
  const t = v as Tagged;
  if (typeof t.$kt === 'string') {
    switch (t.$kt) {
      case 'blob': return blobs.get(t);
      case 'date': return new Date(Number(t.v));
      case 'num': return Number(t.v);
      case 'bigint': return BigInt(String(t.v));
      case 'bytes': {
        const u = unb64(String(t.b64)); const C = (globalThis as Record<string, unknown>)[String(t.view ?? '')] as (new (b: ArrayBuffer) => ArrayBufferView) | undefined;
        return t.view && typeof C === 'function' ? new C(u.buffer as ArrayBuffer) : u.buffer;
      }
      case 'obj': { const o: Record<string, unknown> = {}; for (const [k, x] of Object.entries((t.v ?? {}) as Record<string, unknown>)) o[k] = decode(x, blobs); return o; }
    }
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = decode(x, blobs);
  return out;
}
/** An IndexedDB key as text and back (string keys as they are; others tagged). */
const keyText = (k: IDBValidKey): unknown => (typeof k === 'string' ? k : encode(k, new Map()));
const keyBack = (k: unknown): IDBValidKey => (typeof k === 'string' ? k : decode(k, new Map()) as IDBValidKey);

/* ---------- making one (the Electron build, before the Rust one is installed) ---------- */
export interface MakeProgress { step: 'prepare' | 'files' | 'records' | 'engine' | 'check' | 'finish'; done: number; total: number }
export type MakeResult =
  | { ok: true; dir: string; id: string; counts: Counts; bytes: number }
  | { ok: false; reason: 'unsupported' | 'space' | 'unknown' | 'verify' | 'error'; free?: number; need?: number; profile?: number; detail?: string };
const CHUNK = 8 * 1024 * 1024;
const enc8 = new TextEncoder();

/** Everything written as a hand-over, read back and checked, and marked: what the bridge build calls before it installs
 *  the Rust build — which it must NOT do unless this answers ok. A failure leaves no hand-over (the shell's part folder
 *  is let go, the downloads paused for it set going again) and changes nothing of the person's data. */
export async function makeHandover(onProgress?: (p: MakeProgress) => void, o: { spaceUnknownOk?: boolean } = {}): Promise<MakeResult> {
  const api = handoverApi();
  if (!api?.begin || !api.write || !api.verify || !api.finish || !api.readPart) return { ok: false, reason: 'unsupported' };
  const say = (step: MakeProgress['step'], done = 0, total = 0) => { try { onProgress?.({ step, done, total }); } catch { /* the caller's */ } };
  say('prepare');
  const d = await rawDb();
  try {
    const keys: Record<Store, IDBValidKey[]> = { meta: await keysOf(d, 'meta'), files: await keysOf(d, 'files'), history: await keysOf(d, 'history') };
    // What it needs on the disk: every file kept, and room for the records and the engine's files.
    let need = 16 * 1024 * 1024;
    for (const k of keys.files) { const b = await valueOf<Blob | undefined>(d, 'files', k); if (b instanceof Blob) need += b.size; }
    try { const u = (await navigator.storage?.estimate?.())?.usage; if (u && u > need) need = u; } catch { /* the sum above */ }
    const begun = await api.begin({ need, ...(o.spaceUnknownOk ? { unknownOk: true } : {}) });
    if (!begun.ok) return { ok: false, reason: begun.reason === 'space' ? 'space' : begun.reason === 'unknown' ? 'unknown' : 'error', free: begun.free, need: begun.need, profile: begun.profile };
    const written: { rel: string; size: number }[] = [];
    const putBlob = async (rel: string, blob: Blob) => {
      if (!blob.size) await api.write!(rel, new Uint8Array(0), false);
      for (let off = 0; off < blob.size; off += CHUNK) await api.write!(rel, new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()), off > 0);
      written.push({ rel, size: blob.size });
    };
    const putText = async (rel: string, text: string) => { const u = enc8.encode(text); await api.write!(rel, u, false); written.push({ rel, size: u.length }); };
    // Lines written as they come, a few megabytes at a time — never the whole database as one string.
    const lineFile = (rel: string) => {
      let buf = ''; let started = false; let size = 0;
      const out = async () => { if (!buf && started) return; const u = enc8.encode(buf); buf = ''; await api.write!(rel, u, started); started = true; size += u.length; };
      return { add: async (x: unknown) => { buf += JSON.stringify(x) + '\n'; if (buf.length > 2 * 1024 * 1024) await out(); }, end: async () => { await out(); written.push({ rel, size }); } };
    };
    let blobN = 0;
    const putPictures = async (v: unknown): Promise<Map<Blob, string>> => {
      const found: Blob[] = []; blobsIn(v, found); const rels = new Map<Blob, string>();
      for (const b of found) { if (rels.has(b)) continue; const rel = `blobs/${blobN++}`; await putBlob(rel, b); rels.set(b, rel); }
      return rels;
    };
    // The files kept (add-ons, fonts, providers…), one at a time.
    const files: { key: string; rel: string; size: number; type: string; name?: string }[] = [];
    for (const [i, k] of keys.files.entries()) {
      say('files', i, keys.files.length);
      const blob = await valueOf<Blob | undefined>(d, 'files', k);
      if (!(blob instanceof Blob)) continue;
      const rel = `files/${i}`; await putBlob(rel, blob);
      files.push({ key: String(k), rel, size: blob.size, type: blob.type, ...(blob instanceof File ? { name: blob.name } : {}) });
    }
    say('files', keys.files.length, keys.files.length);
    // Every other record, as it is kept (a picture or bytes inside one written beside it).
    say('records');
    const il = lineFile('handover/idb.jsonl'); let records = 0;
    for (const store of ['meta', 'history'] as const) {
      for (const k of keys[store]) { const v = await valueOf<unknown>(d, store, k); const rels = await putPictures(v); await il.add({ store, key: keyText(k), value: encode(v, rels) }); records++; }
    }
    await il.end();
    await putText('handover/files.json', JSON.stringify(files));
    const local: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null && !localSkipped(k)) local[k] = localStorage.getItem(k) ?? ''; }
    await putText('handover/local.json', JSON.stringify(local));
    if (api.shellFiles) written.push(...await api.shellFiles());
    // The engine last: the streams ended, every moving download paused, aria2's session saved, its files copied.
    say('engine');
    let moving = 0;
    if (api.engineFiles) { const e = await api.engineFiles(); written.push(...e.files); moving = e.moving; }

    // Read back: the shell checks each file's bytes on the disk; here, that the records it holds are the database's.
    say('check');
    const v = await api.verify(written);
    if (!v.ok) { await api.abort?.(); return { ok: false, reason: 'verify', detail: (v.bad ?? []).slice(0, 5).join('; ') }; }
    const back = new TextDecoder().decode(await api.readPart('handover/idb.jsonl')).split('\n').filter(Boolean);
    const localBack = JSON.parse(new TextDecoder().decode(await api.readPart('handover/local.json'))) as Record<string, string>;
    const sameLocal = Object.keys(local).length === Object.keys(localBack).length && Object.entries(local).every(([k, x]) => localBack[k] === x);
    if (back.length !== records || !sameLocal) { await api.abort?.(); return { ok: false, reason: 'verify', detail: `read back: ${back.length}/${records} records, settings ${sameLocal ? 'the same' : 'different'}` }; }
    const sessionText = written.some((x) => x.rel === 'engine/aria2.session') ? new TextDecoder().decode(await api.readPart('engine/aria2.session')) : '';
    const videosText = written.some((x) => x.rel === 'engine/video-jobs.json') ? new TextDecoder().decode(await api.readPart('engine/video-jobs.json')) : '[]';
    let videos = 0; try { const j = JSON.parse(videosText) as unknown; videos = Array.isArray(j) ? j.length : 0; } catch { /* not a list */ }

    say('finish');
    const counts: Counts = { local: Object.keys(local).length, records, files: files.length, history: keys.history.length, addons: keys.meta.filter((k) => String(k).startsWith('addon-manifest:')).length,
      downloads: (sessionText.match(/^[ \t]+gid=/gm) ?? []).length, moving, videos, lists: LISTS.filter((k) => k in local).length, bytes: v.bytes ?? 0 };
    const r = await api.finish({ counts });
    if (!r.ok || !r.dir || !r.id) { await api.abort?.(); return { ok: false, reason: 'error', detail: 'not finished' }; }
    return { ok: true, dir: r.dir, id: r.id, counts, bytes: r.bytes ?? 0 };
  } catch (e) {
    await api.abort?.().catch(() => undefined);
    return { ok: false, reason: 'error', detail: String((e as Error)?.message ?? e) };
  } finally { d.close(); }
}

/* ---------- bringing one back (the Rust build) ---------- */
/** Nothing of the person's here yet: no history, no kept file, no add-on, none of the lists (the first start of the Rust
 *  build). (Not the settings: the app writes them at its first start.) */
export async function profileEmpty(): Promise<boolean> {
  const d = await rawDb();
  try {
    if ((await keysOf(d, 'history')).length || (await keysOf(d, 'files')).length) return false;
    if ((await keysOf(d, 'meta')).some((k) => String(k).startsWith('addon-'))) return false;
  } finally { d.close(); }
  for (const k of LISTS) { try { const v = localStorage.getItem(k); if (v && v !== '[]' && v !== '{}') return false; } catch { /* private mode */ } }
  return true;
}
/** Whether to offer this hand-over at the start: found whole, not brought back nor declined before, and this profile
 *  empty (or a restore of it broken off). */
export async function offerAtStart(f: Found): Promise<boolean> {
  if (!f.found || !f.marker || !f.dir) return false;
  const id = f.marker.id;
  if (f.state && f.state.id === id && (f.state.state === 'restored' || f.state.state === 'declined')) return false;
  let done = '', going = '';
  try { done = localStorage.getItem(DONE_KEY) ?? ''; going = localStorage.getItem(PROGRESS_KEY) ?? ''; } catch { /* private mode */ }
  if (done === id) return false;
  return going === id || await profileEmpty();
}

/** A path kept by the old build inside its data folder (the screen translator's fonts) moved to this build's: every
 *  string in a JSON value that starts with `from` gets `to` in its place (either slash after it). */
export function movedPaths(text: string, from: string, to: string): string {
  if (!from || !to) return text;
  let v: unknown; try { v = JSON.parse(text); } catch { return text; }
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const f = norm(from); const sep = to.includes('\\') ? '\\' : '/';
  let changed = false;
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') { const n = norm(x); if (n === f || n.startsWith(f + '/')) { changed = true; return to.replace(/[\\/]+$/, '') + n.slice(f.length).replace(/\//g, sep); } return x; }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') { const o: Record<string, unknown> = {}; for (const [k, y] of Object.entries(x)) o[k] = walk(y); return o; }
    return x;
  };
  const out = walk(v);
  return changed ? JSON.stringify(out) : text;
}

export interface RestoreProgress { step: 'verify' | 'read' | 'files' | 'records' | 'settings' | 'check'; done: number; total: number }
export interface RestoreResult { mode: 'copy' | 'merge'; local: number; records: number; files: number; history: number; downloads: number }

/** A hand-over brought into this profile. Into an empty profile (or one whose restore of it was broken off) it is
 *  COPIED: every record and every key as the old build had them. Into a profile that already has the person's things it
 *  is MERGED: only the keys, records and files this profile lacks are added. The folder is read, never changed. */
export async function restoreHandover(f: Found, onProgress?: (p: RestoreProgress) => void, o: { mode?: 'auto' | 'copy' | 'merge' } = {}): Promise<RestoreResult> {
  const api = handoverApi();
  if (!api?.read || !api.verifyDir || !f.dir || !f.marker) throw new Error('no hand-over');
  const dir = f.dir; const marker = f.marker;
  const say = (step: RestoreProgress['step'], done = 0, total = 0) => { try { onProgress?.({ step, done, total }); } catch { /* the caller's */ } };
  say('verify');
  const v = await api.verifyDir(dir);
  if (!v.ok) throw Object.assign(new Error(`the hand-over is damaged: ${(v.bad ?? []).slice(0, 3).join('; ')}`), { code: 'broken' });
  say('read');
  const has = new Set(marker.files.map((x) => x.rel));
  const text = async (rel: string) => (has.has(rel) ? new TextDecoder().decode(await api.read!(dir, rel)) : undefined);
  const sizeOf = new Map(marker.files.map((x) => [x.rel, x.size]));
  // (A file read in pieces through the shell's range read, each piece made a Blob at once: never one buffer here.)
  const blobAt = async (rel: string, type = '', name?: string): Promise<Blob> => {
    const size = sizeOf.get(rel) ?? -1;
    let parts: BlobPart[];
    if (api.readRange && size > HANDOVER_PIECE) {
      parts = [];
      for (let at = 0; at < size;) {
        const ab = await api.readRange(dir, rel, at, Math.min(HANDOVER_PIECE, size - at));
        if (!ab.byteLength) throw new Error(`${rel}: ended at ${at} of ${size} bytes`);
        parts.push(new Blob([ab])); at += ab.byteLength;
      }
    } else parts = [await api.read!(dir, rel)];
    return name !== undefined ? new File(parts, name, { type }) : new Blob(parts, { type });
  };
  const withPictures = async <T>(x: unknown): Promise<T> => {
    const tags: Tagged[] = []; tagsIn(x, tags); const got = new Map<Tagged, Blob>();
    for (const t of tags) if (typeof t.rel === 'string' && has.has(t.rel)) got.set(t, await blobAt(t.rel, String(t.type ?? ''), typeof t.name === 'string' ? t.name : undefined));
    return decode(x, got) as T;
  };
  const files = JSON.parse((await text('handover/files.json')) ?? '[]') as { key: string; rel: string; size: number; type: string; name?: string }[];
  const recs = ((await text('handover/idb.jsonl')) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { store: Store; key: unknown; value: unknown });
  const local = JSON.parse((await text('handover/local.json')) ?? '{}') as Record<string, string>;
  let going = ''; try { going = localStorage.getItem(PROGRESS_KEY) ?? ''; } catch { /* private mode */ }
  const copy = o.mode === 'copy' || (o.mode !== 'merge' && (going === marker.id || await profileEmpty()));
  try { localStorage.setItem(PROGRESS_KEY, marker.id); } catch { /* private mode */ }

  const d = await rawDb();
  let nFiles = 0, nRecs = 0, history = 0;
  try {
    // The kept files, then the records (an add-on's manifest is never there without its file).
    for (const [i, x] of files.entries()) {
      say('files', i, files.length);
      if (!copy && (await valueOf<unknown>(d, 'files', x.key)) !== undefined) continue;
      await putRec(d, 'files', x.key, await blobAt(x.rel, x.type, x.name)); nFiles++;
    }
    say('files', files.length, files.length);
    for (const [i, r] of recs.entries()) {
      if (i % 50 === 0) say('records', i, recs.length);
      if (!(STORES as readonly string[]).includes(r.store)) continue;
      const key = keyBack(r.key);
      if (!copy && (await valueOf<unknown>(d, r.store, key)) !== undefined) continue;
      await putRec(d, r.store, key, await withPictures(r.value)); nRecs++;
      if (r.store === 'history') history++;
    }
  } finally { d.close(); }
  // Settings and every other key: copied, or (merged) only those this profile has not. The screen translator's fonts
  // are now in this build's data folder (copied at its start): its settings point there.
  say('settings');
  const fromFonts = marker.from?.userData ? `${marker.from.userData.replace(/[\\/]+$/, '')}${marker.from.userData.includes('\\') ? '\\' : '/'}screen-fonts` : '';
  const toFonts = f.dataDir ? `${f.dataDir.replace(/[\\/]+$/, '')}${f.dataDir.includes('\\') ? '\\' : '/'}screen-fonts` : '';
  let localN = 0;
  for (const [k, val0] of Object.entries(local)) {
    if (localSkipped(k)) continue;
    const val = k === 'kt.screen' ? movedPaths(val0, fromFonts, toFonts) : val0;
    try { if (copy || localStorage.getItem(k) === null) { localStorage.setItem(k, val); localN++; } } catch { /* full: the rest still tried */ }
  }
  // The Electron shell's own: its icon (also kept by the page, as app.icon).
  const desk = window.kurokawaTools as unknown as { appIcon?(o: { set?: string | null }): Promise<unknown> } | undefined;
  try {
    const ic = local['app.icon'];
    let mine: unknown = null; if (!copy) mine = await desk?.appIcon?.({}).catch(() => null);
    if (ic && /^data:image\/png;base64,/.test(ic) && (copy || !mine)) await desk?.appIcon?.({ set: ic });
  } catch { /* the icon is the app's own until chosen again */ }

  // Checked: every key and record of the hand-over is here now.
  say('check');
  const d2 = await rawDb();
  try {
    for (const r of recs) { if ((STORES as readonly string[]).includes(r.store) && (await valueOf<unknown>(d2, r.store, keyBack(r.key))) === undefined) throw new Error(`a record did not arrive (${r.store})`); }
    for (const x of files) if ((await valueOf<unknown>(d2, 'files', x.key)) === undefined) throw new Error('a kept file did not arrive');
  } finally { d2.close(); }
  const missing = Object.keys(local).filter((k) => !localSkipped(k)).filter((k) => { try { return localStorage.getItem(k) === null; } catch { return true; } });
  if (missing.length) throw new Error(`${missing.length} setting(s) did not arrive`);
  try { localStorage.setItem(DONE_KEY, marker.id); localStorage.removeItem(PROGRESS_KEY); } catch { /* private mode */ }
  await api.mark?.({ id: marker.id, state: 'restored', counts: { local: localN, records: nRecs, files: nFiles, history } }).catch(() => false);
  return { mode: copy ? 'copy' : 'merge', local: localN, records: nRecs, files: nFiles, history, downloads: f.engine?.state === 'carried' ? f.engine.downloads ?? 0 : 0 };
}

/* ---------- what a profile holds (the tests and CI compare two) ---------- */
export async function profileSnapshot(): Promise<{ local: Record<string, string>; idb: Record<string, Record<string, unknown>>; files: Record<string, number> }> {
  const d = await rawDb();
  try {
    const idb: Record<string, Record<string, unknown>> = {};
    for (const store of ['meta', 'history'] as const) {
      const o: Record<string, unknown> = {};
      for (const k of await keysOf(d, store)) o[JSON.stringify(keyText(k))] = JSON.parse(JSON.stringify(encode(await valueOf<unknown>(d, store, k), new Map())));
      idb[store] = o;
    }
    const files: Record<string, number> = {};
    for (const k of await keysOf(d, 'files')) { const b = await valueOf<Blob | undefined>(d, 'files', k); files[String(k)] = b instanceof Blob ? b.size : -1; }
    const local: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null && !localSkipped(k)) local[k] = localStorage.getItem(k) ?? ''; }
    return { local, idb, files };
  } finally { d.close(); }
}
