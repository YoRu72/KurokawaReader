// A link looked at before it is downloaded: the file's size, its name as the site gives it, and what it really is —
// from its first bytes, like a download manager's «Save as» does — so the name and the extension shown are right
// even when the site sends «file.bin» or «application/octet-stream» (and the engines fix the name again once the
// file is here: KrDownloader on Android, desktop/sniff.cjs on a computer).
import { request } from '../http';

export interface Probe {
  /** Bytes, when the site says. */
  size?: number;
  /** The name the site gives it (Content-Disposition), or the link's last part. */
  name: string;
  /** The stem and the extension, the latter from the name, the bytes or the content type. */
  stem: string; ext: string;
  /** Where the extension came from, when it was not in the name. */
  extFrom?: 'bytes' | 'type';
  type?: string;
  /** The site honours ranges (pauses and connections work). */
  resumable?: boolean;
  /** A web page came where a file was expected (a sign-in, a check, an error page). */
  page?: boolean;
  finalUrl?: string;
  /** The HTTP status the site answered (the HEAD's, else the range's), when it answered. */
  status?: number;
}

const JUNK = /^(bin|dat|tmp|file|download|dl|php|aspx?|jsp|cgi|octet-stream|unknown|htm|html)$/;
/** Whether an extension says nothing about the file. */
export const weakExt = (ext: string): boolean => !ext || JUNK.test(ext) || !/^[a-z0-9]{1,5}$/.test(ext) || /^\d+$/.test(ext);

const TYPES: Record<string, string> = {
  'video/mp4': 'mp4', 'video/x-matroska': 'mkv', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-msvideo': 'avi', 'video/mp2t': 'ts', 'video/3gpp': '3gp',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/x-rar-compressed': 'rar', 'application/vnd.rar': 'rar', 'application/x-7z-compressed': '7z', 'application/gzip': 'gz', 'application/x-gzip': 'gz', 'application/x-xz': 'xz', 'application/x-bzip2': 'bz2', 'application/x-tar': 'tar',
  'application/vnd.android.package-archive': 'apk', 'application/epub+zip': 'epub', 'application/x-bittorrent': 'torrent', 'application/x-msdownload': 'exe', 'application/x-msi': 'msi', 'application/x-apple-diskimage': 'dmg', 'application/x-iso9660-image': 'iso', 'application/x-mobipocket-ebook': 'mobi', 'application/vnd.amazon.ebook': 'azw3',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/heic': 'heic',
  'application/vnd.apple.mpegurl': 'm3u8', 'application/x-mpegurl': 'm3u8', 'text/vtt': 'vtt', 'application/x-subrip': 'srt', 'application/json': 'json', 'text/plain': 'txt', 'text/csv': 'csv',
};

/** The extension the first bytes say, or null (the same rules as the engines' sniffers). */
export function sniffBytes(b: Uint8Array): string | null {
  if (b.length < 4) return null;
  let head = ''; for (let i = 0; i < Math.min(b.length, 4096); i++) head += String.fromCharCode(b[i]);
  if (head.startsWith('PK\x03\x04') || head.startsWith('PK\x05\x06')) return 'zip';
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith("7z\xbc\xaf'\x1c")) return '7z';
  if (head.startsWith('Rar!')) return 'rar';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gz';
  if (head.startsWith('\xfd7zXZ')) return 'xz';
  if (head.startsWith('BZh')) return 'bz2';
  if (b.length >= 12 && head.startsWith('ftyp', 4)) { const brand = head.slice(8, 12); return brand.startsWith('M4A') ? 'm4a' : brand.startsWith('qt') ? 'mov' : brand.startsWith('hei') || brand.startsWith('mif1') ? 'heic' : brand.startsWith('avif') ? 'avif' : brand.startsWith('3gp') ? '3gp' : 'mp4'; }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return head.includes('webm') ? 'webm' : 'mkv';
  if (head.startsWith('OggS')) return head.includes('OpusHead') ? 'opus' : 'ogg';
  if (head.startsWith('fLaC')) return 'flac';
  if (head.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) return 'mp3';
  if (b.length >= 12 && head.startsWith('RIFF')) { const k = head.slice(8, 12); return k === 'WAVE' ? 'wav' : k === 'AVI ' ? 'avi' : k === 'WEBP' ? 'webp' : null; }
  if (head.startsWith('\x89PNG')) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (head.startsWith('GIF8')) return 'gif';
  if (head.startsWith('#EXTM3U')) return 'm3u8';
  if (head.startsWith('d8:announce') || head.startsWith('d13:announce') || (head.startsWith('d') && head.includes('4:infod'))) return 'torrent';
  if (head.startsWith('MZ')) return 'exe';
  if (head.startsWith('G') && b.length > 376 && b[188] === 0x47 && b[376] === 0x47) return 'ts';
  if (/^\s*<(!doctype html|html)/i.test(head)) return 'html';
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (/^\ufeff?1\r?\n\d\d:\d\d:\d\d,\d{3} -->/.test(head)) return 'srt';
  if (head.startsWith('[Script Info]')) return 'ass';
  if (head.startsWith('<?xml')) return 'xml';
  return null;
}

