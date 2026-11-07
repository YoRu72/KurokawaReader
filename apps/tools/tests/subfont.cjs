// node tests/subfont.cjs: an ASS subtitle's styles put in the player's main font — every style's Fontname
// replaced, whatever the Format line's order; the lines' own \fn (signs) and everything else left as they are.
const esbuild = require('esbuild'); const path = require('node:path');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/player/assFont.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' });
const m = {}; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports = {}); const { assWithFont } = m.exports;
const ass = ['[V4+ Styles]', 'Format: Name, Fontname, Fontsize, PrimaryColour', 'Style: Default,Arial,48,&H00FFFFFF', 'Style: Sign, Comic Sans MS,30,&H0000FFFF', '', '[Events]', 'Format: Layer, Start, End, Style, Text', 'Dialogue: 0,0:00:01.00,0:00:02.00,Default,{\\fnImpact}Sign text'].join('\n');
const r = assWithFont(ass, 'My Font');
ok('each style takes the font', r.includes('Style: Default,My Font,48') && r.includes('Style: Sign, My Font,30'), r);
ok('a line\'s own \\fn kept', r.includes('{\\fnImpact}Sign text'));
ok('nothing else changed', r.split('\n').length === ass.split('\n').length && r.includes('Format: Name, Fontname, Fontsize, PrimaryColour'));
const other = 'Format: Name, Fontsize, Fontname\nStyle: X,40,Arial';
ok('the Format line\'s order followed', assWithFont(other, 'F2') === 'Format: Name, Fontsize, Fontname\nStyle: X,40,F2', assWithFont(other, 'F2'));
ok('a comma in a family name does not split the style', assWithFont(ass, 'A, B').includes('Style: Default,A  B,48'));
ok('no font: the subtitle untouched', assWithFont(ass, '') === ass);
console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
