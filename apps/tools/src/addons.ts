// The add-ons: listed by the Kurokawa repository (repo/tools/index.json), parents with their children, each
// installed on its own — its code fetched and kept here, its settings in the app. Nothing of an add-on is in
// the app before it is installed.
import { APP_VERSION } from './repo';
import { db } from './db';
import { getSettings, updateSettings } from './settings';

export type AddonKind = 'group' | 'torrent-search' | 'anime' | 'anime-provider' | 'subtitles' | 'subtitle-source' | 'debrid' | 'archives' | 'player' | 'source' | 'video' | 'tv' | 'screen' | 'files' | 'courses';
export interface AddonEntry {
  id: string;
  name: string;
  /** Names in other languages, by code. */
  names?: Record<string, string>;
  kind: AddonKind;
  description?: string;
  descriptions?: Record<string, string>;
  version: string;
  /** The add-on's code (a module the app loads) and/or its manifest, relative to repo/tools/. */
  module?: string;
  manifest?: string;
  /** A parent's children (ids). */
  children?: string[];
  parent?: string;
  /** The platforms it runs on; undefined: all. */
  platforms?: ('android' | 'desktop' | 'web' | 'ios')[];
  icon?: string;
  /** Fields the user fills in for this add-on (a debrid key, a choice), shown in its settings. */
  settings?: AddonSetting[];
  /** Native parts it needs, fetched when it is installed (Python and ffmpeg; see packs.ts). */
  packs?: ('python' | 'ffmpeg')[];
  /** The module's SHA-256 (hex) and size in bytes (scripts/addons-index.mjs writes them); the manifest's likewise. */
  sha256?: string; size?: number; manifestSha256?: string; manifestSize?: number;
  /** The lowest app version this entry runs on: an older app does not take it («needs the app update»). */
  minApp?: string;
  /** Installed even when its version is not higher (a deliberate downgrade). */
  force?: boolean;
}
export interface AddonSetting { id: string; label: string; labels?: Record<string, string>; type: 'text' | 'password' | 'number' | 'select' | 'toggle'; options?: string[]; value?: string | number | boolean }
export interface AddonIndex { kurokawa: 'addons'; app: 'tools'; addons: AddonEntry[] }

const INDEX_KEY = 'addons:index';
const STATUS_KEY = 'addons:status';
const INDEX_PATH = 'tools/index.json';
let index: AddonIndex | null = null;

/** Versions as dotted numbers (1.10 after 1.9; a missing part is 0). */
export function cmpDotted(a: string, b: string): number {
  const pa = String(a ?? '').replace(/^v/, '').split(/[.+-]/).map((x) => Number(x) || 0), pb = String(b ?? '').replace(/^v/, '').split(/[.+-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] ?? 0) - (pb[i] ?? 0); if (d) return d; }
  return 0;
}
const HEX64 = /^[0-9a-f]{64}$/i;
/** The index's shape checked (anything else is refused, and the kept copy stays). */
function checkIndex(x: unknown): AddonIndex {
  const o = x as AddonIndex;
  if (!o || typeof o !== 'object' || o.kurokawa !== 'addons' || !Array.isArray(o.addons)) throw new Error('not an add-on index');
  for (const a of o.addons) if (!a || typeof a.id !== 'string' || typeof a.version !== 'string') throw new Error('an entry without id or version');
  return o;
}
/** The repository's list (kept for offline; `fresh` asks the repository again — through catalog.ts: revalidated,
 *  hashed, the last good copy kept, backed off on failure). Throws only when there was never a list. */