/** The file's name from a Content-Disposition header (filename*=UTF-8''… first, then filename="…"). */
export function dispositionName(cd: string | undefined): string | null {
  if (!cd) return null;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd); if (star) { try { return decodeURIComponent(star[2].trim()); } catch { return star[2].trim(); } }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(cd); if (plain) { const v = (plain[2] ?? plain[3] ?? '').trim(); try { return /%[0-9a-f]{2}/i.test(v) ? decodeURIComponent(v) : v; } catch { return v; } }
  return null;
}

/** `%XX` sequences decoded, a bare «%» (or a broken sequence) left as it is: decodeURIComponent throws on «100%.mkv»
 *  and the download — a whole batch — stopped there. */
export const safeDecode = (s: string): string => { try { return decodeURIComponent(s); } catch { return s.replace(/(%[0-9a-f]{2})+/gi, (m) => { try { return decodeURIComponent(m); } catch { return m; } }); } };
/** The name a link gives by itself (its last part, decoded), or the host. */
export function nameFromUrl(url: string): string {
  try { const u = new URL(url); const last = u.pathname.split('/').filter(Boolean).pop() ?? ''; const d = safeDecode(last); return d && d !== '/' ? d : u.hostname; } catch { return url.split('?')[0].split('/').pop() ?? url; }
}

/** The stem and the extension of a name («Movie.S01E01.mkv» → mkv; «v1.2» → none, since 2 is not one). */
export function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.'); if (dot <= 0) return { stem: name, ext: '' };
  const ext = name.slice(dot + 1).toLowerCase(); if (!/^[a-z0-9]{1,5}$/i.test(ext) || /^\d+$/.test(ext)) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext };
}

const within = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise((res, rej) => { const tm = setTimeout(() => rej(new Error('timeout')), ms); p.then((v) => { clearTimeout(tm); res(v); }, (e) => { clearTimeout(tm); rej(e); }); });
const header = (hs: Record<string, string> | undefined, k: string): string | undefined => { if (!hs) return undefined; for (const [a, v] of Object.entries(hs)) if (a.toLowerCase() === k) return v; return undefined; };

/** The link looked at: a HEAD for the size and the name, then its first bytes (a range) for what it is. */
export async function probeUrl(url: string, headers: Record<string, string> = {}): Promise<Probe> {
  let name = nameFromUrl(url); let size: number | undefined; let type: string | undefined; let resumable: boolean | undefined; let finalUrl: string | undefined;
  let headOk = false; let status: number | undefined;
  try {
    const r = await within(request(url, { method: 'HEAD', headers }), 8000); status = r.status;
    if (r.status >= 200 && r.status < 400) {
      headOk = true; finalUrl = r.url;
      const len = Number(header(r.headers, 'content-length')); if (len > 0) size = len;
      type = (header(r.headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase() || undefined;
      resumable = /bytes/i.test(header(r.headers, 'accept-ranges') ?? '');
      const dn = dispositionName(header(r.headers, 'content-disposition')); if (dn) name = dn; else if (r.url && r.url !== url) name = nameFromUrl(r.url);
    }
  } catch { /* no HEAD: the bytes say */ }
  let { stem, ext } = splitName(name); let extFrom: Probe['extFrom']; let page = false;
  // (The first bytes, only when the site honours ranges or the file is small — a whole big file is not fetched to look.)
  if (headOk && type === 'text/html' && !/^html?$/.test(ext)) page = true;
  const canRange = !page && (!headOk || resumable || (size !== undefined && size <= 8 << 20));
  if (canRange) {
    try {
      const r = await within(request(url, { headers: { ...headers, Range: 'bytes=0-4095' }, binary: true }), 10000);
      if (status === undefined || status === 405 || status === 501) status = r.status;
      if (r.status === 206 || r.status === 200) {
        const bytes = Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0));
        if (!headOk) {
          finalUrl = r.url; const cr = /\/(\d+)\s*$/.exec(header(r.headers, 'content-range') ?? ''); if (cr) size = Number(cr[1]); else if (r.status === 200) { const len = Number(header(r.headers, 'content-length')); if (len > 0) size = len; }
          type = (header(r.headers, 'content-type') ?? '').split(';')[0].trim().toLowerCase() || undefined; resumable = r.status === 206;
          const dn = dispositionName(header(r.headers, 'content-disposition')); if (dn) { name = dn; ({ stem, ext } = splitName(name)); }
        }
        const sn = sniffBytes(bytes);
        if (sn === 'html' && !/^html?$/.test(ext)) page = true;
        else if (sn && sn !== 'html' && (weakExt(ext) || (ext === 'zip' && sn !== 'zip'))) { if (sn !== 'zip' || weakExt(ext)) { ext = sn; extFrom = 'bytes'; } }
      }
    } catch { /* the name decides */ }
  }
  if (weakExt(ext) && type && TYPES[type] && type !== 'application/octet-stream') { ext = TYPES[type]; extFrom = 'type'; }
  return { size, name, stem, ext, extFrom, type, resumable, page, finalUrl, status };
}
