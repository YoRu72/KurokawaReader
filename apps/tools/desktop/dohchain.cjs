// DNS over HTTPS for the Electron build (0.21 P9) — the twin of kt-core's dohchain.rs (the rules) and dohproxy.rs (the
// proxy aria2 uses), and of the shared crate's doh.rs decode_strict (the answers trusted). Checked against
// core/kt-core/src/doh-providers.txt and doh-cases.txt by tests/dohchain.cjs. Plain Node (no Electron here):
//  - the resolvers, each asked at its bootstrap addresses (its name kept for TLS and the certificate), never by the
//    network's DNS; POST application/dns-message with an id of its own; the answer read trusting nothing;
//  - the order: the chosen one first, or in «auto» the quickest healthy one; the failing ones last; the next one on a
//    failure; the system's DNS only when the user allowed it, and said so (via «system»);
//  - the cache (TTL honoured within 30 s – 1 h, «no such name» 30 s, 512 names);
//  - the health probe on demand, and at most every half hour when a name is asked (no timer);
//  - a small proxy on 127.0.0.1 (a password of its own) that aria2 is pointed at: its downloads and HTTP trackers
//    find their sites through the chain; a magnet's UDP trackers given by address.
'use strict';
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dns = require('node:dns');
const crypto = require('node:crypto');

// (doh-providers.txt, field by field: id, label, address, bootstrap addresses, json, filters.)
const PROVIDERS = [
  ['cloudflare', 'Cloudflare', 'https://cloudflare-dns.com/dns-query', ['1.1.1.1', '1.0.0.1', '2606:4700:4700::1111', '2606:4700:4700::1001'], true, 'none'],
  ['google', 'Google', 'https://dns.google/dns-query', ['8.8.8.8', '8.8.4.4', '2001:4860:4860::8888', '2001:4860:4860::8844'], true, 'none'],
  ['quad9', 'Quad9', 'https://dns.quad9.net/dns-query', ['9.9.9.9', '149.112.112.112', '2620:fe::fe', '2620:fe::9'], false, 'malware'],
  ['adguard', 'AdGuard', 'https://dns.adguard-dns.com/dns-query', ['94.140.14.14', '94.140.15.15', '2a10:50c0::ad1:ff', '2a10:50c0::ad2:ff'], false, 'ads'],
  ['adguard-unfiltered', 'AdGuard (unfiltered)', 'https://unfiltered.adguard-dns.com/dns-query', ['94.140.14.140', '94.140.14.141', '2a10:50c0::1:ff', '2a10:50c0::2:ff'], false, 'none'],
  ['dnssb', 'DNS.SB', 'https://185.222.222.222/dns-query', ['185.222.222.222'], false, 'none'],
  ['controld', 'Control D', 'https://freedns.controld.com/p0', ['76.76.2.0', '76.76.10.0', '2606:1a40::', '2606:1a40:1::'], false, 'none'],
  ['wikimedia', 'Wikimedia DNS', 'https://wikimedia-dns.org/dns-query', ['185.71.138.138', '2001:67c:930::1'], false, 'none'],
  ['dns4eu', 'DNS4EU', 'https://unfiltered.joindns4.eu/dns-query', ['86.54.11.100', '86.54.11.200', '2a13:1001::86:54:11:100', '2a13:1001::86:54:11:200'], false, 'legal'],
].map(([id, label, url, ips, json, filters]) => ({ id, label, url, ips, json, filters }));

const PROBE_NAME = 'example.com', PROBE_EVERY_S = 1800, FAIL_FORGET_S = 600, TTL_MIN_S = 30, TTL_MAX_S = 3600, NEG_TTL_S = 30, CACHE_MAX = 512, ASK_TIMEOUT_MS = 6000, CHAIN_DEADLINE_MS = 20000;

