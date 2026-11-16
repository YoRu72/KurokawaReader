// Others' «Open with» / «Share» and Files' own «Open with…» chooser, as plain logic (no page: tests/openwith.cjs runs
// it alone). The table of Kurokawa's entries in other apps' lists is native/android/openwith.json — the same file the
// manifest is written from —; what came from another app (KtOpenActivity → KtPlugin.openRequest) is read here, what
// the page does with each kind decided here, and the person's «Always open .mkv with…» choices kept here.
import TABLE from '../../native/android/openwith.json';

export type OwFilter = { actions: string[]; schemes?: string[]; host?: string; mimes?: string[]; exts?: string[] };
export type OwEntry = { id: string; alias: string; res: string; on: boolean; generated: boolean; dest: string; label: { en: string; ar: string }; filters?: OwFilter[] };
/** Every entry, in the order Settings lists them. */
export const ENTRIES: OwEntry[] = (TABLE as unknown as { entries: OwEntry[] }).entries;
export const KINDS = ['archive', 'archiveShare', 'folder', 'image', 'text', 'any', 'browse'] as const;
export type OwKind = (typeof KINDS)[number];

/** Whether an entry shows in other apps: Android's own state when set (1 on, 2 off), else as installed. */
export const isOn = (e: OwEntry, state?: number): boolean => (state === 1 ? true : state === 2 ? false : e.on);

export type OpenItem = { uri: string; name: string; size: number; mime: string; path?: string; dir: boolean; readable: boolean };
export type OpenRequest = { id: string; kind: OwKind; action: string; caller: string; writable: boolean; mime: string; items: OpenItem[] };

/** The request read once (a string or an object): anything missing or of the wrong sort falls back to safe values. */
export function parseOpen(raw: unknown): OpenRequest | null {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return null; } }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>; const str = (x: unknown) => (typeof x === 'string' ? x : '');
  const kind = (KINDS as readonly string[]).includes(str(r.kind)) ? (str(r.kind) as OwKind) : 'any';
  const items = (Array.isArray(r.items) ? r.items : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as { uri?: unknown }).uri === 'string').map((x): OpenItem => ({
    uri: str(x.uri), name: str(x.name).replace(/[\\/]/g, '_') || nameOfUri(str(x.uri)), size: typeof x.size === 'number' && Number.isFinite(x.size) ? x.size : -1, mime: str(x.mime).toLowerCase(),
    ...(str(x.path) ? { path: str(x.path) } : {}), dir: x.dir === true, readable: x.readable !== false,
  }));
  return { id: str(r.id), kind, action: str(r.action), caller: str(r.caller).trim(), writable: r.writable === true, mime: str(r.mime).toLowerCase(), items };
}
/** A link's last part, decoded (a name for a link whose provider gave none). */
export function nameOfUri(u: string): string { const last = u.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop() ?? ''; let n = last; try { n = decodeURIComponent(last); } catch { /* as it is */ } n = n.split(/[/:]/).pop() ?? n; return n || 'file'; }

export type Step =
  | { to: 'archive'; item: OpenItem } | { to: 'extract'; items: OpenItem[] } | { to: 'folder'; path: string } | { to: 'downloads' }
  | { to: 'viewer'; item: OpenItem } | { to: 'editor'; item: OpenItem } | { to: 'any'; item: OpenItem }
  | { to: 'error'; why: 'nothing' | 'unreadable' | 'notHere' };
/** Where a request goes: the kind chosen in the other app's list, the files that came. Archives that are not files
 *  here are fetched first by the page (the only kind that needs a file of its own); a folder must be one the phone
 *  can list; a link nobody can read any more (expired, deleted) is told calmly. */
export function stepFor(req: OpenRequest): Step {
  const items = req.items;
  if (req.kind === 'browse') { const d = items.find((x) => x.dir && x.path); return d?.path ? { to: 'folder', path: d.path } : { to: 'downloads' }; }
  if (!items.length) return { to: 'error', why: 'nothing' };
  if (req.kind === 'folder') { const d = items[0]; if (d.path) return { to: 'folder', path: d.dir ? d.path : parentOf(d.path) }; return { to: 'error', why: d.readable ? 'notHere' : 'unreadable' }; }
  const ok = items.filter((x) => x.readable && !x.dir); if (!ok.length) return { to: 'error', why: 'unreadable' };
  switch (req.kind) {
    case 'archive': return { to: 'archive', item: ok[0] };
    case 'archiveShare': return { to: 'extract', items: ok };
    case 'image': return { to: 'viewer', item: ok[0] };
    case 'text': return { to: 'editor', item: ok[0] };
    default: return { to: 'any', item: ok[0] };
  }
}
export const parentOf = (p: string): string => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';

