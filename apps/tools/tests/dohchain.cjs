// DNS over HTTPS's rules, one table and one set of cases for every copy (0.21 P9):
//  - core/kt-core/src/doh-providers.txt against its copies: desktop/dohchain.cjs (Electron), KrDoh.java (phone),
//    src/dohProviders.ts (the settings page) — id, name, address, bootstrap addresses, JSON form, filters;
//  - core/kt-core/src/doh-cases.txt (read by kt-core's dohchain.rs tests and tests/native/doh/CT.java too) run on
//    Electron's twin, and the address check on the page's twin;
//  - Electron's chain against loopback resolvers with made-up names (never a real one): POST application/dns-message
//    by the bootstrap address (the system's lookup never asked), hostile answers, failover, the health probe and the
//    automatic pick, «no such name», the no-silent-fallback rule and the opt-in, the cache's caps, the user's own
//    resolver found through the public ones, a magnet's UDP trackers, the proxy aria2 is pointed at (CONNECT and GET,
//    its password), aria2's all-proxy; and nothing left open afterwards.
const fs = require('node:fs'); const path = require('node:path'); const http = require('node:http'); const net = require('node:net'); const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'desktop', 'dohchain.cjs'));
let fails = 0; const ok = (what, c, x) => { console.log(c ? 'ok  ' : 'FAIL', what, c ? '' : JSON.stringify(x ?? '')); if (!c) fails++; };

