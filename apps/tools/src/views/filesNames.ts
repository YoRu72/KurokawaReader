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
