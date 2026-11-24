// Searching the glossary across languages (src/ui/glossarysheet.ts): one entry for a name in one place — its original
// and its rendering in EVERY language kept for it, the alternatives, a note, the name of its file — folded the same way
// (src/glossary.ts foldKey: case, width, NFKC, Arabic marks and hamza forms, kana, spaces and punctuation loosened), so
// the Arabic rendering finds the Japanese original, the English finds the Arabic, katakana finds hiragana.
import { foldKey, termKey, termLang, kindOf, type Term, type TermKind } from './glossary';

/** One name in one place with its renderings (one term for each language), folded for matching. */
export interface Ent {
  place: string; members: Term[];
  from: string; tos: string[]; alts: string[][]; notes: string[]; kind: string;
  /** the original's reading, folded (Japanese, when the reading helper is loaded) */
  read?: string;
}
const placeOf = (x: Term) => (x.folder ? `f:${x.folder}` : x.book ? `b:${x.book}` : 'all');
const base = (l?: string) => (l ?? '').trim().split(/[-_]/)[0].toLowerCase();

/** The terms grouped by name and place (the renderings of every language together), each folded once. */
export function buildIndex(list: Term[], kindName: (k: TermKind) => string): Ent[] {
  const at = new Map<string, Ent>(); const kinds = new Map<string, string>();
  for (const x of list) {
    const k = `${placeOf(x)}|${termKey(x.from)}`; let e = at.get(k);
    if (!e) { e = { place: placeOf(x), members: [], from: foldKey(x.from, true), tos: [], alts: [], notes: [], kind: '' }; at.set(k, e); }
    e.members.push(x); e.tos.push(foldKey(x.to, true)); e.alts.push((x.alts ?? []).map((a) => foldKey(a, true))); e.notes.push(x.note ? foldKey(x.note, true) : '');
  }
  for (const e of at.values()) {
    const ks = [...new Set(e.members.map((m) => kindOf(m)))];
    e.kind = ks.map((k) => { let f = kinds.get(k); if (f === undefined) { f = foldKey(kindName(k), true); kinds.set(k, f); } return f; }).join(' ');
  }
  return [...at.values()];
}

export interface Hit {
  ent: Ent;
  /** the entry shown (the language translated into when the name has one, else the first) */
  shown: Term;
  /** the renderings, alternatives and notes that matched but are not the shown rendering */
  also: { term: Term; text: string; field: 'to' | 'alt' | 'note' }[];
  /** what matched in the original or the shown rendering, for highlighting */
  inFrom: boolean; inTo: boolean; score: number;
}
export interface SearchOpts { target?: string; limit?: number; reading?: (from: string) => string | undefined }

/** The names matching `q`: best first (the original or a rendering equal to it, then one beginning with it, then the
 *  rest), the file's order and the name's after that. `total` counts every match, `hits` only `limit` of them. */
export function searchIndex(ix: Ent[], q: string, o: SearchOpts = {}): { hits: Hit[]; total: number } {
  const qf = foldKey(q, true); if (!qf) return { hits: [], total: 0 };
  const tl = base(o.target); const found: Hit[] = [];
  for (const e of ix) {
    const inFrom = e.from.includes(qf); const rd = !inFrom && o.reading ? o.reading(e.members[0].from) : undefined; const inRead = !!rd && rd.includes(qf);
    let any = inFrom || inRead; let score = inFrom ? (e.from === qf ? 0 : e.from.startsWith(qf) ? 1 : 2) : inRead ? 3 : 9;
    const si = Math.max(0, e.members.findIndex((m) => tl && termLang(m) === tl));
    const also: Hit['also'] = []; let inTo = false;
    for (let j = 0; j < e.members.length; j++) {
      const m = e.members[j];
      if (e.tos[j].includes(qf)) { any = true; score = Math.min(score, e.tos[j] === qf ? 0 : e.tos[j].startsWith(qf) ? 1 : 2); if (j === si) inTo = true; else also.push({ term: m, text: m.to, field: 'to' }); }
      e.alts[j].forEach((a, i) => { if (a.includes(qf)) { any = true; score = Math.min(score, 4); also.push({ term: m, text: m.alts![i], field: 'alt' }); } });
      if (e.notes[j] && e.notes[j].includes(qf)) { any = true; score = Math.min(score, 5); also.push({ term: m, text: m.note!, field: 'note' }); }
    }
    if (!any && e.kind.includes(qf)) { any = true; score = 8; }
    if (any) found.push({ ent: e, shown: e.members[si], also, inFrom: inFrom || inRead, inTo, score });
  }
  found.sort((a, b) => a.score - b.score);   // (a stable sort: the index's order — the folder's — within a score)
  return { hits: found.slice(0, o.limit ?? found.length), total: found.length };
}
