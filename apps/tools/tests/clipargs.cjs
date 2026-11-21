// node tests/clipargs.cjs: the clip sheet's ffmpeg argument lists (src/player/clipArgs.ts, pure — no ffmpeg run) for each
// subtitle choice: none, burnt into the picture (exact mode, the subtitles= filter), kept as a track in MP4 (mov_text,
// no fonts) or in MKV (the track as it is, the video's fonts copied and the app's own attached), in fast and exact
// mode; the container each gives; subtitles made of pictures known; a plain subtitle turned into ASS in the player's look.
const esbuild = require('esbuild'); const path = require('node:path');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/player/clipArgs.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' });
const m = {}; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports = {}); const C = m.exports;
const base = { input: '/sdcard/Download/Film.mkv', a: 10, b: 20, from: 10, out: '/sdcard/Movies/clip', kind: 'video', mode: 'fast', subs: 'none', mute: false, res: '', codec: 'h264', quality: 23, gifWidth: 480, gifFps: 12, android: true };
const run = (x) => C.clipArgs({ ...base, ...x });
const has = (a, ...seq) => { for (let i = 0; i + seq.length <= a.length; i++) if (seq.every((s, j) => a[i + j] === s)) return true; return false; };
const tail = (a) => a.slice(-4).join(' ');

