// An entry of the glossary as the card and the selection's menu show it.
import { foldKey, termLang, type Term } from '../glossary';
import { getSettings } from '../settings';
import { bookScopeTerms, type NameEntry } from '../glossmatch';

/* ---------- an entry as the card shows it ---------- */
const baseLang = (c: string): string => (c || '').split('-')[0];
/** Every term of the same original as `entry`'s, in every language (this book's glossary), the first of each scope first. */
export function sameName(entry: NameEntry, bookId: string): Term[] {
  const keys = new Set(entry.terms.map((x) => foldKey(x.from, true)));
  const all = bookScopeTerms(bookId).filter((x) => keys.has(foldKey(x.from, true)));
  return all.length ? all : entry.terms;
}
/** The term shown first: the one in the language in use (the translator's target), else the first. */
export function mainTerm(all: Term[]): Term {
  const lang = baseLang(getSettings().aiTarget || '');
  return all.find((x) => termLang(x) === lang) ?? all[0];
}
