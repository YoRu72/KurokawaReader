// node tests/pdftextrules.cjs: right-to-left line rules of the PDF text (src/pdftext.ts) — a bracket alone keeps
// the turn its place gave it; a number drawn in pieces keeps the order it shows ("١٩٧/٦").
const esbuild = require('esbuild');
const code = esbuild.buildSync({ entryPoints: ['src/pdftext.ts'], bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'error' }).outputFiles[0].text;
const m = { exports: {} }; new Function('module', 'exports', 'require', code)(m, m.exports, require); const P = m.exports;
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
ok('a bracket alone is left as its place made it', P.balanceBrackets('(') === '(' && P.balanceBrackets(')') === ')');
ok('a word ending with an opening bracket is turned round', P.balanceBrackets('اللغة(') === 'اللغة)');
// Pieces in reading order (right to left): "٦" then "/" then "١٩٧", the number standing left to right.
const seq = [{ text: 'الأعيان', l: 194, r: 218, h: 11 }, { text: '٦', l: 183.77, r: 188.7, h: 11 }, { text: '/', l: 180.89, r: 183.88, h: 11 }, { text: '١٩٧', l: 168.5, r: 181.07, h: 11 }, { text: 'ص', l: 150, r: 160, h: 11 }];
const out = P.numberRunsForward(seq);
ok('a number in pieces read as it shows: one piece "١٩٧/٦"', out.length === 3 && out[1].text === '١٩٧/٦' && out[1].l === 168.5 && out[1].r === 188.7, out.map((x) => x.text));
const apart = P.numberRunsForward([{ text: '١', l: 100, r: 104, h: 11 }, { text: '/', l: 80, r: 83, h: 11 }, { text: '٢', l: 60, r: 64, h: 11 }]);
ok('numbers apart on the line stay apart', apart.length === 3);
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
