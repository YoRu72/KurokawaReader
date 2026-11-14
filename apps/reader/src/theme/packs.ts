// Theme packs: the heavy part of a theme (its pictures) fetched when the reader asks for it, checked, kept, and
// removed again. Shared by the Kurokawa apps: the app hands in how to fetch and where to keep (`PackIO`).
//
// A pack is one file, `<id>.ktheme`:
//   bytes 0–7   "KTHEME1\n"
//   bytes 8–11  the header's length N (unsigned, big-endian)
//   N bytes     the header, JSON: { format: 1, id, name, by, version, license: { spdx, notice },
//               assets: [{ name, type, size, sha256, offset }], tokens?: ThemeDef }
//   the rest    the assets' bytes, each at its offset (counted from the end of the header), unchanged.
// The index beside the packs, `themes.json`: { format: 1, themes: [{ id, file, size, sha256, name, by, version,
// assets: [names], preview: { dark?: [ground, glass, accent], light?: [...] } }] } — size and sha256 of the file.

export interface IndexEntry { id: string; file: string; size: number; sha256: string; name: string; by?: string; version: string; assets: string[]; preview?: Partial<Record<'dark' | 'light', string[]>> }
export interface PackIndex { format: number; themes: IndexEntry[] }
export interface PackAsset { name: string; type: string; size: number; sha256: string; offset: number }
export interface PackHeader { format: number; id: string; name: string; by?: string; version: string; license?: { spdx: string; notice: string }; assets: PackAsset[]; tokens?: unknown }
export interface Installed { id: string; version: string; size: number; assets: string[]; at: number; notice?: string; name?: string; by?: string; /** A theme not built into the app brings its tokens (a ThemeDef). */ def?: unknown }
export interface PackIO {
  /** Where themes.json is; pack files are read beside it. */
  indexUrl: string;
  /** The bytes at `url`; `progress(done, total)` as they come. Throws when offline or not 200. */
  fetchBytes(url: string, progress?: (done: number, total: number) => void): Promise<Uint8Array>;
  getFile(key: string): Promise<Blob | undefined>; putFile(key: string, b: Blob): Promise<void>; deleteFile(key: string): Promise<void>;
  getMeta<T>(key: string): Promise<T | undefined>; setMeta<T>(key: string, v: T): Promise<void>;
}
export type PackErrorKind = 'offline' | 'missing' | 'checksum' | 'storage' | 'format';
export class PackError extends Error { constructor(public kind: PackErrorKind, msg: string) { super(msg); } }

const MAGIC = 'KTHEME1\n';
const META = 'themes.installed';
const fileKey = (id: string, asset: string) => `theme:${id}:${asset}`;

export async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}
/** Reads a pack's header and its assets' bytes; checks each asset's checksum. */
export async function parsePack(buf: Uint8Array): Promise<{ header: PackHeader; assets: { a: PackAsset; bytes: Uint8Array }[] }> {
  if (buf.length < 12 || new TextDecoder().decode(buf.subarray(0, 8)) !== MAGIC) throw new PackError('format', 'not a theme pack');
  const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(8);
  if (12 + n > buf.length) throw new PackError('format', 'header past the end');
  let header: PackHeader; try { header = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + n))) as PackHeader; } catch { throw new PackError('format', 'header unreadable'); }
  if (header.format !== 1 || !header.id || !Array.isArray(header.assets)) throw new PackError('format', 'unknown pack format');
  const data = buf.subarray(12 + n); const assets: { a: PackAsset; bytes: Uint8Array }[] = [];
  for (const a of header.assets) {
    if (a.offset < 0 || a.offset + a.size > data.length) throw new PackError('format', `asset ${a.name} past the end`);
    const bytes = data.subarray(a.offset, a.offset + a.size);
    if ((await sha256Hex(bytes)) !== a.sha256) throw new PackError('checksum', `asset ${a.name}: checksum differs`);
    assets.push({ a, bytes });
  }
  return { header, assets };
}
/** Builds a pack (the build script uses it too, from Node). */
export async function buildPack(header: Omit<PackHeader, 'assets'>, files: { name: string; type: string; bytes: Uint8Array }[]): Promise<Uint8Array> {
  let off = 0; const assets: PackAsset[] = [];
  for (const f of files) { assets.push({ name: f.name, type: f.type, size: f.bytes.length, sha256: await sha256Hex(f.bytes), offset: off }); off += f.bytes.length; }
  const head = new TextEncoder().encode(JSON.stringify({ ...header, assets }));
  const out = new Uint8Array(12 + head.length + off); out.set(new TextEncoder().encode(MAGIC), 0); new DataView(out.buffer).setUint32(8, head.length); out.set(head, 12);
  let p = 12 + head.length; for (const f of files) { out.set(f.bytes, p); p += f.bytes.length; }
  return out;
}

