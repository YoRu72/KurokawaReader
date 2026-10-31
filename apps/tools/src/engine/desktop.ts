// The desktop app's engine: aria2c beside the app, spoken to by the Electron main process (desktop/aria2.cjs);
// the preload hands the renderer this bridge.
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
  torrentInfo(source: TaskSource): Promise<TorrentInfo>;
  open(id: string, fileIndex?: number): Promise<void>;
  defaultDir(): Promise<string>;
  pickDir(): Promise<string | null>;
  configure(o: { listenPort?: number; maxConnections?: number; seed?: boolean }): Promise<void>;
  onTasks(cb: (tasks: Task[]) => void): () => void;
  openExternal?(url: string): Promise<void>;
  registerMagnet?(): Promise<void>;
  checkUpdate?(o: { beta: boolean }): Promise<{ version: string; url: string; notes: string; asset?: string } | null>;
  installUpdate?(url: string): Promise<void>;
  readFile?(path: string): Promise<ArrayBuffer>;
}

export class DesktopEngine implements Engine {
  readonly id = 'native' as const;
  readonly can = { torrents: true, http: true, stream: false, limits: true, pickFiles: true, pause: true, seeding: true };
  constructor(private b: DesktopBridge) {}
  list() { return this.b.list(); }
  add(o: AddOptions) { return this.b.add(o); }
  pause(id: string) { return this.b.pause(id); }
  resume(id: string) { return this.b.resume(id); }
  remove(id: string, del: boolean) { return this.b.remove(id, del); }
  setFiles(id: string, p: (0 | 1 | 2)[]) { return this.b.setFiles(id, p); }
  setLimits(l: Limits) { return this.b.setLimits(l); }
  torrentInfo(s: TaskSource) { return this.b.torrentInfo(s); }
  open(id: string, i?: number) { return this.b.open(id, i); }
  onChange(fn: (t: Task[]) => void) { return this.b.onTasks(fn); }
}
