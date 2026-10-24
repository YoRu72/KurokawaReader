// Document scanning on photos: find the page (its four corners), straighten it into a flat rectangle, even out
// the light and clean it up. Pure image arithmetic on RGBA buffers, so it runs the same in the app and in tests.

export type Img = { data: Uint8ClampedArray; width: number; height: number };
export type Pt = { x: number; y: number };
/** Corners in the photo: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];
export type Filter = 'original' | 'auto' | 'color' | 'gray' | 'bw';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/* ---------------------------------------------------------------- small images */

/** The photo shrunk (box average) so its long side is at most `max`, as luminance and saturation planes. */
function small(img: Img, max: number): { w: number; h: number; k: number; L: Float32Array; S: Float32Array; R: Float32Array; G: Float32Array; B: Float32Array } {
  const k = Math.max(1, Math.max(img.width, img.height) / max);
  const w = Math.max(1, Math.round(img.width / k)), h = Math.max(1, Math.round(img.height / k));
  const R = new Float32Array(w * h), G = new Float32Array(w * h), B = new Float32Array(w * h), N = new Float32Array(w * h);
  const d = img.data, W = img.width;
  for (let y = 0; y < img.height; y++) {
    const sy = Math.min(h - 1, Math.floor(y / k));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.floor(x / k)), i = (y * W + x) * 4, j = sy * w + sx;
      R[j] += d[i]; G[j] += d[i + 1]; B[j] += d[i + 2]; N[j]++;
    }
  }
  const L = new Float32Array(w * h), S = new Float32Array(w * h);
  for (let j = 0; j < w * h; j++) {
    const n = N[j] || 1; R[j] /= n; G[j] /= n; B[j] /= n;
    L[j] = 0.299 * R[j] + 0.587 * G[j] + 0.114 * B[j];
    S[j] = Math.max(R[j], G[j], B[j]) - Math.min(R[j], G[j], B[j]);
  }
  return { w, h, k, L, S, R, G, B };
}

/** Two thresholds splitting values into three classes (dark background, paper in shadow, lit paper). */
function otsu3(v: Float32Array, lo: number, hi: number): [number, number] {
  const bins = 64, hist = new Float64Array(bins); const span = hi - lo || 1;
  for (const x of v) hist[clamp(Math.floor(((x - lo) / span) * (bins - 1)), 0, bins - 1)]++;
  const P = new Float64Array(bins + 1), M = new Float64Array(bins + 1);
  for (let i = 0; i < bins; i++) { P[i + 1] = P[i] + hist[i]; M[i + 1] = M[i] + i * hist[i]; }
  const cls = (a: number, b: number) => { const p = P[b] - P[a]; if (!p) return 0; const m = (M[b] - M[a]) / p; return p * m * m; };
  let best = -1, ta = 1, tb = 2;
  for (let a = 1; a < bins - 1; a++) for (let b = a + 1; b < bins; b++) { const v2 = cls(0, a) + cls(a, b) + cls(b, bins); if (v2 > best) { best = v2; ta = a; tb = b; } }
  return [lo + (ta / (bins - 1)) * span, lo + (tb / (bins - 1)) * span];
}

function otsu(v: Float32Array, lo: number, hi: number): number {
  const bins = 256, hist = new Float64Array(bins); const span = hi - lo || 1;
  for (const x of v) hist[clamp(Math.floor(((x - lo) / span) * (bins - 1)), 0, bins - 1)]++;
  let total = 0, sum = 0; for (let i = 0; i < bins; i++) { total += hist[i]; sum += i * hist[i]; }
  let wB = 0, sB = 0, best = 0, at = bins / 2;
  for (let i = 0; i < bins; i++) {
    wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF; const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; at = i; }
  }
  return lo + (at / (bins - 1)) * span;
}

/* ---------------------------------------------------------------- geometry */

function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = []; for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper: Pt[] = []; for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

const area = (q: Pt[]) => { let a = 0; for (let i = 0; i < q.length; i++) { const p = q[i], r = q[(i + 1) % q.length]; a += p.x * r.y - r.x * p.y; } return Math.abs(a) / 2; };

/** A convex polygon cut down to four corners (each time dropping the corner that adds least area). */
function toQuad(poly: Pt[]): Pt[] {
  const p = [...poly];
  while (p.length > 4) {
    let best = 0, bestA = Infinity;
    for (let i = 0; i < p.length; i++) { const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length]; const t = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2; if (t < bestA) { bestA = t; best = i; } }
    p.splice(best, 1);
  }
  return p;
}

/** Four corners put in order: top-left, top-right, bottom-right, bottom-left. */
export function orderQuad(q: Pt[]): Quad {
  const c = { x: q.reduce((s, p) => s + p.x, 0) / q.length, y: q.reduce((s, p) => s + p.y, 0) / q.length };
  const s = [...q].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  // (Sorted by angle from the centre, y down: starts near the top-left going clockwise once rotated to it.)
  let tl = 0; for (let i = 1; i < 4; i++) if (s[i].x + s[i].y < s[tl].x + s[tl].y) tl = i;
  return [s[tl], s[(tl + 1) % 4], s[(tl + 2) % 4], s[(tl + 3) % 4]];
}

function lineX(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / den;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/* ---------------------------------------------------------------- finding the page */

export type Found = { quad: Quad; how: 'shape' | 'edges' | 'frame'; score: number };

/** Grey-level closing (largest then smallest value over a square of radius `r`): dark marks thinner than the
 *  square — print, ruled and printed lines, a pen — vanish into the paper around them; large regions keep their
 *  edges where they were. */
function closeGray(v: Float32Array, w: number, h: number, r: number): Float32Array {
  // Largest / smallest over a sliding window in a few steps per value whatever its width (van Herk–Gil–Werman):
  // the running extreme from each block's start, and to each block's end, meet at the window.
  const k = 2 * r + 1, L = Math.max(w, h) + 2 * r + k;
  const line = new Float32Array(L), g = new Float32Array(L), hh = new Float32Array(L);
  const pass = (src: Float32Array, horiz: boolean, max: boolean) => {
    const out = new Float32Array(w * h);
    const n = horiz ? w : h, m = horiz ? h : w, step = horiz ? 1 : w, stride = horiz ? w : 1;
    const pad = max ? -Infinity : Infinity;
    const len = n + 2 * r;
    for (let j = 0; j < m; j++) {
      const base = j * stride;
      for (let i = 0; i < r; i++) { line[i] = pad; line[r + n + i] = pad; }
      for (let i = 0; i < n; i++) line[r + i] = src[base + i * step];
      for (let s0 = 0; s0 < len; s0 += k) {
        const e = Math.min(len, s0 + k) - 1;
        g[s0] = line[s0]; for (let i = s0 + 1; i <= e; i++) { const a = g[i - 1], b = line[i]; g[i] = max ? (a > b ? a : b) : (a < b ? a : b); }
        hh[e] = line[e]; for (let i = e - 1; i >= s0; i--) { const a = hh[i + 1], b = line[i]; hh[i] = max ? (a > b ? a : b) : (a < b ? a : b); }
      }
      for (let i = 0; i < n; i++) {
        // Window [i, i + 2r] in padded coordinates.
        const a = hh[i], b = g[i + 2 * r];
        out[base + i * step] = max ? (a > b ? a : b) : (a < b ? a : b);
      }
    }
    return out;
  };
  return pass(pass(pass(pass(v, true, true), false, true), true, false), false, false);
}

function blur3(v: Float32Array, w: number, h: number): Float32Array {
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, c = 0; for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s += v[yy * w + xx]; c++; } } o[y * w + x] = s / c; }
  return o;
}

/** Edges of the photo with print removed: strength, direction (of the gradient) and thin edge pixels. */
type Edges = { w: number; h: number; mag: Float32Array; ang: Float32Array; on: Uint8Array; Lc: Float32Array; c1: Float32Array; c2: Float32Array };
function edgesOf(sm: ReturnType<typeof small>): Edges {
  const { w, h } = sm, n = w * h;
  const r = Math.max(2, Math.round(Math.min(w, h) / 90));
  const Lc = blur3(closeGray(sm.L, w, h, r), w, h);
  // Colour too: a page on a table of the same lightness but another colour.
  const C1 = new Float32Array(n), C2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { C1[i] = sm.R[i] - sm.G[i]; C2[i] = (sm.R[i] + sm.G[i]) / 2 - sm.B[i]; }
  const c1 = blur3(closeGray(C1, w, h, r), w, h), c2 = blur3(closeGray(C2, w, h, r), w, h);
  const mag = new Float32Array(n), ang = new Float32Array(n);
  // (Sobel on the three planes, the strongest kept: written out, as this runs for every pixel.)
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    let bx = 0, by = 0, bm = -1;
    for (let p = 0; p < 3; p++) {
      const v = p === 0 ? Lc : p === 1 ? c1 : c2;
      const a = v[i - w - 1], b = v[i - w], c = v[i - w + 1], d = v[i - 1], f = v[i + 1], g = v[i + w - 1], hh = v[i + w], k = v[i + w + 1];
      const gx = c + 2 * f + k - a - 2 * d - g, gy = g + 2 * hh + k - a - 2 * b - c;
      const m2 = (gx * gx + gy * gy) * (p === 0 ? 1 : 0.81);
      if (m2 > bm) { bm = m2; bx = gx; by = gy; }
    }
    mag[i] = Math.sqrt(bm); ang[i] = Math.atan2(by, bx);
  }
  // Thin edges: only the strongest point across each edge (non-maximum suppression), above a floor set by
  // how strong the photo's edges are.
  const vals: number[] = []; for (let i = 0; i < n; i += 7) if (mag[i] > 4) vals.push(mag[i]);
  vals.sort((a, b) => a - b);
  const thr = Math.max(14, (vals[Math.floor(vals.length * 0.97)] ?? 0) * 0.18);
  const on = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, m = mag[i]; if (m < thr) continue;
    const a = ((ang[i] * 180) / Math.PI + 180) % 180;
    const o = a < 22.5 || a >= 157.5 ? 1 : a < 67.5 ? w + 1 : a < 112.5 ? w : w - 1;
    if (m >= mag[i - o] && m >= mag[i + o]) on[i] = 1;
  }
  return { w, h, mag, ang, on, Lc, c1, c2 };
}

/**
 * How well a quadrilateral follows the photo's edges: the share of its sides along which there is an edge running
 * the side's way (sides lying on the photo's border — a page that goes past it — count half), weighted towards
 * larger quads; sides with paper on both sides (a line printed on the page) do not count.
 */
function quadScore(E: Edges, q: Pt[]): number {
  const { w, h, on, ang, Lc, c1, c2 } = E;
  let sum = 0, weak = 0, steps = 0, inside = 0;
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  for (let e = 0; e < 4; e++) {
    const a = q[e], b = q[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
    const sgn = (cx - (a.x + b.x) / 2) * nx + (cy - (a.y + b.y) / 2) * ny > 0 ? 1 : -1;
    const sideAng = Math.atan2(ny, nx);
    const N = Math.max(12, Math.min(80, Math.round(len / 3)));
    let hit = 0, cnt = 0, border = 0, din = 0, dout = 0, dc = 0, ain = 0, aout = 0, bin = 0, bout = 0;
    for (let k = 0; k <= N; k++) {
      const t = 0.04 + (0.92 * k) / N;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      if (x < 2 || y < 2 || x > w - 3 || y > h - 3) { border++; continue; }
      cnt++;
      let ok = 0;
      for (let d = -2; d <= 2 && !ok; d++) {
        const xx = Math.round(x + nx * d), yy = Math.round(y + ny * d);
        if (xx < 1 || yy < 1 || xx >= w - 1 || yy >= h - 1) continue;
        const i = yy * w + xx; if (!on[i]) continue;
        let da = Math.abs(ang[i] - sideAng) % Math.PI; if (da > Math.PI / 2) da = Math.PI - da;
        if (da < 0.38) ok = 1;
      }
      hit += ok;
      const off = 4;
      const xi = Math.round(x + sgn * nx * off), yi = Math.round(y + sgn * ny * off), xo = Math.round(x - sgn * nx * off), yo = Math.round(y - sgn * ny * off);
      if (xo >= 0 && yo >= 0 && xo < w && yo < h && xi >= 0 && yi >= 0 && xi < w && yi < h) { const ii = yi * w + xi, oo = yo * w + xo; din += Lc[ii]; dout += Lc[oo]; ain += c1[ii]; aout += c1[oo]; bin += c2[ii]; bout += c2[oo]; dc++; }
    }
    const total = cnt + border;
    if (border > total * 0.6) { sum += 0.5; continue; } // along the photo's edge: the page goes on past it
    const cov = cnt ? hit / cnt : 0;
    sum += cov; if (cov < 0.35) weak++;
    // A sheet's edge: paper on one side, something else on the other — clearly lighter or darker, or another colour.
    // (A line printed on the page, a column rule, has paper on both sides.)
    if (dc > 4) { inside++; if (Math.max(Math.abs(din - dout), 0.8 * Math.abs(ain - aout), 0.8 * Math.abs(bin - bout)) / dc > 8) steps++; }
  }
  if (inside >= 2 && steps < inside - 1) return 0;
  const A = area(q) / (w * h);
  return (sum / 4) * (weak ? 0.6 ** weak : 1) * (0.55 + 0.45 * Math.sqrt(Math.min(1, A)));
}

/** The page in a photo. When nothing stands out from its surroundings (a page that fills the frame) the whole
 *  photo is the page. */
export function detectPage(img: Img, debug?: (c: Found[]) => void): Found {
  const sm = small(img, 480);
  const full: Quad = [{ x: 0, y: 0 }, { x: img.width, y: 0 }, { x: img.width, y: img.height }, { x: 0, y: img.height }];
  const up = (q: Pt[]): Quad => orderQuad(q.map((p) => ({ x: clamp(p.x * sm.k, 0, img.width), y: clamp(p.y * sm.k, 0, img.height) })));
  const E = edgesOf(sm);
  // (The paper's shape is looked for with the print taken off it: a page of dense text is still one bright sheet.)
  const byShape = shapeQuad({ ...sm, L: E.Lc });
  const byEdges = edgeQuad(E);
  const cands: Found[] = [];
  const frac = (q: Pt[]) => area(q) / (sm.w * sm.h);
  if (byShape) cands.push({ quad: up(byShape.q), how: 'shape', score: Math.max(quadScore(E, byShape.q), byShape.score >= 0.9 && frac(byShape.q) < 0.95 ? 0.5 : 0) });
  if (byEdges) cands.push({ quad: up(byEdges.q), how: 'edges', score: byEdges.score });
  debug?.(cands);
  // A page seen in perspective still has no corner much sharper or flatter than a right angle.
  const sane = (q: Pt[]) => q.every((p, i) => { const a = q[(i + 3) % 4], b = q[(i + 1) % 4]; const ax = a.x - p.x, ay = a.y - p.y, bx = b.x - p.x, by = b.y - p.y; const c = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1); return Math.abs(c) < 0.72; }) && (() => { const w1 = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y), h1 = Math.hypot(q[3].x - q[0].x, q[3].y - q[0].y) + Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y); return Math.min(w1, h1) / Math.max(w1, h1) > 0.2; })();
  const good = cands.filter((c) => { const f = area(c.quad) / (img.width * img.height); return c.score > 0.42 && f > 0.08 && f < 0.97 && sane(c.quad); });
  if (!good.length) return { quad: full, how: 'frame', score: 0 };
  good.sort((a, b) => b.score - a.score);
  return good[0];
}

/** The paper as the largest bright, colourless region; its outline cut down to four corners. */
function shapeQuad(sm: ReturnType<typeof small>): { q: Pt[]; score: number } | null {
  const { w, h, L, S } = sm; const n = w * h;
  const score = new Float32Array(n); let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const v = L[i] - 1.2 * S[i]; score[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
  // (Three classes: the background is the darkest; paper in shadow still counts as paper.)
  const [t1, t2] = otsu3(score, lo, hi);
  let thr = t1;
  { let a = 0, na = 0, b = 0, nb = 0; for (let i = 0; i < n; i++) { if (score[i] <= t1) { a += score[i]; na++; } else if (score[i] > t2) { b += score[i]; nb++; } } if (!na || !nb || b / nb - a / na < 60) thr = otsu(score, lo, hi); }
  // Paper must clearly be the brighter part.
  let mIn = 0, nIn = 0, mOut = 0, nOut = 0;
  for (let i = 0; i < n; i++) if (score[i] > thr) { mIn += score[i]; nIn++; } else { mOut += score[i]; nOut++; }
  if (!nIn || !nOut || mIn / nIn - mOut / nOut < 40) return null;
  let mask = new Uint8Array(n); for (let i = 0; i < n; i++) mask[i] = score[i] > thr ? 1 : 0;
  // Close small gaps (text on the page), then open away specks.
  const morph = (m: Uint8Array, dilate: boolean) => { const o = new Uint8Array(n); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = dilate ? 0 : 1; for (let dy = -1; dy <= 1 && (dilate ? !v : v); dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue; const q = m[yy * w + xx]; if (dilate && q) { v = 1; break; } if (!dilate && !q) { v = 0; break; } } o[y * w + x] = v; } return o; };
  for (let i = 0; i < 2; i++) mask = morph(mask, true); for (let i = 0; i < 2; i++) mask = morph(mask, false);
  for (let i = 0; i < 2; i++) mask = morph(mask, false); for (let i = 0; i < 2; i++) mask = morph(mask, true);
  // Something bright touching the page (a plate, a second sheet) joins it only by a thin neck: the largest
  // region is taken from the mask worn down, then grown back within the mask.
  const full = mask;
  const k = Math.max(3, Math.round(Math.min(w, h) / 70));
  for (let i = 0; i < k; i++) mask = morph(mask, false);
  // Largest region.
  const lab = new Int32Array(n).fill(-1); let bestId = -1, bestN = 0; const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!mask[s] || lab[s] >= 0) continue;
    let cnt = 0; stack.push(s); lab[s] = s;
    while (stack.length) { const i = stack.pop()!; cnt++; const x = i % w, y = (i / w) | 0; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && mask[j] && lab[j] < 0) { lab[j] = s; stack.push(j); } }
    if (cnt > bestN) { bestN = cnt; bestId = s; }
  }
  if (bestN < n * 0.04) return null;
  {
    let sel = new Uint8Array(n); for (let i = 0; i < n; i++) sel[i] = lab[i] === bestId ? 1 : 0;
    for (let i = 0; i < k + 1; i++) { sel = morph(sel, true); for (let j = 0; j < n; j++) sel[j] &= full[j]; }
    bestN = 0; for (let i = 0; i < n; i++) { lab[i] = sel[i] ? bestId : -1; bestN += sel[i]; }
  }
  if (bestN < n * 0.1) return null;
  const pts: Pt[] = [];
  for (let y = 0; y < h; y++) { let a = -1, b = -1; for (let x = 0; x < w; x++) if (lab[y * w + x] === bestId) { if (a < 0) a = x; b = x; } if (a >= 0) { pts.push({ x: a, y }, { x: b + 1, y }, { x: a, y: y + 1 }, { x: b + 1, y: y + 1 }); } }
  const hl = hull(pts); let q = toQuad(hl);
  if (q.length < 4) return null;
  q = refineSides(lab, bestId, w, h, q);
  const qa = area(q);
  const fill = bestN / Math.max(1, qa);          // a page is a solid quadrilateral
  const fitHull = area(hl) / Math.max(1, qa);    // and its outline is four straight sides
  return { q, score: Math.min(1, fill) * Math.min(1, fitHull) * (fill > 0.82 ? 1 : 0.5) };
}

/**
 * The quadrilateral's sides fitted again to the region's outline, each as the straight line most of its
 * nearby outline follows (RANSAC): something covering part of the page, or lying across a corner, bends the
 * hull, not the page's edges — and a corner hidden under it is where those edges meet.
 */
