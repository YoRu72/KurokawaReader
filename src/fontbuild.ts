/**
 * Glyph outlines out of a PDF's fonts, and a TrueType font built from them.
 *
 * Word embeds TrueType fonts only. A PDF's fonts often are CFF (Type 1, Type 1C, OpenType/CFF — TeX,
 * InDesign, 3B2, Canva) or TrueType subsets without a Unicode map. pdf.js turns every embedded font into an
 * OpenType file for the browser; from that file this reads each glyph's outline — TrueType quadratic
 * contours as they are, CFF Type 2 charstrings run and their cubic curves approximated by quadratics — and
 * writes a fresh, small TrueType font holding just the glyphs a document uses, with whatever cmap and
 * layout tables the caller gives it.
 */

export type Pt = { x: number; y: number; on: boolean };
export type Outline = { contours: Pt[][]; adv: number };

const dvOf = (a: Uint8Array) => new DataView(a.buffer, a.byteOffset, a.byteLength);

export type Sfnt = { tables: Map<string, Uint8Array>; cff: boolean };

export function readSfnt(b: Uint8Array): Sfnt | null {
  try {
    const dv = dvOf(b);
    const tag = dv.getUint32(0);
    const cff = tag === 0x4f54544f; // 'OTTO'
    if (!cff && tag !== 0x00010000 && tag !== 0x74727565) return null;
    const n = dv.getUint16(4); const tables = new Map<string, Uint8Array>();
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      const t = String.fromCharCode(...b.subarray(r, r + 4));
      const off = dv.getUint32(r + 8), len = dv.getUint32(r + 12);
      if (off + len > b.length) continue;
      tables.set(t, b.subarray(off, off + len));
    }
    return { tables, cff };
  } catch { return null; }
}

/** Unicode (or private-use) code point → glyph, from the font's (3,1)/(3,10)/(0,x)/(3,0) cmap. */
export function cmapGlyphs(s: Sfnt): Map<number, number> {
  const out = new Map<number, number>();
  const cm = s.tables.get('cmap'); if (!cm) return out;
  const dv = dvOf(cm);
  const subs: { p: number; e: number; off: number }[] = [];
  for (let i = 0, n = dv.getUint16(2); i < n; i++) subs.push({ p: dv.getUint16(4 + i * 8), e: dv.getUint16(6 + i * 8), off: dv.getUint32(8 + i * 8) });
  subs.sort((a, b) => (a.p === 3 && a.e === 10 ? -2 : a.p === 3 ? -1 : 0) - (b.p === 3 && b.e === 10 ? -2 : b.p === 3 ? -1 : 0));
  for (const { off } of subs) {
    try {
      const fmt = dv.getUint16(off);
      if (fmt === 4) {
        const seg = dv.getUint16(off + 6) / 2, ends = off + 14, starts = ends + seg * 2 + 2, deltas = starts + seg * 2, ranges = deltas + seg * 2;
        for (let k = 0; k < seg; k++) {
          const a = dv.getUint16(starts + k * 2), z = dv.getUint16(ends + k * 2), d = dv.getInt16(deltas + k * 2), ro = dv.getUint16(ranges + k * 2);
          if (a === 0xffff) continue;
          for (let c = a; c <= z; c++) {
            let g: number;
            if (!ro) g = (c + d) & 0xffff;
            else { g = dv.getUint16(ranges + k * 2 + ro + (c - a) * 2); if (g) g = (g + d) & 0xffff; }
            if (g && !out.has(c)) out.set(c, g);
          }
        }
      } else if (fmt === 12) {
        for (let k = 0, n = dv.getUint32(off + 12); k < n; k++) {
          const a = dv.getUint32(off + 16 + k * 12), z = dv.getUint32(off + 20 + k * 12), g = dv.getUint32(off + 24 + k * 12);
          for (let c = a; c <= z && c - a < 0x10000; c++) if (!out.has(c)) out.set(c, g + c - a);
        }
      } else if (fmt === 6) {
        const first = dv.getUint16(off + 6), count = dv.getUint16(off + 8);
        for (let k = 0; k < count; k++) { const g = dv.getUint16(off + 10 + k * 2); if (g && !out.has(first + k)) out.set(first + k, g); }
      } else if (fmt === 0) {
        for (let c = 0; c < 256; c++) { const g = cm[off + 6 + c]; if (g && !out.has(c)) out.set(c, g); }
      }
    } catch { /* skip a broken subtable */ }
  }
  return out;
}