function hostOf(url) { const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(String(url)); if (!m) return null; let a = m[1]; a = a.slice(a.lastIndexOf('@') + 1); const h = a.startsWith('[') ? a.slice(1).split(']')[0] : a.split(':')[0]; return h ? h.toLowerCase() : null; }
function isOnDevice(url) { return /^http:\/\//i.test(String(url).trim()) && ['127.0.0.1', 'localhost', '::1'].includes(hostOf(url)); }

/** The user's own address checked (dohchain.rs validate_custom): 'ok' or why not. */
function validateCustom(url) {
  const u = String(url).trim(); if (u.length > 512) return 'tooLong'; if (/[\s\x00-\x1f\x7f]/.test(u)) return 'space';
  let rest; const lower = u.toLowerCase();
  if (lower.startsWith('https://')) rest = lower.slice(8);
  else if (lower.startsWith('http://')) { if (!['127.0.0.1', 'localhost', '::1'].includes(hostOf(u) || '')) return 'notHttps'; rest = lower.slice(7); }
  else return 'notHttps';
  const end = rest.search(/[/?#]/); const auth = end < 0 ? rest : rest.slice(0, end); const p = end < 0 ? '' : rest.slice(end);
  if (auth.includes('@')) return 'userinfo';
  let host, port;
  if (auth.startsWith('[')) { const i = auth.indexOf(']'); if (i < 0) return 'noHost'; host = auth.slice(1, i); const after = auth.slice(i + 1); port = after.startsWith(':') ? after.slice(1) : undefined; }
  else { const i = auth.indexOf(':'); host = i < 0 ? auth : auth.slice(0, i); port = i < 0 ? undefined : auth.slice(i + 1); }
  if (!host) return 'noHost';
  if (port !== undefined && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) return 'badPort';
  if (p.includes('#') || !p.startsWith('/') || p === '/' || p.startsWith('/?')) return 'badPath';
  return 'ok';
}

/** The setting → { kind: 'off' | 'auto' | 'pinned' | 'custom', id?, url? } (a discontinued Mullvad → auto). */
function parseChoice(s) {
  const p = String(s ?? '').trim();
  if (p === 'auto' || p === 'mullvad' || p === 'opendns') return { kind: 'auto' };
  if (PROVIDERS.some((x) => x.id === p)) return { kind: 'pinned', id: p };
  if (p.includes('://') && validateCustom(p) === 'ok') return { kind: 'custom', url: p };
  return { kind: 'off' };
}

/** The resolvers asked, in order (dohchain.rs order). `health`: { id: { ok, ms, at (s) } }. */
function order(choice, health, now, list = PROVIDERS) {
  if (choice.kind === 'off') return [];
  if (choice.kind === 'custom' && isOnDevice(choice.url)) return ['custom'];
  const first = choice.kind === 'pinned' ? choice.id : choice.kind === 'custom' ? 'custom' : null;
  const rank = (id) => { const h = health[id]; if (h && h.ok) return [0, h.ms]; if (h && now - h.at < FAIL_FORGET_S) return [2, 0]; return [1, 0]; };
  const rest = list.map((p, i) => [i, p.id]).filter(([, id]) => id !== first);
  rest.sort((a, b) => { const x = rank(a[1]), y = rank(b[1]); return x[0] - y[0] || x[1] - y[1] || a[0] - b[0]; });
  return [...(first ? [first] : []), ...rest.map(([, id]) => id)];
}
function probeDue(on, lastProbe, chainFailed, now) { if (!on) return false; if (lastProbe == null) return true; return now - lastProbe >= PROBE_EVERY_S || (chainFailed && now - lastProbe >= 60); }
/** Whether a resolver blocks names by itself: its «0.0.0.0» is an answer (dohchain.rs filters). */
function filters(id, list = PROVIDERS) { return id === 'custom' || ['malware', 'ads', 'phishing', 'legal'].includes(list.find((p) => p.id === id)?.filters); }
/** The resolvers the probe asks (dohchain.rs probe_ids): «Check now» all; the automatic probe the chain's first. */
function probeIds(choice, all, list = PROVIDERS) {
  const table = list.map((p) => p.id);
  if (choice.kind === 'off') return [];
  if (choice.kind === 'custom') return all && !isOnDevice(choice.url) ? ['custom', ...table] : ['custom'];
  if (choice.kind === 'pinned' && !all) return [choice.id];
  return table;
}
function isLocalName(name) { const n = String(name).replace(/\.$/, '').toLowerCase(); return (!!n && !n.includes('.')) || n === 'localhost' || ['.localhost', '.local', '.home.arpa', '.lan', '.internal'].some((s) => n.endsWith(s)); }

/** An answered address worth connecting to (dohchain.rs address_ok). */
function addressOk(ip, fromCustom) {
  const v = net.isIP(ip); if (!v) return false;
  if (v === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0 || (o[0] === 169 && o[1] === 254) || o[0] >= 224) return false;
    if (o[0] === 127) return !!fromCustom;
    const priv = o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || (o[0] === 198 && (o[1] === 18 || o[1] === 19));
    return fromCustom || !priv;
  }
  const s = expand6(ip);
  if (s.slice(0, 5).every((x) => x === 0) && s[5] === 0xffff) return addressOk(`${s[6] >> 8}.${s[6] & 255}.${s[7] >> 8}.${s[7] & 255}`, fromCustom);
  if (s.every((x) => x === 0) || (s[0] & 0xff00) === 0xff00 || (s[0] & 0xffc0) === 0xfe80) return false;
  if (s.slice(0, 7).every((x) => x === 0) && s[7] === 1) return !!fromCustom;
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (s.slice(0, 6).every((x) => x === 0) || (s[0] === 0x64 && s[1] === 0xff9b && s.slice(2, 6).every((x) => x === 0))) return addressOk(v4(s[6], s[7]), fromCustom);
  if (s[0] === 0x2002) return addressOk(v4(s[1], s[2]), fromCustom);
  return fromCustom || (s[0] & 0xfe00) !== 0xfc00;
}
function expand6(ip) {
  let a = ip; const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(a); if (v4) { const o = v4[1].split('.').map(Number); a = a.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16); }
  const [l, r] = a.includes('::') ? a.split('::') : [a, null]; const L = l ? l.split(':') : []; const R = r ? r.split(':') : [];
  const mid = r === null ? [] : Array(8 - L.length - R.length).fill('0');
  return [...L, ...mid, ...R].map((x) => parseInt(x || '0', 16));
}

/** The cache (dohchain.rs Cache). */
class Cache {
  constructor() { this.map = new Map(); }
  get(name, now) { const e = this.map.get(name.toLowerCase()); return e && e.until > now ? { ips: e.ips, by: e.by } : null; }
  stale(name, now) { const e = this.map.get(name.toLowerCase()); return e && e.ips.length && now - e.stored < 86400 ? { ips: e.ips, by: e.by } : null; }
  put(name, ips, ttl, by, now) {
    const keep = ips.length ? Math.min(TTL_MAX_S, Math.max(TTL_MIN_S, ttl)) : NEG_TTL_S; const k = name.toLowerCase();
    if (!this.map.has(k) && this.map.size >= CACHE_MAX) { for (const [kk, e] of this.map) if (e.until <= now) this.map.delete(kk); while (this.map.size >= CACHE_MAX) { let min = null; for (const [kk, e] of this.map) if (!min || e.until < min[1]) min = [kk, e.until]; this.map.delete(min[0]); } }
    this.map.set(k, { ips, by, until: now + keep, stored: now });
  }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

/* ---------- the wire (RFC 1035 / 8484) ---------- */
function encodeQuery(name, qtype, id) {
  const n = String(name).trim().replace(/\.$/, ''); if (!n || n.length > 253) throw new Error('not a host name: ' + name);
  const parts = [Buffer.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0])];
  for (const l of n.split('.')) { const b = Buffer.from(l, 'ascii'); if (!b.length || b.length > 63) throw new Error('not a host name: ' + name); parts.push(Buffer.from([b.length]), b); }
  parts.push(Buffer.from([0, qtype >> 8, qtype & 255, 0, 1])); return Buffer.concat(parts);
}
class Refused extends Error { constructor(m, noSuchName) { super(m); this.noSuchName = !!noSuchName; } }
function readName(m, i) {
  const labels = []; let end = null, jumps = 0, total = 0;
  for (;;) {
    if (i >= m.length) throw new Refused('DNS answer cut short'); const len = m[i];
    if (len === 0) return [labels.join('.'), end ?? i + 1];
    if ((len & 0xc0) === 0xc0) { if (i + 1 >= m.length) throw new Refused('DNS answer cut short'); const to = ((len & 0x3f) << 8) | m[i + 1]; if (++jumps > 32 || to >= i) throw new Refused('DNS answer: a name that points at itself'); if (end === null) end = i + 2; i = to; continue; }
    if (len & 0xc0) throw new Refused('DNS answer: a label of an unknown kind');
    if (i + 1 + len > m.length) throw new Refused('DNS answer cut short'); total += len + 1; if (total > 255) throw new Refused('DNS answer: a name too long');
    labels.push(m.subarray(i + 1, i + 1 + len).toString('latin1').toLowerCase()); i += 1 + len;
  }
}
/** An answer read trusting nothing (shell-rs doh.rs decode_strict) → { ips, ttl }; throws Refused. */
function decodeStrict(m, qname, qtype, id) {
  if (m.length > 65535) throw new Refused('DNS answer too big'); if (m.length < 12) throw new Refused('DNS answer cut short');
  if (m.readUInt16BE(0) !== id) throw new Refused('DNS answer for another question (id)');
  const flags = m.readUInt16BE(2); if (!(flags & 0x8000)) throw new Refused('not a DNS answer'); if (flags & 0x0200) throw new Refused('DNS answer truncated');
  const rc = flags & 15; if (rc === 3) throw new Refused('no such name', true); if (rc) throw new Refused(`the resolver failed (code ${rc})`);
  if (m.readUInt16BE(4) !== 1) throw new Refused('DNS answer for another question');
  const an = m.readUInt16BE(6); const want = String(qname).replace(/\.$/, '').toLowerCase();
  let [q, i] = readName(m, 12); if (i + 4 > m.length) throw new Refused('DNS answer cut short');
  if (q !== want || m.readUInt16BE(i) !== qtype) throw new Refused('DNS answer for another question'); i += 4;
  const recs = [];
  for (let k = 0; k < an; k++) { const [owner, at] = readName(m, i); if (at + 10 > m.length) throw new Refused('DNS answer cut short'); const len = m.readUInt16BE(at + 8); const data = at + 10; if (data + len > m.length) throw new Refused('DNS answer cut short'); recs.push({ owner, t: m.readUInt16BE(at), cls: m.readUInt16BE(at + 2), ttl: m.readUInt32BE(at + 4), data, len }); i = data + len; }
  let name = want; const seen = [name]; let ttl = Infinity;
  for (let hop = 0; hop <= 8; hop++) {
    const ips = [];
    for (const r of recs) { if (r.owner !== name || r.cls !== 1 || r.t !== qtype) continue; if (r.t === 1 && r.len === 4) ips.push([...m.subarray(r.data, r.data + 4)].join('.')); else if (r.t === 28 && r.len === 16) { const g = []; for (let j = 0; j < 16; j += 2) g.push(m.readUInt16BE(r.data + j).toString(16)); ips.push(g.join(':')); } else throw new Refused('DNS answer: an address of the wrong size'); ttl = Math.min(ttl, r.ttl); }
    if (ips.length) return { ips, ttl };
    const c = recs.find((r) => r.owner === name && r.t === 5 && r.cls === 1); if (!c) return { ips: [], ttl: 0 };
    const [to] = readName(m, c.data); if (seen.includes(to)) throw new Refused('DNS answer: a CNAME loop'); ttl = Math.min(ttl, c.ttl); seen.push(to); name = to;
  }
  throw new Refused('DNS answer: too many CNAMEs');
}