// ---------- the one table and its copies ----------
const txt = fs.readFileSync(path.join(ROOT, 'core', 'kt-core', 'src', 'doh-providers.txt'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split('|'));
const table = txt.map(([id, label, url, ips, json, filters]) => ({ id, label, url, ips: ips.split(','), json: json === 'json', filters }));
ok(`the table has ${table.length} resolvers, none needing an account (no Mullvad, discontinued)`, table.length === 10 && !table.some((p) => p.id === 'mullvad'));
ok('Electron\'s copy is the table', JSON.stringify(D.PROVIDERS) === JSON.stringify(table), D.PROVIDERS);
const java = fs.readFileSync(path.join(ROOT, 'native', 'android', 'KrDoh.java'), 'utf8');
const jrows = [...java.matchAll(/new Resolver\("([^"]+)", "([^"]+)", "([^"]+)", new String\[\] \{ ([^}]*) \}, (true|false), "([^"]+)"\)/g)].map((m) => ({ id: m[1], label: m[2], url: m[3], ips: m[4].split(',').map((s) => s.trim().replace(/"/g, '')), json: m[5] === 'true', filters: m[6] }));
ok('the phone\'s copy is the table', JSON.stringify(jrows) === JSON.stringify(table), jrows);
const ts = fs.readFileSync(path.join(ROOT, 'src', 'dohProviders.ts'), 'utf8');
const trows = [...ts.matchAll(/\{ id: '([^']+)', label: '([^']+)', url: '([^']+)', filters: '([^']+)' \}/g)].map((m) => ({ id: m[1], label: m[2], url: m[3], filters: m[4] }));
ok('the settings page\'s copy is the table', JSON.stringify(trows) === JSON.stringify(table.map(({ id, label, url, filters }) => ({ id, label, url, filters }))), trows);
// (The page's address check, compiled from TypeScript for this test.)
const esb = require('esbuild'); const tsMod = { exports: {} }; new Function('module', 'exports', esb.transformSync(ts, { loader: 'ts', format: 'cjs' }).code)(tsMod, tsMod.exports);

// ---------- doh-cases.txt ----------
const cases = fs.readFileSync(path.join(ROOT, 'core', 'kt-core', 'src', 'doh-cases.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('|'));
let n = 0; const now = 1_000_000;
for (const [kind, ...f] of cases) {
  n++;
  if (kind === 'order') {
    const health = {}; for (const part of f[1].split(',').filter(Boolean)) { const [id, st] = part.split('='); health[id] = st === 'fail' ? { ok: false, at: now } : st === 'fail-old' ? { ok: false, at: now - D.FAIL_FORGET_S - 60 } : { ok: true, ms: Number(st.slice(3)), at: now }; }
    const got = D.order(D.parseChoice(f[0]), health, now).join(','); ok(`order ${f[0]} ${f[1]}`, got === f[2], got);
  } else if (kind === 'custom') { const got = D.validateCustom(f[0]); const page = tsMod.exports.validateDohUrl(f[0]); ok(`custom ${f[0]}`, got === f[1] && page === f[1], { got, page }); }
  else if (kind === 'tracker') { const got = D.trackerRewrite(f[0], f[1]) ?? '-'; ok(`tracker ${f[0]}`, got === f[2], got); }
  else if (kind === 'magnet') { const m = Object.fromEntries(f[1].split(',').filter(Boolean).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])); const got = D.magnetRewrite(f[0], (h) => m[h] ?? null); ok(`magnet ${f[0].slice(0, 50)}…`, got === f[2], got); }
  else if (kind === 'addr') ok(`addr ${f[0]} ${f[1]}`, (D.addressOk(f[0], f[1] === 'custom') ? 'kept' : 'dropped') === f[2]);
  else if (kind === 'local') ok(`local ${f[0]}`, D.isLocalName(f[0]) === (f[1] === 'yes'));
  else ok(`a known kind of line: ${kind}`, false);
}
ok(`cases read: ${n}`, n >= 70);

// ---------- loopback resolvers ----------
const wire = (name) => Buffer.concat([...name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
const rec = (owner, type, ttl, data) => { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE(1, 2); h.writeUInt32BE(ttl, 4); h.writeUInt16BE(data.length, 8); return Buffer.concat([owner, h, data]); };
function answer(mode, q) {
  let id = q.readUInt16BE(0); if (mode === 'badid') id = (id + 1) & 0xffff;
  let flags = 0x8180; if (mode === 'trunc') flags |= 0x200; if (mode === 'nx') flags |= 3;
  let i = 12; const labels = []; while (q[i]) { labels.push(q.subarray(i + 1, i + 1 + q[i]).toString()); i += q[i] + 1; } const name = labels.join('.'); const qtype = q.readUInt16BE(i + 1);
  const ptr = Buffer.from([0xc0, 12]); const recs = [];
  if (mode === 'loop') recs.push(rec(ptr, 5, 60, wire('b.test')), rec(wire('b.test'), 5, 60, wire(name)));
  else if (mode !== 'nx' && qtype === 1) { const ip = name.startsWith('resolver-') ? [127, 0, 0, 1] : mode === 'private' ? [10, 0, 0, 5] : [203, 0, 113, 5 + mode.length]; recs.push(rec(ptr, 1, 120, Buffer.from(ip))); }
  const head = Buffer.alloc(12); head.writeUInt16BE(id, 0); head.writeUInt16BE(flags, 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(recs.length, 6);
  return Buffer.concat([head, q.subarray(12), ...recs, mode === 'big' ? Buffer.alloc(70000) : Buffer.alloc(0)]);
}
const hits = {}; const seen = [];
const resolverServer = http.createServer((req, res) => {
  const mode = req.url.split('/')[1]; hits[mode] = (hits[mode] || 0) + 1; seen.push(`${mode} ${req.method} ${req.headers.host} ${req.headers['content-type']} ${req.headers.accept}`);
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => {
    const go = () => { if (mode === 'fail') { res.writeHead(500); res.end(); return; } const body = answer(mode, Buffer.concat(chunks)); res.writeHead(200, { 'content-type': 'application/dns-message' }); res.end(body); };
    if (mode === 'slow') setTimeout(go, 300); else go();
  });
});

(async () => {
  await new Promise((r) => resolverServer.listen(0, '127.0.0.1', r)); const port = resolverServer.address().port;
  const mock = (mode) => ({ id: mode, label: mode, url: `http://resolver-${mode}.test:${port}/${mode}/dns-query`, ips: ['127.0.0.1'], json: false, filters: 'none' });
  let sysCalls = 0; const chain = (modes, o = {}) => { const c = new D.DohChain(); c.providers = modes.map(mock); c.systemLookup = async () => { sysCalls++; return ['198.51.100.99']; }; c.lastProbe = Math.floor(Date.now() / 1000); c.configure({ provider: o.provider ?? 'auto', allowSystem: !!o.allowSystem }); c.lastProbe = Math.floor(Date.now() / 1000); return c; };

  // The wire: POST, dns-message both ways, by the bootstrap address with the made-up name kept in Host.
  seen.length = 0; const c0 = chain(['ok']); const a0 = await c0.ask('ok', 'site.test', 1, 3000);
  ok('POST application/dns-message to the bootstrap address, the name in Host', /^ok POST resolver-ok\.test:\d+ application\/dns-message application\/dns-message$/.test(seen[0]) && a0.ips[0] === '203.0.113.7', seen[0]);
  ok('the system\'s lookup never asked for a resolver', sysCalls === 0);
  // Hostile answers.
  for (const mode of ['badid', 'trunc', 'big', 'loop']) { let why = ''; try { await chain([mode]).ask(mode, 'site.test', 1, 3000); } catch (e) { why = e.message; } ok(`hostile ${mode} refused: ${why}`, !!why); }
  // A decoder check on its own: a CNAME chain, a self-pointer.
  { const q = D.encodeQuery('site.test', 1, 0x1234); const head = Buffer.from(q); head.writeUInt16BE(0x8180, 2); head.writeUInt16BE(2, 6); const m = Buffer.concat([head, rec(Buffer.from([0xc0, 12]), 5, 300, wire('cdn.test')), rec(wire('cdn.test'), 1, 9, Buffer.from([198, 51, 100, 2]))]); const r = D.decodeStrict(m, 'Site.Test', 1, 0x1234); ok('a CNAME chain followed, the least TTL', r.ips[0] === '198.51.100.2' && r.ttl === 9, r); }
  // Failover in order; the private «public» answer refused; per-use status.
  const c1 = chain(['fail', 'badid', 'private', 'ok']); const r1 = await c1.lookup('site.test');
  ok('failover: the healthy one answered', r1.ips[0] === '203.0.113.7' && /^doh:ok:\d+$/.test(r1.via), r1);
  ok('failover: the others noted failing; private refused as «blocked»', !c1.health.fail.ok && !c1.health.badid.ok && c1.health.private.reason === 'blocked' && c1.health.ok.ok);
  ok('auto then asks the healthy one first', c1.order()[0] === 'ok', c1.order());
  ok('per-use: which one answered', /^doh:ok:/.test(c1.usedFor(['site.test']).hosts['site.test'].via));
  const before = hits.ok; const r1b = await c1.lookup('SITE.test'); ok('cached: not asked again', hits.ok === before && r1b.via === 'cache:ok', r1b);
  // No such name: the next resolver not asked.
  const c2 = chain(['nx', 'ok']); const okb = hits.ok; let nxErr = null; try { await c2.lookup('none.test'); } catch (e) { nxErr = e; }
  ok('no such name: an answer; the next resolver not asked', nxErr?.noSuchName && hits.ok === okb, nxErr?.message);
  // Every resolver failed: no silent fall-back; then allowed and said.
  sysCalls = 0; const c3 = chain(['fail', 'trunc']); let e3 = ''; try { await c3.lookup('down.test'); } catch (e) { e3 = e.message; }
  ok('all failed, system not allowed: an error that says so, the system never asked', /not allowed/.test(e3) && sysCalls === 0 && c3.usedFor(['down.test']).hosts['down.test'].via === 'failed', e3);
  c3.configure({ provider: 'auto', allowSystem: true }); const r3 = await c3.lookup('down.test');
  ok('allowed: the system\'s answer, marked «system»', r3.ips[0] === '198.51.100.99' && r3.via === 'system' && sysCalls === 1, r3);
  const r3l = await c3.lookup('nas.local'); ok('a local name: the system\'s lookup, marked «local»', r3l.via === 'local');
  // The cache's caps and TTL bounds.
  const cache = new D.Cache(); cache.put('a.test', ['203.0.113.1'], 5, 'ok', 1000); ok('TTL floor: 30 s', !!cache.get('a.test', 1029) && !cache.get('a.test', 1030));
  cache.put('b.test', ['203.0.113.1'], 99999, 'ok', 1000); ok('TTL ceiling: an hour', !!cache.get('b.test', 4599) && !cache.get('b.test', 4600));
  cache.put('c.test', [], 999, 'ok', 1000); ok('«no such name» kept 30 s', !!cache.get('c.test', 1029) && !cache.get('c.test', 1030));
  for (let i = 0; i < 600; i++) cache.put(`n${i}.test`, ['203.0.113.1'], 60 + i, 'ok', 1000); ok('at most 512 names', cache.size === 512);
  // The probe: every resolver at once; auto picks the quickest healthy one.
  const c4 = chain(['slow', 'fail', 'ok']); const p4 = await c4.probe();
  ok('probe: best is the quick one, each one\'s health shown', p4.ok && p4.resolver === 'ok' && c4.order().join(',') === 'ok,slow,fail' && p4.providers.every((p) => p.ok !== null), { order: c4.order(), p4: p4.providers });
  ok('pinned: the chosen one first even when slower', D.order(D.parseChoice('quad9'), { google: { ok: true, ms: 1, at: 1 } }, 2)[0] === 'quad9');
  // The automatic probe: when nothing is known, on a name asked — no timer.
  const c5 = chain(['ok']); c5.lastProbe = null; const h5 = hits.ok; await c5.lookup('again.test'); for (let i = 0; i < 30 && c5.lastProbe == null; i++) await new Promise((r) => setTimeout(r, 50));
  ok('the probe ran by itself once a name was asked', c5.lastProbe != null && hits.ok >= h5 + 2);
  const lp = c5.lastProbe; await c5.lookup('again2.test'); await new Promise((r) => setTimeout(r, 100)); ok('…and not again within the half hour', c5.lastProbe === lp && !c5.probing);
  // The user's own resolver: its name found through the public ones (never the system's lookup); on this device, alone.
  sysCalls = 0; const c6 = chain(['ok']); c6.configure({ provider: `https://resolver-mine.test:${port}/ok/dns-query`, allowSystem: false });
  ok('custom first, then the public ones', c6.order().join(',') === 'custom,ok');
  const boot = await c6.bootstrap(`https://resolver-mine.test:${port}/ok/dns-query`); ok('custom bootstrap through the chain', boot[0] === '127.0.0.1' && sysCalls === 0, boot);
  c6.configure({ provider: `http://127.0.0.1:${port}/ok/dns-query` }); ok('on this device: asked alone', c6.order().join(',') === 'custom'); const r6 = await c6.lookup('mine.test'); ok('…and it answers', r6.via.startsWith('doh:custom:'), r6);
  // A magnet's UDP trackers through the chain.
  const c7 = chain(['ok']); const mag = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&tr=udp%3A%2F%2Ftracker.test%3A1337%2Fannounce&tr=https%3A%2F%2Fweb.test%2Fa';
  const mg = await c7.rewriteMagnet(mag); ok('magnet: the UDP tracker by address, the HTTPS one as it was', mg.includes('tr=udp%3A%2F%2F203.0.113.7%3A1337%2Fannounce') && mg.endsWith('tr=https%3A%2F%2Fweb.test%2Fa'), mg);
  ok('magnet: what answered the tracker is recorded', /^doh:ok/.test(c7.usedFor(['tracker.test']).hosts['tracker.test'].via));
  c7.configure({ provider: 'off' }); ok('magnet while off: untouched', (await c7.rewriteMagnet(mag)) === mag);

  // The proxy aria2 uses: names by the chain, its password, CONNECT and GET.
  const site = net.createServer((s) => { s.once('data', (d) => { const t = d.toString(); if (t.startsWith('HELLO')) s.end('ECHO ' + t); else s.end(`HTTP/1.1 200 OK\r\nContent-Length: ${Buffer.byteLength(t.replace(/\r\n/g, '|'))}\r\n\r\n${t.replace(/\r\n/g, '|')}`); }); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r)); const sport = site.address().port;
  const asked = []; const px = await D.startProxy(async (h) => { asked.push(h); if (h === 'files.test') return { ips: ['127.0.0.1'], via: 'doh:ok:1' }; throw new Error(`no DoH answer for ${h}`); });
  const auth = 'Proxy-Authorization: Basic ' + Buffer.from(decodeURIComponent(new URL(px.url).username) + ':' + decodeURIComponent(new URL(px.url).password)).toString('base64') + '\r\n';
  const talk = (text, after) => new Promise((res) => { const s = net.connect(px.port, '127.0.0.1', () => { s.write(text); if (after) setTimeout(() => s.end(after), 100); }); let got = ''; s.on('data', (d) => { got += d; }); s.on('close', () => res(got)); s.on('error', () => res(got)); setTimeout(() => s.destroy(), 3000); });
  let g = await talk(`CONNECT files.test:${sport} HTTP/1.1\r\n${auth}\r\n`, 'HELLO-TLS'); ok('proxy CONNECT: through the chain, both ways', g.startsWith('HTTP/1.1 200') && g.endsWith('ECHO HELLO-TLS'), g);
  g = await talk(`GET http://files.test:${sport}/a?b=1 HTTP/1.1\r\nHost: files.test\r\nProxy-Connection: keep-alive\r\n${auth}X-Q: 1\r\n\r\n`); ok('proxy GET: origin form, its own headers gone', g.includes('GET /a?b=1 HTTP/1.1|Host: files.test|X-Q: 1|Connection: close') && !/Proxy-/.test(g), g);
  g = await talk(`CONNECT files.test:${sport} HTTP/1.1\r\n\r\n`); ok('proxy without its password: 407, nothing resolved', g.startsWith('HTTP/1.1 407') && asked.length === 2, g);
  g = await talk(`CONNECT nowhere.test:443 HTTP/1.1\r\n${auth}\r\n`); ok('proxy: a name the chain cannot give → 502 with the reason', g.startsWith('HTTP/1.1 502') && /no DoH answer for nowhere\.test/.test(g), g);
  ok('proxy listens on 127.0.0.1 only', px.url.includes('@127.0.0.1:'));
  // aria2's all-proxy: the DoH proxy unless the user set one.
  const A = require(path.join(ROOT, 'desktop', 'aria2.cjs')); A.setDohProxy(px.url, null);
  ok('aria2: all-proxy is the DoH proxy', A.netOptions({})['all-proxy'] === px.url);
  ok('aria2: the user\'s own proxy wins', A.netOptions({ proxy: 'http://p:1' })['all-proxy'] === 'http://p:1');
  A.setDohProxy('', null); ok('aria2: off again', A.netOptions({})['all-proxy'] === '');

  // Nothing left open.
  await px.close(); await new Promise((r) => site.close(r)); await new Promise((r) => resolverServer.close(r)); await new Promise((r) => setTimeout(r, 200));
  const handles = process._getActiveHandles().filter((h) => !(h === process.stdout || h === process.stderr || h === process.stdin) && !(h.constructor?.name === 'WriteStream' || h.constructor?.name === 'ReadStream'));
  ok('no server, socket or timer left open', handles.length === 0, handles.map((h) => h.constructor?.name));
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
