// The reader's glossary for translation (IReader's): names and terms given the rendering the reader wants —
// "Lin Feng" always «لين فنغ», a sect's name always the same — for every book, for one, or kept in a folder (a
// series' names, a world's) that any book can use. The terms a passage
// holds are handed to the model with it, and a term it left as it was is put right after.

/** What a term names — the glossary's «files»: the built-in ones, then the reader's own (`u:` and the name he gave). */
export const KINDS = ['person', 'place', 'group', 'skill', 'item', 'title', 'creature', 'event', 'quote', 'term'] as const;
export type BuiltinKind = typeof KINDS[number];
export type TermKind = BuiltinKind | `u:${string}`;
/** A term's file: its own kind when known (built-in or the reader's), else «Terms» — old data and odd answers too. */
export const kindOf = (x: Pick<Term, 'kind'> | string | undefined): TermKind => { const k = typeof x === 'string' ? x : x?.kind; return k && ((KINDS as readonly string[]).includes(k) || (k.startsWith('u:') && k.length > 2)) ? k as TermKind : 'term'; };
// (What a model may call each kind, in English, singular or plural.)
const SYN: [RegExp, BuiltinKind][] = [
  [/^(person|people|persons|characters?|chars?|names?|humans?|npcs?|protagonists?|heroe?s?)$/, 'person'],
  [/^(places?|locations?|cit(y|ies)|towns?|villages?|countr(y|ies)|kingdoms?|empires?|regions?|buildings?|realms?|worlds?|lands?|geography)$/, 'place'],
  [/^(groups?|organi[sz]ations?|orgs?|clans?|sects?|schools?|factions?|guilds?|famil(y|ies)|houses?|tribes?|part(y|ies)|teams?|armies|army|orders?)$/, 'group'],
  [/^(skills?|spells?|magic|techniques?|abilit(y|ies)|arts?|moves?|powers?)$/, 'skill'],
  [/^(items?|weapons?|artifacts?|artefacts?|objects?|tools?|equipment|treasures?)$/, 'item'],
  [/^(titles?|ranks?|honorifics?|positions?|titles? and ranks?)$/, 'title'],
  [/^(creatures?|monsters?|beasts?|races?|species|demons?)$/, 'creature'],
  [/^(events?|battles?|wars?|festivals?|incidents?)$/, 'event'],
  [/^(quotes?|quotations?|citations?|verses?|sayings?|lines?|chants?|incantations?|mottos?|mottoes)$/, 'quote'],
  [/^(terms?|others?|misc|miscellaneous|concepts?|words?|invented words?)$/, 'term'],
];
/** A kind as a model (or a file) wrote it, made one of the built-in ones; unknown → «Terms». */
export function normKind(raw?: unknown): BuiltinKind {
  const k = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[_-]+/g, ' ') : '';
  if ((KINDS as readonly string[]).includes(k)) return k as BuiltinKind;
  for (const [re, v] of SYN) if (re.test(k)) return v;
  return 'term';
}
export interface Term { id: string; from: string; to: string; /** a book's id, or every book when absent */ book?: string; /** a glossary folder's id (then for the books using that folder) */ folder?: string; /** the language it renders into (ar, en…): used only when translating into it */ lang?: string; /** what it names (characters, places…) */ kind?: TermKind; /** added by the translator on its own */ auto?: boolean; /** other renderings of the same name in that language (a repeat merged into this entry keeps its rendering here) */ alts?: string[]; /** a note on the term */ note?: string }

const KEY = 'kr.glossary';
let cache: Term[] | null = null;
const lower = (s: string) => s.toLocaleLowerCase().trim();
/* ---------- one key for «the same name»: every repeat is found, and every search matches, through it ---------- */
// (Case, width and compatibility forms (NFKC), the marks of Arabic (vowel signs, the dagger alef, tatweel), the
// hamza and alef forms, ى/ي, ة/ه, Persian ی/ک, katakana as hiragana; punctuation and spaces loosened.)
const AR_MARKS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E8\u06EA-\u06ED\u08D3-\u08FF\u0640]/g;
const AR_LETTERS: Record<string, string> = { 'أ': 'ا', 'إ': 'ا', 'آ': 'ا', 'ٱ': 'ا', 'ى': 'ي', 'ئ': 'ي', 'ؤ': 'و', 'ة': 'ه', 'ی': 'ي', 'ک': 'ك' };
const foldStr = (s: string): string => s.normalize('NFKC').toLowerCase().replace(AR_MARKS, '').replace(/[أإآٱىئؤةیک]/g, (c) => AR_LETTERS[c]).replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const GAP = /[\s\p{P}\p{S}]+/gu;
/** The key of a name: `loose` takes out spaces and punctuation altogether (search); else they are one space (the key
 *  of «the same name»). A name of marks alone keeps its own letters. */
