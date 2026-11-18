// Another app as the player (src/player/external, desktop/relay.cjs + extcmd.cjs + extplayer.cjs, the signed /p of
// streamproxy.cjs, their Rust and Java twins), with FAKE players and loopback media only.
// Run: NODE_PATH=$(npm root -g) node tests/extplayer.cjs [en|ar]
// 1. The plain logic: two ways per platform (old player ids count as the outside way); the plan for each kind of
//    source (a torrent's loopback stream, a file, a plain link, a site's stream with headers, HLS) on a phone and with
//    each computer player (one that does not tell where it stopped always reads through the relay; PotPlayer and an
//    arguments line without {ua}/{referrer} get the relay for headers); the phone's one intent with the union of the
//    known players' extras, and each known answer (VLC, MX/Just, mpv's position, mpv's plain OK at the end); «watched»;
//    settings that name a program or arguments cleaned on the way in (backup restore, hand-over).
// 2. The computer's shell: the command lines it builds itself (mpv, VLC, IINA --keep-running, MPC, PotPlayer, the
//    chosen program's arguments line, no shell); the request's checks (http(s) only, subtitles only from its temp
//    folder, no line breaks in headers); the programs (a fake mpv speaking JSON IPC, a fake VLC) found only on
//    absolute PATH folders, started only by a name the shell resolved, the chosen program kept by the shell.
// 3. The relay: wrong token, headers, ranges, HLS rewrite (relative, absolute, key, map, sub-playlist; file: dropped),
//    the cookie only to the source's origin (not to a CDN in the playlist nor after a redirect elsewhere), file: never
//    fetched, no CORS, status (last read), closed after; the signed /p (unsigned, tampered or expired: 403; file:
//    refused; CORS only for app://); relaylogic.rs's tests when rustc is here.
// 4. The page (playwright), computer and phone, English or Arabic: the chooser's two ways, «always» per kind of
//    video, mpv telling → watched once, a player that does not tell keeping the stream until the relay is quiet,
//    «Open in another player» from the app's own player keeping a torrent stream alive, the phone's intent and its
//    answers, the error with its fallback, the settings (phone and computer apart).
// KT_SHOTS=<dir>: screenshots.
'use strict';
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const http = require('node:http'); const Module = require('node:module'); const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..'); const LANG = process.argv[2] === 'ar' ? 'ar' : 'en'; const SHOTS = process.env.KT_SHOTS;
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 300000).unref();
const load = (file) => { const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild')); const out = esbuild.buildSync({ entryPoints: [path.join(ROOT, file)], bundle: true, format: 'cjs', platform: 'node', write: false }); const m = { exports: {} }; new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, require); return m.exports; };
const get = (u, h = {}, method = 'GET') => new Promise((res, rej) => { const r = http.request(u, { headers: h, method }, (x) => { const b = []; x.on('data', (d) => b.push(d)); x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: Buffer.concat(b) })); x.on('error', rej); }); r.on('error', rej); r.end(); });

/* ---------- 1. the plain logic ---------- */
function logic() {
  const L = load('src/player/external/logic.ts');
  ok('two ways: ask / app / out; an old player id counts as the outside way', L.wayOf(undefined) === 'ask' && L.wayOf('app') === 'app' && L.wayOf('out') === 'out' && L.wayOf('mx') === 'out' && L.wayOf('custom') === 'out');
  const torrent = { url: 'http://127.0.0.1:4567/t/abc/Show%20-%2001.mkv', name: 'Show - 01', start: 125 };
  const file = { url: 'http://127.0.0.1:4567/f?t=x&p=%2Fv%2Fa.mkv', name: 'Show - 02', localPath: '/videos/Show - 02.mkv' };
  const site = { url: 'https://cdn.test/v/master.m3u8', name: 'Show - 03', hls: true, headers: { Referer: 'https://site.test/', 'User-Agent': 'UA-1' }, subs: [{ url: 'https://cdn.test/s/en.vtt', name: 'English', isDefault: true, headers: { Referer: 'https://site.test/' } }] };
  const cookie = { ...site, headers: { ...site.headers, Cookie: 'k=v' } };
  const C = (id) => L.pcCaps(id);
  ok('phone: a torrent stream and a plain link as they are, a file by path, headers through the relay (subtitles too)', L.plan(torrent, 'android').main === 'direct' && L.plan(file, 'android').main === 'path' && L.plan(site, 'android').main === 'relay' && L.plan(site, 'android').subs[0] === 'relay');
  ok('phone: a subtitle file in the app\'s own folders is left out; one outside them goes by the app\'s loopback address', L.plan({ ...torrent, subs: [{ path: '/data/x.srt', name: 'x' }] }, 'android').subs[0] === 'drop' && L.plan({ ...torrent, subs: [{ path: '/storage/emulated/0/x.srt', name: 'x' }] }, 'android').subs[0] === 'direct');
  const m = L.plan(cookie, 'linux', C('mpv')); const m2 = L.plan(site, 'linux', C('mpv'));
  ok('computer, mpv with a cookie: the source through the relay (a cookie never on a command line), mpv still telling where it is', m.main === 'relay' && !m.headerArgs && m.relay && C('mpv').reports, m);
  ok('…with only User-Agent and Referer: those on its command line, no relay for the video', m2.main === 'direct' && m2.headerArgs, m2);
  ok('…a torrent stream and a file each through a relay session of their own; the app\'s own loopback subtitles as a copy (the run\'s token never handed out)', ['linux', 'win', 'mac'].every((os) => L.plan(torrent, os, C('mpv')).main === 'relay') && L.plan(file, 'linux', C('mpv')).main === 'relay' && L.plan({ ...file, subs: [{ path: '/v/a.srt', name: 'a' }] }, 'linux', C('mpv')).subs[0] === 'temp' && L.plan({ ...torrent, subs: [{ url: 'http://127.0.0.1:4567/TOK/f?p=%2Fa.srt', name: 'a' }] }, 'linux', C('mpv')).subs[0] === 'temp' && L.plan({ url: 'https://a.test/v.mkv', name: 'v', subs: [{ url: 'https://a.test/v.srt', name: 's' }] }, 'linux', C('mpv')).main === 'direct');
  for (const id of ['vlc', 'iina', 'mpc-hc', 'potplayer']) ok(`computer, ${id} (does not tell): always through the relay, so the app sees when reading stops`, L.plan(torrent, 'win', C(id)).main === 'relay' && L.plan(site, 'win', C(id)).main === 'relay');
  ok('PotPlayer: headers never on its command line (not documented well enough)', C('potplayer').headers === 'none');
  ok('VLC and MPC read subtitles from disk: saved first', L.plan(site, 'win', C('vlc')).subs[0] === 'temp' && L.plan(site, 'win', C('mpc-hc')).subs[0] === 'temp');
  ok('HLS to MPC: refused up front', L.plan(site, 'win', C('mpc-hc')).problem === 'hls' && !L.plan(torrent, 'win', C('mpc-hc')).problem);
  ok('the chosen program: User-Agent/Referer only when its line places both, else none (the relay sends them)', L.chosenCaps('--ua={ua} --ref={referrer} {url}', 'x').headers === 'ua-ref' && L.chosenCaps('--fs {url}', 'x').headers === 'none' && L.chosenCaps('--ua={ua}', 'x').headers === 'none');
  ok('Automatic: the first known player found, in order', L.autoPick([{ id: 'vlc' }, { id: 'mpv' }]).id === 'mpv' && L.autoPick([{ id: 'potplayer' }, { id: 'vlc' }]).id === 'vlc' && L.autoPick([]) === undefined);
  ok('services', L.serviceOf({ taskKind: 'torrent' }) === 'torrent' && L.serviceOf({ localPath: '/a' }) === 'local' && L.serviceOf({ headers: { a: 'b' } }) === 'online' && L.serviceOf({}) === 'http');
  const ready = { target: 'http://127.0.0.1:9/r/T/v/Show', isPath: false, title: 'Show - 03', start: 90.4, subs: [{ at: 'http://127.0.0.1:9/r/T/s/0/en.vtt', name: 'English', isDefault: true }, { at: 'http://127.0.0.1:9/r/T/s/1/ar.ass', name: 'العربية' }] };
  const it = L.androidIntent(ready); const e = Object.fromEntries(it.extras.map((x) => [x.k, [x.t, x.v]]));
  ok('phone intent: one, with the union of the extras (title, int position, from_start, Uri[] subs with names and the default, VLC\'s subtitles_location, return_result); no headers', e.title[1] === 'Show - 03' && e.position[0] === 'i' && e.position[1] === 90400 && e.from_start[1] === false && e.subs[0] === 'ua' && e.subs[1].length === 2 && e['subs.name'][1][1] === 'العربية' && e['subs.enable'][1][0] === ready.subs[0].at && e.subtitles_location[1] === ready.subs[0].at && e.return_result[1] === true && !e.headers && !('pkg' in it), it);
  ok('a file on the phone: by path', L.androidIntent({ ...ready, target: '/storage/emulated/0/a.mkv', isPath: true }).path === '/storage/emulated/0/a.mkv');
  const R = L.androidResult;
  ok('answers: VLC extra_position; MX/Just position and end_by; mpv position; mpv\'s plain OK at the end = ended', R({ code: -1, extras: { extra_position: 1300000, extra_duration: 1440000 } }).pos === 1300 && R({ code: -1, extras: { position: 1430000, duration: 1440000, end_by: 'playback_completion' } }).ended && R({ code: -1, extras: { position: 60000, duration: 1440000 } }).pos === 60 && R({ code: -1, action: 'is.xyz.mpv.MPVActivity.result', extras: {} }).ended);
  ok('nothing known told: told false (→ «Mark as watched?»); hostile values ignored', !R({ code: 0, extras: {} }).told && !R(null).told && !R({ code: -1, action: 'other.app', extras: {} }).told && R({ code: -1, extras: { position: 'x', duration: -5 } }).told === false);
  ok('watched: past 90 %, at the end, not before', L.isWatched({ pos: 1300, dur: 1440 }) && L.isWatched({ ended: true }) && !L.isWatched({ pos: 60, dur: 1440 }));
  // settings that name a program or arguments are cleaned on the way in
  const S = load('src/settingsSafe.ts');
  const dirty = JSON.stringify({ addons: ['player'], extCustom: 'calc.exe --evil', extProgram: 'x', extPcPlayer: 'C:\\evil.exe', extPlayers: { desktop: { local: 'custom', online: 'out' }, android: { torrent: 'mx' } }, playerWith: 'external' });
  const clean = JSON.parse(S.safeStored('kt.settings', dirty));
  ok('settings restore / hand-over: no program, no arguments, defaults only ask/app/out', !('extCustom' in clean) && !('extProgram' in clean) && !('extPcPlayer' in clean) && clean.extPlayers.desktop.local === 'ask' && clean.extPlayers.desktop.online === 'out' && clean.extPlayers.android.torrent === 'ask' && clean.playerWith === 'external' && S.safeStored('kt.other', dirty) === dirty, clean);
  const store = new Map(); global.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } }; global.window = global.window || {};
  try { const B = load('src/backup.ts'); B.applyRestore({ 'kt.settings': dirty }); const after = JSON.parse(store.get('kt.settings')); ok('…through the backup\'s own restore (backup.ts)', !('extCustom' in after) && after.extPlayers.desktop.local === 'ask'); }
  catch (err) { ok('backup.ts loads in node', false, String(err && err.message)); }
  ok('…and the hand-over writes through it (handover.ts)', /safeStored\(k,/.test(fs.readFileSync(path.join(ROOT, 'src/handover.ts'), 'utf8')));
}

