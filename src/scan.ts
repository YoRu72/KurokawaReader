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

/** The page in a photo. When nothing stands out from its surroundings (a page that fills the frame) the whole
 *  photo is the page. */
export function detectPage(img: Img, debug?: (c: Found[]) => void): Found {
  const sm = small(img, 480);
  const full: Quad = [{ x: 0, y: 0 }, { x: img.width, y: 0 }, { x: img.width, y: img.height }, { x: 0, y: img.height }];
  const up = (q: Pt[]): Quad => orderQuad(q.map((p) => ({ x: clamp(p.x * sm.k, 0, img.width), y: clamp(p.y * sm.k, 0, img.height) })));
  const byShape = shapeQuad(sm);
  const byEdges = edgeQuad(sm);
  const A = sm.w * sm.h;
  const cands: Found[] = [];
  if (byShape) cands.push({ quad: up(byShape.q), how: 'shape', score: byShape.score });
  if (byEdges) cands.push({ quad: up(byEdges.q), how: 'edges', score: byEdges.score });
  // (The paper's own outline wins over lines printed on it, unless the outline is the whole frame.)
  debug?.(cands);
  void A;
  const frac = (c: Found) => area(c.quad) / (img.width * img.height);
  // The paper's own outline, when it is clear, is the answer: lines and frames printed or drawn on the page
  // are not its edges. When the paper fills the photo, the photo is the page.
  const shape = cands.find((c) => c.how === 'shape');
  const board = cands.find((c) => c.how === 'edges' && c.score >= 0.85 && frac(c) > 0.3);
  if (shape && shape.score >= 0.8 && frac(shape) > 0.12) return frac(shape) >= 0.95 ? (board ?? { quad: full, how: 'frame', score: shape.score }) : shape;
  const good = cands.filter((c) => c.score > 0.5 && frac(c) > 0.12 && frac(c) < 0.985);
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

/** The page as four straight edges in the photo (Hough lines), for a page that does not stand out by colour. */
function edgeQuad(sm: ReturnType<typeof small>): { q: Pt[]; score: number } | null {
  const { w, h, L } = sm;
  // Smooth, then gradients.
  const blur = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, c = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue; s += L[yy * w + xx]; c++; } blur[y * w + x] = s / c; }
  const mag = new Float32Array(w * h); const ang = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = blur[i - w + 1] + 2 * blur[i + 1] + blur[i + w + 1] - blur[i - w - 1] - 2 * blur[i - 1] - blur[i + w - 1];
    const gy = blur[i + w - 1] + 2 * blur[i + w] + blur[i + w + 1] - blur[i - w - 1] - 2 * blur[i - w] - blur[i - w + 1];
    mag[i] = Math.hypot(gx, gy); ang[i] = Math.atan2(gy, gx);
  }
  const sorted = Float32Array.from(mag).sort(); const thr = Math.max(40, sorted[Math.floor(sorted.length * 0.9)]);
  const edge = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) edge[i] = mag[i] > thr ? 1 : 0;
  // Hough: theta in degrees 0..179, rho offset by the diagonal.
  const D = Math.ceil(Math.hypot(w, h)); const T = 180; const acc = new Int32Array(T * (2 * D + 1));
  const cs = Array.from({ length: T }, (_, t) => Math.cos((t * Math.PI) / 180)), sn = Array.from({ length: T }, (_, t) => Math.sin((t * Math.PI) / 180));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!edge[i]) continue;
    // Only the angles near the gradient's normal vote (an edge pixel lies on a line across its gradient).
    const a = ((ang[i] * 180) / Math.PI + 360) % 180;
    for (let d = -12; d <= 12; d++) { const t = (Math.round(a) + d + 180) % 180; const r = Math.round(x * cs[t] + y * sn[t]) + D; acc[t * (2 * D + 1) + r]++; }
  }
  // Peaks, with neighbours suppressed.
  type Line = { t: number; r: number; v: number };
  const peaks: Line[] = [];
  const minVotes = Math.min(w, h) * 0.12;
  for (let t = 0; t < T; t++) for (let r = 0; r < 2 * D + 1; r++) {
    const v = acc[t * (2 * D + 1) + r]; if (v < minVotes) continue;
    let isMax = true;
    for (let dt = -3; dt <= 3 && isMax; dt++) for (let dr = -6; dr <= 6; dr++) { if (!dt && !dr) continue; const tt = (t + dt + T) % T, rr = r + dr; if (rr < 0 || rr > 2 * D) continue; if (acc[tt * (2 * D + 1) + rr] > v) { isMax = false; break; } }
    if (isMax) peaks.push({ t, r: r - D, v });
  }
  peaks.sort((a, b) => b.v - a.v);
  const top = peaks.slice(0, 24);
  const two = (l: Line): [Pt, Pt] => { const c = cs[l.t], s = sn[l.t]; const x0 = c * l.r, y0 = s * l.r; return [{ x: x0, y: y0 }, { x: x0 - s * 1000, y: y0 + c * 1000 }]; };
  // Horizontal-ish lines have normals near 90°, vertical-ish near 0/180°.
  const H = top.filter((l) => Math.abs(l.t - 90) < 35), V = top.filter((l) => l.t < 35 || l.t > 145);
  const support = (a: Pt, b: Pt) => { const n = 60; let hit = 0; for (let k = 0; k <= n; k++) { const x = Math.round(a.x + ((b.x - a.x) * k) / n), y = Math.round(a.y + ((b.y - a.y) * k) / n); let on = 0; for (let dy = -2; dy <= 2 && !on; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && edge[yy * w + xx]) { on = 1; break; } } hit += on; } return hit / (n + 1); };
  let best: { q: Pt[]; score: number } | null = null;
  for (let i = 0; i < H.length; i++) for (let j = i + 1; j < H.length; j++) for (let k = 0; k < V.length; k++) for (let m = k + 1; m < V.length; m++) {
    const [h1, h2, v1, v2] = [two(H[i]), two(H[j]), two(V[k]), two(V[m])];
    const c = [lineX(...h1, ...v1), lineX(...h1, ...v2), lineX(...h2, ...v2), lineX(...h2, ...v1)];
    if (c.some((p) => !p || p.x < -w * 0.02 || p.y < -h * 0.02 || p.x > w * 1.02 || p.y > h * 1.02)) continue;
    const q = orderQuad(c as Pt[]); const a = area(q) / (w * h);
    if (a < 0.15) continue;
    const s = (support(q[0], q[1]) + support(q[1], q[2]) + support(q[2], q[3]) + support(q[3], q[0])) / 4;
    // A sheet's edge has paper on one side and something else on the other; a line printed on the page has
    // paper on both. At least two sides (those inside the photo) must be such steps.
    let steps = 0, inside = 0;
    for (let e = 0; e < 4; e++) {
      const a2 = q[e], b2 = q[(e + 1) % 4];
      const nx = -(b2.y - a2.y), ny = b2.x - a2.x, nl = Math.hypot(nx, ny) || 1; const cx = (q[0].x + q[2].x) / 2, cy = (q[0].y + q[2].y) / 2;
      const mx = (a2.x + b2.x) / 2, my = (a2.y + b2.y) / 2; const sgn = (cx - mx) * nx + (cy - my) * ny > 0 ? 1 : -1;
      const off = 5; let din = 0, dout = 0, cnt = 0;
      for (let t = 0.1; t <= 0.9; t += 0.05) {
        const x = a2.x + (b2.x - a2.x) * t, y = a2.y + (b2.y - a2.y) * t;
        const xi = Math.round(x + (sgn * nx / nl) * off), yi = Math.round(y + (sgn * ny / nl) * off), xo = Math.round(x - (sgn * nx / nl) * off), yo = Math.round(y - (sgn * ny / nl) * off);
        if (xo < 0 || yo < 0 || xo >= w || yo >= h || xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
        din += blur[yi * w + xi]; dout += blur[yo * w + xo]; cnt++;
      }
      if (cnt < 5) continue;
      inside++;
      if (Math.abs(din - dout) / cnt > 22) steps++;
    }
    if (inside && steps < Math.min(2, inside)) continue;
    const score = s * (0.6 + 0.4 * Math.sqrt(a));
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

export type Adjust = { brightness?: number; contrast?: number };

/** A filter applied: `auto` evens the light and whitens the paper keeping colour; `color` does so with livelier
 *  colour; `gray` in greys; `bw` as clean black on white (for text); `original` leaves it. */
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
  // Ink level: the dark end of the evened page, so faint print gets darker too.
  const norm = new Float32Array(n);
  for (let i = 0; i < n; i++) norm[i] = clamp((lum[i] / Math.max(30, light[i])) * 255, 0, 255);
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
  for (let i = 0; i < n; i++) {
    const o = i * 4; const L = stretch(norm[i]);
    if (f === 'gray') { out[o] = out[o + 1] = out[o + 2] = finish(L); out[o + 3] = 255; continue; }
    // Colour: each channel lifted by the same factor as the light, then its distance from grey widened.
    const k = L / Math.max(1, lum[i]);
    const r = d[o] * k, g = d[o + 1] * k, b = d[o + 2] * k; const m = (r + g + b) / 3;
    out[o] = finish(m + (r - m) * sat); out[o + 1] = finish(m + (g - m) * sat); out[o + 2] = finish(m + (b - m) * sat); out[o + 3] = 255;
  }
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

/* ---------------------------------------------------------------- curved pages */

/**
 * How a page photographed in a book bends: its lines of print as curves y = a + b(a)·x + c(a)·x² (x across
 * the page, both in fractions of the picture, from its middle), its upright rules as x = e + f(e)·y + g·y²,
 * and the margins to cut away (the book's edge, the next page beyond the fold), as fractions.
 */
export type Curve = { b: [number, number, number]; c: [number, number, number]; aLo: number; aHi: number; f: [number, number]; g: number; eLo: number; eHi: number; crop: { l: number; r: number; t: number; b: number }; sheet?: Sheet };

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