export async function loadIndex(fresh = false): Promise<AddonIndex> {
  if (index && !fresh) return index;
  const { readCatalog } = await import('./catalog');
  if (!fresh) {
    const k = await readCatalog(INDEX_PATH, checkIndex, { offlineOnly: true }); if (k.data) return (index = k.data);
    const old = await db.getMeta<AddonIndex>(INDEX_KEY).catch(() => undefined); if (old) return (index = old);
  }
  const got = await readCatalog(INDEX_PATH, checkIndex);
  if (got.data) return (index = got.data);
  if (index) return index;
  throw new Error(got.error ?? 'offline');
}
/** The index as the checker reads it (catalog.ts: kept copy on failure, never throws). */
export async function readIndex(manual = false): Promise<import('./catalog').CatalogResult<AddonIndex>> {
  const { readCatalog } = await import('./catalog'); const r = await readCatalog(INDEX_PATH, checkIndex, { auto: !manual }); if (r.data) index = r.data; return r;
}
export const indexNow = (): AddonIndex | null => index;
export const installed = (id: string): boolean => getSettings().addons.includes(id);

/* ---------- integrity, versions and the atomic swap ---------- */
export type AddonFail = 'checksum' | 'size' | 'nohash' | 'import' | 'http' | 'needsApp';
export class AddonError extends Error { constructor(public kind: AddonFail, msg: string) { super(msg); } }
/** What the app knows of each add-on's last update: when, from and to which version, a failure's reason, the app
 *  version an update waits for. Shown in Settings › Add-ons. */
export interface AddonStatus { at?: number; from?: string; to?: string; failed?: { version: string; kind: AddonFail; at: number }; needsApp?: { version: string; minApp: string } }
export async function addonStatus(): Promise<Record<string, AddonStatus>> { try { return (await db.getMeta<Record<string, AddonStatus>>(STATUS_KEY)) ?? {}; } catch { return {}; } }
async function setStatus(id: string, f: (s: AddonStatus) => AddonStatus): Promise<void> { const all = await addonStatus(); all[id] = f(all[id] ?? {}); await db.setMeta(STATUS_KEY, all).catch(() => undefined); }
export const installedVersion = (id: string): Promise<string | undefined> => db.getMeta<string>(`addon-version:${id}`).catch(() => undefined);
/** The running app is older than an entry needs. */
export const needsApp = (e: AddonEntry): boolean => !!e.minApp && cmpDotted(APP_VERSION, e.minApp) < 0;
/** Once one module of the index carries a checksum (the new index), a module without one is refused; an old index
 *  (none carries one, as one kept from before the rollout) installs as it always did. */
const indexHashed = (ix: AddonIndex): boolean => ix.addons.some((a) => !!a.module && !!a.sha256);
const MODULE_MAX = 2 * 1024 * 1024;
async function fetchChecked(path: string, sha: string | undefined, size: number | undefined, hashed: boolean): Promise<Uint8Array> {
  const { repoBytes, sha256Hex } = await import('./catalog');
  let bytes: Uint8Array; try { bytes = (await repoBytes(`tools/${path}`)).bytes; } catch (e) { throw new AddonError('http', String((e as Error)?.message ?? e)); }
  if (bytes.length > MODULE_MAX) throw new AddonError('size', `${path}: too large`);
  if (sha && HEX64.test(sha)) {
    if (size !== undefined && bytes.length !== size) throw new AddonError('size', `${path}: ${bytes.length} bytes, the index says ${size}`);
    if ((await sha256Hex(bytes)) !== sha.toLowerCase()) throw new AddonError('checksum', `${path}: checksum differs`);
  } else if (hashed) throw new AddonError('nohash', `${path}: no checksum in the index`);
  return bytes;
}
const jsBlob = (b: Uint8Array) => new Blob([b as unknown as BlobPart], { type: 'text/javascript' });  // (GitHub serves .mjs as text/plain; a module import needs a script type)
/** One add-on's files fetched, checked, stored beside the current ones, imported once, and only then made current;
 *  on any failure the new copy is dropped and the installed one keeps working. */
