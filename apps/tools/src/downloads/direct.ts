// A link that names a plain FILE (its last path part, percent-decoded, ends in an extension no web page has) is a
// direct download on every host — even one of the sites yt-dlp is always asked about (an archive.org «download»
// host serving a PDF went to yt-dlp, which made no file). One rule for the page; desktop/ytdlp.cjs (Electron) and
// core/kt-core dlrules.rs (Rust, Tauri) keep the same table — tests/directfile.cjs holds all three to it.
// Where the name says nothing (no extension, .php, .aspx …) the link's own answer decides (downloads/probe.ts).

/** Extensions of files that are never web pages. */
export const DIRECT_EXTS: readonly string[] = [
  // documents
  'pdf', 'epub', 'mobi', 'azw3', 'djvu', 'cbz', 'cbr', 'docx', 'xlsx', 'pptx', 'txt',
  // archives
  'zip', '7z', 'rar', 'tar', 'gz', 'xz', 'bz2', 'zst', 'iso',
  // apps
  'apk', 'xapk', 'apks', 'apkm', 'exe', 'msi', 'dmg', 'deb', 'appimage',
  // subtitles and fonts
  'ass', 'ssa', 'srt', 'vtt', 'sub', 'ttf', 'otf',
  // images
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg',
  // torrents (handled as before) and media files (a manifest — m3u8, mpd — is not a file)
  'torrent',
  'mkv', 'mp4', 'webm', 'avi', 'mov', 'm4v', 'ts', 'flac', 'mp3', 'm4a', 'opus', 'ogg', 'wav', 'aac',
];
const DIRECT = new Set(DIRECT_EXTS);
/** Extensions that say nothing: the answer of the link itself decides. */
export const AMBIGUOUS_EXTS: readonly string[] = ['php', 'asp', 'aspx', 'jsp', 'cgi', 'bin', 'dat', 'download', 'file', 'do', 'action'];
const AMBIGUOUS = new Set(AMBIGUOUS_EXTS);
/** Pages of some sites that look like a file's address but are web pages (a repository's «blob» view, a wiki's file page, a Drive viewer). */
const PAGE_LIKE = [/\/blob\//i, /\/wiki\/(file|image|media):/i, /\/file\/d\//i];

const decode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s.replace(/(%[0-9a-f]{2})+/gi, (m) => { try { return decodeURIComponent(m); } catch { return m; } }); } };
/** The last part of the link's path, percent-decoded ('' when the path ends in a slash). The query and the fragment are never part of it. */
export function lastPart(url: string): string {
  let path: string;
  try { path = new URL(url).pathname; } catch { path = url.split(/[?#]/)[0]; }
  const seg = path.slice(path.lastIndexOf('/') + 1);
  return decode(seg);
}
/** The extension of the link's file name, lower case, or ''. */
export function extOf(url: string): string {
  const n = lastPart(url).trim(); const dot = n.lastIndexOf('.'); if (dot <= 0) return '';
  const e = n.slice(dot + 1).toLowerCase(); return /^[a-z0-9]{1,8}$/.test(e) ? e : '';
}
const urlPath = (url: string): string => { try { return decode(new URL(url).pathname); } catch { return url.split(/[?#]/)[0]; } };
/** The link names a plain file by its extension (and is not one of the pages that look like one). */
export function directByName(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (!DIRECT.has(extOf(url))) return false;
  const p = urlPath(url); return !PAGE_LIKE.some((r) => r.test(p));
}
/** The name says nothing about it (no extension, or one a script has): the link has to be asked. */
export const ambiguousName = (url: string): boolean => /^https?:\/\//i.test(url) && (extOf(url) === '' || AMBIGUOUS.has(extOf(url)));

/** Links the app has asked (HEAD / first bytes) and found to give a file whatever their name said. */
const proved = new Set<string>();
export const markDirect = (url: string): void => { proved.add(url); };
export const forgetDirect = (url: string): void => { proved.delete(url); };
/** A direct file: by its name, or because the link answered with a file. */
export const isDirectFile = (url: string): boolean => proved.has(url) || directByName(url);

/** From a probe: a file came (not a page), its type is not text/html and it is not a manifest. */
export function probeSaysFile(p: { page?: boolean; type?: string; status?: number; ext?: string; attachment?: boolean }): boolean {
  if (p.page) return false;
  if (p.status !== undefined && (p.status < 200 || p.status >= 400)) return false;
  if (p.attachment) return true;
  const ty = (p.type ?? '').toLowerCase();
  if (!ty || ty === 'text/html' || ty === 'application/xhtml+xml') return false;
  if (/mpegurl|dash\+xml/.test(ty) || p.ext === 'm3u8' || p.ext === 'mpd') return false;
  return true;
}
/** A script's name (.php, .aspx …): on a site yt-dlp knows it may be a page or a file; the link is asked before yt-dlp is. */
export const scriptNamed = (url: string): boolean => /^https?:\/\//i.test(url) && AMBIGUOUS.has(extOf(url));
