// aria2's JSON-RPC over a WebSocket (Node 22 has one built in), with a fallback to HTTP POST. Used for the aria2c
// the app runs beside itself; the same client could speak to a remote aria2.
'use strict';

class Aria2Rpc {
  constructor(url, secret = '') { this.url = url; this.secret = secret; this.seq = 0; this.ws = null; this.waiting = new Map(); this.onNotify = null; }
  get token() { return this.secret ? [`token:${this.secret}`] : []; }
  async call(method, ...params) {
    const id = String(++this.seq);
    const body = { jsonrpc: '2.0', id, method: `aria2.${method}`, params: [...this.token, ...params] };
    if (/^wss?:/.test(this.url) && typeof WebSocket === 'function') return this.overWs(body);
    const r = await fetch(this.url.replace(/^ws/, 'http'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
  overWs(body) {
    return new Promise((ok, fail) => {
      const send = () => { this.waiting.set(body.id, { ok, fail }); this.ws.send(JSON.stringify(body)); };
      if (this.ws && this.ws.readyState === 1) { send(); return; }
      if (!this.ws || this.ws.readyState > 1) {
        this.ws = new WebSocket(this.url);
        this.ws.onmessage = (ev) => { try { const j = JSON.parse(String(ev.data)); if (j.id !== undefined && j.id !== null) { const w = this.waiting.get(String(j.id)); if (!w) return; this.waiting.delete(String(j.id)); if (j.error) w.fail(new Error(j.error.message)); else w.ok(j.result); } else if (j.method && this.onNotify) this.onNotify(j.method, j.params); } catch { /* not ours */ } };
        this.ws.onerror = () => { for (const w of this.waiting.values()) w.fail(new Error('aria2 websocket')); this.waiting.clear(); };
        this.ws.onclose = () => { this.ws = null; };
      }
      this.ws.addEventListener('open', send, { once: true });
      this.ws.addEventListener('error', () => fail(new Error('aria2 unreachable')), { once: true });
    });
  }
  close() { try { this.ws?.close(); } catch { /* gone */ } this.ws = null; }
}
module.exports = { Aria2Rpc };
