// node tests/aria2poll.cjs: the remote aria2's poller with fake timers and an RPC that answers slowly — pokes while a
// poll is under way (a pause, a resume, an add) keep one poller, not one more each; with no one listening any more,
// polling stops, even when a poll was under way then.
const path = require('node:path');
(async () => {
  const esbuild = require(require.resolve('esbuild', { paths: [path.join(__dirname, '..'), path.join(__dirname, '..', '..', '..')] }));
  const r = await esbuild.build({ stdin: { contents: "export { Aria2Engine } from './src/engine/aria2';", resolveDir: path.join(__dirname, '..'), loader: 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'neutral', logLevel: 'silent' });
  // Fake timers: a queue run by hand, time moved on by `run(ms)`.
  let now = 0, seq = 0; const timers = new Map();
  const setTimeout_ = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; }; const clearTimeout_ = (id) => { timers.delete(id); };
  global.window = { setTimeout: setTimeout_, clearTimeout: clearTimeout_ }; global.setTimeout = setTimeout_; global.clearTimeout = clearTimeout_;
  global.localStorage = { getItem: () => null, setItem: () => {} };
  const flush = () => new Promise((res) => setImmediate(res));
  const run = async (ms) => { const end = now + ms; for (;;) { await flush(); const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; timers.delete(due[0]); now = Math.max(now, due[1].at); due[1].fn(); } now = end; await flush(); };
  const m = { exports: {} }; new Function('module', 'exports', 'require', r.outputFiles[0].text)(m, m.exports, require);
  // An RPC whose answers come back only when released (a poll under way), counting the polls.
  let polls = 0; const pending = []; const release = async () => { while (pending.length) pending.shift()(); await flush(); await flush(); };
  const rpc = { call: (method) => { if (method === 'tellActive') polls++; if (method === 'pause' || method === 'unpause') return Promise.resolve('ok'); return new Promise((res) => pending.push(() => res(method === 'tellActive' ? [{ gid: 'g1', status: 'active', totalLength: '100', completedLength: '10', uploadLength: '0', downloadSpeed: '5', uploadSpeed: '0', files: [], dir: '/d' }] : []))); } };
  const eng = new m.exports.Aria2Engine(rpc); let seen = 0; let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (x === undefined ? '' : ': ' + x)); if (!c) fails++; };
  const off = eng.onChange(() => { seen++; });
  await run(0);   // the first poll asked, not answered yet
  await eng.pause('g1'); await eng.resume('g1'); await eng.pause('g1');   // three pokes while it is under way
  await release(); await run(0); await release();
  polls = 0; for (let s = 0; s < 10; s++) { await run(1000); await release(); }
  ok('one poller after pokes during a poll (polls in 10 s at 1 a second)', polls <= 11, polls);
  // No one listening, a poll under way at that moment: no more polls.
  await run(1000); off(); await release(); polls = 0; for (let s = 0; s < 10; s++) { await run(1000); await release(); }
  ok('no polls after the last listener left', polls === 0, polls);
  console.log(fails ? 'FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
})();
