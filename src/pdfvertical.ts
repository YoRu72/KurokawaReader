// Vertical writing in PDFs: Japanese, Chinese and Korean set top to bottom in columns read right to left
// (tategaki), and Mongolian, whose columns run left to right. A PDF draws such text as characters stacked
// down the page — one item each, or a column at a time — and code that reads lines across the page then
// gets a grid of single characters. This finds the columns, puts them in reading order and says where the
// paragraphs break. Coordinates are top-down (y grows downwards), as in a viewport.

/** A piece of text on the page: `l`..`r` across, `y` its baseline (top-down), `h` its size; `t`..`b` its
 *  extent down the page when known (a column drawn as one item). */
export type VPiece = { text: string; l: number; r: number; y: number; h: number; t?: number; b?: number; space?: boolean };

/** One column's run of text: its box and what follows it — a new paragraph, or the same one continuing. */
export type VSegment = { text: string; l: number; r: number; t: number; b: number; size: number; items: number[]; breakAfter: boolean };

const CJK = /[ᄀ-ᇿ⺀-⿟　-ヿ㄀-ㇿ㐀-䶿一-鿿ꥠ-꥿가-힯豈-﫿︐-︟︰-﹏＀-￯]|[\ud840-\ud87f][\udc00-\udfff]/;
const MONGOLIAN = /[᠀-᢯]/;
export const isVerticalScript = (s: string) => CJK.test(s) || MONGOLIAN.test(s);

/** Presentation forms for vertical text (︒ ︑ ﹁ ﹂ ︵ ︶ …) as the ordinary characters they stand for. */
export function plainVerticalForms(s: string): string {
  return s.replace(/[︐-︙︰-﹏]/g, (c) => c.normalize('NFKC'));
}

const top = (p: VPiece) => p.t ?? p.y - p.h * 0.88;
const bottom = (p: VPiece) => p.b ?? p.y + p.h * 0.12;
const cx = (p: VPiece) => (p.l + p.r) / 2;

/**
 * Which pieces are set vertically, and those as columns in reading order. A piece is vertical when the
 * next character sits directly under it (or it is a column item) and nothing touches it across; a page needs
 * a few such columns before any of it is read as vertical.
 */
