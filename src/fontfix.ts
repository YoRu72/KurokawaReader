/**
 * Rebuilding a PDF's subset TrueType font so a word processor can use it.
 *
 * Many PDF makers (LibreOffice among them) embed a subset of each font whose glyphs are reached by the
 * PDF's own one-byte codes: no Unicode cmap, no shaping tables. Arabic is stored there already shaped —
 * each glyph is one form of a letter (initial, medial, final, isolated) or a ligature. Such a font cannot
 * draw Unicode text, so it cannot be embedded in a .docx as it is.
 *
 * From how the PDF uses each glyph (its code, its Unicode text, and its neighbours in the line) this
 * rebuilds what the font lacks:
 *  - a Unicode cmap (each character → its isolated glyph, or another form when only that one was used);
 *  - a GSUB table with the Arabic positional features (isol/fina/medi/init) and the ligatures (rlig), so
 *    the shaper picks the very glyphs the PDF used;
 *  - empty glyphs for characters that only occur inside ligatures (a ligature needs its parts);
 *  - an OS/2 table when there is none (Word needs it to embed the font).
 */

type Tables = Map<string, Uint8Array>;

function readTables(b: Uint8Array): Tables | null {
  try {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const tag = dv.getUint32(0);
    if (tag !== 0x00010000 && tag !== 0x74727565) return null; // TrueType outlines only
    const n = dv.getUint16(4); const out: Tables = new Map();
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      const t = String.fromCharCode(...b.subarray(r, r + 4));
      const off = dv.getUint32(r + 8), len = dv.getUint32(r + 12);
      if (off + len > b.length) return null;
      out.set(t, b.slice(off, off + len));
    }
    return out.has('glyf') && out.has('loca') && out.has('head') && out.has('hhea') && out.has('hmtx') && out.has('maxp') ? out : null;
  } catch { return null; }
}

const dvOf = (a: Uint8Array) => new DataView(a.buffer, a.byteOffset, a.byteLength);

/** Byte code → glyph id, the way a PDF viewer reads a symbolic TrueType font: (3,0) then (1,0). */
function codeToGid(cmap: Uint8Array): Map<number, number> {
  const dv = dvOf(cmap); const out = new Map<number, number>();
  const subs: { p: number; e: number; off: number }[] = [];
  for (let i = 0, n = dv.getUint16(2); i < n; i++) subs.push({ p: dv.getUint16(4 + i * 8), e: dv.getUint16(6 + i * 8), off: dv.getUint32(8 + i * 8) });
  const read = (off: number, map: (c: number) => number | null) => {
    const fmt = dv.getUint16(off);
    if (fmt === 0) { for (let c = 0; c < 256; c++) { const g = cmap[off + 6 + c]; if (g) out.set(c, g); } }
    else if (fmt === 6) { const first = dv.getUint16(off + 6), count = dv.getUint16(off + 8); for (let k = 0; k < count; k++) { const g = dv.getUint16(off + 10 + k * 2); if (g) out.set(first + k, g); } }
    else if (fmt === 4) {
      const seg = dv.getUint16(off + 6) / 2, ends = off + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2;
      for (let k = 0; k < seg; k++) {
        const a = dv.getUint16(starts + k * 2), z = dv.getUint16(ends + k * 2), d = dv.getInt16(deltas + k * 2), ro = dv.getUint16(ranges + k * 2);
        if (a === 0xffff) continue;
        for (let c = a; c <= z; c++) {
          let g: number;
          if (!ro) g = (c + d) & 0xffff;
          else { const at = ranges + k * 2 + ro + (c - a) * 2; g = dv.getUint16(at); if (g) g = (g + d) & 0xffff; }
          const code = map(c); if (g && code !== null) out.set(code, g);
        }
      }
    }
  };
  const ms = subs.find((s) => s.p === 3 && s.e === 0); const mac = subs.find((s) => s.p === 1 && s.e === 0);
  if (mac) read(mac.off, (c) => c);
  if (ms) read(ms.off, (c) => (c >= 0xf000 && c <= 0xf0ff ? c - 0xf000 : c <= 0xff ? c : null));
  return out;
}

/** Arabic joining type of a character: D dual, R right, U none, T transparent (marks). */
function joining(c: number): 'D' | 'R' | 'U' | 'T' {
  if ((c >= 0x064b && c <= 0x065f) || c === 0x0670 || (c >= 0x0610 && c <= 0x061a) || (c >= 0x06d6 && c <= 0x06dc) || (c >= 0x06df && c <= 0x06e4) || c === 0x06e7 || c === 0x06e8 || (c >= 0x06ea && c <= 0x06ed) || c === 0x200c) return 'T';
  if (c === 0x0640 || c === 0x200d) return 'D';
  if ((c >= 0x0622 && c <= 0x0625) || c === 0x0627 || c === 0x0629 || (c >= 0x062f && c <= 0x0632) || c === 0x0648 || (c >= 0x0671 && c <= 0x0673) || (c >= 0x0675 && c <= 0x0677) || (c >= 0x0688 && c <= 0x0699) || c === 0x06c0 || (c >= 0x06c3 && c <= 0x06cb) || c === 0x06cd || c === 0x06cf || c === 0x06d2 || c === 0x06d3 || c === 0x06d5 || c === 0x06ee || c === 0x06ef) return 'R';
  if (c === 0x0626 || c === 0x0628 || (c >= 0x062a && c <= 0x062e) || (c >= 0x0633 && c <= 0x063f) || (c >= 0x0641 && c <= 0x0647) || c === 0x0649 || c === 0x064a || c === 0x066e || c === 0x066f || (c >= 0x0678 && c <= 0x0687) || (c >= 0x069a && c <= 0x06bf) || c === 0x06c1 || c === 0x06c2 || c === 0x06cc || c === 0x06ce || c === 0x06d0 || c === 0x06d1 || (c >= 0x06fa && c <= 0x06fc) || c === 0x06ff || c === 0x0620) return 'D';
  return 'U';
}