/* ---------- 2. the computer's shell ---------- */
async function shell() {
  const X = require('../desktop/extcmd.cjs');
  const q = X.check({ target: 'https://cdn.test/v/master.m3u8', title: 'Show\n- 03', start: 90.4, subs: [{ at: path.join(os.tmpdir(), 'kurokawa-clip', 'en.vtt'), isDefault: true }], headers: { ua: 'UA-1', referer: 'https://site.test/' }, slang: ['ar', 'EN', 'en'], alang: ['ja'] }, X.tempDirs()).req;
  ok('request checked: title without line breaks, languages as codes', q && q.title === 'Show - 03' && q.slang.join() === 'ar,en');
  const sub = q.subs[0].at;
  const mpv = X.build('mpv', q).args;
  ok('mpv: title, start, sub, langs, User-Agent and Referer only, hwdec, IPC, «--» then the address', mpv.includes('--start=90.4') && mpv.includes(`--sub-file=${sub}`) && mpv.includes('--user-agent=UA-1') && !mpv.some((a) => /header-fields/.test(a)) && mpv.includes('--input-ipc-server=${ipc}') && mpv.slice(-2).join() === `--,${q.target}`, mpv);
  ok('any other header (a cookie) refused by the shell: such a source must come through the relay', X.check({ target: 'https://a/b', headers: { others: [['Cookie', 'k=v']] } }, X.tempDirs()).error === 'header');
  const ii = X.build('iina', q).args;
  ok('IINA: --keep-running (waits until its window is closed), never -w; its mpv options as --mpv-…', ii[0] === '--keep-running' && !ii.includes('-w') && ii.includes('--mpv-start=90.4') && ii[ii.length - 1] === q.target, ii);
  const vlc = X.build('vlc', q).args; ok('VLC: meta-title, start-time, sub-file, play-and-exit, the address last', vlc.includes('--start-time=90.4') && vlc.includes(`--sub-file=${sub}`) && vlc.includes('--play-and-exit') && vlc[vlc.length - 1] === q.target);
  ok('MPC: /play /close /start ms /sub', X.build('mpc-hc', q).args.join(' ') === `${q.target} /play /close /start 90400 /sub ${sub}`);
  ok('PotPlayer: no header switches', !X.build('potplayer', q).args.some((a) => /user_agent|referer/.test(a)));
  const c = X.build('custom', { ...q, subs: [] }, '"--title={title}" --sub={sub} --hdr \'{referrer}\' ; rm -rf $(x)').args;
  ok('the chosen program\'s line: placeholders inside their own argument, empty ones dropped, no shell (; and $( ) plain)', c.join('|') === `--title=Show - 03|--hdr|https://site.test/|;|rm|-rf|$(x)|${q.target}`, c);
  const opt = X.build('custom', { ...q, title: '--script=evil.lua', subs: [] }, '{title} --name={title} {url}').args;
  ok('…a bare placeholder whose value starts with «-» is left out (it would be read as an option)', opt.join('|') === `--name=--script=evil.lua|${q.target}`, opt);
  ok('refused: a file: or other non-http address, a subtitle outside the temp folder, a header with a line break, a referer that is no address', X.check({ target: 'file:///etc/passwd' }, X.tempDirs()).error === 'target' && X.check({ target: 'https://a/b', subs: [{ at: path.join(os.homedir(), '.ssh', 'id.srt') }] }, X.tempDirs()).error === 'subtitle' && X.check({ target: 'https://a/b', headers: { ua: 'a\r\nX: y' } }, X.tempDirs()).error === 'header' && X.check({ target: 'https://a/b', headers: { referer: 'javascript:x' } }, X.tempDirs()).error === 'header');
  if (process.platform === 'win32') { console.log('skip programs (fake players are shell scripts)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-extbin-')); const log = path.join(dir, 'log.jsonl'); const rel = path.join(dir, 'rel'); fs.mkdirSync(rel);
  const fakeMpv = `const fs=require('fs');const net=require('net');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({p:'mpv',a})+'\\n');
const ipc=(a.find(x=>x.startsWith('--input-ipc-server='))||'').split('=')[1];if(!ipc)process.exit(2);
const srv=net.createServer(c=>{let b='';c.on('data',d=>{b+=d;let n;while((n=b.indexOf('\\n'))>=0){const l=b.slice(0,n);b=b.slice(n+1);const m=JSON.parse(l);if(m.command[0]==='observe_property'){const nm=m.command[2];const v=nm==='time-pos'?1300.5:nm==='duration'?1440:false;c.write(JSON.stringify({event:'property-change',id:m.command[1],name:nm,data:v})+'\\n');}}});setTimeout(()=>{c.write(JSON.stringify({event:'property-change',id:1,name:'time-pos',data:1438})+'\\n');c.write(JSON.stringify({event:'end-file',reason:'eof'})+'\\n');setTimeout(()=>{srv.close();process.exit(0);},100);},400);});
srv.listen(ipc);`;
  fs.writeFileSync(path.join(dir, 'fakempv.js'), fakeMpv);
  fs.writeFileSync(path.join(dir, 'mpv'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'fakempv.js')}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(rel, 'vlc'), `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'myplayer'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}.mine"\nexit 0\n`, { mode: 0o755 });
  const E = require('../desktop/extplayer.cjs'); E.init(path.join(dir, 'store', 'ext-player.json'));
  const oldPath = process.env.PATH; const oldCwd = process.cwd(); process.chdir(dir); process.env.PATH = `${dir}${path.delimiter}rel${path.delimiter}${oldPath}`;
  try {
    const f = E.find();
    ok('found: mpv on an absolute PATH folder; VLC only on a relative PATH folder is not found; nothing chosen yet', f.found.some((x) => x.id === 'mpv') && !f.found.some((x) => x.id === 'vlc') && f.chosen === null, f);
    let threw = ''; try { E.start({ player: '/bin/sh', target: 'https://a/b' }); } catch (e) { threw = e.message; } ok('a program the page names is refused (only a known id or «chosen»)', /not installed/.test(threw));
    threw = ''; try { E.start({ player: 'mpv', target: 'file:///etc/passwd' }); } catch (e) { threw = e.message; } ok('…a file: address refused', /refused: target/.test(threw));
    threw = ''; try { E.start({ player: 'chosen', target: 'https://a/b' }); } catch (e) { threw = e.message; } ok('«chosen» with nothing chosen: refused', /not installed/.test(threw));
    const { id, reports } = E.start({ player: 'mpv', target: 'http://127.0.0.1:1/x', title: 'Show - 01 ${ipc}', start: 12 });
    let st; const t0 = Date.now(); let seenRunning = false;
    for (;;) { await new Promise((r) => setTimeout(r, 100)); st = E.status({ id }); if (st.running) seenRunning = true; if (!st.running || Date.now() - t0 > 8000) break; }
    const rec = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))[0];
    ok('mpv started by the shell with arguments it built, ${ipc} filled with its own socket in --input-ipc-server only (a title naming it stays as it is)', reports && rec.a[0] === '--force-media-title=Show - 01 ${ipc}' && rec.a.some((a) => /--input-ipc-server=.*kt-mpv-[0-9a-f]+\.sock$/.test(a)) && rec.a[rec.a.length - 1] === 'http://127.0.0.1:1/x', rec.a);
    ok('its position told by IPC, the end seen, then ended; the record dropped after', seenRunning && !st.running && st.pos === 1438 && st.dur === 1440 && st.eof && E.status({ id }).error === 'unknown', st);
    threw = ''; try { E.setChosen('myplayer'); } catch (e) { threw = e.message; } ok('the chosen program must be an absolute path to a file (a clear error)', /kt-ext:notprogram/.test(threw));
    // (A Mac's dialog gives the .app bundle: its program inside, by Info.plist's CFBundleExecutable.)
    const app = path.join(dir, 'Fake Player.app'); fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true }); fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleExecutable</key>\n<string>fakeplay</string></dict></plist>'); fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'fakeplay'), '#!/bin/sh\n', { mode: 0o755 });
    ok('a .app bundle picked: its program inside is kept', E.setChosen(app).path === path.join(app, 'Contents', 'MacOS', 'fakeplay'));
    // (Info.plist in its binary form — bplist00, as a built bundle often has it —, read best-effort; IINA's iina-cli first.)
    const bpl = (pairs) => { const enc = (s) => { const ascii = /^[\x00-\x7f]*$/.test(s); let body = Buffer.from(s, ascii ? 'latin1' : 'utf16le'); if (!ascii) { body = Buffer.from(body); body.swap16(); } const n = ascii ? s.length : body.length / 2; return Buffer.concat([Buffer.from(n < 15 ? [(ascii ? 0x50 : 0x60) | n] : [ascii ? 0x5f : 0x6f, 0x10, n]), body]); };
      const n = pairs.length; const objs = [Buffer.from([0xd0 | n, ...pairs.map((_, i) => 1 + i), ...pairs.map((_, i) => 1 + n + i)]), ...pairs.map((p) => enc(p[0])), ...pairs.map((p) => enc(p[1]))];
      let out = Buffer.from('bplist00', 'latin1'); const offs = []; for (const o of objs) { offs.push(out.length); out = Buffer.concat([out, o]); } const table = out.length;
      const tr = Buffer.alloc(32); tr[6] = 2; tr[7] = 1; tr.writeBigUInt64BE(BigInt(objs.length), 8); tr.writeBigUInt64BE(0n, 16); tr.writeBigUInt64BE(BigInt(table), 24);
      return Buffer.concat([out, Buffer.concat(offs.map((o) => Buffer.from([o >> 8, o & 255]))), tr]); };
    const bin = bpl([['CFBundleName', 'Fake'], ['CFBundleExecutable', 'fakebin'], ['Note', 'مشغّل']]);
    const app2 = path.join(dir, 'Binary Player.app'); fs.mkdirSync(path.join(app2, 'Contents', 'MacOS'), { recursive: true }); fs.writeFileSync(path.join(app2, 'Contents', 'Info.plist'), bin); fs.writeFileSync(path.join(app2, 'Contents', 'MacOS', 'fakebin'), '#!/bin/sh\n', { mode: 0o755 });
    ok('…a binary Info.plist: CFBundleExecutable read (UTF-16 values too); a broken one gives nothing, no throw', E.bplistString(bin, 'CFBundleExecutable') === 'fakebin' && E.bplistString(bin, 'Note') === 'مشغّل' && E.setChosen(app2).path === path.join(app2, 'Contents', 'MacOS', 'fakebin') && E.bplistString(bin.subarray(0, 45), 'CFBundleExecutable') === null && E.bplistString(Buffer.concat([bin.subarray(0, bin.length - 1), Buffer.from([255])]), 'CFBundleExecutable') === null);
    const iina = path.join(dir, 'IINA.app'); fs.mkdirSync(path.join(iina, 'Contents', 'MacOS'), { recursive: true }); fs.writeFileSync(path.join(iina, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleExecutable</key><string>IINA</string></dict></plist>');
    for (const f of ['IINA', 'iina-cli']) fs.writeFileSync(path.join(iina, 'Contents', 'MacOS', f), '#!/bin/sh\n', { mode: 0o755 });
    ok('…IINA picked: its bundled iina-cli, not the window program', E.setChosen(iina).path === path.join(iina, 'Contents', 'MacOS', 'iina-cli'));
    const subCopy = path.join(os.tmpdir(), 'kurokawa-clip', `kt-sub-test${process.pid}.srt`); fs.mkdirSync(path.dirname(subCopy), { recursive: true }); fs.writeFileSync(subCopy, '1\n');
    const outside = path.join(dir, 'kt-sub-x.srt'); fs.writeFileSync(outside, '1\n');
    ok('a subtitle copy removed after its player; nothing else (another folder, another name)', E.dropSub({ path: subCopy }).ok && !fs.existsSync(subCopy) && !E.dropSub({ path: outside }).ok && fs.existsSync(outside) && !E.dropSub({ path: '/etc/passwd' }).ok);
    E.setChosen(path.join(dir, 'myplayer')); E.setArgs({ args: '--name={title} {url}' });
    ok('the chosen program and its line kept by the shell (its own file), shown back', E.find().chosen.path === path.join(dir, 'myplayer') && E.find().chosen.args === '--name={title} {url}' && fs.existsSync(path.join(dir, 'store', 'ext-player.json')));
    const ch = E.start({ player: 'chosen', target: 'https://cdn.test/a.mp4', title: 'A b' });
    for (let i = 0; i < 50 && E.status({ id: ch.id }).running; i++) await new Promise((r) => setTimeout(r, 100));
    ok('…started with its line filled (each argument one item), not telling', !ch.reports && fs.readFileSync(`${log}.mine`, 'utf8').trim() === '--name=A b\nhttps://cdn.test/a.mp4');
  } finally { process.env.PATH = oldPath; process.chdir(oldCwd); E.release(); fs.rmSync(dir, { recursive: true, force: true }); }
}

