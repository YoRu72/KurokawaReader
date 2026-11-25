// The glossary's names found in a text (the reader marks them, and a tap on one opens its entry). Pure: no page, no
// storage — except `bookScopeTerms`, which reads the glossary. One trie of every name's folded letters, made once per
// glossary version; a text is folded in one quick pass (the same folding as the key of a name — see foldCluster in
// glossary.ts), and walked once: the leftmost name, the longest of those starting there, then on past it — so a name
// inside a longer one is not found twice. Names of a letter-script (Latin, Cyrillic, Arabic…) match on word
// boundaries; Chinese, Japanese and Korean names anywhere (their words are not set apart; Korean particles attach).
import { foldCluster, foldKey, kindOf, linkedFolders, terms, termLang, type Term } from './glossary';

/** A name as the reader sees it: the terms that name the same thing (in other languages, other folders). */
export interface NameEntry { key: string; terms: Term[] }
export interface Matcher { size: number; first: Int32Array; edges: Map<number, number>; val: (NameEntry | null)[]; byKey: Map<string, NameEntry> }
export interface Folded { c: Uint16Array; from: Int32Array; to: Int32Array; n: number }
export interface Found { s: number; e: number; entry: NameEntry }

/* ---------- the quick fold ---------- */
// A table for the ASCII: 1 a letter or digit (lowered), 2 a gap (space or punctuation: dropped), 0 anything else (the slow way).
const ASC = new Uint8Array(128);
for (let i = 48; i <= 57; i++) ASC[i] = 1;
for (let i = 65; i <= 90; i++) ASC[i] = 1;
for (let i = 97; i <= 122; i++) ASC[i] = 1;
for (const ch of ' \t\n\v\f\r!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~') ASC[ch.charCodeAt(0)] = 2;
const GAPS = new Set<number>([0xa0, 0xa1, 0xab, 0xbb, 0xbf, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x201e, 0x2026, 0x3000, 0x3001, 0x3002, 0x3008, 0x3009, 0x300a, 0x300b, 0x300c, 0x300d, 0x300e, 0x300f, 0x3010, 0x3011, 0xff01, 0xff08, 0xff09, 0xff0c, 0xff0e, 0xff1a, 0xff1b, 0xff1f, 0x60c, 0x61b, 0x61f]);
for (let i = 0x2000; i <= 0x200a; i++) GAPS.add(i);
const AR_FIX: Record<number, number> = { 0x622: 0x627, 0x623: 0x627, 0x625: 0x627, 0x624: 0x648, 0x626: 0x64a, 0x629: 0x647, 0x649: 0x64a };
const CLUSTER = /\P{M}\p{M}*|\p{M}+/uy;
/** A text folded as a name's key is (case, width, Arabic marks and letter forms, katakana as hiragana; spaces and
 *  punctuation gone), with where each folded letter stood in the text. */
export function foldText(s: string): Folded {
  let cap = s.length + 16; let c = new Uint16Array(cap), from = new Int32Array(cap), to = new Int32Array(cap); let n = 0;
  const put = (code: number, a: number, b: number): void => {
    if (n === cap) { cap *= 2; const c2 = new Uint16Array(cap); c2.set(c); c = c2; const f2 = new Int32Array(cap); f2.set(from); from = f2; const t2 = new Int32Array(cap); t2.set(to); to = t2; }
    c[n] = code; from[n] = a; to[n] = b; n++;
  };
  const len = s.length;
  for (let i = 0; i < len; i++) {
    const x = s.charCodeAt(i); const nx = i + 1 < len ? s.charCodeAt(i + 1) : 0;
    // (A letter followed by a combining mark that may join it — an accent, a dakuten — is folded with it, the slow way.)
    const joins = nx >= 0x300 && (nx <= 0x36f || nx === 0x3099 || nx === 0x309a);
    if (!joins) {
      if (x < 128) { const k = ASC[x]; if (k === 1) { put(x >= 65 && x <= 90 ? x + 32 : x, i, i + 1); continue; } if (k === 2) continue; }
      else if (x >= 0x4e00 && x <= 0x9fff || x >= 0x3400 && x <= 0x4dbf || x >= 0x3041 && x <= 0x3096 || x === 0x30fc || x >= 0x430 && x <= 0x44f || x >= 0xe0 && x <= 0xff && x !== 0xf7 || x >= 0xac00 && x <= 0xd7a3) { put(x, i, i + 1); continue; }
      else if (x >= 0x30a1 && x <= 0x30f6) { put(x - 0x60, i, i + 1); continue; }
      else if (x >= 0x410 && x <= 0x42f || x >= 0xc0 && x <= 0xde && x !== 0xd7) { put(x + 32, i, i + 1); continue; }
      else if (x === 0x640 || x >= 0x64b && x <= 0x65f || x === 0x670) continue;
      else if (x >= 0x621 && x <= 0x64a) { put(AR_FIX[x] ?? x, i, i + 1); continue; }
      else if (GAPS.has(x)) continue;
    }
    // The slow way: the whole letter with its marks, folded as the key of a name is.
    CLUSTER.lastIndex = i; const m = CLUSTER.exec(s); const piece = m ? m[0] : s[i]; const f = foldCluster(piece);
    for (let k = 0; k < f.length; k++) put(f.charCodeAt(k), i, i + piece.length);
    i += piece.length - 1;
  }
  return { c, from, to, n };
}

