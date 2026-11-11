// node tests/videoargs.cjs: what to get from a video page → yt-dlp's exact argument list (src/downloads/videoArgs.ts, pure):
// video MP4/MKV/WebM, MP3 / M4A / Opus / FLAC, subtitles, chapters, SponsorBlock, playlists, the speed options, and every
// free-text field refused or neutralised when it tries to smuggle in an option or a path. The finished lists also pass the
// computer's own vetting (desktop/ytdlp.cjs vetArgs), flag for flag.
const esbuild = require('esbuild'); const path = require('node:path'); const Module = require('node:module'); const fs = require('node:fs'); const os = require('node:os');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/downloads/videoArgs.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' });
const m = {}; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports = {}); const V = m.exports;
const o = (x) => V.normaliseOptions(x);
const SPEED = ['--http-chunk-size', '10M', '--retries', '10', '--fragment-retries', '10', '--throttled-rate', '100K', '--buffer-size', '64K'];
const T = '%(title)s [%(id)s]';
const J = (a) => JSON.stringify(a);
const same = (n, got, want) => ok(n, J(got) === J(want), { got, want });
const A = (opts, ctx) => V.buildVideoArgs(o(opts), ctx);
const all = [];
const t = (n, opts, ctx, want, extra) => { const r = A(opts, ctx); all.push(r.args); same(n, r.args, want); if (extra) extra(r); };

