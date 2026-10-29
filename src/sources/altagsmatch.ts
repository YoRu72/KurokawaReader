// The part of AniList tagging that is pure (no app, no storage): a folder's name made a title to search for,
// the request for several names at once, and the entry chosen among AniList's answers — its genres and best
// tags. Kept apart so it can be checked against AniList itself (scripts/check-anilist.mjs).

export type Raw = { id: number; title: { romaji?: string; english?: string; native?: string }; synonyms?: string[]; genres?: string[]; tags?: { name: string; rank: number; category?: string; isMediaSpoiler?: boolean; isGeneralSpoiler?: boolean }[]; averageScore?: number; countryOfOrigin?: string };
/** A tag as kept: its name, how well it fits (AniList's rank, 0–100), its category ("Theme-Fantasy"), whether it
 *  gives the story away. */
export interface Tag { n: string; r: number; c?: string; s?: 1 }
export interface Picked { id: number; genres: string[]; tags: Tag[]; score?: number; country?: string }

/** A folder's name as a title to search for: brackets, "(Light Novel)", a publisher's tag and the like taken off. */
export function searchName(name: string): string {
  return name.replace(/^!+\s*/, '').replace(/\[[^\]]*\]|\{[^}]*\}/g, ' ')
    .replace(/\((?:light novels?|ln|novels?|web novel|wn|complete|ongoing|[^)]*\b(?:press|seas|novel|books)\b)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}
const norm = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\u2018\u2019']/g, '').replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, ' ').trim();
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'and', 'is', 'i', 'my', 'me', 'wa', 'no', 'ga', 'wo', 'ni', 'to']);
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w)));
/** How well a found entry's names match the name asked for (0–1), by its best name: mostly the asked words it
 *  has, partly its own words the name has — "Ascendance of a Bookworm" over "… Part 2"; and none at all when
 *  half its words are not in the name ("Una Volta Monogatari Series" is not "Monogatari Series"). */
export function match(asked: string, titles: string[], also = ''): number {
  const a = words(asked); if (!a.size) return 0;
  // (The folder's whole name — "86 [Eighty-Six]" — vouches for a title's words too, though only the name
  // outside its brackets is searched for.)
  const known = new Set([...a, ...words(also)]);
  let best = 0;
  for (const t of titles) {
    if (!t) continue;
    const b = words(t); if (!b.size) continue;
    let hit = 0; for (const w of a) if (b.has(w)) hit++;
    let own = 0; for (const w of b) if (known.has(w)) own++;
    const ra = hit / a.size, rb = own / b.size;
    if (ra < 0.75 && rb < 0.75) continue;
    if (rb < 0.6 && b.size - own > 1) continue;
    best = Math.max(best, 0.75 * ra + 0.25 * rb);
  }
  return best;
}

/** The query that searches for each name under an alias of its own (s0, s1, …): light novels only. */
export function buildQuery(names: string[]): { query: string; variables: Record<string, string> } {
  // (Each name twice: as a light novel, and — for a series AniList files only as its manga or manhwa (Solo
  // Leveling) — as anything printed; the second is used only when the first finds nothing.)
  const FIELDS = 'id title { romaji english native } synonyms genres averageScore countryOfOrigin tags { name rank category isMediaSpoiler isGeneralSpoiler }';
  const parts = names.map((_, i) => `s${i}: Page(perPage: 6) { media(search: $q${i}, type: MANGA, format: NOVEL, sort: SEARCH_MATCH) { ${FIELDS} } } t${i}: Page(perPage: 3) { media(search: $q${i}, type: MANGA, sort: SEARCH_MATCH) { ${FIELDS} } }`);
  const variables: Record<string, string> = {}; names.forEach((n, i) => { variables[`q${i}`] = n; });
  return { query: `query (${names.map((_, i) => `$q${i}: String`).join(', ')}) { ${parts.join(' ')} }`, variables };
}

/** A title's names to compare with: each as it is, and without what follows its main title — a subtitle after a
 *  colon ("Kino's Journey: The Beautiful World"), a part's number ("Ascendance of a Bookworm: Part 2"). */
function namesOf(m: Raw): string[] {
  const all = [m.title.english ?? '', m.title.romaji ?? '', ...(m.synonyms ?? [])].filter(Boolean);
  const out = new Set(all);
  for (const t of all) { const main = t.replace(/\s*[:：]\s.*$/, '').replace(/\s*[-–—]\s*(part|season|volume|vol\.?)\s*\d+.*$/i, '').replace(/\s+(part|season)\s*\d+$/i, '').trim(); if (main && main !== t) out.add(main); }
  return [...out];
}
const partOf = (m: Raw) => Number(/\b(?:part|season)\s*(\d+)/i.exec(m.title.english ?? m.title.romaji ?? '')?.[1] ?? 0);

/** Of AniList's answers for a name, the entry it is — or null when none matches well enough. Of a series
 *  AniList keeps in parts, the first part. `other` is the answer for the name as anything printed, used when
 *  the light novels give nothing. */
export function pick(asked: string, list: Raw[] | null | undefined, whole = '', other?: Raw[] | null): Picked | null {
  const choose = (l: Raw[] | null | undefined): Raw | null => {
    let best: Raw | null = null; let score = 0;
    for (const m of l ?? []) {
      // (A name that matches as it is beats one that matches only without its subtitle; of those, a numbered
      // part — the series itself, the first part first — beats a side book: "Part 1", not "Short Story
      // Collection".)
      const own = match(asked, [m.title.english ?? '', m.title.romaji ?? '', ...(m.synonyms ?? [])], whole);
      const cut = match(asked, namesOf(m), whole);
      const sc = own >= cut ? own : cut - (partOf(m) ? 0.004 * partOf(m) : 0.03);
      if (sc > score + 1e-9) { score = sc; best = m; }
    }
    return best && score >= 0.66 ? best : null;
  };
  const best = choose(list) ?? choose(other);
  if (!best) return null;
  // (Every tag, the best fitting first; those that give the story away marked, to be shown only when asked.)
  return {
    id: best.id, genres: best.genres ?? [], score: best.averageScore, country: best.countryOfOrigin ?? undefined,
    tags: (best.tags ?? []).sort((a, b) => b.rank - a.rank).map((x): Tag => ({ n: x.name, r: x.rank, ...(x.category ? { c: x.category } : {}), ...(x.isMediaSpoiler || x.isGeneralSpoiler ? { s: 1 as const } : {}) })),
  };
}