/* ---------- the names ---------- */
/** The terms that apply to a book, own first, then its folders', then every book's — each in every language. */
export function bookScopeTerms(bookId: string): Term[] {
  const all = terms(); const linked = new Set(linkedFolders(bookId));
  return [...all.filter((x) => !x.folder && x.book === bookId), ...all.filter((x) => !!x.folder && linked.has(x.folder)), ...all.filter((x) => !x.book && !x.folder)];
}
const MIN = 2;
/** Entries by the folded key of the original (`orig`), or of the rendering and its other renderings in `lang` (`tr`). */
export function nameEntries(list: Term[], mode: 'orig' | 'tr', lang = ''): Map<string, NameEntry> {
  const out = new Map<string, NameEntry>(); const base = (lang || '').split('-')[0];
  const add = (key: string, x: Term): void => { if (key.length < MIN) return; const e = out.get(key); if (e) { if (!e.terms.includes(x)) e.terms.push(x); } else out.set(key, { key, terms: [x] }); };
  for (const x of list) {
    if (kindOf(x) === 'quote') continue;
    if (mode === 'orig') add(foldKey(x.from, true), x);
    else if (base && termLang(x) === base) { add(foldKey(x.to, true), x); for (const a of x.alts ?? []) add(foldKey(a, true), x); }
  }
  return out;
}
export function buildMatcher(entries: Map<string, NameEntry>): Matcher {
  const first = new Int32Array(65536); const edges = new Map<number, number>(); const val: (NameEntry | null)[] = [null]; let nodes = 1;
  for (const [key, e] of entries) {
    let node = 0;
    for (let i = 0; i < key.length; i++) {
      const ch = key.charCodeAt(i);
      if (i === 0) { let nx = first[ch]; if (!nx) { nx = nodes++; first[ch] = nx; val.push(null); } node = nx; }
      else { const k = node * 65536 + ch; let nx = edges.get(k); if (!nx) { nx = nodes++; edges.set(k, nx); val.push(null); } node = nx; }
    }
    val[node] = e;
  }
  return { size: entries.size, first, edges, val, byKey: entries };
}

/* ---------- boundaries ---------- */
const WORDISH = /[\p{L}\p{N}\p{M}]/u;
const wordAt = (text: string, i: number): boolean => { // is the character just before position `i` (end) a letter, digit or mark?
  const c = text.charCodeAt(i); if (c < 128) return ASC[c] === 1;
  if (c >= 0xdc00 && c <= 0xdfff && i > 0) return WORDISH.test(text.slice(i - 1, i + 1)); return WORDISH.test(text[i]);
};
/** CJK and Korean letters: set without spaces (or with particles attached), so a name there needs no boundary. */
const unspaced = (c: number): boolean => c >= 0x3040 && c <= 0x30ff || c >= 0x3400 && c <= 0x9fff || c >= 0xf900 && c <= 0xfaff || c >= 0xff66 && c <= 0xff9f || c >= 0xac00 && c <= 0xd7a3 || c >= 0x1100 && c <= 0x11ff || c >= 0xd800 && c <= 0xdbff;
const PRE_MID = /[^\p{L}\p{N}\p{M}][وفبكل]{0,2}(?:ال)?$/u; const PRE_START = /(?:^|[^\p{L}\p{N}\p{M}])[وفبكل]{0,2}(?:ال)?$/u;
function startOk(text: string, s: number): boolean {
  const c = text.charCodeAt(s); if (unspaced(c)) return true;
  if (s === 0 || !wordAt(text, s - 1)) return true;
  // (Arabic: the one-letter particles and the article are written onto the word — «وبالبوابة».)
  if (c >= 0x600 && c <= 0x6ff) { const w = text.slice(Math.max(0, s - 5), s); return (s - 5 <= 0 ? PRE_START : PRE_MID).test(w); }
  return false;
}
function endOk(text: string, e: number): boolean { // e: just past the name's last character
  let i = e - 1; if (i > 0 && text.charCodeAt(i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff) i--;
  if (unspaced(text.charCodeAt(i))) return true;
  return e >= text.length || !wordAt(text, e);
}

/** The names in `text`, leftmost first, none inside another and the longest where several start at once. */
export function findNames(m: Matcher, text: string, f: Folded = foldText(text)): Found[] {
  const out: Found[] = []; const { c, from, to, n } = f;
  for (let i = 0; i < n; i++) {
    const a = m.first[c[i]]; if (!a) continue;
    if (i > 0 && from[i] === from[i - 1]) continue;       // not from the middle of a letter folded to several
    // (Every ending of a name here, deepest last.)
    let node = a; let best = -1, bestNode = 0; const ends: number[] = []; const nodes: number[] = [];
    if (m.val[node]) { ends.push(i); nodes.push(node); }
    for (let j = i + 1; j < n; j++) { const nx = m.edges.get(node * 65536 + c[j]); if (nx === undefined) break; node = nx; if (m.val[node]) { ends.push(j); nodes.push(node); } }
    const s0 = from[i];
    for (let k = ends.length - 1; k >= 0; k--) {
      const j = ends[k]; if (j + 1 < n && from[j + 1] === from[j]) continue;
      const e0 = to[j];
      if (startOk(text, s0) && endOk(text, e0)) { best = j; bestNode = nodes[k]; break; }
    }
    if (best >= 0) { out.push({ s: s0, e: to[best], entry: m.val[bestNode]! }); i = best; }
  }
  return out;
}