export function findVertical(pieces: VPiece[]): { vertical: Set<number>; segments: VSegment[] } {
  const none = { vertical: new Set<number>(), segments: [] };
  const n = pieces.length; if (n < 6 || n > 20000) return none;
  // Neighbour lookup on a grid of cells about one character in size.
  const sizes = pieces.map((p) => p.h).filter((h) => h > 0).sort((a, b) => a - b); const cell = Math.max(1, sizes[sizes.length >> 1] || 10);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  pieces.forEach((p, i) => { const k = key(cx(p), p.y); const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]); });
  const near = (p: VPiece) => { const out: number[] = []; const gx = Math.floor(cx(p) / cell), gy = Math.floor(p.y / cell); for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) { const a = grid.get(`${gx + dx},${gy + dy}`); if (a) out.push(...a); } return out; };
  const vert = new Set<number>();
  pieces.forEach((p, i) => {
    if (!p.text.trim() || !isVerticalScript(p.text)) return;
    const isColumn = p.t !== undefined && p.b !== undefined && p.b - p.t > (p.r - p.l) * 1.5 && [...p.text].length > 1;
    if (isColumn) { vert.add(i); return; }
    // (A run drawn turned down the page — Mongolian, a word of Latin — is a column however short.)
    if (p.t !== undefined && p.b !== undefined && MONGOLIAN.test(p.text)) { vert.add(i); return; }
    let below = false, across = false;
    for (const j of near(p)) {
      if (j === i) continue; const q = pieces[j]; if (!q.text.trim()) continue;
      const h = Math.max(p.h, q.h);
      if (Math.abs(cx(q) - cx(p)) < h * 0.3 && Math.abs(q.y - p.y) > h * 0.5 && Math.abs(q.y - p.y) < h * 1.45) below = true;
      // (A character of another size beside this one is ruby beside its word, or the word beside its ruby:
      // not text running across.)
      const rubyPair = Math.min(p.h, q.h) <= Math.max(p.h, q.h) * 0.62;
      if (!rubyPair && Math.abs(q.y - p.y) < h * 0.3 && ((q.l - p.r) > -h * 0.2 && (q.l - p.r) < h * 0.35 || (p.l - q.r) > -h * 0.2 && (p.l - q.r) < h * 0.35)) across = true;
    }
    if (below && !across) vert.add(i);
  });
  // Characters wedged in a column (a digit pair set across, a word turned on its side) join it, and so does
  // punctuation set beside its character (a Korean full stop sits off the column's middle, at its end too).
  const PUNCT = /^[.,!?;:'"’”)\]」』）、。，．！？…·・]+$/;
  const vertList = [...vert];
  pieces.forEach((p, i) => {
    if (vert.has(i) || (!p.space && !p.text.trim())) return;
    let up = false, down = false, beside = false;
    // (A column drawn as one run is long: a space between two runs is far from the bottoms the grid is keyed
    // by, so these look through every column item.)
    const wedge = p.space || p.r - p.l < 0.05 || (p.b !== undefined && p.t !== undefined && p.b - p.t < 0.05);
    for (const j of wedge ? vertList : near(p)) {
      if (!vert.has(j)) continue; const q = pieces[j]; const h = Math.max(q.h, p.h);
      if (Math.abs(cx(q) - cx(p)) < h * 0.35) { if (q.y < p.y) up = true; else down = true; }
      if (PUNCT.test(p.text.trim()) && Math.abs(cx(q) - cx(p)) < h * 0.8 && Math.abs(q.y - p.y) < h * 1.5) beside = true;
      // (A glyph with no advance of its own, or a space, wedged in a column: its run's neighbours are above and below.)
      if (wedge && Math.abs(cx(q) - cx(p)) < h * 0.5) {
        if (top(q) <= top(p) + 0.01 && bottom(q) >= top(p) - h * 1.5) up = true;
        if (bottom(q) >= bottom(p) - 0.01 && top(q) <= bottom(p) + h * 1.5) down = true;
      }
    }
    if ((up && down) || beside) vert.add(i);
  });
  if (vert.size < 8 && ![...vert].some((i) => MONGOLIAN.test(pieces[i].text))) return none;
  // Columns: by their middle across the page.
  const idx = [...vert].sort((a, b) => cx(pieces[b]) - cx(pieces[a]));
  const cols: { x: number; h: number; items: number[] }[] = [];
  for (const i of idx) {
    const p = pieces[i]; const c = cols.find((k) => Math.abs(k.x - cx(p)) < Math.max(k.h, p.h) * 0.5);
    if (c) { c.items.push(i); c.x += (cx(p) - c.x) / c.items.length; c.h = Math.max(c.h, p.h); } else cols.push({ x: cx(p), h: p.h, items: [i] });
  }
  // Ruby (furigana): a column of small characters set beside a column of full-size ones is the reading of
  // its words, not text of its own — kept out of what is read, as a reader copying the passage would.
  const ruby = new Set(cols.filter((c) => cols.some((k) => k !== c && c.h <= k.h * 0.62 && Math.abs(k.x - c.x) < k.h * 1.3 && Math.abs(k.x - c.x) > k.h * 0.4)));
  // Each column cut where a gap down it is wider than a line of space (a new block of text).
  const segs: VSegment[] = [];
  for (const c of cols) {
    if (ruby.has(c)) continue;
    c.items.sort((a, b) => top(pieces[a]) - top(pieces[b]));
    let cur: VSegment | null = null; let lastB = 0;
    for (const i of c.items) {
      const p = pieces[i];
      if (cur && top(p) - lastB > c.h * 1.6) { segs.push(cur); cur = null; }
      // (A gap down the column is a space between words: Korean, and Latin words set upright, have them.)
      const gapBefore = cur ? top(p) - lastB : 0;
      if (!cur) { if (p.space) continue; cur = { text: '', l: p.l, r: p.r, t: top(p), b: bottom(p), size: p.h, items: [], breakAfter: false }; }
      else if (p.space) { if (!/\s$/.test(cur.text)) cur.text += ' '; cur.items.push(i); lastB = Math.max(lastB, bottom(p)); continue; }
      else if (gapBefore > p.h * 0.3 && !/\s$/.test(cur.text) && /[\uac00-\ud7afA-Za-z0-9\u1800-\u18AF]/.test(cur.text.slice(-1) + p.text[0]) && !/^[.,!?;:)\]」』）、。，．！？]/.test(p.text)) cur.text += ' ';
      cur.text += p.text; cur.items.push(i); cur.l = Math.min(cur.l, p.l); cur.r = Math.max(cur.r, p.r); cur.t = Math.min(cur.t, top(p)); cur.b = Math.max(cur.b, bottom(p)); cur.size = Math.max(cur.size, p.h);
      lastB = bottom(p);
    }
    if (cur) segs.push(cur);
  }
  // (A space drawn with the character before a full stop or comma that is set turned belongs after it.)
  for (const g of segs) g.text = g.text.replace(/ +([.,!?;:])(?=\S)/g, '$1 ').replace(/ +([.,!?;:])(?= |$)/g, '$1');
  // Tiers: blocks of columns side by side (a page may have two or more, one above the other); read top tier
  // first, each tier's columns right to left (left to right for Mongolian).
  segs.sort((a, b) => a.t - b.t);
  const tiers: { t: number; b: number; segs: VSegment[] }[] = [];
  for (const s of segs) {
    const tier = tiers.find((k) => s.t < k.b - s.size * 0.5 && s.b > k.t + s.size * 0.5);
    if (tier) { tier.segs.push(s); tier.t = Math.min(tier.t, s.t); tier.b = Math.max(tier.b, s.b); } else tiers.push({ t: s.t, b: s.b, segs: [s] });
  }
  tiers.sort((a, b) => a.t - b.t);
  const out: VSegment[] = [];
  for (const tier of tiers) {
    const ltr = tier.segs.filter((s) => MONGOLIAN.test(s.text)).length > tier.segs.length / 2;
    tier.segs.sort((a, b) => (ltr ? a.l - b.l : b.r - a.r));
    // A paragraph ends where its column stops short, or where the next column starts lower (the indent of a
    // new paragraph) or is not the next one along.
    const full = Math.max(...tier.segs.map((s) => s.b)), head = Math.min(...tier.segs.map((s) => s.t));
    tier.segs.forEach((s, k) => {
      const next = tier.segs[k + 1];
      const short = full - s.b > s.size * 1.2;
      const indented = !!next && next.t - head > next.size * 0.6 && next.t - s.t > next.size * 0.6;
      const apart = !!next && (ltr ? next.l - s.r : s.l - next.r) > s.size * 2.6;
      s.breakAfter = !next || short || indented || apart;
    });
    out.push(...tier.segs);
  }
  return { vertical: vert, segments: out };
}

/** The text of vertical columns as a reader reads it: a paragraph's columns run on, paragraphs on lines of
 *  their own. */
export function verticalText(segs: VSegment[]): string {
  let s = '';
  for (const g of segs) s = joinColumn(s, plainVerticalForms(g.text)) + (g.breakAfter ? '\n' : '');
  return s.trim();
}
/** A column's text after the one before it in the same paragraph: Mongolian breaks its lines between words,
 *  so a space goes between; the scripts set without spaces run on. */
export function joinColumn(before: string, next: string): string {
  if (before && next && !/\s$/.test(before) && MONGOLIAN.test(before.slice(-1)) && MONGOLIAN.test(next[0])) return before + ' ' + next;
  return before + next;
}