export function unitsPerEm(s: Sfnt): number {
  const h = s.tables.get('head');
  return h && h.length >= 20 ? dvOf(h).getUint16(18) || 1000 : 1000;
}

/** Vertical metrics: hhea ascender / descender (font units). */
export function verticalMetrics(s: Sfnt): { asc: number; desc: number } | null {
  const h = s.tables.get('hhea');
  if (!h || h.length < 8) return null;
  return { asc: dvOf(h).getInt16(4), desc: dvOf(h).getInt16(6) };
}

function advances(s: Sfnt): (gid: number) => number {
  const hh = s.tables.get('hhea'), hm = s.tables.get('hmtx');
  if (!hh || !hm) return () => 0;
  const n = dvOf(hh).getUint16(34); const dv = dvOf(hm);
  return (g) => { const i = Math.min(g, n - 1) * 4; return i + 2 <= hm.length ? dv.getUint16(i) : 0; };
}

/* ------------------------------------------------------------------ */
/* TrueType outlines                                                   */
/* ------------------------------------------------------------------ */

function ttOutlineReader(s: Sfnt): (gid: number) => Pt[][] {
  const glyf = s.tables.get('glyf'), loca = s.tables.get('loca'), head = s.tables.get('head');
  if (!glyf || !loca || !head) return () => [];
  const long = dvOf(head).getInt16(50) === 1;
  const ld = dvOf(loca), gd = dvOf(glyf);
  const range = (g: number): [number, number] => {
    try { return long ? [ld.getUint32(g * 4), ld.getUint32(g * 4 + 4)] : [ld.getUint16(g * 2) * 2, ld.getUint16(g * 2 + 2) * 2]; } catch { return [0, 0]; }
  };
  const read = (g: number, depth: number): Pt[][] => {
    const [a, z] = range(g);
    if (z <= a || z > glyf.length || depth > 8) return [];
    const nc = gd.getInt16(a);
    if (nc >= 0) {
      const ends: number[] = []; for (let i = 0; i < nc; i++) ends.push(gd.getUint16(a + 10 + i * 2));
      const np = nc ? ends[nc - 1] + 1 : 0;
      let p = a + 10 + nc * 2; const il = gd.getUint16(p); p += 2 + il;
      const flags: number[] = [];
      while (flags.length < np) { const f = glyf[p++]; flags.push(f); if (f & 8) { let r = glyf[p++]; while (r-- > 0) flags.push(f); } }
      const xs: number[] = [], ys: number[] = [];
      let v = 0;
      for (const f of flags) { if (f & 2) { const d = glyf[p++]; v += f & 16 ? d : -d; } else if (!(f & 16)) { v += gd.getInt16(p); p += 2; } xs.push(v); }
      v = 0;
      for (const f of flags) { if (f & 4) { const d = glyf[p++]; v += f & 32 ? d : -d; } else if (!(f & 32)) { v += gd.getInt16(p); p += 2; } ys.push(v); }
      const out: Pt[][] = []; let st = 0;
      for (const e of ends) { const c: Pt[] = []; for (let i = st; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) }); if (c.length) out.push(c); st = e + 1; }
      return out;
    }
    // Composite: its parts, moved and scaled.
    const out: Pt[][] = [];
    let p = a + 10; let more = true;
    while (more) {
      const f = gd.getUint16(p), gi = gd.getUint16(p + 2); p += 4;
      let dx = 0, dy = 0;
      if (f & 1) { dx = gd.getInt16(p); dy = gd.getInt16(p + 2); p += 4; } else { dx = gd.getInt8(p); dy = gd.getInt8(p + 1); p += 2; }
      if (!(f & 2)) { dx = 0; dy = 0; } // point matching: not supported, placed at the origin
      let m = [1, 0, 0, 1];
      const f2 = (o: number) => gd.getInt16(o) / 16384;
      if (f & 8) { const sc = f2(p); m = [sc, 0, 0, sc]; p += 2; }
      else if (f & 0x40) { m = [f2(p), 0, 0, f2(p + 2)]; p += 4; }
      else if (f & 0x80) { m = [f2(p), f2(p + 2), f2(p + 4), f2(p + 6)]; p += 8; }
      for (const c of read(gi, depth + 1)) out.push(c.map((q) => ({ x: Math.round(q.x * m[0] + q.y * m[2] + dx), y: Math.round(q.x * m[1] + q.y * m[3] + dy), on: q.on })));
      more = !!(f & 0x20);
    }
    return out;
  };
  return (g) => { try { return read(g, 0); } catch { return []; } };
}