// (video)
t('best video, MP4 that plays everywhere', { embedThumb: false, embedMeta: false, chapters: 'off' }, {}, ['-f', 'bv*+ba/b', '-S', 'fps,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED], (r) => ok('  …needs ffmpeg to merge', r.needs.includes('merge')));
t('1080p60 MKV', { height: 1080, container: 'mkv', fps60: true, embedThumb: false, embedMeta: false, chapters: 'off' }, {}, ['-f', 'bv*+ba/b', '-S', 'res:1080,fps,vcodec:h264,acodec:m4a', '--merge-output-format', 'mkv', '--remux-video', 'mkv', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
t('720p WebM, 30 fps is enough', { height: 720, container: 'webm', fps60: false, embedThumb: true, embedMeta: false, chapters: 'off' }, {}, ['-f', 'bv*+ba/b', '-S', 'res:720,fps:30,vcodec:vp9,acodec:opus', '--merge-output-format', 'webm', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED], (r) => ok('  …a WebM takes no cover (said)', r.dropped.includes('cover') && !r.args.includes('--embed-thumbnail')));
t('smaller files: AV1/VP9 + Opus', { height: 1440, codec: 'small', container: 'mkv', embedThumb: false, embedMeta: false, chapters: 'off' }, {}, ['-f', 'bv*+ba/b', '-S', 'res:1440,fps,vcodec:av01,acodec:opus', '--merge-output-format', 'mkv', '--remux-video', 'mkv', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
// (audio)
t('MP3 320 with cover and tags', { mode: 'audio', audio: 'mp3', mp3Rate: '320', embedThumb: true, embedMeta: true, chapters: 'off' }, {}, ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '320K', '--embed-thumbnail', '--convert-thumbnails', 'jpg', '--embed-metadata', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
t('MP3 VBR best', { mode: 'audio', audio: 'mp3', mp3Rate: 'vbr', embedThumb: false, embedMeta: false, chapters: 'off' }, {}, ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
t('M4A as is, no ffmpeg: nothing that needs it', { mode: 'audio', audio: 'm4a' }, { ffmpeg: false }, ['-f', 'ba[ext=m4a]/ba', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED], (r) => { ok('  …needs nothing', r.needs.length === 0, r.needs); ok('  …cover, tags and chapters said as left out', ['cover', 'metadata', 'chapters'].every((x) => r.dropped.includes(x)), r.dropped); });
t('M4A with ffmpeg: pinned, copied not re-encoded', { mode: 'audio', audio: 'm4a', embedThumb: false, embedMeta: false, chapters: 'off' }, { ffmpeg: true }, ['-f', 'ba[ext=m4a]/ba', '-x', '--audio-format', 'm4a', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
t('Opus as is, no ffmpeg', { mode: 'audio', audio: 'opus' }, { ffmpeg: false }, ['-f', 'ba[acodec=opus]/ba', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
t('FLAC', { mode: 'audio', audio: 'flac', embedThumb: false, embedMeta: false, chapters: 'off' }, {}, ['-f', 'ba/b', '-x', '--audio-format', 'flac', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
t('WAV takes no cover', { mode: 'audio', audio: 'wav', embedThumb: true, embedMeta: false, chapters: 'off' }, {}, ['-f', 'ba/b', '-x', '--audio-format', 'wav', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
// (extras)
t('subtitles embedded, two languages', { embedThumb: false, embedMeta: false, chapters: 'off', subs: { on: true, langs: ['en', 'ar'], auto: false, how: 'embed', fmt: 'srt' } }, {}, ['-f', 'bv*+ba/b', '-S', 'fps,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--write-subs', '--sub-langs', 'en,ar', '--embed-subs', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
t('auto subs as separate .srt', { embedThumb: false, embedMeta: false, chapters: 'off', subs: { on: true, langs: ['en'], auto: true, how: 'file', fmt: 'srt' } }, {}, ['-f', 'bv*+ba/b', '-S', 'fps,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--write-subs', '--write-auto-subs', '--sub-langs', 'en', '--convert-subs', 'srt', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
t('chapters split into files', { embedThumb: false, embedMeta: false, chapters: 'split' }, {}, ['-f', 'bv*+ba/b', '-S', 'fps,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--split-chapters', '--no-playlist', '-o', `${T}.%(ext)s`, '-o', `chapter:${T} - %(section_number)02d %(section_title)s.%(ext)s`, ...SPEED]);
t('SponsorBlock remove', { embedThumb: false, embedMeta: false, chapters: 'off', sponsor: 'remove', sponsorCats: ['sponsor', 'selfpromo'] }, {}, ['-f', 'bv*+ba/b', '-S', 'fps,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--sponsorblock-remove', 'sponsor,selfpromo', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
t('thumbnail kept as a file', { embedThumb: false, embedMeta: false, chapters: 'off', thumbFile: true, mode: 'audio', audio: 'flac' }, {}, ['-f', 'ba/b', '-x', '--audio-format', 'flac', '--write-thumbnail', '--convert-thumbnails', 'jpg', '--no-playlist', '-o', `${T}.%(ext)s`, '-o', `thumbnail:${T}.%(ext)s`, ...SPEED]);
// (playlists)
t('playlist range with numbering', { mode: 'audio', audio: 'flac', embedThumb: false, embedMeta: false, chapters: 'off', playlist: 'range', range: '2-5, 8' }, {}, ['-f', 'ba/b', '-x', '--audio-format', 'flac', '--yes-playlist', '--playlist-items', '2-5,8', '-o', `%(playlist_index)02d - ${T}.%(ext)s`, ...SPEED]);
t('the whole playlist, Playlist/NN - Title, track numbers', { mode: 'audio', audio: 'mp3', mp3Rate: '192', embedThumb: false, embedMeta: true, chapters: 'off', trackNo: true, playlist: 'all', name: 'playlist' }, {}, ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '192K', '--embed-metadata', '--parse-metadata', 'playlist_index:%(track_number)s', '--yes-playlist', '-o', '%(playlist_title)s/%(playlist_index)02d - %(title)s.%(ext)s', ...SPEED]);
t('one video of a playlist link', { embedThumb: false, embedMeta: false, chapters: 'off', playlist: 'one' }, {}, ['-f', 'bv*+ba/b', '-S', 'fps,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4', '--remux-video', 'mp4', '--no-playlist', '-o', `${T}.%(ext)s`, ...SPEED]);
t('one entry added by itself: its place is literal, the list\'s title too', { mode: 'audio', audio: 'm4a', embedThumb: false, embedMeta: true, chapters: 'off', trackNo: true, name: 'playlist' }, { ffmpeg: true, playlistIndex: 7, playlistTitle: 'Road / Songs: 100%' }, ['-f', 'ba[ext=m4a]/ba', '-x', '--audio-format', 'm4a', '--embed-metadata', '--parse-metadata', '7:%(track_number)s', '--no-playlist', '-o', 'Road Songs 100%%/07 - %(title)s.%(ext)s', ...SPEED]);
t('one entry, numbered with the default name', { embedThumb: false, embedMeta: false, chapters: 'off', mode: 'audio', audio: 'flac' }, { playlistIndex: 3 }, ['-f', 'ba/b', '-x', '--audio-format', 'flac', '--no-playlist', '-o', `03 - ${T}.%(ext)s`, ...SPEED]);
// (speed)
t('concurrent fragments from the connections setting', { embedThumb: false, embedMeta: false, chapters: 'off', mode: 'audio', audio: 'flac' }, { fragments: V.resolveFragments(0, 8) }, ['-f', 'ba/b', '-x', '--audio-format', 'flac', '--no-playlist', '-o', `${T}.%(ext)s`, '-N', '8', ...SPEED]);
ok('Auto: the connections setting, else 4; a chosen number wins; never above 16', V.resolveFragments(0, 0) === 4 && V.resolveFragments(0, 6) === 6 && V.resolveFragments(2, 12) === 2 && V.resolveFragments(0, 64) === 16 && V.resolveFragments(undefined, undefined) === 4);
// (extras the settings add)
{ const r = A({ embedThumb: false, embedMeta: false, chapters: 'off', mode: 'audio', audio: 'flac' }, { extras: { section: '1:00-2:30,0:10-0:20', chapterMatch: 'Intro', headers: { Referer: 'https://x.test/' }, infoJson: true, comments: true, liveChat: true, cover: true } });
  const s = r.args.join(' '); ok('parts, headers, sidecars', ['--download-sections *1:00-2:30', '--download-sections *0:10-0:20', '--download-sections Intro', '--add-header Referer:https://x.test/', '--write-info-json', '--write-comments', '--sub-langs live_chat', '--write-thumbnail'].every((x) => s.includes(x)), s); }

// ---- injection ----
const bad = (n, opts, ctx, pred) => { const r = A(opts, ctx); all.push(r.args); ok(n, pred(r), r); };
const flagsOf = (a) => a.filter((x) => x.startsWith('-'));
bad('template with ../ is refused (the plain name is used)', { name: 'custom', custom: '../../etc/%(title)s' }, {}, (r) => r.rejected.includes('template') && r.args[r.args.indexOf('-o') + 1] === `${T}.%(ext)s`);
bad('template with an absolute path, a drive, a home, a variable', { name: 'custom', custom: '/tmp/x' }, {}, (r) => r.rejected.includes('template'));
for (const c of ['C:\\x', '~/x', '$HOME/x', '%(title)s/..', '-o foo', '--exec x', '%(title)s %PATH%', 'a\nb', '.hidden']) bad(`template ${J(c)} refused`, { name: 'custom', custom: c }, {}, (r) => r.rejected.includes('template') && !r.args.some((x) => x.includes(c) && c.length > 3));
bad('a good custom template is kept', { name: 'custom', custom: '%(uploader)s - %(title).80s (%(upload_date>%Y)s)' }, {}, (r) => r.args[r.args.indexOf('-o') + 1] === '%(uploader)s - %(title).80s (%(upload_date>%Y)s).%(ext)s');
bad('a sub-language «--exec» is dropped', { subs: { on: true, langs: ['--exec', 'en', 'en;rm', '-x', 'a b'], auto: false, how: 'embed', fmt: 'srt' } }, {}, (r) => { const i = r.args.indexOf('--sub-langs'); return r.args[i + 1] === 'en' && !r.args.includes('--exec') && !r.args.some((x) => /;rm|exec/.test(x)); });
bad('only bad sub-languages: no subtitles asked, said', { subs: { on: true, langs: ['--exec'], auto: false, how: 'embed', fmt: 'srt' } }, {}, (r) => !r.args.includes('--write-subs') && r.rejected.includes('subs'));
bad('a range «1;rm» is refused: one video only', { playlist: 'range', range: '1;rm' }, {}, (r) => r.rejected.includes('range') && r.args.includes('--no-playlist') && !r.args.includes('--playlist-items') && !r.args.some((x) => /;rm/.test(x)));
bad('a range «0» or «--exec» is refused', { playlist: 'range', range: '--exec' }, {}, (r) => r.rejected.includes('range'));
bad('chapter pattern starting with «-» is refused', {}, { extras: { chapterMatch: '--exec x' } }, (r) => r.rejected.includes('chapterMatch') && !r.args.includes('--exec x'));
bad('a header with a newline or a bad name is refused', {}, { extras: { headers: { 'X\n--exec': 'a', Good: 'b\nc' } } }, (r) => !r.args.includes('--add-header') && r.rejected.includes('header'));
bad('options of the wrong kind fall back to defaults', { mode: 'rm', height: '1080;x', container: '--exec', codec: 1, audio: {}, mp3Rate: '320K;', sponsor: 'x' }, {}, (r) => r.args.join(' ').includes('--merge-output-format mp4') && !r.args.join(' ').includes('exec'));
bad('the sponsor categories are a fixed list', { sponsor: 'remove', sponsorCats: ['--exec', 'intro'] }, {}, (r) => r.args[r.args.indexOf('--sponsorblock-remove') + 1] === 'intro');
bad('an outName cannot carry a path', {}, { extras: { outName: '../../x/%(y)s' } }, (r) => { const v = r.args[r.args.indexOf('-o') + 1]; return !v.includes('/') && !v.includes('..'); });
// whatever the builder wrote never contains a flag the program's own vetting refuses
{ const flags = new Set(); for (const a of all) for (const f of flagsOf(a)) flags.add(f); ok('every flag written is in the allow-list', [...flags].every((f) => V.ALLOWED_FLAGS.includes(f)), [...flags].filter((f) => !V.ALLOWED_FLAGS.includes(f)));
  ok('every list passes vetArgs', all.every((a) => V.vetArgs(a)), all.filter((a) => !V.vetArgs(a)));
  for (const [n, a] of [['--exec', ['--exec', 'rm -rf /']], ['--config-locations', ['--config-locations', '/x']], ['--load-info-json', ['--load-info-json', 'x.json']], ['-P', ['-P', '/etc']], ['--cookies-from-browser', ['--cookies-from-browser', 'chrome']], ['-o ../', ['-o', '../x.%(ext)s']], ['-o /abs', ['-o', '/etc/x']], ['-o chapter:../', ['-o', 'chapter:../x']], ['a value that is a flag', ['-f', '--exec']], ['a bare word', ['x']], ['not an array', 'x'], ['--exec-before-download', ['--exec-before-download', 'x']], ['-a batch', ['-a', 'x']], ['--downloader', ['--downloader', 'x']], ['-o ~', ['-o', '~/x']]]) ok(`vetArgs refuses ${n}`, V.vetArgs(a) === null); }
// the computer's own copy of the vetting agrees (desktop/ytdlp.cjs, electron stubbed)
{ const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktva-')); const load = Module._load; Module._load = function (req, ...rest) { if (req === 'electron') return { app: { getPath: () => tmp }, net: { fetch: async () => { throw new Error('offline'); } } }; return load.call(this, req, ...rest); };
  const Y = require(path.join(__dirname, '..', 'desktop', 'ytdlp.cjs')); Module._load = load;
  ok('desktop vetArgs exists', typeof Y.vetArgs === 'function');
  if (typeof Y.vetArgs === 'function') { ok('desktop accepts every list the builder wrote', all.every((a) => { const v = Y.vetArgs(a); return Array.isArray(v) && v.length === a.length; }), all.filter((a) => !Y.vetArgs(a)).slice(0, 1));
    ok('desktop refuses what the page refuses', [['--exec', 'x'], ['-P', '/etc'], ['-o', '../x'], ['-o', '/x'], ['--cookies-from-browser', 'x'], ['--load-info-json', 'x'], ['-f', '--exec'], ['x']].every((a) => Y.vetArgs(a) === null)); }
  fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
