// The reading-aid dictionaries — the Japanese one behind furigana (kuromoji + its IPADIC files) and the Chinese one
// behind pinyin (pinyin-pro) — as something the reader can see, start, stop and remove.
//
// They are fetched from the CDN once, when the reader asks (a button in the notice over the book, or in the options),
// each file checked as it arrives and kept in the app's own cache; only when every file is there is the dictionary
// "downloaded". A download stopped half way keeps the files it finished (the next one goes on from them) and is never
// used: what the readings load from is the cache, and only a dictionary that is complete. Nothing here starts a
// download by itself.
import { http, bodyBytes, isWebOnly } from './net';

export type DictKind = 'ja' | 'zh';
/** Why a download did not finish (the words are in the interface's strings: dictFail_*). */
export type DictFail = 'offline' | 'network' | 'http' | 'corrupt' | 'space' | 'unsupported' | 'load';
export interface DictState {
  /** unknown: not looked at yet; none: not on the device; downloading; ready: complete on the device; error: the last try failed */
  phase: 'unknown' | 'none' | 'downloading' | 'ready' | 'error';
  /** bytes received so far (downloading) and the size expected */
  done: number; total: number;
  /** bytes on the device (ready) */
  bytes: number;
  fail?: DictFail; code?: number;
}

type DictFile = { path: string; size: number; kind: 'js' | 'gz' };
interface DictSpec { base: string; files: DictFile[] }
const gz = (name: string, size: number): DictFile => ({ path: `/dict/${name}.dat.gz`, size, kind: 'gz' });
const SPEC: Record<DictKind, DictSpec> = {
  ja: {
    base: 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2',
    files: [
      { path: '/build/kuromoji.js', size: 307967, kind: 'js' },
      gz('base', 3956825), gz('check', 3111633), gz('tid', 1605820), gz('tid_pos', 5916009), gz('tid_map', 1485576), gz('cc', 1692067),
      gz('unk', 10512), gz('unk_pos', 10540), gz('unk_map', 1190), gz('unk_char', 306), gz('unk_compat', 338), gz('unk_invoke', 1140),
    ],
  },
  zh: { base: 'https://cdn.jsdelivr.net/npm/pinyin-pro@3.26.0', files: [{ path: '/dist/index.js', size: 322812, kind: 'js' }] },
};
/** The address a file is kept under (the same the app's service worker keeps it under on the web). */
export const dictUrl = (kind: DictKind, f: DictFile): string => SPEC[kind].base + f.path;
/** The scripts and dictionary folder on the CDN (the way before 0.64.2, kept as the fallback). */
export const KUROMOJI_CDN_JS = SPEC.ja.base + '/build/kuromoji.js';
export const PINYIN_CDN_JS = SPEC.zh.base + '/dist/index.js';
/** Where kuromoji looks for its dictionary files. */
export const KUROMOJI_DICT = SPEC.ja.base + '/dict/';
/** The size to show before it is downloaded: what the files come to. */
export const dictSize = (kind: DictKind): number => SPEC[kind].files.reduce((n, f) => n + f.size, 0);

const CACHE = 'kurokawa-ext';
const MKEY = (k: DictKind) => `kr.readingdict.${k}`;
const hasCache = (): boolean => typeof caches !== 'undefined';

