// node tests/glossary.cjs: the translation glossary (src/glossary.ts) — the terms a passage holds, a book's own
// first, given to the model; a term it left as it was put right.
const esbuild = require('esbuild');
const store = {}; globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const code = esbuild.buildSync({ entryPoints: ['src/glossary.ts'], bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'error' }).outputFiles[0].text;
const m = { exports: {} }; new Function('module', 'exports', code)(m, m.exports); const G = m.exports;
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
G.saveTerms([{ id: '1', from: 'Lin Feng', to: 'لين فنغ' }, { id: '2', from: 'Azure Sect', to: 'الطائفة اللازوردية' }, { id: '3', from: 'Lin Feng', to: 'لين فِنغ', book: 'b1' }, { id: '4', from: 'Qi', to: 'التشي' }]);
const inB1 = G.termsIn(['Lin Feng joined the Azure Sect.'], 'b1');
ok('the terms a passage holds; the book\'s own rendering first', inB1.length === 2 && inB1[0].to === 'لين فِنغ' && inB1.some((x) => x.from === 'Azure Sect'), inB1);
ok('… the general one in another book; a term not there left out', G.termsIn(['Lin Feng smiled.'], 'b2').map((x) => x.to).join() === 'لين فنغ');
ok('given to the model as lines', /"Lin Feng" → "لين فِنغ"/.test(G.glossaryPrompt(inB1)));
ok('a term left untranslated put right', G.applyGlossary('ابتسم Lin Feng ثم مضى', inB1) === 'ابتسم لين فِنغ ثم مضى');
const s1 = G.glossaryStamp(); G.saveTerms(G.terms().slice(1)); ok('a changed glossary changes the stamp (translations made again)', s1 && s1 !== G.glossaryStamp());
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