/* ------------------------------------------------------------------ */
/* CFF outlines                                                        */
/* ------------------------------------------------------------------ */

type Index = { count: number; get(i: number): Uint8Array; end: number };
function readIndex(b: Uint8Array, at: number): Index {
  const dv = dvOf(b);
  const count = dv.getUint16(at);
  if (!count) return { count: 0, get: () => new Uint8Array(0), end: at + 2 };
  const os = b[at + 2];
  const off = (i: number) => { let v = 0; for (let k = 0; k < os; k++) v = v * 256 + b[at + 3 + i * os + k]; return v; };
  const base = at + 3 + (count + 1) * os - 1;
  return { count, get: (i) => b.subarray(base + off(i), base + off(i + 1)), end: base + off(count) };
}

function readDict(d: Uint8Array): Map<number, number[]> {
  const out = new Map<number, number[]>(); let ops: number[] = [];
  for (let i = 0; i < d.length;) {
    const b0 = d[i];
    if (b0 <= 21) {
      let op = b0; i++;
      if (b0 === 12) op = 1200 + d[i++];
      out.set(op, ops); ops = [];
    } else if (b0 === 28) { ops.push((d[i + 1] << 24 >> 16) | d[i + 2]); i += 3; }
    else if (b0 === 29) { ops.push((d[i + 1] << 24) | (d[i + 2] << 16) | (d[i + 3] << 8) | d[i + 4]); i += 5; }
    else if (b0 === 30) {
      let s = ''; i++;
      const nib = '0123456789.EE?-';
      outer: for (;;) { const v = d[i++]; for (const n of [v >> 4, v & 15]) { if (n === 15) break outer; s += n === 12 ? 'E-' : nib[n]; } }
      ops.push(parseFloat(s));
    } else if (b0 >= 32 && b0 <= 246) { ops.push(b0 - 139); i++; }
    else if (b0 >= 247 && b0 <= 250) { ops.push((b0 - 247) * 256 + d[i + 1] + 108); i += 2; }
    else if (b0 >= 251 && b0 <= 254) { ops.push(-(b0 - 251) * 256 - d[i + 1] - 108); i += 2; }
    else i++;
  }
  return out;
}

const bias = (n: number) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

type Cubic = { x: number; y: number; c?: [number, number, number, number] }; // point, with the two control points before it

