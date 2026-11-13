// Names in the Files browser, pure (tests/filesnames.cjs runs them in node): a name split into its stem and its
// extension the way the phone's side does (KtFileJobs.extOf: the last dot, not the first character, a short ending),
// and the batch rename's pattern.
export type NamedEntry = { name: string; dir: boolean; size: number; mtime: number };
/** «Show.S01E01.720p.mkv» → [«Show.S01E01.720p», «mkv»]; «archive.tar.gz» → [«archive.tar», «gz»] (the last one only);
 *  «.gitignore», «README», «notes.» and «a.verylongending» have none; a folder has none. */
export function splitExt(name: string, dir = false): [string, string] {
  const i = name.lastIndexOf('.'); if (dir || i <= 0 || i === name.length - 1 || name.length - i > 8) return [name, ''];
  return [name.slice(0, i), name.slice(i + 1)];
}
const pad = (n: number, w: number) => String(n).padStart(w, '0');
/** The new name of `e` by the pattern: {name} {ext} {name.ext} {size} {date} {time} {now} {n} (with {n:3} for zeros),
 *  then find → replace. A file keeps its extension unless the pattern places it itself ({ext} or {name.ext}); what no
 *  storage takes (\ / : * ? " < > | and control characters) becomes a space; spaces and dots at the ends of the stem go
 *  (a card's FAT refuses them). '' when nothing is left. */
export function patternName(e: NamedEntry, pattern: string, i: number, start: number, find: string, replace: string, fmtSize: (n: number) => string = String): string {
  const [stem, ext] = splitExt(e.name, e.dir);
  const d = new Date(e.mtime); const now = new Date(); const ymd = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1, 2)}-${pad(x.getDate(), 2)}`; const hm = (x: Date) => `${pad(x.getHours(), 2)}${pad(x.getMinutes(), 2)}`;
  let out = pattern.replace(/\{n(?::(\d))?\}/g, (_, w) => pad(start + i, Number(w ?? 1))).replace(/\{name\.ext\}/g, e.name).replace(/\{name\}/g, stem).replace(/\{ext\}/g, ext).replace(/\{size\}/g, fmtSize(e.size).replace(/\s/g, '')).replace(/\{date\}/g, ymd(d)).replace(/\{time\}/g, hm(d)).replace(/\{now\}/g, ymd(now));
  if (find) out = out.split(find).join(replace);
  const keepExt = !e.dir && !!ext && !/\{(ext|name\.ext)\}/.test(pattern);
  // (A name the pattern leaves as it was stays exactly so — «notes.» is not quietly renamed «notes».)
  if ((keepExt ? `${out}.${ext}` : out) === e.name) return e.name;
  out = out.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/^\s+/, '').replace(/[\s.]+$/, '');
  if (keepExt && out) out += `.${ext}`;
  return out === '.' || out === '..' ? '' : out;
}
/** The indexes whose new names clash — with each other, letter case aside (the phone's storage ignores it). */
export function clashes(names: string[]): Set<number> {
  const seen = new Map<string, number[]>(); names.forEach((n, i) => { const k = n.toLowerCase(); seen.set(k, [...(seen.get(k) ?? []), i]); });
  const bad = new Set<number>(); for (const ix of seen.values()) if (ix.length > 1) for (const i of ix) bad.add(i); return bad;
}
/** The way a name reads: right to left when its first strong letter is Arabic, Hebrew, Syriac, Thaana or N'Ko. */
export function textDir(s: string): 'ltr' | 'rtl' {
  for (const ch of s) { if (/[֐-ࣿיִ-﷿ﹰ-﻿]/.test(ch)) return 'rtl'; if (/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ぀-ヿ㐀-鿿가-힯]/.test(ch)) return 'ltr'; }
  return 'ltr';
}
/** A name cut in two for a middle ellipsis: the head (which gives way, «HOREMAJO_03_KARAO…») and the tail that always
 *  shows — the last few letters of the stem and the whole extension («D (1).zip»). */
export function nameParts(name: string, dir = false): { head: string; tail: string; dir: 'ltr' | 'rtl' } {
  const [stem, ext] = splitExt(name, dir); const chars = [...stem]; const way = textDir(name); let keep = Math.min(5, Math.floor(chars.length / 2));
  // (A right-to-left name is cut only between words or at a bracket — never inside a word, whose letters join.)
  if (way === 'rtl') { keep = 0; for (let i = chars.length - 1; i >= Math.max(1, chars.length - 14); i--) if (/[\s_\-.([{]/.test(chars[i])) { keep = chars.length - i; break; } }
  return { head: chars.slice(0, chars.length - keep).join(''), tail: chars.slice(chars.length - keep).join('') + (ext ? `.${ext}` : ''), dir: way };
}
/** A row's second line: the parts that have something to say, one « · » between them — never one left hanging. */
export const joinMeta = (parts: (string | null | undefined | false)[]): string => parts.filter((x): x is string => !!x && !!x.trim()).join(' · ');
/** A place as a person reads it: inside an archive, the archive's own path then the folder inside it («…/a.zip › Fonts»),
 *  never the encoded form the address carries. */
export function readablePath(p: string): string {
  const m = /^arc:\/\/([^/]+)(?:\/(.*))?$/.exec(p); if (!m) return p;
  let archive = m[1]; try { archive = decodeURIComponent(m[1]); } catch { /* as it is */ }
  const inner = (m[2] ?? '').replace(/\/+$/, ''); return inner ? `${archive} › ${inner.split('/').join(' › ')}` : archive;
}
/** A place's own name, for a title: the last folder, or inside an archive the folder there (the archive's name at its top). */
export function placeName(p: string): string {
  const m = /^arc:\/\/([^/]+)(?:\/(.*))?$/.exec(p);
  if (m) { const inner = (m[2] ?? '').replace(/\/+$/, ''); if (inner) return inner.split('/').pop() ?? inner; let a = m[1]; try { a = decodeURIComponent(m[1]); } catch { /* as it is */ } return a.replace(/\/+$/, '').split('/').pop() ?? a; }
  return p.replace(/\/+$/, '').split('/').pop() ?? p;
}