export function foldKey(s: string, loose = false): string {
  const f = foldStr(s).replace(GAP, loose ? '' : ' ').trim();
  return f || s.normalize('NFKC').toLowerCase().trim();
}
export const termKey = (s: string): string => foldKey(s, false);
const CLUSTER = /\P{M}\p{M}*|\p{M}+/gu;
/** A text folded as `foldKey(s, true)` does, with where each folded letter stood in the text (its start and end), to
 *  show what matched. */
export function foldMap(s: string): { f: string; from: number[]; to: number[] } {
  let f = ''; const from: number[] = [], to: number[] = [];
  for (const m of s.matchAll(CLUSTER)) {
    const x = foldStr(m[0]).replace(GAP, ''); const a = m.index!, b = a + m[0].length;
    for (const ch of x) for (let i = 0; i < ch.length; i++) { f += ch[i]; from.push(a); to.push(b); }
  }
  return { f, from, to };
}
// (A place and a language: the same name may be kept for Arabic and for English renderings side by side.)
// (Kept apart by language, not by script: an English and a French rendering of one name, or an Arabic and a Persian
// one, are two terms — the one made later no longer takes the other's place.)
const scopeOf = (x: Term) => `${x.folder ? `f:${x.folder}` : x.book ? `b:${x.book}` : 'all'}|${termLang(x) || `script:${scriptOf(x.to)}`}`;
const MAX_ALTS = 8;
/** Two entries of one name in one place made one: `a` kept, `b`'s rendering (and its other renderings) put beside its
 *  own as alternatives — nothing is lost —, its kind and language taken where `a` has none. */
function mergeTerms(a: Term, b: Term): Term {
  const out: Term = { ...a }; const have = new Set([termKey(a.to), ...(a.alts ?? []).map(termKey)]); const alts = [...(a.alts ?? [])];
  for (const x of [b.to, ...(b.alts ?? [])]) { const k = termKey(x); if (k && !have.has(k)) { have.add(k); alts.push(x); } }
  if (alts.length) out.alts = alts.slice(0, MAX_ALTS); else delete out.alts;
  if (b.note && termKey(b.note) !== termKey(a.note ?? '')) out.note = a.note ? `${a.note} · ${b.note}` : b.note;
  if ((!a.kind || a.kind === 'term') && b.kind && b.kind !== 'term') out.kind = b.kind;
  if (!a.lang && b.lang) out.lang = b.lang;
  return out;
}
/** One term for each name in each place (a book, a folder, every book): written by hand over added by the translator,
 *  else the earlier; the other's rendering kept as an alternative. */
export function dedupe(list: Term[]): Term[] {
  const at = new Map<string, number>(); const out: Term[] = [];
  for (const x of list) {
    const k = `${scopeOf(x)}|${termKey(x.from)}`; const i = at.get(k);
    if (i === undefined) { at.set(k, out.length); out.push(x); continue; }
    const had = out[i]; out[i] = had.auto && !x.auto ? mergeTerms(x, had) : mergeTerms(had, x);
  }
  return out;
}
/** A book's own terms that a folder it uses holds as they are (the same name, language and rendering): redundant. */
function crossRepeats(list: Term[]): Set<string> {
  const lk = read<Record<string, string[]>>(LKEY, {}); const inF = new Map<string, Set<string>>(); const gone = new Set<string>();
  for (const x of list) if (x.folder) { const k = `${x.folder}|${termLang(x)}|${termKey(x.from)}`; (inF.get(k) ?? inF.set(k, new Set()).get(k)!).add(termKey(x.to)); }
  if (!inF.size) return gone;
  for (const x of list) if (x.book && !x.folder) for (const f of lk[x.book] ?? []) if (inF.get(`${f}|${termLang(x)}|${termKey(x.from)}`)?.has(termKey(x.to))) { gone.add(x.id); break; }
  return gone;
}
/** Every repeat made one (also a book's own term its folder holds as it is); how many were merged. */
export function mergeRepeats(): number {
  const before = terms(); const d = dedupe(before); const x = crossRepeats(d); const out = d.filter((t0) => !x.has(t0.id));
  const n = before.length - out.length; if (n > 0) saveTerms(out); return n;
}
export function terms(): Term[] {
  if (cache) return cache;
  try { legacyLang(); const raw = (JSON.parse(localStorage.getItem(KEY) ?? '[]') as Term[]).filter((x) => x && x.from && x.to); const d = dedupe(raw); const x = crossRepeats(d); cache = x.size ? d.filter((t0) => !x.has(t0.id)) : d; if (cache.length !== raw.length) saveTerms(cache); } catch { cache = []; }
  return cache;
}
export function saveTerms(list: Term[]): void { legacyKnown = false; cache = dedupe(list.filter((x) => x.from.trim() && x.to.trim())); try { if (cache.length) localStorage.setItem(KEY, JSON.stringify(cache)); else localStorage.removeItem(KEY); } catch { /* full */ } }
/** Terms added without doubling any (the same name in the same place — or a book's name its folder, or every book,
 *  already holds as it is — is not added again); how many were new. A different rendering of a name already there is
 *  not dropped: it is kept as an alternative of that entry (an entry only the translator had put gives way to the
 *  one written by hand, its rendering kept beside). */
