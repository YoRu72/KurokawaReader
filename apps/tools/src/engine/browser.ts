// The web app's engine: a plain link is handed to the browser's own downloader; torrents cannot be fetched here
// (a remote aria2 can take them). The list is kept in localStorage for the session's record.
import type { AddOptions, Engine, Task } from './types';

const KEY = 'kt.browser.tasks';
export class BrowserEngine implements Engine {
  readonly id = 'browser' as const;
  readonly can = { torrents: false, http: true, stream: false, limits: false, pickFiles: false, pause: false, seeding: false };
  private tasks: Task[] = []; private subs = new Set<(t: Task[]) => void>();
  constructor() { try { this.tasks = JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { /* none */ } }
  private save() { try { localStorage.setItem(KEY, JSON.stringify(this.tasks.slice(0, 200))); } catch { /* full */ } for (const f of this.subs) f(this.tasks); }
  async list() { return this.tasks; }
  async add(o: AddOptions): Promise<Task> {
    if (!o.source.url) throw new Error('torrents');
    const a = document.createElement('a'); a.href = o.source.url; if (o.name) a.download = o.name; a.rel = 'noopener'; a.target = '_blank'; document.body.append(a); a.click(); a.remove();
    const t: Task = { id: `b${Date.now().toString(36)}`, kind: 'http', name: o.name || o.source.url.split('/').pop() || o.source.url, source: o.source, dir: '', state: 'done', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), doneAt: Date.now(), meta: o.meta, engine: 'browser' };
    this.tasks.unshift(t); this.save(); return t;
  }
  async pause() { /* the browser's */ }
  async resume() { /* the browser's */ }
  async remove(id: string) { this.tasks = this.tasks.filter((t) => t.id !== id); this.save(); }
  onChange(fn: (t: Task[]) => void) { this.subs.add(fn); fn(this.tasks); return () => { this.subs.delete(fn); }; }
}
