// The hand-over between the computer's two builds (stage R6a of docs/RUST-PORT-READER.md): the last Electron build
// writes everything the reader keeps — the library's stores copied whole, every localStorage key, the shell's own
// files — into a folder on the computer before the Rust (Tauri) build is installed; the Rust build, whose web view
// starts with an empty profile, finds that folder on its first start and brings it all back. Nothing is deleted from
// the old profile, and the folder itself goes only when the reader asks (after a restore that worked).
//
// The folder (desktop/handover.cjs writes it; desktop-tauri/src-tauri/src/handover.rs finds and reads it):
//   kurokawa-backup.json         a full backup's manifest (src/backup.ts) — so the folder is also a full backup,
//   paths.json                   with its files at safe names: { "books/<id>/<fileName>": "books/3/file", … }
//   books/<n>/file, cover, …     each copied book's file (a LINKED book's file stays where it is: its link crosses)
//   fonts/<n>, files/<n>         the other files the app keeps (fonts, the reader's background picture…)
//   blobs/<n>                    pictures kept inside records (a book's original cover, a source's cover…)
//   handover/books.jsonl         every book record as it is kept (ids, places, notes, links…), one per line
//   handover/meta.jsonl          every other record (folders, tags, glossary state, Anki, automatic backups…)
//   handover/files.json          what files/… and books/<n>/file hold, by the key they are kept under
//   handover/local.json          every localStorage key — settings, per-book settings, sign-ins, flags
//   handover/opfs.json, opfs/<n> the origin's private files (the local AI's models)
// (Not Cache Storage: the computer's and the phones' apps empty it at every start — main.ts —, so nothing of the
// reader's lives there; voices and the local AI's engine are fetched again when used, in either build.)
//   shell/…                      the Electron shell's own files: custom-icon.png, window-state.json, doh.json
//   marker.json                  written last, by the shell: each file's size and SHA-256
// Unlike a backup the reader shares, a hand-over keeps the sign-ins and keys (it never leaves this computer and its
// user's own data folder): the reader is still signed in after the move.
import { db, uid, type Book } from './db';
import { backupManifest, readManifest, restoreManifest, type BackupParts } from './backup';

/* ---------- the shells' halves (desktop/preload.cjs, desktop-tauri/handover-bridge.js) ---------- */
export interface MarkerFile { rel: string; size: number; sha256: string }
export interface Counts { books: number; copied: number; linked: number; files: number; meta: number; local: number; highlights: number; bookmarks: number; bytes: number }
export interface Marker { app: string; kind: 'handover'; format: number; id: string; createdAt: number; from?: { shell?: string; version?: string; platform?: string; portable?: boolean }; counts?: Partial<Counts>; bytes: number; files: MarkerFile[] }
export interface Found { found: boolean; dir?: string; marker?: Marker; state?: { id: string; state: string; at: number } | null; problems?: string[]; looked?: string[]; /** none found: the earlier (Electron) copy's library still in its data folder, its program still installed */ electron?: { library: boolean; program: boolean } }
export interface HandoverApi {
  shell: 'electron' | 'tauri';
  // the writing half (the Electron build)
  begin?(o: { need: number; unknownOk?: boolean }): Promise<{ ok: boolean; reason?: string; free?: number; need?: number; profile?: number; part?: string }>;
  write?(rel: string, data: Uint8Array, append: boolean): Promise<{ size: number }>;
  shellFiles?(): Promise<{ rel: string; size: number }[]>;
  readPart?(rel: string): Promise<ArrayBuffer>;
  verify?(list: { rel: string; size: number }[]): Promise<{ ok: boolean; bad?: string[]; files?: number; bytes?: number }>;
  finish?(info: { counts: Counts }): Promise<{ ok: boolean; dir?: string; id?: string; bytes?: number; files?: number }>;
  abort?(): Promise<boolean>;
  status?(): Promise<{ dir: string; marker: Marker } | null>;
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
export const DONE_KEY = 'kr.handover.done'; export const PROGRESS_KEY = 'kr.handover.progress';
/** localStorage keys that do not cross: the shell's diagnostics, the hand-over's own state. */
export const localSkipped = (k: string): boolean => k === 'kr.diag' || k.startsWith('kr.handover.');

/* ---------- the stores, read whole ---------- */
const DB_NAME = 'kurokawa-reader';
async function rawDb(): Promise<IDBDatabase> {
  await db.allBooks();   // (db.ts opens — and on a new profile makes — the database at its own version first)
  return new Promise((resolve, reject) => { const r = indexedDB.open(DB_NAME); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}
function req<T>(d: IDBDatabase, store: string, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!d.objectStoreNames.contains(store)) { resolve(undefined as T); return; }
    const t = d.transaction(store, 'readonly'); const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result as T); r.onerror = () => reject(r.error);
  });
}
const keysOf = async (d: IDBDatabase, store: string): Promise<IDBValidKey[]> => (await req<IDBValidKey[]>(d, store, (s) => s.getAllKeys())) ?? [];
const valueOf = <T>(d: IDBDatabase, store: string, key: IDBValidKey): Promise<T> => req<T>(d, store, (s) => s.get(key));

