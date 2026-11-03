// The reader's glossary for translation (IReader's): names and terms given the rendering the reader wants —
// "Lin Feng" always «لين فنغ», a sect's name always the same — for every book, for one, or kept in a folder (a
// series' names, a world's) that any book can use. The terms a passage
// holds are handed to the model with it, and a term it left as it was is put right after.

export type TermKind = 'person' | 'place' | 'group' | 'term';
export interface Term { id: string; from: string; to: string; /** a book's id, or every book when absent */ book?: string; /** a glossary folder's id (then for the books using that folder) */ folder?: string; /** the language it renders into (ar, en…): used only when translating into it */ lang?: string; /** what it names (characters, places…) */ kind?: TermKind; /** added by the translator on its own */ auto?: boolean }

const KEY = 'kr.glossary';
let cache: Term[] | null = null;
const lower = (s: string) => s.toLocaleLowerCase().trim();
// (A place and a language: the same name may be kept for Arabic and for English renderings side by side.)
const scopeOf = (x: Term) => `${x.folder ? `f:${x.folder}` : x.book ? `b:${x.book}` : 'all'}|${x.lang ? SCRIPT_OF_LANG(x.lang) : scriptOf(x.to)}`;
/** One term for each name in each place (a book, a folder, every book): the one written by hand kept over one the
 *  translator added, else the latest. */
export function dedupe(list: Term[]): Term[] {
  const at = new Map<string, number>(); const out: Term[] = [];
  for (const x of list) {
    const k = `${scopeOf(x)}|${lower(x.from)}`; const i = at.get(k);
    if (i === undefined) { at.set(k, out.length); out.push(x); continue; }
    const had = out[i]; if (had.auto && !x.auto) out[i] = x; else if (!!had.auto === !!x.auto) out[i] = x;
  }
  return out;
}
export function terms(): Term[] {
  if (cache) return cache;
  try { const raw = (JSON.parse(localStorage.getItem(KEY) ?? '[]') as Term[]).filter((x) => x && x.from && x.to); cache = dedupe(raw); if (cache.length !== raw.length) saveTerms(cache); } catch { cache = []; }
  return cache;
}
export function saveTerms(list: Term[]): void { cache = dedupe(list.filter((x) => x.from.trim() && x.to.trim())); try { if (cache.length) localStorage.setItem(KEY, JSON.stringify(cache)); else localStorage.removeItem(KEY); } catch { /* full */ } }
/** Terms added without doubling any (a name already there for the same place is left as it is, unless only the
 *  translator had put it); how many were new. */
export function addTerms(add: Omit<Term, 'id'>[]): number {
  const list = terms().slice(); const have = new Map(list.map((x, i) => [`${scopeOf(x)}|${lower(x.from)}`, i])); let n = 0;
  for (const a of add) {
    const x = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, ...a } as Term; const k = `${scopeOf(x)}|${lower(x.from)}`; const i = have.get(k);
    if (i === undefined) { have.set(k, list.length); list.push(x); n++; } else if (list[i].auto && !x.auto) list[i] = { ...list[i], to: x.to, kind: x.kind ?? list[i].kind, auto: undefined };
  }
  saveTerms(list); return n;
}

/* ---------- folders: glossaries of their own, for any book ---------- */
export interface Folder { id: string; name: string }
const FKEY = 'kr.glossaryFolders', LKEY = 'kr.glossaryLinks';
const read = <T>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') as T; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full */ } };
export const folders = (): Folder[] => read<Folder[]>(FKEY, []);
export function addFolder(name: string): Folder { const f = { id: Math.random().toString(36).slice(2, 10), name: name.trim() }; write(FKEY, [...folders(), f]); return f; }
export function renameFolder(id: string, name: string): void { write(FKEY, folders().map((f) => (f.id === id ? { ...f, name: name.trim() } : f))); }
export function removeFolder(id: string): void { write(FKEY, folders().filter((f) => f.id !== id)); saveTerms(terms().filter((x) => x.folder !== id)); const l = read<Record<string, string[]>>(LKEY, {}); for (const k of Object.keys(l)) l[k] = l[k].filter((x) => x !== id); write(LKEY, l); }
/** The folders a book uses. */
export const linkedFolders = (bookId?: string): string[] => (bookId ? read<Record<string, string[]>>(LKEY, {})[bookId] ?? [] : []);
export function setLinked(bookId: string, ids: string[]): void { const l = read<Record<string, string[]>>(LKEY, {}); l[bookId] = [...new Set(ids)]; write(LKEY, l); }
/** The script a rendering is written in, and the one a language is written in: a term renders into the language
 *  it was made for (or, made before languages were kept, the one its script fits) — so a name kept in English
 *  letters is not forced into an Arabic translation. */
