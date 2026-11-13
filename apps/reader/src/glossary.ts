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
// (Kept apart by language, not by script: an English and a French rendering of one name, or an Arabic and a Persian
// one, are two terms — the one made later no longer takes the other's place.)
const scopeOf = (x: Term) => `${x.folder ? `f:${x.folder}` : x.book ? `b:${x.book}` : 'all'}|${termLang(x) || `script:${scriptOf(x.to)}`}`;
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
  try { legacyLang(); const raw = (JSON.parse(localStorage.getItem(KEY) ?? '[]') as Term[]).filter((x) => x && x.from && x.to); cache = dedupe(raw); if (cache.length !== raw.length) saveTerms(cache); } catch { cache = []; }
  return cache;
}
export function saveTerms(list: Term[]): void { cache = dedupe(list.filter((x) => x.from.trim() && x.to.trim())); try { if (cache.length) localStorage.setItem(KEY, JSON.stringify(cache)); else localStorage.removeItem(KEY); } catch { /* full */ } }
/** Terms added without doubling any (a name already there for the same place is left as it is, unless only the
 *  translator had put it); how many were new. */
export function addTerms(add: Omit<Term, 'id'>[]): number {
  const list = terms().slice(); const have = new Map(list.map((x, i) => [`${scopeOf(x)}|${lower(x.from)}`, i])); let n = 0;
  for (const a of add) {
    const x = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, ...a } as Term; const k = `${scopeOf(x)}|${lower(x.from)}`; const i = have.get(k);
    if (i === undefined) { have.set(k, list.length); list.push(x); n++; }
    else if (list[i].auto && !x.auto) list[i] = { ...list[i], to: x.to, kind: x.kind ?? list[i].kind, auto: undefined };
    // (One the translator had put in the wrong script for its language — «Keyaru» kept as Arabic — made right by a
    // rendering that is in it; one written by hand is left as it is.)
    else if (list[i].auto && misScripted(list[i]) && !misScripted(x)) { list[i] = { ...list[i], to: x.to, kind: x.kind ?? list[i].kind }; n++; }
  }
  saveTerms(list); return n;
}

/** A glossary as text, one term to a line — `name = rendering`, then after a tab its kind and its language —, to paste
 *  into another tool or back (parseTerms reads it). */
const flat = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();
export const termLine = (x: Pick<Term, 'from' | 'to' | 'kind' | 'lang'>, extra = true): string => `${flat(x.from)} = ${flat(x.to)}` + (extra && (x.kind || x.lang) ? `\t${x.kind ?? ''}\t${x.lang ?? ''}` : '');
export const termsText = (list: Term[]): string => list.map((x) => termLine(x)).join('\n');
export function parseTerms(text: string): { from: string; to: string; kind?: TermKind; lang?: string }[] {
  const out: { from: string; to: string; kind?: TermKind; lang?: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pair, kind, lang] = line.split('\t'); const i = pair.includes(' = ') ? pair.indexOf(' = ') : pair.indexOf('=');
    if (i < 0) continue; const from = pair.slice(0, i).trim(), to = pair.slice(i + (pair.includes(' = ') ? 3 : 1)).trim(); if (!from || !to) continue;
    out.push({ from, to, ...(['person', 'place', 'group', 'term'].includes(kind?.trim()) ? { kind: kind.trim() as TermKind } : {}), ...(lang?.trim() ? { lang: lang.trim() } : {}) });
  }
  return out;
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
/** Books taken out of the library: their own terms, folder links and destination let go (a folder's terms and
 *  every book's stay — other books use them). */
export function forgetBooks(ids: Iterable<string>): void {
  const gone = new Set(ids); if (!gone.size) return;
  if (terms().some((x) => x.book && gone.has(x.book))) saveTerms(terms().filter((x) => !x.book || !gone.has(x.book)));
  for (const k of [LKEY, 'kr.glossaryDest']) { const m = read<Record<string, unknown>>(k, {}); if ([...gone].some((id) => id in m)) { for (const id of gone) if (id !== '*') delete m[id]; write(k, m); } }
}
/** The folders a book uses. */
export const linkedFolders = (bookId?: string): string[] => (bookId ? read<Record<string, string[]>>(LKEY, {})[bookId] ?? [] : []);
export function setLinked(bookId: string, ids: string[]): void { const l = read<Record<string, string[]>>(LKEY, {}); l[bookId] = [...new Set(ids)]; write(LKEY, l); }
/* ---------- languages and scripts: every term for the language it renders into ---------- */
// The letters of each script (marks, digits, spaces and punctuation are not counted).
const SCRIPTS: Record<string, RegExp> = {
  arabic: /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/gu,
  cyrillic: /[Ѐ-ԯ]/gu, greek: /[Ͱ-Ͽἀ-῿]/gu, hebrew: /[֐-׿יִ-ﭏ]/gu,
  thai: /[฀-๿]/gu, devanagari: /[ऀ-ॿ]/gu, armenian: /[԰-֏]/gu, georgian: /[Ⴀ-ჿ]/gu,
  hangul: /[가-힯ᄀ-ᇿ㄰-㆏]/gu, kana: /[぀-ヿㇰ-ㇿｦ-ﾟ]/gu, han: /[㐀-䶿一-鿿豈-﫿]/gu,
  latin: /[a-zA-ZÀ-ɏḀ-ỿ]/gu,
};
/** The script each language is written in ('japanese': kana and kanji; 'chinese': Han alone). A language written
 *  in more than one (Serbian, Kurdish…) or not listed has none: its renderings cannot be told apart by script. */