function refineSides(lab: Int32Array, id: number, w: number, h: number, q: Pt[]): Pt[] {
  const bnd: Pt[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (lab[i] !== id) continue;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || lab[i - 1] !== id || lab[i + 1] !== id || lab[i - w] !== id || lab[i + w] !== id) bnd.push({ x: x + 0.5, y: y + 0.5 });
  }
  const tol = Math.min(w, h) * 0.08;
  const segD = (p: Pt, a: Pt, b: Pt) => { const dx = b.x - a.x, dy = b.y - a.y; const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1); return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); };
  type L = { px: number; py: number; dx: number; dy: number };
  let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
  const lines: L[] = [];
  for (let e = 0; e < 4; e++) {
    const a = q[e], b = q[(e + 1) % 4]; const len = Math.hypot(b.x - a.x, b.y - a.y);
    const near = bnd.filter((p) => { const d = segD(p, a, b); if (d > tol) return false; for (let f = 0; f < 4; f++) if (f !== e && segD(p, q[f], q[(f + 1) % 4]) < d) return false; return true; });
    const fallback: L = { px: a.x, py: a.y, dx: (b.x - a.x) / (len || 1), dy: (b.y - a.y) / (len || 1) };
    if (near.length < len * 0.3) { lines.push(fallback); continue; }
    let best: Pt[] = [];
    for (let it = 0; it < 150; it++) {
      const p1 = near[(rnd() * near.length) | 0], p2 = near[(rnd() * near.length) | 0];
      const dx = p2.x - p1.x, dy = p2.y - p1.y, l = Math.hypot(dx, dy); if (l < len * 0.15) continue;
      // (Close to the old side's direction: within ~25°.)
      if (Math.abs(dx * fallback.dy - dy * fallback.dx) / l > 0.42) continue;
      const inl = near.filter((p) => Math.abs((p.x - p1.x) * dy - (p.y - p1.y) * dx) / l < 1.5);
      if (inl.length > best.length) best = inl;
    }
    if (best.length < len * 0.3) { lines.push(fallback); continue; }
    // Least squares (principal direction) through the inliers.
    let mx = 0, my = 0; for (const p of best) { mx += p.x; my += p.y; } mx /= best.length; my /= best.length;
    let sxx = 0, sxy = 0, syy = 0; for (const p of best) { const u = p.x - mx, v = p.y - my; sxx += u * u; sxy += u * v; syy += v * v; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    lines.push({ px: mx, py: my, dx: Math.cos(th), dy: Math.sin(th) });
  }
  const meet = (l1: L, l2: L): Pt | null => { const den = l1.dx * l2.dy - l1.dy * l2.dx; if (Math.abs(den) < 0.2) return null; const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den; return { x: l1.px + t * l1.dx, y: l1.py + t * l1.dy }; };
  const out: Pt[] = [];
  for (let e = 0; e < 4; e++) { const c = meet(lines[(e + 3) % 4], lines[e]); if (!c || c.x < -w * 0.1 || c.y < -h * 0.1 || c.x > w * 1.1 || c.y > h * 1.1) return q; out.push({ x: clamp(c.x, 0, w), y: clamp(c.y, 0, h) }); }
  // Still a convex quadrilateral about as large as before.
  let sg = 0; for (let e = 0; e < 4; e++) { const a = out[e], b = out[(e + 1) % 4], c = out[(e + 2) % 4]; const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x); if (!sg) sg = Math.sign(cr); else if (Math.sign(cr) !== sg) return q; }
  const r = area(out) / Math.max(1, area(q)); return r > 0.7 && r < 1.3 ? out : q;
}

/** The page as four straight edges in the photo (Hough lines on the edges left once print is removed), the
 *  quadrilateral of them that its edges follow best. */
function edgeQuad(E: Edges): { q: Pt[]; score: number } | null {
  const { w, h, on, ang } = E;
  const D = Math.ceil(Math.hypot(w, h)); const T = 180; const R = 2 * D + 1; const acc = new Int32Array(T * R);
  const cs = Array.from({ length: T }, (_, t) => Math.cos((t * Math.PI) / 180)), sn = Array.from({ length: T }, (_, t) => Math.sin((t * Math.PI) / 180));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!on[i]) continue;
    // Only the angles near the gradient's direction vote (an edge pixel lies on a line across its gradient).
    const a = Math.round(((ang[i] * 180) / Math.PI + 360) % 180);
    for (let d = -6; d <= 6; d++) { const t = (a + d + 180) % 180; const r = Math.round(x * cs[t] + y * sn[t]) + D; acc[t * R + r]++; }
  }
  type Line = { t: number; r: number; v: number };
  const peaks: Line[] = [];
  const minVotes = Math.min(w, h) * 0.1;
  for (let t = 0; t < T; t++) for (let r = 0; r < R; r++) {
    const v = acc[t * R + r]; if (v < minVotes) continue;
    let isMax = true;
    for (let dt = -4; dt <= 4 && isMax; dt++) for (let dr = -5; dr <= 5; dr++) { if (!dt && !dr) continue; const tt = (t + dt + T) % T, rr = (t + dt < 0 || t + dt >= T) ? 2 * D - (r + dr) : r + dr; if (rr < 0 || rr >= R) continue; const u = acc[tt * R + rr]; if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))) { isMax = false; break; } }
    if (isMax) peaks.push({ t, r: r - D, v });
  }
  peaks.sort((a, b) => b.v - a.v);
  const top = peaks.slice(0, 28);
  const two = (l: Line): [Pt, Pt] => { const c = cs[l.t], s = sn[l.t]; const x0 = c * l.r, y0 = s * l.r; return [{ x: x0, y: y0 }, { x: x0 - s * 1000, y: y0 + c * 1000 }]; };
  // Lines running across (normals near 90°) and lines running down (normals near 0°/180°).
  const H = top.filter((l) => l.t >= 45 && l.t < 135), V = top.filter((l) => l.t < 45 || l.t >= 135);
  // (Photo edges are lines too: a page going past the frame is closed by them.)
  const frameH: Line[] = [{ t: 90, r: 0, v: 0 }, { t: 90, r: h - 1, v: 0 }], frameV: Line[] = [{ t: 0, r: 0, v: 0 }, { t: 0, r: w - 1, v: 0 }];
  const HH = [...H, ...frameH], VV = [...V, ...frameV];
  let best: { q: Pt[]; score: number } | null = null;
  for (let i = 0; i < HH.length; i++) for (let j = i + 1; j < HH.length; j++) for (let k = 0; k < VV.length; k++) for (let m = k + 1; m < VV.length; m++) {
    const frameSides = +(i >= H.length) + +(j >= H.length) + +(k >= V.length) + +(m >= V.length);
    if (frameSides > 1) continue;
    const [h1, h2, v1, v2] = [two(HH[i]), two(HH[j]), two(VV[k]), two(VV[m])];
    const c = [lineX(...h1, ...v1), lineX(...h1, ...v2), lineX(...h2, ...v2), lineX(...h2, ...v1)];
    if (c.some((p) => !p || p.x < -w * 0.03 || p.y < -h * 0.03 || p.x > w * 1.03 || p.y > h * 1.03)) continue;
    const q = orderQuad(c as Pt[]); const a = area(q) / (w * h);
    if (a < 0.08) continue;
    // Convex, with no corner pinched shut.
    let sg = 0, bad = false;
    for (let e = 0; e < 4 && !bad; e++) { const p0 = q[e], p1 = q[(e + 1) % 4], p2 = q[(e + 2) % 4]; const cr = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x); const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y), l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y); if (Math.abs(cr) < 0.34 * l1 * l2) bad = true; if (!sg) sg = Math.sign(cr); else if (Math.sign(cr) !== sg) bad = true; }
    if (bad) continue;
    const score = quadScore(E, q);
    if (!best || score > best.score) best = { q, score };
  }
  return best;
}

/* ---------------------------------------------------------------- straightening */

/** The size the page has once flat (its sides' lengths), scaled so its long side is at most `maxSide`. */
export function flatSize(q: Quad, maxSide: number): { w: number; h: number } {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = Math.max(d(q[0], q[1]), d(q[3], q[2])), h = Math.max(d(q[0], q[3]), d(q[1], q[2]));
  const k = Math.min(1, maxSide / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

/** Where the point (u, v) of the straightened page (fractions across and down) is in the photo. */
export function quadPoint(q: Quad, u: number, v: number): Pt {
  const m = homography(1, 1, q); const z = m[6] * u + m[7] * v + 1;
  return { x: (m[0] * u + m[1] * v + m[2]) / z, y: (m[3] * u + m[4] * v + m[5]) / z };
}

/** Projective transform taking the rectangle (0,0)-(w,h) to the quad. */
function homography(w: number, h: number, q: Quad): number[] {
  const src = [[0, 0], [w, 0], [w, h], [0, h]], dst = q.map((p) => [p.x, p.y]);
  const A: number[][] = [], bv: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bv.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bv.push(v);
  }
  // Gaussian elimination.
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [bv[c], bv[p]] = [bv[p], bv[c]];
    for (let r = 0; r < 8; r++) { if (r === c) continue; const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; bv[r] -= f * bv[c]; }
  }
  return bv.map((v, i) => v / A[i][i]);
}

/** The page cut out of the photo and made flat. */
export function warp(img: Img, q: Quad, out: { w: number; h: number }): Img {
  const m = homography(out.w, out.h, q);
  const res = new Uint8ClampedArray(out.w * out.h * 4); const d = img.data, W = img.width, Hh = img.height;
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      const X = x + 0.5, Y = y + 0.5; const z = m[6] * X + m[7] * Y + 1;
      const sx = (m[0] * X + m[1] * Y + m[2]) / z - 0.5, sy = (m[3] * X + m[4] * Y + m[5]) / z - 0.5;
      const x0 = clamp(Math.floor(sx), 0, W - 1), y0 = clamp(Math.floor(sy), 0, Hh - 1), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(Hh - 1, y0 + 1);
      const fx = clamp(sx - x0, 0, 1), fy = clamp(sy - y0, 0, 1);
      const o = (y * out.w + x) * 4, a = (y0 * W + x0) * 4, b = (y0 * W + x1) * 4, c = (y1 * W + x0) * 4, e = (y1 * W + x1) * 4;
      for (let ch = 0; ch < 3; ch++) res[o + ch] = (d[a + ch] * (1 - fx) + d[b + ch] * fx) * (1 - fy) + (d[c + ch] * (1 - fx) + d[e + ch] * fx) * fy;
      res[o + 3] = 255;
    }
  }
  return { data: res, width: out.w, height: out.h };
}

/** Turned a quarter, half or three quarters clockwise. */
export function rotate(img: Img, quarters: number): Img {
  const q = ((quarters % 4) + 4) % 4; if (!q) return img;
  const { width: w, height: h, data } = img; const W = q % 2 ? h : w, H = q % 2 ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [X, Y] = q === 1 ? [h - 1 - y, x] : q === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
    const i = (y * w + x) * 4, o = (Y * W + X) * 4; out[o] = data[i]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2]; out[o + 3] = data[i + 3];
  }
  return { data: out, width: W, height: H };
}

/* ---------------------------------------------------------------- cleaning up */

/** The paper's own brightness across the page (its light falling off, a shadow): the brightest values in
 *  blocks, smoothed — text is dark and small, so it does not count. */
function paperLight(lum: Float32Array, w: number, h: number): Float32Array {
  const bs = Math.max(8, Math.round(Math.max(w, h) / 56));
  const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs);
  const grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const vals: number[] = [];
    for (let y = gy * bs; y < Math.min(h, (gy + 1) * bs); y += 2) for (let x = gx * bs; x < Math.min(w, (gx + 1) * bs); x += 2) vals.push(lum[y * w + x]);
    vals.sort((a, b) => a - b); grid[gy * gw + gx] = vals[Math.floor(vals.length * 0.9)] ?? 255;
  }
  // A block that is all ink (a picture) takes its neighbours' light, but only one block's reach: further than
  // that, a darker area is more likely a shadow on the paper than ink. Then smooth.
  let g = grid;
  for (let pass = 0; pass < 1; pass++) {
    const o = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let m = g[y * gw + x]; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && xx >= 0 && yy < gh && xx < gw) m = Math.max(m, g[yy * gw + xx] * 0.97); } o[y * gw + x] = m; }
    g = o;
  }
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let s = 0, c = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && xx >= 0 && yy < gh && xx < gw) { s += g[yy * gw + xx]; c++; } } o[y * gw + x] = s / c; }
    g = o;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = clamp(y / bs - 0.5, 0, gh - 1), y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = clamp(x / bs - 0.5, 0, gw - 1), x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      out[y * w + x] = (g[y0 * gw + x0] * (1 - tx) + g[y0 * gw + x1] * tx) * (1 - ty) + (g[y1 * gw + x0] * (1 - tx) + g[y1 * gw + x1] * tx) * ty;
    }
  }
  return out;
}

/**
 * What is left around the page once it is flattened — the table, the shadow under a curled edge, the dark of the
 * spine, the next page: from each side of the picture inwards, whatever is not paper (clearly darker than the
 * paper, or coloured where the paper is not) is measured as a depth along that side, the depth smoothed into a
 * clean line, and everything up to it painted with the paper's colour, its edge feathered.
 */
export function cleanBorders(img: Img): Img {
  const { width: W, height: H, data: d } = img;
  const k = Math.max(1, Math.max(W, H) / 500); const w = Math.max(1, Math.round(W / k)), h = Math.max(1, Math.round(H / k)); const n = w * h;
  const L = new Float32Array(n), C = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (Math.min(H - 1, Math.round(y * k)) * W + Math.min(W - 1, Math.round(x * k))) * 4; L[y * w + x] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; C[y * w + x] = Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); }
  // Print removed (it is thinner than this), so only shadows, background and the like stay dark.
  const Lc = closeGray(L, w, h, Math.max(2, Math.round(Math.min(w, h) / 70)));
  // The paper, from the middle of the page: its lightness and colour.
  const mid: number[] = [], midC: number[] = [];
  for (let y = Math.round(h * 0.2); y < h * 0.8; y += 2) for (let x = Math.round(w * 0.2); x < w * 0.8; x += 2) { mid.push(Lc[y * w + x]); midC.push(C[y * w + x]); }
  mid.sort((a, b) => a - b); midC.sort((a, b) => a - b);
  const paper = mid[Math.floor(mid.length * 0.7)] ?? 255, paperC = midC[Math.floor(midC.length * 0.5)] ?? 0;
  if (paper < 80) return img; // (A dark page: nothing to tell.)
  const notPaper = (i: number) => Lc[i] < paper * 0.88 || C[i] > paperC + 45;
  // Print: strokes clearly darker than what is around them. Cleaning stops at print — a shadow over the page's
  // own text (at the spine) is evened by the look, not painted over.
  const ink = (i: number) => L[i] < Lc[i] * 0.72 && Lc[i] > paper * 0.45;
  // Depth of what is not paper, from each side, along it (allowing a pixel or two of paper inside it).
  const maxD = (len: number) => Math.round(len * 0.16);
  const depthAlong = (len: number, across: number, at: (along: number, depth: number) => number) => {
    const dep = new Float32Array(len);
    for (let a = 0; a < len; a++) { let dd = 0, gap = 0; for (let t = 0; t < maxD(across); t++) { const i = at(a, t); if (ink(i)) break; if (notPaper(i)) { dd = t + 1; gap = 0; } else if (++gap > 2) break; } dep[a] = dd; }
    // Smoothed into a clean line (a median, then a little wider so nothing dark is left along it).
    const r = Math.max(2, Math.round(len / 60)); const sm = new Float32Array(len);
    for (let a = 0; a < len; a++) { const win: number[] = []; for (let j = Math.max(0, a - r); j <= Math.min(len - 1, a + r); j++) win.push(dep[j]); win.sort((p, q) => p - q); sm[a] = Math.min(win[win.length >> 1], dep[a] + 2); }
    const out = new Float32Array(len); for (let a = 0; a < len; a++) { let m = 0; for (let j = Math.max(0, a - 2); j <= Math.min(len - 1, a + 2); j++) m = Math.max(m, sm[j]); out[a] = m > 0 ? m + 1.5 : 0; }
    return out;
  };
  const top = depthAlong(w, h, (x, t) => t * w + x), bot = depthAlong(w, h, (x, t) => (h - 1 - t) * w + x);
  const lef = depthAlong(h, w, (y, t) => y * w + t), rig = depthAlong(h, w, (y, t) => y * w + (w - 1 - t));
  const any = [top, bot, lef, rig].some((a) => a.some((v) => v > 0));
  if (!any) return img;
  // The paper's colour: the median of the page's middle (at full size).
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  for (let y = Math.round(H * 0.2); y < H * 0.8; y += 7) for (let x = Math.round(W * 0.2); x < W * 0.8; x += 7) { const o = (y * W + x) * 4; const l = 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2]; if (l >= paper * 0.92) { rs.push(d[o]); gs.push(d[o + 1]); bs.push(d[o + 2]); } }
  const med = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1] ?? 255;
  const pr = med(rs), pg = med(gs), pb = med(bs);
  const out = new Uint8ClampedArray(d); const feather = 3 * k;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.min(w - 1, Math.floor(x / k)), sy = Math.min(h - 1, Math.floor(y / k));
    // How far inside the cleaned border this point is (> 0: inside it), in full-size pixels.
    const inside = Math.max(top[sx] * k - y, bot[sx] * k - (H - 1 - y), lef[sy] * k - x, rig[sy] * k - (W - 1 - x));
    if (inside <= -feather) continue;
    const t = clamp((inside + feather) / (2 * feather), 0, 1); const o = (y * W + x) * 4;
    out[o] = d[o] + (pr - d[o]) * t; out[o + 1] = d[o + 1] + (pg - d[o + 1]) * t; out[o + 2] = d[o + 2] + (pb - d[o + 2]) * t;
  }
  return { data: out, width: W, height: H };
}

/**
 * Fingers holding the page, taken off: skin-coloured patches reaching in from an edge of the page (the paper is
 * not skin-coloured, even cream paper is much less red) are painted over with the paper around them.
 */
