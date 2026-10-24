// node tests/scanbench/spread.mjs <out-dir> <photo...>: the scanner's spread test on each photo — the page found and
// turned as the app does it, then the gutter looked for. A spread is written as <name>-1.png and <name>-2.png (in
// reading order, right to left when RTL=1), a single page as <name>-1.png; and one line each: split or not, where.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const [out, ...photos] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const here = path.dirname(new URL(import.meta.url).pathname);
const tmp = path.join(os.tmpdir(), `scanspread-${process.pid}.mjs`);
await build({ stdin: { contents: `export * from './src/scan.ts'; export { render, curveOf, splitQuad } from './src/scanops.ts';`, resolveDir: path.resolve(here, '../..'), loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: tmp, logLevel: 'silent' });
const S = await import(tmp); globalThis.KR_GUTTER_DEBUG = !!process.env.DBG;
const py = (code, ...args) => execFileSync('python3', ['-c', code, ...args], { maxBuffer: 1 << 30 });
const load = (file, max) => {
  const raw = path.join(os.tmpdir(), `scanspread-${process.pid}.rgba`);
  const meta = JSON.parse(py(`
import sys, json
from PIL import Image, ImageOps
im = ImageOps.exif_transpose(Image.open(sys.argv[1])).convert('RGBA'); m = int(sys.argv[2]); k = min(1, m / max(im.size))
if k < 1: im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
open(sys.argv[3], 'wb').write(im.tobytes()); print(json.dumps({'w': im.width, 'h': im.height}))`, file, String(max), raw).toString());
  const img = { data: new Uint8ClampedArray(fs.readFileSync(raw)), width: meta.w, height: meta.h }; fs.rmSync(raw); return img;
};
const save = (img, file) => {
  const raw = path.join(os.tmpdir(), `scanspread-${process.pid}-o.rgba`); fs.writeFileSync(raw, Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength));
  py(`
import sys
from PIL import Image
Image.frombytes('RGBA', (int(sys.argv[2]), int(sys.argv[3])), open(sys.argv[1], 'rb').read()).convert('RGB').save(sys.argv[4])`, raw, String(img.width), String(img.height), file);
  fs.rmSync(raw);
};
const rtl = !!process.env.RTL;
for (const photo of photos) {
  const name = path.basename(photo).replace(/\.[^.]+$/, '');
  const preview = load(photo, 1200);
  const f = S.detectPage(preview);
  const look = { quad: f.quad.map((c) => ({ x: c.x / preview.width, y: c.y / preview.height })), curve: null, flatten: true, turn: 0, filter: 'auto', adj: {} };
  look.turn = S.pageTurn(S.render(preview, { ...look, filter: 'original' }, 900));
  const flat = S.render(preview, { ...look, filter: 'original' }, 900);
  const t0 = performance.now(); const g = S.findGutter(flat); const ms = Math.round(performance.now() - t0);
  let looks = [look];
  if (g !== null) { const [a, b] = S.splitQuad(look.quad, look.turn, g, preview.width, preview.height); looks = (rtl ? [b, a] : [a, b]).map((q) => ({ ...look, quad: q })); }
  const src = load(photo, 2000);
  looks.forEach((l, k) => { l.curve = S.curveOf(preview, l.quad, l.turn); save(S.render(src, l, 1600), path.join(out, `${name}-${k + 1}.png`)); });
  console.log(`${name.padEnd(22)} turn ${look.turn}  ${g === null ? 'one page' : `split at ${(g.top * 100).toFixed(1)}–${(g.bottom * 100).toFixed(1)}%`}  (${ms} ms)  flat ${flat.width}×${flat.height}`);
}
fs.rmSync(tmp, { force: true });