export function addTerms(add: Omit<Term, 'id'>[]): number {
  const list = terms().slice(); const have = new Map(list.map((x, i) => [`${scopeOf(x)}|${termKey(x.from)}`, i])); let n = 0;
  // (What a place already holds, for the names that could be a repeat of one in a folder or in every book.)
  const wide = new Map<string, Set<string>>();
  for (const y of list) if (y.folder || (!y.book)) { const k = `${y.folder ?? ''}|${termLang(y)}|${termKey(y.from)}`; (wide.get(k) ?? wide.set(k, new Set()).get(k)!).add(termKey(y.to)); }
  const linked = new Map<string, string[]>();
  const heldWide = (x: Term): boolean => {
    if (!wide.size || (!x.book && !x.folder) || (x.folder && x.book)) return false;
    const places = x.book ? ['', ...(linked.get(x.book) ?? linked.set(x.book, linkedFolders(x.book)).get(x.book)!)] : [''];
    return places.some((pl) => wide.get(`${pl}|${termLang(x)}|${termKey(x.from)}`)?.has(termKey(x.to)));
  };
  for (const a of add) {
    const x = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, ...a } as Term; const k = `${scopeOf(x)}|${termKey(x.from)}`; const i = have.get(k);
    if (i === undefined) { if (heldWide(x)) continue; have.set(k, list.length); list.push(x); n++; }
    else if (list[i].auto && !x.auto) list[i] = mergeTerms({ ...x, id: list[i].id, kind: x.kind ?? list[i].kind }, list[i]);
    // (One the translator had put in the wrong script for its language — «Keyaru» kept as Arabic — made right by a
    // rendering that is in it; one written by hand is left as it is.)
    else if (list[i].auto && misScripted(list[i]) && !misScripted(x)) { list[i] = { ...list[i], to: x.to, kind: x.kind ?? list[i].kind }; n++; }
    else list[i] = mergeTerms(list[i], x);
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
    const k = kind?.trim(); out.push({ from, to, ...(k ? { kind: k.startsWith('u:') ? kindOf(k) : normKind(k) } : {}), ...(lang?.trim() ? { lang: lang.trim() } : {}) });
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
/** A map kept as it is, or no key at all when it is empty (nothing is left of what was deleted). */
const put = (k: string, v: Record<string, unknown> | unknown[]): void => { if (Array.isArray(v) ? v.length : Object.keys(v).length) write(k, v); else try { localStorage.removeItem(k); } catch { /* full */ } };
/** The whole glossary as stored (terms, folders, which books use which, where each book's new names go, each book's
 *  choice about a former volume's glossary) — taken before something is deleted, written back by its Undo. */
export interface GlossarySnapshot { terms: Term[]; folders: Folder[]; links: Record<string, string[]>; dest?: Record<string, Dest>; vol?: Record<string, VolChoice> }
export const glossarySnapshot = (): GlossarySnapshot => JSON.parse(JSON.stringify({ terms: terms(), folders: folders(), links: read<Record<string, string[]>>(LKEY, {}), dest: read<Record<string, Dest>>(DKEY, {}), vol: read<Record<string, VolChoice>>(VKEY, {}) })) as GlossarySnapshot;
export function glossaryRestore(s: GlossarySnapshot): void {
  put(FKEY, s.folders); saveTerms(s.terms); put(LKEY, s.links);
  if (s.dest) put(DKEY, s.dest); if (s.vol) put(VKEY, s.vol);
}
/** What a folder holds, for the question before it is deleted: its files, terms and citations, and the books using it. */
export interface GlossaryStats { files: number; terms: number; quotes: number; books: string[] }
export function statsOf(list: Term[], books: string[] = []): GlossaryStats { return { files: new Set(list.map((x) => kindOf(x))).size, terms: list.length, quotes: list.filter((x) => kindOf(x) === 'quote').length, books }; }
export const folderStats = (id: string): GlossaryStats => statsOf(terms().filter((x) => x.folder === id), folderBooks(id));
/** A book that has lost its glossary is not given a former volume's by itself the next time it is opened (it is made
 *  again only when a term is added, the names are found, or the reader takes a former volume's). */
function holdVolChoice(bookIds: Iterable<string>): void {
  const v = read<Record<string, VolChoice>>(VKEY, {}); let any = false;
  for (const b of bookIds) if (b !== '*' && !v[b] && !hasGlossary(b)) { v[b] = { choice: 'empty' }; any = true; }
  if (any) put(VKEY, v);
}
/** A folder removed whole: its files of every kind (the reader's own too), its citations, every book's link to it, the
 *  destination any book had set to it. The books that used it simply have no glossary afterwards. */
export function removeFolder(id: string): void {
  const users = folderBooks(id);
  put(FKEY, folders().filter((f) => f.id !== id)); saveTerms(terms().filter((x) => x.folder !== id));
  const l = read<Record<string, string[]>>(LKEY, {}); for (const k of Object.keys(l)) { l[k] = l[k].filter((x) => x !== id); if (!l[k].length) delete l[k]; } put(LKEY, l);
  const d = read<Record<string, Dest>>(DKEY, {}); let dd = false; for (const k of Object.keys(d)) if (d[k].to === id) { delete d[k]; dd = true; } if (dd) put(DKEY, d);
  holdVolChoice(users);
}
/** A book's own glossary removed whole: its own terms and every folder it uses (those folders are removed for the
 *  other volumes too — a glossary shared is one glossary). */
export function removeBookGlossary(bookId: string): void {
  for (const f of linkedFolders(bookId)) removeFolder(f);
  saveTerms(terms().filter((x) => !(x.book === bookId && !x.folder)));
  holdVolChoice([bookId]);
}
/** One file of a glossary removed whole (every term of that kind among those given by `inPlace`); how many went. */
export function removeFile(kind: TermKind, inPlace: (x: Term) => boolean): number {
  const before = terms(); const keep = before.filter((x) => !(kindOf(x) === kind && inPlace(x))); saveTerms(keep); return before.length - keep.length;
}
/** Every glossary removed: every term, folder, link, destination and choice about a former volume. */
export function removeAllGlossaries(): void {
  saveTerms([]); for (const k of [FKEY, LKEY, DKEY, VKEY]) try { localStorage.removeItem(k); } catch { /* full */ }
}
/** Books taken out of the library: their own terms, folder links and destination let go (a folder's terms and
 *  every book's stay — other books use them). */
export function forgetBooks(ids: Iterable<string>): void {
  const gone = new Set(ids); if (!gone.size) return;
  if (terms().some((x) => x.book && gone.has(x.book))) saveTerms(terms().filter((x) => !x.book || !gone.has(x.book)));
  for (const k of [LKEY, 'kr.glossaryDest', 'kr.glossaryVol']) { const m = read<Record<string, unknown>>(k, {}); if ([...gone].some((id) => id in m)) { for (const id of gone) if (id !== '*') delete m[id]; write(k, m); } }
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
let legacy: string | undefined; let legacyKnown = false;
export function legacyLang(): string {
  if (legacy) return legacy;
  if (legacyKnown) return '';   // (looked for, none: not read again for each term until the terms change)
  try {
    const kept = localStorage.getItem(LEGACY); if (kept) return (legacy = kept);
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Term[];
    if (Array.isArray(raw) && raw.some((x) => x && x.from && !x.lang)) {
      let tg = 'ar'; try { tg = (JSON.parse(localStorage.getItem('kr.visual') ?? '{}') as { aiTarget?: string }).aiTarget || 'ar'; } catch { /* the default */ }
      legacy = base(tg); localStorage.setItem(LEGACY, legacy); return legacy;
    }
    legacyKnown = true;
  } catch { /* storage unreadable */ }
  return '';
}
/** (Tests: the kept language read again.) */
export const _forgetLegacy = (): void => { legacy = undefined; legacyKnown = false; };
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
  for (const x of [...all.filter((t) => !t.folder && t.book && t.book === bookId), ...all.filter((t) => t.folder && linked.has(t.folder)), ...all.filter((t) => !t.book && !t.folder)]) { const k = termKey(x.from); if (seen.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}

/** The names found, less those the glossary already holds for this book (in the language translated into, by the one key of
 *  a name) and the repeats among the names themselves: each name once. */
export function newNames<T extends { from: string }>(found: T[], bookId?: string, target?: string): T[] {
  const have = new Set(termsFor(bookId, target).map((x) => termKey(x.from))); const out: T[] = [];
  for (const f of found) { const k = termKey(f.from); if (!k || have.has(k)) continue; have.add(k); out.push(f); }
  return out;
}

/** A short mark of the whole glossary: translations made with another glossary are made again. */
export function glossaryStamp(): string { return glossaryStampOf(terms()); }
export function glossaryStampOf(l: Term[]): string { if (!l.length) return ''; let h = 0; const s = JSON.stringify(l.map((x) => (x.folder ? [x.from, x.to, x.book ?? '', x.folder] : [x.from, x.to, x.book ?? '']))); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); }

/** The terms that apply to a book and appear in the texts (its own, then its folders', then the general ones). */
export function termsIn(texts: string[], bookId?: string, target?: string): Term[] {
  const list = termsFor(bookId, target); if (!list.length) return [];
  const hay = lower(texts.join('\n'));
  // (A citation: matched as a whole line — spaces, punctuation and quotation marks folded —, never by its words.)
  const lines = list.some((x) => kindOf(x) === 'quote') ? texts.flatMap((x) => x.replace(/<[^>]+>/g, '').split('\n')).map(normLine) : [];
  return list.filter((x) => (kindOf(x) === 'quote' ? !!normLine(x.from) && lines.some((l) => l.includes(normLine(x.from))) : hay.includes(lower(x.from))));
}
/** A line folded for matching a citation: width, case, punctuation, quotation marks and spaces. */
export const normLine = (s: string): string => s.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
// (The one-word labels the model reads; the reader's own files under his name for them.)
const LABEL: Record<BuiltinKind, string> = { person: 'Characters', place: 'Places', group: 'Groups', skill: 'Skills', item: 'Items', title: 'Titles', creature: 'Creatures', event: 'Events', quote: 'Citations', term: 'Terms' };
/** The lines the model is given with a passage, by kind — a name told from a skill —, citations last: to be
 *  rendered exactly as given. */
export function glossaryPrompt(list: Term[], langLabel?: string): string {
  if (!list.length) return '';
  const by = new Map<string, Term[]>(); for (const x of list) { const k = kindOf(x); by.set(k, [...(by.get(k) ?? []), x]); }
  const order = [...KINDS.filter((k) => k !== 'quote'), ...[...by.keys()].filter((k) => k.startsWith('u:')), 'quote'];
  const parts = order.filter((k) => by.has(k)).map((k) => `${k === 'quote' ? 'Citations (fixed lines: wherever one appears, put exactly its rendering)' : k.startsWith('u:') ? k.slice(2) : LABEL[k as BuiltinKind]}:\n${by.get(k)!.map((x) => `- ${JSON.stringify(x.from)} → ${JSON.stringify(x.to)}`).join('\n')}`);
  return `Glossary${langLabel ? ` (renderings in ${langLabel})` : ''} — translate these names and terms exactly as given, every time:\n${parts.join('\n')}`;
}
/** A paragraph that is a citation of the glossary, whole: its fixed rendering, exactly; else undefined. */
export function citationFor(text: string, list: Term[]): string | undefined {
  const n = normLine(text.replace(/<[^>]+>/g, '')); if (!n) return undefined;
  return list.find((x) => kindOf(x) === 'quote' && normLine(x.from) === n)?.to;
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
export function applyGlossary(text: string, all: Term[]): string {
  // (Citations are whole lines in the original's words: put by citationFor, never searched for in a translation.)
  const list = all.filter((x) => kindOf(x) !== 'quote');
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

/* ---------- the book's glossary as a folder: its files (kinds), counted ---------- */
/** The terms a book's glossary holds: its own and its folders' (not every book's). */
export const bookTerms = (bookId: string): Term[] => { const linked = new Set(linkedFolders(bookId)); return terms().filter((x) => (!x.folder && x.book === bookId) || (!!x.folder && linked.has(x.folder))); };
/** How many terms each file holds. */
export function kindCounts(list: Term[]): Map<TermKind, number> { const m = new Map<TermKind, number>(); for (const x of list) { const k = kindOf(x); m.set(k, (m.get(k) ?? 0) + 1); } return m; }
/** The files in their order: the built-in ones, then the reader's own by name. */
export const kindOrder = (ks: Iterable<TermKind>): TermKind[] => { const all = [...new Set(ks)]; return [...KINDS.filter((k) => all.includes(k)), ...all.filter((k) => k.startsWith('u:')).sort()]; };

/* ---------- files in and out: one text file per kind, in a folder named after the book ---------- */
// (Each file's name, in every language the app speaks, for importing such files back: the name → the kind.)
const FILE_NAMES: Record<BuiltinKind, string[]> = {
  person: ['Characters', 'الشخصيات', '登場人物', '인물', '人物'], place: ['Places', 'الأماكن', '場所', '장소', '地点'],
  group: ['Groups', 'الجماعات', '集団', '집단', '团体'], skill: ['Skills', 'المهارات', 'スキル', '기술', '技能'],
  item: ['Items', 'الأدوات', 'アイテム', '아이템', '物品'], title: ['Titles and ranks', 'الألقاب والمراتب', '称号と位階', '칭호와 계급', '称号与等级'],
  creature: ['Creatures', 'المخلوقات', '生き物', '생물', '生物'], event: ['Events', 'الوقائع', '出来事', '사건', '事件'],
  quote: ['Citations', 'المقتبسات', '引用', '인용', '引文'], term: ['Terms', 'المصطلحات', '用語', '용어', '术语'],
};
/** A file name made safe for every system. */
export const safeName = (s: string): string => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'glossary';
/** A book's glossary as files: `{folder}/{file}.txt`, one per kind, each `name = rendering` per line (with its
 *  language), named by `label` (the interface's names). */
export function glossaryFiles(list: Term[], folder: string, label: (k: TermKind) => string): { name: string; text: string }[] {
  const by = new Map<TermKind, Term[]>(); for (const x of list) { const k = kindOf(x); by.set(k, [...(by.get(k) ?? []), x]); }
  return kindOrder(by.keys()).map((k) => ({ name: `${safeName(folder)}/${safeName(label(k))}.txt`, text: by.get(k)!.sort((a, b) => a.from.localeCompare(b.from)).map((x) => termLine({ from: x.from, to: x.to, lang: x.lang }, true)).join('\n') + '\n' }));
}
/** The kind a file's name stands for (any language's name, the kind's own id, a model's word for it); a name
 *  not known is the reader's own file. */
export function kindFromFileName(path: string): TermKind {
  const n = (path.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '').trim(); const l = n.toLocaleLowerCase();
  if (!n) return 'term';
  for (const [k, names] of Object.entries(FILE_NAMES)) if (k === l || names.some((x) => x.toLocaleLowerCase() === l)) return k as BuiltinKind;
  const v = normKind(l); if (v !== 'term' || /^(terms?|others?)$/.test(l)) return v;
  return `u:${n}`;
}
/** Text read from such a file: its terms, each of the file's kind unless its line names another. */
export function parseKindFile(path: string, text: string): ReturnType<typeof parseTerms> {
  const k = kindFromFileName(path); return parseTerms(text).map((x) => ({ ...x, kind: x.kind && x.kind !== 'term' ? x.kind : k }));
}

/* ---------- a former volume's glossary: the same series told from the titles ---------- */
const VOL_RES: RegExp[] = [
  /(?:^|[\s,(（\[【\-–—_])(?:vol(?:ume)?|v|book|part|tome|tomo|band|#)\s*\.?\s*([0-9]+)\b/iu,
  /(?:الجزء|المجلد|ج)\s*\.?\s*([0-9٠-٩]+)/u,
  /第?\s*([0-9]+)\s*(?:巻|卷|권|集|部)/u,
];
const westDigits = (s: string) => s.replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x660));
/** A title's series stem and its volume number: «Mushoku Tensei V29» → «mushoku tensei», 29. The volume marker (V1,
 *  Vol. 1, Volume 29, 第29巻, 29巻, 3권, #3, Part 2, a trailing number), what is in brackets and a subtitle (after
 *  «: » or « - ») left out; width, case, marks and punctuation folded. */
export function volumeStem(title: string): { stem: string; vol: number | null } {
  let t0 = westDigits(title.normalize('NFKC')); let vol: number | null = null;
  for (const re of VOL_RES) { const m = re.exec(t0); if (m) { vol = Number(westDigits(m[1])); t0 = t0.slice(0, m.index) + ' ' + t0.slice(m.index + m[0].length); break; } }
  t0 = t0.replace(/[(（\[【][^)）\]】]*[)）\]】]/g, ' ');
  const cut = t0.split(/\s[-–—~～〜]\s|[:：]\s|：|[～〜~]/)[0]; if (cut.trim().length >= 2) t0 = cut;
  const tail = /[\s#._-]+([0-9]{1,3})\s*$/.exec(t0); if (tail) { if (vol === null) vol = Number(tail[1]); t0 = t0.slice(0, tail.index); }
  const stem = t0.normalize('NFKD').replace(/\p{M}+/gu, '').normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}_]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return { stem, vol };
}
const editDistance = (a: string, b: string): number => {
  const A = [...a], B = [...b]; let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) { const cur = [i]; for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)); prev = cur; }
  return prev[B.length];
};
/** Two titles of one series? 'same' — the stems identical (V1 and V29, «Vol. 1» and «Volume 12», identical titles);
 *  'similar' — nearly so (a letter or two apart, or one's words all in the other's, as a subtitle differing); null —
 *  another series, though a first word be shared. `series` (the library's own series names, when both have one)
 *  is taken first. */
