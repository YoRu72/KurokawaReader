// The part of AniList tagging that is pure (no app, no storage): a folder's name made a title to search for,
// the request for several names at once, and the entry chosen among AniList's answers — its genres and best
// tags. Kept apart so it can be checked against AniList itself (scripts/check-anilist.mjs).

export type Raw = { id: number; title: { romaji?: string; english?: string; native?: string }; synonyms?: string[]; genres?: string[]; tags?: { name: string; rank: number; isMediaSpoiler?: boolean; isGeneralSpoiler?: boolean }[]; averageScore?: number };
export interface Picked { id: number; genres: string[]; tags: string[]; score?: number }

/** A folder's name as a title to search for: brackets, "(Light Novel)", a publisher's tag and the like taken off. */
export function searchName(name: string): string {
  return name.replace(/^!+\s*/, '').replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/\((?:light novels?|ln|novels?|web novel|wn|complete|ongoing|[^)]*\b(?:press|seas|novel|books)\b)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}
const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9぀-ヿ一-鿿]+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'and', 'is', 'i', 'my', 'me', 'wa', 'no', 'ga', 'wo', 'ni', 'to']);
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w)));
/** How well a found entry's names match the name asked for (0–1): the asked words found in the best of its
 *  names, and that name's words found in the asked ones (a short title inside a long folder name counts). */
export function match(asked: string, titles: string[]): number {
  const a = words(asked); if (!a.size) return 0;
  let best = 0;
  for (const t of titles) {
    if (!t) continue;
    const b = words(t); if (!b.size) continue;
    let hit = 0; for (const w of a) if (b.has(w)) hit++;
    best = Math.max(best, Math.min(1, Math.max(hit / a.size, (hit / b.size) * 0.9)));
  }
  return best;
}

/** The query that searches for each name under an alias of its own (s0, s1, …): light novels only. */
export function buildQuery(names: string[]): { query: string; variables: Record<string, string> } {
  const parts = names.map((_, i) => `s${i}: Page(perPage: 5) { media(search: $q${i}, type: MANGA, format: NOVEL, sort: SEARCH_MATCH) { id title { romaji english native } synonyms genres averageScore tags { name rank isMediaSpoiler isGeneralSpoiler } } }`);
  const variables: Record<string, string> = {}; names.forEach((n, i) => { variables[`q${i}`] = n; });
  return { query: `query (${names.map((_, i) => `$q${i}: String`).join(', ')}) { ${parts.join(' ')} }`, variables };
}

/** Of AniList's answers for a name, the entry it is — or null when none matches well enough. */
export function pick(asked: string, list: Raw[] | null | undefined): Picked | null {
  let best: Raw | null = null; let score = 0;
  for (const m of list ?? []) { const sc = match(asked, [m.title.english ?? '', m.title.romaji ?? '', ...(m.synonyms ?? [])]); if (sc > score) { score = sc; best = m; } }
  if (!best || score < 0.6) return null;
  return {
    id: best.id, genres: best.genres ?? [], score: best.averageScore,
    tags: (best.tags ?? []).filter((x) => !x.isMediaSpoiler && !x.isGeneralSpoiler && x.rank >= 55).sort((a, b) => b.rank - a.rank).slice(0, 10).map((x) => x.name),
  };
}
