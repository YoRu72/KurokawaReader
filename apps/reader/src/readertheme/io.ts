// Style packs in the Reader (the shared format and code: src/theme/packs.ts): fetched from the Kurokawa repository
// (repo/themes/ on main — the packs both apps read; nothing of them in the Reader's own package), kept in the app's
// IndexedDB beside the books' files, so an update of the app keeps them and they work offline.
//
// A picture is kept the size of this screen (its long side the screen's long side in device pixels, at most 2560): a
// 6000-pixel photograph is 96 MB once decoded, which a 4 GB phone feels; the screen's size is a tenth of that.
// Not in backups: a backup keeps the style chosen (a setting), and the pictures can be fetched again — a backup stays
// small. A restored style whose pictures are not here shows its drawn background, with its download button.
import type { PackIO } from '../theme/packs';
import type { MyStore, MyTheme } from '../theme/custom';
import { addonUrl } from '../repo';
import { db } from '../db';

/** Where the index is: the repository's, or another given for development and tests (a server on this machine). */
const indexUrl = (): string => { try { return localStorage.getItem('kr.themeIndex') || addonUrl('themes/themes.json'); } catch { return addonUrl('themes/themes.json'); } };

async function fetchBytes(url: string, progress?: (done: number, total: number) => void): Promise<Uint8Array> {
  let r: Response;
  try { r = await fetch(url, { cache: 'no-store' }); }
  catch (e) {
    // (The page's own fetch refused — a network the web view cannot pass: the app's own request, native on a phone or
    // the desktop.)
    if (navigator.onLine === false) throw e;
    const { http, bodyBytes } = await import('../net');
    const x = await http(url, { binary: true }).catch(() => { throw e; });
    if (x.status !== 200) throw new Error(`HTTP ${x.status}`);
    const out = await bodyBytes(x); progress?.(out.length, out.length); return out;
  }
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  if (!r.body || !progress) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader(); const parts: Uint8Array[] = []; let done = 0;
  for (;;) { const { value, done: end } = await reader.read(); if (end) break; parts.push(value); done += value.length; progress(done, total); }
  const out = new Uint8Array(done); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A picture made the size of this screen, as JPEG; as it came where it is smaller already or cannot be decoded here. */
async function screenSized(blob: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob);
    const long = Math.min(2560, Math.round(Math.max(screen.width, screen.height) * (devicePixelRatio || 1)));
    const k = long / Math.max(bmp.width, bmp.height);
    if (k >= 1) { bmp.close(); return blob; }
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    c.getContext('2d')!.drawImage(bmp, 0, 0, w, h); bmp.close();
    const out = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.9));
    return out && out.size ? out : blob;
  } catch { return blob; }
}

export const themeIo: PackIO = {
  get indexUrl() { return indexUrl(); },
  fetchBytes,
  getFile: (k) => db.getFile(k),
  putFile: async (k, b) => db.putFile(k, /^image\//.test(b.type) ? await screenSized(b) : b),
  deleteFile: (k) => db.deleteFile(k),
  getMeta: (k) => db.getMeta(k),
  // (A pack installed or removed: the style in force takes its pictures, or its drawn background, at once.)
  setMeta: async (k, v) => { await db.setMeta(k, v); window.dispatchEvent(new CustomEvent('kr:packs-changed')); },
};

// «My styles» (made with the shared editor, src/theme/editor.ts): their values in localStorage (kr.myStyles — read
// back through the shared module's strict check, as a file is), their pictures in IndexedDB beside the packs'.
// Not in backups (a backup keeps the reading settings and the style chosen): a style of one's own can be exported as
// a file from its menu, and imported again.
const MY_KEY = 'kr.myStyles';
export const myStore: MyStore = {
  load: () => { try { return JSON.parse(localStorage.getItem(MY_KEY) ?? '[]') as unknown; } catch { return []; } },
  save: (list: MyTheme[]) => { try { localStorage.setItem(MY_KEY, JSON.stringify(list)); } catch { /* full */ } },
  io: themeIo,
};
