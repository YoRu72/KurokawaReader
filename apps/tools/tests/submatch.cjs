// node tests/submatch.cjs: which file of a subtitle pack is the episode's (src/player/subMatch.ts) — names read for
// their season and episode past what is not one (resolutions, codecs, CRCs, years, channels), Arabic digits and
// words, ranges as batches, decimals and versions; the pack matched season-aware, absolute numbering with a known
// or a plain offset, the user's own shift; a hand-picked file's shift; the candidate chosen by kind and language.
const esbuild = require('esbuild'); const path = require('node:path');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/player/subMatch.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' });
const m = {}; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports = {}); const S = m.exports;
// [name, season, episode, batch]
const TABLE = [
  ['[SubsPlease] Frieren - 05 (1080p) [ABCD1234].ass', undefined, 5, false],
  ['Frieren.S02E05.1080p.WEB-DL.DDP5.1.H.264.ar.srt', 2, 5, false],
  ['Show S02E05v2.ass', 2, 5, false],
  ['Show 2x05.srt', 2, 5, false],
  ['Show Season 2 - 05.ass', 2, 5, false],
  ['Show S2 - 05.ass', 2, 5, false],
  ['Show 2nd Season - 05.ass', 2, 5, false],
  ['Show - 005.ass', undefined, 5, false],
  ['Show - 05v2.ass', undefined, 5, false],
  ['Show - 05.5.ass', undefined, 5.5, false],
  ['Show - 01-12 [Batch].ass', undefined, 1, true],
  ['Show 01~12.ass', undefined, 1, true],
  ['Show S01E01-E02.ass', 1, 1, true],
  ['Show - 05 [1080p][x264][10bit].ass', undefined, 5, false],
  ['Show (2024) - 07.srt', undefined, 7, false],
  ['Show 2024.srt', undefined, undefined, false],
  ['Show S2.ass', 2, undefined, false],
  ['المسلسل - الحلقة ٠٥.ass', undefined, 5, false],
  ['الحلقة 12.srt', undefined, 12, false],
  ['Show Episode 5.srt', undefined, 5, false],
  ['Show EP05.srt', undefined, 5, false],
  ['Show E05.srt', undefined, 5, false],
  ['Show #05.srt', undefined, 5, false],
  ['Show - 05 - The Title.srt', undefined, 5, false],
  ['[Group] Show [05].ass', undefined, 5, false],
  ['Show 2 - 05.ass', undefined, 5, false],
  ['Mob Psycho 100 - 03.ass', undefined, 3, false],
  ['05.ass', undefined, 5, false],
  ['Season 3/07.ass', 3, 7, false],
  ['Show AAC2.0 - 08.srt', undefined, 8, false],
  ['ショー 第5話.ass', undefined, 5, false],
  ['Show 1920x1080 - 09.ass', undefined, 9, false],
];
for (const [name, s, e, b] of TABLE) { const r = S.subEpisode(name); ok(`read «${name}»`, r.season === s && r.episode === e && r.batch === b, r); }
const pack = (names) => S.packItems(names);
const hit = (items, w) => S.matchEpisode(items, w).map((i) => i.path);
const one = pack(['Show - 01.ass', 'Show - 02.ass', 'Show - 03.ass', 'Show - 03.5.ass', 'Show - 01-03 [Batch].ass', 'fonts/A.ttf']);
ok('plain pack: episode 3, not 3.5, not the batch', JSON.stringify(hit(one, { episode: 3 })) === '["Show - 03.ass"]', hit(one, { episode: 3 }));
ok('plain pack: an episode it lacks → none', hit(one, { episode: 9 }).length === 0);
ok('names without a season match any season in a one-season pack', hit(one, { episode: 2, season: 2 })[0] === 'Show - 02.ass');
const two = pack(['S01/Show S01E05.ass', 'S02/Show S02E05.ass', 'Show S02E06.ass', 'Show - 07.ass']);
ok('season-aware: S02E05 for season 2', JSON.stringify(hit(two, { episode: 5, season: 2 })) === '["S02/Show S02E05.ass"]', hit(two, { episode: 5, season: 2 }));
ok('season-aware: S01E05 for season 1', hit(two, { episode: 5, season: 1 })[0] === 'S01/Show S01E05.ass');
ok('a season-less name not taken when the pack names other seasons', hit(two, { episode: 7, season: 2 }).length === 0);
ok('no season wanted, several in the pack: season 1', hit(two, { episode: 5 })[0] === 'S01/Show S01E05.ass');
const abs = pack(Array.from({ length: 24 }, (_, i) => `Show - ${String(i + 1).padStart(2, '0')}.ass`));
ok('absolute numbering with a known offset: S2E3 → 15', hit(abs, { episode: 3, season: 2, seasonLength: 12, offset: 12 })[0] === 'Show - 15.ass', hit(abs, { episode: 3, season: 2, seasonLength: 12, offset: 12 }));
ok('absolute numbers but offset unknown: by number', hit(abs, { episode: 3, season: 2, seasonLength: 12 })[0] === 'Show - 03.ass');
const late = pack(Array.from({ length: 12 }, (_, i) => `Show - ${i + 13}.ass`));
ok('a pack starting past the season length: its start is the season\'s (ep 1 → 13)', hit(late, { episode: 1, seasonLength: 12 })[0] === 'Show - 13.ass');
ok('numbers inside the season length: by number', hit(one, { episode: 2, seasonLength: 12, offset: 12 })[0] === 'Show - 02.ass');
// The user's own shift.
ok('a shift set by hand: ep 5 + 12 → 17', hit(late, { episode: 5, shift: 12 })[0] === 'Show - 17.ass');
ok('a shift wins over the plain number', hit(abs, { episode: 5, shift: 12 })[0] === 'Show - 17.ass');
ok('impliedShift: file 17 for episode 5 → +12', S.impliedShift(S.subEpisode('Show - 17.ass'), { episode: 5, season: 2 }) === 12);
ok('impliedShift: same number → none', S.impliedShift(S.subEpisode('Show - 05.ass'), { episode: 5 }) === null);
ok('impliedShift: another season named → none', S.impliedShift(S.subEpisode('Show S01E17.ass'), { episode: 5, season: 2 }) === null);
ok('impliedShift: a batch → none', S.impliedShift(S.subEpisode('Show 01-12.ass'), { episode: 5 }) === null);
ok('impliedShift: negative shifts too', S.impliedShift(S.subEpisode('Show - 01.ass'), { episode: 13 }) === -12);
// Candidates.
const multi = pack(['[A] Show - 05 [Arabic].ass', '[B] Show - 05.en.srt', '[B] Show - 05.ar.srt', '[A] Show - 06 [Arabic].ass', '[B] Show - 06.ar.srt']);
const c5 = S.matchEpisode(multi, { episode: 5 }); ok('several variants of one episode all found', c5.length === 3, c5);
ok('picked by language, then ASS', S.pickCandidate(c5, undefined, ['ar', 'en']).path === '[A] Show - 05 [Arabic].ass');
ok('English first when preferred', S.pickCandidate(c5, undefined, ['en']).path === '[B] Show - 05.en.srt');
const kind = S.variantOf('[B] Show - 05.ar.srt'); const c6 = S.matchEpisode(multi, { episode: 6 });
ok('the kind chosen before kept for the next episode', S.pickCandidate(c6, kind, ['ar']).path === '[B] Show - 06.ar.srt');
ok('covered episodes listed', JSON.stringify(S.covered(one).map((x) => x.episode)) === '[1,2,3,3.5]', S.covered(one));
console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