const LANG_SCRIPT: Record<string, string> = {};
for (const [sc, ls] of Object.entries({
  arabic: 'ar fa ur ps sd ug ckb', cyrillic: 'ru uk bg mk be kk ky tg mn', greek: 'el', hebrew: 'he iw yi', thai: 'th', devanagari: 'hi mr ne sa',
  armenian: 'hy', georgian: 'ka', hangul: 'ko', japanese: 'ja', chinese: 'zh',
  latin: 'en fr de es it pt nl id ms tr vi pl cs sk ro sv da no nb nn fi hu tl fil sw ca eu gl et lv lt sl hr bs sq is ga cy af az uz eo la mt so ha yo ig zu xh jv su',
})) for (const l of ls.split(' ')) LANG_SCRIPT[l] = sc;
const base = (l?: string) => (l ?? '').trim().split(/[-_]/)[0].toLowerCase();
export const scriptOfLang = (lang: string): string => LANG_SCRIPT[base(lang)] ?? '';
const lettersOf = (text: string) => text.replace(/[\s\d\p{P}\p{S}\p{M}]/gu, '');
const countIn = (x: string, sc: string) => x.match(SCRIPTS[sc])?.length ?? 0;
/** The script a rendering is mostly written in ('cjk' for kana and Han), or '' when it holds no letters. */
export function scriptOf(text: string): string {
  const x = lettersOf(text); if (!x) return '';
  const tally: [string, number][] = Object.keys(SCRIPTS).filter((k) => k !== 'kana' && k !== 'han').map((k) => [k, countIn(x, k)] as [string, number]);
  tally.push(['cjk', countIn(x, 'kana') + countIn(x, 'han')]);
  tally.sort((a, b) => b[1] - a[1]); return tally[0][1] ? tally[0][0] : '';
}
/** Whether a rendering is written in the script of `lang`: 'ok', 'bad' (plainly another script — «Keyaru» for
 *  Arabic, Japanese, Russian…), or 'unknown' (a language whose script is not known, or no letters). Two languages
 *  of one script (English and French) cannot be told apart this way: their terms rely on the language kept with
 *  each. */
export function scriptVerdict(text: string, lang: string): 'ok' | 'bad' | 'unknown' {
  const sc = scriptOfLang(lang); const x = lettersOf(text); if (!sc || !x) return 'unknown';
  const n = [...x].length;
  const hit = sc === 'japanese' ? countIn(x, 'kana') + countIn(x, 'han') : sc === 'chinese' ? (countIn(x, 'kana') ? 0 : countIn(x, 'han')) : countIn(x, sc);
  return hit / n >= 0.6 ? 'ok' : 'bad';
}
/** The language guessed from a rendering's script alone, where only one language is written in it (Korean, Thai,
 *  Greek, Hebrew, Japanese kana…); '' for the scripts many languages share (Latin, Arabic, Cyrillic, Han…). */
export function langFromScript(text: string): string {
  const x = lettersOf(text); if (!x) return ''; const n = [...x].length;
  if (countIn(x, 'kana') / n >= 0.3 && (countIn(x, 'kana') + countIn(x, 'han')) / n >= 0.6) return 'ja';
  const one: [string, string][] = [['hangul', 'ko'], ['thai', 'th'], ['greek', 'el'], ['hebrew', 'he'], ['armenian', 'hy'], ['georgian', 'ka']];
  for (const [sc, l] of one) if (countIn(x, sc) / n >= 0.6) return l;
  return '';
}
/* Terms made before each was kept with its language. They are never rewritten: the language they were made for is
   taken, where it can be, from the language being translated into when this version first met them (kept once, on
   this device), and only when the rendering is in that language's script; else from a script only one language
   uses; else it is not known — the term is then used for no language and shown as «language not set», for the
   reader to set. */