export function removeFingers(img: Img): Img {
  const { width: W, height: H, data: d } = img;
  const k = Math.max(1, Math.max(W, H) / 400); const w = Math.max(1, Math.round(W / k)), h = Math.max(1, Math.round(H / k));
  const skin = new Uint8Array(w * h);
  // The paper's own colour, for comparison: the median of the page.
  const crs: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (Math.min(H - 1, Math.round(y * k)) * W + Math.min(W - 1, Math.round(x * k))) * 4; const r = d[i], g = d[i + 1], b = d[i + 2];
    const Y = 0.299 * r + 0.587 * g + 0.114 * b, Cb = 128 - 0.1687 * r - 0.3313 * g + 0.5 * b, Cr = 128 + 0.5 * r - 0.4187 * g - 0.0813 * b;
    if ((y * w + x) % 7 === 0) crs.push(Cr);
    skin[y * w + x] = Y > 50 && Cr > 138 && Cr < 185 && Cb > 80 && Cb < 128 && r > g && g >= b * 0.8 ? 1 : 0;
  }
  crs.sort((a, b) => a - b); const paperCr = crs[crs.length >> 1] ?? 128;
  if (paperCr > 142) return img; // (A reddish page all over: nothing to tell fingers by.)
  // Patches of skin touching the edge, of a finger's size.
  const lab = new Int32Array(w * h).fill(-1); const st: number[] = []; const take: number[] = [];
  for (let s0 = 0; s0 < w * h; s0++) {
    if (!skin[s0] || lab[s0] >= 0) continue;
    const px: number[] = []; st.push(s0); lab[s0] = s0; let edge = false;
    while (st.length) { const i = st.pop()!; px.push(i); const x = i % w, y = (i / w) | 0; if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) edge = true; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && skin[j] && lab[j] < 0) { lab[j] = s0; st.push(j); } }
    if (edge && px.length > w * h * 0.002 && px.length < w * h * 0.15) take.push(...px);
  }
  if (!take.length) return img;
  const mask = new Uint8Array(w * h); for (const i of take) mask[i] = 1;
  // (A little wider: the finger's shadow and soft edge.)
  for (let r = 0; r < 4; r++) { const m2 = mask.slice(); for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w]) m2[i] = 1; } mask.set(m2); }
  // The paper around: for each masked point, the average of unmasked points nearby (grown inward a ring at a time).
  const col = new Float32Array(w * h * 3); const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (!mask[i]) { const x = i % w, y = (i / w) | 0; const s = (Math.min(H - 1, Math.round(y * k)) * W + Math.min(W - 1, Math.round(x * k))) * 4; col[i * 3] = d[s]; col[i * 3 + 1] = d[s + 1]; col[i * 3 + 2] = d[s + 2]; known[i] = 1; }
  for (let round = 0; round < Math.max(w, h); round++) {
    let left = 0; const add: [number, number, number, number][] = [];
    for (let i = 0; i < w * h; i++) {
      if (known[i]) continue; const x = i % w, y = (i / w) | 0; let r = 0, g = 0, b = 0, c = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const j = yy * w + xx; if (!known[j]) continue; r += col[j * 3]; g += col[j * 3 + 1]; b += col[j * 3 + 2]; c++; }
      if (c) add.push([i, r / c, g / c, b / c]); else left++;
    }
    for (const [i, r, g, b] of add) { col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b; known[i] = 1; }
    if (!left || !add.length) break;
  }
  const out = new Uint8ClampedArray(d);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.min(w - 1, Math.floor(x / k)), sy = Math.min(h - 1, Math.floor(y / k)); const i = sy * w + sx; if (!mask[i]) continue;
    const o = (y * W + x) * 4; out[o] = col[i * 3]; out[o + 1] = col[i * 3 + 1]; out[o + 2] = col[i * 3 + 2];
  }
  return { data: out, width: W, height: H };
}

export type Adjust = { brightness?: number; contrast?: number };

/** A filter applied: `auto` evens the light and whitens the paper keeping colour; `color` does so with livelier
 *  colour; `gray` in greys; `bw` as clean black on white (for text); `original` leaves it. */
/**
 * The light a lamp's glare adds, pixel by pixel (null when there is none). Glare is where the paper is much
 * brighter than the paper all around it (its typical light over half the page — light falling off gently
 * across the page is not glare). There the print is washed out, and where the paper is blown out to white its own
 * light is lost, so the glare is measured from the print: the light that, taken off, gives the print there the
 * same darkness against its paper as print has elsewhere on the page. Places under glare with no print take it
 * from those around them.
 */
function glareOf(lum: Float32Array, light: Float32Array, w: number, h: number): Float32Array | null {
  const bs = Math.max(8, Math.round(Math.max(w, h) / 48)); const gw = Math.ceil(w / bs), gh = Math.ceil(h / bs), nb = gw * gh;
  const g = new Float32Array(nb), dark = new Float32Array(nb); const vals: number[] = [];
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    g[y * gw + x] = light[Math.min(h - 1, y * bs + (bs >> 1)) * w + Math.min(w - 1, x * bs + (bs >> 1))];
    vals.length = 0;
    for (let yy = y * bs; yy < Math.min(h, (y + 1) * bs); yy += 2) for (let xx = x * bs; xx < Math.min(w, (x + 1) * bs); xx += 2) vals.push(lum[yy * w + xx]);
    vals.sort((a, b) => a - b); dark[y * gw + x] = vals[Math.floor(vals.length * 0.03)] ?? 255;
  }
  // The typical light around each block: low in what is over a wide window (a lamp's glare can be big).
  const R = Math.max(3, Math.round(Math.max(gw, gh) / 2)); const typ = new Float32Array(nb);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    vals.length = 0;
    for (let yy = Math.max(0, y - R); yy <= Math.min(gh - 1, y + R); yy++) for (let xx = Math.max(0, x - R); xx <= Math.min(gw - 1, x + R); xx++) vals.push(g[yy * gw + xx]);
    vals.sort((a, b) => a - b); typ[y * gw + x] = vals[Math.floor(vals.length * 0.35)];
  }
  const wgt = new Float32Array(nb); let any = false;
  for (let i = 0; i < nb; i++) { wgt[i] = clamp((g[i] / Math.max(1, typ[i]) - 1.07) / 0.1, 0, 1); if (wgt[i] > 0) any = true; }
  if (!any) return null;
  // Print's darkness against its paper away from glare (blocks with print in them).
  const ratios: number[] = [];
  for (let i = 0; i < nb; i++) if (!wgt[i] && g[i] - dark[i] > 40) ratios.push(dark[i] / Math.max(1, g[i]));
  if (ratios.length < 4) return null;
  ratios.sort((a, b) => a - b); const r0 = ratios[ratios.length >> 1];
  // Under glare: the light to take off so the print there is as dark (a = (D − r0·L) / (1 − r0)), where there is print.
  const G = new Float32Array(nb), has = new Uint8Array(nb);
  for (let i = 0; i < nb; i++) {
    if (!wgt[i]) { has[i] = 1; continue; }
    // (Real print only: a faint mark — print showing through from the back, a stain — must not be made print.)
    if (g[i] - dark[i] > Math.max(24, g[i] * 0.12)) { G[i] = clamp((dark[i] - r0 * g[i]) / (1 - r0), 0, g[i] - 40) * wgt[i]; has[i] = 1; }
  }
  // Blocks under glare with no print: from their neighbours, ring by ring.
  for (let pass = 0; pass < gw + gh; pass++) {
    let missing = false;
    for (let i = 0; i < nb; i++) if (!has[i]) {
      const y = Math.floor(i / gw), x = i % gw; let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue; const k = yy * gw + xx; if (has[k] === 1) { s += G[k]; c++; } }
      // (At least the paper's excess light: glare adds at least that much, more where the paper is blown out.)
      if (c) { G[i] = Math.min(Math.max(s / c, g[i] - typ[i]), g[i] - 40) * wgt[i]; has[i] = 2; } else missing = true;
    }
    for (let i = 0; i < nb; i++) if (has[i] === 2) has[i] = 1;
    if (!missing) break;
  }
  // Smoothed, and spread to every pixel (bilinear between block centres).
  const sm = new Float32Array(nb);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { let s = 0, c = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue; s += G[yy * gw + xx]; c++; } sm[y * gw + x] = s / c; }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = clamp((y - bs / 2) / bs, 0, gh - 1); const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = clamp((x - bs / 2) / bs, 0, gw - 1); const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      const v = (sm[y0 * gw + x0] * (1 - tx) + sm[y0 * gw + x1] * tx) * (1 - ty) + (sm[y1 * gw + x0] * (1 - tx) + sm[y1 * gw + x1] * tx) * ty;
      out[y * w + x] = Math.max(0, Math.min(v, light[y * w + x] - 30));
    }
  }
  if ((globalThis as { KR_GLARE_DEBUG?: boolean }).KR_GLARE_DEBUG) { let mx = 0; for (const v of sm) mx = Math.max(mx, v); console.log('glare', { r0: +r0.toFixed(2), max: Math.round(mx), blocks: Array.from(wgt).filter((v) => v > 0).length, of: nb }); }
  return out;
}

export function applyFilter(img: Img, f: Filter, adj: Adjust = {}): Img {
  const { width: w, height: h } = img; const n = w * h; const d = img.data;
  const out = new Uint8ClampedArray(d.length);
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const bright = (adj.brightness ?? 0) * 255, con = 1 + (adj.contrast ?? 0);
  const finish = (v: number) => clamp((v - 128) * con + 128 + bright, 0, 255);
  if (f === 'original') {
    for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) out[i * 4 + c] = finish(d[i * 4 + c]); out[i * 4 + 3] = 255; }
    return { data: out, width: w, height: h };
  }
  const light = paperLight(lum, w, h);
  // Glare (a lamp caught by glossy paper) is light added, not light multiplied: where the paper is much brighter
  // than the paper all around it, the excess is taken off before the page is evened — dividing by it instead
  // would leave the print under the glare washed out.
  const glare = glareOf(lum, light, w, h);
  // Ink level: the dark end of the evened page, so faint print gets darker too.
  const norm = new Float32Array(n);
  for (let i = 0; i < n; i++) { const g = glare ? glare[i] : 0; norm[i] = clamp(((lum[i] - g) / Math.max(30, light[i] - g)) * 255, 0, 255); }
  const hist = new Uint32Array(256); for (let i = 0; i < n; i += 3) hist[norm[i] | 0]++;
  let acc = 0, black = 0; const want = (n / 3) * 0.02; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= want) { black = v; break; } }
  black = Math.min(black, 150);
  const stretch = (v: number) => clamp(((v - black) / Math.max(1, 245 - black)) * 255, 0, 255);
  if (f === 'bw') {
    // Local threshold (Sauvola) on the evened page.
    const iw = w + 1; const I = new Float64Array(iw * (h + 1)), I2 = new Float64Array(iw * (h + 1));
    for (let y = 0; y < h; y++) { let s = 0, s2 = 0; for (let x = 0; x < w; x++) { const v = norm[y * w + x]; s += v; s2 += v * v; I[(y + 1) * iw + x + 1] = I[y * iw + x + 1] + s; I2[(y + 1) * iw + x + 1] = I2[y * iw + x + 1] + s2; } }
    const r = Math.max(6, Math.round(Math.max(w, h) / 60));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1); const c = (x1 - x0) * (y1 - y0);
      const s = I[y1 * iw + x1] - I[y0 * iw + x1] - I[y1 * iw + x0] + I[y0 * iw + x0]; const s2 = I2[y1 * iw + x1] - I2[y0 * iw + x1] - I2[y1 * iw + x0] + I2[y0 * iw + x0];
      const m = s / c, sd = Math.sqrt(Math.max(0, s2 / c - m * m));
      const t = m * (1 + 0.2 * (sd / 128 - 1));
      const v = norm[y * w + x] < Math.min(t, 235) - (adj.brightness ?? 0) * 60 ? 0 : 255;
      const o = (y * w + x) * 4; out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
    }
    return { data: out, width: w, height: h };
  }
  const sat = f === 'color' ? 1.35 : 1.1;
  // Print made crisp (unsharp mask on the evened page: the page less a little blur of itself, a little), and the
  // paper made clean: tones just below paper white — print showing through from the back, a faint stain — go to
  // white; print stays as it is.
  const blurN = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s2 = 0, c = 0; for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s2 += norm[yy * w + xx]; c++; } } blurN[y * w + x] = s2 / c; }
  const knee = f === 'color' ? 255 : 172; // ('color' keeps every tone: it is for pictures.)
  const tone = (v: number) => (v <= knee ? v : knee + (v - knee) * (255 - knee) / Math.max(1, 222 - knee));
  for (let i = 0; i < n; i++) {
    const o = i * 4; const L = clamp(tone(stretch(clamp(norm[i] + (norm[i] - blurN[i]) * 0.7, 0, 255))), 0, 255);
    if (f === 'gray') { out[o] = out[o + 1] = out[o + 2] = finish(L); out[o + 3] = 255; continue; }
    // Colour: each channel lifted by the same factor as the light, then its distance from grey widened.
    const gl = glare ? glare[i] : 0; const k = L / Math.max(1, lum[i] - gl);
    const r = (d[o] - gl) * k, g = (d[o + 1] - gl) * k, b = (d[o + 2] - gl) * k; const m = (r + g + b) / 3;
    out[o] = finish(m + (r - m) * sat); out[o + 1] = finish(m + (g - m) * sat); out[o + 2] = finish(m + (b - m) * sat); out[o + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

/* ---------------------------------------------------------------- light: moiré and glare */

/** A separable Gaussian blur of one plane (σ in pixels), edges held. */
function gaussPlane(v: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 2.5)); const k = new Float32Array(2 * r + 1); let ks = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += v[o + Math.min(w - 1, Math.max(0, x + i))] * k[i + r]; tmp[o + x] = s; } }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r]; out[y * w + x] = s; }
  return out;
}

/** The paper's fine texture: mean |v − blur(v)| on bare paper (`paper` marks it), for each plane given. */
function paperTexture(planes: Float32Array[], paper: Uint8Array, w: number, h: number, sigma = 1.2): number[] {
  return planes.map((v) => {
    const b = gaussPlane(v, w, h, sigma); let s = 0, c = 0;
    for (let y = 4; y < h - 4; y += 2) for (let x = 4; x < w - 4; x += 2) { const i = y * w + x; if (paper[i]) { s += Math.abs(v[i] - b[i]); c++; } }
    return c ? s / c : 0;
  });
}

function planesOf(img: Img): { L: Float32Array; C1: Float32Array; C2: Float32Array; paper: Uint8Array } {
  const { width: w, height: h, data: d } = img; const n = w * h;
  const L = new Float32Array(n), C1 = new Float32Array(n), C2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2]; L[i] = 0.299 * r + 0.587 * g + 0.114 * b; C1[i] = r - g; C2[i] = (r + g) / 2 - b; }
  // Paper: near the paper's light, with no print within a few pixels (print's own edges are not texture).
  const light = closeGray(L, w, h, Math.max(3, Math.round(Math.max(w, h) / 150)));
  const near = gaussPlane(L, w, h, 3); const paper = new Uint8Array(n);
  for (let i = 0; i < n; i++) paper[i] = near[i] >= light[i] * 0.9 && L[i] >= light[i] * 0.8 ? 1 : 0;
  return { L, C1, C2, paper };
}

function cropOf(img: Img, x0: number, y0: number, cw: number, ch: number): Img {
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + cw) * 4), y * cw * 4);
  return { data: out, width: cw, height: ch };
}

/**
 * How much fine, regular texture the bare paper carries (luminance, colour): a page photographed off a screen
 * carries the screen's grid of red, green and blue cells — many times a camera's noise. Measured on the middle of
 * the page (the texture covers all of it).
 */
export function moireLevel(img: Img): { lum: number; chroma: number } {
  const cw = Math.min(img.width, 640), ch = Math.min(img.height, 640);
  const c = cropOf(img, (img.width - cw) >> 1, (img.height - ch) >> 1, cw, ch);
  const P = planesOf(c); const [lum, c1, c2] = paperTexture([P.L, P.C1, P.C2], P.paper, cw, ch);
  return { lum, chroma: c1 + c2 };
}

/**
 * A page photographed off a screen, its moiré taken away: the screen's grid is finer than any print, so the
 * least blur that leaves the paper as smooth as a camera's photo of paper takes it (the sharpening that follows
 * gives print its edges back); its colour fringes — the rainbow bands — are blurred much more, colour on a page
 * being broad. Pages without moiré come back as they are.
 */
export function removeMoire(img: Img): Img {
  const m = moireLevel(img);
  if (m.chroma < 3 && m.lum < 4) return img;
  const { width: w, height: h } = img; const n = w * h;
  // The least blur that smooths the paper (found on the middle of the page).
  const cw = Math.min(w, 640), chh = Math.min(h, 640);
  const P0 = planesOf(cropOf(img, (w - cw) >> 1, (h - chh) >> 1, cw, chh));
  let sigma = 2.6;
  for (const s2 of [0.7, 0.9, 1.2, 1.6, 2.1]) { if (paperTexture([gaussPlane(P0.L, cw, chh, s2)], P0.paper, cw, chh)[0] < 1.2) { sigma = s2; break; } }
  const P = planesOf(img);
  const L = gaussPlane(P.L, w, h, sigma), C1 = gaussPlane(P.C1, w, h, Math.max(3, sigma * 2.5)), C2 = gaussPlane(P.C2, w, h, Math.max(3, sigma * 2.5));
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const g = L[i] - 0.356 * C1[i] + 0.114 * C2[i]; const r = g + C1[i], b = g + C1[i] / 2 - C2[i];
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  if ((globalThis as { KR_MOIRE_DEBUG?: boolean }).KR_MOIRE_DEBUG) console.log('moire', m, 'sigma', sigma);
  return { data: out, width: w, height: h };
}

/* ---------------------------------------------------------------- orientation */

/**
 * Quarter turns (clockwise, as `rotate` takes them) that stand a sideways page upright: a landscape page
 * whose lines of text run up and down. Which way up comes from the side the lines start on, aligned (left
 * for left-to-right scripts, right for right-to-left ones); 0 when that is not clear. A portrait page with
 * vertical lines is left alone: that is how Japanese, Chinese and Korean are often set.
 */
export function uprightTurn(img: Img, rtl = false): 0 | 1 | 3 {
  if (img.width <= img.height * 1.05) return 0;
  const sm = small(img, 400); const { w, h, L } = sm;
  // Ink: clearly darker than the paper around it.
  const sorted = Float32Array.from(L).sort(); const paper = sorted[Math.floor(sorted.length * 0.9)];
  const ink = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) ink[i] = L[i] < paper * 0.62 ? 1 : 0;
  const rows = new Float64Array(h), cols = new Float64Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink[y * w + x]) { rows[y]++; cols[x]++; }
  // Across the lines the profile swings between full and empty; along them, letters average out. (Measured
  // over the inked span, so margins do not count.)
  const alt = (p: Float64Array) => {
    let a = 0; while (a < p.length && !p[a]) a++; let b = p.length - 1; while (b > a && !p[b]) b--;
    if (b - a < 8) return 0;
    let s = 0, s2 = 0; for (let i = a; i <= b; i++) { s += p[i]; s2 += p[i] * p[i]; }
    const n = b - a + 1, m = s / n; return m ? Math.sqrt(Math.max(0, s2 / n - m * m)) / m : 0;
  };
  const rA = alt(rows), cA = alt(cols);
  if (!(cA > rA * 1.6)) return 0;
  // The lines: runs of inked columns; their two ends.
  const tops: number[] = [], bots: number[] = [];
  const thr = Math.max(2, h * 0.01);
  for (let x = 0; x < w;) {
    if (cols[x] < thr) { x++; continue; }
    let x1 = x; while (x1 < w && cols[x1] >= thr) x1++;
    if (x1 - x >= 2) {
      let t = h, b = -1;
      for (let y = 0; y < h; y++) for (let xx = x; xx < x1; xx++) if (ink[y * w + xx]) { if (y < t) t = y; if (y > b) b = y; }
      if (b - t > h * 0.2) { tops.push(t); bots.push(b); }
    }
    x = x1;
  }
  if (tops.length < 4) return 0;
  const spread = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length * 0.75)] - s[Math.floor(s.length * 0.25)]; };
  const st = spread(tops), sb = spread(bots);
  if (Math.max(st, sb) < Math.min(st, sb) * 2 + h * 0.012) return 0;
  // Lines starting at the top: the page's left edge is up (it was turned clockwise), so it turns back.
  const startTop = st < sb;
  return startTop !== rtl ? 3 : 1;
}

/**
 * Quarter turns (clockwise, as `rotate` takes them) that stand the page upright, from its print alone: which way
 * its lines run (the ink profile across lines swings between full and empty, along them it evens out), then which
 * way is up — in Arabic as in Latin script a line's ink is densest at its baseline, in the lower part of the line
 * (the dots, harakat and tall letters above thin out). 0 when the print does not say.
 */
