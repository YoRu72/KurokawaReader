// The phone's engine: the app's own plugin (KtPlugin.java — libtorrent for torrents, the multi-connection
// downloader for files), in a foreground service, with a local stream for playing while a file comes.
import type { AddOptions, Engine, Limits, Task, TaskSource, TorrentInfo } from './types';
import { ktPlugin, type KtPlugin } from '../native';

export class NativeEngine implements Engine {
  readonly id = 'native' as const;
  readonly can = { torrents: true, http: true, stream: true, limits: true, pickFiles: true, pause: true, seeding: true };
  private subs = new Set<(t: Task[]) => void>(); private sub: { remove(): void } | null = null;
  constructor(private p: KtPlugin) {}
  static here(): NativeEngine | null { const p = ktPlugin(); return p ? new NativeEngine(p) : null; }
  async list() { return (await this.p.list()).tasks as Task[]; }
  async add(o: AddOptions) { return (await this.p.add(o as unknown as Record<string, unknown>)).task as Task; }
  pause(id: string) { return this.p.pause({ id }); }
  resume(id: string) { return this.p.resume({ id }); }
  remove(id: string, deleteFiles: boolean) { return this.p.remove({ id, deleteFiles }); }
  setFiles(id: string, priorities: (0 | 1 | 2)[]) { return this.p.setFiles({ id, priorities }); }
  setSequential(id: string, on: boolean) { return this.p.setSequential({ id, on }); }
  setLimits(l: Limits) { return this.p.setLimits(l); }
  async torrentInfo(source: TaskSource) { return (await this.p.torrentInfo({ source })).info as TorrentInfo; }
  async streamUrl(id: string, fileIndex: number) { return (await this.p.streamUrl({ id, fileIndex })).url; }
  open(id: string, fileIndex?: number) { return this.p.open({ id, fileIndex }); }
  onChange(fn: (tasks: Task[]) => void): () => void {
    this.subs.add(fn);
    if (!this.sub) void this.p.addListener('tasksChanged', ((ev: { tasks: Task[] }) => { for (const f of this.subs) f(ev.tasks); }) as never).then((s) => { this.sub = s; });
    void this.list().then((t) => fn(t)).catch(() => undefined);
    return () => { this.subs.delete(fn); };
  }
}