async function fetchInto(a: AddonEntry, ix: AddonIndex): Promise<void> {
  if (needsApp(a)) throw new AddonError('needsApp', `${a.id} needs app ${a.minApp}`);
  const hashed = indexHashed(ix);
  let mod: Uint8Array | null = null; let man: unknown = undefined;
  if (a.module) mod = await fetchChecked(a.module, a.sha256, a.size, hashed);
  if (a.manifest) { const b = await fetchChecked(a.manifest, a.manifestSha256, a.manifestSize, hashed && !!a.module); try { man = JSON.parse(new TextDecoder().decode(b)); } catch { throw new AddonError('import', `${a.manifest}: unreadable`); } }
  if (mod) {
    await db.putFile(`addon-next:${a.id}`, jsBlob(mod));
    const u = URL.createObjectURL(jsBlob(mod));
    try { await import(/* @vite-ignore */ u); }
    catch (e) { await db.deleteFile(`addon-next:${a.id}`).catch(() => undefined); throw new AddonError('import', String((e as Error)?.message ?? e)); }
    finally { URL.revokeObjectURL(u); }
    await db.putFile(`addon:${a.id}`, jsBlob(mod)); await db.deleteFile(`addon-next:${a.id}`).catch(() => undefined);
  }
  if (man !== undefined) await db.setMeta(`addon-manifest:${a.id}`, man);
  await db.setMeta(`addon-version:${a.id}`, a.version);
  forgetModule(a.id);
}
/** A loaded module of an add-on just replaced is loaded afresh (addons/search.ts and subs/search.ts listen). */
function forgetModule(id: string): void { try { window.dispatchEvent(new CustomEvent('kt:addon-updated', { detail: id })); } catch { /* no window */ } }

/** Installs an add-on (and its children): their modules fetched, checked and kept. */
export async function install(id: string): Promise<void> {
  const ix = await loadIndex();
  const e = ix.addons.find((a) => a.id === id); if (!e) throw new Error(id);
  if (needsApp(e)) { const { t } = await import('./i18n'); throw new AddonError('needsApp', t('addonNeedsAppError', { v: e.minApp! })); }
  if (e.packs?.length) {
    const { ensurePacks, packsHere } = await import('./packs'); const { t, getLang } = await import('./i18n');
    // (Install was pressed: the packs start at once, the card shows them coming and can cancel.)
    if (packsHere() && !(await ensurePacks(e.packs, t('packWhyAddon', { name: nameOf(e, getLang()) }), { start: true }))) throw Object.assign(new Error(t('cancelled')), { name: 'AbortError' });
  }
  const ids = [id, ...(e.children ?? [])];
  for (const k of ids) {
    const a = ix.addons.find((x) => x.id === k); if (!a || (k !== id && needsApp(a))) continue;
    await fetchInto(a, ix);
  }
  if (e.children?.length) await db.setMeta(`addon-children:${id}`, e.children);
  updateSettings({ addons: [...new Set([...getSettings().addons, ...ids.filter((k) => { const a = ix.addons.find((x) => x.id === k); return k === id || (a && !needsApp(a)); })])] });
}
export async function uninstall(id: string): Promise<void> {
  const ix = await loadIndex().catch(() => null);
  const e = ix?.addons.find((a) => a.id === id);
  const ids = [id, ...(e?.children ?? [])];
  for (const k of ids) { await db.deleteFile(`addon:${k}`).catch(() => undefined); await db.deleteFile(`addon-next:${k}`).catch(() => undefined); await db.deleteMeta(`addon-manifest:${k}`).catch(() => undefined); await db.deleteMeta(`addon-version:${k}`).catch(() => undefined); }
  updateSettings({ addons: getSettings().addons.filter((x) => !ids.includes(x)) });
  // Packs no other installed add-on needs are removed with it (Convert asks for ffmpeg again when it is used).
  if (e?.packs?.length && ix) {
    const still = new Set(getSettings().addons.flatMap((a) => ix.addons.find((x) => x.id === a)?.packs ?? []));
    const { removePack, packsHere, status } = await import('./packs');
    if (packsHere()) { const st = await status().catch(() => null); for (const n of e.packs) if (!still.has(n) && st?.[n]?.version) await removePack(n).catch(() => undefined); }
  }
}
/** Whether the index's entry is an update for what is installed: newer (dotted numbers), or different with `force`. */
const isUpdate = (e: AddonEntry, have: string | undefined): boolean => have === undefined || (e.force ? e.version !== have : cmpDotted(e.version, have) > 0);
/** Installed add-ons whose repository version moved on (and that this app can take). */
export async function updatesAvailable(): Promise<string[]> {
  const ix = await loadIndex(true).catch(() => null); if (!ix) return [];
  const out: string[] = [];
  for (const id of getSettings().addons) { const e = ix.addons.find((a) => a.id === id); if (!e || needsApp(e)) continue; if (isUpdate(e, await installedVersion(id))) out.push(id); }
  return out;
}
export interface UpdateReport { updated: { id: string; name: string; from: string; to: string }[]; failed: { id: string; kind: AddonFail }[]; waiting: string[] }
/** Installed add-ons brought up to date quietly: a newer module fetched, checked and swapped in, and a group's new
 *  sources added (the ones the user removed on purpose stay removed — only children the group did not have before).
 *  An update the app is too old for waits («needs the app update»); a failed one keeps the installed version and is
 *  tried again on the next check. `ix`: an index already read (the checker's). */
