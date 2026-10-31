// aria2 over JSON-RPC (HTTP POST, or WebSocket when the address is ws:// / wss://): a remote aria2 the user points
// the app at. Every aria2 download is a Task here; its GID is the id.
import type { AddOptions, Engine, Limits, Task, TaskFile, TaskSource, TaskState, TorrentInfo } from './types';

type Status = { gid: string; status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed'; totalLength: string; completedLength: string; uploadLength: string; downloadSpeed: string; uploadSpeed: string; infoHash?: string; numSeeders?: string; connections: string; seeder?: string; errorCode?: string; errorMessage?: string; dir: string; files: { index: string; path: string; length: string; completedLength: string; selected: string; uris: { uri: string }[] }[]; bittorrent?: { info?: { name?: string }; announceList?: string[][] }; followedBy?: string[]; following?: string };

export class Aria2Rpc {
  private seq = 0; private ws: WebSocket | null = null; private waiting = new Map<string, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  constructor(public url: string, public secret = '') {}
  private get token(): string[] { return this.secret ? [`token:${this.secret}`] : []; }
  async call<T>(method: string, ...params: unknown[]): Promise<T> {
    const id = String(++this.seq);
    const body = { jsonrpc: '2.0', id, method: `aria2.${method}`, params: [...this.token, ...params] };
    if (/^wss?:/.test(this.url)) return this.overWs<T>(body);
    const r = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result as T;
  }
  private overWs<T>(body: { id: string }): Promise<T> {
    return new Promise<T>((ok, fail) => {
      const send = () => { this.waiting.set(body.id, { ok: ok as (v: unknown) => void, fail }); this.ws!.send(JSON.stringify(body)); };
      if (this.ws && this.ws.readyState === WebSocket.OPEN) { send(); return; }
      if (!this.ws || this.ws.readyState > WebSocket.OPEN) {
        this.ws = new WebSocket(this.url);
        this.ws.onmessage = (ev) => { try { const j = JSON.parse(String(ev.data)) as { id?: string; result?: unknown; error?: { message: string } }; const w = j.id ? this.waiting.get(j.id) : undefined; if (!w) return; this.waiting.delete(j.id!); if (j.error) w.fail(new Error(j.error.message)); else w.ok(j.result); } catch { /* not for us */ } };
        this.ws.onerror = () => { for (const w of this.waiting.values()) w.fail(new Error('aria2 websocket')); this.waiting.clear(); };
        this.ws.onclose = () => { this.ws = null; };
      }
      this.ws.addEventListener('open', send, { once: true });
      this.ws.addEventListener('error', () => fail(new Error('aria2 unreachable')), { once: true });
    });
  }
  version(): Promise<{ version: string }> { return this.call('getVersion'); }
}

const num = (s: string | undefined) => Number(s ?? 0) || 0;
const nameOf = (st: Status): string => st.bittorrent?.info?.name || (st.files[0]?.path ? st.files[0].path.split(/[\\/]/).pop()! : st.files[0]?.uris[0]?.uri?.split('/').pop() || st.gid);
const stateOf = (st: Status): TaskState => st.status === 'active' ? (st.bittorrent && num(st.completedLength) >= num(st.totalLength) && num(st.totalLength) > 0 ? 'seeding' : num(st.totalLength) === 0 && st.bittorrent ? 'metadata' : 'downloading') : st.status === 'waiting' ? 'queued' : st.status === 'paused' ? 'paused' : st.status === 'complete' ? 'done' : st.status === 'error' ? 'failed' : 'failed';

export function taskOfStatus(st: Status, keep: Record<string, Partial<Task>> = {}): Task {
  const extra = keep[st.gid] ?? {};
  const files: TaskFile[] = st.files.map((f) => ({ index: Number(f.index) - 1, path: f.path.replace(st.dir.replace(/[\\/]+$/, '') + '/', '').replace(/^[\\/]+/, ''), size: num(f.length), done: num(f.completedLength), priority: f.selected === 'true' ? 1 : 0 }));
  const total = num(st.totalLength), done = num(st.completedLength), speed = num(st.downloadSpeed);
  const source: TaskSource = st.bittorrent ? (st.infoHash ? { magnet: `magnet:?xt=urn:btih:${st.infoHash}` } : {}) : { url: st.files[0]?.uris[0]?.uri };
  return {
    id: st.gid, kind: st.bittorrent ? 'torrent' : 'http', name: extra.name || nameOf(st), source: extra.source ?? source, dir: st.dir, state: stateOf(st), done, total,
    downSpeed: speed, upSpeed: num(st.uploadSpeed), eta: speed > 0 && total > done ? Math.round((total - done) / speed) : undefined,
    peers: st.bittorrent ? num(st.connections) : undefined, seeds: st.numSeeders !== undefined ? num(st.numSeeders) : undefined, connections: st.bittorrent ? undefined : num(st.connections),
    infoHash: st.infoHash, files, error: st.status === 'error' ? `${st.errorMessage ?? ''} (${st.errorCode})` : undefined, addedAt: extra.addedAt ?? Date.now(), doneAt: st.status === 'complete' ? extra.doneAt ?? Date.now() : undefined, meta: extra.meta, engine: 'aria2',
  };
}

const KEEP = 'kt.aria2.keep';
/** The remote aria2 as an Engine. What aria2 does not keep (the name shown, the meta, when added) is kept here. */
export class Aria2Engine implements Engine {
  readonly id = 'aria2' as const;
  readonly can = { torrents: true, http: true, stream: false, limits: true, pickFiles: true, pause: true, seeding: true };
  private keep: Record<string, Partial<Task>> = {};
  private subs = new Set<(t: Task[]) => void>(); private timer = 0; private last: Task[] = [];
  constructor(public rpc: Aria2Rpc) { try { this.keep = JSON.parse(localStorage.getItem(KEEP) ?? '{}'); } catch { /* none */ } }
  private save() { try { localStorage.setItem(KEEP, JSON.stringify(this.keep)); } catch { /* full */ } }
  async list(): Promise<Task[]> {
    const [a, w, s] = await Promise.all([this.rpc.call<Status[]>('tellActive'), this.rpc.call<Status[]>('tellWaiting', 0, 1000), this.rpc.call<Status[]>('tellStopped', 0, 1000)]);
    // (A magnet's metadata download is followed by the real one: the first is left out once the second exists.)
    const all = [...a, ...w, ...s].filter((st) => !(st.followedBy?.length && num(st.totalLength) === 0));
    this.last = all.map((st) => taskOfStatus(st, this.keep)).sort((x, y) => y.addedAt - x.addedAt);
    return this.last;
  }
  async add(o: AddOptions): Promise<Task> {
    const opts: Record<string, string> = {};
    if (o.dir) opts.dir = o.dir; if (o.name && o.source.url) opts.out = o.name; if (o.paused) opts.pause = 'true';
    if (o.connections) { opts.split = String(o.connections); opts['max-connection-per-server'] = String(Math.min(16, o.connections)); }
    if (o.files?.length) opts['select-file'] = o.files.map((i) => i + 1).join(',');
    if (o.sequential) opts['bt-prioritize-piece'] = 'head=16M,tail=4M';
    if (o.source.headers) opts.header = Object.entries(o.source.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    let gid: string;
    if (o.source.torrent) gid = await this.rpc.call<string>('addTorrent', o.source.torrent, [], opts);
    else gid = await this.rpc.call<string>('addUri', [o.source.magnet ?? o.source.url!], opts);
    this.keep[gid] = { name: o.name, source: o.source, addedAt: Date.now(), meta: o.meta }; this.save();
    const st = await this.rpc.call<Status>('tellStatus', gid);
    const t = taskOfStatus(st, this.keep); this.poke(); return t;
  }
  pause(id: string) { return this.rpc.call<string>('pause', id).then(() => this.poke()); }
  resume(id: string) { return this.rpc.call<string>('unpause', id).then(() => this.poke()); }
  async remove(id: string, deleteFiles: boolean): Promise<void> {
    const st = await this.rpc.call<Status>('tellStatus', id).catch(() => null);
    if (st && (st.status === 'active' || st.status === 'waiting' || st.status === 'paused')) await this.rpc.call('forceRemove', id).catch(() => undefined);
    await this.rpc.call('removeDownloadResult', id).catch(() => undefined);
    // (Files on the other machine cannot be deleted from here; said in the capability — aria2 has no RPC for it.)
    void deleteFiles; delete this.keep[id]; this.save(); this.poke();
  }
  setFiles(id: string, priorities: (0 | 1 | 2)[]) { return this.rpc.call('changeOption', id, { 'select-file': priorities.map((p, i) => (p ? i + 1 : 0)).filter(Boolean).join(',') }).then(() => this.poke()); }
  setLimits(l: Limits) { return this.rpc.call('changeGlobalOption', { 'max-overall-download-limit': String(l.down), 'max-overall-upload-limit': String(l.up) }).then(() => undefined); }
  async torrentInfo(source: TaskSource): Promise<TorrentInfo> {
    const opts = { 'bt-metadata-only': 'true', 'bt-save-metadata': 'false', pause: 'false' };
    const gid = source.torrent ? await this.rpc.call<string>('addTorrent', source.torrent, [], { pause: 'true' }) : await this.rpc.call<string>('addUri', [source.magnet!], opts);
    const until = Date.now() + 60000;
    try {
      for (;;) {
        const st = await this.rpc.call<Status>('tellStatus', gid);
        if (st.bittorrent?.info?.name && num(st.totalLength) > 0) return { name: st.bittorrent.info.name, infoHash: st.infoHash ?? '', total: num(st.totalLength), files: st.files.map((f) => ({ index: Number(f.index) - 1, path: f.path.replace(st.dir + '/', ''), size: num(f.length) })) };
        if (st.status === 'error') throw new Error(st.errorMessage ?? 'aria2');
        if (Date.now() > until) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 800));
      }
    } finally { await this.rpc.call('forceRemove', gid).catch(() => undefined); await this.rpc.call('removeDownloadResult', gid).catch(() => undefined); }
  }
  onChange(fn: (tasks: Task[]) => void): () => void {
    this.subs.add(fn); this.poke();
    return () => { this.subs.delete(fn); if (!this.subs.size) { clearTimeout(this.timer); this.timer = 0; } };
  }
  private poke(): void {
    if (!this.subs.size) return;
    clearTimeout(this.timer);
    const tick = async () => {
      try { const tasks = await this.list(); for (const fn of this.subs) fn(tasks); const moving = tasks.some((t) => t.state === 'downloading' || t.state === 'metadata' || t.state === 'seeding' || t.state === 'queued'); this.timer = window.setTimeout(tick, moving ? 1000 : 5000); }
      catch { this.timer = window.setTimeout(tick, 5000); }
    };
    this.timer = window.setTimeout(tick, 0);
  }
}