function cffReader(s: Sfnt): { read: (gid: number) => Cubic[][]; upem: number } | null {
  const c = s.tables.get('CFF '); if (!c) return null;
  try {
    const hdr = c[2];
    const names = readIndex(c, hdr);
    const tops = readIndex(c, names.end);
    const strings = readIndex(c, tops.end);
    const gsubrs = readIndex(c, strings.end);
    const top = readDict(tops.get(0));
    const cs = readIndex(c, top.get(17)![0]);
    const fm = top.get(1207);
    const upem = fm && fm[0] ? Math.round(1 / fm[0]) : 1000;
    const privOf = (dict: Map<number, number[]>) => {
      const pv = dict.get(18); if (!pv) return { subrs: null as Index | null };
      const [size, off] = pv; const p = readDict(c.subarray(off, off + size));
      const sr = p.get(19);
      return { subrs: sr ? readIndex(c, off + sr[0]) : null };
    };
    let fdOf: (g: number) => { subrs: Index | null } = () => privOf(top);
    if (top.has(1236)) {
      const fda = readIndex(c, top.get(1236)![0]);
      const fds: { subrs: Index | null }[] = []; for (let i = 0; i < fda.count; i++) fds.push(privOf(readDict(fda.get(i))));
      const sel = top.get(1237)![0]; const fmt = c[sel];
      const sel0 = (g: number) => c[sel + 1 + g];
      const sel3 = (g: number) => { const dv = dvOf(c); const n = dv.getUint16(sel + 1); for (let k = 0; k < n; k++) { const first = dv.getUint16(sel + 3 + k * 3), next = dv.getUint16(sel + 3 + (k + 1) * 3); if (g >= first && g < next) return c[sel + 5 + k * 3]; } return 0; };
      fdOf = (g) => fds[(fmt === 0 ? sel0(g) : sel3(g)) ?? 0] ?? fds[0];
    } else { const p = privOf(top); fdOf = () => p; }

    const read = (gid: number): Cubic[][] => {
      if (gid >= cs.count) return [];
      const { subrs } = fdOf(gid);
      const contours: Cubic[][] = []; let cur: Cubic[] | null = null;
      let x = 0, y = 0, stems = 0, haveWidth = false; const st: number[] = [];
      const move = (dx: number, dy: number) => { x += dx; y += dy; cur = [{ x, y }]; contours.push(cur); };
      const line = (dx: number, dy: number) => { x += dx; y += dy; cur?.push({ x, y }); };
      const curve = (a: number, b: number, cc: number, d: number, e: number, f: number) => {
        const x1 = x + a, y1 = y + b, x2 = x1 + cc, y2 = y1 + d; x = x2 + e; y = y2 + f;
        cur?.push({ x, y, c: [x1, y1, x2, y2] });
      };
      let depth = 0;
      const run = (code: Uint8Array): boolean => {
        if (++depth > 12) return true;
        for (let i = 0; i < code.length;) {
          const b0 = code[i];
          if (b0 >= 32 || b0 === 28) {
            if (b0 === 28) { st.push((code[i + 1] << 24 >> 16) | code[i + 2]); i += 3; }
            else if (b0 <= 246) { st.push(b0 - 139); i++; }
            else if (b0 <= 250) { st.push((b0 - 247) * 256 + code[i + 1] + 108); i += 2; }
            else if (b0 <= 254) { st.push(-(b0 - 251) * 256 - code[i + 1] - 108); i += 2; }
            else { st.push(((code[i + 1] << 24) | (code[i + 2] << 16) | (code[i + 3] << 8) | code[i + 4]) / 65536); i += 5; }
            continue;
          }
          i++;
          const takeWidth = (even: boolean) => { if (!haveWidth) { haveWidth = true; if ((st.length % 2 === 1) === even) st.shift(); } };
          switch (b0) {
            case 1: case 3: case 18: case 23: takeWidth(true); stems += st.length >> 1; st.length = 0; break; // stems
            case 19: case 20: takeWidth(true); stems += st.length >> 1; st.length = 0; i += (stems + 7) >> 3; break; // hintmask
            case 21: takeWidth(true); move(st[0], st[1]); st.length = 0; break;
            case 22: takeWidth(false); move(st[0], 0); st.length = 0; break;
            case 4: takeWidth(false); move(0, st[0]); st.length = 0; break;
            case 5: for (let k = 0; k + 1 < st.length; k += 2) line(st[k], st[k + 1]); st.length = 0; break;
            case 6: case 7: { let hz = b0 === 6; for (const v of st) { if (hz) line(v, 0); else line(0, v); hz = !hz; } st.length = 0; break; }
            case 8: for (let k = 0; k + 5 < st.length; k += 6) curve(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]); st.length = 0; break;
            case 24: { let k = 0; for (; k + 5 < st.length - 2; k += 6) curve(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]); line(st[k], st[k + 1]); st.length = 0; break; }
            case 25: { let k = 0; for (; k + 1 < st.length - 6; k += 2) line(st[k], st[k + 1]); curve(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]); st.length = 0; break; }
            case 27: { let k = 0; let dy1 = 0; if (st.length % 2) dy1 = st[k++]; for (; k + 3 < st.length; k += 4) { curve(st[k], dy1, st[k + 1], st[k + 2], st[k + 3], 0); dy1 = 0; } st.length = 0; break; } // hhcurveto
            case 26: { let k = 0; let dx1 = 0; if (st.length % 2) dx1 = st[k++]; for (; k + 3 < st.length; k += 4) { curve(dx1, st[k], st[k + 1], st[k + 2], 0, st[k + 3]); dx1 = 0; } st.length = 0; break; } // vvcurveto
            case 30: case 31: {
              let hz = b0 === 31; let k = 0;
              while (k + 3 < st.length) {
                const last = st.length - k === 5;
                if (hz) curve(st[k], 0, st[k + 1], st[k + 2], last ? st[k + 4] : 0, st[k + 3]);
                else curve(0, st[k], st[k + 1], st[k + 2], st[k + 3], last ? st[k + 4] : 0);
                k += last ? 5 : 4; hz = !hz;
              }
              st.length = 0; break;
            }
            case 10: case 29: {
              const n = st.pop()!;
              const idx = b0 === 10 ? subrs : gsubrs;
              if (idx && idx.count) { const k = n + bias(idx.count); if (k >= 0 && k < idx.count && run(idx.get(k))) return true; }
              break;
            }
            case 11: depth--; return false;
            case 14: takeWidth(true); return true; // endchar (seac accents are not drawn)
            case 12: {
              const op = code[i++];
              if (op === 35) { curve(st[0], st[1], st[2], st[3], st[4], st[5]); curve(st[6], st[7], st[8], st[9], st[10], st[11]); }
              else if (op === 34) { const y0 = y; curve(st[0], 0, st[1], st[2], st[3], 0); curve(st[4], 0, st[5], y0 - y, st[6], 0); }
              else if (op === 36) { const y0 = y; curve(st[0], st[1], st[2], st[3], st[4], 0); curve(st[5], 0, st[6], st[7], st[8], y0 - y - st[7]); }
              else if (op === 37) {
                const x0 = x, y0 = y; let dx = 0, dy = 0; for (let k = 0; k < 10; k += 2) { dx += st[k]; dy += st[k + 1]; }
                curve(st[0], st[1], st[2], st[3], st[4], st[5]);
                if (Math.abs(dx) > Math.abs(dy)) curve(st[6], st[7], st[8], st[9], st[10], y0 - y - st[7] - st[9]);
                else curve(st[6], st[7], st[8], st[9], x0 - x - st[6] - st[8], st[10]);
              }
              st.length = 0; break;
            }
            default: st.length = 0;
          }
        }
        depth--; return false;
      };
      run(cs.get(gid));
      return contours.filter((k) => k.length > 1);
    };
    return { read, upem };
  } catch { return null; }
}

