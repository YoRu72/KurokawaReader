// node tests/lettering.cjs: the screen translator's lettering rules (src/screen/lettering.ts) — the glossary kept
// through a translator (terms masked, the markers put back even with spaces a translator adds), whole words only for
// Latin terms, its prompt for an AI model; each block's kind (a thought, a box, a sound effect, a balloon) and a
// glossary term deciding it; the font for a kind; terms pasted one a line.
const path = require('node:path'); const esbuild = require('esbuild');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x !== undefined ? `  (${JSON.stringify(x)})` : '')); if (!c) fails++; };
const js = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'screen', 'lettering.ts')], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['../player/files'] }).outputFiles[0].text;
const m = { exports: {} }; new Function('module', 'exports', 'require', js)(m, m.exports, require); const L = m.exports;
const cfg = { target: 'ar', glossary: { on: true, entries: [{ from: 'Ken', to: 'كين', lang: 'ar' }, { from: 'Kenji', to: 'كينجي', lang: '' }, { from: 'ドーン', to: '', kind: 'sfx' }, { from: 'Sword', to: 'سيف', lang: 'ja' }] }, letter: { kinds: true, fonts: { default: 'a', dialogue: '', thought: 'b', box: '', sfx: 'c', sign: '' }, lib: [{ id: 'a', name: 'A', path: '/f/a.ttf' }, { id: 'b', name: 'B', path: '/f/b.otf' }, { id: 'c', name: 'C', path: '/f/c.ttf' }] } };
const g = L.glossaryFor(cfg);
ok('the terms for this language and for any, the longest first; another language\'s left out', g[0].from === 'Kenji' && g.length === 3 && !g.some((e) => e.from === 'Sword'), g.map((e) => e.from));
const iKen = g.findIndex((e) => e.from === 'Ken'), iKenji = g.findIndex((e) => e.from === 'Kenji');
const p = L.protect(['Ken met Kenji.', 'Kenneth stayed.'], g);
ok('masked: whole words only (Kenji is its own term, Kenneth untouched)', p.texts[0] === `[[${iKen}]] met [[${iKenji}]].` && p.texts[1] === 'Kenneth stayed.', p.texts);
ok('put back as the reader\'s, spaces a translator added forgiven', L.restore([`التقى [[ ${iKen} ]] بـ [ [${iKenji}] ].`], p.used)[0] === 'التقى كين بـ كينجي.');
ok('an AI model told the glossary', /Ken → كين/.test(L.glossaryPrompt(g)) && /Kenji → كينجي/.test(L.glossaryPrompt(g)));
const kinds = L.kindsOf([
  { text: 'Where are you going?', height: 20, bg: { r: 250, g: 250, b: 250 } },
  { text: '(He knows...)', height: 20, bg: { r: 255, g: 255, b: 255 } },
  { text: 'Meanwhile, at the castle', height: 20, bg: { r: 20, g: 20, b: 30 } },
  { text: 'BAM', height: 60, bg: { r: 120, g: 60, b: 40 } },
  { text: 'ドーン', height: 22, bg: null },
  { text: 'Hello', height: 21, bg: null },
], g);
ok('kinds: a balloon, a thought, a box, a sound effect, a glossary-set one, a plain line', kinds.join() === 'dialogue,thought,box,sfx,sfx,dialogue', kinds);
ok('the font for a kind: its own, else the default; none chosen → the system\'s', L.fontFor(cfg, 'thought') === '/f/b.otf' && L.fontFor(cfg, 'dialogue') === '/f/a.ttf' && L.fontFor({ ...cfg, letter: { ...cfg.letter, fonts: { default: '' } } }, 'box') === '');
ok('kinds off: the default font for every kind', L.fontFor({ ...cfg, letter: { ...cfg.letter, kinds: false } }, 'sfx') === '/f/a.ttf');
const t = L.parseTerms('Kamado Tanjiro = كامادو تانجيرو\nドーン = بووم [sfx]\nBoom → [sfx]\nbad line\nZenitsu\tزينيتسو', 'ar');
ok('terms pasted one a line (=, →, a tab; a kind in brackets)', t.length === 4 && t[1].kind === 'sfx' && t[2].to === '' && t[2].kind === 'sfx' && t[3].to === 'زينيتسو', t);
console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