export function seriesMatch(a: string, b: string, series?: [string | undefined, string | undefined]): 'same' | 'similar' | null {
  if (series?.[0] && series[1]) { const x = volumeStem(series[0]).stem, y = volumeStem(series[1]).stem; if (x && x === y) return 'same'; }
  const x = volumeStem(a).stem, y = volumeStem(b).stem; if (!x || !y) return null;
  if (x === y) return 'same';
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  const d = editDistance(x, y); if (s.length >= 6 && d <= Math.max(1, Math.floor(l.length * 0.12))) return 'similar';
  const ts = s.split(' '), tl = l.split(' ');
  if (ts.length >= 2 && ts.every((w) => tl.includes(w)) && tl.slice(0, ts.length).join(' ') === ts.join(' ')) return 'similar';
  // (Titles written without spaces — Japanese, Chinese —: one the start of the other, of three letters or more.)
  if (!/\s/.test(x + y) && [...s].length >= 3 && l.startsWith(s)) return 'similar';
  return null;
}

/** Each book's choice about a former volume's glossary: shared, copied, started empty (by hand or by itself). */
export interface VolChoice { choice: 'share' | 'copy' | 'empty'; from?: string; auto?: boolean }
const VKEY = 'kr.glossaryVol';
export const volChoice = (bookId: string): VolChoice | undefined => read<Record<string, VolChoice>>(VKEY, {})[bookId];
export function setVolChoice(bookId: string, c: VolChoice | null): void { const all = read<Record<string, VolChoice>>(VKEY, {}); if (c) all[bookId] = c; else delete all[bookId]; write(VKEY, all); }
/** Whether a book has a glossary of its own yet: terms of its own, or a folder it uses. */
export const hasGlossary = (bookId: string): boolean => linkedFolders(bookId).length > 0 || terms().some((x) => !x.folder && x.book === bookId);
/** `others`: the book's other titles (the reader's; see src/booktitles.ts), told apart by the series matcher too. */
export interface BookRef { id: string; title: string; others?: string[]; series?: { name?: string; index?: number } }
/** The best match of two books over the shown title and the other titles of each ('same' before 'similar'). */
function bestMatch(a: BookRef, b: BookRef): 'same' | 'similar' | null {
  let best: 'same' | 'similar' | null = null;
  for (const x of [a.title, ...(a.others ?? [])]) for (const y of [b.title, ...(b.others ?? [])]) {
    const m = seriesMatch(x, y, x === a.title && y === b.title ? [a.series?.name, b.series?.name] : undefined);
    if (m === 'same') return 'same'; if (m) best = m;
  }
  return best;
}
export interface VolCandidate { bookId: string; title: string; vol: number | null; match: 'same' | 'similar'; count: number; folders: string[] }
/** Other books' glossaries of this book's series: one for each glossary (two volumes sharing one folder are one),
 *  the identical ones first, then by the nearest volume (a former one before a later one as near). */
