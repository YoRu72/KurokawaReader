// Another app as the player (src/player/external, desktop/relay.cjs + extplayer.cjs, their Rust and Java twins), with
// FAKE players and loopback media only. Run: NODE_PATH=$(npm root -g) node tests/extplayer.cjs [en|ar]
// 1. The plain logic: the plan for each kind of source (a torrent's loopback stream, a file, a plain link, a site's
//    stream with headers, HLS) and each player; the phone's intents (VLC, mpv, MX, Just, any app) and what each answers;
//    the computer's command lines (mpv, VLC, MPC-HC/BE, PotPlayer, IINA, one's own); «watched».
// 2. The relay (desktop/relay.cjs, and through streamproxy.cjs's server with Electron stood in): a wrong token refused,
//    the source's headers sent, ranges passed, an HLS playlist rewritten (relative and absolute segments, a key, a map,
//    a sub-playlist) and its parts read with the headers, no URL taken from a request, subtitles from a file and from a
//    site, closed after (403; a read under way cut); relaylogic.rs's own tests when rustc is here.
// 3. The programs (desktop/extplayer.cjs) with a fake mpv (a script that speaks mpv's JSON IPC) and a fake VLC: found
//    on the PATH, started with their arguments, the position told by IPC, the end seen, the socket removed.
// 4. The page (playwright): on a computer and on a phone, English or Arabic — the chooser, «always» kept per kind of
//    source, mpv / MX telling where they stopped → watched once (the memory, the review prompt's note), VLC on a
//    computer and «any app» on a phone telling nothing → «Mark as watched?», an app that fails → the error with the
//    in-app player one tap away, the settings rows (phone-only and computer-only kept apart), nothing left behind.
// KT_SHOTS=<dir>: screenshots.
'use strict';
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const http = require('node:http'); const Module = require('node:module'); const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..'); const LANG = process.argv[2] === 'ar' ? 'ar' : 'en'; const SHOTS = process.env.KT_SHOTS;
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 240000).unref();
const load = (file) => { const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild')); const out = esbuild.buildSync({ entryPoints: [path.join(ROOT, file)], bundle: true, format: 'cjs', platform: 'node', write: false }); const m = { exports: {} }; new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const get = (u, h = {}, method = 'GET') => new Promise((res, rej) => { const r = http.request(u, { headers: h, method }, (x) => { const b = []; x.on('data', (d) => b.push(d)); x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: Buffer.concat(b) })); x.on('error', rej); }); r.on('error', rej); r.end(); });

/* ---------- 1. the plain logic ---------- */
function logic() {
  const L = load('src/player/external/logic.ts');
  const P = (id) => L.playerById(id);
  const torrent = { url: 'http://127.0.0.1:4567/t/abc/Show%20-%2001.mkv', name: 'Show - 01', start: 125 };
  const file = { url: 'http://127.0.0.1:4567/f?t=x&p=%2Fv%2Fa.mkv', name: 'Show - 02', localPath: '/videos/Show - 02.mkv' };
  const plain = { url: 'https://media.test/a.mp4', name: 'Clip' };
  const site = { url: 'https://cdn.test/v/master.m3u8', name: 'Show - 03', hls: true, headers: { Referer: 'https://site.test/', 'User-Agent': 'UA-1' }, subs: [{ url: 'https://cdn.test/s/en.vtt', name: 'English', isDefault: true, headers: { Referer: 'https://site.test/' } }] };
  const cookie = { ...site, headers: { ...site.headers, Cookie: 'k=v' } };
  // plans
  ok('torrent stream (loopback): handed as it is, on the phone and the computer', L.plan(torrent, P('mx'), 'android').main === 'direct' && L.plan(torrent, P('vlc'), 'win').main === 'direct' && !L.plan(torrent, P('vlc'), 'win').relay);
  ok('a file: by its path (the phone shares it by its FileProvider)', L.plan(file, P('vlc-android'), 'android').main === 'path' && L.plan(file, P('mpv'), 'linux').main === 'path');
  ok('a plain link: as it is', L.plan(plain, P('mpc-hc'), 'win').main === 'direct' && L.plan(plain, P('just'), 'android').main === 'direct');
  const mpvPlan = L.plan(cookie, P('mpv'), 'linux');
  ok('site stream on a computer, mpv: the headers on its command line, no relay for the video; the subtitle as is', mpvPlan.main === 'direct' && mpvPlan.headerArgs && mpvPlan.subs[0] === 'relay');
  ok('…VLC with only User-Agent and Referer: on its command line too', L.plan(site, P('vlc'), 'win').main === 'direct' && L.plan(site, P('vlc'), 'win').headerArgs);
  ok('…VLC with a cookie: through the relay', L.plan(cookie, P('vlc'), 'win').main === 'relay' && L.plan(cookie, P('vlc'), 'win').relay);
  ok('…VLC reads subtitles from disk only: saved first', L.plan(site, P('vlc'), 'win').subs[0] === 'temp');
  ok('site stream on a phone (any player): the relay, subtitles too', ['vlc-android', 'mx', 'mpv-android', 'just'].every((id) => { const x = L.plan(site, P(id), 'android'); return x.main === 'relay' && x.subs[0] === 'relay'; }));
  ok('HLS to MPC-HC: refused up front (the error offers another app or the in-app player)', L.plan(site, P('mpc-hc'), 'win').problem === 'hls' && !L.plan(torrent, P('mpc-hc'), 'win').problem);
  ok('per platform: phone apps never on a computer, nor the reverse; IINA only on a Mac; MPC/PotPlayer only on Windows', L.playersFor('android').every((p) => p.pkgs || p.id === 'any') && !L.playersFor('win').some((p) => p.pkgs) && L.playersFor('mac').some((p) => p.id === 'iina') && !L.playersFor('linux').some((p) => /mpc|potplayer|iina/.test(p.id)));
  ok('services', L.serviceOf({ taskKind: 'torrent' }) === 'torrent' && L.serviceOf({ localPath: '/a' }) === 'local' && L.serviceOf({ headers: { a: 'b' } }) === 'online' && L.serviceOf({ online: true }) === 'online' && L.serviceOf({}) === 'http');
  // phone intents
  const ready = { target: 'http://127.0.0.1:9/r/T/v/Show', isPath: false, title: 'Show - 03', start: 90.4, subs: [{ at: 'http://127.0.0.1:9/r/T/s/0/en.vtt', name: 'English', isDefault: true }, { at: 'http://127.0.0.1:9/r/T/s/1/ar.ass', name: 'العربية' }] };
  const ex = (it) => Object.fromEntries(it.extras.map((e) => [e.k, [e.t, e.v]]));
  const vlc = L.androidIntent(P('vlc-android'), ready, 'org.videolan.vlc'); const v = ex(vlc);
  ok('VLC: its package, title, position as a long in ms, from_start false, the default subtitle by location, result asked', vlc.pkg === 'org.videolan.vlc' && !vlc.chooser && vlc.result && v.title[1] === 'Show - 03' && v.position[0] === 'l' && v.position[1] === 90400 && v.from_start[1] === false && v.subtitles_location[1] === ready.subs[0].at, vlc);
  const mx = ex(L.androidIntent(P('mx'), ready, 'com.mxtech.videoplayer.ad'));
  ok('MX: int ms, subs (Uri[]) with names, the default enabled, return_result', mx.position[0] === 'i' && mx.position[1] === 90400 && mx.subs[0] === 'ua' && mx.subs[1].length === 2 && mx['subs.name'][1][1] === 'العربية' && mx['subs.enable'][1][0] === ready.subs[0].at && mx.return_result[1] === true);
  ok('MX Pro preferred when both are there (the first installed package is chosen by the page)', P('mx').pkgs[0] === 'com.mxtech.videoplayer.pro');
  const just = ex(L.androidIntent(P('just'), ready)); ok('Just Player: MX\'s extras', just.return_result && just.subs && just.position[1] === 90400);
  const mpvA = ex(L.androidIntent(P('mpv-android'), ready)); ok('mpv-android: subs, subs.enable, position', mpvA.subs && mpvA['subs.enable'] && mpvA.position[1] === 90400 && !mpvA.return_result);
  const any = L.androidIntent(P('any'), ready); ok('any app: the phone\'s chooser, title only, no result', any.chooser && !any.pkg && !any.result && any.extras.length === 1);
  ok('a file on the phone: by path, the data left empty', L.androidIntent(P('mx'), { ...ready, target: '/sdcard/a.mkv', isPath: true }).path === '/sdcard/a.mkv');
  ok('HLS given its type', L.androidIntent(P('mx'), { ...ready, target: 'http://x/a.m3u8' }).mime === 'application/x-mpegURL');
  // answers
  const r1 = L.androidResult(P('vlc-android'), { extra_position: 1300000, extra_duration: 1440000 });
  const r2 = L.androidResult(P('mx'), { position: 1430000, duration: 1440000, end_by: 'playback_completion' });
  const r3 = L.androidResult(P('mpv-android'), { position: 60000, duration: 1440000 });
  ok('answers read: VLC extra_position, MX end_by, mpv position (seconds)', r1.pos === 1300 && r1.dur === 1440 && r2.ended && r3.pos === 60 && !r3.ended);
  ok('nothing told: nothing read', L.androidResult(P('mx'), null).pos === undefined && L.androidResult(P('any'), { position: 5 }).pos === undefined);
  ok('watched: past the share (90 %), at the end, not before', L.isWatched(r1) && L.isWatched({ ended: true }) && !L.isWatched(r3) && !L.isWatched({ pos: 1290, dur: 1440 }) && L.isWatched({ pos: 1300, dur: 1440 }, 90));
  // computer commands
  const pc = { target: 'https://cdn.test/v/master.m3u8', isPath: false, title: 'Show - 03', start: 90.4, subs: [{ at: '/tmp/en.vtt', name: 'English', isDefault: true }], headers: { Referer: 'https://site.test/', 'User-Agent': 'UA-1', Cookie: 'k=v' }, slang: ['ar', 'en'], alang: ['ja'] };
  const m = L.desktopCommand(P('mpv'), pc, '/usr/bin/mpv');
  ok('mpv: title, start, sub, langs, UA, referrer, each other header appended, hwdec, IPC, then «--» and the address', m.ipc && m.args.includes('--force-media-title=Show - 03') && m.args.includes('--start=90.4') && m.args.includes('--sub-file=/tmp/en.vtt') && m.args.includes('--slang=ar,en') && m.args.includes('--alang=ja') && m.args.includes('--user-agent=UA-1') && m.args.includes('--referrer=https://site.test/') && m.args.includes('--http-header-fields-append=Cookie: k=v') && m.args.includes('--hwdec=auto-safe') && m.args.includes('--input-ipc-server=${ipc}') && m.args.slice(-2).join() === `--,${pc.target}`, m.args);
  const vl = L.desktopCommand(P('vlc'), pc, 'vlc'); ok('VLC: meta-title, start-time, sub-file, http-user-agent/referrer, play-and-exit, the address last', vl.args.includes('--meta-title=Show - 03') && vl.args.includes('--start-time=90.4') && vl.args.includes('--sub-file=/tmp/en.vtt') && vl.args.includes('--http-referrer=https://site.test/') && vl.args.includes('--play-and-exit') && vl.args[vl.args.length - 1] === pc.target && !vl.ipc, vl.args);
  const mpc = L.desktopCommand(P('mpc-hc'), pc, 'mpc'); ok('MPC-HC: the address, /play /close, /start in ms, /sub', mpc.args.join(' ') === `${pc.target} /play /close /start 90400 /sub /tmp/en.vtt`, mpc.args);
  const pot = L.desktopCommand(P('potplayer'), pc, 'pot'); ok('PotPlayer: /seek=hh:mm:ss, /sub=, /user_agent=, /referer=', pot.args.includes('/seek=00:01:30') && pot.args.includes('/sub=/tmp/en.vtt') && pot.args.includes('/user_agent=UA-1') && pot.args.includes('/referer=https://site.test/'), pot.args);
  const ii = L.desktopCommand(P('iina'), pc, 'iina-cli'); ok('IINA: -w (waits), its mpv options as --mpv-…', ii.args[0] === '-w' && ii.args.includes('--mpv-start=90.4') && ii.args.includes('--mpv-referrer=https://site.test/') && ii.args[ii.args.length - 1] === pc.target && !ii.args.includes('--'), ii.args);
  const cu = L.desktopCommand(P('custom'), { ...pc, subs: [] }, '', 'my-player "--title={title}" --sub={sub} --from={start} --hdr \'{referrer}\'');
  ok('own command: split like a shell, never given to one; empty placeholders\' arguments left out; the address last when not placed', cu.exe === 'my-player' && cu.args.join('|') === `--title=Show - 03|--from=90.4|--hdr|https://site.test/|${pc.target}`, cu);
  ok('…a ; or $( ) stays a plain argument (no shell)', L.customCommand('p {url}; rm -rf $(x)', { ...pc, subs: [] }).args.join('|') === `${pc.target};|rm|-rf|$(x)`);
  ok('splitArgs: quotes and escapes', JSON.stringify(L.splitArgs('a "b c" \'d "e"\' "f\\"g" ""')) === JSON.stringify(['a', 'b c', 'd "e"', 'f"g', '']));
}

/* ---------- 2. the relay ---------- */
async function relay() {
  const seen = [];
  const SEG = Buffer.alloc(200000, 7);
  const origin = http.createServer((req, res) => {
    seen.push({ url: req.url, ref: req.headers.referer, cookie: req.headers.cookie, ua: req.headers['user-agent'], range: req.headers.range });
    if (req.headers.referer !== 'https://site.test/' || req.headers.cookie !== 'k=v') { res.writeHead(403); res.end('no'); return; }
    const u = req.url.split('?')[0];
    if (u === '/v/master.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8?sig=1\n'); return; }
    if (u === '/v/low/index.m3u8') { res.writeHead(200, { 'content-type': 'application/x-mpegURL' }); res.end(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../keys/k.bin",IV=0x01\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg0.ts\n#EXTINF:4,\nhttp://127.0.0.1:${origin.address().port}/abs/seg1.ts\n#EXT-X-ENDLIST\n`); return; }
    if (u === '/s/en.vtt') { res.writeHead(200, { 'content-type': 'text/vtt' }); res.end('WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n'); return; }
    if (u === '/big.mp4') { const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); if (m) { const a = +m[1], b = m[2] ? +m[2] : SEG.length - 1; res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${a}-${b}/${SEG.length}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' }); res.end(SEG.subarray(a, b + 1)); return; } res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': SEG.length }); res.end(SEG); return; }
    if (u === '/slow.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); const iv = setInterval(() => { if (!res.write(Buffer.alloc(1000))) { /* */ } }, 20); res.on('close', () => clearInterval(iv)); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(`part ${u}`);
  }).listen(0, '127.0.0.1'); await new Promise((r) => origin.on('listening', r));
  const O = `http://127.0.0.1:${origin.address().port}`;
  const Relay = require('../desktop/relay.cjs');
  const srv = http.createServer((req, res) => { void Relay.handle(req, res, `http://127.0.0.1:${srv.address().port}`).then((h) => { if (!h) { res.writeHead(404); res.end(); } }).catch((e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e)); }); }).listen(0, '127.0.0.1'); await new Promise((r) => srv.on('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-ext-')); fs.writeFileSync(path.join(dir, 'ar.ass'), '[Script Info]\nTitle: x\n');
  const H = { Referer: 'https://site.test/', Cookie: 'k=v', 'User-Agent': 'UA-TEST' };
  const s = Relay.open({ url: `${O}/v/master.m3u8`, headers: H, name: 'Show - 03', subs: [{ url: `${O}/s/en.vtt`, name: 'English.vtt' }, { path: path.join(dir, 'ar.ass'), name: 'ar.ass' }] }, base);
  ok('relay: loopback address, a 32-hex token in the path, a name the player can show', new RegExp(`^${base}/r/[0-9a-f]{32}/v/Show%20-%2003$`).test(s.url) && s.subs.length === 2, s);
  ok('a wrong token: 403', (await get(s.url.replace(s.token, '0'.repeat(32)))).status === 403);
  const master = await get(s.url); const mt = master.body.toString();
  ok('the master playlist rewritten: its sub-playlist an address of the session', master.status === 200 && /application\/vnd\.apple\.mpegurl/.test(master.headers['content-type']) && new RegExp(`${base}/r/${s.token}/u/0`).test(mt) && !mt.includes('low/index'), mt);
  ok('…fetched with the source\'s headers (Referer, Cookie, User-Agent)', seen.some((x) => x.url === '/v/master.m3u8' && x.ref === 'https://site.test/' && x.cookie === 'k=v' && x.ua === 'UA-TEST'));
  const media = (await get(`${base}/r/${s.token}/u/0`)).body.toString();
  ok('the media playlist: key, map, relative and absolute segments all made session addresses (relative ones resolved)', /URI="[^"]+\/u\/1",IV=0x01/.test(media) && /URI="[^"]+\/u\/2"/.test(media) && /\/u\/3\n/.test(media) && /\/u\/4\n/.test(media) && !/seg0|k\.bin|abs\/seg1/.test(media), media);
  const parts = await Promise.all([1, 2, 3, 4].map((n) => get(`${base}/r/${s.token}/u/${n}`)));
  ok('…each part read with the headers', parts.every((p) => p.status === 200) && parts.map((p) => p.body.toString()).join('|') === 'part /v/keys/k.bin|part /v/low/init.mp4|part /v/low/seg0.ts|part /abs/seg1.ts', parts.map((p) => p.body.toString()));
  ok('no URL from a request: an unknown number is 404, a query cannot name a site', (await get(`${base}/r/${s.token}/u/99`)).status === 404 && (await get(`${base}/r/${s.token}/u/x?u=${encodeURIComponent(O + '/big.mp4')}`)).status === 404);
  const sub0 = await get(s.subs[0]); const sub1 = await get(s.subs[1]);
  ok('subtitles: the site\'s (with its headers), and a file\'s (as text)', sub0.status === 200 && /Hello/.test(sub0.body.toString()) && sub1.status === 200 && /Script Info/.test(sub1.body.toString()) && /x-ssa/.test(sub1.headers['content-type']));
  const s2 = Relay.open({ url: `${O}/big.mp4`, headers: H, name: 'b' }, base);
  const rg = await get(s2.url, { Range: 'bytes=100-199' }); const hd = await get(s2.url, {}, 'HEAD');
  ok('a file: ranges passed (206, Content-Range), HEAD answered', rg.status === 206 && rg.body.length === 100 && rg.headers['content-range'] === `bytes 100-199/${SEG.length}` && hd.status === 200 && Number(hd.headers['content-length']) === SEG.length, { s: rg.status, cr: rg.headers['content-range'] });
  // closed after: a read under way cut, then 403
  const s3 = Relay.open({ url: `${O}/slow.mp4`, headers: H, name: 'slow' }, base);
  const cut = await new Promise((resolve) => { const r = http.get(s3.url, (x) => { let n = 0; x.on('data', (d) => { n += d.length; if (n > 3000) Relay.close(s3.token); }); x.on('close', () => resolve(true)); x.on('error', () => resolve(true)); }); r.on('error', () => resolve(true)); setTimeout(() => resolve(false), 5000); });
  ok('closed: a read under way cut, the address refused (403)', cut && (await get(s3.url)).status === 403 && Relay.close(s3.token) === false);
  Relay.close(s.token); Relay.close(s2.token);
  ok('all sessions closed', Relay.count() === 0 && (await get(s.url)).status === 403);
  // through streamproxy.cjs's own server (Electron's net stood in by Node's fetch)
  const real = Module._load; Module._load = function (req, ...rest) { if (req === 'electron') return { net: { fetch: (u, o) => fetch(u, o) }, app: { getPath: () => os.tmpdir() } }; return real.call(this, req, ...rest); };
  try {
    const SP = require('../desktop/streamproxy.cjs'); const r = await SP.relayOpen({ url: `${O}/big.mp4`, headers: H, name: 'v' });
    const g = await get(r.url, { Range: 'bytes=0-9' });
    ok('streamproxy.cjs: relayOpen on the app\'s stream server (loopback), relayClose', /^http:\/\/127\.0\.0\.1:\d+\/r\/[0-9a-f]{32}\/v\/v$/.test(r.url) && g.status === 206 && g.body.length === 10 && SP.relayClose({ token: r.token }).closed === true && (await get(r.url)).status === 403);
    SP.stop();
  } catch (e) { ok('streamproxy.cjs loads with Electron stood in', false, String(e && e.stack || e)); } finally { Module._load = real; }
  srv.close(); origin.close(); fs.rmSync(dir, { recursive: true, force: true });
  // relaylogic.rs (std only)
  try { execFileSync('rustc', ['--version'], { stdio: 'ignore' }); const out = path.join(os.tmpdir(), `kt-relaylogic-${process.pid}`); execFileSync('rustc', ['--edition', '2021', '--test', path.join(ROOT, 'desktop-tauri/src-tauri/src/relaylogic.rs'), '-o', out], { stdio: 'pipe' }); const r = execFileSync(out, { encoding: 'utf8' }); ok('relaylogic.rs: its tests (join, rewrite, parse, headers, mpv lines)', /test result: ok\. 4 passed/.test(r), r); fs.rmSync(out, { force: true }); }
  catch (e) { if (e.code === 'ENOENT') console.log('skip relaylogic.rs (no rustc)'); else ok('relaylogic.rs compiles and passes', false, String(e.stderr || e.message).slice(-800)); }
}