/** A cubic curve as quadratic pieces (control, end), within `tol` font units. */
function cubicToQuads(p0: [number, number], p1: [number, number], p2: [number, number], p3: [number, number], tol: number): [number, number][][] {
  const at = (t: number, a: number, b: number, c: number, d: number) => { const u = 1 - t; return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d; };
  for (let n = 1; n <= 16; n++) {
    const segs: [number, number][][] = []; let ok = true;
    for (let i = 0; i < n && ok; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      // The piece of the cubic between t0 and t1, as its own cubic (end points and derivatives).
      const P = (t: number): [number, number] => [at(t, p0[0], p1[0], p2[0], p3[0]), at(t, p0[1], p1[1], p2[1], p3[1])];
      const D = (t: number): [number, number] => { const u = 1 - t; return [3 * (u * u * (p1[0] - p0[0]) + 2 * u * t * (p2[0] - p1[0]) + t * t * (p3[0] - p2[0])), 3 * (u * u * (p1[1] - p0[1]) + 2 * u * t * (p2[1] - p1[1]) + t * t * (p3[1] - p2[1]))]; };
      const s = P(t0), e = P(t1), ds = D(t0), de = D(t1), h = (t1 - t0) / 3;
      const c1: [number, number] = [s[0] + ds[0] * h, s[1] + ds[1] * h], c2: [number, number] = [e[0] - de[0] * h, e[1] - de[1] * h];
      const q: [number, number] = [(3 * (c1[0] + c2[0]) - s[0] - e[0]) / 4, (3 * (c1[1] + c2[1]) - s[1] - e[1]) / 4];
      for (const t of [0.25, 0.5, 0.75]) {
        const cx = at(t, s[0], c1[0], c2[0], e[0]), cy = at(t, s[1], c1[1], c2[1], e[1]);
        const u = 1 - t; const qx = u * u * s[0] + 2 * u * t * q[0] + t * t * e[0], qy = u * u * s[1] + 2 * u * t * q[1] + t * t * e[1];
        if (Math.hypot(cx - qx, cy - qy) > tol) { ok = false; break; }
      }
      segs.push([q, e]);
    }
    if (ok || n === 16) return segs;
  }
  return [];
}