/** A failed fetch: not there (404: the theme is not published yet) or no way through (offline, refused). */
const offline = (e: unknown): PackError => { if (e instanceof PackError) return e; const m = String((e as Error)?.message ?? e); return new PackError(/\b404\b/.test(m) ? 'missing' : 'offline', m); };
let indexCache: { url: string; at: number; ix: PackIndex } | null = null;
/** The index (kept 10 minutes); throws PackError('offline') when it cannot be reached. */
export async function loadIndex(io: PackIO, fresh = false): Promise<PackIndex> {
  if (!fresh && indexCache && indexCache.url === io.indexUrl && Date.now() - indexCache.at < 600e3) return indexCache.ix;
  let bytes: Uint8Array; try { bytes = await io.fetchBytes(io.indexUrl); } catch (e) { throw offline(e); }
  let ix: PackIndex; try { ix = JSON.parse(new TextDecoder().decode(bytes)) as PackIndex; } catch { throw new PackError('format', 'index unreadable'); }
  if (ix.format !== 1 || !Array.isArray(ix.themes)) throw new PackError('format', 'unknown index format');
  indexCache = { url: io.indexUrl, at: Date.now(), ix }; return ix;
}
export const forgetIndex = (): void => { indexCache = null; };

export async function installed(io: PackIO): Promise<Record<string, Installed>> { try { return (await io.getMeta<Record<string, Installed>>(META)) ?? {}; } catch { return {}; } }

/** Fetches a pack, checks it against the index's checksum and its own, keeps its assets. */
export async function installPack(io: PackIO, id: string, progress?: (done: number, total: number) => void): Promise<Installed> {
  const ix = await loadIndex(io); const e = ix.themes.find((x) => x.id === id);
  if (!e) throw new PackError('missing', `no pack ${id}`);
  const url = new URL(e.file, io.indexUrl).href;
  let buf: Uint8Array; try { buf = await io.fetchBytes(url, (d, t) => progress?.(d, t || e.size)); } catch (err) { throw offline(err); }
  // (A mismatch may be the list's as much as the file's: both are read afresh on the next try.)
  if (buf.length !== e.size || (await sha256Hex(buf)) !== e.sha256) { indexCache = null; throw new PackError('checksum', `${e.file}: checksum differs`); }
  const { header, assets } = await parsePack(buf);
  if (header.id !== id) throw new PackError('format', 'pack is for another theme');
  try { for (const { a, bytes } of assets) await io.putFile(fileKey(id, a.name), new Blob([bytes as unknown as BlobPart], { type: a.type })); }
  catch (err) { for (const { a } of assets) await io.deleteFile(fileKey(id, a.name)).catch(() => undefined); throw new PackError('storage', String((err as Error)?.message ?? err)); }
  const rec: Installed = { id, version: header.version, size: e.size, assets: assets.map((x) => x.a.name), at: Date.now(), notice: header.license?.notice, name: header.name, by: header.by, def: header.tokens };
  const all = await installed(io); all[id] = rec;
  try { await io.setMeta(META, all); } catch (err) { throw new PackError('storage', String((err as Error)?.message ?? err)); }
  dropUrls(id); return rec;
}
export async function removePack(io: PackIO, id: string): Promise<void> {
  const all = await installed(io); const rec = all[id]; if (!rec) return;
  for (const a of rec.assets) await io.deleteFile(fileKey(id, a)).catch(() => undefined);
  delete all[id]; await io.setMeta(META, all); dropUrls(id);
}
const urls = new Map<string, Record<string, string>>();
function dropUrls(id: string): void { const u = urls.get(id); if (u) Object.values(u).forEach((x) => URL.revokeObjectURL(x)); urls.delete(id); }
/** Object URLs of an installed pack's pictures (empty when it is not here). */
export async function pictureUrls(io: PackIO, id: string): Promise<Record<string, string>> {
  const have = urls.get(id); if (have) return have;
  const rec = (await installed(io))[id]; if (!rec) return {};
  const out: Record<string, string> = {};
  for (const a of rec.assets) { const b = await io.getFile(fileKey(id, a)).catch(() => undefined); if (b) out[a] = URL.createObjectURL(b); }
  urls.set(id, out); return out;
}