type Form = 'isol' | 'init' | 'medi' | 'fina';
const FORMS: Form[] = ['isol', 'fina', 'medi', 'init'];
const formOf = (prev: boolean, next: boolean): Form => (prev && next ? 'medi' : prev ? 'fina' : next ? 'init' : 'isol');

/** One use of a glyph in the PDF: its code, its Unicode text (empty for a mark drawn with its letter's
 *  text), and where it is drawn (page x, y and the size of an em there), in drawing order along a line. */
export type GlyphUse = [code: number, text: string, x: number, y: number, em: number, width: number, span?: number];

const MIRROR: Record<number, number> = { 0x28: 0x29, 0x29: 0x28, 0x5b: 0x5d, 0x5d: 0x5b, 0x7b: 0x7d, 0x7d: 0x7b, 0xab: 0xbb, 0xbb: 0xab, 0x3c: 0x3e, 0x3e: 0x3c };
/** Canonical combining class of the Arabic marks (the order a shaper sorts them into). */
const ccc = (c: number) => ({ 0x64b: 27, 0x64c: 28, 0x64d: 29, 0x64e: 30, 0x64f: 31, 0x650: 32, 0x651: 33, 0x652: 34, 0x653: 230, 0x654: 230, 0x655: 220, 0x670: 35 } as Record<number, number>)[c] ?? 0;
const norm = (s: string) => (/[\ufb50-\ufdff\ufe70-\ufeff]/.test(s) ? s.normalize('NFKC') : s);
const isMark = (c: number) => joining(c) === 'T';