/* ---------- records as text: pictures and bytes kept beside them ---------- */
// (A record is turned into JSON with every Blob in it written as a file of its own and named by a {"$kr":"blob"}
// stand-in; bytes, dates and numbers JSON has not are named the same way. Turned back, each is what it was.)
type Tagged = { $kr: string; [k: string]: unknown };
function blobsIn(v: unknown, out: Blob[]): void {
  if (!v || typeof v !== 'object') return;
  if (v instanceof Blob) { out.push(v); return; }
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Date) return;
  for (const x of Array.isArray(v) ? v : Object.values(v)) blobsIn(x, out);
}
function b64(u: Uint8Array): string { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s: string): Uint8Array { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function encode(v: unknown, rels: Map<Blob, string>): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $kr: 'num', v: String(v) };
  if (typeof v === 'bigint') return { $kr: 'bigint', v: String(v) };
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Blob) return { $kr: 'blob', rel: rels.get(v), type: v.type, size: v.size, ...(v instanceof File ? { name: v.name, lastModified: v.lastModified } : {}) };
  if (v instanceof Date) return { $kr: 'date', v: v.getTime() };
  if (v instanceof ArrayBuffer) return { $kr: 'bytes', b64: b64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { $kr: 'bytes', view: v.constructor.name, b64: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : encode(x, rels)));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = encode(x, rels);
  return '$kr' in out ? { $kr: 'obj', v: out } : out;
}
function tagsIn(v: unknown, out: Tagged[]): void {
  if (!v || typeof v !== 'object') return;
  const t = v as Tagged;
  if (typeof t.$kr === 'string') { if (t.$kr === 'blob') out.push(t); else if (t.$kr === 'obj' && t.v && typeof t.v === 'object') for (const x of Object.values(t.v)) tagsIn(x, out); return; }
  for (const x of Array.isArray(v) ? v : Object.values(v)) tagsIn(x, out);
}
function decode(v: unknown, blobs: Map<Tagged, Blob>): unknown {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => decode(x, blobs));
  const t = v as Tagged;
  if (typeof t.$kr === 'string') {
    switch (t.$kr) {
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

/* ---------- the origin's private files (OPFS) ---------- */
type Dir = { entries?(): AsyncIterable<[string, { kind: 'file' | 'directory'; getFile?(): Promise<File> }]>; getDirectoryHandle(n: string, o?: { create?: boolean }): Promise<Dir>; getFileHandle(n: string, o?: { create?: boolean }): Promise<{ getFile(): Promise<File>; createWritable?(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }> };
const opfsRoot = async (): Promise<Dir | null> => { try { return ((await (navigator.storage as unknown as { getDirectory?(): Promise<Dir> })?.getDirectory?.()) ?? null); } catch { return null; } };
async function opfsFiles(): Promise<{ path: string; file: File }[]> {
  const out: { path: string; file: File }[] = []; const root = await opfsRoot(); if (!root?.entries) return out;
  const walk = async (d: Dir, at: string): Promise<void> => {
    for await (const [name, h] of d.entries!()) {
      const p = at ? `${at}/${name}` : name;
      if (h.kind === 'file' && h.getFile) out.push({ path: p, file: await h.getFile() });
      else if (h.kind === 'directory') await walk(h as unknown as Dir, p);
    }
  };
  try { await walk(root, ''); } catch { /* what was read so far */ }
  return out;
}
async function opfsPut(path: string, blob: Blob): Promise<void> {
  let d = await opfsRoot(); if (!d) throw new Error('no private files here');
  const parts = path.split('/');
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  if (!fh.createWritable) throw new Error('this web view cannot write private files');
  const w = await fh.createWritable(); await w.write(blob); await w.close();
}

/* ---------- making one (the Electron build, before the Rust one is installed) ---------- */
export interface MakeProgress { step: 'prepare' | 'files' | 'records' | 'check' | 'finish'; done: number; total: number }
export type MakeResult =
  | { ok: true; dir: string; id: string; counts: Counts; bytes: number }
  | { ok: false; reason: 'unsupported' | 'space' | 'unknown' | 'verify' | 'error'; free?: number; need?: number; profile?: number; detail?: string };
const CHUNK = 8 * 1024 * 1024;
const enc8 = new TextEncoder();
const keyOf = (b: { fileName: string; size: number }) => `${b.fileName}:${b.size}`;
const remoteKey = (r?: Book['remote']) => (r?.source && r.id ? `${r.source}\u0000${r.id}` : '');

/** The whole library written as a hand-over, read back and checked, and marked: what the bridge build calls before it
 *  installs the Rust build — which it must NOT do unless this answers ok. A failure leaves no hand-over (the shell's
 *  part folder is let go) and changes nothing of the reader's data. */
export async function makeHandover(onProgress?: (p: MakeProgress) => void, o: { spaceUnknownOk?: boolean } = {}): Promise<MakeResult> {
  const api = handoverApi();
  if (!api?.begin || !api.write || !api.verify || !api.finish || !api.readPart) return { ok: false, reason: 'unsupported' };
  const say = (step: MakeProgress['step'], done = 0, total = 0) => { try { onProgress?.({ step, done, total }); } catch { /* the caller's */ } };
  say('prepare');
  const d = await rawDb();
  try {
    const books = (await req<Book[]>(d, 'books', (s) => s.getAll())) ?? [];
    const fileKeys = await keysOf(d, 'files');
    const metaKeys = await keysOf(d, 'meta');
    // What it needs on the disk: every file kept, every picture in the records, and room for the records themselves.
    let need = 16 * 1024 * 1024;
    for (const k of fileKeys) { const b = await valueOf<Blob | undefined>(d, 'files', k); if (b instanceof Blob) need += b.size; }
    for (const b of books) { if (b.cover instanceof Blob) need += b.cover.size; if (b.coverOrig instanceof Blob) need += b.coverOrig.size; }
    // (The origin's own count — the stores, the caches and the private files together — when it is the larger.)
    try { const u = (await navigator.storage?.estimate?.())?.usage; if (u && u > need) need = u; } catch { /* the sum above */ }
    // (The shell could not read the disk's free space: «unknown», with its estimate — the page asks the reader, and
    // only their «go on» makes it — spaceUnknownOk.)
    const begun = await api.begin({ need, ...(o.spaceUnknownOk ? { unknownOk: true } : {}) });
    if (!begun.ok) return { ok: false, reason: begun.reason === 'space' ? 'space' : begun.reason === 'unknown' ? 'unknown' : 'error', free: begun.free, need: begun.need, profile: begun.profile };
    const written: { rel: string; size: number }[] = [];
    const putBlob = async (rel: string, blob: Blob) => {
      if (!blob.size) await api.write!(rel, new Uint8Array(0), false);
      for (let off = 0; off < blob.size; off += CHUNK) await api.write!(rel, new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer()), off > 0);
      written.push({ rel, size: blob.size });
    };
    const putText = async (rel: string, text: string) => { const u = enc8.encode(text); await api.write!(rel, u, false); written.push({ rel, size: u.length }); };
    // Lines written as they come, a few megabytes at a time — never the whole store as one string.
    const lineFile = (rel: string) => {
      let buf = ''; let started = false; let size = 0;
      const out = async () => { if (!buf && started) return; const u = enc8.encode(buf); buf = ''; await api.write!(rel, u, started); started = true; size += u.length; };
      return { add: async (o: unknown) => { buf += JSON.stringify(o) + '\n'; if (buf.length > 2 * 1024 * 1024) await out(); }, end: async () => { await out(); written.push({ rel, size }); } };
    };
    let blobN = 0;
    const putPictures = async (v: unknown, at?: (b: Blob) => string | undefined): Promise<Map<Blob, string>> => {
      const found: Blob[] = []; blobsIn(v, found); const rels = new Map<Blob, string>();
      for (const b of found) { if (rels.has(b)) continue; const rel = at?.(b) ?? `blobs/${blobN++}`; await putBlob(rel, b); rels.set(b, rel); }
      return rels;
    };

    // The files kept (each book's own file, fonts, the reader's background…), one at a time.
    const indexOf = new Map(books.map((b, i) => [b.id, i]));
    const files: { key: string; rel: string; size: number; type: string; name?: string; book?: string }[] = [];
    const paths: Record<string, string> = {};
    let otherN = 0, fontN = 0, copied = 0;
    for (const [i, k] of fileKeys.entries()) {
      const key = String(k); const blob = await valueOf<Blob | undefined>(d, 'files', k);
      say('files', i, fileKeys.length);
      if (!(blob instanceof Blob)) continue;
      const n = indexOf.get(key); const book = n !== undefined ? books[n] : undefined;
      const rel = book ? `books/${n}/file` : key.startsWith('font:') ? `fonts/${fontN++}` : `files/${otherN++}`;
      await putBlob(rel, blob);
      files.push({ key, rel, size: blob.size, type: blob.type, ...(blob instanceof File ? { name: blob.name } : {}), ...(book ? { book: key } : {}) });
      if (book) { paths[`books/${book.id}/${book.fileName}`] = rel; copied++; }
      else if (key.startsWith('font:')) paths[`fonts/${key.slice(5)}`] = rel;
    }
    say('files', fileKeys.length, fileKeys.length);
    // Every book's record as it is kept: its cover at books/<n>/cover, any other picture in it under blobs/.
    say('records');
    const bl = lineFile('handover/books.jsonl');
    let highlights = 0, bookmarks = 0, linked = 0;
    for (const [n, b] of books.entries()) {
      const rels = await putPictures(b, (x) => (x === b.cover ? `books/${n}/cover` : x === b.coverOrig ? `books/${n}/cover-orig` : undefined));
      if (b.cover instanceof Blob) paths[`books/${b.id}/cover`] = `books/${n}/cover`;
      await bl.add({ n, record: encode(b, rels) });
      highlights += (b.highlights?.length ?? 0) + (b.pdfHighlights?.length ?? 0) + (b.pins?.length ?? 0);
      bookmarks += b.bookmarks?.length ?? 0;
      if (b.source && !files.some((f) => f.book === b.id)) linked++;
      // (Its translations as a full backup keeps them: what a restore into a library that has the book merges.)
      const tr = await valueOf<Record<string, string> | undefined>(d, 'meta', `tr:${b.id}`), trs = await valueOf<Record<string, string> | undefined>(d, 'meta', `trs:${b.id}`);
      if ((tr && Object.keys(tr).length) || (trs && Object.keys(trs).length)) { await putText(`books/${n}/translations.json`, JSON.stringify({ tr: tr ?? {}, trs: trs ?? {} })); paths[`books/${b.id}/translations.json`] = `books/${n}/translations.json`; }
    }
    await bl.end();
    const ml = lineFile('handover/meta.jsonl');
    for (const k of metaKeys) { const v = await valueOf<unknown>(d, 'meta', k); const rels = await putPictures(v); await ml.add({ key: String(k), value: encode(v, rels) }); }
    await ml.end();
    await putText('handover/files.json', JSON.stringify(files));
    const local: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null && !localSkipped(k)) local[k] = localStorage.getItem(k) ?? ''; }
    await putText('handover/local.json', JSON.stringify(local));
    // The origin's private files (the local AI's models), each a file of its own.
    const opfsIdx: { path: string; rel: string; size: number; type: string }[] = []; let opfsN = 0;
    for (const f of await opfsFiles()) { const rel = `opfs/${opfsN++}`; await putBlob(rel, f.file); opfsIdx.push({ path: f.path, rel, size: f.file.size, type: f.file.type }); }
    await putText('handover/opfs.json', JSON.stringify(opfsIdx));
    // (The full backup's manifest — credentials left out, as every backup's — so the folder also reads as one.)
    await putText('kurokawa-backup.json', JSON.stringify({ ...(await backupManifest(true)), handover: { format: 1 } }, null, 1));
    await putText('paths.json', JSON.stringify(paths));
    if (api.shellFiles) written.push(...await api.shellFiles());

    // Read back: the shell checks each file's bytes on the disk; here, that the records it holds are the library's.
    say('check');
    const v = await api.verify(written);
    if (!v.ok) { await api.abort?.(); return { ok: false, reason: 'verify', detail: (v.bad ?? []).slice(0, 5).join('; ') }; }
    const back = new TextDecoder().decode(await api.readPart('handover/books.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { n: number; record: Book });
    const metaBack = new TextDecoder().decode(await api.readPart('handover/meta.jsonl')).split('\n').filter(Boolean).length;
    const same = back.length === books.length && back.every((x, i) => x.record.id === books[i].id && JSON.stringify(x.record.progress ?? null) === JSON.stringify(encode(books[i].progress ?? null, new Map())) && (x.record.highlights?.length ?? 0) === (books[i].highlights?.length ?? 0));
    if (!same || metaBack !== metaKeys.length) { await api.abort?.(); return { ok: false, reason: 'verify', detail: `records read back: ${back.length}/${books.length} books, ${metaBack}/${metaKeys.length} others` }; }

    say('finish');
    const counts: Counts = { books: books.length, copied, linked, files: files.length, meta: metaKeys.length, local: Object.keys(local).length, highlights, bookmarks, bytes: v.bytes ?? 0 };
    const r = await api.finish({ counts });
    if (!r.ok || !r.dir || !r.id) { await api.abort?.(); return { ok: false, reason: 'error', detail: 'not finished' }; }
    return { ok: true, dir: r.dir, id: r.id, counts, bytes: r.bytes ?? 0 };
  } catch (e) {
    await api.abort?.().catch(() => undefined);
    return { ok: false, reason: 'error', detail: String((e as Error)?.message ?? e) };
  } finally { d.close(); }
}

/* ---------- bringing one back (the Rust build) ---------- */
/** Nothing of the reader's here yet: no book, no folder, no tag (the first start of the Rust build). (Not the
 *  settings: the app writes them whole at its first start, migrations and all.) */
export async function profileEmpty(): Promise<boolean> {
  if ((await db.allBooks()).length) return false;
  for (const k of ['folders', 'tags']) { const v = await db.getMeta<unknown[]>(k); if (Array.isArray(v) && v.length) return false; }
  return true;
}
/** Whether to offer this hand-over at the start: found whole, not brought back nor declined before, and this
 *  profile empty (or a restore of it broken off). */
export async function offerAtStart(f: Found): Promise<boolean> {
  if (!f.found || !f.marker || !f.dir) return false;
  const id = f.marker.id;
  if (f.state && f.state.id === id && (f.state.state === 'restored' || f.state.state === 'declined')) return false;
  let done = '', going = '';
  try { done = localStorage.getItem(DONE_KEY) ?? ''; going = localStorage.getItem(PROGRESS_KEY) ?? ''; } catch { /* private mode */ }
  if (done === id) return false;
  return going === id || await profileEmpty();
}

export interface RestoreProgress { step: 'verify' | 'read' | 'books' | 'records' | 'settings' | 'check'; done: number; total: number }
export interface RestoreResult { mode: 'copy' | 'merge'; books: number; added: number; highlights: number; bookmarks: number; local: number; meta: number }

/** A hand-over brought into this profile. Into an empty profile (or one whose restore of it was broken off) it is
 *  COPIED: every record with its own id, every key, as the old build had them. Into a library that already has
 *  books it is MERGED: the books it lacks added as they were (with their notes, places, covers; linked ones linked),
 *  then the full backup's rules for the rest (src/backup.ts: notes merged, the later place kept…). The folder is read,
 *  never changed. */
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
  const bytes = (rel: string) => api.read!(dir, rel);
  const text = async (rel: string) => (has.has(rel) ? new TextDecoder().decode(await bytes(rel)) : undefined);
  const lines = async <T>(rel: string): Promise<T[]> => ((await text(rel)) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
  // A file read in pieces (PIECE bytes each, through the shell's range read) and each piece made a Blob at once: the
  // book is never one buffer in this page, and the Blob put in the store is made of the pieces' Blobs (the browser
  // keeps their bytes once — Chromium on disk when large —, not a second copy). A file of a shell without the range
  // read, or no bigger than one piece, is read whole.
  const sizeOf = new Map(marker.files.map((x) => [x.rel, x.size]));
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
    } else parts = [await bytes(rel)];
    return name !== undefined ? new File(parts, name, { type }) : new Blob(parts, { type });
  };
  const withPictures = async <T>(v: unknown): Promise<T> => {
    const tags: Tagged[] = []; tagsIn(v, tags); const got = new Map<Tagged, Blob>();
    for (const t of tags) if (typeof t.rel === 'string' && has.has(t.rel)) got.set(t, await blobAt(t.rel, String(t.type ?? ''), typeof t.name === 'string' ? t.name : undefined));
    return decode(v, got) as T;
  };
  const files = JSON.parse((await text('handover/files.json')) ?? '[]') as { key: string; rel: string; size: number; type: string; name?: string; book?: string }[];
  const books = await lines<{ n: number; record: unknown }>('handover/books.jsonl');
  const meta = await lines<{ key: string; value: unknown }>('handover/meta.jsonl');
  const local = JSON.parse((await text('handover/local.json')) ?? '{}') as Record<string, string>;
  let going = ''; try { going = localStorage.getItem(PROGRESS_KEY) ?? ''; } catch { /* private mode */ }
  const copy = o.mode === 'copy' || (o.mode !== 'merge' && (going === marker.id || await profileEmpty()));
  try { localStorage.setItem(PROGRESS_KEY, marker.id); } catch { /* private mode */ }

  // Books: each one's file first, then its record — a book is never there without its file.
  const existing = await db.allBooks();
  const byKey = new Set(existing.map(keyOf)); const byRemote = new Set(existing.map((b) => remoteKey(b.remote)).filter(Boolean)); const ids = new Set(existing.map((b) => b.id));
  const fileOf = new Map(files.filter((x) => x.book).map((x) => [x.book!, x]));
  let added = 0, highlights = 0, bookmarks = 0;
  for (const [i, line] of books.entries()) {
    say('books', i, books.length);
    const rec = await withPictures<Book>(line.record);
    highlights += (rec.highlights?.length ?? 0) + (rec.pdfHighlights?.length ?? 0) + (rec.pins?.length ?? 0); bookmarks += rec.bookmarks?.length ?? 0;
    const old = rec.id; const file = fileOf.get(old);
    if (!copy) {
      // (Merged: a book this library has already is left to the backup's rules below.)
      if (byKey.has(keyOf(rec)) || (remoteKey(rec.remote) && byRemote.has(remoteKey(rec.remote)))) continue;
      if (ids.has(rec.id)) {
        rec.id = uid();
        if (rec.progress) rec.progress = { ...rec.progress, bookId: rec.id };
        rec.bookmarks = (rec.bookmarks ?? []).map((x) => (x?.locator?.bookId === old ? { ...x, locator: { ...x.locator, bookId: rec.id } } : x));
      }
      // (Its folder put back by name, below: this library's folders have their own ids.)
      delete rec.folderId; delete rec.folderAt;
    }
    if (file) await db.putFile(rec.id, await blobAt(file.rel, file.type, file.name));
    await db.putBook(rec);
    ids.add(rec.id); byKey.add(keyOf(rec)); added++;
  }
  say('books', books.length, books.length);
  // The other files (fonts, the background picture…) and records.
  say('records');
  const haveFile = async (key: string) => { const d = await rawDb(); try { return (await valueOf<unknown>(d, 'files', key)) !== undefined; } finally { d.close(); } };
  for (const x of files) if (!x.book && (copy || !(await haveFile(x.key)))) await db.putFile(x.key, await blobAt(x.rel, x.type, x.name));
  const MERGED_BY_BACKUP = new Set(['folders', 'tags', 'fonts']);
  for (const [i, m] of meta.entries()) {
    if (i % 50 === 0) say('records', i, meta.length);
    if (!copy && (MERGED_BY_BACKUP.has(m.key) || (await db.getMeta(m.key)) !== undefined)) continue;
    await db.setMeta(m.key, await withPictures(m.value));
  }
  // Settings and every other key: copied, or (merged) only those this profile has not.
  say('settings');
  let localN = 0;
  for (const [k, val] of Object.entries(local)) {
    if (localSkipped(k)) continue;
    try { if (copy || localStorage.getItem(k) === null) { localStorage.setItem(k, val); localN++; } } catch { /* full: the rest still tried */ }
  }
  if (!copy) {
    const man = await text('kurokawa-backup.json');
    if (man) {
      const paths = JSON.parse((await text('paths.json')) ?? '{}') as Record<string, string>;
      const parts: BackupParts = { blob: async (p) => (paths[p] && has.has(paths[p]) ? blobAt(paths[p]) : undefined), text: async (p) => (paths[p] ? text(paths[p]) : undefined) };
      await restoreManifest(readManifest(man), parts);
    }
  }
  // The private files (the local AI's models). Where this web view cannot write them, the list of models is emptied —
  // they then show as not downloaded, never as there and broken.
  let opfsFailed = false;
  for (const x of JSON.parse((await text('handover/opfs.json')) ?? '[]') as { path: string; rel: string; type: string }[]) {
    try { await opfsPut(x.path, await blobAt(x.rel, x.type)); } catch { opfsFailed = true; }
  }
  try {
    if (copy && opfsFailed) localStorage.setItem('kr.localModels', '[]');
  } catch { /* private mode */ }
  // The Electron shell's own: its icon (also kept by the page, as app.icon) and its DNS choice.
  const desk = (window as unknown as { kurokawaDesktop?: { appIcon?(o: { set?: string | null }): Promise<unknown>; setDoh?(p: string): Promise<unknown> } }).kurokawaDesktop;
  try {
    const icon = local['app.icon'];
    let mine: unknown = null; if (!copy) mine = await desk?.appIcon?.({}).catch(() => null);
    if (icon && /^data:image\/png;base64,/.test(icon) && (copy || !mine)) await desk?.appIcon?.({ set: icon });
  } catch { /* the icon is the app's own until chosen again */ }
  try {
    const doh = JSON.parse((await text('shell/doh.json')) ?? 'null') as { provider?: string } | null;
    if (doh?.provider && doh.provider !== 'off' && desk?.setDoh) await desk.setDoh(doh.provider);
  } catch { /* DNS stays the system's */ }

  // Checked: every book of the hand-over is in the library now.
  say('check');
  const now = await db.allBooks(); const keys = new Set(now.map(keyOf));
  const missing = books.filter((l) => { const r = l.record as Book; return !keys.has(keyOf(r)); }).length;
  if (missing) throw new Error(`${missing} book(s) did not arrive`);
  try { localStorage.setItem(DONE_KEY, marker.id); localStorage.removeItem(PROGRESS_KEY); } catch { /* private mode */ }
  await api.mark?.({ id: marker.id, state: 'restored', counts: { books: books.length, highlights, bookmarks } }).catch(() => false);
  return { mode: copy ? 'copy' : 'merge', books: books.length, added, highlights, bookmarks, local: localN, meta: meta.length };
}

