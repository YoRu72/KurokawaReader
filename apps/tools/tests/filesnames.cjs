// node tests/filesnames.cjs: the Files browser's names (src/views/filesNames.ts, pure) — a name's last extension split
// off as the phone's side does it, and the batch rename's pattern: the extension kept unless the pattern places it, dotted
// stems («Show.S01E01.720p.mkv»), «.gitignore», «archive.tar.gz», no extension, folders, trailing dots and spaces,
// forbidden characters, names that clash letter case aside.
const esbuild = require('esbuild'); const path = require('node:path');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/views/filesNames.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' });
const m = {}; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports = {}); const N = m.exports;
const f = (name, dir = false) => ({ name, dir, size: 1536, mtime: new Date(2025, 0, 2, 3, 4).getTime() });
const P = (name, pattern, o = {}) => N.patternName(f(name, o.dir), pattern, o.i ?? 0, o.start ?? 1, o.find ?? '', o.replace ?? '', (n) => `${n} B`);
const J = JSON.stringify;
ok('split: the last extension', J(N.splitExt('Show.S01E01.720p.mkv')) === J(['Show.S01E01.720p', 'mkv']) && J(N.splitExt('archive.tar.gz')) === J(['archive.tar', 'gz']));
ok('split: none for a dot-file, no dot, a trailing dot, a long ending, a folder', ['.gitignore', 'README', 'notes.', 'report.final_version'].every((n) => N.splitExt(n)[1] === '') && N.splitExt('my.folder', true)[1] === '');
ok('{name} leaves names as they were', ['Show.S01E01.720p.mkv', '.gitignore', 'archive.tar.gz', 'README', 'notes.', ' spaced .txt'].every((n) => P(n, '{name}') === n), ['Show.S01E01.720p.mkv', 'notes.'].map((n) => P(n, '{name}')));
ok('{name}_x keeps the last extension', P('Show.S01E01.720p.mkv', '{name}_x') === 'Show.S01E01.720p_x.mkv' && P('archive.tar.gz', '{name}_x') === 'archive.tar_x.gz' && P('.gitignore', '{name}_x') === '.gitignore_x' && P('README', '{name}_x') === 'README_x');
ok('a folder: its dots no extension', P('my.folder', '{name}_x', { dir: true }) === 'my.folder_x');
ok('the pattern places the extension itself', P('a.MKV', '{name}.{ext}') === 'a.MKV' && P('a.mkv', 'b-{name.ext}') === 'b-a.mkv' && P('a.mkv', '{name}.mp4.{ext}') === 'a.mp4.mkv');
ok('an extension typed into the pattern is not the file\'s', P('a.mkv', '{name}.mp4') === 'a.mp4.mkv');
ok('numbering with zeros', P('a.mkv', 'Ep {n:3}', { i: 4, start: 1 }) === 'Ep 005.mkv');
ok('find → replace on the name', P('Show.S01E01.720p.mkv', '{name}', { find: '.', replace: ' ' }) === 'Show S01E01 720p.mkv');
ok('trailing dots and spaces dropped before the extension', P('a.mkv', '{name}. . ') === 'a.mkv' && P('a.mkv', 'x..') === 'x.mkv' && P('README', 'x. ') === 'x');
ok('forbidden characters become spaces', P('a.mkv', 'x:y*z?') === 'x y z.mkv');
ok('nothing left: empty (refused)', P('a.mkv', '...') === '' && P('README', '..') === '' && P('a.mkv', '   ') === '');
ok('date, time, size', P('a.mkv', '{date}_{time}_{size}') === '2025-01-02_0304_1536B.mkv');
ok('clashes: letter case aside, every one of them marked', J([...N.clashes(['X.mkv', 'x.MKV', 'y', 'z', 'Y'])].sort()) === J([0, 1, 2, 4]));
console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