export function volCandidates(book: BookRef, books: BookRef[]): VolCandidate[] {
  const me = volumeStem(book.title); const myVol = book.series?.index ?? me.vol;
  const out: VolCandidate[] = []; const seen = new Set<string>();
  for (const b of books) {
    if (b.id === book.id) continue;
    const list = bookTerms(b.id); if (!list.length) continue;
    const match = bestMatch(book, b); if (!match) continue;
    const fs = linkedFolders(b.id).filter((f) => list.some((x) => x.folder === f)); const key = fs.length ? fs.slice().sort().join(',') : `b:${b.id}`;
    const vol = b.series?.index ?? volumeStem(b.title).vol; const c: VolCandidate = { bookId: b.id, title: b.title, vol, match, count: list.length, folders: fs };
    if (seen.has(key)) { const i = out.findIndex((y) => (y.folders.length ? y.folders.slice().sort().join(',') : `b:${y.bookId}`) === key); if (i >= 0 && dist(c.vol, myVol) < dist(out[i].vol, myVol)) out[i] = c; continue; }
    seen.add(key); out.push(c);
  }
  return out.sort((a, b) => (a.match === b.match ? 0 : a.match === 'same' ? -1 : 1) || dist(a.vol, myVol) - dist(b.vol, myVol) || (a.vol ?? 0) - (b.vol ?? 0));
}
const dist = (v: number | null, me: number | null | undefined) => (v === null || me === null || me === undefined ? 9999 : Math.abs(v - me) * 2 + (v > me ? 1 : 0));
/** What to do for a book with no glossary yet: nothing (it has one, a choice was made, no glossary of its series,
 *  or «Never»); take the nearest identical one by itself («Automatically»); or offer the choices. */
