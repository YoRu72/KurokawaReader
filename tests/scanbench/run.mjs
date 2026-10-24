// node tests/scanbench/run.mjs <dir>: find the page in every synthetic photo of tests/scanbench/make.py and
// score it against the truth (worst corner distance as a share of the photo's diagonal). Needs <name>.rgba next
// to each photo (python3 tests/scanbench/torgba.py <dir>).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = process.argv[2];
const tmp = path.join(os.tmpdir(), `scanbench-${process.pid}.mjs`);
await build({ entryPoints: [path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../src/scan.ts')], bundle: true, format: 'esm', platform: 'node', outfile: tmp, logLevel: 'silent' });
const S = await import(tmp);
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));
let ok = 0, total = 0, time = 0; const foundAll = {};
const only = process.env.ONLY;
for (const [name, q] of Object.entries(truth)) {
  if (only && !name.includes(only)) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
  const data = new Uint8ClampedArray(fs.readFileSync(path.join(dir, `${name}.rgba`)));
  const img = { data, width: meta.w, height: meta.h };
  const t0 = performance.now();
  const found = S.detectPage(img, process.env.DEBUG ? (c) => console.log('   cands', c.map((x) => `${x.how}:${x.score.toFixed(2)}`).join(' ')) : undefined);
  const dt = performance.now() - t0; time += dt;
  const diag = Math.hypot(meta.w, meta.h);
  const want = q ? q.map(([x, y]) => ({ x: Math.min(meta.w, Math.max(0, x)), y: Math.min(meta.h, Math.max(0, y)) })) : [{ x: 0, y: 0 }, { x: meta.w, y: 0 }, { x: meta.w, y: meta.h }, { x: 0, y: meta.h }];
  const got = found.quad;
  // (A corner past the photo's edge is not one the photo shows: only the corners in it are compared.)
  const inside = q ? q.map(([x, y]) => x >= 0 && y >= 0 && x <= meta.w && y <= meta.h) : [true, true, true, true];
  const err = Math.max(...want.map((p, i) => (inside[i] ? Math.hypot(p.x - got[i].x, p.y - got[i].y) : 0))) / diag;
  foundAll[name] = got.map((p) => [p.x / meta.k, p.y / meta.k]);
  const pass = err < 0.02; total++; if (pass) ok++;
  console.log(`${pass ? 'ok  ' : 'MISS'} ${name.padEnd(20)} ${found.how.padEnd(6)} score ${found.score.toFixed(2)}  err ${(err * 100).toFixed(1)}%  ${dt.toFixed(0)} ms`);
}
console.log(`${ok}/${total} within 2% · ${(time / Math.max(1, total)).toFixed(0)} ms each`);
fs.writeFileSync(path.join(dir, 'found.json'), JSON.stringify(foundAll));
fs.rmSync(tmp, { force: true });