/* ---------- 3. the relay and the signed proxy ---------- */
async function relay() {
  const seen = []; const SEG = Buffer.alloc(200000, 7);
  const mk = (fn) => { const s = http.createServer(fn).listen(0, '127.0.0.1'); return new Promise((r) => s.on('listening', () => r(s))); };
  const cdn = await mk((req, res) => { seen.push({ host: 'cdn', url: req.url, cookie: req.headers.cookie, ref: req.headers.referer, auth: req.headers.authorization }); res.writeHead(200); res.end(`cdn ${req.url}`); });
  const C = `http://127.0.0.1:${cdn.address().port}`;
  const origin = await mk((req, res) => {
    seen.push({ host: 'origin', url: req.url, ref: req.headers.referer, cookie: req.headers.cookie, ua: req.headers['user-agent'] });
    const u = req.url.split('?')[0];
    if (req.headers.cookie !== 'k=v') { res.writeHead(403); res.end('no'); return; }
    if (u === '/v/master.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8?sig=1\n'); return; }
    if (u === '/v/low/index.m3u8') { res.writeHead(200, { 'content-type': 'application/x-mpegURL' }); res.end(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../keys/k.bin",IV=0x01\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg0.ts\n#EXTINF:4,\n${C}/abs/seg1.ts\n#EXTINF:4,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n`); return; }
    if (u === '/s/en.vtt') { res.writeHead(200, { 'content-type': 'text/vtt' }); res.end('WEBVTT\n\n00:01.000 --> 00:02.000\nHello\n'); return; }
    if (u === '/away') { res.writeHead(302, { location: `${C}/moved.mp4` }); res.end(); return; }
    if (u === '/tofile') { res.writeHead(302, { location: 'file:///etc/passwd' }); res.end(); return; }
    if (u === '/big.mp4') { const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); if (m) { const a = +m[1], b = m[2] ? +m[2] : SEG.length - 1; res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${a}-${b}/${SEG.length}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' }); res.end(SEG.subarray(a, b + 1)); return; } res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': SEG.length }); res.end(SEG); return; }
    if (u === '/huge.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); const line = Buffer.from('#EXTINF:4,\nseg.ts\n'.repeat(4096)); let n = 0; const more = () => { while (n < 300) { n++; if (!res.write(line)) { res.once('drain', more); return; } } res.end(); }; more(); return; }
    if (u === '/slow.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); const iv = setInterval(() => res.write(Buffer.alloc(1000)), 20); res.on('close', () => clearInterval(iv)); return; }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(`part ${u}`);
  });
  const O = `http://127.0.0.1:${origin.address().port}`;
  const Relay = require('../desktop/relay.cjs');
  const srv = await mk((req, res) => { void Relay.handle(req, res, `http://127.0.0.1:${srv.address().port}`).then((hd) => { if (!hd) { res.writeHead(404); res.end(); } }).catch((e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e)); }); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const H = { Referer: 'https://site.test/', Cookie: 'k=v', Authorization: 'Bearer s', 'User-Agent': 'UA-TEST' };
  let threw = false; try { Relay.open({ url: 'file:///etc/passwd' }, base); } catch { threw = true; } ok('relay: a file: source refused', threw);
  const s = Relay.open({ url: `${O}/v/master.m3u8`, headers: H, name: 'Show - 03', subs: [{ url: `${O}/s/en.vtt`, name: 'English.vtt' }, { path: '/etc/passwd', name: 'x.srt' }, { url: 'file:///etc/passwd', name: 'y.srt' }] }, base);
  ok('a token in the path; a subtitle given as a path or file: gets no address (no file read for a player)', new RegExp(`^${base}/r/[0-9a-f]{32}/v/Show%20-%2003$`).test(s.url) && s.subs[0] && s.subs[1] === '' && s.subs[2] === '', s);
  ok('a wrong token: 403', (await get(s.url.replace(s.token, '0'.repeat(32)))).status === 403);
  const master = await get(s.url, { Origin: 'https://evil.test' });
  ok('the master playlist rewritten; no CORS header at all', master.status === 200 && new RegExp(`/r/${s.token}/u/0`).test(master.body.toString()) && !('access-control-allow-origin' in master.headers));
  const media = (await get(`${base}/r/${s.token}/u/0`)).body.toString();
  ok('the media playlist: key, map, relative and absolute segments made session addresses; the file: line dropped', /URI="[^"]+\/u\/1",IV=0x01/.test(media) && /URI="[^"]+\/u\/2"/.test(media) && /\/u\/3\n/.test(media) && /\/u\/4\n/.test(media) && !/file:|passwd/.test(media), media);
  const parts = await Promise.all([1, 2, 3, 4].map((n) => get(`${base}/r/${s.token}/u/${n}`)));
  ok('…each part read', parts.every((p) => p.status === 200) && parts.map((p) => p.body.toString()).join('|') === `part /v/keys/k.bin|part /v/low/init.mp4|part /v/low/seg0.ts|cdn /abs/seg1.ts`, parts.map((p) => p.body.toString()));
  const toCdn = seen.filter((x) => x.host === 'cdn');
  ok('the cookie and authorisation went only to the source\'s origin; the CDN in the playlist got the referer only', toCdn.length === 1 && !toCdn[0].cookie && !toCdn[0].auth && toCdn[0].ref === 'https://site.test/' && seen.filter((x) => x.host === 'origin').every((x) => x.cookie === 'k=v'), toCdn);
  const s4 = Relay.open({ url: `${O}/away`, headers: H, name: 'a' }, base); seen.length = 0; const moved = await get(s4.url);
  ok('a redirect to another host followed here, without the cookie', moved.status === 200 && /cdn \/moved\.mp4/.test(moved.body.toString()) && seen.some((x) => x.host === 'cdn' && !x.cookie && !x.auth));
  const s5 = Relay.open({ url: `${O}/tofile`, headers: H, name: 'f' }, base); ok('a redirect to file: refused', (await get(s5.url)).status === 502);
  ok('no URL from a request: an unknown number is 404', (await get(`${base}/r/${s.token}/u/99`)).status === 404 && (await get(`${base}/r/${s.token}/u/x?u=${encodeURIComponent(O + '/big.mp4')}`)).status === 404);
  const sub0 = await get(s.subs[0]); ok('the site\'s subtitle served with its headers', sub0.status === 200 && /Hello/.test(sub0.body.toString()));
  const s2 = Relay.open({ url: `${O}/big.mp4`, headers: H, name: 'b' }, base);
  const before = Relay.status(s2.token).lastRead; await new Promise((r) => setTimeout(r, 20));
  const rg = await get(s2.url, { Range: 'bytes=100-199' });
  ok('ranges passed; status tells the last read', rg.status === 206 && rg.body.length === 100 && Relay.status(s2.token).open && Relay.status(s2.token).lastRead > before && Relay.status(s2.token).reads === 1);
  const s3 = Relay.open({ url: `${O}/slow.mp4`, headers: H, name: 'slow' }, base);
  const cut = await new Promise((resolve) => { const r = http.get(s3.url, (x) => { let n = 0; x.on('data', (d) => { n += d.length; if (n > 3000) { ok('…a read under way counted', Relay.status(s3.token).reading === 1); Relay.close(s3.token); } }); x.on('close', () => resolve(true)); x.on('error', () => resolve(true)); }); r.on('error', () => resolve(true)); setTimeout(() => resolve(false), 5000); });
  ok('closed: the read under way cut, the address refused (403), status closed', cut && (await get(s3.url)).status === 403 && !Relay.status(s3.token).open);
  const s6 = Relay.open({ url: `${O}/huge.m3u8`, headers: H, name: 'h' }, base);
  ok('a playlist bigger than the cap (16 MB) is not buffered: 502', (await get(s6.url)).status === 502 && Relay.MAX_LIST === 16 << 20);
  let longRefused = false; try { Relay.open({ url: `${O}/${'x'.repeat(9000)}` }, base); } catch { longRefused = true; } ok('…an address longer than 8 KB refused', longRefused);
  for (const x of [s, s2, s4, s5, s6]) Relay.close(x.token);
  ok('all sessions closed', Relay.count() === 0);
  // the signed /p through streamproxy.cjs's own server (Electron's net stood in by Node's fetch)
  const real = Module._load; Module._load = function (req, ...rest) { if (req === 'electron') return { net: { fetch: (u, o) => fetch(u, o), request: () => { throw new Error('not in tests'); } }, app: { getPath: () => os.tmpdir() } }; return real.call(this, req, ...rest); };
  try {
    const SP = require('../desktop/streamproxy.cjs'); Relay.setFetch((u, o) => fetch(u, o));
    const pu = await SP.url(`${O}/big.mp4`, H);
    ok('/p: signed address (expiry and HMAC)', /\/p\?u=.*&h=.*&e=\d+&t=[0-9a-f]{32}$/.test(pu));
    const g = await get(pu, { Range: 'bytes=0-9', Origin: 'app://kurokawa' });
    ok('…its own address works, CORS only for the app\'s page', g.status === 206 && g.body.length === 10 && g.headers['access-control-allow-origin'] === 'app://kurokawa');
    const g2 = await get(pu, { Range: 'bytes=0-9', Origin: 'https://evil.test' }); ok('…another origin gets no CORS', g2.status === 206 && !('access-control-allow-origin' in g2.headers));
    const unsigned = pu.replace(/&e=.*$/, ''); const tampered = pu.replace(encodeURIComponent(`${O}/big.mp4`), encodeURIComponent(`${O}/slow.mp4`)); const expired = pu.replace(/&e=\d+/, '&e=1000');
    ok('…unsigned, tampered or expired: 403 before anything is fetched', (await get(unsigned)).status === 403 && (await get(tampered)).status === 403 && (await get(expired)).status === 403);
    let refused = false; try { await SP.url('file:///etc/passwd', {}); } catch { refused = true; } ok('…a file: source refused', refused);
    let nl = false; try { await SP.url('https://a.test/x\nX: y', {}); } catch { nl = true; } ok('…an address with a line break refused', nl);
    // (/audio and /video run ffmpeg on what they are given: only under this run's token, CORS for the app's page only.)
    const ab = await SP.audioBase(); const vb = await SP.videoBase();
    const ah = await get(ab, { Origin: 'https://evil.test' }, 'HEAD');
    ok('/audio and /video: only with the run\'s token in the path (bare: 403), no CORS for another origin', /\/audio\/[0-9a-f]{32}$/.test(ab) && /\/video\/[0-9a-f]{32}$/.test(vb) && ah.status === 200 && !('access-control-allow-origin' in ah.headers) && (await get(ab.replace(/\/audio\/.*$/, '/audio?src=x'), {}, 'HEAD')).status === 403 && (await get(vb.replace(/\/video\/.*$/, '/video?src=x'), {}, 'HEAD')).status === 403);
    // (A file on this computer for another program's player: a relay session's own address, ranges, nothing of the run's token.)
    const tmpFile = path.join(os.tmpdir(), `kt-relay-file-${process.pid}.mkv`); fs.writeFileSync(tmpFile, Buffer.alloc(5000, 3));
    const rf = await SP.relayOpen({ file: tmpFile, name: 'Local' }); const gf = await get(rf.url, { Range: 'bytes=10-19' });
    const rev = await get(rf.url, { Range: 'bytes=100-50' }); const past = await get(rf.url, { Range: 'bytes=6000-' });
    ok('…a reversed range (bytes=100-50) or one past the end: 416 with the size', rev.status === 416 && rev.headers['content-range'] === 'bytes */5000' && past.status === 416);
    let relRefused = false; try { await SP.relayOpen({ file: 'relative/x.mkv' }); } catch { relRefused = true; }
    ok('a file through a relay session: ranges served, its address has no run token; a relative or missing path refused', gf.status === 206 && gf.body.length === 10 && /\/r\/[0-9a-f]{32}\/v\/Local$/.test(rf.url) && relRefused);
    SP.relayClose({ token: rf.token }); ok('…closed: 403', (await get(rf.url)).status === 403); fs.rmSync(tmpFile, { force: true });
    const r = await SP.relayOpen({ url: `${O}/big.mp4`, headers: H, name: 'v' });
    ok('streamproxy.cjs: relayOpen on the app\'s stream server, relayStatus, relayClose', /^http:\/\/127\.0\.0\.1:\d+\/r\/[0-9a-f]{32}\/v\/v$/.test(r.url) && (await get(r.url, { Range: 'bytes=0-9' })).status === 206 && SP.relayStatus({ token: r.token }).open && SP.relayClose({ token: r.token }).closed && (await get(r.url)).status === 403);
    SP.stop();
  } catch (e) { ok('streamproxy.cjs with Electron stood in', false, String(e && e.stack || e)); } finally { Module._load = real; }
  srv.close(); origin.close(); cdn.close();
  try { execFileSync('rustc', ['--version'], { stdio: 'ignore' }); const out = path.join(os.tmpdir(), `kt-relaylogic-${process.pid}`); execFileSync('rustc', ['--edition', '2021', '--test', path.join(ROOT, 'desktop-tauri/src-tauri/src/relaylogic.rs'), '-o', out], { stdio: 'pipe' }); const r = execFileSync(out, { encoding: 'utf8' }); ok('relaylogic.rs: its tests (join, rewrite, parse, headers by origin, players\' arguments, checks, mpv lines)', /test result: ok\. 7 passed/.test(r), r); fs.rmSync(out, { force: true }); }
  catch (e) { if (e.code === 'ENOENT') console.log('skip relaylogic.rs (no rustc)'); else ok('relaylogic.rs compiles and passes', false, String(e.stderr || e.message).slice(-800)); }
}

/* ---------- 4. the page ---------- */
const STREAM = LANG === 'ar' ? 'تشغيل في أثناء التنزيل' : 'Play while downloading';
const OPENWITH = LANG === 'ar' ? 'افتحه في مشغّل آخر' : 'Open in another player';
const streamFrom = async (p, i) => { const cards = typeof i === 'string' ? [await p.$(`.task-card:has-text("${i}")`)] : await p.$$('.task-card'); await cards[typeof i === 'string' ? 0 : i].click(); const b = p.getByRole('button', { name: STREAM }).first(); await b.waitFor({ timeout: 10000 }); await b.click(); };
async function page() {
  let chromium; try { ({ chromium } = require('playwright')); } catch { console.log('skip page (no playwright)'); return; }
  const DIST = path.join(ROOT, 'dist'); if (!fs.existsSync(path.join(DIST, 'index.html'))) { ok('dist built', false); return; }
  const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-extmedia-'));
  fs.writeFileSync(path.join(MEDIA, 'en.srt'), '1\n00:00:01,000 --> 00:00:03,000\nFirst line\n');
  let media = true; try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '20', '-c:v', 'libvpx', '-b:v', '200k', path.join(MEDIA, 'clip.webm')]); } catch { media = false; }
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.webm': 'video/webm', '.srt': 'text/plain' };
  const web = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(f).size; const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); const type = MIME[path.extname(f)] || 'application/octet-stream';
    if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1, 'access-control-allow-origin': '*' }); fs.createReadStream(f, { start: a, end: b }).pipe(res); return; }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'access-control-allow-origin': '*' }); fs.createReadStream(f).pipe(res);
  }).listen(0, '127.0.0.1'); await new Promise((r) => web.on('listening', r));
  const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `ext-${name}-${LANG}.png`) }); } };
  const task = (o) => ({ id: o.id, kind: o.kind, name: o.name, source: { url: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) }, dir: o.dir, state: o.state, done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: o.name, size: 1000, done: o.state === 'done' ? 1000 : 300, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now(), engine: o.engine, meta: o.meta });
  const META = { anilistId: 4242, episode: 3, title: 'Made-up Show' };
  const playLabel = LANG === 'ar' ? 'تشغيل' : 'Play';
  /* ----- the computer ----- */
  {
    const p = await br.newPage({ viewport: { width: 1280, height: 800 } }); p.on('pageerror', (e) => errors.push('pc: ' + e.message));
    // (Default settings: nothing about how to watch is set — one chooser must be all that is asked.)
    await p.addInitScript(([lang, tasks, port]) => {
      localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1');
      if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime'], settingsLayout: 'tabs' }));
      window.__calls = []; window.__status = {}; window.__relayReads = 0; window.__quietAfter = 1; window.__lastRead = () => Date.now() - 3600e3;
      const rec = (k) => async (o) => { window.__calls.push([k, o]); return undefined; };
      // (Each fake takes what the real bridge method takes — desktop/preload.cjs and desktop-tauri/bridge.js; checked below.)
      const api = {
        platform: 'desktop', available: true, os: 'linux', list: async () => tasks, onTasks: (fn) => { setTimeout(() => fn(tasks), 50); return () => {}; }, freeSpace: async () => 5e11,
        fileUrl: async (pth) => `http://127.0.0.1:${port}/media/${pth.split('/').pop()}?t=RUNTOKEN`, streamUrl: async (o) => { window.__calls.push(['streamUrl', o]); return { url: `http://127.0.0.1:${port}/media/clip.webm?t=RUNTOKEN` }; }, streamDone: rec('streamDone'),
        extPlayers: async () => { window.__calls.push(['extPlayers']); return { found: [{ id: 'mpv', name: 'mpv' }, { id: 'vlc', name: 'VLC' }].filter((f) => !window.__noPlayers), chosen: window.__chosen ?? null }; },
        extPlayerChoose: async (o) => { window.__calls.push(['extPlayerChoose', o]); if (window.__chooseFails) throw new Error(window.__chooseFails); if (window.__chooseCancel) return null; window.__chosen = { path: '/opt/my player/play', args: '', there: true }; return { path: '/opt/my player/play' }; },
        extPlayerStart: async (o) => { window.__calls.push(['extPlayerStart', o]); if (window.__failStart) throw new Error('spawn ENOENT'); const id = String(window.__calls.length); window.__status[id] = { n: 0, mpv: o.player === 'mpv' }; return { id, reports: o.player === 'mpv' }; },
        extPlayerStatus: async (o) => { window.__calls.push(['extPlayerStatus', o]); const s = window.__status[o.id]; s.n++; return s.n < 2 ? { running: true, code: null, pos: s.mpv ? 600 : null, dur: s.mpv ? 1440 : null, eof: false } : { running: false, code: 0, pos: s.mpv ? 1350 : null, dur: s.mpv ? 1440 : null, eof: false }; },
        extPlayerDropSub: rec('extPlayerDropSub'),
        relayOpen: async (o) => { window.__calls.push(['relayOpen', o]); return { token: 'tok', url: 'http://127.0.0.1:3/r/tok/v/x', subs: (o.subs || []).map((x, i) => (x.url ? `http://127.0.0.1:3/r/tok/s/${i}/s` : '')) }; }, relayClose: rec('relayClose'),
        relayStatus: async (o) => { window.__calls.push(['relayStatus', o]); window.__relayReads++; return window.__relayReads <= window.__quietAfter ? { open: true, lastRead: Date.now(), reading: 1 } : { open: true, lastRead: window.__lastRead(), reading: 0 }; },
        writeTemp: async (name, text) => { window.__calls.push(['writeTemp', { name, text }]); return `/tmp/kurokawa-clip/${name}`; },
      };
      window.__api = api;
      window.kurokawaTools = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
    }, [LANG, [task({ id: 'd1', kind: 'http', name: 'Made-up Show - 03.mkv', dir: '/videos', state: 'done', engine: 'aria2', meta: META }), task({ id: 't1', kind: 'torrent', name: 'Made-up Clip.mkv', dir: '/videos', state: 'downloading', engine: 'aria2' })], web.address().port]);
    await p.goto(base); await p.waitForSelector('.task-card', { timeout: 20000 });
    // The fakes take what the real bridges take (a fake with another shape once hid a wrong call).
    {
      const shape = (file, re) => { const out = {}; const src = fs.readFileSync(path.join(ROOT, file), 'utf8'); let m; while ((m = re.exec(src))) out[m[1]] = m[2].split(',').map((x) => x.trim()).filter(Boolean).length; return out; };
      const pre = shape('desktop/preload.cjs', /(\w+): \(([^)]*)\) => call\(/g); const tau = shape('desktop-tauri/bridge.js', /(\w+): function \(([^)]*)\) \{ return call\(/g);
      const fakes = await p.evaluate(() => Object.fromEntries(Object.entries(window.__api).filter(([, v]) => typeof v === 'function').map(([k, v]) => [k, v.length])));
      const bad = Object.entries(fakes).filter(([k, n]) => (k in pre && pre[k] !== n) || (k in tau && tau[k] !== n));
      ok('every fake bridge method takes as many arguments as desktop/preload.cjs and desktop-tauri/bridge.js give it', !bad.length && 'writeTemp' in pre && pre.writeTemp === 2, { bad, writeTemp: [pre.writeTemp, tau.writeTemp] });
    }
    await p.evaluate(() => { window.addEventListener('kt-anime-watched', (e) => { (window.__watched ??= []).push(e.detail); }); });
    const playBtn = async () => { await p.click(`.task-card:has-text("Show - 03") button[aria-label="${playLabel}"]`); };
    await playBtn(); await p.waitForSelector('.ext-chooser .watch-choice', { timeout: 10000 }); await p.waitForTimeout(300);
    const ways = await p.$$eval('.ext-chooser .watch-choice', (e) => e.map((x) => x.dataset.way));
    const chooserText = await p.$eval('.ext-chooser', (e) => e.textContent);
    ok('default settings: one question only (no «Watch with» sheet before the chooser)', (await p.$$('.sheet')).length === 1);
    ok('PC chooser: exactly two ways, no player name in its lines (what happens is said instead)', ways.join() === 'app,out' && !/mpv|VLC|MPC|PotPlayer|IINA/.test(chooserText), { ways, chooserText });
    await shot(p, 'chooser-pc');
    await p.click('.ext-chooser .switch-row input'); await p.click('.ext-chooser [data-way="out"]');
    await p.waitForFunction(() => (window.__watched ?? []).length > 0, null, { timeout: 15000 });
    const pc1 = await p.evaluate(() => ({ calls: window.__calls, mem: JSON.parse(localStorage.getItem('kt.player.memory') || '{}'), set: JSON.parse(localStorage.getItem('kt.settings')), review: sessionStorage.getItem('kt.anime.reviewAsk'), watched: window.__watched }));
    const start = pc1.calls.find((c) => c[0] === 'extPlayerStart')[1]; const ro = pc1.calls.find((c) => c[0] === 'relayOpen')?.[1];
    ok('a file on this PC: a relay session of its own (the run\'s token never on another program\'s command line); a typed request, no program, no arguments', start.player === 'mpv' && start.target === 'http://127.0.0.1:3/r/tok/v/x' && ro?.file === '/videos/Made-up Show - 03.mkv' && !JSON.stringify(start).includes('RUNTOKEN') && !('exe' in start) && !('args' in start), { start, ro });
    const mk = pc1.mem['/videos/Made-up Show - 03.mkv'];
    ok('mpv told 1350 of 1440: the memory, watched once, the review note', mk && mk.duration === 1440 && mk.watched === true && pc1.watched.length === 1 && !!pc1.review, { mk, w: pc1.watched });
    ok('«always» kept as the outside way for files, on the computer only', pc1.set.extPlayers?.desktop?.local === 'out' && !pc1.set.extPlayers?.android);
    // Cancelling the chooser for a torrent started from the list: the stream let go at once.
    await p.reload(); await p.waitForSelector('.task-card'); await p.evaluate(() => { window.__calls = []; }); await streamFrom(p, 'Made-up Clip.mkv'); await p.waitForSelector('.ext-chooser'); await p.keyboard.press('Escape');
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'streamDone'), null, { timeout: 5000 }).catch(() => undefined);
    ok('chooser cancelled (a torrent from the list): its stream let go', await p.evaluate(() => window.__calls.some((c) => c[0] === 'streamDone' && c[1].id === 't1')));
    await p.goto(base); await p.waitForSelector('.task-card');
    // A player that does not tell (VLC) on the torrent stream, with a subtitle: through the relay; kept until ten quiet minutes.
    await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.extPcPlayer = 'vlc'; s.extPlayers.desktop.http = 'out'; localStorage.setItem('kt.settings', JSON.stringify(s)); });
    await p.reload(); await p.waitForSelector('.task-card'); await p.evaluate(() => { window.__calls = []; window.__relayReads = 0; window.__quietAfter = 2; window.__lastRead = () => Date.now() - 120e3; window.__waitedAt = Date.now(); });
    // (A video handed in with its subtitle — Android's «Kurokawa Player» path; any source with a subtitle would do.)
    await p.evaluate((port) => window.dispatchEvent(new CustomEvent('kt:play', { detail: { url: `http://127.0.0.1:${port}/media/clip.webm`, name: 'Handed in', subs: [`http://127.0.0.1:${port}/media/en.srt`] } })), web.address().port);
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'extPlayerStart'), null, { timeout: 15000 });
    const vs = await p.evaluate(() => window.__calls.find((c) => c[0] === 'extPlayerStart')[1]);
    const wt = await p.evaluate(() => window.__calls.find((c) => c[0] === 'writeTemp')?.[1]);
    ok('VLC with a subtitle: saved through writeTemp(name, text), its path an .srt/.ass copy, handed over', !!wt && /^kt-sub-[\w]+\.(srt|ass)$/.test(wt.name) && /First line/.test(wt.text) && /\/kurokawa-clip\/kt-sub-\w+\.(srt|ass)$/.test(vs.subs[0]?.at || ''), { wt, subs: vs.subs });
    ok('…the video through the relay (so its reads are seen)', vs.player === 'vlc' && vs.target === 'http://127.0.0.1:3/r/tok/v/x', vs);
    await p.waitForTimeout(12000);
    const kept = await p.evaluate(() => window.__calls.map((c) => c[0]));
    ok('…ended, the relay quiet for only two minutes: everything kept (a paused film in a single-instance player)', !kept.includes('relayClose') && !kept.includes('extPlayerDropSub') && kept.filter((x) => x === 'relayStatus').length >= 2, kept);
    await p.evaluate(() => { window.__lastRead = () => Date.now() - 11 * 60e3; });
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'relayClose'), null, { timeout: 12000 }).catch(() => undefined);
    const done2 = await p.evaluate(() => window.__calls.map((c) => c[0]));
    ok('…ten quiet minutes: the relay closed and the subtitle copy removed', done2.includes('relayClose') && done2.includes('extPlayerDropSub'), done2);
    await p.goto(base); await p.waitForSelector('.task-card');
    // «Open in another player» from inside the app's own player on a torrent: the stream kept; cancelling reopens the player there.
    if (media) {
      await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.extPlayers.desktop.torrent = 'app'; s.extPcPlayer = 'mpv'; localStorage.setItem('kt.settings', JSON.stringify(s)); });
      await p.reload(); await p.waitForSelector('.task-card'); await p.evaluate(() => { window.__calls = []; });
      await streamFrom(p, 'Made-up Clip.mkv'); await p.waitForSelector('.kt-player video.kt-video', { timeout: 15000 });
      await p.waitForFunction(() => document.querySelector('.kt-video').currentTime > 2.2, null, { timeout: 15000 });
      await p.click('.kt-top button[data-icon="more"]'); await p.getByRole('button', { name: OPENWITH }).click();
      await p.waitForSelector('.ext-chooser [data-way="out"]'); await p.keyboard.press('Escape');
      await p.waitForSelector('.kt-player video.kt-video', { timeout: 10000 });
      await p.waitForFunction(() => document.querySelector('.kt-video').currentTime > 2, null, { timeout: 10000 });
      ok('chooser cancelled from inside the app\'s player: it reopens where it was, the stream not let go', !(await p.evaluate(() => window.__calls.some((c) => c[0] === 'streamDone'))));
      await p.click('.kt-top button[data-icon="more"]'); await p.getByRole('button', { name: OPENWITH }).click();
      await p.waitForSelector('.ext-chooser [data-way="out"]'); await p.click('.ext-chooser [data-way="out"]');
      await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'extPlayerStart'), null, { timeout: 10000 });
      const atStart = await p.evaluate(() => window.__calls.map((c) => c[0]));
      ok('«Open in another player» on a torrent: the stream not let go when the app\'s player closed', !atStart.slice(0, atStart.indexOf('extPlayerStart')).includes('streamDone'), atStart);
      const st = await p.evaluate(() => window.__calls.find((c) => c[0] === 'extPlayerStart')[1]);
      const sro = await p.evaluate(() => window.__calls.find((c) => c[0] === 'relayOpen')?.[1]);
      ok('…mpv (it tells) on the torrent: the same live address through a relay session of its own, from where it was — no run token in anything handed to the player', st.player === 'mpv' && st.target === 'http://127.0.0.1:3/r/tok/v/x' && sro?.url === `http://127.0.0.1:${web.address().port}/media/clip.webm?t=RUNTOKEN` && !JSON.stringify(st).includes('RUNTOKEN') && st.start > 0, { st, sro });
      await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'streamDone'), null, { timeout: 15000 });
      ok('…and let go once that player ended', true);
      // A failure there: «Watch in the in-app player» gets the stream still alive (no streamDone before it reopens).
      await p.waitForSelector('.kt-player', { state: 'detached' }).catch(() => undefined);
      await p.goto(base); await p.waitForSelector('.task-card'); await p.evaluate(() => { window.__calls = []; window.__failStart = true; });
      await streamFrom(p, 'Made-up Clip.mkv'); await p.waitForSelector('.kt-player video.kt-video', { timeout: 15000 });
      await p.click('.kt-top button[data-icon="more"]'); await p.getByRole('button', { name: OPENWITH }).click();
      await p.waitForSelector('.ext-chooser [data-way="out"]'); await p.click('.ext-chooser [data-way="out"]');
      await p.waitForSelector('.ext-error', { timeout: 10000 }); await p.click('.ext-error .btn.primary');
      await p.waitForSelector('.kt-player video.kt-video', { timeout: 10000 });
      ok('a failed hand-over → «Watch in the in-app player»: the stream was not withdrawn', !(await p.evaluate(() => window.__calls.some((c) => c[0] === 'streamDone'))));
      await p.evaluate(() => { window.__failStart = false; });
      await p.click('.kt-top button[data-icon="back"]'); await p.waitForFunction(() => !document.querySelector('.kt-player'));
      // (Reloaded just after the app's player was open: the app goes back to the page it was opened from; then home.)
      await p.goto(base); await p.reload(); await p.waitForTimeout(500); await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.task-card');
    }
    // «Mark as watched?» for a tracked episode with VLC.
    await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.extPcPlayer = 'vlc'; localStorage.setItem('kt.settings', JSON.stringify(s)); localStorage.removeItem('kt.player.memory'); });
    await p.reload(); await p.waitForSelector('.task-card'); await p.evaluate(() => { window.__quietAfter = 0; window.__calls = []; });
    await p.evaluate(() => { window.addEventListener('kt-anime-watched', (e) => { (window.__watched ??= []).push(e.detail); }); });
    await playBtn(); await p.waitForSelector('.ext-mark', { timeout: 20000 }); await p.waitForTimeout(250); await shot(p, 'mark-pc');
    ok('VLC told nothing about a tracked episode: «Mark as watched?» naming it', /VLC/.test(await p.$eval('.ext-mark', (e) => e.textContent)));
    const asked = await p.evaluate(() => window.__calls.map((c) => c[0]));
    ok('…the relay session closed before the question is asked (an unanswered question holds nothing)', asked.includes('relayOpen') && asked.includes('relayClose'), asked);
    await p.click('.ext-mark .btn.primary'); await p.waitForFunction(() => (window.__watched ?? []).length >= 1);
    await p.waitForTimeout(300);
    ok('…yes: watched once', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.player.memory'))['/videos/Made-up Show - 03.mkv']?.watched === true && window.__watched.length === 1));
    // A program that fails: the error, the in-app player one tap away, «Choose a program…» — buttons of one width.
    await p.evaluate(() => { window.__failStart = true; }); await playBtn();
    await p.waitForSelector('.ext-error', { timeout: 10000 }); await p.waitForTimeout(250); await shot(p, 'error-pc');
    const widths = await p.$$eval('.ext-error .btn', (e) => e.map((b) => Math.round(b.getBoundingClientRect().width)));
    ok('a program that fails: the error, «Watch in the in-app player» and «Choose a program…», of one width', widths.length === 2 && widths[0] === widths[1] && /spawn ENOENT/.test(await p.$eval('.ext-error-why', (e) => e.textContent)), widths);
    await p.click('.ext-error .btn.primary'); await p.waitForSelector('.kt-player, .player-view', { timeout: 15000 });
    ok('…one tap: the in-app player opens the same video', true);
    // Nothing found on this PC: the first use asks for a program; a refused pick says why.
    await p.goto(base); await p.waitForSelector('.task-card');
    await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); delete s.extPcPlayer; localStorage.setItem('kt.settings', JSON.stringify(s)); });
    await p.reload(); await p.waitForSelector('.task-card'); await p.evaluate(() => { window.__chosen = null; window.__noPlayers = true; window.__calls = []; window.__chooseFails = 'kt-ext:batch'; });
    await playBtn(); await p.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /\.bat/.test(t.textContent)), null, { timeout: 10000 }).catch(() => undefined);
    ok('a .bat picked: said plainly (no shell is run), not swallowed', await p.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /\.bat/.test(t.textContent))));
    await p.evaluate(() => { window.__chooseFails = ''; window.__calls = []; });
    await playBtn(); await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'extPlayerStart'), null, { timeout: 15000 });
    const first = await p.evaluate(() => ({ calls: window.__calls, set: JSON.parse(localStorage.getItem('kt.settings')) }));
    ok('nothing found: the shell\'s dialog first, then «chosen» started (the path stays with the shell)', first.calls.some((c) => c[0] === 'extPlayerChoose') && first.calls.find((c) => c[0] === 'extPlayerStart')[1].player === 'chosen' && first.set.extPcPlayer === 'chosen' && !JSON.stringify(first.set).includes('/opt/my player'));
    // Settings → Player on a computer.
    await p.goto(base + '#/settings'); await p.reload(); await p.evaluate(() => { window.__chosen = { path: '/opt/my player/play', args: '--fs {url}', there: true }; });
    await p.goto(base + '#/');
    await p.goto(base + '#/settings'); await p.waitForSelector('.settings-nav .chip', { timeout: 15000 }); await p.evaluate(() => { const c = [...document.querySelectorAll('.settings-nav .chip')].find((x) => /player/.test(x.dataset.sec || '')); c?.click(); }); await p.waitForSelector('.ext-settings .ext-pc-pick', { timeout: 15000 });
    const pcs = await p.evaluate(() => ({ rows: [...document.querySelectorAll('.ext-settings [data-service]')].map((b) => b.dataset.service), args: !!document.querySelector('.ext-args') }));
    ok('PC settings: the four kinds of video, «Player on this PC», the chosen program\'s arguments line', pcs.rows.join() === 'torrent,online,http,local' && pcs.args, pcs);
    await p.$eval('.ext-settings', (e) => (e.previousElementSibling ?? e).scrollIntoView({ block: 'start' })); await p.waitForTimeout(200); await shot(p, 'settings-pc');
    await p.click('.ext-settings [data-service="online"]'); await p.waitForTimeout(250);
    const opts = await p.$$eval('.sheet:last-of-type button, .sheet:last-of-type [role="option"], .sheet:last-of-type label', (e) => e.map((x) => x.textContent.trim()).filter(Boolean));
    ok('…a kind of video: ask, the in-app player, «A player on this PC» — no player names', opts.some((x) => /PC|الحاسوب/.test(x)) && !opts.some((x) => /mpv|VLC|MX/.test(x)), opts);
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    await p.click('.ext-settings .ext-pc-pick'); await p.waitForTimeout(250);
    const pcOpts = await p.$$eval('.sheet:last-of-type button, .sheet:last-of-type label', (e) => e.map((x) => x.textContent.trim()).filter(Boolean));
    ok('«Player on this PC»: Automatic (mpv), mpv, VLC, the chosen program, «Choose a program…»', pcOpts.some((x) => /mpv\)/.test(x)) && pcOpts.some((x) => x === 'VLC') && pcOpts.some((x) => x === 'play') && pcOpts.some((x) => /…/.test(x)), pcOpts);
    await p.keyboard.press('Escape');
    await p.close();
  }
  /* ----- the phone ----- */
  {
    const p = await br.newPage({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); p.on('pageerror', (e) => errors.push('phone: ' + e.message));
    await p.addInitScript(([lang, tasks]) => {
      localStorage.setItem('kr.lang', lang); if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime'] }));
      window.__calls = []; window.__answer = { code: -1, action: 'com.mxtech.intent.result.VIEW', extras: { position: 1430000, duration: 1440000, end_by: 'playback_completion' } };
      const api = {
        addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks }), streamUrl: async (o) => ({ url: `http://127.0.0.1:5/stream/${o.id}/${o.fileIndex}` }), localUrl: async (o) => ({ url: `http://127.0.0.1:5/file?p=${encodeURIComponent(o.path)}` }),
        openPlayerApp: async (o) => { window.__calls.push(['openPlayerApp', o]); if (window.__fail) throw new Error('not installed'); return window.__answer; },
        relayOpen: async (o) => { window.__calls.push(['relayOpen', o]); return { token: 'tk', url: 'http://127.0.0.1:5/r/tk/v/x', subs: [] }; }, relayClose: async (o) => { window.__calls.push(['relayClose', o]); },
      };
      const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
    }, [LANG, [task({ id: 'p1', kind: 'torrent', name: 'Made-up Show - 05.mkv', dir: '/sdcard/Download', state: 'downloading', engine: 'native', meta: { ...META, episode: 5 } })]]);
    await p.goto(base); await p.waitForSelector('.task-card', { timeout: 20000 });
    const home = async (answer) => { if (!(await p.$('.task-card'))) { await p.goto(base); await p.waitForSelector('.task-card'); } await p.evaluate((a) => { localStorage.removeItem('kt.player.memory'); window.__watched = []; window.__calls = []; if (a) window.__answer = a; if (!window.__l) { window.__l = true; window.addEventListener('kt-anime-watched', (e) => { (window.__watched ??= []).push(e.detail); }); } }, answer); };
    const play = async () => { await streamFrom(p, 0); };
    await home(null); await play(); await p.waitForSelector('.ext-chooser .watch-choice', { timeout: 10000 }); await p.waitForTimeout(300);
    const ways = await p.$$eval('.ext-chooser .watch-choice', (e) => e.map((x) => x.dataset.way));
    ok('phone chooser: exactly two ways — the in-app player and «Another app»; no player names', ways.join() === 'app,out' && !/VLC|MX|mpv|Just/.test(await p.$eval('.ext-chooser', (e) => e.textContent)), ways);
    await shot(p, 'chooser-phone');
    await p.click('.ext-chooser [data-way="out"]'); await p.waitForFunction(() => (window.__watched ?? []).length > 0, null, { timeout: 15000 });
    const ph = await p.evaluate(() => ({ calls: window.__calls, watched: window.__watched }));
    const it = ph.calls.find((c) => c[0] === 'openPlayerApp')[1];
    ok('the phone\'s own list (no package named): the torrent\'s stream as it is, the union of extras', !('pkg' in it) && it.data === 'http://127.0.0.1:5/stream/p1/0' && it.extras.some((e) => e.k === 'return_result') && it.extras.find((e) => e.k === 'title').v === 'Made-up Show - 05.mkv', it);
    ok('an MX-style answer «played to the end»: watched once', ph.watched.length === 1 && ph.watched[0].ep === 5);
    // mpv-android's plain OK at the end.
    await home({ code: -1, action: 'is.xyz.mpv.MPVActivity.result', extras: {} });
    await play(); await p.waitForSelector('.ext-chooser [data-way="out"]'); await p.click('.ext-chooser [data-way="out"]');
    await p.waitForFunction(() => (window.__watched ?? []).length > 0, null, { timeout: 15000 }).catch(async (e) => { console.log('dbg', JSON.stringify(await p.evaluate(() => ({ c: window.__calls, w: window.__watched, sheet: document.querySelector('.sheet')?.textContent, toast: document.querySelector('.toast')?.textContent })))); throw e; });
    ok('mpv-android\'s plain OK with nothing: ended, watched, no question', !(await p.$('.ext-mark')));
    // Nothing known told: «Mark as watched?».
    await home({ code: 0, action: '', extras: {} });
    await play(); await p.waitForSelector('.ext-chooser [data-way="out"]'); await p.click('.ext-chooser [data-way="out"]');
    await p.waitForSelector('.ext-mark', { timeout: 10000 }); await p.waitForTimeout(250); await shot(p, 'mark-phone');
    await p.click('.ext-mark .btn.tonal'); await p.waitForTimeout(300);
    ok('an app that told nothing: «Mark as watched?»; «Not yet» → not watched', await p.evaluate(() => (window.__watched ?? []).length === 0));
    // Settings → Player on a phone.
    await p.goto(base + '#/settings'); await p.waitForTimeout(800);
    await p.evaluate(() => { const c = document.getElementById('player'); if (c && c.tagName === 'DETAILS') c.open = true; c?.querySelector('summary, h3')?.click?.(); });
    await p.waitForSelector('.ext-settings', { timeout: 15000 });
    ok('phone settings: the four kinds of video; no computer player row, no arguments', (await p.$$('.ext-settings [data-service]')).length === 4 && !(await p.$('.ext-pc-pick')) && !(await p.$('.ext-args')));
    await p.$eval('.ext-settings', (e) => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(200); await shot(p, 'settings-phone');
    // The outside way remembered, the app missing: the error with the in-app player.
    await p.goto(base); await p.waitForSelector('.task-card');
    await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.extPlayers = { android: { torrent: 'out' } }; localStorage.setItem('kt.settings', JSON.stringify(s)); });
    await p.reload(); await p.waitForSelector('.task-card'); await p.evaluate(() => { window.__fail = true; });
    await play(); await p.waitForSelector('.ext-error', { timeout: 10000 }); await p.waitForTimeout(250); await shot(p, 'error-phone');
    ok('phone: the remembered way used without asking; no app → the error with the in-app player and «Pick another app»', (await p.$$('.ext-error .btn')).length === 2);
    await p.close();
  }
  await br.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
  ok('no page errors', errors.length === 0, errors);
}

(async () => {
  logic();
  await shell();
  await relay();
  await page();
  console.log(fails ? `${fails} FAILED` : 'all ok'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e && e.stack || e); process.exit(1); });