export async function autoUpdate(ix0?: AddonIndex): Promise<UpdateReport> {
  const rep: UpdateReport = { updated: [], failed: [], waiting: [] };
  const ix = ix0 ?? (await loadIndex(true).catch(() => null)); if (!ix) return rep;
  if (ix0) index = ix0;
  const { getLang } = await import('./i18n'); const lang = getLang();
  for (const id of [...getSettings().addons]) {
    const e = ix.addons.find((a) => a.id === id); if (!e) continue;
    const v = await installedVersion(id);
    if (needsApp(e)) { if (isUpdate(e, v)) { rep.waiting.push(id); await setStatus(id, (s) => ({ ...s, needsApp: { version: e.version, minApp: e.minApp! } })); } continue; }
    try {
      // (Only a newer version is taken — an older one in the index is a downgrade, refused unless it says `force`.)
      if (isUpdate(e, v)) {
        await fetchInto(e, ix);
        await setStatus(id, () => ({ at: Date.now(), from: v, to: e.version }));
        if (v !== undefined && (e.module || e.manifest)) rep.updated.push({ id, name: nameOf(e, lang), from: v, to: e.version });
      }
      if (e.children?.length) {
        const known = (await db.getMeta<string[]>(`addon-children:${id}`)) ?? e.children.filter((k) => getSettings().addons.includes(k));
        for (const k of e.children) if (!known.includes(k) && !getSettings().addons.includes(k)) { const c = ix.addons.find((x) => x.id === k); if (!c || needsApp(c)) continue; try { await fetchInto(c, ix); updateSettings({ addons: [...new Set([...getSettings().addons, k])] }); await setStatus(k, () => ({ at: Date.now(), to: c.version })); } catch (er) { rep.failed.push({ id: k, kind: er instanceof AddonError ? er.kind : 'http' }); } }
        await db.setMeta(`addon-children:${id}`, e.children);
      }
    } catch (er) {
      const kind: AddonFail = er instanceof AddonError ? er.kind : 'http';
      rep.failed.push({ id, kind });
      // (Offline is no failure worth showing: tried again next time, nothing recorded.)
      if (kind !== 'http') await setStatus(id, (s) => ({ ...s, failed: { version: e.version, kind, at: Date.now() } }));
    }
  }
  return rep;
}
/** An installed add-on's module, as a blob URL to import. */
export async function moduleUrl(id: string): Promise<string | null> {
  const b = await db.getFile(`addon:${id}`); return b ? URL.createObjectURL(b.type === 'text/javascript' ? b : new Blob([b], { type: 'text/javascript' })) : null;
}
export const nameOf = (a: AddonEntry, lang: string): string => a.names?.[lang] ?? a.name;
export const descOf = (a: AddonEntry, lang: string): string => a.descriptions?.[lang] ?? a.description ?? '';
/** The user's settings of one add-on, defaults filled in. */
export function addonSettings(a: AddonEntry): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const f of a.settings ?? []) if (f.value !== undefined) out[f.id] = f.value;
  return { ...out, ...(getSettings().addonSettings[a.id] ?? {}) };
}
export function setAddonSettings(id: string, v: Record<string, string | number | boolean>): void {
  updateSettings({ addonSettings: { ...getSettings().addonSettings, [id]: v } });
}
