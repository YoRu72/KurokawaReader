// The desktop engine: aria2c beside the app (resources/aria2/<platform>/aria2c, or one on the PATH) spawned with
// RPC on a free port and a secret, its session saved; every download a Task of the shape the page knows.
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { Aria2Rpc } = require('./aria2rpc.cjs');

const num = (s) => Number(s ?? 0) || 0;

/** aria2's piece bitfield as segments of done bytes (runs of finished pieces), for the details page's file map. */
function piecesToSegments(st) {
  const bits = st.bitfield; const n = Number(st.numPieces) || 0; const len = Number(st.pieceLength) || 0; const total = Number(st.totalLength) || 0; if (!bits || !n || !len) return undefined;
  const out = []; let run = -1;
  for (let i = 0; i <= n; i++) { const on = i < n && ((parseInt(bits[i >> 2], 16) >> (3 - (i & 3))) & 1); if (on && run < 0) run = i; else if (!on && run >= 0) { out.push({ start: run * len, pos: Math.min(total, i * len), end: Math.min(total, i * len), active: false, worker: 0 }); run = -1; } }
  return out.slice(0, 400);
}
class Aria2Engine {
  constructor(o) {
    this.userData = o.userData; this.resources = o.resources; this.defaultDir = o.defaultDir;
    this.keepFile = path.join(this.userData, 'tasks.json');
    try { this.keep = JSON.parse(fs.readFileSync(this.keepFile, 'utf8')); } catch { this.keep = {}; }
    this.config = Object.assign({ seed: false, listenPort: 0, maxConnections: 8 }, this.readConfig());
    this.proc = null; this.rpc = null; this.available = false; this.reason = ''; this.subs = new Set(); this.timer = null; this.last = [];
  }
  readConfig() { try { return JSON.parse(fs.readFileSync(path.join(this.userData, 'aria2-config.json'), 'utf8')); } catch { return {}; } }
  saveConfig() { try { fs.writeFileSync(path.join(this.userData, 'aria2-config.json'), JSON.stringify(this.config)); } catch { /* ignore */ } }
  saveKeep() { try { fs.writeFileSync(this.keepFile, JSON.stringify(this.keep)); } catch { /* ignore */ } }