/** One POST to a resolver (`url`), at `ip` when given (the name kept for Host, SNI and the certificate). */
function post(url, ip, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const mod = u.protocol === 'https:' ? https : http; const host = u.hostname.replace(/^\[|\]$/g, '');
    const rq = mod.request({ host: ip || host, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, method: 'POST', servername: net.isIP(host) ? undefined : host, headers: { host: u.host, 'content-type': 'application/dns-message', accept: 'application/dns-message', 'content-length': body.length, 'user-agent': 'KurokawaTools' }, timeout: timeoutMs, agent: false },
      (res) => { const chunks = []; let n = 0; res.on('data', (c) => { n += c.length; if (n > 65536) { rq.destroy(new Refused('DNS answer too big')); return; } chunks.push(c); }); res.on('end', () => { if (res.statusCode !== 200) reject(new Refused(`HTTP ${res.statusCode}`)); else resolve(Buffer.concat(chunks)); }); res.on('error', reject); });
    rq.on('timeout', () => rq.destroy(new Refused('timeout'))); rq.on('error', (e) => reject(e instanceof Refused ? e : new Refused(String(e.code || e.message || e))));
    rq.end(body);
  });
}

const nowS = () => Math.floor(Date.now() / 1000);

/** The chain's state and its work (dohtools.rs's twin). */
class DohChain {
  constructor() { this.choice = { kind: 'off' }; this.allowSystem = false; this.health = {}; this.cache = new Cache(); this.used = new Map(); this.lastProbe = null; this.chainFailed = false; this.probing = null; this.counts = { queries: 0, fails: 0, system: 0 }; this.providers = PROVIDERS; this.systemLookup = (h) => dns.promises.lookup(h, { all: true }).then((a) => a.map((x) => x.address)); this.proxy = null; this.boot = new Map(); this.askTimeout = ASK_TIMEOUT_MS; this.deadline = CHAIN_DEADLINE_MS; }
  get on() { return this.choice.kind !== 'off'; }
  configure(o) { const c = parseChoice(o.provider); if (JSON.stringify(c) !== JSON.stringify(this.choice)) { this.cache.clear(); this.lastProbe = null; } this.choice = c; this.allowSystem = !!o.allowSystem; return { provider: String(o.provider ?? 'off'), allowSystem: this.allowSystem, on: this.on }; }
  order() { return order(this.choice, this.health, nowS(), this.providers); }
  server(id) { if (id === 'custom') return this.choice.kind === 'custom' ? { url: this.choice.url, ips: [] } : null; const p = this.providers.find((x) => x.id === id); return p ? { url: p.url, ips: p.ips } : null; }
  /** The user's resolver's own name: asked of the public ones (never the network's DNS) unless it is an address. */
  async bootstrap(url) {
    const h = hostOf(url); if (!h || net.isIP(h) || isOnDevice(url)) return [];
    const had = this.boot.get(h); if (had) return had; let last = null;
    for (const id of order({ kind: 'auto' }, this.health, nowS(), this.providers)) { try { const a = await this.ask(id, h, 1, ASK_TIMEOUT_MS); if (a.ips.length) { this.boot.set(h, a.ips); return a.ips; } } catch (e) { last = e; } }
    throw new Refused(`the resolver's own name not found${last ? `: ${last.message}` : ''}`);
  }
  /** One resolver asked, by each of its addresses in turn, never past `until` (the lookup's own deadline). */
  async ask(id, host, qtype, timeoutMs, until = Date.now() + timeoutMs) {
    const s = this.server(id); if (!s) throw new Refused('unknown');
    const ips = s.ips.length ? s.ips : await this.bootstrap(s.url);
    const qid = crypto.randomInt(0, 65536); const q = encodeQuery(host, qtype, qid); let last = null;
    for (const ip of ips.length ? ips : [null]) {
      const left = Math.min(timeoutMs, until - Date.now()); if (left <= 0) { last = new Refused('deadline'); break; }
      try { return decodeStrict(await post(s.url, ip, q, left), host, qtype, qid); } catch (e) { if (e.noSuchName) throw e; last = e; }
    }
    throw last ?? new Refused('no answer');
  }
  async askBoth(id, host, until) { const a = await this.ask(id, host, 1, this.askTimeout, until); if (a.ips.length) return a; return this.ask(id, host, 28, this.askTimeout, until); }
  note(id, ok, ms, reason) { this.health[id] = { ok, ms, at: nowS(), reason: reason || '' }; }
  /** `host` resolved by the chain → { ips, via } (dohchain.rs resolve); throws with the reason. */
  async lookup(host) {
    const ord = this.order(); if (!ord.length) throw new Error('DNS over HTTPS is off'); this.counts.queries++;
    const key = String(host).toLowerCase(); const t = nowS(); const t0 = Date.now(); const done = (via, ips) => { this.used.set(key, { via, at: Date.now() }); if (this.used.size > 400) this.used.delete(this.used.keys().next().value); return { ips, via }; };
    try {
      if (isLocalName(host)) return done('local', await this.systemLookup(host));
      const hit = this.cache.get(key, t); if (hit) { if (!hit.ips.length) { const b = /^blocked:/.test(hit.by); throw Object.assign(new Error(b ? `DNS over HTTPS: ${host} is blocked by ${hit.by.slice(8)}` : `no such host: ${host}`), { noSuchName: true, blocked: b }); } return done(`cache:${hit.by}`, hit.ips); }
      const failed = []; const until = t0 + this.deadline;
      for (const id of ord) {
        if (Date.now() >= until) { failed.push([id, 'deadline']); break; }
        const a0 = Date.now();
        try {
          const a = await this.askBoth(id, host, until); const ms = Date.now() - a0; this.note(id, true, ms);
          // (A filtering resolver's 0.0.0.0: blocked by it, on purpose — an answer; no other resolver asked.)
          if (a.ips.length && filters(id, this.providers) && a.ips.every((ip) => /^(0\.0\.0\.0|0(:0){7}|::)$/.test(ip))) { this.cache.put(key, [], 0, `blocked:${id}`, t); this.used.set(key, { via: `blocked:${id}`, at: Date.now() }); throw Object.assign(new Error(`DNS over HTTPS: ${host} is blocked by ${id}`), { noSuchName: true, blocked: true }); }
          const kept = a.ips.filter((ip) => addressOk(ip, id === 'custom'));
          if (!kept.length && a.ips.length) { failed.push([id, 'private']); continue; }
          this.cache.put(key, kept, a.ttl, id, t);
          if (!kept.length) { this.used.set(key, { via: `none:${id}`, at: Date.now() }); throw Object.assign(new Error(`no such host: ${host} (answered by ${id})`), { noSuchName: true }); }
          return done(`doh:${id}:${ms}`, kept);
        } catch (e) {
          if (e.noSuchName) { if (e instanceof Refused) { this.note(id, true, Date.now() - a0); this.cache.put(key, [], 0, id, t); this.used.set(key, { via: `none:${id}`, at: Date.now() }); throw Object.assign(new Error(`no such host: ${host} (answered by ${id})`), { noSuchName: true }); } throw e; }
          this.note(id, false, Date.now() - a0, e.message); failed.push([id, e.message]);
        }
      }
      const st = this.cache.stale(key, t); if (st) return done(`stale:${st.by}`, st.ips);
      if (this.allowSystem) { try { const ips = await this.systemLookup(host); if (ips.length) { this.counts.system++; return done('system', ips); } } catch { /* below */ } }
      this.counts.fails++; this.chainFailed = true; this.used.set(key, { via: failed.length && failed.every(([, w]) => w === 'private') ? 'private' : 'failed', at: Date.now() });
      throw new Error(`DNS over HTTPS: no resolver answered for ${host} (${failed.slice(0, 3).map(([i, w]) => `${i}: ${w}`).join('; ')})${this.allowSystem ? '' : ' — the system\'s DNS is not allowed in Settings'}`);
    } finally { if (!this.probing && probeDue(this.on, this.lastProbe, this.chainFailed, nowS())) void this.probe(false).catch(() => undefined); }
  }
  /** PROBE_NAME asked at once (5 s each) of every resolver («Check now»: `all`) or of those the chain asks first (the
   *  automatic probe — probeIds). (Electron cannot tell a metered connection, so the automatic probe does not look.) */
  probe(all = true) {
    if (this.probing) return this.probing;
    const ids = probeIds(this.choice, all, this.providers);
    this.probing = Promise.all(ids.map(async (id) => { const t0 = Date.now(); try { const a = await this.ask(id, PROBE_NAME, 1, 5000); const ok = a.ips.some((ip) => addressOk(ip, id === 'custom')); this.note(id, ok, Date.now() - t0, ok ? '' : 'no usable address'); return [id, ok, Date.now() - t0]; } catch (e) { this.note(id, false, Date.now() - t0, e.noSuchName ? 'no such name' : e.message); return [id, false, Date.now() - t0]; } }))
      .then((rs) => { this.lastProbe = nowS(); this.chainFailed = false; const best = rs.filter((r) => r[1]).sort((a, b) => a[2] - b[2])[0]; return { ...this.status(), ok: !!best, ...(best ? { resolver: best[0], ms: best[2] } : { why: 'no resolver answered', ms: Math.max(0, ...rs.map((r) => r[2])) }) }; })
      .finally(() => { this.probing = null; });
    return this.probing;
  }
  status() {
    const t = nowS(); const h = (id) => this.health[id];
    return { on: this.on, allowSystem: this.allowSystem, order: this.order(), providers: this.providers.map((p) => ({ id: p.id, label: p.label, url: p.url, filters: p.filters, ok: h(p.id) ? h(p.id).ok : null, ms: h(p.id) ? h(p.id).ms : null, at: h(p.id) ? h(p.id).at * 1000 : null, reason: h(p.id)?.reason ?? '' })),
      custom: h('custom') ? { ...h('custom'), at: h('custom').at * 1000 } : null, lastProbe: this.lastProbe != null ? this.lastProbe * 1000 : null, ...this.counts, cached: this.cache.size, now: t * 1000,
      proxy: { running: !!this.proxy, port: this.proxy?.port ?? 0, tunnels: this.proxy?.tunnels ?? 0 } };
  }
  usedFor(hosts) { const o = {}; for (const h of hosts || []) { const u = this.used.get(String(h).toLowerCase()); if (u) o[h] = u; } return { on: this.on, hosts: o }; }
  /** A magnet's UDP trackers by address (dohchain.rs magnet_rewrite): every host asked at once, `budget` ms for all;
   *  one not answered in time is left out — never a name for aria2 to look up by the network's DNS. */
  async rewriteMagnet(m, budget = 5000) {
    if (!this.on) return m; const hosts = new Map(); let timer = null;
    const all = Promise.all(magnetHosts(m).map((h) => this.lookup(h).then((r) => { hosts.set(h, r.ips[0]); }, () => undefined)));
    await Promise.race([all, new Promise((r) => { timer = setTimeout(r, budget); })]); clearTimeout(timer);
    const got = new Map(hosts); return magnetRewrite(m, (h) => got.get(h) ?? null);
  }
}

