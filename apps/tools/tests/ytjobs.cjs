// node tests/ytjobs.cjs: the computer's yt-dlp (desktop/ytdlp.cjs, Electron) with stand-ins only — child_process and
// Electron's net faked, a temp folder for the app's data; no real yt-dlp, no network:
// - the look: one -J run, its answer kept (an id handed back), lighter retries, a browser's sign-in passed to the look too;
// - a sign-in kept per site: only that site's cookies, a file only this user may read, given as --cookies (a browser's
//   --cookies-from-browser then dropped), listed and removed — values never in the args' text but the file's path;
// - the download reuses the look (--load-info-json, no address) and, when that run fails, runs again at once with the address;
// - at most N video jobs at once, the rest «queued» and started in order; pause/remove keep working;
// - self-healing: an extractor error → one update (a fake newer release) → one more try.
const Module = require('node:module'); const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os'); const { EventEmitter } = require('node:events');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktyt-')); let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const spawned = []; const execs = []; let version = '2026.01.01';
const RAW = JSON.stringify({ id: 'abc', title: 'Made-up clip', extractor_key: 'Youtube', webpage_url: 'https://www.youtube.com/watch?v=abc', formats: [{ format_id: '22', url: 'x', vcodec: 'avc1', acodec: 'mp4a', height: 720 }] });
const cp = { execFile: (bin, args, opts, cb) => { if (typeof opts === 'function') cb = opts; if (args[0] === '--version') return cb(null, version + '\n'); execs.push(args); cb(null, RAW, ''); },
  spawn: (bin, args) => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => { setTimeout(() => p.emit('close', null), 1); }; spawned.push({ args, p }); return p; } };
