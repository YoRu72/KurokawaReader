if (process.argv.length < 4) { console.log('usage: node tests/pdf2docx/metrics.mjs <original.pdf> <converted.pdf>'); process.exit(1); }
// node metrics.mjs original.pdf converted.pdf → per page: matched lines, mean/max |Δbaseline|, mean |Δstart|, |Δend|
import { buildPdfWorker } from '../../scripts/patch-pdfjs.mjs';
import fs from 'fs';
const W = new URL('../../node_modules/pdfjs-dist/legacy/build/kr-test-worker.mjs', import.meta.url).pathname;
if (!fs.existsSync(W)) await buildPdfWorker(W);
const pdfjs = await import(new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.mjs', import.meta.url).href);
pdfjs.GlobalWorkerOptions.workerSrc = W;
const open = async (f) => pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(f)), verbosity: 0 }).promise;
async function lines(doc, n) {
  const page = await doc.getPage(n); const tc = await page.getTextContent();
  const its = tc.items.filter((i) => i.str && i.str.trim() && i.str !== ' ').map((i) => ({ y: i.transform[5], l: i.transform[4], r: i.transform[4] + i.width, h: i.height }));
  its.sort((a, b) => b.y - a.y);
  const out = [];
  for (const it of its) { const g = out.find((o) => Math.abs(o.y - it.y) < Math.max(3, it.h * 0.35)); if (g) { g.l = Math.min(g.l, it.l); g.r = Math.max(g.r, it.r); g.n++; } else out.push({ y: it.y, l: it.l, r: it.r, n: 1 }); }
  return out.filter((o) => o.r - o.l > 3);
}
const [a, b] = [await open(process.argv[2]), await open(process.argv[3])];
let tot = { m: 0, u: 0, dy: 0, max: 0 };
for (let p = 1; p <= a.numPages; p++) {
  if (p > b.numPages) { console.log('page', p, 'missing'); continue; }
  const A = await lines(a, p), B = await lines(b, p);
  let m = 0, dy = 0, mx = 0, dl = 0, dr = 0; const used = new Set();
  for (const x of A) {
    let best = null, bd = 1e9;
    for (const [k, y] of B.entries()) { if (used.has(k)) continue; const d = Math.abs(y.y - x.y) + Math.abs((y.l + y.r) / 2 - (x.l + x.r) / 2) * 0.3; if (d < bd) { bd = d; best = k; } }
    if (best === null || Math.abs(B[best].y - x.y) > 20) continue;
    used.add(best); m++; const d = Math.abs(B[best].y - x.y); if (process.env.DETAIL == p) console.log(`  orig y ${x.y.toFixed(1)} [${x.l.toFixed(0)}..${x.r.toFixed(0)}] → ${B[best].y.toFixed(1)} [${B[best].l.toFixed(0)}..${B[best].r.toFixed(0)}]`); dy += d; mx = Math.max(mx, d); dl += Math.abs(B[best].l - x.l); dr += Math.abs(B[best].r - x.r);
  }
  console.log(`page ${p}: lines ${A.length}/${B.length} matched ${m} | Δbaseline mean ${(dy / (m || 1)).toFixed(1)} max ${mx.toFixed(1)} | Δleft ${(dl / (m || 1)).toFixed(1)} Δright ${(dr / (m || 1)).toFixed(1)}`);
  tot.m += m; tot.u += A.length - m; tot.dy += dy; tot.max = Math.max(tot.max, mx);
}
console.log(`ALL: matched ${tot.m}, unmatched ${tot.u}, mean Δbaseline ${(tot.dy / (tot.m || 1)).toFixed(2)}pt, max ${tot.max.toFixed(1)}pt; pages ${a.numPages} → ${b.numPages}`);
fs.unlinkSync(W);