function cubicToTT(contours: Cubic[][], tol: number): Pt[][] {
  const out: Pt[][] = [];
  for (const c of contours) {
    const pts: Pt[] = [];
    let px = c[0].x, py = c[0].y;
    pts.push({ x: px, y: py, on: true });
    for (let i = 1; i < c.length; i++) {
      const p = c[i];
      if (p.c) {
        for (const [q, e] of cubicToQuads([px, py], [p.c[0], p.c[1]], [p.c[2], p.c[3]], [p.x, p.y], tol)) {
          pts.push({ x: q[0], y: q[1], on: false }, { x: e[0], y: e[1], on: true });
        }
      } else pts.push({ x: p.x, y: p.y, on: true });
      px = p.x; py = p.y;
    }
    // A closing point on the start is dropped (TrueType contours close themselves).
    const l = pts[pts.length - 1];
    if (pts.length > 1 && l.on && Math.abs(l.x - pts[0].x) < 0.5 && Math.abs(l.y - pts[0].y) < 0.5) pts.pop();
    // PostScript outlines turn the other way round: TrueType fills clockwise outer contours.
    pts.reverse();
    if (pts.length > 2) out.push(pts);
  }
  return out;
}

/** Outlines of a pdf.js-made font, in its own units. */
export function debugCff(s: Sfnt, gid: number) { return cffReader(s)?.read(gid); }
export function glyphReader(s: Sfnt): { outline: (gid: number) => Outline; upem: number } {
  const upem = unitsPerEm(s);
  const adv = advances(s);
  if (s.cff) {
    const r = cffReader(s);
    if (r) return { upem: r.upem || upem, outline: (g) => ({ contours: cubicToTT(r.read(g), Math.max(0.5, (r.upem || upem) / 1000)), adv: adv(g) * ((r.upem || upem) / upem) }) };
    return { upem, outline: (g) => ({ contours: [], adv: adv(g) }) };
  }
  const tt = ttOutlineReader(s);
  return { upem, outline: (g) => ({ contours: tt(g), adv: adv(g) }) };
}

