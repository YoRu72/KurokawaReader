// Theme packs in this app: fetched from the Kurokawa repository (repo/themes/ on main, beside the add-ons — the
// same place every build already reads, open to the web build too), kept in the app's IndexedDB with the add-ons'
// files. Downloaded pictures are not in the settings backup (they are big and can be fetched again); the theme
// chosen is, and a restored theme whose pictures are not here shows its drawn background with a download button.
import type { PackIO, PackIndex, PackHeader } from './theme/packs';
import type { ThemeDef } from './theme/themes';
import { db } from './db';
import { addonUrl } from './repo';
import { request } from './http';

async function fetchBytes(url: string, progress?: (done: number, total: number) => void): Promise<Uint8Array> {
  let r: Response;
  try { r = await fetch(url, { cache: 'no-store' }); }
  catch (e) {
    // (The page's own fetch refused — a phone's network the web view cannot pass: the app's request layer.)
    const x = await request(url, { binary: true }).catch(() => { throw e; });
    if (x.status !== 200) throw new Error(`HTTP ${x.status}`);
    const bin = atob(x.body); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    progress?.(out.length, out.length); return out;
  }
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !progress) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader(); const parts: Uint8Array[] = []; let done = 0;
  for (;;) { const { value, done: end } = await reader.read(); if (end) break; parts.push(value); done += value.length; progress(done, total); }
  const out = new Uint8Array(done); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const INDEX_URL = addonUrl('themes/themes.json');
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The theme list checked: entries without an id, file, size, checksum or version left out; never a «my-» id (those
 *  are the reader's own themes, which nothing from the repository may replace). */
export function checkThemeIndex(x: unknown): PackIndex {
  const o = x as PackIndex;
  if (!o || typeof o !== 'object' || o.format !== 1 || !Array.isArray(o.themes)) throw new Error('unknown index format');
  const themes = o.themes.filter((e) => e && typeof e.id === 'string' && ID.test(e.id) && !e.id.startsWith('my-') && typeof e.file === 'string' && e.file === `${e.id}.ktheme`
    && typeof e.size === 'number' && e.size > 0 && typeof e.sha256 === 'string' && /^[0-9a-f]{64}$/.test(e.sha256) && typeof e.version === 'string' && typeof e.name === 'string');
  return { format: 1, themes };
}
/** The list through catalog.ts (revalidated, its last good copy kept and answered offline). */
async function indexBytes(): Promise<Uint8Array> {
  const { readCatalog } = await import('./catalog');
  const r = await readCatalog('themes/themes.json', checkThemeIndex);
  if (!r.data) throw new Error(r.error ?? 'offline');
  return new TextEncoder().encode(JSON.stringify(r.data));
}
/** A pack's tokens: only a light theme's values in the reader's-theme format (colours and numbers in ranges, fixed
 *  words — theme/custom.ts's `sanitise`, every CSS string then built by `toDef`), never CSS or script text; no
 *  pictures of its own (those come as a pack's assets). Nothing else is accepted. */
async function packTokens(raw: unknown, header: Pick<PackHeader, 'id' | 'name' | 'by'>): Promise<unknown> {
  if (raw === undefined || raw === null) return undefined;
  const o = raw as { kurokawaTheme?: unknown; theme?: Record<string, unknown> };
  if (!o || typeof o !== 'object' || o.kurokawaTheme !== 1 || !o.theme || typeof o.theme !== 'object') throw new Error('not a theme of the known format');
  const { sanitise, toDef, cleanThemeName } = await import('./theme/custom');
  const my = sanitise({ ...o.theme, v: 1, id: 'my-repo', name: header.name, at: 0 });
  for (const m of [my.dark, my.light]) if (m && (m.bg.kind === 'picture' || m.bg.kind === 'pack')) throw new Error('a light theme has no pictures');
  const def = toDef(my);
  return { ...def, repoChecked: true, id: header.id, name: cleanThemeName(String(header.name ?? header.id)) || header.id, by: typeof header.by === 'string' ? cleanThemeName(header.by) : undefined, custom: false, base: undefined };
}
export const themeIo: PackIO = {
  indexUrl: INDEX_URL, fetchBytes: (url, progress) => (url === INDEX_URL ? indexBytes() : fetchBytes(url, progress)),
  getFile: (k) => db.getFile(k), putFile: (k, b) => db.putFile(k, b), deleteFile: (k) => db.deleteFile(k),
  getMeta: (k) => db.getMeta(k), setMeta: checkedMeta,
};
/** The shared installer (theme/packs.ts, the Reader's too) keeps a pack's tokens as the pack gave them; here they are
 *  checked as the list of installed themes is written: a record whose tokens are refused fails the write (the pack's
 *  pictures just kept are dropped again, nothing is registered) and the others carry the checked theme. */
async function checkedMeta<T>(key: string, v: T): Promise<void> {
  if (key !== 'themes.installed' || !v || typeof v !== 'object') return db.setMeta(key, v);
  const all = v as unknown as Record<string, { id: string; name?: string; by?: string; assets?: string[]; def?: unknown }>;
  const out: typeof all = {};
  for (const [id, rec] of Object.entries(all)) {
    const raw = rec?.def as { repoChecked?: boolean } | null | undefined;
    if (raw == null || raw.repoChecked) { out[id] = rec; continue; }
    try { out[id] = { ...rec, def: await packTokens(raw, { id: rec.id, name: rec.name ?? rec.id, by: rec.by }) }; }
    catch (err) { for (const a of rec.assets ?? []) await db.deleteFile(`theme:${rec.id}:${a}`).catch(() => undefined); throw new Error(`tokens refused: ${String((err as Error)?.message ?? err)}`); }
  }
  return db.setMeta(key, out as unknown as T);
}
/** Themes of the repository kept here, made usable at start (their checked tokens). */
export async function registerKeptThemes(): Promise<string[]> {
  const { installed } = await import('./theme/packs'); const { registerTheme, THEMES } = await import('./theme/themes');
  const out: string[] = [];
  for (const rec of Object.values(await installed(themeIo))) if (rec.def && !THEMES.some((x) => x.id === rec.id)) { registerTheme(rec.def as ThemeDef); out.push(rec.id); }
  return out;
}
/** The checker's part: installed repository themes whose list version rose, fetched again (each pack checked; the
 *  reader's own themes — «my-…», kept apart in their own store, full values — are never touched). */
export async function updateThemes(ix: PackIndex): Promise<{ id: string; name: string; from: string; to: string }[]> {
  const { installed, installPack, forgetIndex } = await import('./theme/packs'); const { upsertTheme } = await import('./theme/themes');
  const { cmpDotted } = await import('./addons');
  forgetIndex();
  const out: { id: string; name: string; from: string; to: string }[] = [];
  for (const rec of Object.values(await installed(themeIo))) {
    if (rec.id.startsWith('my-')) continue;
    const e = ix.themes.find((x) => x.id === rec.id); if (!e || cmpDotted(e.version, rec.version) <= 0) continue;
    try {
      const next = await installPack(themeIo, rec.id);
      if (next.def) upsertTheme({ ...(next.def as ThemeDef), classic: false, custom: false });
      out.push({ id: rec.id, name: next.name ?? e.name, from: rec.version, to: next.version });
    } catch { /* the kept version stays; the next check tries again */ }
  }
  return out;
}
/** Repository themes not seen yet (the «New» mark): those of the list not in the seen ids (the first list ever read
 *  counts as seen). */
export function newThemes(ix: PackIndex | null, seen: string[] | undefined): string[] { return !ix || !seen ? [] : ix.themes.filter((e) => !seen.includes(e.id)).map((e) => e.id); }
export async function themePictures(packId: string): Promise<Record<string, string>> {
  const { pictureUrls } = await import('./theme/packs');
  return pictureUrls(themeIo, packId);
}