const state: Record<DictKind, DictState> = {
  ja: { phase: 'unknown', done: 0, total: dictSize('ja'), bytes: 0 },
  zh: { phase: 'unknown', done: 0, total: dictSize('zh'), bytes: 0 },
};
const listeners = new Set<(kind: DictKind, s: DictState) => void>();
const emit = (kind: DictKind): void => { const s = { ...state[kind] }; for (const fn of [...listeners]) { try { fn(kind, s); } catch { /* a listener's own fault */ } } };
const set = (kind: DictKind, patch: Partial<DictState>): void => { state[kind] = { ...state[kind], ...patch }; emit(kind); };
export const getDictState = (kind: DictKind): DictState => ({ ...state[kind] });
/** Told of every change (progress included); returns the way to stop being told. */
export function onDictChange(fn: (kind: DictKind, s: DictState) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export const dictListenerCount = (): number => listeners.size;

const readManifest = (k: DictKind): { bytes: number } | null => { try { const m = JSON.parse(localStorage.getItem(MKEY(k)) ?? 'null') as { bytes?: number } | null; return m && typeof m.bytes === 'number' ? { bytes: m.bytes } : null; } catch { return null; } };
const writeManifest = (k: DictKind, bytes: number): void => { try { localStorage.setItem(MKEY(k), JSON.stringify({ bytes, at: Date.now() })); } catch { /* full: the cache itself still says what is there */ } };
const dropManifest = (k: DictKind): void => { try { localStorage.removeItem(MKEY(k)); } catch { /* */ } };

const checking: Partial<Record<DictKind, Promise<DictState>>> = {};
const jobs: Partial<Record<DictKind, { ctl: AbortController; done: Promise<boolean> }>> = {};

/** What is on the device: complete, or not. Looked up once; `force` looks again. */
export function refreshDictState(kind: DictKind, force = false): Promise<DictState> {
  if (jobs[kind]) return Promise.resolve(getDictState(kind));
  if (force) delete checking[kind];
  return (checking[kind] ??= (async () => {
    if (!hasCache()) { set(kind, { phase: 'none', bytes: 0 }); return getDictState(kind); }
    try {
      const c = await caches.open(CACHE); let bytes = 0;
      for (const f of SPEC[kind].files) {
        const hit = await c.match(dictUrl(kind, f));
        if (!hit) { dropManifest(kind); set(kind, { phase: 'none', bytes: 0, done: 0, fail: undefined }); return getDictState(kind); }
        bytes += Number(hit.headers.get('content-length')) || f.size;
      }
      // (Every file is there: a dictionary kept by an earlier version — the service worker kept the files — counts.)
      const m = readManifest(kind); if (!m) writeManifest(kind, bytes);
      set(kind, { phase: 'ready', bytes: m?.bytes ?? bytes, fail: undefined });
    } catch { set(kind, { phase: 'none', bytes: 0 }); }
    return getDictState(kind);
  })()).then(() => getDictState(kind)); // (as it is when asked for, not as it was when first looked at)
}

const isAbort = (e: unknown): boolean => (e as { name?: string })?.name === 'AbortError';
class DictError extends Error { constructor(public fail: DictFail, public code?: number) { super(`dict:${fail}${code ? ':' + code : ''}`); } }

/** One file's bytes, as they come (progress), complete. Native shells go through their own HTTP when the page's fetch is refused. */
async function fetchBytes(url: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<{ bytes: Uint8Array; length: number | null }> {
  let r: Response;
  try { r = await fetch(url, { signal }); }
  catch (e) {
    if (isAbort(e) || signal.aborted) throw e;
    if (!isWebOnly()) {
      try { const h = await http(url, { binary: true }); if (h.status >= 200 && h.status < 300) { const bytes = await bodyBytes(h); onBytes(bytes.length); return { bytes, length: null }; } throw new DictError('http', h.status); }
      catch (e2) { if (e2 instanceof DictError) throw e2; }
    }
    throw new DictError(navigator.onLine === false ? 'offline' : 'network');
  }
  if (!r.ok) throw new DictError('http', r.status);
  // (A length is compared only when nothing was compressed on the way: then it is the length of what is read.)
  const encoded = (r.headers.get('content-encoding') ?? 'identity') !== 'identity';
  const length = encoded ? null : (Number(r.headers.get('content-length')) || null);
  const parts: Uint8Array[] = []; let got = 0;
  try {
    if (r.body) { const rd = r.body.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onBytes(value.length); } }
    else { const b = new Uint8Array(await r.arrayBuffer()); parts.push(b); got = b.length; onBytes(b.length); }
  } catch (e) {
    if (isAbort(e) || signal.aborted) throw e;
    throw new DictError(navigator.onLine === false ? 'offline' : 'network');
  }
  const bytes = new Uint8Array(got); let at = 0; for (const p of parts) { bytes.set(p, at); at += p.length; }
  return { bytes, length };
}
/** A file that arrived whole and is what it should be: the bytes as long as the server said; a dictionary file gzip; a script, script. */
function checkBytes(f: DictFile, bytes: Uint8Array, length: number | null): void {
  if (!bytes.length || (length !== null && length !== bytes.length)) throw new DictError('corrupt');
  if (f.kind === 'gz' && !(bytes[0] === 0x1f && bytes[1] === 0x8b)) throw new DictError('corrupt');
  if (f.kind === 'js' && (bytes[0] === 0x3c /* < : a page, not a script */)) throw new DictError('corrupt');
}

async function run(kind: DictKind, signal: AbortSignal): Promise<boolean> {
  const spec = SPEC[kind];
  if (!hasCache()) { set(kind, { phase: 'error', fail: 'unsupported', code: undefined }); return false; }
  const total = dictSize(kind); let done = 0; let last = 0;
  set(kind, { phase: 'downloading', done: 0, total, fail: undefined, code: undefined });
  const tick = (n: number): void => { done += n; const now = Date.now(); if (now - last > 80) { last = now; set(kind, { done: Math.min(done, total) }); } };
  try {
    const c = await caches.open(CACHE); let bytes = 0;
    for (const f of spec.files) {
      const url = dictUrl(kind, f);
      const have = await c.match(url);
      if (have) { const n = Number(have.headers.get('content-length')) || f.size; bytes += n; tick(n); continue; } // (kept from a try that stopped)
      let got = 0;
      const { bytes: data, length } = await fetchBytes(url, signal, (n) => { got += n; tick(n); });
      done -= got; // (counted again below, whole, once it is kept)
      checkBytes(f, data, length);
      try { await c.put(url, new Response(data as BlobPart, { headers: { 'content-type': f.kind === 'gz' ? 'application/gzip' : 'application/javascript', 'content-length': String(data.length) } })); }
      catch (e) { throw (e as { name?: string })?.name === 'QuotaExceededError' ? new DictError('space') : new DictError('network'); }
      bytes += data.length; tick(data.length);
    }
    writeManifest(kind, bytes); checking[kind] = Promise.resolve({ ...state[kind], phase: 'ready' });
    set(kind, { phase: 'ready', bytes, done: total, fail: undefined, code: undefined });
    return true;
  } catch (e) {
    if (isAbort(e) || signal.aborted) { set(kind, { phase: 'none', done: 0 }); delete checking[kind]; return false; }
    const fail = e instanceof DictError ? e.fail : 'network';
    delete checking[kind];
    set(kind, { phase: 'error', fail, code: e instanceof DictError ? e.code : undefined, done: 0 });
    return false;
  }
}

/** Download (or go on with the download going; or finish a half one). Resolves true when the dictionary is on the device. */
export function downloadDict(kind: DictKind): Promise<boolean> {
  const live = jobs[kind]; if (live) return live.done;
  if (state[kind].phase === 'ready') return Promise.resolve(true);
  const ctl = new AbortController();
  const done = run(kind, ctl.signal).finally(() => { if (jobs[kind]?.ctl === ctl) delete jobs[kind]; });
  jobs[kind] = { ctl, done };
  return done;
}
/** Stop a download going on. What was finished stays for the next try, but is not used. */
export function cancelDict(kind: DictKind): void { jobs[kind]?.ctl.abort(); }
export const isDownloading = (kind: DictKind): boolean => !!jobs[kind];

/** Say that what was on the device did not work (it has been removed): the reason is shown where the dictionary is offered. */
export function markDictFailed(kind: DictKind, fail: DictFail): void { set(kind, { phase: 'error', fail, done: 0 }); }

/** Take the dictionary off the device. */
export async function removeDict(kind: DictKind): Promise<void> {
  const j = jobs[kind]; if (j) { j.ctl.abort(); await j.done.catch(() => false); }
  dropManifest(kind); delete checking[kind];
  if (hasCache()) { try { const c = await caches.open(CACHE); for (const f of SPEC[kind].files) await c.delete(dictUrl(kind, f)); } catch { /* */ } }
  forgetLoaded(kind);
  set(kind, { phase: 'none', bytes: 0, done: 0, fail: undefined, code: undefined });
}

/* ---------------------------------------------------------------- loading from the device */
const loadedHooks: Partial<Record<DictKind, () => void>> = {};
/** The code that built something from the dictionary says how to forget it (removing the dictionary). */
export function onDictForget(kind: DictKind, fn: () => void): void { loadedHooks[kind] = fn; }
function forgetLoaded(kind: DictKind): void { loadedHooks[kind]?.(); }

/** The dictionary complete on the device, or an error 'dict-missing' (the caller shows the notice that offers the download). */
/** Is this error the one that says a dictionary is not on the device, or is there but would not load (and which)? */
export const missingDict = (e: unknown): DictKind | null => (/^dict-(missing|load)$/.test((e as { message?: string })?.message ?? '') ? ((e as { dictKind?: DictKind }).dictKind ?? null) : null);
export async function requireDict(kind: DictKind): Promise<void> {
  const s = await refreshDictState(kind);
  if (s.phase !== 'ready') throw Object.assign(new Error('dict-missing'), { dictKind: kind });
}
/** A script kept on the device, as a blob address (to be revoked by the caller). */
export async function dictScriptUrl(kind: DictKind): Promise<string> {
  const f = SPEC[kind].files.find((x) => x.kind === 'js')!;
  const hit = await (await caches.open(CACHE)).match(dictUrl(kind, f));
  if (!hit) { delete checking[kind]; set(kind, { phase: 'none', bytes: 0 }); dropManifest(kind); throw Object.assign(new Error('dict-missing'), { dictKind: kind }); }
  return URL.createObjectURL(new Blob([await hit.arrayBuffer()], { type: 'text/javascript' }));
}
let undoLocal: (() => void) | null = null;
/** Let go of what withLocalKuromoji set up (its requests answered locally, its blob addresses) — also when its loader never answered. */
export function abandonLocalKuromoji(): void { const u = undoLocal; undoLocal = null; u?.(); }
/** While `fn` runs, kuromoji's requests for its dictionary files are answered from the device (not the network). */
export async function withLocalKuromoji<T>(fn: () => Promise<T>): Promise<T> {
  abandonLocalKuromoji();
  const c = await caches.open(CACHE); const map = new Map<string, string>();
  const proto = XMLHttpRequest.prototype; const open = proto.open; let patched = false;
  const undo = () => { if (patched) { proto.open = open; patched = false; } for (const u of map.values()) URL.revokeObjectURL(u); map.clear(); if (undoLocal === undo) undoLocal = null; };
  undoLocal = undo;
  try {
    for (const f of SPEC.ja.files) {
      if (f.kind !== 'gz') continue;
      const hit = await c.match(dictUrl('ja', f));
      if (!hit) { delete checking.ja; set('ja', { phase: 'none', bytes: 0 }); dropManifest('ja'); throw Object.assign(new Error('dict-missing'), { dictKind: 'ja' as DictKind }); }
      map.set(dictUrl('ja', f), URL.createObjectURL(await hit.blob()));
    }
    // (kuromoji joins the folder and the name itself, which can leave «https:/host/…»: read as an address first.)
    proto.open = function (this: XMLHttpRequest, ...a: unknown[]): void {
      try { const local = map.get(new URL(String(a[1]), location.href).href); if (local) a[1] = local; } catch { /* as it was */ }
      return (open as (...x: unknown[]) => void).apply(this, a);
    } as typeof proto.open;
    patched = true;
    return await fn();
  } finally { undo(); }
}

/** Say that what was on the device did not work (see markDictFailed) — here as the error the callers see. */
export function loadFailed(kind: DictKind, cause: unknown): Error {
  console.warn('reading dictionary did not load', kind, cause);
  markDictFailed(kind, 'load');
  return Object.assign(new Error('dict-load'), { dictKind: kind });
}
/** A time limit on something that may never answer (a loader that never calls back). */
export function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  const ms = Number((window as unknown as { __krDictLoadMs?: number }).__krDictLoadMs) || 40000;
  let id = 0;
  return Promise.race([p, new Promise<never>((_, rej) => { id = window.setTimeout(() => rej(new Error(`${what}: timeout`)), ms); })]).finally(() => window.clearTimeout(id));
}
