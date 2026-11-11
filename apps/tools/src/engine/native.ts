// The phone's engine: the app's own plugin (KtPlugin.java — libtorrent for torrents, the multi-connection
// downloader for files), in a foreground service, with a local stream for playing while a file comes.
import type { AddOptions, Engine, Limits, Task, TaskSource, TorrentDetail, TorrentInfo } from './types';
import { ktPlugin, listen, type KtPlugin } from '../native';

export class NativeEngine implements Engine {
  readonly id = 'native' as const;
  readonly can = { torrents: true, http: true, stream: true, limits: true, pickFiles: true, pause: true, seeding: true };
  private subs = new Set<(t: Task[]) => void>(); private sub: { remove(): void } | null = null; private subbing = false;
  constructor(private p: KtPlugin) {}
  static here(): NativeEngine | null { const p = ktPlugin(); return p ? new NativeEngine(p) : null; }
  async list() { return (await this.p.list()).tasks as Task[]; }
  async add(o: AddOptions) { { const C = await import('../downloads/cloud'); if (C.maybeCloud(o.source.url)) { const tk = await C.addVia(this, o); if (tk) return tk; } } const { withConnections } = await import('./connections'); return (await this.p.add(withConnections(o) as unknown as Record<string, unknown>)).task as Task; }
  pause(id: string) { return this.p.pause({ id }); }
  resume(id: string, anyway?: boolean) { return this.p.resume(anyway ? { id, anyway } : { id }); }
  remove(id: string, deleteFiles: boolean) { return this.p.remove({ id, deleteFiles }); }
  setFiles(id: string, priorities: (0 | 1 | 2)[]) { return this.p.setFiles({ id, priorities }); }
  setSequential(id: string, on: boolean) { return this.p.setSequential({ id, on }); }
  async torrentDetail(id: string) { return (await this.p.torrentDetail({ id })) as TorrentDetail; }
  recheck(id: string) { return this.p.recheck({ id }); }
  reannounce(id: string) { return this.p.reannounce({ id }); }
  async addTrackers(id: string, urls: string[]) { return (await this.p.addTrackers({ id, urls })).added; }
  setTaskLimits(id: string, down: number, up: number) { return this.p.setTaskLimits({ id, down, up }); }
  setLimits(l: Limits) { return this.p.setLimits(l); }
  setUrl(id: string, url: string, headers?: Record<string, string>) { return this.p.setUrl({ id, url, headers }); }
  move(id: string, how: -2 | -1 | 1 | 2) { return this.p.move({ id, how }); }
  async torrentInfo(source: TaskSource) { return (await this.p.torrentInfo({ source })).info as TorrentInfo; }
  async streamUrl(id: string, fileIndex: number) { return (await this.p.streamUrl({ id, fileIndex })).url; }
  open(id: string, fileIndex?: number) { return this.p.open({ id, fileIndex }) as Promise<void | { opened?: boolean; dir?: string }>; }
  rename(id: string, name: string) { return (this.p as unknown as { rename(o: { id: string; name: string }): Promise<{ name: string }> }).rename({ id, name }).then((r) => r.name); }
  onChange(fn: (tasks: Task[]) => void): () => void {
    this.subs.add(fn);
    if (!this.sub && !this.subbing) { this.subbing = true; void listen<{ tasks: Task[] }>(this.p as never, 'tasksChanged', (ev) => { for (const f of this.subs) f(ev.tasks); }).then((s) => { this.sub = s; }).catch((e) => { this.subbing = false; console.warn('[tools] tasksChanged', e); }); }
    void this.list().then((t) => fn(t)).catch(() => undefined);
    return () => { this.subs.delete(fn); };
  }
}
