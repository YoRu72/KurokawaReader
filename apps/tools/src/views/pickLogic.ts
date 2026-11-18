// Another app's «pick a file», as the Files page reads it (plain logic, no page: tests/picker.cjs runs it alone).
// The request comes from the Android side (KtPickActivity): what was asked (GET_CONTENT, PICK), one file or several,
// the kinds of file wanted (MIME types, «image/*»…), the asking app's name. A file's kind is told from its name.
export type PickRequest = { id: string; action: string; multiple: boolean; mimes: string[]; caller: string };

/** The request read once: any field missing or of the wrong sort falls back to «one file, any kind». */
export function parsePick(raw: unknown): PickRequest | null {
  let o: unknown = raw;
  if (typeof raw === 'string') { try { o = JSON.parse(raw); } catch { return null; } }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const mimes = (Array.isArray(r.mimes) ? r.mimes : typeof r.mimes === 'string' ? [r.mimes] : [])
    .filter((m): m is string => typeof m === 'string').map((m) => m.trim().toLowerCase()).filter((m) => /^[a-z0-9.+*-]+\/[a-z0-9.+*-]+$/.test(m));
  return { id: typeof r.id === 'string' ? r.id : '', action: typeof r.action === 'string' ? r.action : '', multiple: r.multiple === true, mimes: [...new Set(mimes)], caller: typeof r.caller === 'string' ? r.caller.trim() : '' };
}

const EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mov: 'video/quicktime', avi: 'video/x-msvideo', '3gp': 'video/3gpp', ts: 'video/mp2t', m2ts: 'video/mp2t', mts: 'video/mp2t', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', mpg: 'video/mpeg', mpeg: 'video/mpeg', ogv: 'video/ogg',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav', wma: 'audio/x-ms-wma', amr: 'audio/amr', mid: 'audio/midi',
  txt: 'text/plain', nfo: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html', xml: 'text/xml', json: 'application/json',
  srt: 'application/x-subrip', ass: 'text/x-ssa', ssa: 'text/x-ssa', vtt: 'text/vtt', sub: 'text/plain',
  pdf: 'application/pdf', epub: 'application/epub+zip', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text', rtf: 'application/rtf',
  zip: 'application/zip', rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip', apk: 'application/vnd.android.package-archive', torrent: 'application/x-bittorrent',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};
/** A file's MIME type from its name; «application/octet-stream» when the name says nothing. */
export function mimeOfName(name: string): string { const m = /\.([a-z0-9]+)$/i.exec(name); return (m && EXT[m[1].toLowerCase()]) || 'application/octet-stream'; }
/** Whether a file of type `mime` answers the request: any kind when none was named (or «*\/*»); «image/*» takes every
 *  picture; a subtitle counts as text too (an app asking for «text/*» means them as well). */
export function mimeMatches(mime: string, wanted: string[]): boolean {
  if (!wanted.length || wanted.some((w) => w === '*/*' || w === 'application/octet-stream')) return true;
  const [type] = mime.split('/'); const sub = mime === 'application/x-subrip';
  return wanted.some((w) => { const [wt, ws] = w.split('/'); if (ws === '*') return wt === type || (wt === 'text' && sub); return w === mime || (w === 'text/plain' && (sub || mime === 'text/x-ssa' || mime === 'text/vtt')); });
}
/** What the answer hands back: the paths in the order chosen, one only when one was asked for. */
export function pickResult(req: PickRequest, chosen: string[]): string[] { const uniq = [...new Set(chosen.filter(Boolean))]; return req.multiple ? uniq : uniq.slice(0, 1); }
/** The kinds asked for, for the screen's line («Pictures, PDF»): known families by their name, the rest as written. */
export function kindsAsked(wanted: string[], names: { image: string; video: string; audio: string; text: string }): string[] {
  if (!wanted.length || wanted.some((w) => w === '*/*')) return [];
  return [...new Set(wanted.map((w) => { const [wt, ws] = w.split('/'); if (ws === '*' && wt in names) return names[wt as keyof typeof names]; const ext = Object.keys(EXT).find((k) => EXT[k] === w); return ext ? ext.toUpperCase() : w; }))];
}
