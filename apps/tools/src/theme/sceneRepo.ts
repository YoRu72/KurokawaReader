// Scenes (animated wallpapers) from the repository: repo/scenes/scenes.json lists them (format 1: id, names in the
// app's five languages, version, sha256, size, `engine` — the lowest engine level the scene needs —, preview colours)
// beside repo/scenes/<id>.json, made by scripts/scenes.mjs from scenes-src/. The catalogue is read through catalog.ts;
// a scene is downloaded on first use (size capped, SHA-256 checked, its structure checked here as strictly as the
// engine's own reader — json.rs and scenefile.rs — would: nothing unchecked reaches the wasm), kept in IndexedDB, and
// updated like a theme when its version rises. Built-in scenes never pass here: they work offline exactly as before.
import { db } from '../db';
import { getSettings } from '../settings';
import { REPO_DOCS, SCENES_ALL, setRepoScenes, type SceneEntry } from './sceneList';

/** The engine level this build carries (sceneHost.ts's ABI): a scene needing more says «needs the app update». */
export const ENGINE_LEVEL = 2;
/** A downloaded scene file is at most this big (the engine itself reads at most 256 KB). */
export const SCENE_MAX = 512 * 1024;
const LANGS = ['en', 'ar', 'ja', 'ko', 'zh'] as const;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/; const HEX64 = /^[0-9a-f]{64}$/; const COLOUR = /^#[0-9a-f]{6}$/i; const VER = /^\d{1,6}(\.\d{1,6}){0,3}$/;

export interface RepoScene { id: string; file: string; names: Partial<Record<(typeof LANGS)[number], string>>; version: string; sha256: string; size: number; engine: number; preview: { dark?: string[]; light?: string[] } }
export interface SceneCatalog { format: 1; scenes: RepoScene[] }
interface Kept { version: string; sha256: string; size: number; at: number }
const META = 'scenes.installed';
const fileKey = (id: string) => `scene:${id}`;

const cleanText = (v: unknown): string => typeof v === 'string' ? [...v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩<>]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 40).join('') : '';
/** The catalogue checked: anything it does not know is dropped; a malformed entry is left out, not the whole list. */
export function checkCatalog(x: unknown): SceneCatalog {
  const o = x as { format?: unknown; scenes?: unknown };
  if (!o || typeof o !== 'object' || o.format !== 1 || !Array.isArray(o.scenes)) throw new Error('not a scene catalogue');
  const out: RepoScene[] = [];
  for (const e of o.scenes.slice(0, 200) as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID.test(e.id) || SCENES_ALL.some((b) => b.id === e.id) || out.some((y) => y.id === e.id)) continue;
    if (typeof e.version !== 'string' || !VER.test(e.version) || typeof e.sha256 !== 'string' || !HEX64.test(e.sha256)) continue;
    if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size < 2 || e.size > SCENE_MAX || typeof e.engine !== 'number' || !Number.isInteger(e.engine) || e.engine < 1) continue;
    const names: RepoScene['names'] = {}; const n = (e.names ?? {}) as Record<string, unknown>;
    for (const l of LANGS) { const v = cleanText(n[l]); if (v) names[l] = v; }
    if (!names.en) continue;
    const pv = (e.preview ?? {}) as Record<string, unknown>; const preview: RepoScene['preview'] = {};
    for (const m of ['dark', 'light'] as const) if (Array.isArray(pv[m])) { const c = (pv[m] as unknown[]).filter((v): v is string => typeof v === 'string' && COLOUR.test(v)).slice(0, 4); if (c.length >= 2) preview[m] = c; }
    out.push({ id: e.id, file: `${e.id}.json`, names, version: e.version, sha256: e.sha256, size: e.size, engine: e.engine, preview });
  }
  return { format: 1, scenes: out };
}

export { SceneFileError, checkSceneBytes } from './sceneCheck';
import { SceneFileError, checkSceneBytes } from './sceneCheck';
const bad = (code: SceneFileError['code'], m: string): never => { throw new SceneFileError(code, m); };

