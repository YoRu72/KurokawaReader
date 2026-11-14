// Undo / redo for any editing session (the theme editor, and whatever settings want it): states pushed as they
// change, a continuous gesture (a slider dragged, a colour dragged) kept as ONE step by a shared key until it is
// sealed. Shared by the Kurokawa apps; no import from either.
export class History<T> {
  private past: T[] = []; private future: T[] = []; private openKey: string | null = null;
  constructor(private now: T, private limit = 200) {}
  get current(): T { return this.now; }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  /** A new state. With `key`: while the same key is open (not sealed), it replaces the step it began instead of adding one. */
  push(next: T, key?: string): void {
    if (key && key === this.openKey) { this.now = next; this.future = []; return; }
    this.past.push(this.now); if (this.past.length > this.limit) this.past.shift();
    this.now = next; this.future = []; this.openKey = key ?? null;
  }
  /** The gesture ended (the slider let go): the next change is a new step. */
  seal(): void { this.openKey = null; }
  undo(): T | null { if (!this.past.length) return null; this.future.push(this.now); this.now = this.past.pop()!; this.openKey = null; return this.now; }
  redo(): T | null { if (!this.future.length) return null; this.past.push(this.now); this.now = this.future.pop()!; this.openKey = null; return this.now; }
  /** A fresh start from `state` (after a save or a discard). */
  clear(state: T): void { this.past = []; this.future = []; this.now = state; this.openKey = null; }
}

/** An action that only really happens when its «Undo» chance is over (the snackbar gone, or the page left):
 *  returns `undo`, which cancels it. */
export function deferred(commit: () => void | Promise<void>, ms: number): { undo(): void; now(): void } {
  let done = false;
  const run = () => { if (done) return; done = true; clearTimeout(timer); globalThis.removeEventListener?.('pagehide', run); void commit(); };
  const timer = setTimeout(run, ms);
  globalThis.addEventListener?.('pagehide', run);
  return { undo: () => { if (done) return; done = true; clearTimeout(timer); globalThis.removeEventListener?.('pagehide', run); }, now: run };
}