/* ---------- 3. the programs ---------- */
async function programs() {
  if (process.platform === 'win32') { console.log('skip programs (fake players are shell scripts)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-extbin-')); const log = path.join(dir, 'log.jsonl');
  const fakeMpv = `const fs=require('fs');const net=require('net');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({p:'mpv',a})+'\\n');
const ipc=(a.find(x=>x.startsWith('--input-ipc-server='))||'').split('=')[1];if(!ipc)process.exit(2);
const srv=net.createServer(c=>{let b='';c.on('data',d=>{b+=d;let n;while((n=b.indexOf('\\n'))>=0){const l=b.slice(0,n);b=b.slice(n+1);const m=JSON.parse(l);if(m.command[0]==='observe_property'){const nm=m.command[2];const v=nm==='time-pos'?1300.5:nm==='duration'?1440:false;c.write(JSON.stringify({event:'property-change',id:m.command[1],name:nm,data:v})+'\\n');}}});setTimeout(()=>{c.write(JSON.stringify({event:'property-change',id:1,name:'time-pos',data:1438})+'\\n');c.write(JSON.stringify({event:'end-file',reason:'eof'})+'\\n');setTimeout(()=>{srv.close();process.exit(0);},100);},400);});
srv.listen(ipc);`;
  fs.writeFileSync(path.join(dir, 'fakempv.js'), fakeMpv);
  fs.writeFileSync(path.join(dir, 'mpv'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'fakempv.js')}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'vlc'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}.vlc"\nexit 0\n`, { mode: 0o755 });
  const X = require('../desktop/extplayer.cjs'); const oldPath = process.env.PATH; process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  try {
    const f = X.find({ cands: [{ id: 'mpv', paths: ['/nowhere/mpv', 'mpv'] }, { id: 'vlc', paths: ['vlc'] }, { id: 'potplayer', paths: ['%NO_SUCH_VAR%\\PotPlayer.exe'] }] });
    ok('found on the PATH (the first path that is there), a missing one left out', f.found.length === 2 && f.found[0].path === path.join(dir, 'mpv') && f.found[1].id === 'vlc', f);
    const { id } = X.start({ exe: path.join(dir, 'mpv'), args: ['--force-media-title=Show - 01', '--start=12', '--input-ipc-server=${ipc}', '--', 'http://127.0.0.1:1/x'], ipc: true });
    let st; const t0 = Date.now(); let polls = 0; let seenRunning = false;
    for (;;) { await new Promise((r) => setTimeout(r, 100)); st = X.status({ id }); polls++; if (st.running) seenRunning = true; if (!st.running || Date.now() - t0 > 8000) break; }
    const rec = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))[0];
    ok('mpv started with its arguments, ${ipc} filled with a socket of its own', rec.a[0] === '--force-media-title=Show - 01' && /kt-mpv-[0-9a-f]+\.sock$/.test(rec.a[2]) && rec.a[4] === 'http://127.0.0.1:1/x', rec.a);
    ok('its position told by IPC (observed, not polled), the end seen, then ended', seenRunning && !st.running && st.code === 0 && st.pos === 1438 && st.dur === 1440 && st.eof === true, st);
    ok('the socket removed, the record dropped after it was seen ended', !fs.existsSync(rec.a[2].split('=')[1]) && X.status({ id }).error === 'unknown' && X.running() === 0);
    const v = X.start({ exe: 'vlc', args: ['--meta-title=a b', 'http://127.0.0.1:1/y'], ipc: false }); for (let i = 0; i < 50 && X.status({ id: v.id }).running; i++) await new Promise((r) => setTimeout(r, 100));
    ok('VLC (a bare name, from the PATH): started, each argument one item (no shell), its end seen', fs.readFileSync(`${log}.vlc`, 'utf8').trim() === '--meta-title=a b http://127.0.0.1:1/y');
    let threw = false; try { X.start({ exe: '', args: [] }); } catch { threw = true; } ok('no program: refused', threw);
  } finally { process.env.PATH = oldPath; X.release(); fs.rmSync(dir, { recursive: true, force: true }); }
}

