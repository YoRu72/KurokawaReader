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
