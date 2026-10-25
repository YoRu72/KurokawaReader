// User fonts: stored as blobs in IndexedDB and registered with the FontFace API
// at start-up, so they work offline and show up in the Visual Options lists.
import { db, uid } from './db';

export type FontScript = 'latin' | 'arabic' | 'cjk';
export interface CustomFont { id: string; name: string; family: string; script: FontScript; size: number }

let cache: CustomFont[] | null = null;
const listeners = new Set<() => void>();

export async function listFonts(): Promise<CustomFont[]> {
  if (!cache) cache = (await db.getMeta<CustomFont[]>('fonts')) ?? [];
  return cache;
}
export function fontsSync(): CustomFont[] { return cache ?? []; }
export function onFontsChange(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

async function register(font: CustomFont, blob: Blob): Promise<void> {
  const face = new FontFace(font.family, await blob.arrayBuffer());
  await face.load();
  document.fonts.add(face);
}

/** Load every stored font into the document. Call once at start-up. */
export async function loadFonts(): Promise<void> {
  for (const f of await listFonts()) {
    const blob = await db.getFile(`font:${f.id}`);
    if (blob) await register(f, blob).catch(() => undefined);
  }
}

function guessScript(name: string, bytes: Uint8Array): FontScript {
  if (/arab|naskh|kufi|thuluth|ruqaa|amiri|cairo|tajawal|almarai|uthman|sultan|mohanad|scheherazade|lateef|harmattan|noto.*arab/i.test(name)) return 'arabic';
  if (/cjk|mincho|gothic|hiragino|meiryo|yu ?(gothic|mincho)|songti|heiti|simsun|simhei|pingfang|yahei|batang|dotum|gulim|malgun|nanum|source ?han|noto.*(jp|sc|tc|kr|hk)\b|\b(jp|sc|tc|kr)\b/i.test(name)) return 'cjk';
  // Look for an Arabic cmap range marker is overkill; fall back to the name heuristic.
  void bytes;
  return 'latin';
}

export async function addFontFromFile(file: File, script?: FontScript): Promise<CustomFont> {
  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const name = file.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_]+/g, ' ');
  const id = uid();
  const font: CustomFont = { id, name, family: `KR-${id}`, script: script ?? guessScript(file.name, bytes), size: file.size };
  await register(font, file); // throws on an invalid font before anything is stored
  await db.putFile(`font:${id}`, file);
  cache = [...(await listFonts()), font];
  await db.setMeta('fonts', cache);
  listeners.forEach((fn) => fn());
  return font;
}

export async function addFontFromUrl(url: string, script?: FontScript): Promise<CustomFont> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  const blob = await r.blob();
  const name = decodeURIComponent(url.split('/').pop() ?? 'font');
  return addFontFromFile(new File([blob], name, { type: blob.type || 'font/ttf' }), script);
}

export async function removeFont(id: string): Promise<void> {
  const fonts = await listFonts();
  const f = fonts.find((x) => x.id === id);
  if (f) for (const face of document.fonts) if (face.family === f.family) document.fonts.delete(face);
  cache = fonts.filter((x) => x.id !== id);
  await db.setMeta('fonts', cache);
  await db.deleteFile(`font:${id}`);
  listeners.forEach((fn) => fn());
}

export async function setFontScript(id: string, script: FontScript): Promise<void> {
  cache = (await listFonts()).map((f) => (f.id === id ? { ...f, script } : f));
  await db.setMeta('fonts', cache);
  listeners.forEach((fn) => fn());
}

/** CSS family for a font setting value: built-ins or `custom:<id>`. */
export function familyFor(value: string, builtins: Record<string, string>): string {
  if (value.startsWith('system:')) return `'${value.slice(7).replace(/'/g, '')}'`;
  if (value.startsWith('custom:')) {
    const f = fontsSync().find((x) => x.id === value.slice(7));
    return f ? `'${f.family}'` : 'inherit';
  }
  return builtins[value] ?? 'inherit';
}

/** Fonts installed on this computer (Local Font Access API: Chromium / Electron). Returns [] elsewhere. */
export async function listSystemFonts(): Promise<{ family: string; fullName: string }[]> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string; fullName: string }[]> }).queryLocalFonts;
  if (!q) return [];
  try {
    const all = await q();
    const seen = new Map<string, string>();
    for (const f of all) if (!seen.has(f.family)) seen.set(f.family, f.fullName);
    return [...seen].map(([family, fullName]) => ({ family, fullName })).sort((a, b) => a.family.localeCompare(b.family));
  } catch { return []; }
}
export function canListSystemFonts(): boolean { return 'queryLocalFonts' in window; }
