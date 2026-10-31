// node tests/scanbench/pipe.mjs <out-dir> <photo.jpg...>: the scanner's whole treatment of each photo, as the app
// does it (find the page, its bend and its turn on a 1200-px copy; the page made from a larger copy), written as
// <name>-found.png (the photo with the page found), <name>-page.png (the result) and <name>.json (timings, what
// was found). Photos are decoded by Python (PIL), so this runs without a browser.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const [out, ...photos] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const here = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(os.tmpdir(), `scanpipe-${process.pid}.mjs`);
await build({ stdin: { contents: `export * from './src/scan.ts'; export { render, curveOf } from './src/scanops.ts';`, resolveDir: path.resolve(here, '../..'), loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: tmp, logLevel: 'silent', external: [] });
const S = await import(tmp); globalThis.KR_CURVE_DEBUG = !!process.env.DBG; globalThis.KR_MOIRE_DEBUG = !!process.env.MOIRE; globalThis.KR_GLARE_DEBUG = !!process.env.GLARE; globalThis.KR_TURN_DEBUG = !!process.env.DBG; globalThis.KR_SW = process.env.SW; globalThis.KR_LAM = process.env.LAM; globalThis.KR_GX = process.env.GX; globalThis.KR_R2 = process.env.R2; globalThis.KR_LX = process.env.LX; globalThis.KR_L1 = process.env.L1; globalThis.KR_MODEL = process.env.MODEL; globalThis.KR_K = process.env.K; globalThis.KR_LA = process.env.LA; globalThis.KR_LR = process.env.LR; globalThis.KR_NOARC = !!process.env.NOARC;
if (process.env.DBG) globalThis.KR_GRID_DUMP = (band, w, h, pieces) => {
  const img = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  for (let i = 0; i < w * h; i++) { const v = band[i] ? 160 : 255; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  for (const o of globalThis.KR_SLOPES ?? []) { const x1 = o.u1 * w, x2 = o.u2 * w, y = o.v * h, dy = o.d * h; for (let k = 0; k <= 20; k++) { const x = Math.round(x1 + (x2 - x1) * k / 20), yy = Math.round(y - dy / 2 + dy * k / 20); const i = (yy * w + x) * 4; if (i >= 0 && i < img.data.length) { img.data[i] = 0; img.data[i + 1] = 160; img.data[i + 2] = 255; } } }
  for (const [u, v] of globalThis.KR_PEAKS ?? []) { const x = Math.round(u * w), y = Math.round(v * h); for (let d = -1; d <= 1; d++) { const i = ((y + d) * w + x) * 4; if (i >= 0 && i < img.data.length) { img.data[i] = 255; img.data[i + 1] = 0; img.data[i + 2] = 255; } } }
  pieces.forEach((p, k) => { const c = [[220, 0, 0], [0, 140, 0], [0, 0, 220], [200, 120, 0]][k % 4]; for (const [u, v] of p.pts) { const x = Math.round(u * w), y = Math.round(v * h); for (let d = -2; d <= 2; d++) for (let e = -2; e <= 2; e++) { const i = ((y + d) * w + x + e) * 4; if (i >= 0 && i < img.data.length) { img.data[i] = c[0]; img.data[i + 1] = c[1]; img.data[i + 2] = c[2]; } } } });
  globalThis.__dump = img;
};
const filter = process.env.FILTER || 'auto';
const SIDE = Number(process.env.SIDE || 2400);

const py = (code, ...args) => execFileSync('python3', ['-c', code, ...args], { maxBuffer: 1 << 30 });
const load = (file, max) => {
  const raw = path.join(os.tmpdir(), `scanpipe-${process.pid}.rgba`);
  const meta = JSON.parse(py(`
import sys, json
from PIL import Image, ImageOps
im = ImageOps.exif_transpose(Image.open(sys.argv[1])).convert('RGBA'); m = int(sys.argv[2]); k = min(1, m / max(im.size))
if k < 1: im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
open(sys.argv[3], 'wb').write(im.tobytes()); print(json.dumps({'w': im.width, 'h': im.height}))`, file, String(max), raw).toString());
  const img = { data: new Uint8ClampedArray(fs.readFileSync(raw)), width: meta.w, height: meta.h };
  fs.rmSync(raw); return img;
};
const save = (img, file) => {
  const raw = path.join(os.tmpdir(), `scanpipe-${process.pid}-o.rgba`); fs.writeFileSync(raw, Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
  py(`
import sys
from PIL import Image
Image.frombytes('RGBA', (int(sys.argv[2]), int(sys.argv[3])), open(sys.argv[1], 'rb').read()).convert('RGB').save(sys.argv[4])`, raw, String(img.width), String(img.height), file);
  fs.rmSync(raw);
};
const FULL = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

for (const photo of photos) {
  const name = path.basename(photo).replace(/\.[^.]+$/, '');
  const t = {}; let t0 = performance.now();
  const preview = load(photo, 1200);
  const prep = (S.prepareLook ?? null);
  let look;
  if (prep) { look = prep(preview, { autoCrop: true, autoTurn: true, flatten: true, filter, rtl: true }); }
  else {
    look = { quad: FULL, curve: null, flatten: true, turn: 0, filter, adj: {} };
    const f = S.detectPage(preview); look.quad = f.quad.map((c) => ({ x: c.x / preview.width, y: c.y / preview.height })); look.how = f.how;
    t.detect = Math.round(performance.now() - t0); t0 = performance.now();
    const flat = S.render(preview, { ...look, curve: null, turn: 0, filter: 'original', adj: {} }, 900);
    look.turn = S.pageTurn(flat); t.turn = Math.round(performance.now() - t0); t0 = performance.now();
    look.curve = S.curveOf(preview, look.quad, look.turn); t.curve = Math.round(performance.now() - t0);
  }
  t0 = performance.now();
  // The found page drawn on the photo.
  const shown = { data: new Uint8ClampedArray(preview.data), width: preview.width, height: preview.height };
  const q = look.quad.map((c) => ({ x: c.x * preview.width, y: c.y * preview.height }));
  for (let e = 0; e < 4; e++) { const a = q[e], b = q[(e + 1) % 4]; const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)); for (let k = 0; k <= n; k++) { const x = Math.round(a.x + ((b.x - a.x) * k) / n), y = Math.round(a.y + ((b.y - a.y) * k) / n); for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= shown.width || yy >= shown.height) continue; const i = (yy * shown.width + xx) * 4; shown.data[i] = 0; shown.data[i + 1] = 230; shown.data[i + 2] = 0; } } }
  save(shown, path.join(out, `${name}-found.png`));
  const src = load(photo, Math.round(SIDE * 1.25));
  t0 = performance.now();
  const page = S.render(src, look, SIDE); t.render = Math.round(performance.now() - t0);
  save(page, path.join(out, `${name}-page.png`));
  if (globalThis.__dump) { save(globalThis.__dump, path.join(out, `${name}-bands.png`)); globalThis.__dump = null; }
  if (process.env.DBG && look.curve?.grid) { const g = look.curve.grid; for (const v of [0.15, 0.3, 0.5]) { const j = Math.round(v * (g.gy - 1)); console.log('my at v', v, Array.from({ length: g.gx }, (_, i) => (g.my[j * g.gx + i] * 1000).toFixed(0)).join(' ')); } }
  const info = { how: look.how, quad: look.quad, turn: look.turn, curve: !!look.curve, sheet: !!look.curve?.sheet, size: [page.width, page.height], ms: t };
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(info, null, 1));
  console.log(name, JSON.stringify({ how: info.how, turn: info.turn, curve: info.curve, sheet: info.sheet, size: info.size, ms: t }));
}
fs.rmSync(tmp, { force: true });