/* ---------- torrents ---------- */
function trackerRewrite(url, ip) {
  const s = String(url); if (s.slice(0, 6).toLowerCase() !== 'udp://') return null; const rest = s.slice(6);
  const end = rest.search(/[/?]/); const auth = end < 0 ? rest : rest.slice(0, end); const tail = end < 0 ? '' : rest.slice(end);
  if (auth.startsWith('[')) return null; const i = auth.lastIndexOf(':'); const host = i < 0 ? auth : auth.slice(0, i); const port = i < 0 ? null : auth.slice(i + 1);
  if (!host || net.isIP(host) || isLocalName(host)) return null;
  return `udp://${net.isIP(ip) === 6 ? `[${ip}]` : ip}${port !== null ? `:${port}` : ''}${tail}`;
}
function trackerHost(url) { if (!trackerRewrite(url, '192.0.2.1')) return null; return hostOf('x://' + String(url).slice(6)); }
const pctDecode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
const pctEncode = (s) => Array.from(Buffer.from(s, 'utf8')).map((c) => (/[A-Za-z0-9\-._~]/.test(String.fromCharCode(c)) ? String.fromCharCode(c) : '%' + c.toString(16).toUpperCase().padStart(2, '0'))).join('');
function magnetHosts(m) { const q = String(m).split('?')[1] ?? ''; return [...new Set(q.split('&').map((p) => p.split('=')).filter(([k]) => k && k.toLowerCase() === 'tr').map(([, v]) => trackerHost(pctDecode(v ?? ''))).filter(Boolean))]; }
function magnetRewrite(m, resolve) {
  const i = String(m).indexOf('?'); if (i < 0) return m;
  return m.slice(0, i + 1) + m.slice(i + 1).split('&').map((p) => { const j = p.indexOf('='); if (j < 0) return p; const k = p.slice(0, j); if (k.toLowerCase() !== 'tr') return p; const url = pctDecode(p.slice(j + 1)); const h = trackerHost(url); if (!h) return p; const ip = resolve(h); const n = ip ? trackerRewrite(url, ip) : null; return n ? `${k}=${pctEncode(n)}` : null; }).filter((p) => p !== null).join('&');
}