/* ---------- 4. the page ---------- */
const STREAM = LANG === 'ar' ? 'تشغيل في أثناء التنزيل' : 'Play while downloading';
const streamFrom = async (p, i) => { const cards = await p.$$('.task-card'); await cards[i].click(); const b = p.getByRole('button', { name: STREAM }).first(); await b.waitFor({ timeout: 10000 }); await b.click(); };
async function page() {
  let chromium; try { ({ chromium } = require('playwright')); } catch { console.log('skip page (no playwright)'); return; }
  const DIST = path.join(ROOT, 'dist'); if (!fs.existsSync(path.join(DIST, 'index.html'))) { ok('dist built', false); return; }
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
  const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0, '127.0.0.1'); await new Promise((r) => web.on('listening', r));
  const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `ext-${name}-${LANG}.png`) }); } };
  const task = (o) => ({ id: o.id, kind: o.kind, name: o.name, source: { url: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) }, dir: o.dir, state: o.state, done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: o.name, size: 1000, done: o.state === 'done' ? 1000 : 300, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now(), engine: o.engine, meta: o.meta });
  const META = { anilistId: 4242, episode: 3, title: 'Made-up Show' };
  /* ----- the computer ----- */
  {
    const p = await br.newPage({ viewport: { width: 1280, height: 800 } }); p.on('pageerror', (e) => errors.push('pc: ' + e.message));
    await p.addInitScript(([lang, tasks]) => {
      localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1');
      if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime'], playerWith: 'external', settingsLayout: 'tabs' }));
      window.__calls = []; window.__status = {};
      const rec = (k) => async (o) => { window.__calls.push([k, o]); return undefined; };
      const api = {
        platform: 'desktop', available: true, os: 'linux', list: async () => tasks, onTasks: (fn) => { setTimeout(() => fn(tasks), 50); return () => {}; }, on: () => () => {}, ready: async () => ({}), freeSpace: async () => 5e11,
        fileUrl: async (pth) => `http://127.0.0.1:1/f?t=x&p=${encodeURIComponent(pth)}`, streamUrl: async (o) => ({ url: `http://127.0.0.1:2/T/t/s1/${o.fileIndex}` }), streamDone: rec('streamDone'),
        extPlayers: async (o) => { window.__calls.push(['extPlayers', o]); return { found: [{ id: 'mpv', path: '/usr/bin/mpv' }, { id: 'vlc', path: '/usr/bin/vlc' }] }; },
        extPlayerStart: async (o) => { window.__calls.push(['extPlayerStart', o]); if (window.__failStart) throw new Error('spawn ENOENT'); const id = String(window.__calls.length); window.__status[id] = 0; return { id }; },
        extPlayerStatus: async (o) => { window.__calls.push(['extPlayerStatus', o]); const n = ++window.__status[o.id]; const mpv = window.__calls.find((c) => c[0] === 'extPlayerStart' && String(window.__calls.indexOf(c) + 1) === o.id)?.[1]?.ipc; return n < 3 ? { running: true, code: null, pos: mpv ? 600 : null, dur: mpv ? 1440 : null, eof: false } : { running: false, code: 0, pos: mpv ? 1350 : null, dur: mpv ? 1440 : null, eof: false }; },
        extPlayerStop: rec('extPlayerStop'), relayOpen: async (o) => { window.__calls.push(['relayOpen', o]); return { token: 'tok', url: 'http://127.0.0.1:3/r/tok/v/x', subs: (o.subs || []).map((_, i) => `http://127.0.0.1:3/r/tok/s/${i}/s`) }; }, relayClose: rec('relayClose'), writeTemp: async (o) => ({ path: `/tmp/${o.name}` }),
      };
      window.kurokawaTools = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
    }, [LANG, [task({ id: 'd1', kind: 'http', name: 'Made-up Show - 03.mkv', dir: '/videos', state: 'done', engine: 'aria2', meta: META }), task({ id: 't1', kind: 'torrent', name: 'Made-up Clip.mkv', dir: '/videos', state: 'downloading', engine: 'aria2' })]]);
    await p.goto(base); await p.waitForSelector('.task-card', { timeout: 20000 });
    await p.evaluate(() => { window.addEventListener('kt-anime-watched', (e) => { (window.__watched ??= []).push(e.detail); }); });
    // The finished episode: the chooser (mpv, VLC, the in-app player), «always for files» on, mpv picked.
    const playBtn = async (i) => { const b = await p.$$('.task-card button[aria-label="' + (LANG === 'ar' ? 'تشغيل' : 'Play') + '"]'); if (!b[i]) { const all = await p.$$('.task-card'); await all[i].click(); return; } await b[i].click(); };
    await playBtn(0); await p.waitForSelector('.ext-chooser .watch-choice', { timeout: 10000 }); await p.waitForTimeout(300);
    const names = await p.$$eval('.ext-chooser .watch-choice', (e) => e.map((x) => x.dataset.player));
    ok('PC chooser: the programs found here (mpv, VLC) and the in-app player; no phone app', names.join() === 'mpv,vlc,app', names);
    await shot(p, 'chooser-pc');
    await p.click('.ext-chooser .switch-row input'); await p.click('.ext-chooser [data-player="mpv"]');
    await p.waitForFunction(() => (window.__watched ?? []).length > 0, null, { timeout: 15000 });
    const pc1 = await p.evaluate(() => ({ calls: window.__calls, mem: JSON.parse(localStorage.getItem('kt.player.memory') || '{}'), set: JSON.parse(localStorage.getItem('kt.settings')), review: sessionStorage.getItem('kt.anime.reviewAsk'), watched: window.__watched }));
    const start = pc1.calls.find((c) => c[0] === 'extPlayerStart')[1];
    ok('mpv started with the file\'s path, its title, IPC, hwdec; no relay for a file', start.exe === '/usr/bin/mpv' && start.ipc && start.args[start.args.length - 1] === '/videos/Made-up Show - 03.mkv' && start.args.includes('--force-media-title=Made-up Show - 03.mkv') && start.args.includes('--hwdec=auto-safe') && !pc1.calls.some((c) => c[0] === 'relayOpen'), start);
    const mk = pc1.mem['/videos/Made-up Show - 03.mkv'];
    ok('the position mpv told came back: the memory (1350 of 1440), watched (past 90 %), once', mk && mk.duration === 1440 && mk.watched === true && pc1.watched.length === 1 && pc1.watched[0].id === 4242 && pc1.watched[0].ep === 3 && !!pc1.review, { mk, w: pc1.watched });
    ok('«always» kept for files, on the computer only', pc1.set.extPlayers?.desktop?.local === 'mpv' && !pc1.set.extPlayers?.android);
    // The torrent while it comes: VLC (tells nothing) → «Mark as watched?» not asked for an untracked clip; the stream released.
    await p.evaluate(() => { window.__calls = []; }); await streamFrom(p, 1); await p.waitForSelector('.ext-chooser [data-player="vlc"]'); await p.click('.ext-chooser [data-player="vlc"]');
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'streamDone'), null, { timeout: 15000 });
    const pc2 = await p.evaluate(() => window.__calls);
    const vs = pc2.find((c) => c[0] === 'extPlayerStart')[1];
    ok('torrent stream to VLC: its loopback address as it is, play-and-exit; the stream released after the program ended', vs.args[vs.args.length - 1] === 'http://127.0.0.1:2/T/t/s1/0' && vs.args.includes('--play-and-exit') && !vs.ipc && pc2.find((c) => c[0] === 'streamDone')[1].id === 't1', vs);
    ok('an untracked clip and an app that tells nothing: no question', !(await p.$('.ext-mark')));
    await p.goto(base); await p.waitForSelector('.task-card');
    // «Mark as watched?» for a tracked episode with VLC (settings: always ask), and the error with its fallback.
    await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.extPlayers.desktop.local = 'vlc'; localStorage.setItem('kt.settings', JSON.stringify(s)); });
    await p.reload(); await p.waitForSelector('.task-card'); await p.evaluate(() => { window.addEventListener('kt-anime-watched', (e) => { (window.__watched ??= []).push(e.detail); }); localStorage.removeItem('kt.player.memory'); });
    await playBtn(0); await p.waitForSelector('.ext-mark', { timeout: 15000 }); await p.waitForTimeout(250); await shot(p, 'mark-pc');
    ok('VLC told nothing about a tracked episode: «Mark as watched?»', /VLC/.test(await p.$eval('.ext-mark', (e) => e.textContent)));
    await p.click('.ext-mark .btn.primary'); await p.waitForFunction(() => (window.__watched ?? []).length === 1);
    ok('…answered yes: watched (once)', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.player.memory'))['/videos/Made-up Show - 03.mkv']?.watched === true && window.__watched.length === 1));
    await p.evaluate(() => { window.__failStart = true; }); await playBtn(0);
    await p.waitForSelector('.ext-error', { timeout: 10000 }); await p.waitForTimeout(250); await shot(p, 'error-pc');
    ok('a program that fails: the error, «Watch in the in-app player» and «Choose another app»', (await p.$$('.ext-error .btn')).length === 2 && /spawn ENOENT/.test(await p.$eval('.ext-error-why', (e) => e.textContent)));
    await p.click('.ext-error .btn.primary'); await p.waitForSelector('.kt-player, .player-view', { timeout: 15000 });
    ok('…one tap: the in-app player opens the same video', true);
    await p.keyboard.press('Escape'); await p.goBack().catch(() => undefined);
    // Settings → Player on a computer.
    await p.goto(base + '#/settings'); await p.waitForSelector('.settings-nav .chip', { timeout: 15000 }); await p.evaluate(() => { const c = [...document.querySelectorAll('.settings-nav .chip')].find((x) => /player/.test(x.dataset.sec || '')); c?.click(); }); await p.waitForSelector('.ext-settings', { timeout: 15000 }); await p.waitForFunction(() => /mpv/.test(document.querySelector('.ext-found')?.textContent || ''));
    const pcs = await p.evaluate(() => ({ rows: [...document.querySelectorAll('.ext-settings [data-service]')].map((b) => b.dataset.service), custom: !!document.querySelector('.ext-custom'), found: document.querySelector('.ext-found').textContent }));
    ok('PC settings: the four kinds of source, one\'s own command, what was found', pcs.rows.join() === 'torrent,online,http,local' && pcs.custom && /mpv/.test(pcs.found) && /VLC/.test(pcs.found), pcs);
    await p.$eval('.ext-settings', (e) => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(200); await shot(p, 'settings-pc');
    await p.click('.ext-settings [data-service="online"]'); await p.waitForTimeout(250);
    const opts = await p.$$eval('.sheet:last-of-type button, .sheet:last-of-type [role="option"], .sheet:last-of-type label', (e) => e.map((x) => x.textContent.trim()).filter(Boolean));
    ok('…its choices: ask, the in-app player, the computer\'s players (no phone app)', opts.some((x) => /mpv/.test(x)) && opts.some((x) => /PotPlayer|MPC/.test(x)) === false && !opts.some((x) => /MX Player|Just Player/.test(x)), opts);
    await p.keyboard.press('Escape');
    await p.close();
  }
  /* ----- the phone ----- */
  {
    const p = await br.newPage({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); p.on('pageerror', (e) => errors.push('phone: ' + e.message));
    await p.addInitScript(([lang, tasks]) => {
      localStorage.setItem('kr.lang', lang); if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime'], playerWith: 'external' }));
      window.__calls = [];
      const api = {
        addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks }), streamUrl: async (o) => ({ url: `http://127.0.0.1:5/stream/${o.id}/${o.fileIndex}` }), localUrl: async (o) => ({ url: `http://127.0.0.1:5/file?p=${encodeURIComponent(o.path)}` }),
        playerApps: async (o) => { window.__calls.push(['playerApps', o]); return { installed: ['com.mxtech.videoplayer.ad', 'org.videolan.vlc'] }; },
        openPlayerApp: async (o) => { window.__calls.push(['openPlayerApp', o]); if (o.chooser) return { code: 0 }; return o.pkg === 'org.videolan.vlc' ? { code: -1, extras: { extra_position: 200000, extra_duration: 1440000 } } : { code: -1, extras: { position: 1430000, duration: 1440000, end_by: 'playback_completion' } }; },
        relayOpen: async (o) => { window.__calls.push(['relayOpen', o]); return { token: 'tk', url: 'http://127.0.0.1:5/r/tk/v/x', subs: [] }; }, relayClose: async (o) => { window.__calls.push(['relayClose', o]); },
      };
      const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
    }, [LANG, [task({ id: 'p1', kind: 'torrent', name: 'Made-up Show - 05.mkv', dir: '/sdcard/Download', state: 'downloading', engine: 'native', meta: { ...META, episode: 5 } })]]);
    await p.goto(base); await p.waitForSelector('.task-card', { timeout: 20000 });
    await p.evaluate(() => { window.addEventListener('kt-anime-watched', (e) => { (window.__watched ??= []).push(e.detail); }); });
    const play = async () => { if (!(await p.$('.task-card'))) { await p.goto(base); await p.waitForSelector('.task-card'); } await streamFrom(p, 0); };
    await play(); await p.waitForSelector('.ext-chooser .watch-choice', { timeout: 10000 }); await p.waitForTimeout(300);
    const names = await p.$$eval('.ext-chooser .watch-choice', (e) => e.map((x) => x.dataset.player));
    ok('phone chooser: the installed apps (VLC, MX), «another app», the in-app player; no computer program', names.join() === 'vlc-android,mx,any,app', names);
    await shot(p, 'chooser-phone');
    await p.click('.ext-chooser [data-player="mx"]'); await p.waitForFunction(() => (window.__watched ?? []).length > 0, null, { timeout: 15000 });
    const ph = await p.evaluate(() => ({ calls: window.__calls, mem: JSON.parse(localStorage.getItem('kt.player.memory') || '{}'), watched: window.__watched }));
    const it = ph.calls.find((c) => c[0] === 'openPlayerApp')[1];
    ok('MX (free, the one installed): its package, the torrent\'s stream as it is, title, return_result', it.pkg === 'com.mxtech.videoplayer.ad' && it.data === 'http://127.0.0.1:5/stream/p1/0' && it.result && it.extras.some((e) => e.k === 'return_result') && it.extras.find((e) => e.k === 'title').v === 'Made-up Show - 05.mkv', it);
    ok('MX said «played to the end»: watched once, the show told', ph.watched.length === 1 && ph.watched[0].ep === 5 && Object.values(ph.mem).some((m) => m.watched));
    // «Another app»: the phone's chooser, nothing told → «Mark as watched?» when back.
    await p.evaluate(() => { localStorage.removeItem('kt.player.memory'); window.__watched = []; window.__calls = []; });
    await play(); await p.waitForSelector('.ext-chooser [data-player="any"]'); await p.click('.ext-chooser [data-player="any"]');
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'openPlayerApp'));
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForSelector('.ext-mark', { timeout: 10000 }); await p.waitForTimeout(250); await shot(p, 'mark-phone');
    const anyIt = await p.evaluate(() => window.__calls.find((c) => c[0] === 'openPlayerApp')[1]);
    ok('«another app»: the phone\'s chooser; back in the app: «Mark as watched?»', anyIt.chooser && !anyIt.pkg);
    await p.click('.ext-mark .btn.tonal'); await p.waitForTimeout(300);
    ok('…«Not yet»: not watched', await p.evaluate(() => (window.__watched ?? []).length === 0 && !Object.values(JSON.parse(localStorage.getItem('kt.player.memory') || '{}')).some((m) => m.watched)));
    // Settings → Player on a phone: no command line.
    await p.goto(base + '#/settings'); await p.waitForTimeout(800);
    await p.evaluate(() => { const c = document.getElementById('player'); if (c && c.tagName === 'DETAILS') c.open = true; c?.querySelector('summary, h3')?.click?.(); });
    await p.waitForSelector('.ext-settings', { timeout: 15000 }); await p.waitForFunction(() => /MX/.test(document.querySelector('.ext-found')?.textContent || ''));
    ok('phone settings: the four kinds of source, no command line (a computer\'s), MX and VLC found', (await p.$$('.ext-settings [data-service]')).length === 4 && !(await p.$('.ext-custom')));
    await p.$eval('.ext-settings', (e) => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(200); await shot(p, 'settings-phone');
    // Error on the phone (no app took it) with its fallback.
    await p.goto(base); await p.waitForSelector('.task-card');
    await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.extPlayers = { android: { torrent: 'vlc-android' } }; localStorage.setItem('kt.settings', JSON.stringify(s)); });
    await p.reload(); await p.waitForSelector('.task-card');
    await p.evaluate(() => { const pl = window.Capacitor.Plugins.KurokawaTools; window.__calls = []; window.Capacitor.Plugins.KurokawaTools = new Proxy({}, { get: (t, k) => (k === 'then' ? undefined : k === 'openPlayerApp' ? async () => { throw new Error('not installed'); } : pl[k]) }); });
    await play(); await p.waitForSelector('.ext-error', { timeout: 10000 }); await p.waitForTimeout(250); await shot(p, 'error-phone');
    ok('phone: the default app (VLC) used without asking; it failed → the error with the in-app player', /VLC/.test(await p.$eval('.ext-error', (e) => e.textContent)) && (await p.$$('.ext-error .btn')).length === 2);
    await p.close();
  }
  await br.close(); web.close();
  ok('no page errors', errors.length === 0, errors);
}

(async () => {
  logic();
  await relay();
  await programs();
  await page();
  console.log(fails ? `${fails} FAILED` : 'all ok'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e && e.stack || e); process.exit(1); });