  /** The binary: the one shipped for this platform, else one on the PATH. */
  binary() {
    const plat = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
    const exe = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';
    for (const p of [path.join(this.resources, 'aria2', `${plat}-${process.arch}`, exe), path.join(this.resources, 'aria2', plat, exe)]) if (fs.existsSync(p)) return p;
    try { const r = spawnSync(exe, ['--version'], { timeout: 4000, windowsHide: true }); if (r.status === 0) return exe; } catch { /* none */ }
    return null;
  }
  static freePort() { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); }); }

  async start() {
    const bin = this.binary();
    if (!bin) { this.available = false; this.reason = process.platform === 'darwin' ? 'aria2c is not bundled for macOS: install it with Homebrew (brew install aria2), or set up a remote aria2 in Settings.' : 'aria2c missing'; return false; }
    const port = await Aria2Engine.freePort(); const secret = crypto.randomBytes(12).toString('hex');
    fs.mkdirSync(this.defaultDir, { recursive: true });
    const sessionFile = path.join(this.userData, 'aria2.session'); if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, '');
    const args = ['--enable-rpc', `--rpc-listen-port=${port}`, `--rpc-secret=${secret}`, '--rpc-listen-all=false', '--rpc-allow-origin-all=false', '--continue=true', `--max-connection-per-server=${Math.min(16, this.config.maxConnections)}`, `--split=${Math.min(16, this.config.maxConnections)}`, '--min-split-size=1M', '--max-concurrent-downloads=5', '--bt-save-metadata=true', '--bt-load-saved-metadata=true', `--seed-time=${this.config.seed ? 0 : 0}`, `--seed-ratio=${this.config.seed ? 0 : 0.0}`, `--dir=${this.defaultDir}`, `--save-session=${sessionFile}`, `--input-file=${sessionFile}`, '--save-session-interval=30', '--enable-dht=true', '--enable-dht6=true', '--bt-enable-lpd=true', '--follow-torrent=true', '--file-allocation=none', '--check-certificate=false', '--user-agent=KurokawaTools/0.1 aria2', '--summary-interval=0', '--console-log-level=warn', '--quiet=true', '--bt-detach-seed-only=true', '--auto-file-renaming=true', '--allow-overwrite=false', '--max-tries=5', '--retry-wait=3', '--dht-file-path=' + path.join(this.userData, 'dht.dat'), '--dht-file-path6=' + path.join(this.userData, 'dht6.dat')];
    if (this.config.listenPort > 0) { args.push(`--listen-port=${this.config.listenPort}`, `--dht-listen-port=${this.config.listenPort}`); } else { args.push('--listen-port=6881-6999', '--dht-listen-port=6881-6999'); }
    // Senpwai's torrent options: peer discovery, encryption, and when seeding stops.
    const c = this.config; if (!c.seed) args.push('--seed-time=0'); else args.push(`--seed-ratio=${c.seedRatio > 0 ? c.seedRatio : '0.0'}`, ...(c.seedMinutes > 0 ? [`--seed-time=${c.seedMinutes}`] : []));
    if (c.dht === false) args.push('--enable-dht=false', '--enable-dht6=false'); if (c.lsd === false) args.push('--bt-enable-lpd=false'); else args.push('--bt-enable-lpd=true');
    if (c.enc === 'forced') args.push('--bt-require-crypto=true', '--bt-min-crypto-level=arc4');
    this.proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stderr.on('data', (d) => console.warn('[aria2c]', String(d).trim()));
    this.proc.on('exit', (code) => { console.warn('[aria2c] exited', code); this.available = false; this.reason = `aria2c exited (${code})`; this.proc = null; });
    this.rpc = new Aria2Rpc(`ws://127.0.0.1:${port}/jsonrpc`, secret);
    this.rpc.onNotify = () => this.tick();
    for (let i = 0; i < 40; i++) { try { await this.rpc.call('getVersion'); this.available = true; this.reason = ''; break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
    if (!this.available) { this.reason = 'aria2c did not answer'; return false; }
    this.loop();
    return true;
  }
  stop() { try { this.rpc?.call('saveSession').catch(() => {}); } catch { /* ignore */ } try { this.rpc?.close(); } catch { /* ignore */ } if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; } }

  /* ---------- tasks ---------- */
  nameOf(st) { return st.bittorrent?.info?.name || (st.files?.[0]?.path ? path.basename(st.files[0].path) : (st.files?.[0]?.uris?.[0]?.uri || '').split('/').pop()) || st.gid; }
  stateOf(st) {
    if (st.status === 'active') { if (st.bittorrent && num(st.totalLength) === 0) return 'metadata'; if (st.bittorrent && num(st.totalLength) > 0 && num(st.completedLength) >= num(st.totalLength)) return 'seeding'; return 'downloading'; }
    if (st.status === 'waiting') return 'queued'; if (st.status === 'paused') return 'paused'; if (st.status === 'complete') return 'done'; return 'failed';
  }
  task(st) {
    const extra = this.keep[st.gid] || {}; const total = num(st.totalLength), done = num(st.completedLength), speed = num(st.downloadSpeed);
    const dir = (st.dir || '').replace(/[\\/]+$/, '');
    return {
      id: st.gid, kind: st.bittorrent ? 'torrent' : 'http', name: extra.name || this.nameOf(st), source: extra.source || (st.bittorrent ? (st.infoHash ? { magnet: `magnet:?xt=urn:btih:${st.infoHash}` } : {}) : { url: st.files?.[0]?.uris?.[0]?.uri }),
      dir, state: this.stateOf(st), done, total, downSpeed: speed, upSpeed: num(st.uploadSpeed), eta: speed > 0 && total > done ? Math.round((total - done) / speed) : undefined,
      peers: st.bittorrent ? num(st.connections) : undefined, seeds: st.numSeeders !== undefined ? num(st.numSeeders) : undefined, connections: st.bittorrent ? undefined : num(st.connections), infoHash: st.infoHash,
      files: (st.files || []).map((f) => ({ index: Number(f.index) - 1, path: (f.path || '').startsWith(dir) ? f.path.slice(dir.length).replace(/^[\\/]+/, '') : f.path, size: num(f.length), done: num(f.completedLength), priority: f.selected === 'true' ? 1 : 0 })),
      segments: st.status === 'active' && !st.bittorrent ? piecesToSegments(st) : undefined,
      error: st.status === 'error' ? `${st.errorMessage || ''} (${st.errorCode})` : undefined, addedAt: extra.addedAt || Date.now(), doneAt: st.status === 'complete' ? extra.doneAt || Date.now() : undefined, meta: extra.meta, engine: 'native',
    };
  }
  async list() {
    if (!this.available) return [];
    const [a, w, s] = await Promise.all([this.rpc.call('tellActive'), this.rpc.call('tellWaiting', 0, 1000), this.rpc.call('tellStopped', 0, 1000)]);
    const all = [...a, ...w, ...s].filter((st) => !(st.followedBy?.length && num(st.totalLength) === 0) && !(st.status === 'complete' && st.followedBy?.length));
    for (const st of all) if (st.status === 'complete' && this.keep[st.gid] && !this.keep[st.gid].doneAt) { this.keep[st.gid].doneAt = Date.now(); this.saveKeep(); }
    // (A magnet's metadata task followed by the real download: the keep goes to the follower.)
    for (const st of [...a, ...w, ...s]) if (st.followedBy?.length && this.keep[st.gid]) for (const g of st.followedBy) if (!this.keep[g]) { this.keep[g] = { ...this.keep[st.gid] }; this.saveKeep(); }
    this.last = all.map((st) => this.task(st)).sort((x, y) => y.addedAt - x.addedAt);
    return this.last;
  }
  async add(o) {
    if (!this.available) throw new Error(this.reason || 'aria2c missing');
    const opts = {};
    if (o.dir) opts.dir = o.dir; if (o.name && o.source.url) opts.out = o.name; if (o.paused) opts.pause = 'true';
    if (o.connections) { opts.split = String(o.connections); opts['max-connection-per-server'] = String(Math.min(16, o.connections)); }
    if (o.files?.length) opts['select-file'] = o.files.map((i) => i + 1).join(',');
    if (o.sequential) opts['bt-prioritize-piece'] = 'head=16M,tail=4M';
    if (o.source.headers) opts.header = Object.entries(o.source.headers).map(([k, v]) => `${k}: ${v}`);
    const gid = o.source.torrent ? await this.rpc.call('addTorrent', o.source.torrent, [], opts) : await this.rpc.call('addUri', [o.source.magnet || o.source.url], opts);
    this.keep[gid] = { name: o.name, source: o.source, addedAt: Date.now(), meta: o.meta }; this.saveKeep();
    const st = await this.rpc.call('tellStatus', gid); this.tick();
    return this.task(st);
  }
  async pause(id) { await this.rpc.call('pause', id); this.tick(); }
  async resume(id) { await this.rpc.call('unpause', id); this.tick(); }
  async remove(id, deleteFiles) {
    const st = await this.rpc.call('tellStatus', id).catch(() => null);
    if (st && ['active', 'waiting', 'paused'].includes(st.status)) await this.rpc.call('forceRemove', id).catch(() => {});
    await this.rpc.call('removeDownloadResult', id).catch(() => {});
    if (deleteFiles && st) for (const f of st.files || []) { try { if (f.path && fs.existsSync(f.path)) fs.rmSync(f.path, { force: true }); if (f.path && fs.existsSync(f.path + '.aria2')) fs.rmSync(f.path + '.aria2', { force: true }); } catch { /* busy */ } }
    delete this.keep[id]; this.saveKeep(); this.tick();
  }
  async setFiles(id, priorities) { await this.rpc.call('changeOption', id, { 'select-file': priorities.map((p, i) => (p ? i + 1 : 0)).filter(Boolean).join(',') }); this.tick(); }
  async setLimits(l) { await this.rpc.call('changeGlobalOption', { 'max-overall-download-limit': String(l.down || 0), 'max-overall-upload-limit': String(l.up || 0) }); }
  async configure(o) { Object.assign(this.config, o); this.saveConfig(); if (o.maxConnections) await this.rpc.call('changeGlobalOption', { 'max-concurrent-downloads': String(Math.max(1, o.maxConnections)) }).catch(() => {}); if (o.seed !== undefined || o.seedRatio !== undefined || o.seedMinutes !== undefined) { const c = this.config; await this.rpc.call('changeGlobalOption', c.seed ? { 'seed-ratio': c.seedRatio > 0 ? String(c.seedRatio) : '0.0', 'seed-time': c.seedMinutes > 0 ? String(c.seedMinutes) : '525600' } : { 'seed-time': '0' }).catch(() => {}); } }
  async torrentInfo(source) {
    const gid = source.torrent ? await this.rpc.call('addTorrent', source.torrent, [], { pause: 'true' }) : await this.rpc.call('addUri', [source.magnet], { 'bt-metadata-only': 'true', 'bt-save-metadata': 'false' });
    const until = Date.now() + 60000;
    try {
      for (;;) {
        const st = await this.rpc.call('tellStatus', gid);
        if (st.bittorrent?.info?.name && num(st.totalLength) > 0) { const dir = (st.dir || '').replace(/[\\/]+$/, ''); return { name: st.bittorrent.info.name, infoHash: st.infoHash || '', total: num(st.totalLength), files: (st.files || []).map((f) => ({ index: Number(f.index) - 1, path: (f.path || '').startsWith(dir) ? f.path.slice(dir.length).replace(/^[\\/]+/, '') : f.path, size: num(f.length) })) }; }
        if (st.status === 'error') throw new Error(st.errorMessage || 'aria2');
        if (Date.now() > until) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 700));
      }
    } finally { await this.rpc.call('forceRemove', gid).catch(() => {}); await this.rpc.call('removeDownloadResult', gid).catch(() => {}); }
  }
  async fileOf(id, fileIndex) { const st = await this.rpc.call('tellStatus', id); const f = (st.files || [])[Math.max(0, fileIndex || 0)]; return f ? f.path : st.dir; }
  onTasks(fn) { this.subs.add(fn); this.tick(); return () => this.subs.delete(fn); }
  tick() { clearTimeout(this.timer); this.timer = setTimeout(() => this.loop(), 50); }
  async loop() {
    clearTimeout(this.timer);
    if (!this.available) return;
    try { const tasks = await this.list(); for (const fn of this.subs) fn(tasks); const moving = tasks.some((t) => ['downloading', 'metadata', 'seeding', 'queued'].includes(t.state)); this.timer = setTimeout(() => this.loop(), moving ? 700 : 4000); }
    catch { this.timer = setTimeout(() => this.loop(), 4000); }
  }
}
module.exports = { Aria2Engine };