const LEGACY = 'kr.glossaryLegacyLang';
let legacy: string | undefined;
export function legacyLang(): string {
  if (legacy) return legacy;
  try {
    const kept = localStorage.getItem(LEGACY); if (kept) return (legacy = kept);
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Term[];
    if (Array.isArray(raw) && raw.some((x) => x && x.from && !x.lang)) {
      let tg = 'ar'; try { tg = (JSON.parse(localStorage.getItem('kr.visual') ?? '{}') as { aiTarget?: string }).aiTarget || 'ar'; } catch { /* the default */ }
      legacy = base(tg); localStorage.setItem(LEGACY, legacy); return legacy;
    }
  } catch { /* storage unreadable */ }
  return '';
}
/** (Tests: the kept language read again.) */
export const _forgetLegacy = (): void => { legacy = undefined; };
/** The language a term renders into: its own; for one made before languages were kept, the one it can be known
 *  to have been made for; else ''. */
export function termLang(x: Pick<Term, 'lang' | 'to'>): string {
  if (x.lang) return base(x.lang);
  const one = langFromScript(x.to); if (one) return one;
  const l = legacyLang(); return l && scriptVerdict(x.to, l) === 'ok' ? l : '';
}
export const langOfTerm = (x: Term): string => termLang(x);
/** A term whose rendering is plainly not in its language's script («Keyaru» kept as Arabic): not used — the name
 *  is then as if it had no rendering yet — and shown for the reader to put right. */
export const misScripted = (x: Pick<Term, 'lang' | 'to'>): boolean => { const l = termLang(x); return !!l && scriptVerdict(x.to, l) === 'bad'; };
/** The language a term given without one is kept under: the one translated into when its rendering can be in it;
 *  else the one its script alone tells; else none (shown as «language not set»). */
export function langForNew(to: string, target: string): string {
  const tl = base(target); if (!to.trim() || scriptVerdict(to, tl) !== 'bad') return tl;
  return langFromScript(to);
}
/** Whether a term is for translations into `target`: made for that language, and written in its script. */
export function fitsTarget(x: Term, target?: string): boolean {
  if (!target) return true;
  return termLang(x) === base(target) && !misScripted(x);
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
export function glossaryPrompt(list: Term[], langLabel?: string): string {
  if (!list.length) return '';
  return `Glossary${langLabel ? ` (renderings in ${langLabel})` : ''} — translate these names and terms exactly as given, every time:\n${list.map((x) => `- ${JSON.stringify(x.from)} → ${JSON.stringify(x.to)}`).join('\n')}`;
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// (Letters of the scripts written with spaces between words and nothing joined to them: a term whose edge is one
// of these is only a whole word there — «Lin» is not put right inside «Linda». Arabic and Hebrew (letters joined
// before a name: و، بـ، لـ، الـ), Korean (particles after one), Japanese, Chinese and Thai (no spaces at all) are
// matched anywhere, as before.)
const WORDY = '\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}\\p{Script=Armenian}\\p{Script=Georgian}';
const wordyEdge = new RegExp(`^[${WORDY}\\p{N}]$`, 'u');
/** A term the model left untranslated put right: in one pass over the text (what was put in is not looked at
 *  again), the longest term first where two begin at the same place, the rendering written as it is (a «$&» in it
 *  is not read as a pattern). A term the same in both languages still holds its place, so a shorter one inside it
 *  is not put in. */
export function applyGlossary(text: string, list: Term[]): string {
  const to = new Map<string, string>();
  for (const x of list) { const k = lower(x.from); if (k && !to.has(k)) to.set(k, x.to); }
  if (!to.size) return text;
  const parts = [...list.reduce((m, x) => { const f = x.from.trim(); if (f && !m.has(lower(f))) m.set(lower(f), f); return m; }, new Map<string, string>()).values()]
    .sort((a, b) => b.length - a.length)
    .map((f) => {
      const chars = [...f]; const head = wordyEdge.test(chars[0]), tail = wordyEdge.test(chars[chars.length - 1]);
      return `${head ? `(?<![${WORDY}\\p{N}\\p{M}_])` : ''}${esc(f)}${tail ? `(?![${WORDY}\\p{N}\\p{M}_])` : ''}`;
    });
  let re: RegExp;
  try { re = new RegExp(parts.join('|'), 'giu'); } catch { return text; }
  return text.replace(re, (m) => { const r = to.get(lower(m)); if (r !== undefined) return lower(m) === lower(r) ? m : r; for (const [k, v] of to) if (new RegExp(`^${esc(k)}$`, 'iu').test(m)) return lower(k) === lower(v) ? m : v; return m; });
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