export function rebuildFont(raw: Uint8Array, lines: GlyphUse[][], spaceCode?: number): Uint8Array | null {
  const t = readTables(raw); if (!t || t.has('GSUB') || !t.has('cmap')) return null;
  const c2g = codeToGid(t.get('cmap')!);
  if (!c2g.size) return null;
  const maxp = t.get('maxp')!; let numGlyphs = dvOf(maxp).getUint16(4);
  const upem = dvOf(t.get('head')!).getUint16(18) || 1000;

  const tally = <K>(m: Map<K, Map<number, number>>, k: K, g: number) => { let x = m.get(k); if (!x) m.set(k, x = new Map()); x.set(g, (x.get(g) ?? 0) + 1); };
  const top = (x: Map<number, number>) => [...x.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const letterForm = new Map<string, Map<number, number>>(); // `${char}|${form}` → glyph uses
  const markGlyph = new Map<number, Map<number, number>>(); // mark char → glyph uses
  const markGuess = new Map<number, Map<number, number>>();
  const streams: { stream: { c: number; form: Form }[]; occ: { key: string; at: number; len: number }[] }[] = [];
  const ctxNext = new Map<string, Map<number, number>>(), ctxPrev = new Map<string, Map<number, number>>();
  const plain = new Map<number, Map<number, number>>(); // non-joining char → glyph uses
  const ligs = new Map<string, { comps: { c: number; form: Form }[]; gid: number; across?: boolean }>(); // letters only
  const absorbed = new Map<string, { c: number; form: Form; marks: number[]; gid: number }>(); // a letter drawn with its marks
  const markLigs = new Map<string, { marks: number[]; gid: number }>(); // several marks drawn as one glyph
  const offsets = new Map<string, [number, number][]>(); // `${base}|${mark}` → mark origin − base origin (font units)
  const markGids = new Set<number>(), ligGids = new Set<number>();
  const seen = new Set<number>();

  for (const line of lines) {
    // Clusters: each spacing glyph with the zero-width glyphs (its marks) drawn over it.
    type Cl = { gid: number; cps: number[]; marks: number[]; x: number; y: number; em: number; adv: number; mpos: [number, number][]; bad?: boolean; span?: number };
    const cls: Cl[] = []; const loose: { gid: number; x: number; y: number; cps: number[]; span?: number }[] = [];
    for (const [code, text, x, y, em, w, span] of line) {
      const gid = c2g.get(code) ?? 0; if (!gid) continue;
      // (A code with no real text comes as a control or private-use character.)
      const cps = [...norm(text)].map((c) => c.codePointAt(0)!).filter((c) => c >= 0x20 && !(c >= 0xe000 && c <= 0xf8ff) && c !== 0xfffd);
      if (text === '\uffff') { cls.push({ gid, cps: [], marks: [], x, y, em, adv: w * em, mpos: [], bad: true }); continue; }
      if (w > 0 && !(cps.length && cps.every(isMark))) cls.push({ gid, cps, marks: [], x, y, em, adv: w * em, mpos: [], span: span || undefined });
      else loose.push({ gid, x, y, cps, span: span || undefined });
    }
    for (const m of loose) {
      // A mark with text of its own (a real combining mark) stays a cluster of its own; others go on their letter.
      if (m.cps.length && m.cps.every(isMark)) { cls.push({ gid: m.gid, cps: m.cps, marks: [], x: m.x, y: m.y, em: 0, adv: 0, mpos: [] }); continue; }
      const own = m.span ? cls.find((c) => c.span === m.span && !c.bad) : undefined;
      if (own) { own.marks.push(m.gid); own.mpos.push([m.x, m.y]); continue; }
      if (m.span) continue; // a span with several letters: whose mark it is is not known
      let best: Cl | null = null, bd = Infinity;
      for (const c of cls) { if (c.bad) continue; const d = m.x < c.x ? c.x - m.x : m.x > c.x + c.adv ? m.x - c.x - c.adv : 0; if (d < bd) { bd = d; best = c; } }
      if (best && bd < best.em * 0.3) { best.marks.push(m.gid); best.mpos.push([m.x, m.y]); }
    }
    cls.sort((a, b) => a.x - b.x || b.adv - a.adv);
    const rtl = cls.filter((e) => e.cps.some((c) => c >= 0x600 && c <= 0x6ff)).length > cls.length / 2;
    if (rtl) cls.reverse();
    const stream: { c: number; form: Form }[] = []; const occ: { key: string; at: number; len: number }[] = [];
    streams.push({ stream, occ });
    const letters = (e: Cl) => (e.bad || !e.cps.length ? [0x20] : e.cps.filter((c) => !isMark(c)));
    const firstJ = (e: Cl) => { const n = letters(e); return n.length ? joining(n[0]) : 'T'; };
    const lastJ = (e: Cl) => { const n = letters(e); return n.length ? joining(n[n.length - 1]) : 'T'; };
    for (let i = 0; i < cls.length; i++) {
      const e = cls[i];
      if (e.bad || !e.cps.length) { stream.push({ c: 0, form: 'isol' }); continue; }
      for (const c of e.cps) seen.add(c);
      const marks = e.cps.filter(isMark), lets = letters(e);
      // Marks drawn as their own glyphs: one glyph per mark, in order; or several marks in one glyph.
      const markPart = (base: number, letterKey?: string) => {
        e.marks.forEach((g, k) => {
          markGids.add(g); if (!(e.em > 0)) return;
          const off: [number, number] = [(e.mpos[k][0] - e.x) / e.em * upem, (e.mpos[k][1] - e.y) / e.em * upem];
          for (const key of [`${base}|${g}`, ...(letterKey ? [`L${letterKey}|${g}`] : [])]) { const list = offsets.get(key) ?? []; list.push(off); offsets.set(key, list); }
        });
        // One mark, one glyph: that is its glyph; with several, the order is only a guess (used when nothing better).
        if (e.marks.length === 1 && marks.length === 1) tally(markGlyph, marks[0], e.marks[0]);
        else if (e.marks.length === marks.length) marks.forEach((c, k) => tally(markGuess, c, e.marks[k]));
        else if (e.marks.length === 1 && marks.length > 1) markLigs.set(marks.join(','), { marks, gid: e.marks[0] });
      };
      if (!lets.length) { // a mark glyph with its own text
        markGids.add(e.gid);
        if (marks.length === 1) tally(markGlyph, marks[0], e.gid); else markLigs.set(marks.join(','), { marks, gid: e.gid });
        continue;
      }
      let p = i - 1; while (p >= 0 && firstJ(cls[p]) === 'T') p--;
      let q = i + 1; while (q < cls.length && firstJ(cls[q]) === 'T') q++;
      const joinsPrev = p >= 0 && lastJ(cls[p]) === 'D' && (firstJ(e) === 'D' || firstJ(e) === 'R');
      const joinsNext = q < cls.length && lastJ(e) === 'D' && (firstJ(cls[q]) === 'D' || firstJ(cls[q]) === 'R');
      const form = formOf(joinsPrev, joinsNext);
      if (lets.length === 1) {
        const c = lets[0];
        // A bracket in right-to-left text is drawn mirrored: its glyph has the other bracket's shape (the
        // shaper mirrors it back).
        if (joining(c) === 'U') { if (!marks.length) tally(plain, rtl ? MIRROR[c] ?? c : c, e.gid); markPart(e.gid); stream.push({ c: 0, form: 'isol' }); continue; }
        stream.push({ c, form });
        if (marks.length && !e.marks.length) absorbed.set(`${c}|${form}|${marks.join(',')}`, { c, form, marks, gid: e.gid }); // the glyph draws the marks
        else {
          tally(letterForm, `${c}|${form}`, e.gid); markPart(e.gid, `${c}|${form}`);
          // The letter it joins on each side: naskh draws many letters differently before (or after) certain others.
          // (A letter that does not join its neighbour, an alef before a lam, can still depend on it.)
          const nb = (k: number, last: boolean) => { if (k < 0 || k >= cls.length) return 0; const l = letters(cls[k]); const x = last ? l[l.length - 1] : l[0]; return x && joining(x) !== 'U' ? x : 0; };
          const nl = nb(q, false), pl = nb(p, true);
          tally(ctxNext, `${c}|${form}|${nl}`, e.gid); tally(ctxPrev, `${c}|${form}|${pl}`, e.gid);
        }
        continue;
      }
      // A ligature of letters: the forms they would take in its place in the word.
      ligGids.add(e.gid);
      const comps = lets.map((c, k) => {
        const j = joining(c);
        const prevIn = k > 0 ? joining(lets[k - 1]) === 'D' && j !== 'U' : joinsPrev;
        const nextIn = k < lets.length - 1 ? j === 'D' && joining(lets[k + 1]) !== 'U' : joinsNext;
        return { c, form: formOf(prevIn, nextIn) };
      });
      const lkey = `${lets.join(',')}|${comps.map((x) => x.form).join(',')}`;
      // Marks between its letters: the ligature also forms across them (otherwise marks keep the letters apart).
      const across = e.cps.some((c, k) => isMark(c) && k > 0 && k < e.cps.length - 1 && e.cps.slice(k).some((x) => !isMark(x)));
      ligs.set(lkey, { comps, gid: e.gid, across: across || ligs.get(lkey)?.across });
      if (occ.length < 4000) occ.push({ key: lkey, at: stream.length, len: comps.length });
      stream.push(...comps);
      markPart(e.gid);
    }
  }

  // Each (letter, form) → its most used glyph; each character's nominal glyph (what the cmap gives).
  const formGlyph = new Map<number, Partial<Record<Form, number>>>();
  // The usual glyph of a letter in a form is the one drawn beside the most different neighbours (a variant
  // used only before, say, a noon is the exception, even when that pair is frequent).
  const groups = (ctx: Map<string, Map<number, number>>, c: number, f: Form) => [...ctx.entries()].filter(([k]) => k.startsWith(`${c}|${f}|`)).map(([k, uses]) => ({ other: +k.split('|')[2], uses }));
  for (const [k, uses] of letterForm) {
    const [c, f] = k.split('|'); const side = f === 'fina' ? ctxPrev : ctxNext;
    const score = new Map<number, number>();
    for (const g of groups(side, +c, f as Form)) { const t = top(g.uses); score.set(t, (score.get(t) ?? 0) + 1); }
    const all = [...uses.entries()].sort((a, b) => (score.get(b[0]) ?? 0) - (score.get(a[0]) ?? 0) || b[1] - a[1]);
    const m = formGlyph.get(+c) ?? {}; m[f as Form] = all[0][0]; formGlyph.set(+c, m);
  }
  const nominal = new Map<number, number>();
  for (const [c, uses] of plain) nominal.set(c, top(uses));
  const sp = spaceCode !== undefined ? c2g.get(spaceCode) : undefined; if (sp) nominal.set(0x20, sp);
  for (const [c, uses] of markGlyph) nominal.set(c, top(uses));
  for (const [c, uses] of markGuess) if (!nominal.has(c)) nominal.set(c, top(uses));
  for (const [c, m] of formGlyph) nominal.set(c, m.isol ?? m.fina ?? m.init ?? m.medi!);
  const added: number[] = [];
  for (const c of seen) if (!nominal.has(c) && c > 0x20) { nominal.set(c, numGlyphs + added.length); added.push(c); if (isMark(c)) markGids.add(numGlyphs + added.length - 1); }
  if (!nominal.size) return null;
  numGlyphs += added.length;

  // GSUB: positional forms, letters drawn with their marks, marks drawn together, letter ligatures.
  const singles: Record<Form, Map<number, number>> = { isol: new Map(), fina: new Map(), medi: new Map(), init: new Map() };
  for (const [c, m] of formGlyph) {
    const nom = nominal.get(c)!;
    for (const f of FORMS) { const g = m[f]; if (g !== undefined && g !== nom) singles[f].set(nom, g); }
  }
  const after = (c: number, f: Form | null) => { const nom = nominal.get(c)!; return f ? singles[f].get(nom) ?? nom : nom; };
  const rules = (list: { seq: number[]; gid: number }[]) => {
    const m = new Map<number, { rest: number[]; gid: number }[]>();
    for (const { seq, gid } of list) {
      if (seq.length < 2) continue;
      const l = m.get(seq[0]) ?? []; if (l.some((r) => r.rest.join() === seq.slice(1).join())) continue;
      l.push({ rest: seq.slice(1), gid }); m.set(seq[0], l);
    }
    for (const l of m.values()) l.sort((a, b) => b.rest.length - a.rest.length);
    return m;
  };
  // Marks as the text has them and in canonical order (shapers sort marks by combining class).
  const orders = (ms: number[]) => { const c = [...ms].sort((a, b) => ccc(a) - ccc(b)); return c.join() === ms.join() ? [ms] : [ms, c]; };
  const absorbRules = rules([...absorbed.values()].flatMap((a) => orders(a.marks).map((ms) => ({ seq: [after(a.c, a.form), ...ms.map((c) => nominal.get(c)!)], gid: a.gid }))));
  const markRules = rules([...markLigs.values()].flatMap((a) => orders(a.marks).map((ms) => ({ seq: ms.map((c) => nominal.get(c)!), gid: a.gid }))));
  // Ligatures that overlap (مي and ين in "مين") are tried in the order the PDF shows: one that won where
  // the other could have started first goes in an earlier lookup.
  const level = new Map<string, number>([...ligs.keys()].map((k) => [k, 0]));
  const beats: [string, string][] = [];
  const ligList = [...ligs.entries()];
  for (const { stream, occ } of streams) for (const o of occ) {
    for (const [yk, y] of ligList) {
      if (yk === o.key) continue;
      const n = y.comps.length;
      for (let j = Math.max(0, o.at - n + 1); j <= o.at; j++) {
        if (j + n > stream.length || (j === o.at && n <= o.len)) continue;
        // (Compared as the glyphs the shaper will have: two forms can share a glyph.)
        if (y.comps.every((cp, k) => stream[j + k].c === cp.c && after(cp.c, cp.form) === after(cp.c, stream[j + k].form))) { beats.push([o.key, yk]); break; }
      }
    }
  }
  for (let it = 0; it < 8; it++) { let changed = false; for (const [a, b] of beats) if (level.get(b)! <= level.get(a)!) { level.set(b, level.get(a)! + 1); changed = true; } if (!changed) break; }
  const ligLevels = [...new Set(level.values())].sort((a, b) => a - b).flatMap((lv) => [true, false].map((across) => ({
    flag: across ? 8 : 0,
    rules: rules([...ligs.entries()].filter(([k, a]) => level.get(k) === lv && !!a.across === across).map(([, a]) => ({ seq: a.comps.map((x) => after(x.c, x.form)), gid: a.gid }))),
  })));
  for (const a of absorbed.values()) ligGids.add(a.gid);

  // GPOS: each mark where the PDF put it on its letter (mark-to-base, one mark class per mark glyph).
  const anchors = new Map<number, Map<number, [number, number]>>(); // base → mark → offset
  // A letter's marks also attach to the glyph the shaper will pick for that letter and form.
  for (const [k, list] of [...offsets]) {
    if (!k.startsWith('L')) continue;
    const [c, f, m] = k.slice(1).split('|'); const shaped = after(+c, f as Form);
    if (!offsets.has(`${shaped}|${m}`)) offsets.set(`${shaped}|${m}`, list);
  }
  for (const [k, list] of offsets) {
    if (k.startsWith('L')) continue;
    const [b, m] = k.split('|').map(Number);
    const xs = list.map((v) => v[0]).sort((a, c) => a - c), ys = list.map((v) => v[1]).sort((a, c) => a - c);
    const mid = (a: number[]) => a[Math.floor(a.length / 2)];
    let row = anchors.get(b); if (!row) anchors.set(b, row = new Map());
    row.set(m, [Math.round(mid(xs)), Math.round(mid(ys))]);
  }

  const out = new Map(t);
  out.set('cmap', buildCmap(nominal));
  // Contextual variants: the usual form glyph becomes the variant the PDF drew next to that neighbour.
  const glyphsOf = new Map<number, Set<number>>();
  for (const [k, uses] of letterForm) { const c = +k.split('|')[0]; const set = glyphsOf.get(c) ?? new Set<number>(); for (const g of uses.keys()) set.add(g); glyphsOf.set(c, set); }
  for (const [c, g] of nominal) glyphsOf.get(c)?.add(g);
  // A neighbour may be part of a ligature by then (ligatures come before contextual forms): the ligatures
  // that begin (for what follows) or end (for what precedes) with that letter count as it.
  const ligStarts = new Map<number, Set<number>>(), ligEnds = new Map<number, Set<number>>();
  for (const l of ligs.values()) {
    const a = l.comps[0].c, z = l.comps[l.comps.length - 1].c;
    (ligStarts.get(a) ?? ligStarts.set(a, new Set()).get(a)!).add(l.gid);
    (ligEnds.get(z) ?? ligEnds.set(z, new Set()).get(z)!).add(l.gid);
  }
  const variants: Ctx[] = [];
  for (const [k] of letterForm) {
    const [c, f] = k.split('|'); const form = f as Form; const usual = after(+c, form);
    for (const g of groups(form === 'fina' ? ctxPrev : ctxNext, +c, form)) {
      const v = top(g.uses); if (v === usual || !g.other) continue;
      const other = new Set([...(glyphsOf.get(g.other) ?? []), ...((form === 'fina' ? ligEnds : ligStarts).get(g.other) ?? [])]);
      if (!other.size) continue;
      variants.push({ from: usual, to: v, ctx: [...other].sort((a, b) => a - b), before: form === 'fina' });
    }
  }
  out.set('GSUB', buildGsub(singles, [{ rules: absorbRules, flag: 0 }, { rules: markRules, flag: 0 }, ...ligLevels], variants));
  if (anchors.size) out.set('GPOS', buildGpos(anchors));
  out.set('GDEF', buildGdef(markGids, ligGids));
  // Empty glyphs for the added characters; full metrics; marks take no advance.
  const head = t.get('head')!; const longLoca = dvOf(head).getInt16(50) === 1;
  if (added.length) {
    const loca = t.get('loca')!; const oldN = numGlyphs - added.length;
    const last = longLoca ? dvOf(loca).getUint32(oldN * 4) : dvOf(loca).getUint16(oldN * 2);
    const nl = new Uint8Array((numGlyphs + 1) * (longLoca ? 4 : 2)); nl.set(loca.subarray(0, (oldN + 1) * (longLoca ? 4 : 2)));
    const nd = dvOf(nl); for (let g = oldN + 1; g <= numGlyphs; g++) { if (longLoca) nd.setUint32(g * 4, last); else nd.setUint16(g * 2, last); }
    out.set('loca', nl);
    const m2 = maxp.slice(); dvOf(m2).setUint16(4, numGlyphs); out.set('maxp', m2);
  }
  const hhea = t.get('hhea')!.slice(); const hm = t.get('hmtx')!; const nh = dvOf(hhea).getUint16(34);
  const adv: number[] = [], lsb: number[] = [];
  const oldN = numGlyphs - added.length;
  for (let g = 0; g < oldN; g++) { adv.push(dvOf(hm).getUint16(Math.min(g, nh - 1) * 4)); lsb.push(g < nh ? dvOf(hm).getInt16(g * 4 + 2) : dvOf(hm).getInt16(nh * 4 + (g - nh) * 2)); }
  for (let k = 0; k < added.length; k++) { adv.push(0); lsb.push(0); }
  for (const g of markGids) if (g < adv.length) adv[g] = 0;
  const hmtx = new Uint8Array(numGlyphs * 4); const hd = dvOf(hmtx);
  for (let g = 0; g < numGlyphs; g++) { hd.setUint16(g * 4, adv[g]); hd.setInt16(g * 4 + 2, lsb[g]); }
  dvOf(hhea).setUint16(34, numGlyphs); out.set('hhea', hhea); out.set('hmtx', hmtx);
  // post: format 3 (no glyph names), the names of the subset mean nothing now.
  const post = t.get('post'); const np = new Uint8Array(32); if (post && post.length >= 32) np.set(post.subarray(0, 32)); dvOf(np).setUint32(0, 0x00030000); out.set('post', np);
  if (!out.has('OS/2')) out.set('OS/2', buildOs2(t, nominal, adv));
  out.delete('hdmx'); out.delete('LTSH'); out.delete('VDMX'); // per-glyph tables that no longer match
  return writeFont(out);
}

function buildCmap(map: Map<number, number>): Uint8Array {
  const cs = [...map.keys()].filter((c) => c <= 0xffff).sort((a, b) => a - b);
  // Format 4 with one segment per run of consecutive characters with consecutive glyphs (delta), else per char.
  const segs: { a: number; z: number; d: number }[] = [];
  for (const c of cs) {
    const g = map.get(c)!; const s = segs[segs.length - 1];
    if (s && c === s.z + 1 && ((g - c) & 0xffff) === s.d) s.z = c; else segs.push({ a: c, z: c, d: (g - c) & 0xffff });
  }
  segs.push({ a: 0xffff, z: 0xffff, d: 1 });
  const n = segs.length; const len = 16 + n * 8;
  const sub = new Uint8Array(len); const d = dvOf(sub);
  d.setUint16(0, 4); d.setUint16(2, len); d.setUint16(4, 0); d.setUint16(6, n * 2);
  const sr = 2 * 2 ** Math.floor(Math.log2(n)); d.setUint16(8, sr); d.setUint16(10, Math.floor(Math.log2(n))); d.setUint16(12, n * 2 - sr);
  segs.forEach((s, i) => { d.setUint16(14 + i * 2, s.z); d.setUint16(16 + n * 2 + i * 2, s.a); d.setUint16(16 + n * 4 + i * 2, s.d); d.setUint16(16 + n * 6 + i * 2, 0); });
  const out = new Uint8Array(4 + 8 * 2 + len); const o = dvOf(out);
  o.setUint16(0, 0); o.setUint16(2, 2);
  o.setUint16(4, 0); o.setUint16(6, 3); o.setUint32(8, 20);
  o.setUint16(12, 3); o.setUint16(14, 1); o.setUint32(16, 20);
  out.set(sub, 20);
  return out;
}

/** A byte writer for OpenType structures with offsets filled in later. */
class W {
  b: number[] = [];
  u16(v: number) { this.b.push((v >> 8) & 255, v & 255); return this; }
  u32(v: number) { this.u16((v >>> 16) & 0xffff); this.u16(v & 0xffff); return this; }
  tag(s: string) { for (let i = 0; i < 4; i++) this.b.push(s.charCodeAt(i)); return this; }
  at(pos: number, v: number) { this.b[pos] = (v >> 8) & 255; this.b[pos + 1] = v & 255; }
  get len() { return this.b.length; }
  bytes() { return new Uint8Array(this.b); }
}

function coverage(gids: number[]): number[] {
  const w = new W(); w.u16(1).u16(gids.length); for (const g of gids) w.u16(g); return w.b;
}

type LigLookup = { rules: Map<number, { rest: number[]; gid: number }[]>; flag: number };

function ligatureSubtable(ligs: Map<number, { rest: number[]; gid: number }[]>): number[] {
  const firsts = [...ligs.keys()].sort((a, b) => a - b);
  const st = new W(); st.u16(1); const covAt = st.len; st.u16(0); st.u16(firsts.length);
  const setAt = firsts.map(() => { const p = st.len; st.u16(0); return p; });
  firsts.forEach((g, i) => {
    const setStart = st.len; st.at(setAt[i], setStart);
    const rules = ligs.get(g)!; st.u16(rules.length);
    const ruleAt = rules.map(() => { const p = st.len; st.u16(0); return p; });
    rules.forEach((r, k) => { st.at(ruleAt[k], st.len - setStart); st.u16(r.gid).u16(r.rest.length + 1); for (const x of r.rest) st.u16(x); });
  });
  st.at(covAt, st.len); st.b.push(...coverage(firsts));
  return st.b;
}

type Ctx = { from: number; to: number; ctx: number[]; before: boolean };

function buildGsub(singles: Record<Form, Map<number, number>>, ligLookups: LigLookup[], variants: Ctx[] = []): Uint8Array {
  const lookups: number[][] = [];
  const features: { tag: string; idx: number[] }[] = [];
  for (const f of FORMS) {
    const m = singles[f]; if (!m.size) continue;
    const from = [...m.keys()].sort((a, b) => a - b);
    const st = new W(); st.u16(2); const covAt = st.len; st.u16(0); st.u16(from.length); for (const g of from) st.u16(m.get(g)!);
    st.at(covAt, st.len); st.b.push(...coverage(from));
    lookups.push(lookupOf(1, st.b)); features.push({ tag: f, idx: [lookups.length - 1] });
  }
  const rlig: number[] = [];
  for (const { rules, flag } of ligLookups) { if (!rules.size) continue; lookups.push(lookupOf(4, ligatureSubtable(rules), flag)); rlig.push(lookups.length - 1); }
  if (rlig.length) features.push({ tag: 'rlig', idx: rlig });
  if (variants.length) {
    // One single substitution per (usual → variant), and one chaining lookup choosing among them by neighbour.
    const swap = new Map<string, number>();
    for (const v of variants) {
      const key = `${v.from}>${v.to}`; if (swap.has(key)) continue;
      const st = new W(); st.u16(2); const covAt = st.len; st.u16(0); st.u16(1); st.u16(v.to); st.at(covAt, st.len); st.b.push(...coverage([v.from]));
      lookups.push(lookupOf(1, st.b)); swap.set(key, lookups.length - 1);
    }
    const subs = variants.map((v) => {
      const st = new W(); st.u16(3);
      const covs: [number, number[]][] = [];
      const cov = (gs: number[]) => { const p = st.len; st.u16(0); covs.push([p, gs]); };
      st.u16(v.before ? 1 : 0); if (v.before) cov(v.ctx);
      st.u16(1); cov([v.from]);
      st.u16(v.before ? 0 : 1); if (!v.before) cov(v.ctx);
      st.u16(1); st.u16(0).u16(swap.get(`${v.from}>${v.to}`)!);
      for (const [p, gs] of covs) { st.at(p, st.len); st.b.push(...coverage(gs)); }
      return st.b;
    });
    lookups.push(lookupMany(6, subs, 8)); features.push({ tag: 'calt', idx: [lookups.length - 1] });
  }
  return layoutTable(features, lookups);
}

/** GSUB/GPOS common part: scripts DFLT and arab (default language: every feature), features, lookups. */
function layoutTable(features: { tag: string; idx: number[] }[], lookups: number[][]): Uint8Array {
  features.sort((x, y) => (x.tag < y.tag ? -1 : x.tag > y.tag ? 1 : 0));
  const feats = features.map((_, i) => i);
  const sl = new W(); sl.u16(2);
  const sAt = ['DFLT', 'arab'].map((s) => { sl.tag(s); const p = sl.len; sl.u16(0); return p; });
  for (const p of sAt) { sl.at(p, sl.len); sl.u16(4).u16(0); sl.u16(0).u16(0xffff).u16(feats.length); for (const i of feats) sl.u16(i); }
  const fl = new W(); fl.u16(features.length);
  const fAt = features.map((f) => { fl.tag(f.tag); const p = fl.len; fl.u16(0); return p; });
  features.forEach((f, i) => { fl.at(fAt[i], fl.len); fl.u16(0).u16(f.idx.length); for (const x of f.idx) fl.u16(x); });
  const ll = new W(); ll.u16(lookups.length);
  const lAt = lookups.map(() => { const p = ll.len; ll.u16(0); return p; });
  lookups.forEach((lk, i) => { ll.at(lAt[i], ll.len); ll.b.push(...lk); });
  const g = new W(); g.u32(0x00010000); g.u16(10); g.u16(10 + sl.len); g.u16(10 + sl.len + fl.len);
  g.b.push(...sl.b, ...fl.b, ...ll.b);
  return g.bytes();
}

function lookupMany(type: number, subs: number[][], flag = 0): number[] {
  const w = new W(); w.u16(type).u16(flag).u16(subs.length);
  const at = subs.map(() => { const p = w.len; w.u16(0); return p; });
  subs.forEach((sb, i) => { w.at(at[i], w.len); w.b.push(...sb); });
  return w.b;
}

function lookupOf(type: number, sub: number[], flag = 0): number[] {
  const w = new W(); w.u16(type).u16(flag).u16(1).u16(8); w.b.push(...sub); return w.b;
}

/** Mark-to-base positioning: every mark glyph its own class, anchored at (0,0); each base has, for each mark
 *  seen on it, the offset at which the PDF drew that mark. */
function buildGpos(anchors: Map<number, Map<number, [number, number]>>): Uint8Array {
  const marks = [...new Set([...anchors.values()].flatMap((r) => [...r.keys()]))].sort((a, b) => a - b);
  const bases = [...anchors.keys()].filter((b) => !marks.includes(b)).sort((a, b) => a - b);
  const cls = new Map(marks.map((m, i) => [m, i]));
  const st = new W();
  st.u16(1); const mcAt = st.len; st.u16(0); const bcAt = st.len; st.u16(0); st.u16(marks.length); const maAt = st.len; st.u16(0); const baAt = st.len; st.u16(0);
  // MarkArray
  st.at(maAt, st.len); const ma = st.len; st.u16(marks.length);
  const mrAt = marks.map((m) => { st.u16(cls.get(m)!); const p = st.len; st.u16(0); return p; });
  marks.forEach((_, i) => { st.at(mrAt[i], st.len - ma); st.u16(1).u16(0).u16(0); });
  // BaseArray
  st.at(baAt, st.len); const ba = st.len; st.u16(bases.length);
  const slots = bases.map((b) => marks.map((m) => { const p = st.len; st.u16(0); return anchors.get(b)!.has(m) ? p : -1; }));
  bases.forEach((b, i) => marks.forEach((m, k) => {
    const p = slots[i][k]; if (p < 0) return;
    const [x, y] = anchors.get(b)!.get(m)!; st.at(p, st.len - ba); st.u16(1).u16(x & 0xffff).u16(y & 0xffff);
  }));
  st.at(mcAt, st.len); st.b.push(...coverage(marks));
  st.at(bcAt, st.len); st.b.push(...coverage(bases));
  return layoutTable([{ tag: 'mark', idx: [0] }], [lookupOf(4, st.b)]);
}

/** Glyph classes: marks (so ligatures skip them and they attach to letters), ligatures; the rest bases. */
function buildGdef(marks: Set<number>, ligs: Set<number>): Uint8Array {
  const entries = [...[...marks].map((g) => [g, 3] as const), ...[...ligs].filter((g) => !marks.has(g)).map((g) => [g, 1] as const)].sort((a, b) => a[0] - b[0]);
  const w = new W(); w.u32(0x00010000).u16(12).u16(0).u16(0).u16(0);
  w.u16(2).u16(entries.length); for (const [g, c] of entries) w.u16(g).u16(g).u16(c);
  return w.bytes();
}

function buildOs2(t: Tables, nominal: Map<number, number>, adv: number[]): Uint8Array {
  const head = dvOf(t.get('head')!), hhea = dvOf(t.get('hhea')!);
  const asc = hhea.getInt16(4), desc = hhea.getInt16(6), gap = hhea.getInt16(8);
  const yMax = head.getInt16(42), yMin = head.getInt16(38);
  const used = [...nominal.values()].map((g) => adv[g] ?? 0).filter((a) => a > 0);
  const avg = used.length ? Math.round(used.reduce((a, b) => a + b, 0) / used.length) : 500;
  const macStyle = head.getUint16(44); const bold = !!(macStyle & 1), italic = !!(macStyle & 2);
  const cs = [...nominal.keys()].filter((c) => c <= 0xffff);
  const arabic = cs.some((c) => c >= 0x600 && c <= 0x6ff);
  const w = new W();
  w.u16(4).u16(avg).u16(bold ? 700 : 400).u16(5).u16(0); // version, xAvgCharWidth, weight, width, fsType: installable
  const em = head.getUint16(18);
  for (const v of [Math.round(em * 0.65), Math.round(em * 0.6), 0, Math.round(em * 0.075), Math.round(em * 0.65), Math.round(em * 0.6), 0, Math.round(em * 0.48), Math.round(em * 0.05), Math.round(em * 0.25)]) w.u16(v & 0xffff);
  w.u16(0); // sFamilyClass
  for (let i = 0; i < 10; i++) w.b.push(0); // panose
  w.u32(1 | (arabic ? 1 << 13 : 0)).u32(0).u32(0).u32(0); // Unicode ranges: Basic Latin, Arabic
  w.tag('KRDR');
  w.u16((bold ? 0x20 : 0) | (italic ? 1 : 0) | (!bold && !italic ? 0x40 : 0) | 0x80);
  w.u16(cs.length ? Math.min(...cs) : 0x20).u16(cs.length ? Math.max(...cs) : 0x20);
  w.u16(asc & 0xffff).u16(desc & 0xffff).u16(gap & 0xffff);
  w.u16(Math.max(0, yMax)).u16(Math.max(0, -yMin));
  w.u32(1 | (arabic ? 1 << 6 : 0)).u32(0); // code pages: Latin 1, Arabic
  w.u16(Math.round(em * 0.5)).u16(Math.round(em * 0.7)).u16(0).u16(0x20).u16(0);
  return w.bytes();
}

function writeFont(tables: Tables): Uint8Array {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  let off = 12 + n * 16; const offs: number[] = [];
  for (const t of tags) { offs.push(off); off += (tables.get(t)!.length + 3) & ~3; }
  const out = new Uint8Array(off); const d = dvOf(out);
  d.setUint32(0, 0x00010000); d.setUint16(4, n);
  const es = Math.floor(Math.log2(n)); d.setUint16(6, 16 * 2 ** es); d.setUint16(8, es); d.setUint16(10, n * 16 - 16 * 2 ** es);
  const sum = (a: Uint8Array) => { let s = 0; for (let i = 0; i < a.length; i += 4) s = (s + ((a[i] << 24) | ((a[i + 1] ?? 0) << 16) | ((a[i + 2] ?? 0) << 8) | (a[i + 3] ?? 0))) >>> 0; return s; };
  tags.forEach((t, i) => {
    let data = tables.get(t)!;
    if (t === 'head') { data = data.slice(); dvOf(data).setUint32(8, 0); }
    const r = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[r + k] = t.charCodeAt(k);
    d.setUint32(r + 4, sum(data)); d.setUint32(r + 8, offs[i]); d.setUint32(r + 12, data.length);
    out.set(data, offs[i]);
  });
  const hi = tags.indexOf('head');
  if (hi >= 0) d.setUint32(offs[hi] + 8, (0xb1b0afba - sum(out)) >>> 0);
  return out;
}