export function pageTurn(img: Img): 0 | 1 | 2 | 3 {
  const sm = small(img, 900); const { w, h, L } = sm; const n = w * h;
  const light = paperLight(L, w, h);
  const ink = new Uint8Array(n); let inked = 0;
  for (let i = 0; i < n; i++) if (L[i] < light[i] * 0.66) { ink[i] = 1; inked++; }
  if (inked < n * 0.003) return 0;
  // Away from the photo's edges (the book's edge, the next page are no print).
  const mx = Math.round(w * 0.04), my = Math.round(h * 0.04);
  // Profiles across the rows and across the columns, each at the small slant that makes it sharpest (a photo is
  // rarely square to the print).
  const profile = (alongX: boolean, k: number) => {
    const n2 = alongX ? h : w; const p = new Float64Array(n2);
    for (let y = my; y < h - my; y++) for (let x = mx; x < w - mx; x++) {
      if (!ink[y * w + x]) continue;
      const at = alongX ? Math.round(y - k * (x - w / 2)) : Math.round(x - k * (y - h / 2));
      if (at >= 0 && at < n2) p[at]++;
    }
    return p;
  };
  const alt = (p: Float64Array) => {
    let a = 0; while (a < p.length && !p[a]) a++; let b = p.length - 1; while (b > a && !p[b]) b--;
    if (b - a < 8) return 0;
    // (Each value against its neighbourhood: a page's large-scale changes — a picture, a margin — do not count.)
    let s = 0, c = 0;
    for (let i = a + 6; i <= b - 6; i++) { let m = 0; for (let k = -6; k <= 6; k++) m += p[i + k]; m /= 13; if (m > 0) { s += Math.abs(p[i] - m) / m; c++; } }
    return c ? s / c : 0;
  };
  let rA = 0, cA = 0;
  for (let k = -0.16; k <= 0.161; k += 0.04) { rA = Math.max(rA, alt(profile(true, k))); cA = Math.max(cA, alt(profile(false, k))); }
  const across = rA > cA * 1.25 ? 'rows' : cA > rA * 1.25 ? 'cols' : null;
  if (!across) return 0;
  // Lines made horizontal (for upright or turned a quarter clockwise), then the baseline's place in each line.
  const W = across === 'rows' ? w : h, H = across === 'rows' ? h : w;
  // (Turned a quarter clockwise, as `rotate(img, 1)` does: the new (x, y) is the old (y, h − 1 − x).)
  const at = (x: number, y: number) => (across === 'rows' ? ink[y * w + x] : ink[(h - 1 - x) * w + y]);
  const prof = new Float64Array(H);
  for (let y = 0; y < H; y++) { let c = 0; for (let x = Math.round(W * 0.04); x < W * 0.96; x++) c += at(x, y); prof[y] = c; }
  // Bands of print between near-empty rows.
  const sorted = Array.from(prof).filter((v) => v > 0).sort((a, b) => a - b);
  const floor = (sorted[Math.floor(sorted.length * 0.5)] ?? 0) * 0.18;
  const bands: { hh: number; top: number; rel: number; mass: number }[] = [];
  for (let y = 0; y < H;) {
    if (prof[y] <= floor) { y++; continue; }
    let y1 = y; while (y1 < H && prof[y1] > floor) y1++;
    const hh = y1 - y;
    if (hh >= 4 && hh < H * 0.2) {
      let pk = y, mass = 0, cm = 0; for (let k = y; k < y1; k++) { if (prof[k] > prof[pk]) pk = k; mass += prof[k]; cm += prof[k] * k; }
      // Where the densest row and the ink's middle sit in the band: below its middle when upright.
      bands.push({ hh, top: y, rel: ((pk + 0.5 - y) / hh) * 0.6 + ((cm / mass + 0.5 - y) / hh) * 0.4, mass });
    }
    y = y1;
  }
  if (bands.length < 3) return 0;
  // Only bands of a line's usual height (a dark margin, a picture, a rule are not lines), each with one say; and
  // lines of print are tall for their spacing — ruled lines on writing paper are thin, and say nothing.
  const hs = bands.map((b) => b.hh).sort((a, b) => a - b); const med = hs[hs.length >> 1];
  const kept = bands.filter((b) => b.hh >= med * 0.55 && b.hh <= med * 1.8);
  if (kept.length < 3) return 0;
  const tops = bands.map((b) => b.top).sort((a, b) => a - b); const gaps: number[] = []; for (let i = 1; i < tops.length; i++) gaps.push(tops[i] - tops[i - 1]);
  gaps.sort((a, b) => a - b); const spacing = gaps[gaps.length >> 1] ?? H;
  if (med < spacing * 0.3) return 0;
  const lines = kept.map((b) => b.rel - 0.5).sort((a, b) => a - b);
  const up = lines[lines.length >> 1]; // > 0: upright (as made horizontal); < 0: upside down
  // (Most lines must agree.)
  const agree = lines.filter((v) => Math.sign(v) === Math.sign(up)).length / lines.length;
  if ((globalThis as { KR_TURN_DEBUG?: boolean }).KR_TURN_DEBUG) console.log('turn: up', up.toFixed(3), 'agree', agree.toFixed(2), 'lines', lines.length, across);
  // (Sure enough: most lines agree on a small lean, or many on a clear one.)
  if (!((agree >= 0.75 && Math.abs(up) >= 0.02) || (agree >= 0.58 && Math.abs(up) >= 0.08))) return 0;
  if (across === 'rows') return up > 0 ? 0 : 2;
  // (Made horizontal by turning a quarter clockwise; upside down: the other way.)
  return up > 0 ? 1 : 3;
}

/**
 * A book photographed open on two pages: where the spine runs between them, as a fraction across the (upright,
 * flattened) picture — a band down the middle with no print, between two pages of print — or null when this is
 * one page.
 */
export function findGutter(img: Img): { top: number; bottom: number } | null {
  if (img.width < img.height * 1.1) return null; // (Two pages side by side are wider than tall.)
  const { w, h, L } = small(img, 900);
  // Print against the paper around it: closing takes away what is thin (print) and keeps what is broad (the
  // spine's shadow, the light falling off), so a deep fold does not count as print.
  const light = closeGray(L, w, h, Math.max(3, Math.round(w / 90)));
  const y0 = Math.round(h * 0.08), y1 = Math.round(h * 0.92);
  const ink = new Float64Array(w);
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) if (L[y * w + x] < light[y * w + x] * 0.78) ink[x]++;
  // Smoothed across a little (the gaps between words are not the gap between pages).
  const r = Math.max(2, Math.round(w * 0.012)); const ik = new Float64Array(w);
  for (let x = 0; x < w; x++) { let s2 = 0, c = 0; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s2 += ink[k]; c++; } ik[x] = s2 / c / (y1 - y0); }
  const mean = (a: number, b: number, f: Float64Array) => { let s2 = 0, c = 0; for (let x = Math.max(0, Math.round(a)); x < Math.min(w, b); x++) { s2 += f[x]; c++; } return c ? s2 / c : 0; };
  const leftInk = mean(w * 0.05, w * 0.45, ik), rightInk = mean(w * 0.55, w * 0.95, ik);
  const less = Math.min(leftInk, rightInk);
  const dbg = (globalThis as { KR_GUTTER_DEBUG?: boolean }).KR_GUTTER_DEBUG;
  if (dbg) console.log('gutter', { w, h, leftInk: +leftInk.toFixed(3), rightInk: +rightInk.toFixed(3), prof: Array.from({ length: 20 }, (_, i) => +ik[Math.round((i + 0.5) * w / 20)].toFixed(3)).join(' ') });
  if (less < 0.004) return null; // (Print on both sides, or it is no spread.)
  // The emptiest column in the middle part, and the run of near-empty columns around it.
  let best = -1, bv = Infinity;
  for (let x = Math.round(w * 0.3); x < w * 0.7; x++) if (ik[x] < bv) { bv = ik[x]; best = x; }
  if (best < 0 || bv > less * 0.2) return null;
  let a = best; while (a > 0 && ik[a - 1] <= less * 0.3) a--;
  let b = best; while (b < w - 1 && ik[b + 1] <= less * 0.3) b++;
  if (b - a < w * 0.012 || b - a > w * 0.35) return null;
  // The paper's brightness down each column (its median: print is little of it).
  const B = new Float64Array(w); const col: number[] = [];
  for (let x = 0; x < w; x++) { col.length = 0; for (let y = y0; y < y1; y += 3) col.push(L[y * w + x]); col.sort((p, q) => p - q); B[x] = col[col.length >> 1]; }
  // A fold shows: as a shadow down the gap (darker than the paper either side of it), or as two pages lit
  // differently (a step from one to the other). Two columns of print on one flat landscape sheet show neither.
  // (The paper's own brightness: the gap's brightest, since next to the gap is print.)
  const gapB = Array.from(B.subarray(a, b + 1)).sort((p, q) => p - q);
  const paper = gapB[Math.floor(gapB.length * 0.9)], dv = gapB[0];
  const third = Math.max(1, Math.round((b - a) / 3));
  const lp = mean(a, a + third, B), rp = mean(b + 1 - third, b + 1, B);
  const shadow = dv < paper * 0.92;
  const step = Math.abs(lp - rp) > Math.max(lp, rp) * 0.08;
  if (dbg) console.log('gutter gap', { a, b, dv: Math.round(dv), lp: Math.round(lp), rp: Math.round(rp), shadow, step });
  if (!shadow && !step) return null;
  // The spine, band by band down the page (a book is seldom photographed square to its spine): the shadow's
  // darkest column, or where the brightness steps; then a straight line through them.
  const lo = a, hi = b;
  const pts: [number, number][] = [];
  const NB = 6;
  for (let k = 0; k < NB; k++) {
    const ya = Math.round(y0 + ((y1 - y0) * k) / NB), yb = Math.round(y0 + ((y1 - y0) * (k + 1)) / NB);
    const Bb = new Float64Array(w);
    for (let x = lo; x <= hi; x++) { col.length = 0; for (let y = ya; y < yb; y += 2) col.push(L[y * w + x]); col.sort((p, q) => p - q); Bb[x] = col[col.length >> 1]; }
    let at = -1;
    if (shadow) {
      // The middle of the shadow's dark (a fold's shadow is a V, often flat at its foot: its darkest column wanders).
      let v = Infinity; for (let x = lo; x <= hi; x++) v = Math.min(v, Bb[x]);
      let ref = 0; for (let x = lo; x <= hi; x++) ref = Math.max(ref, Bb[x]);
      const cut = v + (ref - v) * 0.35; let sw = 0, sx = 0;
      for (let x = lo; x <= hi; x++) if (Bb[x] < cut) { const wt = cut - Bb[x]; sw += wt; sx += wt * x; }
      if (sw > 0) at = sx / sw;
    }
    else { let bestD = 0; for (let x = lo + 1; x <= hi; x++) { const d = Math.abs(Bb[x] - Bb[x - 1]); if (d > bestD) { bestD = d; at = x; } } }
    if (at >= 0) pts.push([(ya + yb) / 2 / h, (at + 0.5) / w]);
  }
  const fit = (P: [number, number][]) => {
    const n = P.length, my = P.reduce((s2, p) => s2 + p[0], 0) / n, mx = P.reduce((s2, p) => s2 + p[1], 0) / n;
    let sxy = 0, syy = 0; for (const [y, x] of P) { sxy += (y - my) * (x - mx); syy += (y - my) ** 2; }
    const k = syy > 1e-9 ? sxy / syy : 0; return { k, c: mx - k * my };
  };
  let line = fit(pts);
  // (One band can be fooled — a picture, a heading across the gap: the worst is let go once.)
  if (pts.length > 3) {
    let wi = 0, wd = -1; pts.forEach(([y, x], i) => { const d = Math.abs(x - (line.c + line.k * y)); if (d > wd) { wd = d; wi = i; } });
    if (wd > 0.01) { pts.splice(wi, 1); line = fit(pts); }
  }
  const k = clamp(line.k, -0.12, 0.12);
  const top = line.c, bottom = line.c + k;
  if (dbg) console.log('gutter line', { top: +top.toFixed(3), bottom: +bottom.toFixed(3), pts: pts.map(([y, x]) => `${y.toFixed(2)}:${x.toFixed(3)}`).join(' ') });
  if (Math.min(top, bottom) < 0.25 || Math.max(top, bottom) > 0.75) return null;
  return { top, bottom };
}

/* ---------------------------------------------------------------- curved pages */

/**
 * How a page photographed in a book bends: its lines of print as curves y = a + b(a)·x + c(a)·x² (x across
 * the page, both in fractions of the picture, from its middle), its upright rules as x = e + f(e)·y + g·y²,
 * and the margins to cut away (the book's edge, the next page beyond the fold), as fractions.
 */
export type Curve = { b: [number, number, number]; c: [number, number, number]; aLo: number; aHi: number; f: [number, number]; g: number; eLo: number; eHi: number; crop: { l: number; r: number; t: number; b: number }; sheet?: Sheet; grid?: Grid };

/**
 * The page as a sheet in space, seen by the camera: flat across, bent along its width (a book's page curls
 * toward the spine) as z = W·u(1−u)(c1 + c2·u + c3·u²), turned and placed by `rv`/`tv` and seen with focal
 * length `f`. Coordinates are the flattened photo's, centred, in units of half its longer side; the page is
 * cut from x0..x1 × y0..y1 of its own (flat) coordinates.
 */
export type Sheet = { rv: number[]; tv: number[]; c: number[]; W: number; f: number; x0: number; x1: number; y0: number; y1: number };

function rodrigues(r: number[]): number[] {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const kx = r[0] / th, ky = r[1] / th, kz = r[2] / th, c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s, ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s, kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v];
}
/** Where a point of the sheet (X across, Y down) is seen in the photo. */
function sheetProject(R: number[], tv: number[], c: number[], W: number, f: number, X: number, Y: number): [number, number] {
  const u = X / W, v = Y / W; const Z = W * u * (1 - u) * (c[0] + c[1] * u + c[2] * u * u + v * (c[3] + c[4] * u));
  const x = R[0] * X + R[1] * Y + R[2] * Z + tv[0], y = R[3] * X + R[4] * Y + R[5] * Z + tv[1], z = R[6] * X + R[7] * Y + R[8] * Z + tv[2];
  const zz = Math.abs(z) < 1e-9 ? 1e-9 : z;
  return [(f * x) / zz, (f * y) / zz];
}

/**
 * Fit the sheet to the lines of print (each straight and level on the page: one Y for all its points) and the
 * upright rules (one X for all theirs) — bundle adjustment with the points' own positions along their line
 * eliminated (Schur complement), Levenberg–Marquardt. Points are in the photo's centred units.
 */
function fitSheet(lines: { pts: [number, number][] }[], rules: { pts: [number, number][] }[]): { sheet: Sheet; rms: number; lines: number; lineErr: number[]; ruleX: number[] } | null {
  const f = 1.2;
  // The direction of the lines, and each point's place along and across them, start the fit.
  let sx = 0, sy = 0;
  for (const l of lines) { const a = l.pts[0], b = l.pts[l.pts.length - 1]; let dx = b[0] - a[0], dy = b[1] - a[1]; if (dx < 0) { dx = -dx; dy = -dy; } sx += dx; sy += dy; }
  const th = Math.atan2(sy, sx); const ca = Math.cos(th), sa = Math.sin(th);
  const along = (p: [number, number]) => p[0] * ca + p[1] * sa, across = (p: [number, number]) => -p[0] * sa + p[1] * ca;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const l of [...lines, ...rules]) for (const p of l.pts) { const a = along(p), b = across(p); if (a < xmin) xmin = a; if (a > xmax) xmax = a; if (b < ymin) ymin = b; if (b > ymax) ymax = b; }
  const W = xmax - xmin; if (W <= 0.1) return null;
  // (Globals: turn 3, place 3, bend 5 — the bend along the width, and how it changes down the page.)
  const NP = 11;
  const nL = lines.length, nR = rules.length, G = NP + nL + nR;
  const g = new Float64Array(G);
  g[2] = th; g[3] = xmin * ca - ymin * sa; g[4] = xmin * sa + ymin * ca; g[5] = f;
  type Ob = { u: number; v: number; kind: 0 | 1; q: number; li: number };
  const obs: Ob[] = []; const loc: number[] = [];
  lines.forEach((l, i) => { let m = 0; for (const p of l.pts) m += across(p); g[NP + i] = m / l.pts.length - ymin; for (const p of l.pts) { obs.push({ u: p[0], v: p[1], kind: 0, q: NP + i, li: i }); loc.push(along(p) - xmin); } });
  rules.forEach((l, i) => { let m = 0; for (const p of l.pts) m += along(p); g[NP + nL + i] = m / l.pts.length - xmin; for (const p of l.pts) { obs.push({ u: p[0], v: p[1], kind: 1, q: NP + nL + i, li: -1 }); loc.push(across(p) - ymin); } });
  const M = obs.length; const L = Float64Array.from(loc);
  const pointOf = (gg: Float64Array, ll: Float64Array, j: number): [number, number] => { const o = obs[j]; return o.kind === 0 ? [ll[j], gg[o.q]] : [gg[o.q], ll[j]]; };
  const cost = (gg: Float64Array, ll: Float64Array) => { const R = rodrigues([gg[0], gg[1], gg[2]]); const tv = [gg[3], gg[4], gg[5]], c = [gg[6], gg[7], gg[8], gg[9], gg[10]]; let s = 0; for (let j = 0; j < M; j++) { const [X, Y] = pointOf(gg, ll, j); const p = sheetProject(R, tv, c, W, f, X, Y); s += (p[0] - obs[j].u) ** 2 + (p[1] - obs[j].v) ** 2; } return s; };
  let lambda = 1e-3; let cur = cost(g, L);
  const eps = 1e-6;
  const A = new Float64Array(G * G), bg = new Float64Array(G);
  const NB = NP + 1;
  const Dj = new Float64Array(M), Bj = new Float64Array(M * NB), blj = new Float64Array(M);
  const idxOf = (q: number) => { const a = new Array(NB); for (let i = 0; i < NP; i++) a[i] = i; a[NP] = q; return a; };
  for (let it = 0; it < 40; it++) {
    A.fill(0); bg.fill(0);
    const R0 = rodrigues([g[0], g[1], g[2]]);
    const Rs = [0, 1, 2].map((k) => { const r = [g[0], g[1], g[2]]; r[k] += eps; return rodrigues(r); });
    const tv0 = [g[3], g[4], g[5]], c0 = [g[6], g[7], g[8], g[9], g[10]];
    for (let j = 0; j < M; j++) {
      const o = obs[j]; const [X, Y] = pointOf(g, L, j);
      const p0 = sheetProject(R0, tv0, c0, W, f, X, Y); const ru = p0[0] - o.u, rv = p0[1] - o.v;
      const J: number[] = new Array(2 * NB);
      for (let k = 0; k < NP; k++) {
        let p: [number, number];
        if (k < 3) p = sheetProject(Rs[k], tv0, c0, W, f, X, Y);
        else if (k < 6) { const t = tv0.slice(); t[k - 3] += eps; p = sheetProject(R0, t, c0, W, f, X, Y); }
        else { const c = c0.slice(); c[k - 6] += eps; p = sheetProject(R0, tv0, c, W, f, X, Y); }
        J[2 * k] = (p[0] - p0[0]) / eps; J[2 * k + 1] = (p[1] - p0[1]) / eps;
      }
      // (The distance stays put: a page twice as large twice as far looks almost the same, and left free the
      // fit drifts along that line.)
      J[10] = J[11] = 0;
      const pq = o.kind === 0 ? sheetProject(R0, tv0, c0, W, f, X, Y + eps) : sheetProject(R0, tv0, c0, W, f, X + eps, Y);
      J[2 * NP] = (pq[0] - p0[0]) / eps; J[2 * NP + 1] = (pq[1] - p0[1]) / eps;
      const pl = o.kind === 0 ? sheetProject(R0, tv0, c0, W, f, X + eps, Y) : sheetProject(R0, tv0, c0, W, f, X, Y + eps);
      const lu = (pl[0] - p0[0]) / eps, lv = (pl[1] - p0[1]) / eps;
      const idx = idxOf(o.q);
      for (let a = 0; a < NB; a++) {
        const ja0 = J[2 * a], ja1 = J[2 * a + 1]; const ia = idx[a];
        bg[ia] += ja0 * ru + ja1 * rv;
        for (let b = 0; b < NB; b++) A[ia * G + idx[b]] += ja0 * J[2 * b] + ja1 * J[2 * b + 1];
        Bj[j * NB + a] = ja0 * lu + ja1 * lv;
      }
      Dj[j] = lu * lu + lv * lv; blj[j] = lu * ru + lv * rv;
    }
    let improved = false;
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const S = Float64Array.from(A); const rhs = Float64Array.from(bg);
      for (let a = 0; a < G; a++) S[a * G + a] += lambda * (A[a * G + a] + 1e-9);
      // (The bend's change down the page is held back a little: little print may say much about it.)
      // (The bend is held back toward flat — gently across, more for its change down the page — so where the
      // print says little, the sheet stays plain rather than inventing folds.)
      for (let q = 6; q < NP; q++) { const mu = (q >= 9 ? 3e-3 : 3e-4) * M; S[q * G + q] += mu; rhs[q] += mu * g[q]; }
      for (let j = 0; j < M; j++) {
        const d = Dj[j] * (1 + lambda) + 1e-12; const q = obs[j].q;
        const idx = idxOf(q);
        for (let a = 0; a < NB; a++) { const ba = Bj[j * NB + a] / d; rhs[idx[a]] -= ba * blj[j]; for (let b = 0; b < NB; b++) S[idx[a] * G + idx[b]] -= ba * Bj[j * NB + b]; }
      }
      // Solve S δ = −rhs (Gaussian elimination with partial pivoting).
      const n = G; const Mx = new Float64Array(n * (n + 1));
      for (let a = 0; a < n; a++) { for (let b = 0; b < n; b++) Mx[a * (n + 1) + b] = S[a * G + b]; Mx[a * (n + 1) + n] = -rhs[a]; }
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        let pv = i; for (let r = i + 1; r < n; r++) if (Math.abs(Mx[r * (n + 1) + i]) > Math.abs(Mx[pv * (n + 1) + i])) pv = r;
        if (Math.abs(Mx[pv * (n + 1) + i]) < 1e-15) { ok = false; break; }
        if (pv !== i) for (let c = 0; c <= n; c++) { const tmp = Mx[i * (n + 1) + c]; Mx[i * (n + 1) + c] = Mx[pv * (n + 1) + c]; Mx[pv * (n + 1) + c] = tmp; }
        for (let r = 0; r < n; r++) if (r !== i) { const fct = Mx[r * (n + 1) + i] / Mx[i * (n + 1) + i]; if (fct) for (let c = i; c <= n; c++) Mx[r * (n + 1) + c] -= fct * Mx[i * (n + 1) + c]; }
      }
      if (!ok) { lambda *= 10; continue; }
      const dg = new Float64Array(n); for (let i = 0; i < n; i++) dg[i] = Mx[i * (n + 1) + n] / Mx[i * (n + 1) + i];
      const g2 = Float64Array.from(g); for (let i = 0; i < n; i++) g2[i] += dg[i];
      const L2 = Float64Array.from(L);
      for (let j = 0; j < M; j++) { const d = Dj[j] * (1 + lambda) + 1e-12; const q = obs[j].q; let s2 = blj[j]; for (let a = 0; a < NP; a++) s2 += Bj[j * NB + a] * dg[a]; s2 += Bj[j * NB + NP] * dg[q]; L2[j] -= s2 / d; }
      const c2 = cost(g2, L2);
      if (c2 < cur) { g.set(g2); L.set(L2); const gain = cur - c2; cur = c2; lambda = Math.max(1e-9, lambda / 3); improved = true; if (gain < 1e-12 * M) it = 1e9; }
      else lambda *= 4;
    }
    if (!improved) break;
  }
  const rms = Math.sqrt(cur / M);
  const lineErr = new Array(nL).fill(0), lineN = new Array(nL).fill(0);
  { const R = rodrigues([g[0], g[1], g[2]]); for (let j = 0; j < M; j++) { const o = obs[j]; if (o.kind) continue; const [X, Y] = pointOf(g, L, j); const p = sheetProject(R, [g[3], g[4], g[5]], [g[6], g[7], g[8], g[9], g[10]], W, f, X, Y); lineErr[o.li] += (p[0] - o.u) ** 2 + (p[1] - o.v) ** 2; lineN[o.li]++; } }
  for (let i = 0; i < nL; i++) lineErr[i] = Math.sqrt(lineErr[i] / Math.max(1, lineN[i]));
  // The page: where its print is, with a margin; lines are their middles, so half a line more.
  const Ys = Array.from(g.slice(NP, NP + nL)).sort((a, b) => a - b);
  const gaps = Ys.slice(1).map((y, i) => y - Ys[i]).filter((d) => d > 1e-4).sort((a, b) => a - b);
  const pitch = gaps.length ? gaps[gaps.length >> 1] : 0.03;
  let x0 = Infinity, x1 = -Infinity, y0 = Ys[0] - pitch * 0.7, y1 = Ys[Ys.length - 1] + pitch * 0.7;
  for (let j = 0; j < M; j++) { const [X, Y] = pointOf(g, L, j); if (X < x0) x0 = X; if (X > x1) x1 = X; if (obs[j].kind === 1) { if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; } }
  const m = 0.035 * Math.max(x1 - x0, y1 - y0);
  return { sheet: { rv: [g[0], g[1], g[2]], tv: [g[3], g[4], g[5]], c: [g[6], g[7], g[8], g[9], g[10]], W, f, x0: x0 - m, x1: x1 + m, y0: y0 - m, y1: y1 + m }, rms, lines: nL, lineErr, ruleX: Array.from(g.slice(NP + nL, NP + nL + nR)) };
}

