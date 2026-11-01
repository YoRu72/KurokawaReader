// The add-ons: listed by the Kurokawa repository (repo/tools/index.json), parents with their children, each
// installed on its own — its code fetched and kept here, its settings in the app. Nothing of an add-on is in
// the app before it is installed.
import { addonUrl } from './repo';
import { db } from './db';
import { getSettings, updateSettings } from './settings';

export type AddonKind = 'group' | 'torrent-search' | 'anime' | 'anime-provider' | 'subtitles' | 'subtitle-source' | 'debrid' | 'archives' | 'player' | 'source' | 'video';
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
}
export interface AddonSetting { id: string; label: string; labels?: Record<string, string>; type: 'text' | 'password' | 'number' | 'select' | 'toggle'; options?: string[]; value?: string | number | boolean }
export interface AddonIndex { kurokawa: 'addons'; app: 'tools'; addons: AddonEntry[] }

const INDEX_KEY = 'addons:index';
let index: AddonIndex | null = null;

/** The repository's list (kept for offline; `fresh` asks the repository again). */
export async function loadIndex(fresh = false): Promise<AddonIndex> {
  if (index && !fresh) return index;
  if (!fresh) { const kept = await db.getMeta<AddonIndex>(INDEX_KEY).catch(() => undefined); if (kept) { index = kept; return kept; } }
  const r = await fetch(addonUrl('tools/index.json'), { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as AddonIndex;
  index = j; await db.setMeta(INDEX_KEY, j).catch(() => undefined);
  return j;
}
export const indexNow = (): AddonIndex | null => index;
export const installed = (id: string): boolean => getSettings().addons.includes(id);

/** Installs an add-on (and its children): their modules fetched into the store. */
export async function install(id: string): Promise<void> {
  const ix = await loadIndex();
  const e = ix.addons.find((a) => a.id === id); if (!e) throw new Error(id);
  if (e.packs?.length) {
    const { ensurePacks, packsHere } = await import('./packs'); const { t, getLang } = await import('./i18n');
    if (packsHere() && !(await ensurePacks(e.packs, t('packWhyAddon', { name: nameOf(e, getLang()) })))) throw new Error(t('cancelled'));
  }
  const ids = [id, ...(e.children ?? [])];
  for (const k of ids) {
    const a = ix.addons.find((x) => x.id === k); if (!a) continue;
    if (a.module) { const r = await fetch(addonUrl(`tools/${a.module}`), { cache: 'no-store' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); await db.putFile(`addon:${k}`, new Blob([await r.arrayBuffer()], { type: 'text/javascript' })); }  // (GitHub serves .mjs as text/plain; a module import needs a script type)
    if (a.manifest) { const r = await fetch(addonUrl(`tools/${a.manifest}`), { cache: 'no-store' }); if (!r.ok) throw new Error(`HTTP ${r.status}`); await db.setMeta(`addon-manifest:${k}`, await r.json()); }
    await db.setMeta(`addon-version:${k}`, a.version);
  }
  if (e.children?.length) await db.setMeta(`addon-children:${id}`, e.children);
  updateSettings({ addons: [...new Set([...getSettings().addons, ...ids])] });
}
export async function uninstall(id: string): Promise<void> {
  const ix = await loadIndex().catch(() => null);
  const e = ix?.addons.find((a) => a.id === id);
  const ids = [id, ...(e?.children ?? [])];
  for (const k of ids) { await db.deleteFile(`addon:${k}`).catch(() => undefined); await db.deleteMeta(`addon-manifest:${k}`).catch(() => undefined); await db.deleteMeta(`addon-version:${k}`).catch(() => undefined); }
  updateSettings({ addons: getSettings().addons.filter((x) => !ids.includes(x)) });
  // Packs no other installed add-on needs are removed with it (Convert asks for ffmpeg again when it is used).
  if (e?.packs?.length && ix) {
    const still = new Set(getSettings().addons.flatMap((a) => ix.addons.find((x) => x.id === a)?.packs ?? []));
    const { removePack, packsHere, status } = await import('./packs');
    if (packsHere()) { const st = await status().catch(() => null); for (const n of e.packs) if (!still.has(n) && st?.[n]?.version) await removePack(n).catch(() => undefined); }
  }
}
/** Installed add-ons whose repository version moved on. */
export async function updatesAvailable(): Promise<string[]> {
  const ix = await loadIndex(true).catch(() => null); if (!ix) return [];
  const out: string[] = [];
  for (const id of getSettings().addons) { const e = ix.addons.find((a) => a.id === id); if (!e) continue; const v = await db.getMeta<string>(`addon-version:${id}`); if (v !== e.version) out.push(id); }
  return out;
}
/** Installed add-ons brought up to date quietly: a changed module fetched again, and a group's new sources
 *  added (the ones the user removed on purpose stay removed — only children the group did not have before). */
export async function autoUpdate(): Promise<string[]> {
  const ix = await loadIndex(true).catch(() => null); if (!ix) return [];
  const done: string[] = [];
  for (const id of [...getSettings().addons]) {
    const e = ix.addons.find((a) => a.id === id); if (!e) continue;
    const v = await db.getMeta<string>(`addon-version:${id}`); if (v === e.version) continue;
    try {
      if (e.module) { const r = await fetch(addonUrl(`tools/${e.module}`), { cache: 'no-store' }); if (!r.ok) continue; await db.putFile(`addon:${id}`, new Blob([await r.arrayBuffer()], { type: 'text/javascript' })); }
      if (e.children?.length) {
        const known = (await db.getMeta<string[]>(`addon-children:${id}`)) ?? e.children.filter((k) => getSettings().addons.includes(k));
        for (const k of e.children) if (!known.includes(k) && !getSettings().addons.includes(k)) { await install(k); done.push(k); }
        await db.setMeta(`addon-children:${id}`, e.children);
      }
      await db.setMeta(`addon-version:${id}`, e.version); done.push(id);
    } catch { /* offline: next time */ }
  }
  return done;
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