/* ------------------------------------------------------------------ */
/* Writing a TrueType font                                             */
/* ------------------------------------------------------------------ */

export type FontMeta = { family: string; bold?: boolean; italic?: boolean; upem: number; asc?: number; desc?: number };

function encodeGlyph(cs: Pt[][]): { bytes: Uint8Array; box: [number, number, number, number]; pts: number } {
  const pts = cs.flat();
  if (!pts.length) return { bytes: new Uint8Array(0), box: [0, 0, 0, 0], pts: 0 };
  const xs = pts.map((p) => Math.round(p.x)), ys = pts.map((p) => Math.round(p.y));
  const box: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const head: number[] = [];
  const u16 = (a: number[], v: number) => a.push((v >> 8) & 255, v & 255);
  u16(head, cs.length); for (const v of box) u16(head, v & 0xffff);
  let end = -1; for (const c of cs) { end += c.length; u16(head, end); }
  u16(head, 0); // no instructions
  const flags: number[] = [], xb: number[] = [], yb: number[] = [];
  let lx = 0, ly = 0;
  pts.forEach((p, i) => {
    let f = p.on ? 1 : 0;
    const dx = xs[i] - lx, dy = ys[i] - ly; lx = xs[i]; ly = ys[i];
    if (dx === 0) f |= 16; else if (Math.abs(dx) < 256) { f |= 2; if (dx > 0) f |= 16; xb.push(Math.abs(dx)); } else u16(xb, dx & 0xffff);
    if (dy === 0) f |= 32; else if (Math.abs(dy) < 256) { f |= 4; if (dy > 0) f |= 32; yb.push(Math.abs(dy)); } else u16(yb, dy & 0xffff);
    flags.push(f);
  });
  const all = [...head, ...flags, ...xb, ...yb];
  while (all.length % 2) all.push(0);
  return { bytes: new Uint8Array(all), box, pts: pts.length };
}

function nameTable(family: string, sub: string): Uint8Array {
  const ps = `${family}-${sub}`.replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) || 'KurokawaFont';
  const recs: [number, string][] = [[1, family], [2, sub], [3, `${family} ${sub}; Kurokawa`], [4, sub === 'Regular' ? family : `${family} ${sub}`], [6, ps]];
  const enc = (s: string) => { const a: number[] = []; for (const ch of s) { const c = ch.codePointAt(0)!; if (c > 0xffff) { const v = c - 0x10000; a.push(0xd8 + (v >> 18), (v >> 10) & 255, 0xdc + ((v >> 8) & 3), v & 255); } else a.push(c >> 8, c & 255); } return a; };
  const data: number[] = []; const head: number[] = [];
  const u16 = (a: number[], v: number) => a.push((v >> 8) & 255, v & 255);
  u16(head, 0); u16(head, recs.length); u16(head, 6 + recs.length * 12);
  for (const [id, s] of recs) { const b = enc(s); u16(head, 3); u16(head, 1); u16(head, 0x409); u16(head, id); u16(head, b.length); u16(head, data.length); data.push(...b); }
  return new Uint8Array([...head, ...data]);
}