/* ---------- what a profile holds (the tests and CI compare two) ---------- */
export async function profileSnapshot(): Promise<{ books: Record<string, unknown>[]; files: Record<string, number>; meta: string[]; local: Record<string, string>; opfs: string[] }> {
  const d = await rawDb();
  try {
    const books = ((await req<Book[]>(d, 'books', (s) => s.getAll())) ?? []).sort((a, b) => (a.id < b.id ? -1 : 1));
    const files: Record<string, number> = {};
    for (const k of await keysOf(d, 'files')) { const b = await valueOf<Blob | undefined>(d, 'files', k); files[String(k)] = b instanceof Blob ? b.size : -1; }
    const meta = (await keysOf(d, 'meta')).map(String).sort();
    const local: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k !== null && !localSkipped(k)) local[k] = localStorage.getItem(k) ?? ''; }
    const opfs = (await opfsFiles()).map((f) => `${f.path} ${f.file.size}`).sort();
    return { opfs, books: books.map((b) => JSON.parse(JSON.stringify(encode({ ...b, cover: undefined, coverOrig: undefined }, new Map()))) as Record<string, unknown>).map((r, i) => ({ ...r, coverSize: books[i].cover instanceof Blob ? books[i].cover!.size : null })), files, meta, local };
  } finally { d.close(); }
}