/** MPEG-TS: the sync byte 0x47 at the start of each 188-byte packet (or each 192-byte one, M2TS), twice at least.
 *  A «.ts» is a TypeScript source as often as a video (MainActivity.looksMpegTs is the Java twin). */
export function sniffTs(b: Uint8Array): boolean {
  const n = b.length;
  if (n >= 189 && b[0] === 0x47 && b[188] === 0x47 && (n < 377 || b[376] === 0x47)) return true;
  return n >= 197 && b[4] === 0x47 && b[196] === 0x47 && (n < 389 || b[388] === 0x47);
}

/* ---------- «Always open .mkv with…»: Files' own chooser, the choices kept ---------- */
export type AppChoice = { pkg: string; cls: string; label: string; icon?: string };
/** Kurokawa's own ways to open a file: its viewers first in the chooser. «system»: the computer's default app. */
export type OwnWay = 'player' | 'viewer' | 'editor' | 'archive' | 'installer' | 'system';
export type DefaultApp = { own: OwnWay } | { app: AppChoice };
const KEY = 'kt.files.defaultApps';
/** The extension a choice is kept under: the last one, lower case («Show.S01.MKV» → «mkv»); none for no extension. */
export function extOf(name: string): string { const m = /\.([A-Za-z0-9]{1,10})$/.exec(name); return m ? m[1].toLowerCase() : ''; }
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
export function loadDefaults(s: Store): Record<string, DefaultApp> {
  try { const o = JSON.parse(s.getItem(KEY) ?? '{}') as Record<string, DefaultApp>; return o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).filter(([k, v]) => /^[a-z0-9]{1,10}$/.test(k) && !!v && (typeof (v as { own?: unknown }).own === 'string' || !!(v as { app?: AppChoice }).app?.pkg))) : {}; } catch { return {}; }
}
export function setDefault(s: Store, ext: string, d: DefaultApp | null): Record<string, DefaultApp> {
  const all = loadDefaults(s); if (!ext) return all; if (d) all[ext] = d; else delete all[ext];
  try { s.setItem(KEY, JSON.stringify(all)); } catch { /* none */ }
  return all;
}
/** Kurokawa's ways for this file, best first. */
export function ownWays(name: string, pc: boolean): OwnWay[] {
  const n = name.toLowerCase(); const out: OwnWay[] = [];
  if (/\.(mkv|mp4|m4v|webm|avi|mov|m2ts|mts|flv|wmv|3gp|mp3|m4a|flac|ogg|opus|wav|aac|m3u8)$/.test(n)) out.push('player');
  // (The picture viewer, the text editor and the installer are the phone's; a computer has the player, archives and its own default app.)
  if (!pc && /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif|tiff?)$/.test(n)) out.push('viewer');
  if (!pc && /\.(txt|md|log|ini|conf|cfg|ya?ml|toml|csv|nfo|m3u|json|xml|ass|ssa|srt|vtt|sub|lrc)$/.test(n)) out.push('editor');
  if (/\.(zip|cbz|7z|rar|tar|tgz|txz|tbz2|gz|xz|bz2|001)$/.test(n)) out.push('archive');
  if (!pc && /\.(apk|apks|xapk|apkm)$/.test(n)) out.push('installer');
  if (pc) out.push('system');
  return out;
}
/** The chooser's list: Kurokawa's ways first, then the other apps by name (in the page's language order). */
export function chooserList(name: string, apps: AppChoice[], pc: boolean): ({ own: OwnWay } | { app: AppChoice })[] {
  const seen = new Set<string>(); const others = apps.filter((a) => { const k = `${a.pkg}/${a.cls}`; if (!a.pkg || seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.label.localeCompare(b.label));
  return [...ownWays(name, pc).map((own) => ({ own })), ...others.map((app) => ({ app }))];
}