export function volDecision(book: BookRef, books: BookRef[], mode: 'auto' | 'ask' | 'never' = 'auto'): { kind: 'none' } | { kind: 'auto'; cand: VolCandidate } | { kind: 'ask'; cands: VolCandidate[] } {
  if (mode === 'never' || hasGlossary(book.id) || volChoice(book.id)) return { kind: 'none' };
  const cands = volCandidates(book, books); if (!cands.length) return { kind: 'none' };
  if (mode === 'auto' && cands[0].match === 'same') return { kind: 'auto', cand: cands[0] };
  return { kind: 'ask', cands };
}
/** The common name of a series, as its titles write it (the first one's words without its volume). */
export function seriesName(title: string): string { const { stem } = volumeStem(title); const words = stem.split(' ').length; const t0 = westDigits(title.normalize('NFKC')).replace(/[(（\[【][^)）\]】]*[)）\]】]/g, ' ').split(/\s[-–—~～〜]\s|[:：]\s|：|[～〜~]/)[0]; const w = t0.split(/\s+/).filter(Boolean); return (w.length >= words ? w.slice(0, words).join(' ') : seriesOf(title)).replace(/[\s,._\-–—]+$/, '') || title; }
/** Both volumes use ONE glossary from now on: the former one's folder (made from its own list when it had none,
 *  named after the series), its new names added there for each. Returns what puts everything back. */
