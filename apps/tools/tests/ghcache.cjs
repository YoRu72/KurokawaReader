// node tests/ghcache.cjs: the shell's GitHub calls (desktop/gh.cjs), Electron's net faked: an answer kept ten minutes in
// memory (no second request), then asked conditionally with the kept ETag — a 304 answered from the kept body —, every
// request with a time limit, the bodies kept across a restart. No network.
const Module = require('node:module'); const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktgh-')); let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const calls = []; let changed = false;
const net = { fetch: async (u, o) => { calls.push({ u, inm: o.headers['if-none-match'], signal: !!o.signal }); if (o.headers['if-none-match'] === '"v1"' && !changed) return { status: 304, ok: false, headers: { get: () => '"v1"' } }; return { status: 200, ok: true, json: async () => ({ tag_name: changed ? '2026.11.02' : '2026.11.01' }), headers: { get: (k) => (k === 'etag' ? (changed ? '"v2"' : '"v1"') : null) } }; } };
const load = Module._load; Module._load = function (req, ...rest) { if (req === 'electron') return { app: { getPath: () => tmp }, net }; return load.call(this, req, ...rest); };
(async () => {
  const U = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
  let G = require(path.join(__dirname, '..', 'desktop', 'gh.cjs'));
  ok('the first answer', (await G.ghJson(U)).tag_name === '2026.11.01' && calls.length === 1 && calls[0].signal);
  await G.ghJson(U); ok('within ten minutes: from memory, no request', calls.length === 1, calls.length);
  G.forget(U); ok('asked again: conditionally, the 304 answered from the kept body', (await G.ghJson(U)).tag_name === '2026.11.01' && calls[1].inm === '"v1"', calls[1]);
  delete require.cache[require.resolve(path.join(__dirname, '..', 'desktop', 'gh.cjs'))]; G = require(path.join(__dirname, '..', 'desktop', 'gh.cjs'));
  changed = true; ok('after a restart: the kept ETag sent, a new release read', (await G.ghJson(U)).tag_name === '2026.11.02' && calls[2].inm === '"v1"', calls[2]);
  console.log(fails ? `${fails} failed` : 'all passed'); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})();
