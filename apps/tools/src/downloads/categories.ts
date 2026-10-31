// Categories (Prism's): what a file is by its extension — video, music, documents, programs, compressed,
// images, other — with the user's own categories winning over the built-ins; each may have a folder of its own,
// or a sub-folder of the download folder when the setting says so.
import { getSettings } from '../settings';
import { t } from '../i18n';

export interface Category { id: string; name: string; icon: string; exts: string[]; dir?: string; builtin?: boolean }
export const BUILTIN: Category[] = [
  { id: 'video', name: 'catVideo', icon: 'film', builtin: true, exts: '3gp asf avi flv m2ts m4v mkv mov mp4 mpe mpeg mpg ogv qt rm rmvb ts vob webm wmv'.split(' ') },
  { id: 'music', name: 'catMusic', icon: 'music', builtin: true, exts: 'aac aif aiff alac ape flac m4a mid mp3 mpa oga ogg opus ra wav wma'.split(' ') },
  { id: 'documents', name: 'catDocuments', icon: 'file', builtin: true, exts: 'csv doc docx epub md odp ods odt pdf pps ppt pptx rtf txt xls xlsx xps cbz cbr mobi azw3'.split(' ') },
  { id: 'programs', name: 'catPrograms', icon: 'apps', builtin: true, exts: 'apk appimage bin deb dmg exe flatpak jar msi msix msu pkg rpm run snap xapk'.split(' ') },
  { id: 'compressed', name: 'catCompressed', icon: 'archive', builtin: true, exts: '7z ace arj bz2 cab gz gzip img iso lz lzh lzma r00 r01 rar sit sitx tar tbz tgz txz xz z zip zst'.split(' ') },
  { id: 'images', name: 'catImages', icon: 'images', builtin: true, exts: 'avif bmp gif heic ico jpeg jpg png psd raw svg tif tiff webp'.split(' ') },
  { id: 'subtitles', name: 'catSubtitles', icon: 'subtitles', builtin: true, exts: 'srt ass ssa vtt sub idx'.split(' ') },
  { id: 'other', name: 'catOther', icon: 'download', builtin: true, exts: [] },
];
export const allCategories = (): Category[] => [...((getSettings().categories ?? []) as Category[]), ...BUILTIN];
export const categoryName = (c: Category): string => (c.builtin ? t(c.name as 'catVideo') : c.name);
export function categoryOf(name: string, kind?: string): Category {
  if (kind === 'torrent' && !/\.\w{2,5}$/.test(name)) return BUILTIN.find((c) => c.id === 'video')!;
  const ext = (/\.(\w{1,6})$/.exec(name)?.[1] ?? '').toLowerCase();
  return allCategories().find((c) => c.exts.includes(ext)) ?? BUILTIN[BUILTIN.length - 1];
}
/** The folder a file of this category lands in, or undefined for the default. */
export function categoryDir(c: Category): string | undefined {
  if (c.dir) return c.dir; const s = getSettings(); const base = s.downloadDir;
  if (s.useCategoryFolders && c.id !== 'other' && base && !base.startsWith('content:')) return `${base.replace(/[\\/]$/, '')}/${categoryName(c)}`;
  return undefined;
}
/** Prism's batch patterns: `[1-10]`, `[001-100]`, `[1-10:2]`, `[10-1]`, `[a-z]`, several ranges multiply; other brackets stay. */
export function expandPattern(url: string, cap = 10000): string[] {
  const re = /\[(\d+)-(\d+)(?::(\d+))?\]|\[([a-zA-Z])-([a-zA-Z])(?::(\d+))?\]/g; const parts: (string | string[])[] = []; let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(url))) {
    parts.push(url.slice(last, m.index)); last = m.index + m[0].length;
    if (m[1] !== undefined) { const a = Number(m[1]), b = Number(m[2]), step = Math.max(1, Number(m[3] ?? 1)), pad = m[1].length > 1 && m[1].startsWith('0') ? m[1].length : 0; const vals: string[] = []; if (a <= b) for (let i = a; i <= b && vals.length < cap; i += step) vals.push(String(i).padStart(pad, '0')); else for (let i = a; i >= b && vals.length < cap; i -= step) vals.push(String(i).padStart(pad, '0')); parts.push(vals); }
    else { const a = m[4].charCodeAt(0), b = m[5].charCodeAt(0), step = Math.max(1, Number(m[6] ?? 1)); const vals: string[] = []; if (a <= b) for (let i = a; i <= b; i += step) vals.push(String.fromCharCode(i)); else for (let i = a; i >= b; i -= step) vals.push(String.fromCharCode(i)); parts.push(vals); }
  }
  parts.push(url.slice(last));
  let out = ['']; for (const p of parts) { if (typeof p === 'string') out = out.map((x) => x + p); else { const next: string[] = []; for (const x of out) for (const v of p) { next.push(x + v); if (next.length >= cap) break; } out = next; } if (out.length >= cap) break; }
  return out.slice(0, cap);
}