/** Writes a TrueType font: glyph 0 is .notdef; `extra` are ready tables (cmap, GSUB, GPOS, GDEF, OS/2…). */
export function writeTrueType(meta: FontMeta, glyphs: Outline[], extra: Map<string, Uint8Array>, os2: (box: [number, number, number, number], avg: number) => Uint8Array): Uint8Array {
  const enc = glyphs.map((g) => encodeGlyph(g.contours));
  const glyfLen = enc.reduce((n, e) => n + e.bytes.length, 0);
  const glyf = new Uint8Array(glyfLen); const loca = new Uint8Array((glyphs.length + 1) * 4); const ld = dvOf(loca);
  let off = 0; enc.forEach((e, i) => { ld.setUint32(i * 4, off); glyf.set(e.bytes, off); off += e.bytes.length; }); ld.setUint32(glyphs.length * 4, off);
  const nonEmpty = enc.filter((e) => e.pts);
  const box: [number, number, number, number] = nonEmpty.length ? [Math.min(...nonEmpty.map((e) => e.box[0])), Math.min(...nonEmpty.map((e) => e.box[1])), Math.max(...nonEmpty.map((e) => e.box[2])), Math.max(...nonEmpty.map((e) => e.box[3]))] : [0, 0, 0, 0];
  const n = glyphs.length;
  const hmtx = new Uint8Array(n * 4); const hd = dvOf(hmtx);
  glyphs.forEach((g, i) => { hd.setUint16(i * 4, Math.max(0, Math.round(g.adv))); hd.setInt16(i * 4 + 2, enc[i].pts ? enc[i].box[0] : 0); });
  const head = new Uint8Array(54); const h = dvOf(head);
  h.setUint32(0, 0x00010000); h.setUint32(4, 0x00010000); h.setUint32(12, 0x5f0f3cf5); h.setUint16(16, 0x000b); h.setUint16(18, meta.upem);
  h.setInt16(36, box[0]); h.setInt16(38, box[1]); h.setInt16(40, box[2]); h.setInt16(42, box[3]);
  h.setUint16(44, (meta.bold ? 1 : 0) | (meta.italic ? 2 : 0)); h.setUint16(46, 8); h.setInt16(48, 2); h.setInt16(50, 1);
  const asc = Math.round(meta.asc ?? Math.max(box[3], meta.upem * 0.8)), desc = Math.round(meta.desc ?? Math.min(box[1], -meta.upem * 0.2));
  const hhea = new Uint8Array(36); const hh = dvOf(hhea);
  hh.setUint32(0, 0x00010000); hh.setInt16(4, asc); hh.setInt16(6, desc); hh.setInt16(8, 0);
  hh.setUint16(10, Math.max(0, ...glyphs.map((g) => Math.round(g.adv)))); hh.setInt16(12, box[0]); hh.setInt16(14, 0); hh.setInt16(16, box[2]);
  hh.setInt16(18, 1); hh.setUint16(34, n);
  const maxp = new Uint8Array(32); const mp = dvOf(maxp);
  mp.setUint32(0, 0x00010000); mp.setUint16(4, n);
  mp.setUint16(6, Math.max(0, ...enc.map((e) => e.pts))); mp.setUint16(8, Math.max(0, ...glyphs.map((g) => g.contours.length)));
  mp.setUint16(14, 2);
  const post = new Uint8Array(32); dvOf(post).setUint32(0, 0x00030000); dvOf(post).setInt16(8, -Math.round(meta.upem * 0.1)); dvOf(post).setInt16(10, Math.round(meta.upem * 0.05));
  const used = glyphs.map((g) => g.adv).filter((a) => a > 0);
  const tables = new Map<string, Uint8Array>([['head', head], ['hhea', hhea], ['maxp', maxp], ['hmtx', hmtx], ['loca', loca], ['glyf', glyf], ['post', post], ['name', nameTable(meta.family, meta.bold && meta.italic ? 'Bold Italic' : meta.bold ? 'Bold' : meta.italic ? 'Italic' : 'Regular')]]);
  tables.set('OS/2', os2(box, used.length ? Math.round(used.reduce((a, b) => a + b, 0) / used.length) : meta.upem / 2));
  for (const [k, v] of extra) tables.set(k, v);
  return writeSfnt(tables);
}

export function writeSfnt(tables: Map<string, Uint8Array>): Uint8Array {
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
