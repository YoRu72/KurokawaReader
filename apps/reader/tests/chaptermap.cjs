// node tests/chaptermap.cjs: a novel moved to another source (src/sources/chaptermap.ts, used by migrate.ts) — each
// chapter of the old list matched to the same chapter of the new one; numbers that start again in each volume
// ("Volume 2 Chapter 1") matched within their volume, not taken for volume 1's.
const esbuild = require('esbuild');
const code = esbuild.buildSync({ entryPoints: ['src/sources/chaptermap.ts'], bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'error' }).outputFiles[0].text;
const m = { exports: {} }; new Function('module', 'exports', code)(m, m.exports); const { chapterMap } = m.exports;
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const ch = (names) => names.map((name, i) => ({ name, path: `/c/${i}` }));
// Plain numbers: matched by number (a prologue the new site lacks does not shift them).
{ const map = chapterMap(ch(['Prologue', 'Chapter 1', 'Chapter 2', 'Chapter 3']), ch(['Ch. 1 - Start', 'Ch. 2 - Road', 'Ch. 3 - Gate'])); ok('plain numbers matched by number', map(1) === 0 && map(3) === 2, [map(1), map(3)]); }
// Numbers that start again in each volume.
const vols = ['Volume 1 Chapter 1', 'Volume 1 Chapter 2', 'Volume 2 Chapter 1', 'Volume 2 Chapter 2', 'Volume 3 Chapter 1'];
{ const map = chapterMap(ch(vols), ch(['Vol. 1 Ch. 1', 'Vol. 1 Ch. 2', 'Vol. 2 Ch. 1', 'Vol. 2 Ch. 2', 'Vol. 3 Ch. 1'])); const got = vols.map((_, i) => map(i));
  ok('volume 2 chapter 1 goes to volume 2 chapter 1 (not volume 1\'s)', got.join() === '0,1,2,3,4', got); }
{ const map = chapterMap(ch(['第1巻 第1話', '第1巻 第2話', '第2巻 第1話']), ch(['第1巻 第1話 始まり', '第1巻 第2話 道', '第2巻 第1話 門'])); const got = [0, 1, 2].map((i) => map(i));
  ok('Japanese volumes (第2巻 第1話)', got.join() === '0,1,2', got); }
{ const map = chapterMap(ch(['المجلد 1 الفصل 1', 'المجلد 1 الفصل 2', 'المجلد 2 الفصل 1']), ch(['المجلد ١ - الفصل ١', 'المجلد ١ - الفصل ٢', 'المجلد ٢ - الفصل ١'])); const got = [0, 1, 2].map((i) => map(i));
  ok('Arabic volumes («المجلد ٢ - الفصل ١»)', got.join() === '0,1,2', got); }
// A chapter with no volume given in a list whose numbers start again: not guessed onto volume 1.
{ const map = chapterMap(ch(['Chapter 1', 'Chapter 2']), ch(['Vol. 1 Ch. 1', 'Vol. 1 Ch. 2', 'Vol. 2 Ch. 1', 'Vol. 2 Ch. 2'])); ok('a number that is in two volumes not guessed', map(0) === undefined, map(0)); }
// One list numbered through, the other by volume with numbers that never start again: matched by number still.
{ const map = chapterMap(ch(['Chapter 1', 'Chapter 2', 'Chapter 3']), ch(['Vol. 1 Ch. 1', 'Vol. 1 Ch. 2', 'Vol. 2 Ch. 3'])); ok('numbers running through the volumes still matched', [0, 1, 2].map((i) => map(i)).join() === '0,1,2', [0, 1, 2].map((i) => map(i))); }
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