/** The page cut from the photo as the sheet says, flat: each output pixel's place on the sheet seen through
 *  the camera (exactly on a coarse grid, in between by interpolation). */
/** Rows and columns along the edges that mostly fall outside the photo (alpha 0) cut off; what is left
 *  outside within the page becomes paper (white). */
function cropOutside(out: Uint8ClampedArray, ow: number, oh: number, frac: number): Img {
  const bad = (x: number, y: number) => out[(y * ow + x) * 4 + 3] === 0;
  const rowBad = (y: number) => { let c = 0; for (let x = 0; x < ow; x += 2) if (bad(x, y)) c++; return c > (ow / 2) * frac; };
  const colBad = (x: number, y0: number, y1: number) => { let c = 0; for (let y = y0; y < y1; y += 2) if (bad(x, y)) c++; return c > ((y1 - y0) / 2) * Math.max(frac, 0.6); };
  let top = 0, bot = oh; while (top < oh * 0.25 && rowBad(top)) top++; while (bot > oh * 0.75 && rowBad(bot - 1)) bot--;
  // (Columns only when they are mostly outside: a page's side is not to be cut for a corner's sake.)
  let left = 0, right = ow; while (left < ow * 0.25 && colBad(left, top, bot)) left++; while (right > ow * 0.75 && colBad(right - 1, top, bot)) right--;
  const cw = right - left, ch = bot - top;
  const res = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const i = ((y + top) * ow + x + left) * 4, o = (y * cw + x) * 4; if (out[i + 3]) { res[o] = out[i]; res[o + 1] = out[i + 1]; res[o + 2] = out[i + 2]; } else res[o] = res[o + 1] = res[o + 2] = 255; res[o + 3] = 255; }
  return { data: res, width: cw, height: ch };
}

function sheetUnwarp(img: Img, sh: Sheet): Img {
  const { width: W, height: H, data: d } = img; const kp = Math.max(W, H) / 2;
  const R = rodrigues(sh.rv); const step = 8;
  // As many pixels as the page has in the photo: the projected area of the page over its own area.
  let area = 0; { const nG = 12; const P = (i: number, j: number) => sheetProject(R, sh.tv, sh.c, sh.W, sh.f, sh.x0 + ((sh.x1 - sh.x0) * i) / nG, sh.y0 + ((sh.y1 - sh.y0) * j) / nG);
    for (let j = 0; j < nG; j++) for (let i = 0; i < nG; i++) { const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), e = P(i, j + 1); area += Math.abs((a[0] * b[1] - b[0] * a[1]) + (b[0] * c[1] - c[0] * b[1]) + (c[0] * e[1] - e[0] * c[1]) + (e[0] * a[1] - a[0] * e[1])) / 2; } }
  const k = clamp(Math.sqrt((area * kp * kp) / ((sh.x1 - sh.x0) * (sh.y1 - sh.y0))), 10, 20000);
  const ow = Math.max(1, Math.round((sh.x1 - sh.x0) * k)), oh = Math.max(1, Math.round((sh.y1 - sh.y0) * k));
  const gw = Math.ceil(ow / step) + 1, gh = Math.ceil(oh / step) + 1; const gx = new Float32Array(gw * gh), gy = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const p = sheetProject(R, sh.tv, sh.c, sh.W, sh.f, sh.x0 + (i * step) / k, sh.y0 + (j * step) / k); gx[j * gw + i] = p[0] * kp + W / 2 - 0.5; gy[j * gw + i] = p[1] * kp + H / 2 - 0.5; }
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const fy = y / step, j0 = Math.min(gh - 2, Math.floor(fy)), ty = fy - j0;
    for (let x = 0; x < ow; x++) {
      const fx = x / step, i0 = Math.min(gw - 2, Math.floor(fx)), tx = fx - i0;
      const a = j0 * gw + i0;
      const sx = (gx[a] * (1 - tx) + gx[a + 1] * tx) * (1 - ty) + (gx[a + gw] * (1 - tx) + gx[a + gw + 1] * tx) * ty;
      const sy = (gy[a] * (1 - tx) + gy[a + 1] * tx) * (1 - ty) + (gy[a + gw] * (1 - tx) + gy[a + gw + 1] * tx) * ty;
      const o = (y * ow + x) * 4; out[o + 3] = 255;
      if (sx < -1 || sy < -1 || sx > W || sy > H) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 0; continue; }
      const x0 = clamp(Math.floor(sx), 0, W - 1), y0 = clamp(Math.floor(sy), 0, H - 1), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
      const fx2 = clamp(sx - x0, 0, 1), fy2 = clamp(sy - y0, 0, 1);
      const A2 = (y0 * W + x0) * 4, B2 = (y0 * W + x1) * 4, C2 = (y1 * W + x0) * 4, E2 = (y1 * W + x1) * 4;
      for (let ch = 0; ch < 3; ch++) out[o + ch] = (d[A2 + ch] * (1 - fx2) + d[B2 + ch] * fx2) * (1 - fy2) + (d[C2 + ch] * (1 - fx2) + d[E2 + ch] * fx2) * fy2;
    }
  }
  return cropOutside(out, ow, oh, 0.3);
}

/** Weighted least squares (normal equations, small systems). */
function lsq(rows: number[][], ys: number[], ws: number[]): number[] | null {
  const n = rows[0]?.length ?? 0; if (!n || rows.length < n) return null;
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  rows.forEach((r, k) => { const w = ws[k]; for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) A[i][j] += w * r[i] * r[j]; A[i][n] += w * r[i] * ys[k]; } });
  for (let i = 0; i < n; i++) A[i][i] += 1e-9;
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; const d = A[i][i]; if (Math.abs(d) < 1e-14) return null;
    for (let r = 0; r < n; r++) if (r !== i) { const f = A[r][i] / d; for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c]; }
  }
  return A.map((r, i) => r[n] / r[i]);
}

/**
 * Where each point of the flattened page comes from in the photo of it: the offset (in fractions of the page's
 * width `mx` and height `my`) from the point to its source, on a gx × gy grid over the page, read between by
 * bilinear interpolation. Made so that every line of print runs level and upright rules (a frame, a column's line)
 * run straight down; this follows any bend — a book's curl at the spine, a page that waves — where one formula for
 * the whole page cannot.
 */
export type Grid = { gx: number; gy: number; mx: number[]; my: number[]; wScale?: number };

/** Bilinear weights of point (u, v) in [0,1]² on a gx × gy grid: four (node, weight) pairs. */
function gridW(gx: number, gy: number, u: number, v: number): [number, number][] {
  const fx = clamp(u, 0, 1) * (gx - 1), fy = clamp(v, 0, 1) * (gy - 1);
  const x0 = Math.min(gx - 2, Math.floor(fx)), y0 = Math.min(gy - 2, Math.floor(fy)); const tx = fx - x0, ty = fy - y0;
  return [[y0 * gx + x0, (1 - tx) * (1 - ty)], [y0 * gx + x0 + 1, tx * (1 - ty)], [(y0 + 1) * gx + x0, (1 - tx) * ty], [(y0 + 1) * gx + x0 + 1, tx * ty]];
}
const gridAt = (g: number[], gx: number, gy: number, u: number, v: number) => { let s = 0; for (const [k, w] of gridW(gx, gy, u, v)) s += g[k] * w; return s; };

/**
 * Fit one displacement field: each curve (points along it, (along, across) in [0,1]) must come out at one
 * `across` value of its own once the field is taken off; the field as smooth as can be between them.
 * Returns the field and how well it explains the curves (rms, in the same units), or null.
 */
type SlopeObs = { u1: number; u2: number; v: number; d: number; wt: number };
function fitField(curves: [number, number][][], gx: number, gy: number, alongIsU: boolean, slopes: SlopeObs[] = []): { g: number[]; rms: number; rms0: number } | null {
  const N = gx * gy, L = curves.length, n = N + L;
  if (L < 3 && slopes.length < 20) return null;
  const A = Array.from({ length: n }, () => new Float64Array(n)); const b = new Float64Array(n);
  let m = 0;
  const add = (idx: number[], ws: number[], y: number, wt: number) => {
    for (let i = 0; i < idx.length; i++) { b[idx[i]] += wt * ws[i] * y; for (let j = 0; j < idx.length; j++) A[idx[i]][idx[j]] += wt * ws[i] * ws[j]; }
  };
  // Data: across_i − field(u_i, v_i) − t_c = 0 for every point of curve c.
  curves.forEach((pts, c) => { for (const [al, ac] of pts) { const [u, v] = alongIsU ? [al, ac] : [ac, al]; const gw = gridW(gx, gy, u, v); add([...gw.map((q) => q[0]), N + c], [...gw.map((q) => q[1]), 1], ac, 1); m++; } });
  // Slopes: the field rises between two points as the print does there (field(u2, v) − field(u1, v) = d).
  for (const o of slopes) { const a = gridW(gx, gy, o.u1, o.v), b2 = gridW(gx, gy, o.u2, o.v); add([...b2.map((q) => q[0]), ...a.map((q) => q[0])], [...b2.map((q) => q[1]), ...a.map((q) => -q[1])], o.d, o.wt); }
  // Smoothness: second differences across the grid, both ways, and the mixed one; a little pull to zero.
  const lam = Math.max(1, m + slopes.length * 0.5) * (Number((globalThis as { KR_LAM?: number }).KR_LAM) || 0.02);
  for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) {
    const k = y * gx + x;
    // (Along the lines a page may bend sharply — a book curls fast at its spine; down the page it changes slowly.)
    if (x > 0 && x < gx - 1) add([k - 1, k, k + 1], [1, -2, 1], 0, lam * (Number((globalThis as { KR_LX?: number }).KR_LX) || 1));
    if (y > 0 && y < gy - 1) add([k - gx, k, k + gx], [1, -2, 1], 0, lam);
    if (x < gx - 1 && y < gy - 1) add([k, k + 1, k + gx, k + gx + 1], [1, -1, -1, 1], 0, lam * 0.5);
    add([k], [1], 0, lam * 1e-3);
    // (A little resistance to any change at all: where there is no print — the margins, past the last line — the
    // map stays as it is at the print's edge instead of swinging on.)
    if (y < gy - 1) add([k, k + gx], [1, -1], 0, lam * (Number((globalThis as { KR_L1?: number }).KR_L1) || 0.08));
  }
  // Solve (symmetric, positive definite): Cholesky.
  for (let i = 0; i < n; i++) A[i][i] += 1e-9;
  for (let j = 0; j < n; j++) {
    let d = A[j][j]; for (let k = 0; k < j; k++) d -= A[j][k] * A[j][k]; if (!(d > 0)) return null; d = Math.sqrt(d); A[j][j] = d;
    for (let i = j + 1; i < n; i++) { let s2 = A[i][j]; for (let k = 0; k < j; k++) s2 -= A[i][k] * A[j][k]; A[i][j] = s2 / d; }
  }
  const z = new Float64Array(n); for (let i = 0; i < n; i++) { let s2 = b[i]; for (let k = 0; k < i; k++) s2 -= A[i][k] * z[k]; z[i] = s2 / A[i][i]; }
  const x = new Float64Array(n); for (let i = n - 1; i >= 0; i--) { let s2 = z[i]; for (let k = i + 1; k < n; k++) s2 -= A[k][i] * x[k]; x[i] = s2 / A[i][i]; }
  const g = Array.from(x.slice(0, N));
  let e = 0, e0 = 0;
  curves.forEach((pts, c) => { const mean = pts.reduce((s2, p) => s2 + p[1], 0) / pts.length; for (const [al, ac] of pts) { const [u, v] = alongIsU ? [al, ac] : [ac, al]; e += (ac - gridAt(g, gx, gy, u, v) - x[N + c]) ** 2; e0 += (ac - mean) ** 2; } });
  return { g, rms: Math.sqrt(e / m), rms0: Math.sqrt(e0 / m) };
}

/** Solve the normal equations A x = b (symmetric, positive definite) in place: Cholesky. Null when singular. */
function cholSolve(A: Float64Array[], b: Float64Array): Float64Array | null {
  const n = b.length;
  for (let i = 0; i < n; i++) A[i][i] += 1e-9;
  for (let j = 0; j < n; j++) {
    let d = A[j][j]; for (let k = 0; k < j; k++) d -= A[j][k] * A[j][k]; if (!(d > 0)) return null; d = Math.sqrt(d); A[j][j] = d;
    for (let i = j + 1; i < n; i++) { let s2 = A[i][j]; for (let k = 0; k < j; k++) s2 -= A[i][k] * A[j][k]; A[i][j] = s2 / d; }
  }
  const z = new Float64Array(n); for (let i = 0; i < n; i++) { let s2 = b[i]; for (let k = 0; k < i; k++) s2 -= A[i][k] * z[k]; z[i] = s2 / A[i][i]; }
  const x = new Float64Array(n); for (let i = n - 1; i >= 0; i--) { let s2 = z[i]; for (let k = i + 1; k < n; k++) s2 -= A[k][i] * x[k]; x[i] = s2 / A[i][i]; }
  return x;
}

/**
 * The page's vertical displacement as a book page bends: curled about an axis along the spine (down the page), so
 * the displacement is a function of the position across the page, scaled with the height on the page (the camera
 * sees the near and far ends of a curl from different angles): dy(u, v) = A(u) + B(u)·(v − ½) + C(u)·(v − ½)²,
 * each of A, B, C a fine curve across the page (so a sharp curl at the spine is followed), plus a coarse, very smooth
 * free-form remainder for pages that wave. Fitted to the lines of print (each must come out level) and to the
 * print's slope where lines could not be followed.
 */
