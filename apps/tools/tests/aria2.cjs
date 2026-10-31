// node tests/aria2.cjs: the desktop engine's mapping of aria2's answers into tasks, against a fake aria2 RPC
// (HTTP) — add (magnet, link, torrent with chosen files), list (a metadata task hidden behind its follower),
// pause/resume/remove, torrentInfo, limits.
const http = require('http'); const path = require('path'); const fs = require('fs'); const os = require('os');
const { Aria2Engine } = require('../desktop/aria2.cjs');
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const calls = []; const downloads = new Map(); let gid = 0;
const server = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
  const j = JSON.parse(b); const m = j.method.replace('aria2.', ''); const p = j.params.slice(1); calls.push(m);
  const reply = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result })); };
  const st = (g) => downloads.get(g);
  switch (m) {
    case 'getVersion': return reply({ version: '1.37.0' });
    case 'addUri': { const g = String(++gid).padStart(16, '0'); const uri = p[0][0]; const isMag = uri.startsWith('magnet:'); downloads.set(g, { gid: g, status: p[1]?.pause === 'true' ? 'paused' : 'active', totalLength: isMag ? '0' : '1000000', completedLength: isMag ? '0' : '250000', downloadSpeed: '50000', uploadSpeed: '0', connections: '4', dir: '/dl', files: [{ index: '1', path: isMag ? '' : '/dl/file.zip', length: isMag ? '0' : '1000000', completedLength: '250000', selected: 'true', uris: [{ uri }] }], ...(isMag ? { bittorrent: {}, infoHash: 'abc', followedBy: p[1]?.['bt-metadata-only'] ? undefined : ['f' + g] } : {}) }); if (isMag && !p[1]?.['bt-metadata-only']) downloads.set('f' + g, { gid: 'f' + g, status: 'active', totalLength: '5000000', completedLength: '1000000', downloadSpeed: '100000', uploadSpeed: '1000', connections: '12', numSeeders: '7', dir: '/dl', infoHash: 'abc', following: g, bittorrent: { info: { name: 'Test Torrent' } }, files: [{ index: '1', path: '/dl/Test Torrent/a.mkv', length: '4000000', completedLength: '1000000', selected: 'true', uris: [] }, { index: '2', path: '/dl/Test Torrent/b.txt', length: '1000000', completedLength: '0', selected: 'false', uris: [] }] }); if (isMag && p[1]?.['bt-metadata-only']) Object.assign(st(g), { totalLength: '5000000', bittorrent: { info: { name: 'Meta Torrent' } }, files: [{ index: '1', path: '/dl/Meta Torrent/x.mkv', length: '5000000', completedLength: '0', selected: 'true', uris: [] }] }); return reply(g); }
    case 'addTorrent': { const g = String(++gid).padStart(16, '0'); downloads.set(g, { gid: g, status: 'active', totalLength: '300', completedLength: '0', downloadSpeed: '0', uploadSpeed: '0', connections: '0', dir: '/dl', infoHash: 'def', bittorrent: { info: { name: 'From File' } }, files: [{ index: '1', path: '/dl/From File/1', length: '100', completedLength: '0', selected: p[2]?.['select-file']?.includes('1') ? 'true' : 'false', uris: [] }, { index: '2', path: '/dl/From File/2', length: '200', completedLength: '0', selected: p[2]?.['select-file']?.includes('2') ? 'true' : 'false', uris: [] }] }); return reply(g); }
    case 'tellStatus': return reply(st(p[0]));
    case 'tellActive': return reply([...downloads.values()].filter((d) => d.status === 'active'));
    case 'tellWaiting': return reply([...downloads.values()].filter((d) => d.status === 'waiting' || d.status === 'paused'));
    case 'tellStopped': return reply([...downloads.values()].filter((d) => ['complete', 'error', 'removed'].includes(d.status)));
    case 'pause': st(p[0]).status = 'paused'; return reply(p[0]);
    case 'unpause': st(p[0]).status = 'active'; return reply(p[0]);
    case 'forceRemove': st(p[0]).status = 'removed'; return reply(p[0]);
    case 'removeDownloadResult': downloads.delete(p[0]); return reply('OK');
    case 'changeOption': return reply('OK');
    case 'changeGlobalOption': calls.push(JSON.stringify(p[0])); return reply('OK');
    default: return reply('OK');
  }
}); });
(async () => {
  await new Promise((r) => server.listen(6899, '127.0.0.1', r));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-')); const e = new Aria2Engine({ userData: ud, resources: ud, defaultDir: path.join(ud, 'dl') });
  e.rpc = new (require('../desktop/aria2rpc.cjs').Aria2Rpc)('http://127.0.0.1:6899/jsonrpc', 's'); e.available = true;
  const link = await e.add({ source: { url: 'https://example.org/file.zip' }, connections: 8 });
  ok('a link becomes an http task with its progress', link.kind === 'http' && link.state === 'downloading' && link.total === 1000000 && link.done === 250000 && link.name === 'file.zip' && link.connections === 4 && link.eta === 15);
  const mag = await e.add({ source: { magnet: 'magnet:?xt=urn:btih:abc' }, sequential: true, meta: { title: 'T' } });
  ok('a magnet becomes a torrent task', mag.kind === 'torrent' && mag.state === 'metadata');
  const list = await e.list();
  const follower = list.find((t) => t.id.startsWith('f'));
  ok('the list hides the metadata task behind the real one, which inherits the meta', !list.some((t) => t.id === mag.id) && !!follower && follower.name === 'Test Torrent' && follower.meta?.title === 'T' && follower.seeds === 7 && follower.peers === 12 && follower.files.length === 2 && follower.files[0].path === 'Test Torrent/a.mkv' && follower.files[1].priority === 0);
  await e.pause(follower.id); ok('pause', (await e.list()).find((t) => t.id === follower.id).state === 'paused');
  await e.resume(follower.id); ok('resume', (await e.list()).find((t) => t.id === follower.id).state === 'downloading');
  const tf = await e.add({ source: { torrent: 'ZmFrZQ==' }, files: [1] });
  ok('a .torrent with chosen files: only those selected', tf.files[0].priority === 0 && tf.files[1].priority === 1 && tf.name === 'From File');
  const info = await e.torrentInfo({ magnet: 'magnet:?xt=urn:btih:meta' });
  ok('torrentInfo reads the metadata then removes the task', info.name === 'Meta Torrent' && info.total === 5000000 && info.files.length === 1 && calls.includes('forceRemove'));
  await e.setLimits({ down: 1024, up: 0 }); ok('limits go to aria2 as global options', calls.some((c) => c.includes('"max-overall-download-limit":"1024"')));
  await e.remove(link.id, false); ok('remove', !(await e.list()).some((t) => t.id === link.id));
  console.log(fails ? `${fails} FAILED` : 'all passed');
  server.close(); process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
