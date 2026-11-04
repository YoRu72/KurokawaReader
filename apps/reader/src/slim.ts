// What a slim build (the phone apps) leaves out of its package and fetches from the web app the first time it is
// needed: the reading fonts rarely chosen (kept on the device once fetched, so they work offline after) and
// pdf.js's CJK character maps. The build writes slim.json saying what was left out; a full build has none.
import { WEB_APP_URL } from './repo';

export interface SlimFont { file: string; weight: string; style: string }
export interface Slim { cmaps?: boolean; fonts?: Record<string, SlimFont[]> }
let slim: Slim = {}; let loaded: Promise<Slim> | null = null;

/** Read once at start; nothing in a full build. */
export function loadSlim(): Promise<Slim> {
  return (loaded ??= (async () => { try { const r = await fetch('slim.json', { cache: 'no-store' }); if (r.ok) slim = (await r.json()) as Slim; } catch { /* a full build */ } return slim; })());
}
export const slimNow = (): Slim => slim;
/** Where pdf.js finds its character maps: beside the app, or on the web app when the package left them out. */
export const cmapsUrl = (local: string): string => (slim.cmaps ? `${WEB_APP_URL}assets/pdfjs/cmaps/` : `${local}cmaps/`);
/** Whether a reading font is one the package left out (fetched when first chosen). */
export const isRemoteFont = (family: string): boolean => !!slim.fonts?.[family.replace(/^['"]|['"]$/g, '')];

const ready = new Map<string, Promise<boolean>>();
/** A left-out font made available: from the device when it was fetched before, else fetched from the web app
 *  and kept; registered with the document. True when it is there to use. */
export function ensureFont(family: string): Promise<boolean> {
  const fam = family.replace(/^['"]|['"]$/g, '');
  const faces = slim.fonts?.[fam]; if (!faces) return Promise.resolve(true);
  const had = ready.get(fam); if (had) return had;
  const p = (async () => {
    const { db } = await import('./db');
    let ok = true;
    for (const f of faces) {
      const key = `font:slim:${f.file}`;
      try {
        let blob = await db.getFile(key).catch(() => undefined);
        if (!blob) { const r = await fetch(`${WEB_APP_URL}assets/fonts/${f.file}`); if (!r.ok) throw new Error(String(r.status)); blob = await r.blob(); await db.putFile(key, blob).catch(() => undefined); }
        const face = new FontFace(fam, await blob.arrayBuffer(), { weight: f.weight, style: f.style, display: 'swap' });
        await face.load(); document.fonts.add(face);
      } catch { ok = false; }
    }
    if (!ok) ready.delete(fam);
    return ok;
  })();
  ready.set(fam, p);
  return p;
}