function fitCurl(curves: [number, number][][], slopes: SlopeObs[]): { at: (u: number, v: number) => number; scale: (u: number) => number; rms: number; rms0: number } | null {
  const G = globalThis as { KR_K?: number; KR_LA?: number; KR_LR?: number };
  const K = Number(G.KR_K) || 41, RX = 6, RY = 8;
  const L = curves.length, nA = 3 * K, nR = RX * RY, n = nA + nR + L;
  if (L < 3) return null;
  const A = Array.from({ length: n }, () => new Float64Array(n)); const b = new Float64Array(n);
  const add = (idx: number[], ws: number[], y: number, wt: number) => {
    for (let i = 0; i < idx.length; i++) { b[idx[i]] += wt * ws[i] * y; const Ai = A[idx[i]]; for (let j = 0; j < idx.length; j++) Ai[idx[j]] += wt * ws[i] * ws[j]; }
  };
  // The field at (u, v) as weights on the unknowns.
  const basis = (u: number, v: number): [number[], number[]] => {
    const f = clamp(u, 0, 1) * (K - 1), k0 = Math.min(K - 2, Math.floor(f)), t = f - k0; const dv = v - 0.5;
    const idx = [k0, k0 + 1, K + k0, K + k0 + 1, 2 * K + k0, 2 * K + k0 + 1], ws = [1 - t, t, (1 - t) * dv, t * dv, (1 - t) * dv * dv, t * dv * dv];
    for (const [r, wr] of gridW(RX, RY, u, v)) { idx.push(nA + r); ws.push(wr); }
    return [idx, ws];
  };
  let m = 0;
  curves.forEach((pts, c) => { for (const [u, v] of pts) { const [idx, ws] = basis(u, v); idx.push(nA + nR + c); ws.push(1); add(idx, ws, v, 1); m++; } });
  for (const o of slopes) { const [i2, w2] = basis(o.u2, o.v), [i1, w1] = basis(o.u1, o.v); add([...i2, ...i1], [...w2, ...w1.map((q) => -q)], o.d, o.wt); }
  // Smooth: the curves across the page bend gently (the curl itself may be sharp, its change is not), the scale
  // and bow terms more so; the remainder very smooth; all pulled a little towards nothing where nothing says.
  const lamA = Math.max(1, m) * (Number(G.KR_LA) || 0.004), lamR = Math.max(1, m) * (Number(G.KR_LR) || 0.2);
  for (let part = 0; part < 3; part++) for (let k = 0; k < K; k++) {
    const i = part * K + k; const mul = part === 0 ? 1 : part === 1 ? 3 : 10;
    if (k > 0 && k < K - 1) add([i - 1, i, i + 1], [1, -2, 1], 0, lamA * mul);
    add([i], [1], 0, lamA * 1e-3 * mul);
  }
  for (let y = 0; y < RY; y++) for (let x = 0; x < RX; x++) {
    const k = nA + y * RX + x;
    if (x > 0 && x < RX - 1) add([k - 1, k, k + 1], [1, -2, 1], 0, lamR);
    if (y > 0 && y < RY - 1) add([k - RX, k, k + RX], [1, -2, 1], 0, lamR);
    add([k], [1], 0, lamR * 0.05);
  }
  const x = cholSolve(A, b); if (!x) return null;
  const at = (u: number, v: number) => { const [idx, ws] = basis(u, v); let s2 = 0; for (let i = 0; i < idx.length; i++) s2 += x[idx[i]] * ws[i]; return s2; };
  let e = 0, e0 = 0;
  curves.forEach((pts, c) => { const mean = pts.reduce((s2, p) => s2 + p[1], 0) / pts.length; for (const [u, v] of pts) { e += (v - at(u, v) - x[nA + nR + c]) ** 2; e0 += (v - mean) ** 2; } });
  // How much the page is magnified across its height at each place across it (B: the curl's nearness to the camera).
  const scale = (u: number) => { const f = clamp(u, 0, 1) * (K - 1), k0 = Math.min(K - 2, Math.floor(f)), t = f - k0; return x[K + k0] * (1 - t) + x[K + k0 + 1] * t; };
  return { at, scale, rms: Math.sqrt(e / m), rms0: Math.sqrt(e0 / m) };
}

/**
 * The direction the print runs at points across the page, from the ink's texture (the structure tensor: lines of
 * print make the ink change fastest across them); used where lines are too steep or faint to follow one by one, as
 * at a book's spine. Returned as slope observations for the field, with how clear each is.
 */
function printSlopes(ink: Uint8Array, w: number, h: number, P: number): SlopeObs[] {
  const n = w * h;
  const box = (v: Float32Array, r: number) => {
    const t = new Float32Array(n), o = new Float32Array(n);
    for (let y = 0; y < h; y++) { let s2 = 0; const b = y * w; for (let x = -r; x < w; x++) { if (x + r < w) s2 += v[b + x + r]; if (x - r - 1 >= 0) s2 -= v[b + x - r - 1]; if (x >= 0) t[b + x] = s2 / (2 * r + 1); } }
    for (let x = 0; x < w; x++) { let s2 = 0; for (let y = -r; y < h; y++) { if (y + r < h) s2 += t[(y + r) * w + x]; if (y - r - 1 >= 0) s2 -= t[(y - r - 1) * w + x]; if (y >= 0) o[y * w + x] = s2 / (2 * r + 1); } }
    return o;
  };
  let I = new Float32Array(n); for (let i = 0; i < n; i++) I[i] = ink[i];
  const r1 = Math.max(1, Math.round(P / 6)); I = box(box(I, r1), r1);
  const xx = new Float32Array(n), xy = new Float32Array(n), yy = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; const gx = (I[i + 1] - I[i - 1]) / 2, gy = (I[i + w] - I[i - w]) / 2; xx[i] = gx * gx; xy[i] = gx * gy; yy[i] = gy * gy; }
  const r2 = Math.max(2, Math.round(P * (Number((globalThis as { KR_R2?: number }).KR_R2) || 0.35)));
  const Jxx = box(box(xx, r2), r2), Jxy = box(box(xy, r2), r2), Jyy = box(box(yy, r2), r2);
  const D = box(box(I, r2), r2);
  const out: SlopeObs[] = []; const stp = Math.max(3, Math.round(P / 2));
  let eMax = 0; for (let i = 0; i < n; i += 5) eMax = Math.max(eMax, Jxx[i] + Jyy[i]);
  for (let y = stp; y < h - stp; y += stp) for (let x = stp; x < w - stp; x += stp) {
    const i = y * w + x; const e = Jxx[i] + Jyy[i]; if (e < eMax * 0.05 || D[i] < 0.04 || D[i] > 0.5) continue;
    const coh = Math.hypot(Jxx[i] - Jyy[i], 2 * Jxy[i]) / e; if (coh < 0.35) continue;
    // The gradient's main direction φ; the print runs across it: slope −cot φ.
    const phi = 0.5 * Math.atan2(2 * Jxy[i], Jxx[i] - Jyy[i]); const sn = Math.sin(phi); if (Math.abs(sn) < 0.6) continue;
    const slope = -Math.cos(phi) / sn;
    const du = stp / w;
    out.push({ u1: (x + 0.5) / w - du, u2: (x + 0.5) / w + du, v: (y + 0.5) / h, d: (slope * 2 * stp) / h, wt: coh * (Number((globalThis as { KR_SW?: number }).KR_SW) || 0.6) });
  }
  return out;
}

/**
 * The lines of print as curves, followed strip by strip down the page: in each narrow upright strip the ink's
 * profile, smoothed to the size of a line, peaks once per line (dots, harakat and the letters' shapes all fall in
 * the same hump); the peaks of neighbouring strips are joined into lines. No shape is assumed, so a line that runs
 * level and then curls down at the spine is followed as it is.
 */
let lastSpacing = 0; let lastSlopes: SlopeObs[] = [];
function linePieces(ink: Uint8Array, w: number, h: number): { pts: [number, number][]; thick: number }[] {
  // The spacing of lines: the repeat (autocorrelation) of the row profile, in several narrow upright strips (lines
  // that slant or bend stay sharp in a narrow strip), the middle value of their answers.
  const spacingIn = (x0: number, x1: number) => {
    const rows = new Float64Array(h);
    for (let y = 0; y < h; y++) { let c = 0; for (let x = x0; x < x1; x++) c += ink[y * w + x]; rows[y] = c; }
    let mean = 0; for (let y = 0; y < h; y++) mean += rows[y]; mean /= h;
    if (mean < 0.3) return 0;
    const maxLag = Math.floor(h / 5); const ac = new Float64Array(maxLag + 1);
    for (let lag = 1; lag <= maxLag; lag++) { let sum = 0; for (let y = 0; y + lag < h; y++) sum += (rows[y] - mean) * (rows[y + lag] - mean); ac[lag] = sum / (h - lag); }
    // Past the first dip (neighbouring rows alike), the strongest repeat is the line spacing (its multiples are weaker).
    let dip = 2; while (dip < maxLag && ac[dip + 1] < ac[dip]) dip++;
    let P0 = 0, best = 0; for (let lag = dip; lag <= maxLag; lag++) if (ac[lag] > best) { best = ac[lag]; P0 = lag; }
    // (The first clear repeat, not a multiple of it that happens to be a little stronger.)
    for (let lag = dip + 1; lag < P0; lag++) if (ac[lag] >= best * 0.6 && ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1]) { P0 = lag; break; }
    return best > 0 && P0 >= 4 ? P0 : 0;
  };
  const ests: number[] = []; const sw0 = Math.max(16, Math.round(w / 10));
  for (let x0 = Math.round(w * 0.05); x0 + sw0 <= w * 0.95; x0 += sw0) { const e = spacingIn(x0, x0 + sw0); if (e) ests.push(e); }
  ests.sort((a2, b2) => a2 - b2);
  let P = ests.length ? ests[ests.length >> 1] : 0;
  if (!P) return [];
  if ((globalThis as { KR_CURVE_DEBUG?: boolean }).KR_CURVE_DEBUG) console.log('lines: spacing', P);
  lastSpacing = P;
  // The print's local direction (from its texture), so each strip's ink is gathered along the lines' own slope —
  // a slanted line then still makes one sharp hump.
  const sl = printSlopes(ink, w, h, P); lastSlopes = sl;
  const cs = Math.max(3, Math.round(P / 2)); const cw = Math.ceil(w / cs), ch = Math.ceil(h / cs);
  const sg = new Float32Array(cw * ch).fill(NaN);
  for (const o of sl) { const cx = Math.min(cw - 1, Math.floor(((o.u1 + o.u2) / 2) * w / cs)), cy = Math.min(ch - 1, Math.floor(o.v * h / cs)); sg[cy * cw + cx] = (o.d * h) / ((o.u2 - o.u1) * w); }
  // (Gaps filled from around: a few rounds of averaging the known neighbours.)
  for (let round = 0; round < 12; round++) { let left = 0; const nx = sg.slice(); for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const i = y * cw + x; if (!Number.isNaN(sg[i])) continue; let s2 = 0, c = 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= cw || yy >= ch) continue; const v = sg[yy * cw + xx]; if (!Number.isNaN(v)) { s2 += v; c++; } } if (c) nx[i] = s2 / c; else left++; } sg.set(nx); if (!left) break; }
  const slopeAt = (x: number, y: number) => { const v = sg[Math.min(ch - 1, Math.floor(y / cs)) * cw + Math.min(cw - 1, Math.floor(x / cs))]; return Number.isNaN(v) ? 0 : v; };
  // (Strips about a line tall and half overlapping: wide enough to gather a line's ink, narrow enough to follow it.)
  const sw = Math.max(8, Math.round(P * 1.2)), step = Math.max(4, Math.round(sw / 2)), sigma = Math.max(1.5, P / 5);
  const ker: number[] = []; const R = Math.ceil(sigma * 2.5); for (let k = -R; k <= R; k++) ker.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  type Peak = { x: number; y: number; v: number; chain: number };
  const strips: Peak[][] = [];
  for (let x0 = 0; x0 + sw <= w; x0 += step) {
    const xc = x0 + sw / 2;
    const pr = new Float64Array(h);
    for (let y = 0; y < h; y++) { const sl0 = slopeAt(xc, y); for (let x = x0; x < x0 + sw; x++) { if (!ink[y * w + x]) continue; const yy = Math.round(y - sl0 * (x - xc)); if (yy >= 0 && yy < h) pr[yy]++; } }
    const sm = new Float64Array(h); for (let y = 0; y < h; y++) { let s2 = 0, ws = 0; for (let k = -R; k <= R; k++) { const yy = y + k; if (yy < 0 || yy >= h) continue; s2 += pr[yy] * ker[k + R]; ws += ker[k + R]; } sm[y] = s2 / ws; }
    // (Less what the strip has everywhere — a shadow, the book's edge running down it: only the lines' humps count.)
    { const sorted = Array.from(sm).sort((a, b) => a - b); const base = sorted[Math.floor(h * 0.2)]; for (let y = 0; y < h; y++) sm[y] = Math.max(0, sm[y] - base); }
    // Humps a line tall (a wide dark area — the book's edge, a picture — is none), then those clearly above the
    // strip's usual hump (stray marks between lines are not lines).
    const humps: Peak[] = [];
    for (let y = 1; y < h - 1; y++) {
      if (sm[y] <= 0.3 || sm[y] < sm[y - 1] || sm[y] < sm[y + 1]) continue;
      let a = y; while (a > 0 && sm[a] > sm[y] * 0.5) a--; let b2 = y; while (b2 < h - 1 && sm[b2] > sm[y] * 0.5) b2++;
      if (b2 - a > P * 1.2) continue;
      const d = sm[y - 1] - 2 * sm[y] + sm[y + 1]; const off = d < 0 ? clamp((sm[y - 1] - sm[y + 1]) / (2 * d), -0.5, 0.5) : 0;
      humps.push({ x: xc, y: y + off + 0.5, v: sm[y], chain: -1 });
    }
    const vs = humps.map((p0) => p0.v).sort((a, b) => a - b); const typ = vs[Math.floor(vs.length * 0.75)] ?? 0;
    const peaks: Peak[] = [];
    for (const pk of humps) {
      if (pk.v < typ * 0.25) continue;
      if (peaks.length && pk.y - peaks[peaks.length - 1].y < P * 0.5) { if (pk.v > peaks[peaks.length - 1].v) peaks[peaks.length - 1] = pk; continue; }
      peaks.push(pk);
    }
    const mx = typ;
    strips.push(peaks);
    if ((globalThis as { KR_CURVE_DEBUG?: boolean }).KR_CURVE_DEBUG && x0 > w * 0.55) { let rej = 0; for (let y = 1; y < h - 1; y++) if (sm[y] >= mx * 0.2 && sm[y] >= sm[y - 1] && sm[y] >= sm[y + 1]) rej++; console.log('strip', x0, 'mx', mx.toFixed(1), 'humps', rej, 'peaks', peaks.length); }
  }
  (globalThis as { KR_PEAKS?: unknown[] }).KR_PEAKS = strips.flat().map((q) => [q.x / w, q.y / h]);
  // Join: each peak to the nearest of the last few strips' chain ends, within a third of a line.
  const chains: Peak[][] = [];
  const ends: { s: number; p: Peak }[] = [];
  strips.forEach((peaks, s) => {
    for (const pk of peaks) {
      let bestE = -1, bd = P * 0.33;
      for (let e = 0; e < ends.length; e++) {
        const en = ends[e]; if (s - en.s > 4) continue;
        // Where the chain heads: on along its own slope (a line curling at the spine climbs fast).
        const c = chains[en.p.chain]; const q = c.length >= 2 ? c[Math.max(0, c.length - 3)] : null;
        const slope = q && en.p.x > q.x ? clamp((en.p.y - q.y) / (en.p.x - q.x), -1, 1) : 0;
        const d = Math.abs(en.p.y + slope * (pk.x - en.p.x) - pk.y); if (d < bd) { bd = d; bestE = e; }
      }
      if (bestE >= 0) { const c = ends[bestE].p.chain; pk.chain = c; chains[c].push(pk); ends[bestE] = { s, p: pk }; }
      else { pk.chain = chains.length; chains.push([pk]); ends.push({ s, p: pk }); }
    }
  });
  return chains.filter((c) => c.length >= 4).map((c) => ({ pts: c.map((p) => [p.x / w, p.y / h] as [number, number]), thick: P }));
}

/** The displacement fields of a page from its lines (and upright rules), at source positions; null when they run
 *  straight. */
type Fields = { dy: (u: number, v: number) => number; dx: (u: number, v: number) => number; scale?: (u: number) => number };
function fieldsOf(ink: Uint8Array, rule: Uint8Array, w: number, h: number): Fields | null {
  const pieces = linePieces(ink, w, h);
  (globalThis as { KR_GRID_DUMP?: (b: Uint8Array, w: number, h: number, p: unknown) => void }).KR_GRID_DUMP?.(ink, w, h, pieces);
  // (Lines enough to say how the page lies: a few words of handwriting, a drawing do not.)
  if (pieces.length < 8 || pieces.reduce((a, p) => a + p.pts.length, 0) < 60) return null;
  // (Each piece thinned to at most ~40 points: long lines do not outweigh the rest.)
  const curves = pieces.map((p) => { const k = Math.max(1, Math.floor(p.pts.length / 40)); return p.pts.filter((_, i) => i % k === 0); });
  const gx = Number((globalThis as { KR_GX?: number }).KR_GX) || 14, gy = Math.round(gx * 1.3);
  // (The print's slope counts only among the lines followed — not in a drawing, a picture or the margins.)
  const near = new Uint8Array(Math.ceil(w / 8) * Math.ceil(h / 8)); const nw = Math.ceil(w / 8), nh = Math.ceil(h / 8);
  const rad = Math.max(1, Math.round(lastSpacing / 8));
  for (const c of curves) for (const [u, v] of c) { const cx = Math.floor(u * w / 8), cy = Math.floor(v * h / 8); for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad * 2; dx <= rad * 2; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < nw && y < nh) near[y * nw + x] = 1; } }
  const slopes = lastSlopes.filter((o) => near[Math.min(nh - 1, Math.floor(o.v * h / 8)) * nw + Math.min(nw - 1, Math.floor(((o.u1 + o.u2) / 2) * w / 8))]);
  if (!(globalThis as { KR_SLOPES?: unknown }).KR_SLOPES) (globalThis as { KR_SLOPES?: unknown }).KR_SLOPES = slopes;
  if ((globalThis as { KR_CURVE_DEBUG?: boolean }).KR_CURVE_DEBUG) { const hist = new Array(10).fill(0), sl = new Array(10).fill(0); for (const o of slopes) { const b = Math.min(9, Math.floor(o.u1 * 10)); hist[b]++; sl[b] += o.d / (o.u2 - o.u1) * h / w; } console.log('slopes by u:', hist.join(' '), '| mean slope', sl.map((v, i) => (hist[i] ? v / hist[i] : 0).toFixed(2)).join(' ')); const ph = new Array(10).fill(0); for (const c of curves) for (const [u] of c) ph[Math.min(9, Math.floor(u * 10))]++; console.log('line pts by u:', ph.join(' ')); }
  // The book-curl model first; the free-form grid when it is asked for (tests).
  const useGrid = (globalThis as { KR_MODEL?: string }).KR_MODEL === 'grid';
  type Fit = { at: (u: number, v: number) => number; scale?: (u: number) => number; rms: number; rms0: number };
  const fit = (cs: [number, number][][]): Fit | null => {
    if (!useGrid) return fitCurl(cs, slopes);
    const f = fitField(cs, gx, gy, true, slopes); if (!f) return null;
    return { at: (u, v) => gridAt(f.g, gx, gy, u, v), rms: f.rms, rms0: f.rms0 };
  };
  let fy = fit(curves);
  if (!fy) return null;
  // Pieces the field does not explain (a heading set at a slant, a picture's edge) are left out once.
  {
    const errs = curves.map((pts) => { let e = 0; for (const [u, v] of pts) e += v - fy!.at(u, v); const t = e / pts.length; let r = 0; for (const [u, v] of pts) r += (v - fy!.at(u, v) - t) ** 2; return Math.sqrt(r / pts.length); });
    const med = [...errs].sort((a, b) => a - b)[errs.length >> 1];
    const keep = curves.filter((_, c) => errs[c] <= Math.max(med * 3, 1.5 / h));
    if (keep.length >= 6 && keep.length < curves.length) fy = fit(keep) ?? fy;
  }
  if ((globalThis as { KR_CURVE_DEBUG?: boolean }).KR_CURVE_DEBUG) console.log('field: pieces', pieces.length, 'rms', (fy.rms * h).toFixed(2), 'px, flat', (fy.rms0 * h).toFixed(2), 'px');
  // Only when the lines really are not level and the field explains them.
  let lo = Infinity, hi = -Infinity; for (let j = 0; j <= 10; j++) for (let i = 0; i <= 20; i++) { const d = fy.at(i / 20, j / 10); if (d < lo) lo = d; if (d > hi) hi = d; }
  if (fy.rms0 * h < 0.9 || fy.rms > fy.rms0 * 0.6 || (hi - lo) * h < 2) return null;
  // Sideways: upright rules, as curves down the page.
  let dx = new Array(gx * gy).fill(0);
  {
    const n = w * h; const lab = new Int32Array(n).fill(-1); const st: number[] = []; const rcurves: [number, number][][] = [];
    for (let s0 = 0; s0 < n; s0++) {
      if (!rule[s0] || lab[s0] >= 0) continue;
      const px: number[] = []; st.push(s0); lab[s0] = s0;
      while (st.length) { const i = st.pop()!; px.push(i); const x = i % w, y = (i / w) | 0; for (let dy = -1; dy <= 1; dy++) for (let dxx = -1; dxx <= 1; dxx++) { const yy = y + dy, xx = x + dxx; if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue; const j = yy * w + xx; if (rule[j] && lab[j] < 0) { lab[j] = s0; st.push(j); } } }
      const sum = new Float64Array(h), cnt = new Float64Array(h); for (const i of px) { const y = (i / w) | 0; sum[y] += i % w; cnt[y]++; }
      const pts: [number, number][] = []; for (let y = 0; y < h; y += 4) if (cnt[y]) pts.push([(y + 0.5) / h, (sum[y] / cnt[y] + 0.5) / w]);
      if (pts.length >= 10) rcurves.push(pts);
    }
    if (rcurves.length >= 2) { const fx = fitField(rcurves, gx, gy, false); if (fx && fx.rms < fx.rms0) dx = fx.g; }
  }
  const fyAt = fy.at;
  return { dy: fyAt, dx: (u, v) => gridAt(dx, gx, gy, u, v), scale: fy.scale };
}

