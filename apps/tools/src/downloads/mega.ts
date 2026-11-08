// MEGA links (mega.nz): a file or a whole folder, the way MEGA's own app reads them. The link's key (after «#»)
// opens the file's name and the folder's tree, read from MEGA's API; each file is then downloaded like any other —
// several connections, resumable — from the storage address MEGA gives, and decrypted as it is written (the phone's
// downloader; a computer decrypts it once whole). Only the key in the link is used; nothing is sent to MEGA but the
// requests its site makes.
import { request } from '../http';
import type { AddOptions, Engine, Task } from '../engine/types';
import type { CloudFile, CloudInfo } from './cloud';

/** A MEGA link of any form: mega.nz/file/…#key, /folder/…#key (and a file or folder inside it), /embed/…, and the
 *  old #!id!key and #F!id!key. */
const RE = /https?:\/\/(?:www\.)?mega(?:\.co)?\.nz\/(?:(file|embed)\/([\w-]{6,})#([\w-]{20,})|folder\/([\w-]{6,})#([\w-]{16,})(?:\/(file|folder)\/([\w-]{6,}))?|#(F?)!([\w-]{6,})!([\w-]{16,})(?:!([\w-]{6,}))?)/i;
export const isMega = (u: string): boolean => RE.test(u);
/** Every MEGA link in a text (a page's, a pasted list). */
export function megaLinks(text: string): string[] { const g = new RegExp(RE.source, 'gi'); return [...new Set([...text.matchAll(g)].map((m) => m[0]))]; }

type Link = { kind: 'file'; id: string; key: Uint8Array } | { kind: 'folder'; id: string; key: Uint8Array; sub?: { kind: 'file' | 'folder'; id: string } };
const b64u = (s: string): Uint8Array => { const t = s.replace(/-/g, '+').replace(/_/g, '/').replace(/,/g, ''); const b = atob(t + '='.repeat((4 - (t.length % 4)) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
const toB64u = (b: Uint8Array): string => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function parseMega(u: string): Link | null {
  const m = RE.exec(u); if (!m) return null;
  if (m[1]) return { kind: 'file', id: m[2], key: b64u(m[3]) };
  if (m[4]) return { kind: 'folder', id: m[4], key: b64u(m[5]), sub: m[6] ? { kind: m[6] as 'file' | 'folder', id: m[7] } : undefined };
  if (m[8]) return { kind: 'folder', id: m[9], key: b64u(m[10]), sub: m[11] ? { kind: 'folder', id: m[11] } : undefined };
  return { kind: 'file', id: m[9], key: b64u(m[10]) };
}

/* ---------- AES, through the page's own crypto (no library): ECB and CBC without padding ---------- */
const keyCache = new Map<string, Promise<CryptoKey>>();
const aesKey = (k: Uint8Array) => { const id = toB64u(k); let p = keyCache.get(id); if (!p) { p = crypto.subtle.importKey('raw', k.slice().buffer as ArrayBuffer, 'AES-CBC', false, ['encrypt', 'decrypt']); keyCache.set(id, p); } return p; };
/** CBC decryption of whole blocks with no padding: WebCrypto insists on padding, so a block that decrypts to a valid
 *  one is added at the end (the padding encrypted after the last block) and taken off again. */
async function cbcDecrypt(k: Uint8Array, data: Uint8Array, iv = new Uint8Array(16)): Promise<Uint8Array> {
  const key = await aesKey(k); const last = data.slice(data.length - 16);
  const extra = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, key, new Uint8Array(16).fill(16))).slice(0, 16);
  const all = new Uint8Array(data.length + 16); all.set(data); all.set(extra, data.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, all));
}
/** ECB: each block decrypted on its own (CBC with a zero IV, one block at a time). */
async function ecbDecrypt(k: Uint8Array, data: Uint8Array): Promise<Uint8Array> { const out = new Uint8Array(data.length); for (let i = 0; i < data.length; i += 16) out.set(await cbcDecrypt(k, data.slice(i, i + 16)), i); return out; }
/** A file's 32-byte key folded into its AES key (the two halves XORed). */
const fold = (k: Uint8Array): Uint8Array => (k.length === 32 ? Uint8Array.from({ length: 16 }, (_, i) => k[i] ^ k[i + 16]) : k);
async function attrs(at: string, k: Uint8Array): Promise<{ n?: string }> {
  try { const raw = await cbcDecrypt(fold(k), b64u(at)); const s = new TextDecoder().decode(raw).replace(/\0+$/, ''); return s.startsWith('MEGA{') ? JSON.parse(s.slice(4)) : {}; } catch { return {}; }
}

/* ---------- MEGA's API ---------- */
const ERR: Record<number, string> = { [-2]: 'megaErrArgs', [-9]: 'megaErrGone', [-11]: 'megaErrAccess', [-16]: 'megaErrBlocked', [-17]: 'megaErrQuota', [-18]: 'megaErrBusy' };
export class MegaError extends Error { constructor(public code: number) { super(ERR[code] ?? `MEGA ${code}`); } }
let seq = Math.floor(Math.random() * 1e9);
async function api<T>(body: unknown[], node?: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await request(`https://g.api.mega.co.nz/cs?id=${seq++}${node ? `&n=${node}` : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status !== 200) { if (attempt < 3) { await new Promise((ok) => setTimeout(ok, 800 * (attempt + 1))); continue; } throw new Error(`MEGA: HTTP ${r.status}`); }
    const j = JSON.parse(r.body) as unknown;
    // (A number is an error: -3 «try again» is tried again, a moment later each time.)
    const code = typeof j === 'number' ? j : Array.isArray(j) && typeof j[0] === 'number' ? j[0] : 0;
    if (code === -3 && attempt < 5) { await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1))); continue; }
    if (code < 0) throw new MegaError(code);
    return (j as T[])[0];
  }
}

export interface MegaFile extends CloudFile { handle: string; key: Uint8Array; folder?: string }
export type MegaInfo = CloudInfo<MegaFile>;

/** What a link holds: its name and its files (a folder's with their place in it). */
export async function megaInfo(u: string): Promise<MegaInfo> {
  const l = parseMega(u); if (!l) throw new Error('mega-link');
  if (l.kind === 'file') {
    const r = await api<{ s: number; at: string }>([{ a: 'g', p: l.id }]);
    const name = (await attrs(r.at, l.key)).n || `${l.id}.bin`;
    return { service: 'MEGA', name, folder: false, files: [{ id: l.id, handle: l.id, name, path: name, size: r.s, key: l.key }] };
  }
  type Node = { h: string; p: string; t: number; a: string; k: string; s?: number };
  const r = await api<{ f: Node[] }>([{ a: 'f', c: 1, r: 1, ca: 1 }], l.id);
  const keyOf = async (n: Node): Promise<Uint8Array | null> => {
    const part = n.k.split('/').map((x) => x.split(':')[1]).find(Boolean); if (!part) return null;
    try { const enc = b64u(part); return await ecbDecrypt(l.key, enc); } catch { return null; }
  };
  const nodes = new Map<string, { n: Node; name: string; key: Uint8Array }>();
  for (const n of r.f) { const k = await keyOf(n); if (!k) continue; nodes.set(n.h, { n, name: (await attrs(n.a, k)).n || n.h, key: k }); }
  // (The tree's top: the folder the link opens — or the one inside it the link points to.)
  const topId = l.sub?.kind === 'folder' ? l.sub.id : [...nodes.values()].find((x) => x.n.t === 1 && !nodes.has(x.n.p))?.n.h;
  const pathOf = (h: string): string[] => { const out: string[] = []; for (let x = nodes.get(h); x && x.n.h !== topId; x = nodes.get(x.n.p)) out.unshift(x.name); return out; };
  const under = (h: string) => { for (let x = nodes.get(h); x; x = nodes.get(x.n.p)) if (x.n.h === topId) return true; return false; };
  const top = topId ? nodes.get(topId) : undefined;
  let files = [...nodes.values()].filter((x) => x.n.t === 0 && (!topId || under(x.n.h)));
  if (l.sub?.kind === 'file') files = files.filter((x) => x.n.h === l.sub!.id);
  return { service: 'MEGA', name: top?.name ?? l.id, folder: true, files: files.map((x) => { const p = pathOf(x.n.h); return { id: x.n.h, handle: x.n.h, name: x.name, path: p.join('/'), size: x.n.s ?? 0, key: x.key, folder: l.id }; }).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })) };
}

/** A file's storage address now (MEGA gives a fresh one each time; it lasts some hours). */
export async function megaUrl(f: MegaFile): Promise<string> {
  const r = await api<{ g: string | string[] }>(f.folder ? [{ a: 'g', g: 1, n: f.handle, ssl: 2 }] : [{ a: 'g', g: 1, p: f.handle, ssl: 2 }], f.folder);
  const g = Array.isArray(r.g) ? r.g[0] : r.g; if (!g) throw new MegaError(-9); return g;
}

/** The files added as downloads (a folder's in its own folder, its tree kept: `dirFor`). */
export async function addMegaFiles(eng: Engine, info: MegaInfo, files: MegaFile[], base: Omit<AddOptions, 'source'>, link: string, dirFor: (f: MegaFile) => string | undefined): Promise<Task[]> {
  const out: Task[] = [];
  for (const f of files) {
    const url = await megaUrl(f);
    out.push(await eng.add({ ...base, source: { url }, dir: dirFor(f), name: f.name, meta: { ...(base.meta ?? {}), megaKey: toB64u(f.key), mega: link, megaHandle: f.handle, ...(f.folder ? { megaFolder: f.folder } : {}) } }));
  }
  return out;
}
/** A MEGA download whose storage address ran out (it lasts some hours): a new one asked of MEGA and the download
 *  taken up again — once per download while the app runs. */
const renewed = new Set<string>();
export async function renewFailed(eng: Engine, tasks: Task[]): Promise<void> {
  for (const x of tasks) {
    if (x.state !== 'failed' || !x.meta?.megaHandle || renewed.has(x.id) || !eng.setUrl) continue; renewed.add(x.id);
    try { const url = await megaUrl({ id: x.meta.megaHandle, handle: x.meta.megaHandle, folder: x.meta.megaFolder, name: x.name, path: x.name, size: x.total, key: new Uint8Array() }); await eng.setUrl(x.id, url); await eng.resume(x.id); } catch { /* left failed: its error stays */ }
  }
}

/** On a computer (aria2 keeps what MEGA sends as it is): each finished MEGA file decrypted once, in its place. */
const CLEAR = 'kt.megaClear';
export async function afterDone(tasks: Task[]): Promise<void> {
  const d = window.kurokawaTools as unknown as { megaDecrypt?(o: { path: string; key: string }): Promise<boolean> } | undefined; if (!d?.megaDecrypt) return;
  let done: string[] = []; try { done = JSON.parse(localStorage.getItem(CLEAR) ?? '[]'); } catch { /* none */ }
  for (const x of tasks) {
    const key = x.meta?.megaKey as string | undefined; if (!key || x.state !== 'done' || done.includes(x.id) || busy.has(x.id)) continue;
    busy.add(x.id);
    try { const path = `${(x.dir ?? '').replace(/[\\/]$/, '')}/${x.name}`; await d.megaDecrypt({ path, key }); done = [...done, x.id].slice(-500); try { localStorage.setItem(CLEAR, JSON.stringify(done)); } catch { /* full */ } }
    catch { /* tried again on the next change */ } finally { busy.delete(x.id); }
  }
}
const busy = new Set<string>();