export function shareGlossary(bookId: string, cand: VolCandidate, auto = false): () => void {
  const before = glossarySnapshot(); const dests = read<Record<string, Dest>>(DKEY, {}); const vols = read<Record<string, VolChoice>>(VKEY, {});
  let fid = cand.folders[0];
  if (!fid) {
    const f = addFolder(seriesName(cand.title)); fid = f.id;
    saveTerms(terms().map((x) => (!x.folder && x.book === cand.bookId ? { ...x, book: undefined, folder: f.id } : x)));
    setLinked(cand.bookId, [...linkedFolders(cand.bookId), f.id]); setDest(cand.bookId, { to: f.id, addNew: true });
  }
  setLinked(bookId, [...linkedFolders(bookId), ...cand.folders, fid]); setDest(bookId, { to: fid, addNew: true });
  setVolChoice(bookId, { choice: 'share', from: cand.bookId, ...(auto ? { auto } : {}) });
  return () => { glossaryRestore(before); write(DKEY, dests); write(VKEY, vols); };
}
/** A separate copy of the former volume's glossary, this book's own to change freely. */
export function copyGlossary(bookId: string, cand: VolCandidate): () => void {
  const before = glossarySnapshot(); const vols = read<Record<string, VolChoice>>(VKEY, {});
  addTerms(bookTerms(cand.bookId).map(({ id: _i, folder: _f, ...x }) => { void _i; void _f; return { ...x, book: bookId }; }));
  setVolChoice(bookId, { choice: 'copy', from: cand.bookId });
  return () => { glossaryRestore(before); write(VKEY, vols); };
}
/** No longer sharing a folder: its terms kept as this book's own copy, the folder left to the other volumes. */
export function stopSharing(bookId: string, folderId: string): void {
  // (Unlinked first: a copy of what the folder holds is not taken for a repeat of the folder's own.)
  const copy = terms().filter((x) => x.folder === folderId).map(({ id: _i, folder: _f, ...x }) => { void _i; void _f; return { ...x, book: bookId }; });
  setLinked(bookId, linkedFolders(bookId).filter((f) => f !== folderId));
  addTerms(copy);
  if (destOf(bookId).to === folderId) setDest(bookId, { to: 'book', addNew: true });
  setVolChoice(bookId, { choice: 'copy', from: volChoice(bookId)?.from });
}
/** The books using a folder. */
export const folderBooks = (folderId: string): string[] => Object.entries(read<Record<string, string[]>>(LKEY, {})).filter(([, v]) => v.includes(folderId)).map(([k]) => k);

/** A book renamed: a glossary folder named after the series of its former title, and used by no other book, takes the
 *  name the new title gives (the folder is followed, as the book is). */
export function followRename(bookId: string, oldTitle: string, newTitle: string): void {
  if (!oldTitle || !newTitle || oldTitle === newTitle) return;
  const used = read<Record<string, string[]>>(LKEY, {});
  for (const f of folders()) {
    if (!linkedFolders(bookId).includes(f.id)) continue;
    if (Object.entries(used).some(([k, v]) => k !== bookId && v.includes(f.id))) continue;
    if (f.name === seriesName(oldTitle)) renameFolder(f.id, seriesName(newTitle));
    else if (f.name === seriesOf(oldTitle)) renameFolder(f.id, seriesOf(newTitle));
    else if (f.name === oldTitle) renameFolder(f.id, newTitle);
  }
}