/** The fields turned into a map from the flattened page back to the photo (each node found by fixed-point steps). */
function inverseMap(f: Fields, gx = 61, gy = 41): Grid {
  const mx: number[] = [], my: number[] = [];
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
    const u0 = i / (gx - 1), v0 = j / (gy - 1); let u = u0, v = v0;
    for (let k = 0; k < 6; k++) { const nu = u0 + f.dx(u, v), nv = v0 + f.dy(u, v); u = nu; v = nv; }
    mx.push(u - u0); my.push(v - v0);
  }
  return { gx, gy, mx, my };
}

/** Where the map sends (u, v): its source point. */
function mapAt(g: Grid, u: number, v: number): [number, number] {
  const fx = clamp(u, 0, 1) * (g.gx - 1), fy = clamp(v, 0, 1) * (g.gy - 1);
  const x0 = Math.min(g.gx - 2, Math.floor(fx)), y0 = Math.min(g.gy - 2, Math.floor(fy)); const tx = fx - x0, ty = fy - y0;
  const k = y0 * g.gx + x0, a = (1 - tx) * (1 - ty), b = tx * (1 - ty), c = (1 - tx) * ty, d = tx * ty;
  return [u + g.mx[k] * a + g.mx[k + 1] * b + g.mx[k + g.gx] * c + g.mx[k + g.gx + 1] * d, v + g.my[k] * a + g.my[k + 1] * b + g.my[k + g.gx] * c + g.my[k + g.gx + 1] * d];
}

/**
 * The part of a page that curls away from the camera (at a book's spine) is seen foreshortened: its print squeezed
 * across. From how much the page is magnified across its height at each place (the curl's `scale`: nearer the
 * camera, larger), its height above the flat is known (z/f = magnification − 1, for a camera at about the page's
 * longer side away), and the page's true width along its surface (the arc's length) is laid out flat again.
 */
function unfold(g: Grid, scale: (u: number) => number, w: number, h: number): Grid {
  const N = 200; const f = Math.max(w, h);
  // Magnification relative to the page's flattest part (the median: most of a page lies flat).
  const sc: number[] = []; for (let i = 0; i <= N; i++) sc.push(scale(i / N));
  const ref = [...sc].sort((a, b) => a - b)[N >> 1];
  // (A page that is merely tilted — what the corners found did not quite straighten — makes the magnification change
  // evenly across; only what bends is the curl: an even change is taken out.)
  let su = 0, suu = 0, sm = 0, sum = 0; for (let i = 0; i <= N; i++) { const u = i / N; su += u; suu += u * u; sm += sc[i]; sum += u * sc[i]; }
  const slope = ((N + 1) * sum - su * sm) / Math.max(1e-9, (N + 1) * suu - su * su), icpt = (sm - slope * su) / (N + 1);
  const curl = sc.map((v, i) => v - (icpt + slope * (i / N)));
  const ref2 = [...curl].sort((a, b) => a - b)[N >> 1];
  const xs: number[] = [], zs: number[] = [];
  for (let i = 0; i <= N; i++) {
    const m = clamp((1 + curl[i] - ref2), 0.75, 1.25); const z = (1 - 1 / m) * f; // z > 0: nearer the camera
    const xi = (i / N - 0.5) * w; xs.push(xi / m); zs.push(z); // (seen at x, it lies at x / m from the axis)
  }
  void ref;
  const S = [0]; for (let i = 1; i <= N; i++) S.push(S[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]));
  const total = S[N]; const flatW = xs[N] - xs[0];
  if (!(total > 0) || total / Math.max(1, flatW) < 1.003) return g;
  // (A curl the lines barely show is no reason to widen the page: only a clear one, up to a seventh.)
  if (total / Math.max(1, flatW) > 1.15) return g;
  // For a place along the unfolded page (fraction of its length), the place in the picture.
  const uOf = (t: number) => { const target = t * total; let lo = 0, hi = N; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] < target) lo = mid; else hi = mid; } const fr = (target - S[lo]) / Math.max(1e-9, S[hi] - S[lo]); return (lo + fr) / N; };
  const mx: number[] = [], my: number[] = [];
  for (let j = 0; j < g.gy; j++) for (let i = 0; i < g.gx; i++) { const u = i / (g.gx - 1), v = j / (g.gy - 1); const [su, sv] = mapAt(g, uOf(u), v); mx.push(su - u); my.push(sv - v); }
  return { gx: g.gx, gy: g.gy, mx, my, wScale: (g.wScale ?? 1) * total / Math.max(1, w) };
}

/**
 * The map that makes the page's lines level, found in passes: each pass follows the lines of the page as the
 * passes before have flattened it, so lines that curl too steeply to follow at first (at the spine) are followed
 * once the rest of the page is straight; the maps are chained.
 */
function findGrid(ink: Uint8Array, rule: Uint8Array, w: number, h: number): Grid | null {
  let total: Grid | null = null;
  let cur = ink, curRule = rule; let scale: ((u: number) => number) | undefined;
  for (let pass = 0; pass < 3; pass++) {
    const f = fieldsOf(cur, curRule, w, h);
    if (!f) break;
    if (!pass) scale = f.scale;
    const g = inverseMap(f);
    if (!total) total = g;
    else {
      // total ∘ g: a point goes through g first (it was found on the already flattened page), then the earlier map.
      const t: Grid = total; const mx: number[] = [], my: number[] = [];
      for (let j = 0; j < g.gy; j++) for (let i = 0; i < g.gx; i++) { const u = i / (g.gx - 1), v = j / (g.gy - 1); const [u1, v1] = mapAt(g, u, v); const [u2, v2] = mapAt(t, u1, v1); mx.push(u2 - u); my.push(v2 - v); }
      total = { gx: g.gx, gy: g.gy, mx, my };
    }
    // The ink as flattened so far, for the next pass.
    const nx = new Uint8Array(w * h), nr = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [su, sv] = mapAt(total, (x + 0.5) / w, (y + 0.5) / h); const sx = Math.floor(su * w), sy = Math.floor(sv * h);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue; nx[y * w + x] = ink[sy * w + sx]; nr[y * w + x] = rule[sy * w + sx];
    }
    cur = nx; curRule = nr;
  }
  if (total && scale && !(globalThis as { KR_NOARC?: boolean }).KR_NOARC) total = unfold(total, scale, w, h);
  // A map that folds the page over, tears it or moves it far is a mistake (a drawing taken for lines): none then.
  if (total) {
    const g = total; let bad = ''; let maxMy = 0, minDu = 9, maxDu = 0, maxSh = 0, minDv = 9, maxDv = 0;
    const ij0 = Math.floor(g.gx * 0.1), ij1 = Math.ceil(g.gx * 0.9) - 1, jj0 = Math.floor(g.gy * 0.1), jj1 = Math.ceil(g.gy * 0.9) - 1;
    for (let j = jj0; j <= jj1; j++) for (let i = ij0; i <= ij1; i++) {
      const k = j * g.gx + i; maxMy = Math.max(maxMy, Math.abs(g.my[k]));
      if (i < g.gx - 1) { const du = 1 / (g.gx - 1); const dd = 1 + (g.mx[k + 1] - g.mx[k]) / du; minDu = Math.min(minDu, dd); maxDu = Math.max(maxDu, dd); maxSh = Math.max(maxSh, Math.abs((g.my[k + 1] - g.my[k]) / du)); }
      if (j < g.gy - 1) { const dv = 1 / (g.gy - 1); const dd = 1 + (g.my[k + g.gx] - g.my[k]) / dv; minDv = Math.min(minDv, dd); maxDv = Math.max(maxDv, dd); }
    }
    // (In the page's inner part: the outermost rows and columns may stretch more, where nothing is printed.)
    if (maxMy > 0.2) bad = 'moves'; else if (minDu < 0.4 || maxDu > 2.2) bad = 'stretches across'; else if (maxSh > 0.9) bad = 'shears'; else if (minDv < 0.45 || maxDv > 2) bad = 'stretches down';
    if ((globalThis as { KR_CURVE_DEBUG?: boolean }).KR_CURVE_DEBUG) console.log('field: check', bad || 'ok', 'my', maxMy.toFixed(3), 'du', minDu.toFixed(2), maxDu.toFixed(2), 'shear', maxSh.toFixed(2), 'dv', minDv.toFixed(2), maxDv.toFixed(2));
    if (bad) return null;
  }
  return total;
}

