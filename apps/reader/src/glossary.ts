// The reader's glossary for translation (IReader's): names and terms given the rendering the reader wants —
// "Lin Feng" always «لين فنغ», a sect's name always the same — for every book or for one. The terms a passage
// holds are handed to the model with it, and a term it left as it was is put right after.

export interface Term { id: string; from: string; to: string; /** a book's id, or every book when absent */ book?: string }

const KEY = 'kr.glossary';
let cache: Term[] | null = null;
export function terms(): Term[] {
  if (cache) return cache;
  try { cache = (JSON.parse(localStorage.getItem(KEY) ?? '[]') as Term[]).filter((x) => x && x.from && x.to); } catch { cache = []; }
  return cache;
}
export function saveTerms(list: Term[]): void { cache = list; try { if (list.length) localStorage.setItem(KEY, JSON.stringify(list)); else localStorage.removeItem(KEY); } catch { /* full */ } }

/** A short mark of the whole glossary: translations made with another glossary are made again. */
export function glossaryStamp(): string { const l = terms(); if (!l.length) return ''; let h = 0; const s = JSON.stringify(l.map((x) => [x.from, x.to, x.book ?? ''])); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); }

const lower = (s: string) => s.toLocaleLowerCase();
/** The terms that apply to a book and appear in the texts (the book's own before the general ones). */
export function termsIn(texts: string[], bookId?: string): Term[] {
  const all = terms(); if (!all.length) return [];
  const hay = lower(texts.join('\n'));
  const seen = new Set<string>(); const out: Term[] = [];
  for (const x of [...all.filter((t) => t.book && t.book === bookId), ...all.filter((t) => !t.book)]) { const k = lower(x.from); if (seen.has(k) || !hay.includes(k)) continue; seen.add(k); out.push(x); }
  return out;
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