// (A fake release: its tag, its sums file without the asset — no digest to check — and a few bytes as «the program».)
const net = { fetch: async (u) => {
  if (/releases\/latest$/.test(u)) return { ok: true, json: async () => ({ tag_name: '2026.11.01' }) };
  if (/SHA2-256SUMS/.test(u)) return { ok: true, text: async () => '' };
  let sent = false; return { ok: true, url: u, headers: { get: () => '4' }, body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array([1, 2, 3, 4]) })) }) } };
} };
const load = Module._load; Module._load = function (req, ...rest) { if (req === 'electron') return { app: { getPath: () => tmp }, net }; if (req === 'node:child_process') return cp; return load.call(this, req, ...rest); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const Y = require(path.join(__dirname, '..', 'desktop', 'ytdlp.cjs')); fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true }); fs.writeFileSync(Y.binPath(), 'x');
  // The look.
  const got = await Y.info('https://www.youtube.com/watch?v=abc', { cookiesFromBrowser: 'firefox' }); const a0 = execs[0];
  ok('the look gets a shaped answer with an id', got.kind === 'video' && /^[0-9a-f]{16}$/.test(got.infoId), got);
  ok('its answer is kept in the app\'s folder', fs.existsSync(path.join(tmp, 'video-info', `${got.infoId}.json`)));
  ok('lighter retries: 15 s a try, one extractor retry', a0.join(' ').includes('--socket-timeout 15') && a0.join(' ').includes('--extractor-retries 1'), a0);
  ok('the browser sign-in chosen in Settings goes to the look too', a0.join(' ').includes('--cookies-from-browser firefox'));
  // A sign-in kept per site.
  const cookies = [{ domain: '.youtube.com', path: '/', name: 'SID', value: 'made-up-value-1', secure: true, httpOnly: true, expirationDate: 2000000000 }, { domain: 'www.youtube.com', hostOnly: true, path: '/', name: 'PREF', value: 'f1=1', secure: false }, { domain: '.example.org', path: '/', name: 'OTHER', value: 'not-this-site' }];
  const r = await Y.saveCookies('https://music.youtube.com/watch?v=x', cookies); const f = path.join(tmp, 'video-cookies', 'youtube.com.txt');
  ok('the site and the count of its cookies', r.site === 'youtube.com' && r.count === 2, r);
  const text = fs.readFileSync(f, 'utf8');
  ok('a Netscape cookie file of that site only', /^# Netscape HTTP Cookie File/.test(text) && text.includes('#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tmade-up-value-1') && text.includes('www.youtube.com\tFALSE\t/\tFALSE\t0\tPREF') && !text.includes('example.org'));
  if (process.platform !== 'win32') ok('readable by this user alone (0600)', (fs.statSync(f).mode & 0o777) === 0o600, (fs.statSync(f).mode & 0o777).toString(8));
  ok('listed', JSON.stringify(Y.listCookies().map((x) => [x.site, x.count])) === JSON.stringify([['youtube.com', 2]]));
  execs.length = 0; await Y.info('https://youtu.be/abc', { cookiesFromBrowser: 'firefox' }); const a1 = execs[0];
  ok('the look of that site uses the kept sign-in (--cookies <its file>), the browser\'s dropped', a1.includes('--cookies') && a1[a1.indexOf('--cookies') + 1] === f && !a1.includes('--cookies-from-browser'), a1);
  ok('no cookie value in the arguments', !a1.join(' ').includes('made-up-value-1'));
  // The download reuses the look, and falls back to the address at once when that fails.
  const jobs = new Y.VideoJobs(() => {}); const dir = path.join(tmp, 'D'); const args = ['-f', '22', '--no-playlist', '-o', '%(title)s.%(ext)s'];
  const t = await jobs.add({ url: 'https://www.youtube.com/watch?v=abc', dir, title: 'T', args, infoId: got.infoId }); await sleep(30);
  let s0 = spawned[0].args; ok('the job reads the kept look (--load-info-json), not the site', s0.includes('--load-info-json') && s0[s0.indexOf('--load-info-json') + 1] === path.join(tmp, 'video-info', `${got.infoId}.json`) && !s0.includes('https://www.youtube.com/watch?v=abc'), s0);
  ok('and the site\'s kept sign-in', s0.includes('--cookies'));
  spawned[0].p.stderr.emit('data', 'ERROR: [youtube] abc: Requested format is not available\n'); spawned[0].p.emit('close', 1); await sleep(30);
  const s1 = spawned[1] && spawned[1].args; ok('a failed reuse runs again at once with the address', !!s1 && !s1.includes('--load-info-json') && s1[s1.length - 1] === 'https://www.youtube.com/watch?v=abc' && t.state === 'downloading', s1);
  spawned[1].p.emit('close', 0); await sleep(10); ok('then done', t.state === 'done', t.state);
  ok('an id that is a path is refused', (await jobs.add({ url: 'https://u/v', dir, args, infoId: '../../etc/passwd', paused: true })).meta.infoId === undefined);
  ok('a stale look is not reused', (() => { const p = path.join(tmp, 'video-info', `${got.infoId}.json`); const old = (Date.now() - 6 * 60000) / 1000; fs.utimesSync(p, old, old); return Y.freshInfo(got.infoId) === null; })());
  // The queue.
  spawned.length = 0; const q = new Y.VideoJobs(() => {}); q.setMax(2); const ts = [];
  for (let i = 0; i < 4; i++) ts.push(await q.add({ url: `https://www.youtube.com/watch?v=q${i}`, dir, title: `Q${i}`, args }));
  await sleep(30); ok('two run, two wait', spawned.length === 2 && ts.filter((x) => x.state === 'queued').length === 2, ts.map((x) => x.state));
  q.pause(ts[3].id); spawned[0].p.emit('close', 0); await sleep(30);
  ok('one ends → the oldest waiting starts; a paused one does not', spawned.length === 3 && ts[2].state === 'downloading' && ts[3].state === 'paused', ts.map((x) => x.state));
  q.resume(ts[3].id); await sleep(20); ok('resumed while full: it waits', ts[3].state === 'queued', ts[3].state);
  q.remove(ts[1].id, false); await sleep(30); ok('removed → the waiting one starts', ts[3].state === 'downloading' && spawned.length === 4, ts.map((x) => x.state));
  // Self-healing.
  spawned.length = 0; const hj = new Y.VideoJobs(() => {}); const ht = await hj.add({ url: 'https://www.youtube.com/watch?v=h', dir, title: 'H', args }); await sleep(30);
  spawned[0].p.stderr.emit('data', 'ERROR: [youtube] h: Unable to extract nsig function code; please report this issue\n'); version = '2026.01.01';
  const was = version; setTimeout(() => { version = '2026.11.01'; }, 5); spawned[0].p.emit('close', 1); await sleep(200);
  ok('an extractor error → a newer yt-dlp fetched → tried again once', spawned.length === 2 && ht.meta.healTried === true && !!ht.meta.healed, { n: spawned.length, meta: ht.meta, was });
  spawned[1].p.stderr.emit('data', 'ERROR: [youtube] h: Unable to extract nsig function code\n'); spawned[1].p.emit('close', 1); await sleep(100);
  ok('…and only once: the second failure is said', ht.state === 'failed' && spawned.length === 2 && /Unable to extract/.test(ht.error), [ht.state, ht.error]);
  // The pushes: a burst of phases inside one 250 ms window — each phase still sent, in order; progress merged.
  { spawned.length = 0; const seen = []; let sends = 0; const pj = new Y.VideoJobs(Y.pusher(() => { sends++; const x = pj.list().find((y) => y.source.url === 'https://www.youtube.com/watch?v=p'); if (x && x.meta && x.meta.phase && seen[seen.length - 1] !== x.meta.phase) seen.push(x.meta.phase); }));
    await pj.add({ url: 'https://www.youtube.com/watch?v=p', dir, title: 'P', args }); await sleep(30); const pp = spawned[0].p; const say = (l) => pp.stdout.emit('data', l + '\n');
    sends = 0; say('[download] Destination: /x/P.f137.mp4'); for (let i = 1; i < 30; i++) say(`KT|${i * 1000}|100000|NA|1000|5|${i}|40|/x/P.f137.mp4`); say('[download] Destination: /x/P.f140.m4a'); say('[Merger] Merging formats into "/x/P.mp4"'); say('[EmbedThumbnail] x');
    ok('a burst of phases in one window: video, audio, merge, embed — each sent, in order', JSON.stringify(seen.slice(-4)) === JSON.stringify(['video', 'audio', 'merge', 'embed']), seen);
    ok('…progress merged, not one push a line', sends <= 6, sends); pp.emit('close', 0); await sleep(300); }
  ok('removed sign-in: overwritten and gone', Y.removeCookies('youtube.com') && !fs.existsSync(f));
  console.log(fails ? `${fails} failed` : 'all passed'); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})();
