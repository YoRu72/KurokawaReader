// node tests/submatch.cjs: which file of a subtitle pack is the episode's (src/player/subMatch.ts) — names read for
// their season and episode past what is not one (resolutions, codecs, CRCs, years, channels), Arabic digits and
// words, ranges as batches, decimals and versions; the pack matched season-aware, absolute numbering with a known
// or a plain offset, the user's own shift; a hand-picked file's shift; the candidate chosen by kind and language;
// specials never an episode; languages, groups, kinds and cue spans; rankFiles' ranking with its reasons and guesses,
// per source; a correction learned (shift, kind, group, language) and applied to the next episodes. All names made up.
const esbuild = require('esbuild'); const path = require('node:path');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/player/subMatch.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' });
const m = {}; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports = {}); const S = m.exports;
// [name, season, episode, batch]
const TABLE = [
  // (Every way an episode is said.)
  ['Kumo S01E04.ass', 1, 4, false], ['kumo.s01e04.srt', 1, 4, false], ['Kumo 1x04.srt', 1, 4, false], ['Kumo - 04.ass', undefined, 4, false],
  ['Kumo [04].ass', undefined, 4, false], ['Kumo (04).ass', undefined, 4, false], ['Kumo E04.ass', undefined, 4, false], ['Kumo EP04.ass', undefined, 4, false],
  ['Kumo Ep.04.ass', undefined, 4, false], ['Kumo Episode 4.srt', undefined, 4, false], ['Kumo episode 04 - Title.srt', undefined, 4, false], ['くも 第04話.ass', undefined, 4, false],
  ['くも 第4话.ass', undefined, 4, false], ['Kumo #04.ass', undefined, 4, false], ['Kumo - 04v2.ass', undefined, 4, false], ['Kumo 04v3.ass', undefined, 4, false],
  ['Kumo - 12 END.ass', undefined, 12, false], ['Kumo 12 END [1080p].ass', undefined, 12, false], ['Kumo - 12 (END).srt', undefined, 12, false], ['Kumo_-_04_[720p].ass', undefined, 4, false],
  ['Kumo.04.ass', undefined, 4, false], ['04 - Title.srt', undefined, 4, false], ['Kumo S01 E04.ass', 1, 4, false], ['Kumo S01-E04.ass', 1, 4, false],
  // (Batches: never one episode.)
  ['Kumo 01-12.ass', undefined, 1, true], ['Kumo [01-12].ass', undefined, 1, true], ['Kumo (01~12) [BD].ass', undefined, 1, true], ['Kumo - 01 ~ 12.srt', undefined, 1, true], ['Kumo S01E01-E12.srt', 1, 1, true], ['Kumo Episode 1-12.srt', undefined, 1, true],
  // (Decimals.)
  ['Kumo - 04.5.ass', undefined, 4.5, false], ['Kumo - 12.5 [ABCD1234].ass', undefined, 12.5, false], ['Kumo S01E04.5.ass', 1, 4.5, false],
  // (What is never the episode.)
  ['Kumo - 04 [1080p].ass', undefined, 4, false], ['Kumo - 04 [720p][x264].ass', undefined, 4, false], ['Kumo [1080p] - 04.ass', undefined, 4, false], ['Kumo 2026 - 04.srt', undefined, 4, false],
  ['Kumo (2026) [04].srt', undefined, 4, false], ['Kumo - 04 [x265 10bit].ass', undefined, 4, false], ['Kumo - 04 [A1B2C3D4].ass', undefined, 4, false], ['Kumo - 04 (A1B2C3D4).ass', undefined, 4, false],
  ['Kumo - 04 [5.1].srt', undefined, 4, false], ['Kumo - 04 [AAC 2.0].srt', undefined, 4, false], ['Kumo 04 FLAC 5.1.srt', undefined, 4, false], ['Kumo - 04 [HEVC][Hi10P].ass', undefined, 4, false],
  ['Kumo - 04 [1920x1080].ass', undefined, 4, false], ['Kumo.S01E04.2160p.H.265.DDP5.1-GRP.srt', 1, 4, false], ['Kumo - 04 [4K].ass', undefined, 4, false], ['Kumo 1080 - 04.ass', undefined, 4, false],
  ['Kumo 86 - 04.ass', undefined, 4, false],
  // (Seasons.)
  ['Kumo S2 - 03.ass', 2, 3, false], ['Kumo Season 2 Episode 3.ass', 2, 3, false], ['Kumo 2nd Season - 03.ass', 2, 3, false], ['Season 02/Kumo - 03.ass', 2, 3, false], ['Kumo S02/03.ass', 2, 3, false], ['الموسم 2 الحلقة 3.srt', 2, 3, false],
  ['Kumo - 15.ass', undefined, 15, false], ['Kumo S02E15.ass', 2, 15, false],

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
for (const [name, s, e, b] of TABLE) { const r = S.subEpisode(name); ok(`read «${name}»`, r.season === s && r.episode === e && r.batch === b && !r.special, r); }
// Specials: read, but never a normal episode.
const SPECIALS = ['Kumo - NCOP.ass', 'Kumo - NCOP1.ass', 'Kumo NCED 02.ass', 'Kumo - OVA.ass', 'Kumo OVA 2.srt', 'Kumo - OAD 01.ass', 'Kumo - SP 01.ass', 'Kumo - OP1.ass', 'Kumo - ED.ass', 'Kumo [NCOP] [1080p].ass', 'Kumo S00E01.ass', 'Specials/Kumo - 01.ass', 'Kumo - Creditless ED 02.ass', 'Kumo Special 3.srt', 'Kumo - Preview 04.ass', 'Extras/Kumo 04.srt'];
for (const n of SPECIALS) ok(`a special: «${n}»`, S.subEpisode(n).special === true, S.subEpisode(n));
ok('«Ed» in a title is not an ending', !S.subEpisode('Ed and Kumo - 04.ass').special && S.subEpisode('Ed and Kumo - 04.ass').episode === 4);
ok('«Spirit» is not «SP»', !S.subEpisode('Spirit - 04.ass').special);
// How the number was read (a lone one is a guess).
ok('how: SxxEyy', S.subEpisode('Kumo S01E04.ass').how === 'sxe'); ok('how: said as an episode', S.subEpisode('Kumo EP04.ass').how === 'marker');
ok('how: after a dash', S.subEpisode('Kumo - 04.ass').how === 'dash'); ok('how: in brackets', S.subEpisode('Kumo [04].ass').how === 'bracket'); ok('how: a lone number', S.subEpisode('Kumo 04.ass').how === 'lone');
// Languages.
const LANGS = [['Kumo - 04.ar.ass', 'ar'], ['Kumo - 04.ara.srt', 'ar'], ['Kumo - 04 [Arabic].ass', 'ar'], ['Kumo - 04 (ARA).ass', 'ar'], ['Kumo - 04.en.srt', 'en'], ['Kumo - 04.eng.forced.srt', 'en'], ['Kumo - 04 [English].ass', 'en'], ['Kumo - 04 [eng].ass', 'en'],
  ['Kumo - 04.ja.srt', 'ja'], ['Kumo - 04 [JPN].ass', 'ja'], ['Kumo - 04.zh-hans.ass', 'zh'], ['Kumo - 04 [CHS].ass', 'zh'], ['Kumo - 04.ko.srt', 'ko'], ['Arabic/Kumo - 04.ass', 'ar'], ['ar/Kumo - 04.ass', 'ar'], ['Kumo - 04_ar.srt', 'ar'], ['Kumo - 04 العربية.srt', 'ar'],
  ['Kumo - It Begins - 04.srt', undefined], ['Kumo - De Facto 04.srt', undefined], ['Kumo - 04.srt', undefined], ['Kumo - 04 [Arabic+English].ass', 'ar']];
for (const [n, l] of LANGS) ok(`language of «${n}»: ${l}`, S.langOfName(n) === l, S.langOfName(n));
// Groups.
const GROUPS = [['[Kiri] Kumo - 04.ass', 'kiri'], ['(Kiri) Kumo - 04.ass', 'kiri'], ['Kumo.S01E04.1080p.WEB.H264-NEBULA.srt', 'nebula'], ['Kumo.S01E04.1080p.WEB.H264-NEBULA.ar.srt', 'nebula'], ['Kumo - 04.ass', undefined], ['Kumo - 04v2.ass', undefined], ['[04] Kumo.ass', undefined], ['Kumo-04.srt', undefined]];
for (const [n, g] of GROUPS) ok(`group of «${n}»: ${g}`, S.groupOf(n) === g, S.groupOf(n));
ok('kind: .ass', S.kindOf('a/b - 04.ASS') === 'ass'); ok('kind: .srt', S.kindOf('x.srt') === 'srt');
// Cue spans.
ok('cue span of an SRT', JSON.stringify(S.cueSpan('1\n00:00:01,500 --> 00:00:03,000\nA\n\n2\n00:23:40,000 --> 00:23:42,250\nB\n')) === JSON.stringify({ first: 1.5, last: 1422.25 }), S.cueSpan('1\n00:00:01,500 --> 00:00:03,000\nA\n\n2\n00:23:40,000 --> 00:23:42,250\nB\n'));
ok('cue span of an ASS', S.cueSpan('[Events]\nDialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,A\nDialogue: 0,0:22:10.50,0:22:12.00,Default,,0,0,0,,B\n').last === 1332);
ok('cue span of nothing', S.cueSpan('hello') === undefined);
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
// ---------- rankFiles: the ranked list, its reasons, its guesses ----------
const F = (paths, source) => paths.map((p) => ({ path: p, source }));
const top = (files, c) => { const r = S.rankFiles(files, c); return r[0] ? r[0].file.path : undefined; };
const R = [];
const p12 = F(Array.from({ length: 12 }, (_, i) => `Kumo - ${String(i + 1).padStart(2, '0')}.ass`), 'A');
R.push(['plain pack, episode 4', top(p12, { episode: 4 }) === 'Kumo - 04.ass']);
R.push(['plain pack, an episode it lacks → none', S.rankFiles(p12, { episode: 13 }).length === 0]);
R.push(['plain pack: reason is the number', S.rankFiles(p12, { episode: 4 })[0].basis === 'number']);
const withJunk = F(['Kumo - 01-12 [Batch].ass', 'Kumo - NCOP.ass', 'Kumo - OVA 04.ass', 'Kumo - 04.5.ass', 'Kumo - 04.ass', 'Kumo - SP 04.ass'], 'A');
R.push(['batch, specials and 4.5 never episode 4', JSON.stringify(S.rankFiles(withJunk, { episode: 4 }).map((x) => x.file.path)) === '["Kumo - 04.ass"]']);
R.push(['an OVA is not episode 1', S.rankFiles(F(['Kumo - OVA 01.ass'], 'A'), { episode: 1 }).length === 0]);
const s2 = F(['Kumo S01E03.ass', 'Kumo S02E03.ass', 'Kumo S02E04.ass'], 'A');
R.push(['season aware: S2E3', top(s2, { episode: 3, season: 2 }) === 'Kumo S02E03.ass']);
R.push(['season aware: reason exact', S.rankFiles(s2, { episode: 3, season: 2 })[0].basis === 'exact']);
R.push(['season aware: S1E3', top(s2, { episode: 3, season: 1 }) === 'Kumo S01E03.ass']);
const absF = F(Array.from({ length: 24 }, (_, i) => `Kumo - ${String(i + 1).padStart(2, '0')}.ass`), 'A');
R.push(['absolute told: S2E3 = 15', top(absF, { episode: 3, season: 2, absolute: 15, seasonLength: 12 }) === 'Kumo - 15.ass']);
R.push(['absolute told: reason absolute, not a guess', (() => { const r = S.rankFiles(absF, { episode: 3, season: 2, absolute: 15, seasonLength: 12 })[0]; return r.basis === 'absolute' && !r.guess; })()]);
R.push(['absolute told, season length unknown, pack runs past: 15', top(absF, { episode: 3, season: 2, absolute: 15 }) === 'Kumo - 15.ass']);
R.push(['per-season pack beside an absolute number: S02E03 wins', top(F(['Kumo S02E03.ass', 'Kumo - 15.ass'], 'A'), { episode: 3, season: 2, absolute: 15 }) === 'Kumo S02E03.ass']);
R.push(['a season\'s own numbers (1..12) with absolute 15 told: 03', top(F(Array.from({ length: 12 }, (_, i) => `Kumo S2 - ${String(i + 1).padStart(2, '0')}.ass`), 'A'), { episode: 3, season: 2, absolute: 15 }) === 'Kumo S2 - 03.ass']);
const lateF = F(Array.from({ length: 12 }, (_, i) => `Kumo - ${i + 13}.ass`), 'A');
R.push(['a pack starting past the season (13..24), length known: ep 1 → 13, a guess', (() => { const r = S.rankFiles(lateF, { episode: 1, seasonLength: 12 })[0]; return r && r.file.path === 'Kumo - 13.ass' && r.guess; })()]);
R.push(['the same pack, length unknown: nothing for ep 1', S.rankFiles(lateF, { episode: 1 }).length === 0]);
// (Resolution, year, CRC, codec numbers in every name.)
const noisy = F(['[Kiri] Kumo (2026) - 04 [1080p][x264][A1B2C3D4].ass', '[Kiri] Kumo (2026) - 05 [1080p][x264][B1B2C3D4].ass'], 'A');
R.push(['noisy names: episode 4', top(noisy, { episode: 4 }) === noisy[0].path]);
R.push(['noisy names: nothing for 1080 or 2026', S.rankFiles(noisy, { episode: 1080 }).length === 0 && S.rankFiles(noisy, { episode: 2026 }).length === 0 && S.rankFiles(noisy, { episode: 264 }).length === 0]);
// (Languages.)
const ml = F(['Kumo - 04.en.srt', 'Kumo - 04.ar.srt', 'Kumo - 04.fr.srt', 'Kumo - 04.srt'], 'A');
R.push(['language preference first: ar', top(ml, { episode: 4, langs: ['ar', 'en'] }) === 'Kumo - 04.ar.srt']);
R.push(['language preference first: en', top(ml, { episode: 4, langs: ['en', 'ar'] }) === 'Kumo - 04.en.srt']);
R.push(['an unwanted language comes after an untagged file', (() => { const r = S.rankFiles(ml, { episode: 4, langs: ['ja'] }).map((x) => x.file.path); return r[0] === 'Kumo - 04.srt'; })()]);
R.push(['the language is in the reasons', S.rankFiles(ml, { episode: 4, langs: ['ar'] })[0].plus.includes('lang')]);
R.push(['[Arabic] tag counts', top(F(['Kumo - 04 [English].ass', 'Kumo - 04 [Arabic].ass'], 'A'), { episode: 4, langs: ['ar'] }) === 'Kumo - 04 [Arabic].ass']);
R.push(['Arabic folder counts', top(F(['English/Kumo - 04.ass', 'Arabic/Kumo - 04.ass'], 'A'), { episode: 4, langs: ['ar'] }) === 'Arabic/Kumo - 04.ass']);
// (Kinds.)
R.push(['.ass before .srt', top(F(['Kumo - 04.srt', 'Kumo - 04.ass'], 'A'), { episode: 4 }) === 'Kumo - 04.ass']);
R.push(['.srt before .vtt', top(F(['Kumo - 04.vtt', 'Kumo - 04.srt'], 'A'), { episode: 4 }) === 'Kumo - 04.srt']);
R.push(['language beats kind', top(F(['Kumo - 04.en.ass', 'Kumo - 04.ar.srt'], 'A'), { episode: 4, langs: ['ar'] }) === 'Kumo - 04.ar.srt']);
// (Groups.)
const gr = F(['[Kiri] Kumo - 04.ass', '[Mori] Kumo - 04.ass'], 'A');
R.push(['the video\'s own group first', top(gr, { episode: 4, videoName: '[Mori] Kumo - 04 [1080p].mkv' }) === '[Mori] Kumo - 04.ass']);
R.push(['the group reason given', S.rankFiles(gr, { episode: 4, videoName: '[Mori] Kumo - 04.mkv' })[0].plus.includes('group')]);
R.push(['the group chosen last time', top(gr, { episode: 4, lastGroup: 'mori' }) === '[Mori] Kumo - 04.ass']);
R.push(['scene group of the video', top(F(['Kumo.S01E04.WEB-ALPHA.srt', 'Kumo.S01E04.WEB-BETA.srt'], 'A'), { episode: 4, season: 1, videoName: 'Kumo.S01E04.1080p.WEB.H264-BETA.mkv' }) === 'Kumo.S01E04.WEB-BETA.srt']);
R.push(['two groups with no hint: a tie, a guess', S.rankFiles(gr, { episode: 4 })[0].guess === true]);
R.push(['language beats the group chosen last time', top(F(['[Kiri] Kumo - 04.en.ass', '[Mori] Kumo - 04.ar.ass'], 'A'), { episode: 4, langs: ['ar'], lastGroup: 'kiri' }) === '[Mori] Kumo - 04.ar.ass']);
// (Cue spans against the video's length.)
const sp = [{ path: '[Kiri] Kumo - 04.ass', source: 'A', last: 3300 }, { path: '[Mori] Kumo - 04.ass', source: 'A', last: 1410 }];
R.push(['a file running far past the video loses', top(sp, { episode: 4, duration: 1420 }) === '[Mori] Kumo - 04.ass']);
R.push(['a file far short of the video loses', top([{ path: '[Kiri] Kumo - 04.ass', source: 'A', last: 1400 }, { path: '[Mori] Kumo - 04.ass', source: 'A', last: 300 }], { episode: 4, duration: 1420 }) === '[Kiri] Kumo - 04.ass']);
R.push(['the span reason given', S.rankFiles(sp, { episode: 4, duration: 1420 }).some((x) => x.minus.includes('span'))]);
R.push(['no length known: spans ignored (tie)', S.rankFiles(sp, { episode: 4 })[0].score === S.rankFiles(sp, { episode: 4 })[1].score]);
// (Two sources numbered each from its own.)
const twoF = [...F(['[Kiri] Kumo - 01.ass', '[Kiri] Kumo - 02.ass'], 'K'), ...F(['Kumo S01E01.ar.srt', 'Kumo S01E02.ar.srt'], 'M')];
R.push(['two sources: both offer episode 2', S.rankFiles(twoF, { episode: 2, season: 1 }).length === 2]);
R.push(['two sources: the language decides', top(twoF, { episode: 2, season: 1, langs: ['ar'] }) === 'Kumo S01E02.ar.srt']);
R.push(['a season named in one source does not hide the other\'s bare numbers', S.rankFiles(twoF, { episode: 1, season: 1 }).some((x) => x.file.path === '[Kiri] Kumo - 01.ass')]);
// (A lone number is a guess.)
R.push(['a lone number is a guess', S.rankFiles(F(['Kumo 04.ass'], 'A'), { episode: 4 })[0].guess === true]);
R.push(['a dashed number is not', S.rankFiles(F(['Kumo - 04.ass'], 'A'), { episode: 4 })[0].guess === false]);
R.push(['a dashed number beats a lone one', top(F(['Kumo 04.srt', 'Kuma - 04.srt'], 'A'), { episode: 4 }) === 'Kuma - 04.srt']);
// (Titles.)
R.push(['the show\'s title in the name helps a tie', top(F(['Other - 04.ass', 'Kumo - 04.ass'], 'A'), { episode: 4, titles: ['Kumo'] }) === 'Kumo - 04.ass']);
// ---------- learning ----------
const plus12 = F(Array.from({ length: 12 }, (_, i) => `[Kiri] Kumo - ${i + 13}.ass`), 'P');
const LC = S.learnCorrection(plus12[0], { episode: 1 });
R.push(['correction: file 13 for episode 1 → shift +12', LC.shift === 12]);
R.push(['correction: its group and kind kept', LC.group === 'kiri' && LC.variant === S.variantOf(plus12[0].path)]);
const learned = { [S.learnKey('P', undefined)]: LC };
R.push(['learned shift applied: ep 2 → 14', top(plus12, { episode: 2, learned }) === '[Kiri] Kumo - 14.ass']);
R.push(['learned shift applied: ep 12 → 24', top(plus12, { episode: 12, learned }) === '[Kiri] Kumo - 24.ass']);
R.push(['learned: the reason is the correction', S.rankFiles(plus12, { episode: 5, learned })[0].basis === 'learned']);
R.push(['learned: per source — another source is not shifted', top([...plus12, ...F(['Kumo - 05.srt'], 'Q')], { episode: 5, learned, langs: [] }) !== undefined && S.rankFiles([...F(['Kumo - 05.srt'], 'Q')], { episode: 5, learned })[0].basis === 'number']);
R.push(['learned per season: season 2 not shifted by season 1\'s', S.rankFiles(F(['Kumo - 03.ass'], 'P'), { episode: 3, season: 2, learned: { [S.learnKey('P', 1)]: { shift: 12 } } })[0].basis === 'number']);
R.push(['correction: same number → no shift', S.learnCorrection({ path: 'Kumo - 05.ass' }, { episode: 5 }).shift === undefined]);
R.push(['correction: a batch → no shift', S.learnCorrection({ path: 'Kumo 01-12.ass' }, { episode: 5 }).shift === undefined]);
R.push(['correction: a special → no shift', S.learnCorrection({ path: 'Kumo - OVA 03.ass' }, { episode: 5 }).shift === undefined]);
R.push(['correction: another season → no shift', S.learnCorrection({ path: 'Kumo S01E17.ass' }, { episode: 5, season: 2 }).shift === undefined]);
R.push(['correction: the absolute number → no shift (absolute handles it)', S.learnCorrection({ path: 'Kumo - 15.ass' }, { episode: 3, season: 2, absolute: 15 }).shift === undefined]);
R.push(['correction: a negative shift', S.learnCorrection({ path: 'Kumo - 01.ass' }, { episode: 13 }).shift === -12]);
R.push(['correction: the language chosen', S.learnCorrection({ path: 'Kumo - 04.en.srt' }, { episode: 4 }).lang === 'en']);
const mlv = F(['[Kiri] Kumo - 05.ar.ass', '[Mori] Kumo - 05.en.srt', '[Kiri] Kumo - 06.ar.ass', '[Mori] Kumo - 06.en.srt'], 'A');
const L2 = { [S.learnKey('A', undefined)]: S.learnCorrection(mlv[1], { episode: 5 }) };
R.push(['learned kind beats the language preference next episode', top(mlv, { episode: 6, langs: ['ar'], learned: L2 }) === '[Mori] Kumo - 06.en.srt']);
R.push(['learned kind: the reason given', S.rankFiles(mlv, { episode: 6, langs: ['ar'], learned: L2 })[0].plus.includes('variant')]);
R.push(['forgotten (no learned): the language again', top(mlv, { episode: 6, langs: ['ar'] }) === '[Kiri] Kumo - 06.ar.ass']);
R.push(['the older per-show shift still read', top(plus12, { episode: 3, shift: 12 }) === '[Kiri] Kumo - 15.ass']);
R.push(['the older per-show kind still read', top(mlv, { episode: 6, langs: ['ar'], filter: S.variantOf(mlv[1].path) }) === '[Mori] Kumo - 06.en.srt']);
// (Collisions.)
R.push(['collision: «Kumo 2 - 04» is episode 4 of a title with a 2', top(F(['Kumo 2 - 04.ass', 'Kumo 2 - 02.ass'], 'A'), { episode: 4 }) === 'Kumo 2 - 04.ass']);
R.push(['collision: «86 - 04» never episode 86', S.rankFiles(F(['86 - 04.ass'], 'A'), { episode: 86 }).length === 0]);
R.push(['collision: a year beside a dashed number', top(F(['Kumo 2026 - 04.ass'], 'A'), { episode: 4 }) === 'Kumo 2026 - 04.ass']);
R.push(['collision: 5.1 audio never episode 5', S.rankFiles(F(['Kumo - 04 [AAC 5.1].ass'], 'A'), { episode: 5 }).length === 0]);
R.push(['collision: v2 beside v1 — v2 first', top(F(['Kumo - 04.ass', 'Kumo - 04v2.ass'], 'A'), { episode: 4 }) === 'Kumo - 04v2.ass']);
R.push(['collision: 04 END is episode 4', top(F(['Kumo - 04 END.ass'], 'A'), { episode: 4 }) === 'Kumo - 04 END.ass']);
R.push(['collision: NCED 04 never episode 4 beside a real 04', JSON.stringify(S.rankFiles(F(['Kumo - NCED 04.ass', 'Kumo - 04.ass'], 'A'), { episode: 4 }).map((x) => x.file.path)) === '["Kumo - 04.ass"]']);
R.push(['collision: 第04話 and - 04 both', S.rankFiles(F(['くも 第04話.ass', 'Kumo - 04.srt'], 'A'), { episode: 4 }).length === 2]);
R.push(['collision: a CRC that looks like digits', S.rankFiles(F(['Kumo - 04 [12345678].ass'], 'A'), { episode: 4 }).length === 1]);
R.push(['collision: x264 never episode 264', S.rankFiles(F(['Kumo x264 - 04.ass'], 'A'), { episode: 264 }).length === 0]);
R.push(['collision: 10bit never episode 10', S.rankFiles(F(['Kumo - 04 10bit.ass'], 'A'), { episode: 10 }).length === 0]);
R.push(['collision: 720 never an episode', S.rankFiles(F(['Kumo - 04 [720p].ass'], 'A'), { episode: 720 }).length === 0]);
R.push(['collision: a range in brackets is a batch', S.rankFiles(F(['Kumo [01-12].ass'], 'A'), { episode: 1 }).length === 0]);
R.push(['collision: Episode 4 and EP04 both match', S.rankFiles(F(['Kumo Episode 4.srt', 'Kumo EP04.ass'], 'A'), { episode: 4 }).length === 2]);
R.push(['collision: 1x04 is season 1', top(F(['Kumo 1x04.srt', 'Kumo 2x04.srt'], 'A'), { episode: 4, season: 2 }) === 'Kumo 2x04.srt']);
R.push(['collision: (04) and [04]', S.rankFiles(F(['Kumo (04).ass', 'Kumo [04].srt'], 'A'), { episode: 4 }).length === 2]);
R.push(['collision: #04', top(F(['Kumo #04.ass'], 'A'), { episode: 4 }) === 'Kumo #04.ass']);
R.push(['collision: the list is ranked by score', (() => { const r = S.rankFiles(ml, { episode: 4, langs: ['ar', 'en'] }); return r.every((x, i) => i === 0 || r[i - 1].score >= x.score); })()]);
for (const [n, c] of R) ok(`rank: ${n}`, !!c);
const total = TABLE.length + SPECIALS.length + LANGS.length + GROUPS.length + R.length; console.log(`table: ${total} cases`);
if (total < 120) { console.log('FAIL table under 120 cases'); fails++; }
console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