// None
let r = run({}); ok('none, fast: one copy attempt', r.length === 1 && has(r[0], '-map', '0', '-c', 'copy') && has(r[0], '-ss', '00:00:10.000', '-to', '00:00:20.000', '-i', base.input) && tail(r[0]) === '-progress pipe:1 -nostats /sdcard/Movies/clip', r);
ok('none, fast: no subtitle input, no attach', !r[0].includes('-attach') && r[0].filter((x) => x === '-i').length === 1);
r = run({ mode: 'exact' }); ok('none, exact on a phone: three encoders tried', r.length === 3 && r[0].includes('h264_mediacodec') && r[1].includes('libx264') && r[2].includes('mpeg4') && r.every((a) => has(a, '-movflags', '+faststart')));
// Burn
r = run({ mode: 'exact', subs: 'burn', burnFilter: "subtitles='/c/clip.ass':fontsdir='/c/fonts'" });
ok('burn, exact: the subtitles filter on every encoder', r.every((a) => { const vf = a[a.indexOf('-vf') + 1]; return vf.startsWith("subtitles='/c/clip.ass':fontsdir='/c/fonts',format="); }), r.map((a) => a[a.indexOf('-vf') + 1]));
ok('burn, exact: no subtitle stream mapped', r.every((a) => !a.includes('-c:s') && !a.some((x) => /^0:s/.test(x))));
r = run({ mode: 'fast', subs: 'burn', burnFilter: 'subtitles=x' }); ok('burn needs exact: in fast mode nothing is drawn', r.length === 1 && !r[0].includes('-vf'));
// Soft, MKV
r = run({ subs: 'soft', softBox: 'mkv', softFile: '/c/clip-track.ass', softTitle: 'Arabic', softLang: 'ara', attach: [{ path: '/c/fonts/Amiri.ttf', mime: 'application/x-truetype-font' }], videoAttachments: 2 });
let a = r[0]; ok('soft MKV, fast: the subtitle file a second input', r.length === 1 && has(a, '-i', base.input, '-i', '/c/clip-track.ass'));
ok('soft MKV, fast: picture, sound, the track and the video\'s fonts mapped, all copied', has(a, '-map', '0:v', '-map', '0:a?', '-map', '1:0', '-map', '0:t?', '-c', 'copy') && !a.includes('mov_text'), a);
ok('soft MKV: the app\'s font attached after the video\'s two', has(a, '-attach', '/c/fonts/Amiri.ttf', '-metadata:s:t:2', 'mimetype=application/x-truetype-font'));
ok('soft MKV: title, language, default, the clip\'s length', has(a, '-metadata:s:s:0', 'title=Arabic') && has(a, '-metadata:s:s:0', 'language=ara') && has(a, '-disposition:s:0', 'default') && has(a, '-t', '10.000'));
ok('soft MKV: written to .mkv', C.clipOutExt('video', 'fast', 'soft', 'mp4', 'mkv') === 'mkv' && C.clipOutExt('video', 'exact', 'soft', 'mkv', 'mkv') === 'mkv');
r = run({ mode: 'exact', subs: 'soft', softBox: 'mkv', softTrack: 1, attach: [{ path: '/c/f.otf', mime: 'application/vnd.ms-opentype' }] });
ok('soft MKV, exact, the file\'s own track: 0:s:1 copied with the fonts, encoders kept', r.length === 3 && r.every((x) => has(x, '-map', '0:s:1', '-map', '0:t?', '-c:s', 'copy', '-c:t', 'copy') && x.filter((y) => y === '-i').length === 1 && !x.includes('-t')), r[0]);
ok('soft MKV, fonts count unknown: every attachment tagged', has(r[0], '-attach', '/c/f.otf', '-metadata:s:t', 'mimetype=application/vnd.ms-opentype') && !r[0].includes('+faststart'));
// Soft, MP4
r = run({ subs: 'soft', softBox: 'mp4', softFile: '/c/clip-track.srt', attach: [{ path: '/c/fonts/Amiri.ttf', mime: 'application/x-truetype-font' }], videoAttachments: 2 });
a = r[0]; ok('soft MP4, fast: the track as mov_text, no fonts carried', has(a, '-map', '0:v', '-map', '0:a?', '-map', '1:0', '-c', 'copy', '-c:s', 'mov_text') && !a.includes('0:t?') && !a.includes('-attach') && has(a, '-movflags', '+faststart'), a);
ok('soft MP4: written to .mp4 by default, whatever the source', C.clipOutExt('video', 'fast', 'soft', 'mkv') === 'mp4' && C.clipOutExt('video', 'exact', 'soft', 'mkv', 'mp4') === 'mp4');
r = run({ mode: 'exact', subs: 'soft', softBox: 'mp4', softTrack: 0 });
ok('soft MP4, exact, the file\'s own track: 0:s:0 → mov_text', r.length === 3 && r.every((x) => has(x, '-map', '0:s:0', '-c:s', 'mov_text') && !x.includes('-c:t') && has(x, '-movflags', '+faststart')), r[0]);
r = run({ subs: 'soft', softBox: 'mp4' }); ok('soft with no subtitle at all: as none', !r[0].includes('-c:s') || r[0].includes('-0:t?'));
// Kinds and containers
ok('audio and GIF never take a track', C.clipOutExt('audio', 'fast', 'soft', 'mkv') === 'm4a' && C.clipOutExt('gif', 'exact', 'soft', 'mkv') === 'gif' && !run({ kind: 'gif', subs: 'soft', softBox: 'mkv', softFile: '/x.ass' })[0].includes('/x.ass'));
ok('none: the source container kept in fast mode, MP4 when re-encoded', C.clipOutExt('video', 'fast', 'none', 'webm') === 'webm' && C.clipOutExt('video', 'exact', 'none', 'mkv') === 'mp4');
ok('subtitles made of pictures known (MKV only)', C.pictureSub('hdmv_pgs_subtitle') && C.pictureSub('dvd_subtitle') && !C.pictureSub('ass') && !C.pictureSub('subrip') && !C.pictureSub(undefined));
// A plain subtitle in the player's look
const ass = C.cuesToStyledAss([{ start: 1, end: 2.5, text: 'Hello <i>there</i>\nfriend' }, { start: 3, end: 4, text: 'Top', top: true }], { font: 'Amiri', size: 100, color: '#ffffff', outline: '#000000', outlineWidth: 2, bold: true, italic: false, pos: 100, background: 'none' }, 720);
ok('styled ASS: the font and size, bold, the lines with their breaks and italics', /Style: Default,Amiri,40,&H00FFFFFF&,/.test(ass) && /,-1,0,0,0,100,100/.test(ass) && ass.includes('Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hello {\\i1}there{\\i0}\\Nfriend') && ass.includes(',,{\\an8}Top'), ass);
ok('shifted cues: those before the clip left out', C.shiftCues([{ start: 1, end: 2, text: 'a' }, { start: 12, end: 14, text: 'b' }], -10).length === 1);
if (fails) { console.log(`${fails} failed`); process.exit(1); } console.log('all passed');