const SCRIPT_OF_LANG = (l: string): string => (/^(ar|fa|ur|ps|ku|sd|ug)/.test(l) ? 'arabic' : /^(ru|uk|bg|sr|mk|be|kk)/.test(l) ? 'cyrillic' : /^(zh|ja)/.test(l) ? 'cjk' : /^ko/.test(l) ? 'hangul' : /^he/.test(l) ? 'hebrew' : /^(th)/.test(l) ? 'thai' : /^(hi|mr|ne)/.test(l) ? 'devanagari' : 'latin');
export function scriptOf(text: string): string {
  const x = text.replace(/[\s\d\p{P}\p{S}]/gu, ''); if (!x) return '';
  const count = (re: RegExp) => (x.match(re)?.length ?? 0);
  const tally: [string, number][] = [['arabic', count(/[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/g)], ['cyrillic', count(/[\u0400-\u04ff]/g)], ['cjk', count(/[\u3040-\u30ff\u4e00-\u9fff]/g)], ['hangul', count(/[\uac00-\ud7af]/g)], ['hebrew', count(/[\u0590-\u05ff]/g)], ['thai', count(/[\u0e00-\u0e7f]/g)], ['devanagari', count(/[\u0900-\u097f]/g)], ['latin', count(/[a-zA-Z\u00c0-\u024f]/g)]];
  return tally.sort((a, b) => b[1] - a[1])[0][1] ? tally[0][0] : '';
}
export const langOfTerm = (x: Term): string => (x.lang ? x.lang.split('-')[0] : '');
/** Whether a term is for translations into `target`. */
export function fitsTarget(x: Term, target?: string): boolean {
  if (!target) return true; const tl = target.split('-')[0];
  if (x.lang) return x.lang.split('-')[0] === tl;
  const sc = scriptOf(x.to); return !sc || sc === SCRIPT_OF_LANG(tl);
}
/** Every term that applies to a book (into `target`, when given): its own first, then its folders', then the
 *  general ones (one per name). */
export function termsFor(bookId?: string, target?: string): Term[] {
  const all = terms().filter((x) => fitsTarget(x, target)); const linked = new Set(linkedFolders(bookId)); const seen = new Set<string>(); const out: Term[] = [];
  for (const x of [...all.filter((t) => !t.folder && t.book && t.book === bookId), ...all.filter((t) => t.folder && linked.has(t.folder)), ...all.filter((t) => !t.book && !t.folder)]) { const k = lower(x.from); if (seen.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}

/** A short mark of the whole glossary: translations made with another glossary are made again. */
export function glossaryStamp(): string { return glossaryStampOf(terms()); }
export function glossaryStampOf(l: Term[]): string { if (!l.length) return ''; let h = 0; const s = JSON.stringify(l.map((x) => (x.folder ? [x.from, x.to, x.book ?? '', x.folder] : [x.from, x.to, x.book ?? '']))); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); }

/** The terms that apply to a book and appear in the texts (its own, then its folders', then the general ones). */
export function termsIn(texts: string[], bookId?: string, target?: string): Term[] {
  const list = termsFor(bookId, target); if (!list.length) return [];
  const hay = lower(texts.join('\n'));
  return list.filter((x) => hay.includes(lower(x.from)));
}
/** The lines the model is given with a passage. */
export function glossaryPrompt(list: Term[]): string {
  if (!list.length) return '';
  return `Glossary — translate these names and terms exactly as given, every time:\n${list.map((x) => `- ${JSON.stringify(x.from)} → ${JSON.stringify(x.to)}`).join('\n')}`;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A term the model left untranslated put right. */
export function applyGlossary(text: string, list: Term[]): string {
  let s = text;
  for (const x of list) { if (lower(x.from) === lower(x.to)) continue; s = s.replace(new RegExp(esc(x.from), 'gi'), x.to); }
  return s;
}

/* ---------- where the names the translator finds go, for each book ---------- */
/** 'book' — the book's own list; 'auto' — a folder made by itself for the book's series (found again for its
 *  other volumes); or a folder's id. `addNew`: new names put into that folder (else it is only used, and new
 *  names stay with the book). */
export interface Dest { to: 'book' | 'auto' | string; addNew: boolean }
const DKEY = 'kr.glossaryDest';
export const destOf = (bookId: string): Dest => { const all = read<Record<string, Dest>>(DKEY, {}); const d = all[bookId] ?? all['*']; return { to: d?.to ?? 'book', addNew: d?.addNew ?? true }; };
export function setDest(bookId: string, d: Dest): void { const all = read<Record<string, Dest>>(DKEY, {}); all[bookId] = d; write(DKEY, all); }
/** A series' name from a volume's title: «回復術士のやり直し 8 ～…», «Overlord Vol. 3», «Book 2: …» → the part before
 *  the number. */
export function seriesOf(title: string): string {
  const t0 = title.replace(/[（(\[【].*?[)）\]】]/g, ' ').trim();
  const m = /^(.*?)(?:\s*[-–—:：~～]?\s*(?:vol(?:ume)?\.?|book|tome|part|الجزء|المجلد|第)?\s*[0-9０-９٠-٩]+(?:巻|卷|권)?\b.*)$/i.exec(t0);
  const base = (m && m[1].trim().length >= 2 ? m[1] : t0).replace(/[\s\-–—:：~～]+$/, '').trim();
  return base || title;
}
/** Where a book's new names go now: the folder (made, and used by the book, when it is to be made by itself),
 *  or the book itself. */
export function namesTarget(bookId: string, title: string): { book?: string; folder?: string } {
  const d = destOf(bookId);
  if (d.to === 'book') return { book: bookId };
  let id = d.to;
  if (d.to === 'auto') { const name = seriesOf(title); id = folders().find((f) => f.name === name)?.id ?? addFolder(name).id; }
  if (!folders().some((f) => f.id === id)) return { book: bookId };
  if (!linkedFolders(bookId).includes(id)) setLinked(bookId, [...linkedFolders(bookId), id]);
  return d.addNew ? { folder: id } : { book: bookId };
}
