// A QR code drawn by the app itself (byte mode, versions 1–10, error correction M): an address another phone
// scans — the Wi-Fi share, a link handed over. Returns the modules as rows of booleans, and an SVG of them.

const EC_M: Record<number, [number, number, number]> = { // version: [data codewords, EC codewords per block, blocks]
  1: [16, 10, 1], 2: [28, 16, 1], 3: [44, 26, 1], 4: [64, 18, 2], 5: [86, 24, 2], 6: [108, 16, 4], 7: [124, 18, 4], 8: [154, 22, 4], 9: [182, 22, 5], 10: [216, 26, 5],
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

// GF(256) with the QR polynomial 0x11d.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function ecCodewords(data: number[], n: number): number[] {
  let gen = [1]; for (let i = 0; i < n; i++) { const nx = new Array(gen.length + 1).fill(0); for (let j = 0; j < gen.length; j++) { nx[j] ^= gen[j]; nx[j + 1] ^= mul(gen[j], EXP[i]); } gen = nx; }
  const res = new Array(n).fill(0);
  for (const d of data) { const f = d ^ res[0]; res.shift(); res.push(0); if (f) for (let j = 0; j < n; j++) res[j] ^= mul(gen[j + 1], f); }
  return res;
}

/** The modules of a QR code holding `text` (UTF-8), or null when it does not fit version 10 (≈ 213 bytes). */
export function qrModules(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  let ver = 0; for (let v = 1; v <= 10; v++) { const cap = EC_M[v][0] - (v < 10 ? 2 : 3); if (bytes.length <= cap) { ver = v; break; } }
  if (!ver) return null;
  const [dataLen, ecLen, blocks] = EC_M[ver];
  // Bits: mode 0100, the count (8 bits under version 10, 16 at 10), the bytes, a terminator, padding.
  const bits: number[] = []; const push = (v: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  push(4, 4); push(bytes.length, ver < 10 ? 8 : 16); for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataLen * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data: number[] = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0; data.length < dataLen; pad++) data.push(pad % 2 ? 0x11 : 0xec);
  // Blocks (the shorter first, then the longer), interleaved, with their EC codewords.
  const short = Math.floor(dataLen / blocks), longer = dataLen - short * blocks; const bl: number[][] = []; const ec: number[][] = []; let at = 0;
  for (let b = 0; b < blocks; b++) { const len = short + (b >= blocks - longer ? 1 : 0); const d = data.slice(at, at + len); at += len; bl.push(d); ec.push(ecCodewords(d, ecLen)); }
  const seq: number[] = []; for (let i = 0; i < short + 1; i++) for (const d of bl) if (i < d.length) seq.push(d[i]); for (let i = 0; i < ecLen; i++) for (const e of ec) seq.push(e[i]);
  // The matrix: finders, timing, alignment, the dark module, then the data snaked in, then the best mask.
  const n = ver * 4 + 17; const m: number[][] = Array.from({ length: n }, () => new Array(n).fill(-1));
  const put = (r: number, c: number, v: number) => { if (r >= 0 && c >= 0 && r < n && c < n) m[r][c] = v; };
  const finder = (r: number, c: number) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const on = i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)); put(r + i, c + j, on ? 1 : 0); } };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { m[6][i] = i % 2 ? 0 : 1; m[i][6] = i % 2 ? 0 : 1; }
  const al = ALIGN[ver]; for (const r of al) for (const c of al) { if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) put(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) === 1 ? 0 : 1); }
  m[n - 8][8] = 1;
  const fmtCells: [number, number][] = []; for (let i = 0; i < 6; i++) fmtCells.push([8, i]); fmtCells.push([8, 7], [8, 8], [7, 8]); for (let i = 5; i >= 0; i--) fmtCells.push([i, 8]);
  for (let i = 0; i < 8; i++) { m[8][n - 1 - i] = m[8][n - 1 - i] === -1 ? 0 : m[8][n - 1 - i]; m[n - 1 - i][8] = m[n - 1 - i][8] === -1 ? 0 : m[n - 1 - i][8]; }
  for (const [r, c] of fmtCells) if (m[r][c] === -1) m[r][c] = 0;
  if (ver >= 7) for (let i = 0; i < 18; i++) { m[Math.floor(i / 3)][n - 11 + (i % 3)] = 0; m[n - 11 + (i % 3)][Math.floor(i / 3)] = 0; }
  const reserved = m.map((row) => row.map((v) => v !== -1));
  let bi = 0; const all = seq.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1));
  let up = true; for (let col = n - 1; col > 0; col -= 2) { if (col === 6) col--; for (let k = 0; k < n; k++) { const row = up ? n - 1 - k : k; for (const c of [col, col - 1]) if (!reserved[row][c]) { m[row][c] = all[bi++] ?? 0; } } up = !up; }
  const masks: ((r: number, c: number) => boolean)[] = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (_r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
  const apply = (mk: number): number[][] => m.map((row, r) => row.map((v, c) => (reserved[r][c] ? v : masks[mk](r, c) ? v ^ 1 : v)));
  const penalty = (g: number[][]): number => { let p = 0; for (let r = 0; r < n; r++) { let run = 1; for (let c = 1; c < n; c++) { if (g[r][c] === g[r][c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } } for (let c = 0; c < n; c++) { let run = 1; for (let r = 1; r < n; r++) { if (g[r][c] === g[r - 1][c]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } } let dark = 0; for (const row of g) for (const v of row) dark += v; p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10; return p; };
  let best = 0, bestP = Infinity, bestG: number[][] = m;
  for (let mk = 0; mk < 8; mk++) { const g = apply(mk); const p = penalty(g); if (p < bestP) { bestP = p; best = mk; bestG = g; } }
  // Format information (EC level M = 00, the mask), BCH-coded and XORed with 101010000010010.
  let f = (0 << 3) | best; let bch = f << 10; for (let i = 14; i >= 10; i--) if ((bch >> i) & 1) bch ^= 0x537 << (i - 10); const fmt = ((f << 10) | bch) ^ 0x5412;
  const fbits = Array.from({ length: 15 }, (_, i) => (fmt >> (14 - i)) & 1);
  fmtCells.forEach(([r, c], i) => { bestG[r][c] = fbits[i]; });
  for (let i = 0; i < 8; i++) bestG[8][n - 1 - i] = fbits[14 - i];
  for (let i = 0; i < 7; i++) bestG[n - 1 - i][8] = fbits[i];
  bestG[n - 8][8] = 1;
  if (ver >= 7) { // version information below the top-right finder and left of the bottom-left one
    let vb = ver << 12; for (let i = 17; i >= 12; i--) if ((vb >> i) & 1) vb ^= 0x1f25 << (i - 12); const vinfo = (ver << 12) | vb;
    for (let i = 0; i < 18; i++) { const bit = (vinfo >> i) & 1; bestG[Math.floor(i / 3)][n - 11 + (i % 3)] = bit; bestG[n - 11 + (i % 3)][Math.floor(i / 3)] = bit; }
  }
  return bestG.map((row) => row.map((v) => v === 1));
}

/** The code as an SVG (dark on light, a quiet zone of 4 modules), `size` pixels wide. */
export function qrSvg(text: string, size = 220): string {
  const g = qrModules(text); if (!g) return '';
  const n = g.length; const q = 4; const w = n + q * 2; let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (g[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${w}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${w}" height="${w}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
