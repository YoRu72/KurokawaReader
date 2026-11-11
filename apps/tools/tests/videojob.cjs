// node tests/videojob.cjs: the computer's video job (desktop/ytdlp.cjs) with yt-dlp stubbed: the page's argument list is vetted and run in the
// download folder (-P) with nothing else from the page; a tampered list is refused before anything starts; a task without a list runs the
// older way; and the output lines become the phase (video, audio, merging, converting, embedding), one bar over both streams, and fragment counts.
const Module = require('node:module'); const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os'); const { EventEmitter } = require('node:events');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktjob-')); let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const spawned = []; const procs = [];
const cp = { execFile: (bin, args, opts, cb) => { if (typeof opts === 'function') cb = opts; if (args[0] === '--version') return cb(null, '2026.10.10\n'); cb(null, '{}', ''); },
  spawn: (bin, args) => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {}; spawned.push({ bin, args }); procs.push(p); return p; } };
const load = Module._load; Module._load = function (req, ...rest) { if (req === 'electron') return { app: { getPath: () => tmp }, net: { fetch: async () => { throw new Error('offline'); } } }; if (req === 'node:child_process') return cp; return load.call(this, req, ...rest); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const Y = require(path.join(__dirname, '..', 'desktop', 'ytdlp.cjs')); fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true }); fs.writeFileSync(Y.binPath(), 'x');
  let pushes = 0; const jobs = new Y.VideoJobs(() => { pushes++; }); const dir = path.join(tmp, 'Downloads');
  const args = ['-f', 'bv*+ba/b', '-x', '--audio-format', 'mp3', '--no-playlist', '-o', '%(title)s [%(id)s].%(ext)s', '-N', '4'];
  const t = await jobs.add({ url: 'https://www.youtube.com/watch?v=abc', dir, title: 'T', args, expect: 300e6, audioFmt: 'MP3' }); await sleep(50);
  const a = spawned[0] && spawned[0].args; ok('the job started', !!a);
  ok('the page\'s list runs as it is', a && args.every((x, i) => a[a.indexOf('-f') + i] === x || a.includes(x)));
  ok('the download folder is given by this side (-P), the page names no path', a && a[a.indexOf('-P') + 1] === dir && a.indexOf('-P') < a.indexOf('-f'));
  ok('only one --no-playlist, none added by the older way', a && a.filter((x) => x === '--no-playlist').length === 1);
  ok('the progress template has the fragment fields', a && /fragment_index.*fragment_count.*info\.filename/.test(a[a.indexOf('--progress-template') + 1]));
  const p = procs[0]; const say = (l) => p.stdout.emit('data', l + '\n');
  say('[download] Destination: /x/T.f137.mp4'); ok('phase: video', t.meta.phase === 'video', t.meta.phase);
  say('KT|50000000|100000000|NA|2000000|25|7|40|/x/T.f137.mp4'); ok('fragments reported', t.meta.frag === 7 && t.meta.frags === 40, t.meta);
  ok('speed, eta and bytes of the stream', t.downSpeed === 2e6 && t.eta === 25 && t.done === 5e7);
  say('KT|100000000|100000000|NA|2000000|0|40|40|/x/T.f137.mp4'); say('[download] Destination: /x/T.f140.m4a');
  ok('phase: audio, and the first stream counted into one bar', t.meta.phase === 'audio' && !('frag' in t.meta === false && t.meta.frag > 0));
  say('KT|10000000|20000000|NA|1000000|10|NA|NA|/x/T.f140.m4a');
  ok('one bar over both streams (not starting again)', t.done === 110e6 && t.total === 300e6, [t.done, t.total]);
  ok('no fragment counts for a plain stream', !t.meta.frag && !t.meta.frags);
  say('[Merger] Merging formats into "/x/T.mkv"'); ok('phase: merging', t.meta.phase === 'merge' && t.downSpeed === 0);
  say('[ExtractAudio] Destination: /x/T.mp3'); ok('phase: converting to MP3', t.meta.phase === 'convert MP3', t.meta.phase);
  say('[EmbedThumbnail] ffmpeg: Adding thumbnail'); ok('phase: embedding', t.meta.phase === 'embed');
  p.emit('close', 0); await sleep(20); ok('done', t.state === 'done');
  // throttle: a flood of lines does not push every one
  const before = pushes; const t2 = await jobs.add({ url: 'https://www.youtube.com/watch?v=def', dir, title: 'U', args: ['-f', 'ba/b', '--no-playlist', '-o', 'x.%(ext)s'] }); await sleep(30); const p2 = procs[1];
  for (let i = 0; i < 500; i++) p2.stdout.emit('data', `KT|${i}|1000|NA|10|1|NA|NA|/x/U.mp4\n`);
  ok('the page is told far less often than the lines come (throttled)', pushes - before < 20, pushes - before);
  // tampered list: nothing starts
  const n = spawned.length; const t3 = await jobs.add({ url: 'https://www.youtube.com/watch?v=ghi', dir, title: 'V', args: ['-f', 'b', '--exec', 'rm -rf /'] }); await sleep(30);
  ok('a list with --exec is refused, nothing is spawned', spawned.length === n && t3.state === 'failed' && /invalid/.test(t3.error), [spawned.length, t3.state, t3.error]);
  // the older way (no list): as before
  const t4 = await jobs.add({ url: 'https://www.youtube.com/watch?v=jkl', dir, title: 'W', format: '137+140', container: 'mp4' }); await sleep(30);
  const o = spawned[n] && spawned[n].args; ok('a task without a list still runs the older way (-o, --no-playlist, -f)', !!o && o.includes('--no-playlist') && o.includes('-o') && o.includes('-f') && !o.includes('-P'), o);
  fs.rmSync(tmp, { recursive: true, force: true }); Module._load = load;
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