/** A page with its print made level and its rules straight, the same size. */
function gridUnwarp(img: Img, gr: Grid): Img {
  const { width: W, height: H, data: d } = img;
  // (The page unfolded may be wider than it was seen.)
  const OW = Math.max(1, Math.round(W * clamp(gr.wScale ?? 1, 1, 1.15)));
  const out = new Uint8ClampedArray(OW * H * 4);
  for (let y = 0; y < H; y++) {
    const v0 = (y + 0.5) / H;
    // (The map read between its nodes, written out: this runs for every pixel of the finished page.)
    const fy0 = v0 * (gr.gy - 1), j0 = Math.min(gr.gy - 2, Math.floor(fy0)), ty = fy0 - j0;
    for (let x = 0; x < OW; x++) {
      const u0 = (x + 0.5) / OW, fx0 = u0 * (gr.gx - 1), i0 = Math.min(gr.gx - 2, Math.floor(fx0)), tx = fx0 - i0;
      const k = j0 * gr.gx + i0, a = (1 - tx) * (1 - ty), bq = tx * (1 - ty), cq = (1 - tx) * ty, dq = tx * ty;
      const u = u0 + gr.mx[k] * a + gr.mx[k + 1] * bq + gr.mx[k + gr.gx] * cq + gr.mx[k + gr.gx + 1] * dq;
      const v = v0 + gr.my[k] * a + gr.my[k + 1] * bq + gr.my[k + gr.gx] * cq + gr.my[k + gr.gx + 1] * dq;
      const sx = u * W - 0.5, sy = v * H - 0.5; const o = (y * OW + x) * 4;
      // (Beyond the photo: dark, as the background around a page is — cleaned away with it afterwards.)
      if (sx < -1 || sy < -1 || sx > W || sy > H) { out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = 255; continue; }
      const x0 = clamp(Math.floor(sx), 0, W - 1), y0 = clamp(Math.floor(sy), 0, H - 1), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
      const fx = clamp(sx - x0, 0, 1), fy = clamp(sy - y0, 0, 1);
      const A = (y0 * W + x0) * 4, B = (y0 * W + x1) * 4, C = (y1 * W + x0) * 4, E = (y1 * W + x1) * 4;
      for (let ch = 0; ch < 3; ch++) out[o + ch] = (d[A + ch] * (1 - fx) + d[B + ch] * fx) * (1 - fy) + (d[C + ch] * (1 - fx) + d[E + ch] * fx) * fy;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: OW, height: H };
}

/** Find how a (flattened) page bends, from its lines of print and its ruled lines; null when there is too
 *  little print to tell, or it does not bend. */
export function findCurve(img: Img): Curve | null {
  const sm = small(img, 1000); const { w, h, L } = sm; const n = w * h;
  const light = paperLight(L, w, h);
  const ink = new Uint8Array(n); for (let i = 0; i < n; i++) ink[i] = L[i] < light[i] * 0.62 ? 1 : 0;
  // Upright rules: thin, tall strokes of ink (a little slanted, as photographed). They are set aside (and
  // measured), so they do not join the lines of the two columns of print they divide.
  const rule = new Uint8Array(n);
  {
    const seen = new Int32Array(n).fill(-1); const st: number[] = [];
    for (let s0 = 0; s0 < n; s0++) {
      if (!ink[s0] || seen[s0] >= 0) continue;
      const px: number[] = []; st.push(s0); seen[s0] = s0; let y0 = h, y1 = -1, x0 = w, x1 = -1;
      while (st.length) { const i = st.pop()!; px.push(i); const x = i % w, y = (i / w) | 0; if (y < y0) y0 = y; if (y > y1) y1 = y; if (x < x0) x0 = x; if (x > x1) x1 = x; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue; const j = yy * w + xx; if (ink[j] && seen[j] < 0) { seen[j] = s0; st.push(j); } } }
      const bh = y1 - y0 + 1, bw = x1 - x0 + 1;
      // (The photo's own edge is not a rule.)
      if (bh >= h * 0.2 && bw <= Math.max(8, bh * 0.15) && px.length <= bh * 8 && x0 > 2 && x1 < w - 3) for (const i of px) rule[i] = 1;
    }
  }
  const ruleW = new Uint8Array(n); for (let i = 0; i < n; i++) if (rule[i]) { const x = i % w; for (let d = -3; d <= 3; d++) if (x + d >= 0 && x + d < w) ruleW[i + d] = 1; }
  for (let i = 0; i < n; i++) if (ruleW[i]) ink[i] = 0;
  // Lines of print: ink smeared along the rows into bands, as far as the gap between words (from the size of
  // the print: the usual height of a letter's ink).
  let gapMax = Math.round(w / 45);
  {
    const hs: number[] = []; const seen = new Uint8Array(n); const st: number[] = [];
    for (let s0 = 0; s0 < n && hs.length < 4000; s0 += 7) {
      if (!ink[s0] || seen[s0]) continue;
      let y0 = h, y1 = -1, cnt = 0; st.push(s0); seen[s0] = 1;
      while (st.length && cnt < 4000) { const i = st.pop()!; cnt++; const x = i % w, y = (i / w) | 0; if (y < y0) y0 = y; if (y > y1) y1 = y; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && ink[j] && !seen[j]) { seen[j] = 1; st.push(j); } }
      st.length = 0;
      if (cnt >= 6 && y1 - y0 >= 3) hs.push(y1 - y0 + 1);
    }
    if (hs.length > 20) { hs.sort((a, b) => a - b); const charH = hs[Math.floor(hs.length * 0.7)]; gapMax = clamp(Math.round(charH * 1.3), 6, Math.round(w / 25)); }
  }
  const band = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    let last = -1;
    for (let x = 0; x < w; x++) { const i = y * w + x; if (ruleW[i]) { last = -1; continue; } if (ink[i]) { if (last >= 0 && x - last <= gapMax) for (let k = last; k <= x; k++) band[y * w + k] = 1; band[i] = 1; last = x; } }
  }
  // (Rows of one line that the letters' shapes leave apart are closed up: a small gap down each column.)
  for (let x = 0; x < w; x++) { let last = -1; for (let y = 0; y < h; y++) { const i = y * w + x; if (band[i]) { if (last >= 0 && y - last <= 3) for (let k = last + 1; k < y; k++) band[k * w + x] = 1; last = y; } } }
  // First the lines as they are, a smooth field making them level (any bend); else the formulas below.
  {
    // (A more generous ink mask than below: thin, faint print still counts for following lines.)
    const ink2 = new Uint8Array(n); for (let i = 0; i < n; i++) ink2[i] = !ruleW[i] && L[i] < light[i] * 0.78 ? 1 : 0;
    const grid = findGrid(ink2, rule, w, h);
    if (grid) {
      // The page flattened, its own edges are straight now: where they show (the next page beyond the spine, the
      // table), the page is cut to them.
      const crop = { l: 0, r: 0, t: 0, b: 0 };
      try {
        const flat = gridUnwarp(img, grid); const fp = detectPage(flat);
        if (fp.how !== 'frame') {
          const q = fp.quad, W2 = flat.width, H2 = flat.height;
          const l = Math.max(q[0].x, q[3].x) / W2, r = 1 - Math.min(q[1].x, q[2].x) / W2, t = Math.max(q[0].y, q[1].y) / H2, b = 1 - Math.min(q[2].y, q[3].y) / H2;
          // (Only a clear page, most of the picture, its sides nearly upright and level.)
          const square = Math.abs(q[0].x - q[3].x) / W2 < 0.04 && Math.abs(q[1].x - q[2].x) / W2 < 0.04 && Math.abs(q[0].y - q[1].y) / H2 < 0.04 && Math.abs(q[3].y - q[2].y) / H2 < 0.04;
          if (square && (1 - l - r) * (1 - t - b) > 0.45 && l >= 0 && r >= 0 && t >= 0 && b >= 0) Object.assign(crop, { l, r, t, b });
        }
      } catch { /* the whole flattened picture */ }
      return { grid, b: [0, 0, 0], c: [0, 0, 0], aLo: 0, aHi: 0, f: [0, 0], g: 0, eLo: 0, eHi: 0, crop };
    }
  }
  // Bands thinner than print (stray specks) or joined lines are sorted out by their shape below.
  const lab = new Int32Array(n).fill(-1); const stack: number[] = [];
  type Line = { xs: number[]; ys: number[]; wt: number; a: number };
  const lines: Line[] = [];
  for (let s = 0; s < n; s++) {
    if (!band[s] || lab[s] >= 0) continue;
    const px: number[] = []; stack.push(s); lab[s] = s;
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    while (stack.length) { const i = stack.pop()!; px.push(i); const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && band[j] && lab[j] < 0) { lab[j] = s; stack.push(j); } }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw < w * 0.12 || bh > bw / 3 || px.length < bw * 2) continue;
    // Its middle down each column.
    const sum = new Float64Array(bw), cnt = new Float64Array(bw);
    for (const i of px) { const x = i % w - x0; sum[x] += (i / w) | 0; cnt[x]++; }
    // Thickness: a band two lines tall is two lines joined, not one.
    let thick = 0, tc = 0; for (let x = 0; x < bw; x++) if (cnt[x]) { thick += cnt[x]; tc++; }
    const xs: number[] = [], ys: number[] = [];
    for (let x = 0; x < bw; x += 3) if (cnt[x]) { xs.push((x0 + x + 0.5) / w - 0.5); ys.push((sum[x] / cnt[x] + 0.5) / h - 0.5); }
    if (xs.length < 8) continue;
    // A band that wanders (two lines joined at a slant, a picture) is no line.
    { const r = lsq(xs.map((x) => [1, x, x * x]), ys, xs.map(() => 1)); if (!r) continue; let e = 0; xs.forEach((x, j) => { e += (ys[j] - r[0] - r[1] * x - r[2] * x * x) ** 2; }); if (Math.sqrt(e / xs.length) * h > Math.max(1.5, (thick / Math.max(1, tc)) * 0.4)) continue; }
    lines.push({ xs, ys, wt: bw / w, a: 0, thick: thick / Math.max(1, tc) } as Line & { thick: number });
  }
  if ((globalThis as { KR_CURVE_DEBUG?: boolean }).KR_CURVE_DEBUG) console.log('curve: lines', lines.length, 'gapMax', gapMax, 'w', w, 'h', h);
  if (lines.length < 5) return null;
  // Lines much thicker than most are two lines joined (or a picture): left out.
  const th = (lines as (Line & { thick: number })[]).map((l) => l.thick).sort((a, b) => a - b); const medT = th[th.length >> 1];
  const good = (lines as (Line & { thick: number })[]).filter((l) => l.thick < medT * 3);
  if (good.length < 5) return null;
  // Each line's own fit first (its place a), then slope and bend as smooth functions of a, fitted together.
  for (const l of good) { const r = lsq(l.xs.map((x) => [1, x, x * x]), l.ys, l.xs.map(() => 1)) ?? [l.ys.reduce((s, v) => s + v, 0) / l.ys.length, 0, 0]; l.a = r[0]; }
  let B = [0, 0, 0], C = [0, 0, 0];
  let use = good;
  for (let it = 0; it < 6; it++) {
    const rows: number[][] = [], ys: number[] = [], ws: number[] = [];
    for (const l of use) { const a = l.a; l.xs.forEach((x, j) => { rows.push([x, a * x, a * a * x, x * x, a * x * x, a * a * x * x]); ys.push(l.ys[j] - a); ws.push(l.wt); }); }
    const sol = lsq(rows, ys, ws); if (!sol) return null;
    B = sol.slice(0, 3); C = sol.slice(3, 6);
    const bOf = (a: number) => B[0] + B[1] * a + B[2] * a * a, cOf = (a: number) => C[0] + C[1] * a + C[2] * a * a;
    for (const l of use) { let s = 0; l.xs.forEach((x, j) => { s += l.ys[j] - bOf(l.a) * x - cOf(l.a) * x * x; }); l.a = s / l.xs.length; }
    // Lines that do not follow the rest (a picture's edge, a heading set at a slant) are dropped.
    const err = use.map((l) => { let s = 0; l.xs.forEach((x, j) => { const d = l.ys[j] - l.a - bOf(l.a) * x - cOf(l.a) * x * x; s += d * d; }); return Math.sqrt(s / l.xs.length); });
    const med = [...err].sort((a, b) => a - b)[err.length >> 1];
    const keep = use.filter((_, k) => err[k] <= Math.max(med * 3, 0.002));
    if (keep.length < 5) break;
    use = keep;
  }
  const as = use.map((l) => l.a).sort((a, b) => a - b);
  // Only a page whose lines really bend or slope is reshaped: the model must explain them clearly better than
  // straight level lines do.
  {
    const bOf = (a: number) => B[0] + B[1] * a + B[2] * a * a, cOf = (a: number) => C[0] + C[1] * a + C[2] * a * a;
    let e0 = 0, e1 = 0, m = 0, disp = 0;
    for (const l of use) {
      const mean = l.ys.reduce((s2, v) => s2 + v, 0) / l.ys.length;
      l.xs.forEach((x, j) => { e0 += (l.ys[j] - mean) ** 2; e1 += (l.ys[j] - l.a - bOf(l.a) * x - cOf(l.a) * x * x) ** 2; m++; });
      for (const x of [-0.5, 0.5]) disp = Math.max(disp, Math.abs(bOf(l.a) * x + cOf(l.a) * x * x));
    }
    if ((globalThis as { KR_CURVE_DEBUG?: boolean }).KR_CURVE_DEBUG) console.log('curve: used', use.length, 'disp', disp.toFixed(4), 'rms model', Math.sqrt(e1 / m).toFixed(5), 'rms flat', Math.sqrt(e0 / m).toFixed(5));
    if (disp < 0.004 || Math.sqrt(e1 / m) > Math.sqrt(e0 / m) * 0.6) { B = [0, 0, 0]; C = [0, 0, 0]; }
  }
  // Upright rules.
  const rl = new Int32Array(n).fill(-1); const rules: { e: number; f: number; g: number; wt: number }[] = []; const rulePts: [number, number][][] = [];
  for (let s = 0; s < n; s++) {
    if (!rule[s] || rl[s] >= 0) continue;
    const px: number[] = []; stack.push(s); rl[s] = s;
    while (stack.length) { const i = stack.pop()!; px.push(i); const x = i % w, y = (i / w) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue; const j = yy * w + xx; if (rule[j] && rl[j] < 0) { rl[j] = s; stack.push(j); } } }
    const sum = new Float64Array(h), cnt = new Float64Array(h); for (const i of px) { const y = (i / w) | 0; sum[y] += i % w; cnt[y]++; }
    const ys: number[] = [], xs: number[] = []; for (let y = 0; y < h; y += 3) if (cnt[y]) { ys.push((y + 0.5) / h - 0.5); xs.push((sum[y] / cnt[y] + 0.5) / w - 0.5); }
    if (ys.length < 10 || (ys[ys.length - 1] - ys[0]) < 0.25) continue;
    const r = lsq(ys.map((y) => [1, y, y * y]), xs, ys.map(() => 1)); if (!r) continue;
    rules.push({ e: r[0], f: r[1], g: r[2], wt: ys[ys.length - 1] - ys[0] });
    rulePts.push(xs.map((x, k) => [x, ys[k]]));
  }
  let F: [number, number] = [0, 0], G = 0;
  if (rules.length) {
    const tw = rules.reduce((s, r) => s + r.wt, 0); G = rules.reduce((s, r) => s + r.g * r.wt, 0) / tw;
    if (rules.length >= 2 && Math.max(...rules.map((r) => r.e)) - Math.min(...rules.map((r) => r.e)) > 0.2) { const s = lsq(rules.map((r) => [1, r.e]), rules.map((r) => r.f), rules.map((r) => r.wt)); if (s) F = [s[0], s[1]]; }
    else F = [rules.reduce((s, r) => s + r.f * r.wt, 0) / tw, 0];
  }
  const bent = B.some((v) => v) || rules.some((r) => Math.abs(r.f) > 0.008 || Math.abs(r.g) > 0.008);
  if ((globalThis as { KR_CURVE_DEBUG?: boolean }).KR_CURVE_DEBUG) console.log('curve: bent', bent, 'rules', rules.length);
  if (!bent) return null;
  // The sheet in space, when it explains the print well: perspective and curl together, the page's width
  // even across (the far side of a page is seen smaller).
  let sheet: Sheet | undefined;
  {
    const k = 2 / Math.max(w, h);
    const toN = (x: number, y: number): [number, number] => [x * w * k, y * h * k];
    const pick = (xs: number[], ys: number[], most: number) => { const out: [number, number][] = []; const stp = Math.max(1, Math.floor(xs.length / most)); for (let j = 0; j < xs.length; j += stp) out.push(toN(xs[j], ys[j])); return out; };
    const lns = use.map((l) => ({ pts: pick(l.xs, l.ys, 14) }));
    const rls = rulePts.map((r) => ({ pts: pick(r.map((p) => p[0]), r.map((p) => p[1]), 20) }));
    try {
      let fit = fitSheet(lns, rls);
      // Lines the sheet does not explain (joined, or part of a picture) are left out, and it is fitted again.
      for (let round = 0; fit && round < 2; round++) {
        const errs = [...fit.lineErr].sort((a, b) => a - b); const med = errs[errs.length >> 1];
        const lim = Math.max(med * 2.5, 1.2 * k);
        const keep = lns.filter((_, i) => fit!.lineErr[i] <= lim);
        if (keep.length === lns.length || keep.length < 5) break;
        lns.splice(0, lns.length, ...keep); fit = fitSheet(lns, rls);
      }
      // How much the sheet magnifies (area) at a point of it; NaN outside the photo.
      const magnif = (sh: Sheet, R: number[], X: number, Y: number) => {
        const e = 0.01; const p = sheetProject(R, sh.tv, sh.c, sh.W, sh.f, X, Y), px = sheetProject(R, sh.tv, sh.c, sh.W, sh.f, X + e, Y), py = sheetProject(R, sh.tv, sh.c, sh.W, sh.f, X, Y + e);
        if (Math.abs(p[0] / k) > w / 2 || Math.abs(p[1] / k) > h / 2) return NaN;
        return ((px[0] - p[0]) * (py[1] - p[1]) - (px[1] - p[1]) * (py[0] - p[0])) / (e * e);
      };
      // A sheet must be a plausible page where its print is: in front of the camera, not folded over, its
      // scale across that part within reason.
      let lo = Infinity, hi = 0;
      if (fit) {
        const sh = fit.sheet; const R = rodrigues(sh.rv); let ok = true;
        for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) {
          const d = magnif(sh, R, sh.x0 + ((sh.x1 - sh.x0) * i) / 8, sh.y0 + ((sh.y1 - sh.y0) * j) / 8);
          if (Number.isNaN(d)) continue; if (!(d > 0)) ok = false; lo = Math.min(lo, d); hi = Math.max(hi, d);
        }
        if (!ok || !(hi > 0) || hi > lo * 4 || Math.max(...sh.c.map(Math.abs)) > 1.5) fit = null;
      }
      // The page's extent: where its ink is, seen flat (the lines found may not reach every word) — but only as
      // far as the sheet stays as plausible as where the print was.
      if (fit) {
        const sh = { ...fit.sheet }; const padX = (sh.x1 - sh.x0) * 0.5, padY = (sh.y1 - sh.y0) * 0.3;
        sh.x0 -= padX; sh.x1 += padX; sh.y0 -= padY; sh.y1 += padY;
        const R = rodrigues(sh.rv); const step = 0.006; let ex0 = Infinity, ex1 = -Infinity, ey0 = Infinity, ey1 = -Infinity;
        for (let Y = sh.y0; Y <= sh.y1; Y += step) for (let X = sh.x0; X <= sh.x1; X += step) {
          const p = sheetProject(R, sh.tv, sh.c, sh.W, sh.f, X, Y); const px = Math.round(p[0] / k + w / 2), py = Math.round(p[1] / k + h / 2);
          if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue;
          if (!ink[py * w + px] && !rule[py * w + px]) continue;
          if (X < ex0 || X > ex1 || Y < ey0 || Y > ey1) { const d = magnif(sh, R, X, Y); if (!(d > lo / 2 && d < hi * 2)) continue; }
          if (X < ex0) ex0 = X; if (X > ex1) ex1 = X; if (Y < ey0) ey0 = Y; if (Y > ey1) ey1 = Y;
        }
        if (ex1 > ex0) {
          // A rule near a side is the page's frame: past it lies only the margin — or the next page beyond the fold.
          const span = ex1 - ex0;
          for (const X of fit.ruleX) {
            if (X > ex0 + span * 0.8 && X < ex1) ex1 = Math.min(ex1, X + span * 0.025);
            if (X < ex0 + span * 0.2 && X > ex0) ex0 = Math.max(ex0, X - span * 0.025);
          }
          const mg = 0.025 * Math.max(ex1 - ex0, ey1 - ey0); fit.sheet = { ...fit.sheet, x0: ex0 - mg, x1: ex1 + mg, y0: ey0 - mg, y1: ey1 + mg };
        }
      }
      if ((globalThis as { KR_CURVE_DEBUG?: boolean }).KR_CURVE_DEBUG) console.log('curve: sheet fit', !!fit, fit ? (fit.rms * Math.max(w, h)).toFixed(2) : '');
      if (fit && fit.rms < 7 / Math.max(w, h)) sheet = fit.sheet;
    } catch { /* the simpler model stands */ }
  }
  const cv: Curve = { sheet, b: B as Curve['b'], c: C as Curve['c'], aLo: as[0], aHi: as[as.length - 1], f: F, g: G, eLo: rules.length ? Math.min(...rules.map((r) => r.e)) : 0, eHi: rules.length ? Math.max(...rules.map((r) => r.e)) : 0, crop: { l: 0, r: 0, t: 0, b: 0 } };
  return cv;
}

/** Sample source position for an output point, in fractions from the middle. */
function curveSource(cv: Curve, u: number, v: number, bv: number, cvv: number, fu: number): [number, number] {
  let x = u, y = v;
  for (let k = 0; k < 4; k++) { y = v + bv * x + cvv * x * x; x = u + fu * y + cv.g * y * y; }
  return [x, y];
}

/** The page with its lines straightened (and its margins cut as the curve says). */
export function unwarp(img: Img, cv: Curve): Img {
  if (cv.grid) {
    const out = gridUnwarp(img, cv.grid); const { l, r, t, b } = cv.crop;
    if (!(l || r || t || b)) return out;
    const x0 = Math.round(l * out.width), x1 = Math.round((1 - r) * out.width), y0 = Math.round(t * out.height), y1 = Math.round((1 - b) * out.height);
    const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0); const res = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) res.set(out.data.subarray(((y + y0) * out.width + x0) * 4, ((y + y0) * out.width + x0 + cw) * 4), y * cw * 4);
    return { data: res, width: cw, height: ch };
  }
  if (cv.sheet) return sheetUnwarp(img, cv.sheet);
  const { width: W, height: H, data: d } = img;
  const { l, r, t, b } = cv.crop;
  const ow = Math.max(1, Math.round(W * (1 - l - r))), oh = Math.max(1, Math.round(H * (1 - t - b)));
  const out = new Uint8ClampedArray(ow * oh * 4);
  const clampA = (a: number) => clamp(a, cv.aLo, cv.aHi), clampE = (e: number) => clamp(e, cv.eLo, cv.eHi);
  const bRow = new Float64Array(oh), cRow = new Float64Array(oh), fCol = new Float64Array(ow);
  for (let y = 0; y < oh; y++) { const v = (y + 0.5) / H + t - 0.5; const a = clampA(v); bRow[y] = cv.b[0] + cv.b[1] * a + cv.b[2] * a * a; cRow[y] = cv.c[0] + cv.c[1] * a + cv.c[2] * a * a; }
  for (let x = 0; x < ow; x++) { const u = (x + 0.5) / W + l - 0.5; fCol[x] = cv.f[0] + cv.f[1] * clampE(u); }
  for (let y = 0; y < oh; y++) {
    const v = (y + 0.5) / H + t - 0.5;
    for (let x = 0; x < ow; x++) {
      const u = (x + 0.5) / W + l - 0.5;
      const [sxn, syn] = curveSource(cv, u, v, bRow[y], cRow[y], fCol[x]);
      const sx = (sxn + 0.5) * W - 0.5, sy = (syn + 0.5) * H - 0.5;
      if (sx < -1 || sy < -1 || sx > W || sy > H) { const o = (y * ow + x) * 4; out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = 0; continue; }
      const x0 = clamp(Math.floor(sx), 0, W - 1), y0 = clamp(Math.floor(sy), 0, H - 1), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
      const fx = clamp(sx - x0, 0, 1), fy = clamp(sy - y0, 0, 1);
      const o = (y * ow + x) * 4, A = (y0 * W + x0) * 4, Bq = (y0 * W + x1) * 4, Cq = (y1 * W + x0) * 4, E = (y1 * W + x1) * 4;
      for (let ch = 0; ch < 3; ch++) out[o + ch] = (d[A + ch] * (1 - fx) + d[Bq + ch] * fx) * (1 - fy) + (d[Cq + ch] * (1 - fx) + d[E + ch] * fx) * fy;
      out[o + 3] = 255;
    }
  }
  // Rows and columns along the edges that fall outside the photo are cut off; any left inside become paper.
  const bad = (x: number, y: number) => out[(y * ow + x) * 4 + 3] === 0;
  const rowBad = (y: number) => { let c = 0; for (let x = 0; x < ow; x += 2) if (bad(x, y)) c++; return c > ow * 0.15; };
  const colBad = (x: number, y0: number, y1: number) => { let c = 0; for (let y = y0; y < y1; y += 2) if (bad(x, y)) c++; return c > (y1 - y0) * 0.15; };
  let top = 0, bot = oh; while (top < oh * 0.2 && rowBad(top)) top++; while (bot > oh * 0.8 && rowBad(bot - 1)) bot--;
  let left = 0, right = ow; while (left < ow * 0.2 && colBad(left, top, bot)) left++; while (right > ow * 0.8 && colBad(right - 1, top, bot)) right--;
  const cw = right - left, ch = bot - top;
  const res = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const i = ((y + top) * ow + x + left) * 4, o = (y * cw + x) * 4; if (out[i + 3]) { res[o] = out[i]; res[o + 1] = out[i + 1]; res[o + 2] = out[i + 2]; } else res[o] = res[o + 1] = res[o + 2] = 255; res[o + 3] = 255; }
  return { data: res, width: cw, height: ch };
}

/**
 * A book's own edge or the next page beyond the fold, left along a side of the picture, cut away: a band
 * near the side (within 15%) clearly darker than the paper, with the picture cut where the paper is bright
 * again on the inside of it.
 */
export function trimMargins(img: Img, sides: 'all' | 'lr' = 'all'): Img {
  const { width: W, height: H, data: d } = img;
  const lum = (x: number, y: number) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
  const prof = (n: number, m: number, at: (i: number, j: number) => number) => {
    const out = new Float32Array(n); const vals: number[] = [];
    for (let i = 0; i < n; i++) { vals.length = 0; for (let j = Math.floor(m * 0.1); j < m * 0.9; j += 4) vals.push(at(i, j)); vals.sort((a, b) => a - b); out[i] = vals[Math.floor(vals.length * 0.75)] ?? 255; }
    return out;
  };
  const cols = prof(W, H, (x, y) => lum(x, y)), rows = prof(H, W, (y, x) => lum(x, y));
  const cut = (p: Float32Array, fromEnd: boolean): number => {
    const n = p.length; const mid = Array.from(p.slice(Math.floor(n * 0.25), Math.ceil(n * 0.75))).sort((a, b) => a - b); const paper = mid[mid.length >> 1];
    const band = Math.floor(n * 0.15); let pm = -1, mv = Infinity;
    for (let k = 0; k < band; k++) { const i = fromEnd ? n - 1 - k : k; if (p[i] < mv) { mv = p[i]; pm = k; } }
    if (pm < 0 || mv > paper * 0.8) return 0;
    let k = pm; while (k < band * 1.4 && p[fromEnd ? n - 1 - k : k] < paper * 0.9) k++;
    return k < band * 1.4 ? k + Math.round(n * 0.004) : 0;
  };
  // What would be cut must not be print like the page's own: ink as dense there means it is the page.
  const inkIn = (x0: number, x1: number, y0: number, y1: number) => { let c = 0, n = 0; for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) { n++; if (lum(x, y) < 90) c++; } return n ? c / n : 0; };
  const pageInk = inkIn(Math.floor(W * 0.2), Math.floor(W * 0.8), Math.floor(H * 0.2), Math.floor(H * 0.8));
  const sane = (k: number, ink: number) => (k && ink < pageInk * 0.45 ? k : 0);
  let l = cut(cols, false), r = cut(cols, true), t = sides === 'all' ? cut(rows, false) : 0, b = sides === 'all' ? cut(rows, true) : 0;
  l = sane(l, inkIn(0, l, 0, H)); r = sane(r, inkIn(W - r, W, 0, H)); t = sane(t, inkIn(0, W, 0, t)); b = sane(b, inkIn(0, W, H - b, H));
  if (!l && !r && !t && !b) return img;
  const ow = W - l - r, oh = H - t - b; if (ow < W * 0.6 || oh < H * 0.6) return img;
  const out = new Uint8ClampedArray(ow * oh * 4);
  for (let y = 0; y < oh; y++) out.set(d.subarray(((y + t) * W + l) * 4, ((y + t) * W + l + ow) * 4), y * ow * 4);
  return { data: out, width: ow, height: oh };
}
