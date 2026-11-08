// The words taken off the picture behind them, on a computer: the same rules as the phone's (KtInpaint.java) — the
// background guessed from the ring of pixels around the block (its edges, median-smoothed, blended across: a Coons
// patch), the pixels far from the guess (letters, outlines) and two around them replaced by it, then softened.
export function clean(px: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(px); if (w < 4 || h < 4) return out;
  const edge = (side: number): number[][] => {
    const n = side < 2 ? w : h; const ch = [new Array<number>(n), new Array<number>(n), new Array<number>(n)];
    for (let i = 0; i < n; i++) { const o = 4 * (side === 0 ? i : side === 1 ? (h - 1) * w + i : side === 2 ? i * w : i * w + w - 1); for (let c = 0; c < 3; c++) ch[c][i] = px[o + c]; }
    const win = Math.max(2, Math.floor(n / 6));
    return ch.map((src) => src.map((_, i) => { const b: number[] = []; for (let j = i - win; j <= i + win; j++) b.push(src[Math.max(0, Math.min(n - 1, j))]); b.sort((a, c) => a - c); return b[b.length >> 1]; }));
  };
  const T = edge(0), B = edge(1), L = edge(2), R = edge(3); const guess = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) { const v = y / (h - 1); for (let x = 0; x < w; x++) { const u = x / (w - 1); const o = 4 * (y * w + x);
    for (let c = 0; c < 3; c++) guess[o + c] = (1 - v) * T[c][x] + v * B[c][x] + (1 - u) * L[c][y] + u * R[c][y] - ((1 - u) * (1 - v) * T[c][0] + u * (1 - v) * T[c][w - 1] + (1 - u) * v * B[c][0] + u * v * B[c][w - 1]);
    guess[o + 3] = 255; } }
  const dist = (o: number) => { const dr = px[o] - guess[o], dg = px[o + 1] - guess[o + 1], db = px[o + 2] - guess[o + 2]; return Math.sqrt((dr * dr * 3 + dg * dg * 4 + db * db * 2) / 9); };
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (dist(4 * (y * w + x)) <= 46) continue; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) mask[yy * w + xx] = 1; } }
  for (let i = 0; i < w * h; i++) if (mask[i]) for (let c = 0; c < 4; c++) out[4 * i + c] = guess[4 * i + c];
  for (let pass = 0; pass < 2; pass++) { const b = new Uint8ClampedArray(out);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (!mask[i]) continue; for (let c = 0; c < 3; c++) { let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += out[4 * (i + dy * w + dx) + c]; b[4 * i + c] = s / 9; } }
    out.set(b); }
  return out;
}
