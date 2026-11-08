// node tests/inpaint.cjs: the computer's screen translator taking the words off the picture (src/screen/inpaint.ts),
// the same cases as the phone's (tests/native/InT.java): a plain balloon, a gradient, nothing to take off.
const esbuild = require('esbuild'); const path = require('node:path');
const o = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/screen/inpaint.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' });
const m = { exports: {} }; new Function('module', 'exports', o.outputFiles[0].text)(m, m.exports); const { clean } = m.exports;
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + x)); if (!c) fails++; };
const w = 160, h = 60;
const scene = (bg, ink) => { const p = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = (y >= 8 && y < h - 8 && x >= 8 && x < w - 8 && (Math.floor(x / 3) % 3 === 0 || y % 9 < 2)) ? ink : bg(x, y); p.set([...c, 255], 4 * (y * w + x)); } return p; };
const worst = (a, bg) => { let mx = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const q = bg(x, y); for (let c = 0; c < 3; c++) mx = Math.max(mx, Math.abs(a[4 * (y * w + x) + c] - q[c])); } return mx; };
const white = () => [255, 255, 255]; const sky = (x, y) => [40 + Math.floor(x * 150 / w), 60 + Math.floor(y * 100 / h), 200];
const m1 = worst(clean(scene(white, [0, 0, 0]), w, h), white); ok('a plain balloon: the letters gone', m1 <= 6, m1);
const m2 = worst(clean(scene(sky, [255, 255, 255]), w, h), sky); ok('a gradient: the letters gone, the gradient kept', m2 <= 14, m2);
const plain = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) plain.set([...sky(i % w, Math.floor(i / w)), 255], 4 * i);
const m3 = worst(clean(plain, w, h), sky); ok('nothing to take off: left as it was', m3 <= 3, m3);
console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
