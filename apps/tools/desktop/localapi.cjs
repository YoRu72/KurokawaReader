// The local API (a computer): a small HTTP server on 127.0.0.1 that lets a command line, a script or a browser
// extension add downloads and read the queue — behind a token the app shows in its settings, and only when the
// reader turned it on. Nothing listens until then; nothing is reachable from other machines.
const http = require('node:http'); const crypto = require('node:crypto');
let server = null; let token = ''; let port = 0;
function start(opts, api) {
  stop(); token = opts.token || crypto.randomBytes(16).toString('hex'); port = Number(opts.port) || 8977;
  server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || new URL(req.url, 'http://x').searchParams.get('token') || '';
    if (!token || auth !== token) { res.writeHead(401, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'token' })); return; }
    const url = new URL(req.url, 'http://127.0.0.1'); let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1 << 20) req.destroy(); });
    req.on('end', async () => {
      const json = (code, obj) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      try {
        if (req.method === 'GET' && url.pathname === '/tasks') return json(200, { tasks: api.tasks().map((x) => ({ id: x.id, kind: x.kind, name: x.name, state: x.state, done: x.done, total: x.total, downSpeed: x.downSpeed, dir: x.dir })) });
        if (req.method === 'GET' && url.pathname === '/version') return json(200, { app: 'Kurokawa Tools', version: api.version() });
        if (req.method === 'POST' && url.pathname === '/add') { const o = body ? JSON.parse(body) : {}; const urls = Array.isArray(o.urls) ? o.urls : o.url ? [o.url] : []; if (!urls.length) return json(400, { error: 'url' }); const ids = []; for (const u of urls) { const t = await api.add({ url: String(u), dir: o.dir, video: !!o.video, audio: !!o.audio, name: o.name, paused: !!o.paused }); ids.push(t && t.id); } return json(200, { added: ids }); }
        if (req.method === 'POST' && /^\/tasks\/[^/]+\/(pause|resume|remove)$/.test(url.pathname)) { const [, , id, act] = url.pathname.split('/'); await api.act(id, act); return json(200, { ok: true }); }
        json(404, { error: 'route' });
      } catch (e) { json(500, { error: String(e && e.message || e) }); }
    });
  });
  server.listen(port, '127.0.0.1'); server.on('error', () => { server = null; });
  return { token, port };
}
function stop() { if (server) { try { server.close(); } catch { /* none */ } server = null; } }
function state() { return { on: !!server, token, port }; }
module.exports = { start, stop, state };
