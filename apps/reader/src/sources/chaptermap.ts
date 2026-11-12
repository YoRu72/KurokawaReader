// Which chapter of one source's list is which of another's (a novel moved to another source: see migrate.ts) —
// by number, by name, by place. Kept apart from the migration itself so it can be tried without a library.
import type { WebChapter } from './ext/source';

const digits = (name: string) => name.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10));
// (A volume as a name gives it: "Volume 2", "Vol. 2", "Book 2", "V2C1", «المجلد ٢», «الجزء ٢», "第2巻", "2권".)
const VOLUME = /(?:\b(?:volume|vol|book|tome)\s*\.?\s*(\d+)|(?:المجلد|مجلد|الجزء|جزء)\s*(\d+)|第?\s*(\d+)\s*[巻卷권]|\bv(\d+)(?=\s*c(?:h)?\s*\.?\s*\d))/i;
/** A chapter's volume as its name gives it, else null. */
export function volumeNumber(name: string): number | null {
  const m = VOLUME.exec(digits(name)); const v = m ? m.slice(1).find((x) => x !== undefined) : undefined;
  return v !== undefined ? Number(v) : null;
}
/** A chapter's number as its name gives it ("Chapter 12", "Ch. 12.5 - …", "第12话", «الفصل ١٢») — the volume's
 *  number ("Vol. 2 Ch. 1", "第2巻 第1話") not taken for it —, else null. */
export function chapterNumber(name: string): number | null {
  const parse = (s: string) => { const m = /(?:chapter|chap|ch|episode|ep|part|الفصل|فصل|الحلقة|第)\s*\.?\s*(\d+(?:\.\d+)?)/i.exec(s.replace(/(?<![a-z])c(?=\d)/gi, 'ch ')) ?? /(?:^|\s|#)(\d+(?:\.\d+)?)(?=\s|$|[:：.\-–—)])/.exec(s); return m ? Number(m[1]) : null; };
  const s = digits(name);
  return parse(s.replace(VOLUME, ' ')) ?? parse(s);
}
const nameKey = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');

/** Which of the new chapters each old one is: by its number (the most reliable across sites), else by its
 *  name, else — the lists numbered alike from the start — by its place. */
export function chapterMap(from: WebChapter[], to: WebChapter[]): (i: number) => number | undefined {
  const byNum = new Map<number, number>(); const byVolNum = new Map<string, number>(); const byName = new Map<string, number>();
  // (The volumes each number is found in: a number in more than one — chapters counted again from 1 in each
  // volume — says nothing alone, only with its volume.)
  const volsOf = (l: WebChapter[]) => { const m = new Map<number, Set<number | null>>(); for (const c of l) { const n = chapterNumber(c.name); if (n !== null) (m.get(n) ?? m.set(n, new Set()).get(n)!).add(volumeNumber(c.name)); } return m; };
  const toVols = volsOf(to), fromVols = volsOf(from);
  to.forEach((c, j) => {
    const n = chapterNumber(c.name); const v = volumeNumber(c.name);
    if (n !== null && !byNum.has(n)) byNum.set(n, j);
    if (n !== null && v !== null && !byVolNum.has(`${v}|${n}`)) byVolNum.set(`${v}|${n}`, j);
    const k = nameKey(c.name); if (k && !byName.has(k)) byName.set(k, j);
  });
  // (Both lists numbered — most chapters carrying a number — the number decides; a site that counts from 0 or
  // skips a prologue is matched all the same.)
  const numbered = (l: WebChapter[]) => l.filter((c) => chapterNumber(c.name) !== null).length >= l.length * 0.6;
  const useNum = numbered(from) && numbered(to);
  const cache = new Map<number, number | undefined>();
  return (i: number) => {
    if (cache.has(i)) return cache.get(i);
    const c = from[i]; let j: number | undefined;
    if (c) {
      if (useNum) {
        const n = chapterNumber(c.name); const v = volumeNumber(c.name);
        if (n !== null) {
          if (v !== null) j = byVolNum.get(`${v}|${n}`);
          // (The number alone, when it is one chapter in each list — not one found again in another volume.)
          if (j === undefined && (toVols.get(n)?.size ?? 0) <= 1 && (fromVols.get(n)?.size ?? 0) <= 1) j = byNum.get(n);
        }
      }
      if (j === undefined) j = byName.get(nameKey(c.name));
      if (j === undefined && !useNum && from.length && Math.abs(from.length - to.length) <= Math.max(2, from.length * 0.05) && i < to.length) j = i;
    }
    cache.set(i, j); return j;
  };
}
