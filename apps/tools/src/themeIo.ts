// Theme packs in this app: fetched from the Kurokawa repository (repo/themes/ on main, beside the add-ons — the
// same place every build already reads, open to the web build too), kept in the app's IndexedDB with the add-ons'
// files. Downloaded pictures are not in the settings backup (they are big and can be fetched again); the theme
// chosen is, and a restored theme whose pictures are not here shows its drawn background with a download button.
import type { PackIO } from './theme/packs';
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
export const themeIo: PackIO = {
  indexUrl: addonUrl('themes/themes.json'), fetchBytes,
  getFile: (k) => db.getFile(k), putFile: (k, b) => db.putFile(k, b), deleteFile: (k) => db.deleteFile(k),
  getMeta: (k) => db.getMeta(k), setMeta: (k, v) => db.setMeta(k, v),
};
export async function themePictures(packId: string): Promise<Record<string, string>> {
  const { pictureUrls } = await import('./theme/packs');
  return pictureUrls(themeIo, packId);
}