/* ---------- the proxy aria2 uses (kt-core dohproxy.rs) ---------- */
const MAX_CONNS = 128;
function startProxy(lookup) {
  // (The password from the system's randomness; checked whole, in constant time, before anything is dialled; at most
  // MAX_CONNS connections; FTP not carried — aria2 is given this proxy for http and https only.)
  const user = 'kt', pass = crypto.randomBytes(16).toString('hex'); const want = Buffer.from(Buffer.from(`${user}:${pass}`).toString('base64'));
  const authorized = (headers) => headers.some((h) => { const i = h.indexOf(':'); if (i < 0 || h.slice(0, i).trim().toLowerCase() !== 'proxy-authorization') return false; const v = h.slice(i + 1).trim(); if (v.slice(0, 6).toLowerCase() !== 'basic ') return false; const got = Buffer.from(v.slice(6).trim()); return got.length === want.length && crypto.timingSafeEqual(got, want); });
  const socks = new Set(); let open = 0; const st = { port: 0, host: '', tunnels: 0, refused: 0, url: '', address: '', user, password: pass, close: null };
  const reply = (c, status, why) => { const body = String(why).replace(/[\r\n]/g, ' '); try { c.end(`HTTP/1.1 ${status}\r\n${status.startsWith('407') ? 'Proxy-Authenticate: Basic realm="kt"\r\n' : ''}X-Kt-Doh: ${body}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`); } catch { /* gone */ } };
  const dial = async (host, port) => { const ips = net.isIP(host) ? [host] : (await lookup(host)).ips; let last = null; for (const ip of ips) { try { return await new Promise((ok, bad) => { const s = net.connect({ host: ip, port, timeout: 20000 }); s.once('connect', () => { s.setTimeout(0); ok(s); }); s.once('timeout', () => { s.destroy(); bad(new Error('timeout')); }); s.once('error', bad); }); } catch (e) { last = e; } } throw last ?? new Error('no address'); };
  const splitHP = (s, def) => { const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) || /^([^:]+)(?::(\d+))?$/.exec(s); if (!m || !m[1]) return null; const port = m[2] ? Number(m[2]) : def; return port > 0 && port < 65536 ? [m[1], port] : null; };
  // (Half-open allowed: a client that has sent all it will still gets the site's answer.)
  const server = net.createServer({ allowHalfOpen: true }, (c) => {
    if (open >= MAX_CONNS) { st.refused++; reply(c, '503 Service Unavailable', 'busy'); return; }
    open++; socks.add(c); c.on('close', () => { socks.delete(c); open--; }); c.on('error', () => undefined); c.setTimeout(300000, () => c.destroy());
    let buf = Buffer.alloc(0); const headTimer = setTimeout(() => c.destroy(), 5000);
    const onData = async (d) => {
      buf = Buffer.concat([buf, d]); const end = buf.indexOf('\r\n\r\n'); if (end < 0) { if (buf.length > 32768) c.destroy(); return; }
      clearTimeout(headTimer); c.removeListener('data', onData); c.pause();
      const head = buf.subarray(0, end).toString('latin1'); const rest = buf.subarray(end + 4); const lines = head.split('\r\n'); const parts = lines[0].split(' '); const headers = lines.slice(1).filter(Boolean);
      if (!authorized(headers)) { st.refused++; return reply(c, '407 Proxy Authentication Required', 'auth'); }
      if (parts.length !== 3) return reply(c, '400 Bad Request', 'bad request');
      const [method, target, ver] = parts; let site;
      if (method.toUpperCase() === 'CONNECT') {
        const hp = splitHP(target, 443); if (!hp) return reply(c, '400 Bad Request', 'bad target');
        try { site = await dial(hp[0], hp[1]); } catch (e) { return reply(c, '502 Bad Gateway', e.message || e); }
        st.tunnels++; socks.add(site); site.on('close', () => socks.delete(site)); site.on('error', () => c.destroy()); c.on('close', () => site.destroy());
        c.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (rest.length) site.write(rest); c.pipe(site); site.pipe(c); c.resume(); return;
      }
      if (!/^http:\/\//i.test(target)) return reply(c, '400 Bad Request', 'only http:// or CONNECT');
      const after = target.slice(7); const slash = after.indexOf('/'); const auth = slash < 0 ? after : after.slice(0, slash); const p = slash < 0 ? '/' : after.slice(slash);
      const hp = splitHP(auth, 80); if (!hp) return reply(c, '400 Bad Request', 'bad target');
      try { site = await dial(hp[0], hp[1]); } catch (e) { return reply(c, '502 Bad Gateway', e.message || e); }
      st.tunnels++; socks.add(site); site.on('close', () => socks.delete(site)); site.on('error', () => c.destroy()); c.on('close', () => site.destroy());
      // (The proxy's own headers — Proxy-Authorization above all — never reach the site.)
      const keep = headers.filter((h) => { const k = h.split(':')[0].trim().toLowerCase(); return !k.startsWith('proxy-') && k !== 'connection' && k !== 'keep-alive'; });
      site.write(`${method} ${p} ${ver}\r\n${keep.map((h) => h + '\r\n').join('')}Connection: close\r\n\r\n`); if (rest.length) site.write(rest); c.pipe(site); site.pipe(c); c.resume();
    };
    c.on('data', onData); c.on('close', () => clearTimeout(headTimer));
  });
  return new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '127.0.0.1', () => { const a = server.address(); st.port = a.port; st.host = a.address; st.address = `http://127.0.0.1:${st.port}`; st.url = `http://${user}:${pass}@127.0.0.1:${st.port}`; st.close = () => new Promise((done) => { for (const s of socks) s.destroy(); socks.clear(); server.close(() => done()); }); ok(st); }); });
}

module.exports = { filters, probeIds, MAX_CONNS, PROVIDERS, PROBE_NAME, validateCustom, parseChoice, order, probeDue, isLocalName, addressOk, Cache, encodeQuery, decodeStrict, Refused, post, DohChain, trackerRewrite, trackerHost, magnetRewrite, magnetHosts, startProxy, hostOf, isOnDevice, FAIL_FORGET_S, NEG_TTL_S, TTL_MIN_S, TTL_MAX_S, CACHE_MAX };
