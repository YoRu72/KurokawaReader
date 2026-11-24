// Searching the extensions of every repository the reader added, by name: one flat list, each extension once per
// repository it is offered by. Pure (no network, no storage): the repositories' indexes as already kept, the
// versions installed handed in. Folded as the glossary's search does (case, width, marks, kana, gaps), so a name
// typed without its marks, in another width or in katakana finds the one with them.
import { foldKey as fk } from '../glossary';
/** Folded as the glossary does, and the Latin accents taken off too (é = e; kana's marks stay). */
const foldKey = (s: string, loose = false): string => fk(s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''), loose);
import type { Repo, ExtItem } from './repos';

export type ExtState = 'installed' | 'update' | 'not' | 'cannot';
export interface ExtEntry {
  repoKey: string; repoName: string; item: ExtItem; state: ExtState;
  /** the name, the language (its code and its name in the interface language) and the repository's name, folded */
  n: string; l: string; r: string;
  /** the language's short label (EN), for the chips and the row */
  lang: string;
  /** the version installed, when one is */
  have?: string;
}
export interface ExtFilter { installed?: boolean; updates?: boolean; lang?: string }

/** Every extension of the repositories of extensions: the ones that run here and the novel ones that do not (shown
 *  as «cannot run here»); the folders of books have none. `langName` gives a language's name in the interface
 *  language; `label` its short label; `newer` says whether the first version is later than the second. */
export function buildExtIndex(repos: Repo[], installed: Record<string, string>, langName: (code: string) => string, label: (lang: string) => string, newer: (a: string, b: string) => boolean): ExtEntry[] {
  const out: ExtEntry[] = []; const langs = new Map<string, string>(); const folded = new Map<string, string>();
  const fold = (s: string): string => { let f = folded.get(s); if (f === undefined) { f = foldKey(s, true); folded.set(s, f); } return f; };
  for (const r of repos) {
    if (r.kind === 'folder' || r.kind === 'site') continue;
    const rf = foldKey(r.name, true);
    for (const i of r.items) {
      if (!i.runnable && i.itemType !== 'novel') continue;
      let l = langs.get(i.lang); if (l === undefined) { l = `${foldKey(i.lang, true)} ${foldKey(langName(i.lang), true)}`; langs.set(i.lang, l); }
      const have = installed[`${r.key}:${i.id}`];
      const state: ExtState = !i.runnable ? 'cannot' : have === undefined ? 'not' : newer(i.version, have) ? 'update' : 'installed';
      out.push({ repoKey: r.key, repoName: r.name, item: i, state, n: fold(i.name), l, r: rf, lang: label(i.lang), have });
    }
  }
  return out;
}

/** The entries matching the query and the filters, best first: the name equal to it, then beginning with it, then
 *  holding it, then the language, then the repository's name; the name's order after that. An empty query keeps
 *  all (by name). */
export function searchExts(ix: ExtEntry[], q: string, f: ExtFilter = {}): ExtEntry[] {
  const qf = foldKey(q, true); const hits: { e: ExtEntry; s: number }[] = [];
  for (const e of ix) {
    if (f.installed && e.state !== 'installed' && e.state !== 'update') continue;
    if (f.updates && e.state !== 'update') continue;
    if (f.lang && e.lang !== f.lang) continue;
    let s = 0;
    if (qf) {
      if (e.n === qf) s = 0; else if (e.n.startsWith(qf)) s = 1; else if (e.n.includes(qf)) s = 2;
      else if (e.l.split(' ').includes(qf)) s = 3; else if (e.r.includes(qf)) s = 4; else if (e.l.includes(qf)) s = 5; else continue;
    }
    hits.push({ e, s });
  }
  hits.sort((a, b) => a.s - b.s || (a.e.n < b.e.n ? -1 : a.e.n > b.e.n ? 1 : 0) || (a.e.item.name < b.e.item.name ? -1 : a.e.item.name > b.e.item.name ? 1 : 0) || (a.e.r < b.e.r ? -1 : a.e.r > b.e.r ? 1 : 0));
  return hits.map((x) => x.e);
}
