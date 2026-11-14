// node tests/videohosts.cjs: the sites yt-dlp is always asked about are one list on every platform — the page's
// (src/video/ytdlp.ts, the source), Electron's (desktop/ytdlp.cjs) and the Rust core's (core/kt-core videotools.rs) —;
// this fails when one drifts. Also: the forms of a YouTube address (music., m., nocookie, shorts, live) are all covered.
const fs = require('node:fs'); const path = require('node:path');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const fromRegex = (src) => { const m = /const VIDEO_HOSTS = \/\(\^\|\\\.\)\(([^)]*)\)\$\/i;/.exec(src); return m ? m[1].split('|').map((x) => x.replace(/\\\./g, '.')).sort() : null; };
const page = fromRegex(R('src/video/ytdlp.ts')); const electron = fromRegex(R('desktop/ytdlp.cjs'));
const rs = /const VIDEO_HOSTS: &\[&str\] = &\[([\s\S]*?)\];/.exec(R('core/kt-core/src/videotools.rs')); const rust = rs ? [...rs[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort() : null;
ok('the page has its list', !!page && page.length > 20, page); ok('Electron has its list', !!electron, electron); ok('the Rust core has its list', !!rust, rust);
const diff = (a, b) => ({ only: a.filter((x) => !b.includes(x)), missing: b.filter((x) => !a.includes(x)) });
ok('Electron = the page', JSON.stringify(electron) === JSON.stringify(page), diff(electron || [], page || []));
ok('Rust = the page', JSON.stringify(rust) === JSON.stringify(page), diff(rust || [], page || []));
const re = new RegExp(/\/\(\^\|\\\.\)\(([^)]*)\)\$\/i/.exec(R('src/video/ytdlp.ts'))[0].slice(1, -2), 'i');
for (const u of ['https://music.youtube.com/watch?v=a', 'https://m.youtube.com/watch?v=a', 'https://www.youtube-nocookie.com/embed/a', 'https://www.youtube.com/shorts/a', 'https://www.youtube.com/live/a', 'https://youtu.be/a', 'https://mobile.twitter.com/a/status/1', 'https://x.com/a/status/1'])
  ok(`covered: ${u}`, re.test(new URL(u).hostname));
ok('not a look-alike', !re.test('notyoutube.com') && !re.test('youtube.com.evil.test'));
console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
