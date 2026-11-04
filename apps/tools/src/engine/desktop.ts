// The desktop app's engine: aria2c beside the app, spoken to by the Electron main process (desktop/aria2.cjs);
// the preload hands the renderer this bridge.
import { t } from '../i18n';
import type { AddOptions, Engine, Limits, Task, TaskSource, TorrentInfo } from './types';

export interface DesktopBridge {
  platform: 'desktop';
  available: boolean;
  reason?: string;
  os?: string;
  /** Resolves once the main process has said whether aria2c is there. */
  ready?(): Promise<unknown>;
  onUpdateProgress?(cb: (p: { pct: number; got: number; total: number }) => void): () => void;
  add(o: AddOptions): Promise<Task>;
  list(): Promise<Task[]>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string, deleteFiles: boolean): Promise<void>;
  setFiles(id: string, priorities: number[]): Promise<void>;
  setLimits(l: Limits): Promise<void>;
  setUrl?(id: string, url: string): Promise<string>;
  move?(id: string, how: number): Promise<void>;
  torrentInfo(source: TaskSource): Promise<TorrentInfo>;
  open(id: string, fileIndex?: number): Promise<void>;
  /** Watching while it downloads: the file served as its pieces come (desktop/torrentstream.cjs). */
  streamUrl?(o: { id: string; fileIndex: number }): Promise<{ url: string }>;
  defaultDir(): Promise<string>;
  pickDir(): Promise<string | null>;
  configure(o: { listenPort?: number; maxConnections?: number; seed?: boolean }): Promise<void>;
  onTasks(cb: (tasks: Task[]) => void): () => void;
  openExternal?(url: string): Promise<void>;
  registerMagnet?(): Promise<void>;
  checkUpdate?(o: { beta: boolean }): Promise<{ version: string; url: string; notes: string; asset?: string } | null>;
  installUpdate?(url: string): Promise<void>;
  readFile?(path: string): Promise<ArrayBuffer>;
  videoInfo?(o: { url: string; playlist?: boolean }): Promise<unknown>;
  videoReady?(): Promise<unknown>;
  videoVersion?(): Promise<{ version: string | null; ready: boolean }>;
  videoUpdate?(): Promise<{ version: string | null; updated?: boolean; latest?: string }>;
}

export class DesktopEngine implements Engine {
  readonly id = 'native' as const;
  readonly can: { torrents: boolean; http: boolean; stream: boolean; limits: boolean; pickFiles: boolean; pause: boolean; seeding: boolean };
  readonly streamUrl?: (id: string, fileIndex: number) => Promise<string>;
  constructor(private b: DesktopBridge) {
    this.can = { torrents: true, http: true, stream: !!b.streamUrl, limits: true, pickFiles: true, pause: true, seeding: true };
    if (b.streamUrl) this.streamUrl = async (id, fileIndex) => (await b.streamUrl!({ id, fileIndex })).url;
  }
  list() { return this.b.list(); }
  add(o: AddOptions) { return this.b.add(o).catch((e: Error) => { if (/\bexists$/.test(String(e?.message ?? ''))) throw new Error(t('existsSkipped', { name: o.name ?? '' })); throw e; }); }
  pause(id: string) { return this.b.pause(id); }
  resume(id: string) { return this.b.resume(id); }
  remove(id: string, del: boolean) { return this.b.remove(id, del); }
  setFiles(id: string, p: (0 | 1 | 2)[]) { return this.b.setFiles(id, p); }
  setLimits(l: Limits) { return this.b.setLimits(l); }
  async move(id: string, how: -2 | -1 | 1 | 2) { if (this.b.move) await this.b.move(id, how); }
  async setUrl(id: string, url: string) { if (!this.b.setUrl) throw new Error('not here'); await this.b.setUrl(id, url); }
  torrentInfo(s: TaskSource) { return this.b.torrentInfo(s); }
  open(id: string, i?: number) { return this.b.open(id, i); }
  rename(id: string, name: string) { return (this.b as unknown as { rename(o: { id: string; name: string }): Promise<string> }).rename({ id, name }); }
  onChange(fn: (t: Task[]) => void) { return this.b.onTasks(fn); }
}