/* ---------- the catalogue and what is kept ---------- */
export const engineOk = (e: RepoScene): boolean => e.engine <= ENGINE_LEVEL;
export async function readScenes(manual = false): Promise<import('../catalog').CatalogResult<SceneCatalog>> {
  const { readCatalog } = await import('../catalog'); return readCatalog('scenes/scenes.json', checkCatalog, { auto: !manual });
}
export const keptScenes = async (): Promise<SceneCatalog | null> => { const { readCatalog } = await import('../catalog'); return (await readCatalog('scenes/scenes.json', checkCatalog, { offlineOnly: true })).data; };
export async function installedScenes(): Promise<Record<string, Kept>> { try { return (await db.getMeta<Record<string, Kept>>(META)) ?? {}; } catch { return {}; } }
export const nameOfScene = (e: RepoScene, lang: string): string => e.names[lang as 'en'] ?? e.names.en ?? e.id;

/** The repository's scenes listed for the picker and the mixer (from the kept catalogue: no network). */
export async function listRepoScenes(cat?: SceneCatalog | null): Promise<RepoScene[]> {
  const c = cat ?? (await keptScenes()); const list = c?.scenes ?? [];
  const lang = (await import('../i18n')).getLang();
  setRepoScenes(list.map((e): SceneEntry => ({ id: e.id, name: '', hint: '', label: nameOfScene(e, lang), repo: true })));
  return list;
}
/** Fetched, checked, kept — beside the copy in use, which is replaced only once the new one passed. */
async function download(e: RepoScene): Promise<unknown> {
  if (!engineOk(e)) bad('shape', 'needs a newer engine');
  const { repoBytes, sha256Hex } = await import('../catalog');
  const { bytes } = await repoBytes(`scenes/${e.file}`);
  if (bytes.length > SCENE_MAX || bytes.length !== e.size) bad('size', `${bytes.length} bytes, the catalogue says ${e.size}`);
  if ((await sha256Hex(bytes)) !== e.sha256) bad('checksum', 'checksum differs');
  const doc = checkSceneBytes(bytes);
  await db.putFile(fileKey(e.id), new Blob([bytes as unknown as BlobPart], { type: 'application/json' }));
  const all = await installedScenes(); all[e.id] = { version: e.version, sha256: e.sha256, size: e.size, at: Date.now() }; await db.setMeta(META, all);
  REPO_DOCS[e.id] = doc; return doc;
}
/** A kept scene's document (checked again as it is read back: storage is not trusted either). */
async function keptDoc(id: string): Promise<unknown | null> {
  const b = await db.getFile(fileKey(id)).catch(() => undefined); if (!b) return null;
  try { return checkSceneBytes(new Uint8Array(await b.arrayBuffer())); } catch { return null; }
}
/** Before the engine opens `id` (a repository scene, or a mix on one): the list known, the document here. */
export async function prepareScene(id: string): Promise<void> {
  const cat = await keptScenes(); await listRepoScenes(cat);
  let target = id;
  if (id.startsWith('mix:')) { const { mixById } = await import('./sceneMix'); target = mixById(id.slice(4))?.base ?? ''; }
  if (!target || REPO_DOCS[target] || SCENES_ALL.some((b) => b.id === target)) return;
  const kept = await keptDoc(target); if (kept) { REPO_DOCS[target] = kept; return; }
  const e = cat?.scenes.find((x) => x.id === target); if (!e || !engineOk(e)) return;
  await download(e).catch(() => undefined);
}
/** The checker's part: installed scenes whose catalogue version rose, downloaded again; the list refreshed. */
export async function updateScenes(cat: SceneCatalog): Promise<{ id: string; name: string; from: string; to: string }[]> {
  await listRepoScenes(cat);
  const { cmpDotted } = await import('../addons'); const lang = (await import('../i18n')).getLang();
  const have = await installedScenes(); const out: { id: string; name: string; from: string; to: string }[] = [];
  for (const [id, k] of Object.entries(have)) {
    const e = cat.scenes.find((x) => x.id === id); if (!e || !engineOk(e) || cmpDotted(e.version, k.version) <= 0) continue;
    try { await download(e); out.push({ id, name: nameOfScene(e, lang), from: k.version, to: e.version }); } catch { /* the kept one stays; next check */ }
  }
  return out;
}
/** Catalogue scenes not seen yet (the «New» mark); the first catalogue ever read counts as seen. */
export function newScenes(cat: SceneCatalog | null): string[] {
  const seen = getSettings().seenScenes; if (!cat || !seen) return [];
  return cat.scenes.filter((e) => !seen.includes(e.id)).map((e) => e.id);
}
