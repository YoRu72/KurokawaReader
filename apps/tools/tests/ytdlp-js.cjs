// The computer's yt-dlp is given a JavaScript runtime — the app's own Node (Electron's program with
// ELECTRON_RUN_AS_NODE) — without which YouTube reads nothing since yt-dlp 2025.11; a yt-dlp older than the option
// (one of the user's own) is not given it.
const Module = require('node:module'); const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktjs-')); const errors = [];
const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
let version = '2026.10.10'; const calls = [];
const cp = { execFile: (bin, args, opts, cb) => { if (typeof opts === 'function') { cb = opts; opts = {}; } calls.push({ args, env: opts.env }); if (args[0] === '--version') return cb(null, version + '\n'); cb(null, JSON.stringify({ id: 'x', title: 'A video', formats: [], extractor_key: 'Youtube', webpage_url: args[args.length - 1] })); }, spawn: () => { throw new Error('not here'); } };
const load = Module._load; Module._load = function (req, ...rest) { if (req === 'electron') return { app: { getPath: () => tmp }, net: { fetch: async () => { throw new Error('offline'); } } }; if (req === 'node:child_process' || req === 'child_process') return cp; return load.call(this, req, ...rest); };
(async () => {
  const Y = require(path.join(__dirname, '..', 'desktop', 'ytdlp.cjs'));
  fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true }); fs.writeFileSync(Y.binPath(), 'x');
  await Y.info('https://www.youtube.com/watch?v=abc').catch(() => undefined);
  let j = calls.find((c) => c.args[0] === '-J');
  const at = j ? j.args.indexOf('--js-runtimes') : -1;
  check('yt-dlp asked with the app\'s Node as its JavaScript runtime', at >= 0 && j.args[at + 1] === `node:${process.execPath}` && j.env && j.env.ELECTRON_RUN_AS_NODE === '1', j && j.args);
  // An older yt-dlp of the user's own: no option it would refuse.
  calls.length = 0; version = '2025.06.30'; const own = path.join(tmp, 'own-yt-dlp'); fs.writeFileSync(own, 'xx'); Y.setCustomPath(own);
  await Y.info('https://www.youtube.com/watch?v=abc').catch(() => undefined);
  j = calls.find((c) => c.args[0] === '-J');
  check('an older yt-dlp is not given the option', !!j && !j.args.includes('--js-runtimes'), j && j.args);
  fs.rmSync(tmp, { recursive: true, force: true });
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
