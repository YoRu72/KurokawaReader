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

// ---------- the batch rename's pure side (src/views/filesBatch.ts) ----------
const ob = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/views/filesBatch.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' });
const bm = {}; new Function('module', 'exports', ob.outputFiles[0].text)(bm, bm.exports = {}); const B = bm.exports;
const D = '/d';
const it = (name, o = {}) => ({ path: `${o.dir ?? D}/${name}`, name, dir: !!o.isDir, size: o.size ?? 1536, mtime: o.mtime ?? new Date(2025, 0, 2, 3, 4).getTime() });
const merge = (a, b) => { const o = { ...a }; for (const k of Object.keys(b)) o[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? merge(a[k] ?? {}, b[k]) : b[k]; return o; };
const rec = (patch = {}) => merge(B.defaultRecipe('selected'), patch);
const plan = (names, patch = {}, ctx = {}) => B.planBatch(names.map((n) => (typeof n === 'string' ? it(n) : n)), rec(patch), ctx);
const outs = (names, patch, ctx) => plan(names, patch, ctx).rows.map((r) => (r.action === 'rename' ? r.to : r.from));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const t = (n, names, patch, want, ctx) => { const got = outs(names, patch, ctx); ok(n, eq(got, want), got); };
const eps = Array.from({ length: 12 }, (_, i) => `x${i}.mkv`);
// — numbering
t('number after, the digits from the count (12 → 01…12)', eps, { nameMode: 'replace', nameText: 'Show', num: { on: true } }, Array.from({ length: 12 }, (_, i) => `Show - ${String(i + 1).padStart(2, '0')}.mkv`));
t('number: three items, one digit', ['a.mkv', 'b.mkv', 'c.mkv'], { num: { on: true } }, ['a - 1.mkv', 'b - 2.mkv', 'c - 3.mkv']);
t('number from 5, step 5: width of the largest', ['a.mkv', 'b.mkv', 'c.mkv'], { num: { on: true, start: 5, step: 5 } }, ['a - 05.mkv', 'b - 10.mkv', 'c - 15.mkv']);
t('number: a width chosen (3)', ['a.mkv', 'b.mkv'], { num: { on: true, pad: 3 } }, ['a - 001.mkv', 'b - 002.mkv']);
t('number before the name, a separator of one\'s own', ['a.mkv', 'b.mkv'], { num: { on: true, pos: 'before', sep: '_' } }, ['1_a.mkv', '2_b.mkv']);
t('number alone when the name is replaced by nothing', ['a.mkv', 'b.mkv'], { nameMode: 'replace', num: { on: true } }, ['1.mkv', '2.mkv']);
t('number from 0', ['a.mkv', 'b.mkv'], { num: { on: true, start: 0, sep: '' } }, ['a0.mkv', 'b1.mkv']);
t('order as picked: the array order, not the names\'', ['c.txt', 'a.txt', 'b.txt'], { nameMode: 'replace', nameText: 'n', num: { on: true } }, ['n - 1.txt', 'n - 2.txt', 'n - 3.txt']);
t('order by name: c, a, b → 3, 1, 2', ['c.txt', 'a.txt', 'b.txt'], { nameMode: 'replace', nameText: 'n', num: { on: true, order: 'name' } }, ['n - 3.txt', 'n - 1.txt', 'n - 2.txt']);
t('order by name is natural: 2 before 10', ['10.txt', '2.txt'], { nameMode: 'replace', nameText: 'n', num: { on: true, order: 'name' } }, ['n - 2.txt', 'n - 1.txt']);
t('order by date: the older first', [it('a.txt', { mtime: 300 }), it('b.txt', { mtime: 100 }), it('c.txt', { mtime: 200 })], { nameMode: 'replace', nameText: 'n', num: { on: true, order: 'date' } }, ['n - 3.txt', 'n - 1.txt', 'n - 2.txt']);
t('order by the current sort', ['a.txt', 'b.txt', 'c.txt'], { nameMode: 'replace', nameText: 'n', num: { on: true, order: 'sort' } }, ['n - 3.txt', 'n - 1.txt', 'n - 2.txt'], { sortIndex: new Map([[`${D}/a.txt`, 2], [`${D}/b.txt`, 0], [`${D}/c.txt`, 1]]) });
t('the number in the pattern: {n:3}, no second number added', ['a.mkv', 'b.mkv'], { nameMode: 'pattern', nameText: 'Ep {n:3}', num: { on: true, start: 7 } }, ['Ep 007.mkv', 'Ep 008.mkv']);
ok('the last number: from 1 step 1 for 12 = 12; from 3 step 2 for 4 = 9', B.lastNumber(12, rec().num) === 12 && B.lastNumber(4, { ...rec().num, start: 3, step: 2 }) === 9);
ok('a chosen end smaller than needed is flagged', plan(eps, { num: { on: true, end: 5 } }).endShort && !plan(eps, { num: { on: true, end: 12 } }).endShort && !plan(eps, { num: { on: false, end: 3 } }).endShort);
ok('a numbering position is told on each row (picked order, number)', (() => { const p = plan(['b.txt', 'a.txt'], { num: { on: true, order: 'name', start: 10 } }); return p.rows[0].picked === 1 && p.rows[0].num === 11 && p.rows[1].num === 10; })());
// — extensions
t('extension set (a typed dot dropped)', ['a.png', 'b.PNG'], { ext: { mode: 'set', value: '.jpg' } }, ['a.jpg', 'b.jpg']);
t('extension set on a file with none', ['README'], { ext: { mode: 'set', value: 'txt' } }, ['README.txt']);
t('extension set to nothing typed: left as it is', ['a.png'], { ext: { mode: 'set', value: '' } }, ['a.png']);
t('extension set: spaces and forbidden characters taken out', ['a.png'], { ext: { mode: 'set', value: ' j:p g' } }, ['a.jpg']);
t('a second extension added', ['a.mkv', 'README'], { ext: { mode: 'add', value: 'bak' } }, ['a.mkv.bak', 'README.bak']);
t('the extension removed', ['a.mkv', 'archive.tar.gz', 'README'], { ext: { mode: 'remove' } }, ['a', 'archive.tar', 'README']);
t('the extension lower-cased / UPPER-CASED', ['A.MKV', 'b.Mp4'], { ext: { mode: 'lower' } }, ['A.mkv', 'b.mp4']);
t('… upper', ['a.mkv', 'b.Mp4'], { ext: { mode: 'upper' } }, ['a.MKV', 'b.MP4']);
t('a double extension: only the last one is the extension', ['archive.tar.gz'], { ext: { mode: 'upper' } }, ['archive.tar.GZ']);
t('set to a dotted extension (tar.gz)', ['a.zip'], { ext: { mode: 'set', value: 'tar.gz' } }, ['a.tar.gz']);
t('a dot-file has no extension: one is added', ['.gitignore'], { ext: { mode: 'add', value: 'bak' } }, ['.gitignore.bak']);
t('extension and number together: Show - 1.mp4', ['x.mkv'], { nameMode: 'replace', nameText: 'Show', num: { on: true }, ext: { mode: 'set', value: 'mp4' } }, ['Show - 1.mp4']);
t('the extension of a file already of that name: unchanged', ['a.jpg'], { ext: { mode: 'set', value: 'jpg' } }, ['a.jpg']);
{ const p = plan([it('dir.d', { isDir: true }), 'a.png'], { ext: { mode: 'set', value: 'jpg' } }); ok('a folder never given an extension: kept, listed', p.rows[0].to === 'dir.d' && p.rows[0].action === 'skip' && p.folderExt.length === 1 && p.rows[1].to === 'a.jpg', p.rows); }
{ const p = plan([it('dir.d', { isDir: true })], { nameMode: 'after', nameText: '_x', ext: { mode: 'set', value: 'jpg' } }); ok('a folder is still renamed by name, with no extension', p.rows[0].to === 'dir.d_x' && p.rows[0].action === 'rename', p.rows); }
ok('png → mp4: a different kind, flagged; jpg → png, ass → srt, mkv → mp4: not', plan(['a.png'], { ext: { mode: 'set', value: 'mp4' } }).kindChanges === 1 && plan(['a.jpg', 'b.webp'], { ext: { mode: 'set', value: 'png' } }).kindChanges === 0 && plan(['a.ass'], { ext: { mode: 'set', value: 'srt' } }).kindChanges === 0 && plan(['a.mkv'], { ext: { mode: 'set', value: 'mp4' } }).kindChanges === 0);
ok('a file with no (known) extension given one: not a kind change', plan(['README', 'a.xyz'], { ext: { mode: 'set', value: 'mp4' } }).kindChanges === 0);
ok('the kinds\' chips follow the selection', eq(B.chipsFor([it('a.png')]), ['jpg', 'png', 'webp']) && B.chipsFor([it('a.ass'), it('b.mkv')]).includes('srt') && B.chipsFor([it('a.mkv')]).includes('mp4') && B.chipsFor([it('a.xyz')]).length >= 3);
// — the name
t('name replaced', ['a.mkv', 'b.mkv'], { nameMode: 'replace', nameText: 'Z' }, ['Z.mkv', 'Z.mkv']);
t('name: added before', ['a.mkv'], { nameMode: 'before', nameText: '[x] ' }, ['[x] a.mkv']);
t('name: added after', ['a.mkv'], { nameMode: 'after', nameText: ' (1)' }, ['a (1).mkv']);
t('find and replace, plain, any case', ['Show.MKV Show.mkv'], { find: 'show', replace: 'S' }, ['S.MKV S.mkv']);
t('find and replace, plain, the case kept', ['Show show.mkv'], { find: 'show', replace: 'S', matchCase: true }, ['Show S.mkv']);
t('find and replace: regex with a group', ['ep01.mkv', 'ep12.mkv'], { find: 'ep(\\d+)', replace: 'E$1', regex: true }, ['E01.mkv', 'E12.mkv']);
t('a plain replacement: «$1» is just text', ['a.mkv'], { find: 'a', replace: '$1' }, ['$1.mkv']);
ok('a regular expression that does not parse: an error', plan(['a.mkv'], { find: '(', regex: true }).error.length > 0 && plan(['a.mkv'], { find: '(' }).error === '');
t('the find does not reach the extension', ['mkv.mkv'], { find: 'mkv', replace: 'x' }, ['x.mkv']);
t('brackets removed: [..] and (..)', ['[Grp] Show (1080p) 01 [ABCD].mkv'], { tf: { tags: true, collapse: true, trim: true } }, ['Show 01.mkv']);
t('spaces → underscores', ['a b  c.txt'], { tf: { spaces: 'toUnderscore' } }, ['a_b_c.txt']);
t('underscores → spaces', ['a_b__c.txt'], { tf: { spaces: 'toSpace' } }, ['a b  c.txt']);
t('collapse and trim', ['  a   b  .txt'], { tf: { collapse: true, trim: true } }, ['a b.txt']);
t('case: lower, UPPER, Title', ['The aRt Of.txt'], { tf: { case: 'lower' } }, ['the art of.txt']);
t('case: upper', ['The aRt.txt'], { tf: { case: 'upper' } }, ['THE ART.txt']);
t('case: Title', ['the art_of-war (2).txt'], { tf: { case: 'title' } }, ['The Art_Of-War (2).txt']);
t('Arabic names: no case, number after, the extension kept', ['أغنية النهاية.ass', 'المقدمة.ass'], { num: { on: true } }, ['أغنية النهاية - 1.ass', 'المقدمة - 2.ass']);
t('Arabic: title case leaves the letters', ['أغنية النهاية.ass'], { tf: { case: 'title' } }, ['أغنية النهاية.ass']);
t('Japanese names replaced, numbered, the extension changed', ['第1話 タイトル.mkv', '第2話 タイトル.mkv'], { nameMode: 'replace', nameText: '蒼のカノン', num: { on: true, sep: ' 第' }, ext: { mode: 'set', value: 'mp4' } }, ['蒼のカノン 第1.mp4', '蒼のカノン 第2.mp4']);
t('dotted names: Show.S01E01.720p.mkv → the last dot is the extension', ['Show.S01E01.720p.mkv'], { nameMode: 'after', nameText: '_x' }, ['Show.S01E01.720p_x.mkv']);
t('no extension: README stays, the pattern {name}_x', ['README'], { nameMode: 'after', nameText: '_x' }, ['README_x']);
t('a name left as it was stays exactly so («notes.» is not trimmed)', ['notes.'], { }, ['notes.']);
t('pattern tokens: {name} {ext} {date} {time} {size}', ['a.mkv'], { nameMode: 'pattern', nameText: '{name}_{date}_{time}_{size}' }, ['a_2025-01-02_0304_1536B.mkv'], { fmtSize: (n) => `${n} B` });
t('pattern placing the extension itself: {name}.{ext} → as it was', ['a.MKV'], { nameMode: 'pattern', nameText: '{name}.{ext}' }, ['a.MKV']);
t('pattern with an extension of its own: the file\'s kept after it', ['a.mkv'], { nameMode: 'pattern', nameText: '{name}.mp4' }, ['a.mp4.mkv']);
// — what no storage takes, too long, hidden, empty
{ const p = plan(['a.mkv'], { nameMode: 'replace', nameText: 'x:y*z?' }); ok('forbidden characters become spaces, said', p.rows[0].to === 'x y z.mkv' && p.rows[0].flags.illegal, p.rows[0]); }
{ const long = 'é'.repeat(200); const p = plan(['a.mkv'], { nameMode: 'replace', nameText: long }); ok('too long (255 bytes): shortened by clipName, extension kept, said', new TextEncoder().encode(p.rows[0].to).length <= 255 && p.rows[0].to.endsWith('.mkv') && p.rows[0].flags.tooLong, p.rows[0].to.length); }
{ const p = plan(['a.mkv'], { nameMode: 'replace', nameText: '' }); ok('the name taken away leaves ".mkv": a hidden file, said', p.rows[0].to === '.mkv' && p.rows[0].flags.hidden, p.rows[0]); }
{ const p = plan(['a'], { nameMode: 'replace', nameText: '...' }); ok('nothing left: empty, blocking', p.rows[0].to === '' && p.rows[0].flags.empty && p.summary.blocking === 1, p.rows[0]); }
{ const p = plan(['a.mkv', 'b.mkv'], {}); ok('nothing changed: all skipped as unchanged', p.summary.rename === 0 && p.summary.unchanged === 2 && p.rows.every((r) => r.flags.unchanged), p.summary); }
// — clashes
{ const p = plan(['a.mkv', 'b.mkv'], { nameMode: 'replace', nameText: 'X' }); ok('two results the same: both marked, blocking by «stop»', p.rows[0].flags.clashResult && p.rows[1].flags.clashResult && p.summary.blocking === 2, p.summary); }
{ const p = plan(['a.mkv'], { nameMode: 'replace', nameText: 'X' }, { existing: () => new Set(['a.mkv', 'x.mkv']) }); ok('a name already in the folder (letter case aside): marked', p.rows[0].flags.clashExisting && p.summary.blocking === 1, p.rows[0]); }
t('policy skip: the first keeps the name, the others are left', ['a.mkv', 'b.mkv', 'c.mkv'], { nameMode: 'replace', nameText: 'X', clash: 'skip' }, ['X.mkv', 'b.mkv', 'c.mkv']);
t('policy skip: a name taken in the folder: left', ['a.mkv'], { nameMode: 'replace', nameText: 'X', clash: 'skip' }, ['a.mkv'], { existing: () => new Set(['x.mkv', 'a.mkv']) });
t('policy number: " (2)", " (3)" before the extension', ['a.mkv', 'b.mkv', 'c.mkv'], { nameMode: 'replace', nameText: 'X', clash: 'number' }, ['X.mkv', 'X (2).mkv', 'X (3).mkv']);
t('policy number: jumps over a name taken', ['a.mkv', 'b.mkv'], { nameMode: 'replace', nameText: 'X', clash: 'number' }, ['X (3).mkv', 'X (4).mkv'], { existing: () => new Set(['a.mkv', 'b.mkv', 'x.mkv', 'x (2).mkv']) });
{ const p = plan(['a.txt', 'b.txt'], { nameMode: 'replace', nameText: 'X', clash: 'skip' }); ok('after a policy the rows are not blocking, said resolved', p.summary.blocking === 0 && p.rows[1].flags.resolved === 'skip' && p.summary.skipped === 1 && p.summary.warnings === 1, p.summary); }
t('a swap a↔b is no clash (the names are freed by each other)', ['a.txt', 'b.txt'], { find: '', nameMode: 'pattern', nameText: '{name}' }, ['a.txt', 'b.txt']);
{ const items = [it('1.txt'), it('2.txt'), it('3.txt')]; const p = B.planBatch(items, rec({ nameMode: 'pattern', nameText: '{n}', num: { on: true, start: 2 } }), { existing: () => new Set(['1.txt', '2.txt', '3.txt']) }); ok('a chain 1→2, 2→3, 3→4 is no clash', eq(p.rows.map((r) => r.to), ['2.txt', '3.txt', '4.txt']) && p.summary.blocking === 0, p.rows.map((r) => r.to)); }
{ const items = [it('a.txt'), it('b.txt')]; const p = B.planBatch(items, rec({ nameMode: 'pattern', nameText: '{n}', num: { on: true, start: 1 } }), { existing: () => new Set(['a.txt', 'b.txt']) }); ok('names «1», «2» free in the folder: fine', p.summary.blocking === 0); }
{ const p = plan(['a.txt'], { tf: { case: 'upper' } }); ok('a change of letter case only is a rename, not a clash with itself', p.rows[0].to === 'A.txt' && p.rows[0].action === 'rename' && !p.rows[0].flags.clashExisting, p.rows[0]); const q = plan(['a.txt'], { tf: { case: 'upper' } }, { existing: () => new Set(['a.txt']) }); ok('… even when the folder lists it', q.summary.blocking === 0, q.rows[0]); }
{ const p = B.planBatch([it('a.txt', { dir: '/d1' }), it('a.txt', { dir: '/d2' })], rec({ nameMode: 'replace', nameText: 'X' }), {}); ok('the same new name in two folders is no clash', p.summary.blocking === 0 && p.rows[0].to === 'X.txt'); }
// — the steps and the run, against a pretend folder
const fakeFs = (dirs) => { const fs = new Map(Object.entries(dirs).map(([d, ns]) => [d, new Set(ns)])); const log = []; let fail = null;
  const io = { list: async (d) => (fs.has(d) ? [...fs.get(d)] : null), rename: async (d, from, to) => { log.push(`${from}>${to}`); if (fail && fail(from, to)) throw new Error('read error'); const s = fs.get(d); if (!s.has(from)) throw new Error('not found'); if (s.has(to) && to.toLowerCase() !== from.toLowerCase()) throw new Error('exists'); if ([...s].some((x) => x.toLowerCase() === to.toLowerCase() && x !== from)) throw new Error('exists'); s.delete(from); s.add(to); } };
  return { fs, io, log, failWhen: (f) => { fail = f; }, names: (d) => [...fs.get(d)].sort() }; };
const Rn = (pairs, d = '/d') => pairs.map(([from, to]) => ({ dir: d, from, to }));
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), m }; };
(async () => {
  const run = (f, rens, o = {}) => B.runRenames(rens, f.io, { id: o.id ?? 'j1', ...o });
  { const f = fakeFs({ '/d': ['a', 'b', 'x'] }); const r = await run(f, Rn([['a', 'b'], ['b', 'a']])); ok('swap a↔b by way of a temporary name; nothing lost', eq(f.names('/d'), ['a', 'b', 'x']) && r.moved.length === 2 && f.log.some((l) => l.includes('.ktren-')) && r.failed.length === 0, { log: f.log, r }); ok('… each now holds the other (a→tmp, b→a, tmp→b)', eq(f.log.length, 3)); }
  { const f = fakeFs({ '/d': ['1', '2', '3'] }); const r = await run(f, Rn([['1', '2'], ['2', '3'], ['3', '4']])); ok('chain 1→2→3→4: the end first, no temporary name', eq(f.names('/d'), ['2', '3', '4']) && !f.log.some((l) => l.includes('.ktren-')) && r.moved.length === 3, f.log); }
  { const f = fakeFs({ '/d': ['1', '2', '3'] }); const r = await run(f, Rn([['1', '2'], ['2', '3'], ['3', '1']])); ok('a ring of three: all moved, one temporary name', eq(f.names('/d'), ['1', '2', '3']) && r.moved.length === 3 && f.log.filter((l) => l.includes('.ktren-')).length === 2, f.log); }
  { const f = fakeFs({ '/d': ['a.txt', 'b'] }); const r = await run(f, Rn([['a.txt', 'A.txt']])); ok('a change of letter case only: by way of a temporary name (any storage)', f.names('/d').includes('A.txt') && r.moved.length === 1 && f.log.length === 2, f.log); }
  { const many = Array.from({ length: 2000 }, (_, i) => String(i)); const f = fakeFs({ '/d': many }); const t0 = Date.now(); const r = await run(f, Rn(many.map((n, i) => [n, String(i + 1)]))); ok('a chain of 2000 in the worst order: right, quick, no temporary name', r.moved.length === 2000 && !f.log.some((l) => l.includes('.ktren-')) && Date.now() - t0 < 4000 && f.fs.get('/d').has('2000') && !f.fs.get('/d').has('0'), { ms: Date.now() - t0 }); }
  { const f = fakeFs({ '/d': ['a', 'b', 'c', 'd'] }); let cancel = false; const r = await run(f, Rn([['a', 'x'], ['b', 'y'], ['c', 'z'], ['d', 'w']]), { progress: (k) => { if (k === 1) cancel = true; }, cancelled: () => cancel }); ok('cancel midway: the rest untouched, what was done kept, no temporary name', r.cancelled && eq(f.names('/d'), ['c', 'd', 'x', 'y']) && r.untouched.length === 2 && r.stranded.length === 0, { names: f.names('/d'), r }); }
  { const f = fakeFs({ '/d': ['a', 'b', 'c', 'd', 'e', 'f'] }); let cancel = false; const r = await run(f, Rn([['a', 'b'], ['b', 'a'], ['c', 'd'], ['d', 'c'], ['e', 'g'], ['f', 'h']]), { progress: (k) => { if (k === 3) cancel = true; }, cancelled: () => cancel }); ok('cancel in the middle of a swap: the swap is finished, no temporary name left', r.cancelled && r.stranded.length === 0 && !f.names('/d').some((x) => x.startsWith('.ktren')) && f.names('/d').length === 6 && r.moved.includes(0) && r.moved.includes(1), { names: f.names('/d'), r }); }
  { const f = fakeFs({ '/d': ['a', 'b', 'c'] }); f.failWhen((from) => from === 'b'); const r = await run(f, Rn([['a', 'x'], ['b', 'y'], ['c', 'z']])); ok('a step failing in the middle: that item listed, the others done', eq(f.names('/d'), ['b', 'x', 'z']) && r.failed.length === 1 && r.failed[0].i === 1 && r.moved.length === 2, { names: f.names('/d'), r }); }
  { const f = fakeFs({ '/d': ['a', 'b'] }); const st = store(); f.failWhen((from, to) => to === 'b' && from.startsWith('.ktren')); const r = await B.runRenames(Rn([['a', 'b'], ['b', 'a']]), f.io, { id: 'sw', journal: new B.Journal('sw', st) }); ok('a swap whose last step fails: told, the item left under its temporary name, the journal kept (Finish / Undo later)', r.failed.length === 1 && r.stranded.length === 1 && f.names('/d').length === 2 && B.readJournal(st) !== null, { names: f.names('/d'), r }); f.failWhen(null); const jr = B.readJournal(st); const w = B.whereNow(jr, (d, n) => f.fs.get(d)?.has(n)); await B.runRenames(B.recoveryRens(jr, w.at, 'undo'), f.io, { id: 'sw2' }); ok('… and Undo from the journal puts both back', eq(f.names('/d'), ['a', 'b']), f.names('/d')); }
  { const f = fakeFs({ '/d': ['a', 'b'] }); f.fs.get('/d').add('x'); const r = await run(f, Rn([['a', 'x'], ['b', 'y']])); ok('a target that appeared since the preview: that item failed (exists), the other done', r.failed.length === 1 && r.failed[0].i === 0 && /exists/.test(r.failed[0].why) && f.names('/d').includes('a') && f.names('/d').includes('y') && f.names('/d').includes('x'), r); }
  { const f = fakeFs({ '/d': ['b'] }); const r = await run(f, Rn([['a', 'x'], ['b', 'y']])); ok('a source gone since the preview: listed, the other done', r.failed.length === 1 && r.failed[0].why === 'not found' && f.names('/d').includes('y'), r); }
  { const f = fakeFs({ '/d': ['a', 'b'] }); f.fs.get('/d').add('x'); const g = f.io.rename; let injected = false; f.io.rename = async (d, from, to) => { if (!injected && from === 'a') { injected = true; f.fs.get('/d').add('y'); } return g(d, from, to); }; const r = await run(f, Rn([['a', 'z'], ['b', 'y']])); ok('a target appearing between the look and the step: the storage refuses it, never overwritten', r.failed.length === 1 && f.names('/d').includes('b') && f.names('/d').includes('y'), { names: f.names('/d'), r }); }
  { const f = fakeFs({ '/d': ['a', 'b', 'c'] }); const rens = Rn([['a', 'b'], ['b', 'c'], ['c', 'a']]); const r = await run(f, rens); const u = B.undoRens(rens, r); const r2 = await run(f, u.rens, { id: 'u1' }); ok('Undo of a finished ring restores every name', eq(f.names('/d'), ['a', 'b', 'c']) && r2.moved.length === 3 && f.names('/d').every((x) => !x.startsWith('.')), { u, names: f.names('/d') }); }
  { const f = fakeFs({ '/d': ['a', 'b', 'c', 'd'] }); let cancel = false; const rens = Rn([['a', 'x'], ['b', 'y'], ['c', 'z'], ['d', 'w']]); const r = await run(f, rens, { progress: (k) => { if (k === 1) cancel = true; }, cancelled: () => cancel }); const u = B.undoRens(rens, r); await run(f, u.rens, { id: 'u2' }); ok('Undo after a cancelled (partial) run restores every name', eq(f.names('/d'), ['a', 'b', 'c', 'd']) && u.rens.length === 2, { names: f.names('/d'), u }); }
  { const f = fakeFs({ '/d': ['a', 'b', 'c'] }); f.failWhen((from) => from === 'b'); const rens = Rn([['a', 'x'], ['b', 'y'], ['c', 'z']]); const r = await run(f, rens); f.failWhen(null); const u = B.undoRens(rens, r); await run(f, u.rens, { id: 'u3' }); ok('Undo after a run with a failure restores the ones that were done', eq(f.names('/d'), ['a', 'b', 'c']) && u.rens.length === 2); }
  { const f = fakeFs({ '/d': ['a', 'b'] }); const rens = Rn([['a', 'b'], ['b', 'a']]); const r = await run(f, rens); const u = B.undoRens(rens, r); ok('Undo of nothing moved: nothing to do', B.undoRens(rens, { at: ['a', 'b'] }).rens.length === 0 && u.rens.length === 2); }
  // — a run cut short (the app closed): the journal, then Finish or Undo
  const cut = async (afterSteps, inFlight) => {
    const f = fakeFs({ '/d': ['a', 'b', 'c', 'd', 'x'] }); const st = store(); const rens = Rn([['a', 'b'], ['b', 'a'], ['c', 'e'], ['d', 'c']]);
    const present = new Set(['a', 'b', 'c', 'd', 'x']); const steps = B.planSteps(rens, () => present, 'cut'); const j = new B.Journal('cut', st); j.begin(rens, steps);
    for (let k = 0; k < afterSteps; k++) { const s = steps[k]; await f.io.rename(s.dir, s.from, s.to); j.mark(k, true); }
    if (inFlight) { const s = steps[afterSteps]; await f.io.rename(s.dir, s.from, s.to); } // (done on the disk, not yet written down)
    return { f, st, rens, steps };
  };
  for (const [after, flight] of [[0, false], [1, false], [1, true], [2, false], [3, true]]) {
    const { f, st, rens } = await cut(after, flight);
    const jr = B.readJournal(st); const where = B.whereNow(jr, (d, n) => f.fs.get(d)?.has(n)); const fin = B.recoveryRens(jr, where.at, 'finish');
    await B.runRenames(fin, f.io, { id: 'fin' });
    const want = ['b', 'a', 'e', 'c', 'x'].sort(); ok(`interrupted after ${after}${flight ? ' (+1 under way)' : ''} steps: Finish completes the plan, no temporary name`, eq(f.names('/d'), want) && where.problems.length === 0, { names: f.names('/d'), where });
    const g = await cut(after, flight); const jr2 = B.readJournal(g.st); const w2 = B.whereNow(jr2, (d, n) => g.f.fs.get(d)?.has(n)); const un = B.recoveryRens(jr2, w2.at, 'undo'); await B.runRenames(un, g.f.io, { id: 'und' });
    ok(`interrupted after ${after}${flight ? ' (+1 under way)' : ''} steps: Undo takes everything back`, eq(g.f.names('/d'), ['a', 'b', 'c', 'd', 'x']), g.f.names('/d'));
  }
  { const f = fakeFs({ '/d': ['a', 'b'] }); const st = store(); const rens = Rn([['a', 'b'], ['b', 'a']]); const r = await B.runRenames(rens, f.io, { id: 'ok1', journal: new B.Journal('ok1', st) }); ok('a clean run leaves no journal', r.moved.length === 2 && B.readJournal(st) === null && st.m.size === 0, [...st.m.keys()]); }
  { const f = fakeFs({ '/d': Array.from({ length: 5000 }, (_, i) => `file name number ${i}.mkv`) }); const st = store(); const rens = Rn(Array.from({ length: 5000 }, (_, i) => [`file name number ${i}.mkv`, `Show - ${String(i + 1).padStart(4, '0')}.mkv`])); const j = new B.Journal('big', st); const r = await B.runRenames(rens, f.io, { id: 'big', journal: j }); ok(`5000 renames: journal ${Math.round(j.size / 1024)} KB, done, journal cleared`, r.moved.length === 5000 && j.size < 600000 && st.m.size === 0, { size: j.size }); }
  { const f = fakeFs({ '/d': ['a'] }); const rens = Rn([['a', 'b']]); const bad = { getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => {} }; const r = await B.runRenames(rens, f.io, { id: 'q', journal: new B.Journal('q', bad) }); ok('a store that is full: the run still goes on', r.moved.length === 1); }
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();

