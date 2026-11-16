// «Verify after copying» — the Full check (a lazy chunk, loaded when a copy or move runs with it chosen).
// The engines (phone and computer) always compare the size of every file they copy and never delete a move's original when
// that fails; this adds a check of the CONTENT, for a copy or a move between two storages:
//   1. the items are copied into a hidden stage folder inside the destination folder (its name starts with
//      «.kurokawa-extract-», which no listing shows, and it is on the destination's own storage);
//   2. every original is compared with its staged copy: the size first, then the checksum (the shell's hashFile, which
//      reads the file in chunks on its own side — the page never holds a file); a copy that differs is deleted from the
//      stage, so it never appears under the real name, and what is already at the destination is left alone;
//   3. what passed is moved out of the stage into the destination (a rename on one storage; the usual question when a
//      name is taken is asked then);
//   4. a MOVE deletes an original only now, and only an item whose every file passed and arrived; anything else stays where
//      it was and the end says so;
//   5. the stage is removed — at the end, on Cancel, on a failure; and a stage left by an app that was killed is swept at
//      the next start (the stage paths are kept in localStorage while a job runs).
// Progress is by file (bytes of the files checked so far): the checksum of one file cannot be interrupted, so Cancel acts
// between files — a file being summed is let go and its result ignored.
import type { Entry } from './files';

export interface VerifyEnd { status: 'done' | 'cancelled'; files: number; verified: number; failed: string[]; mismatch: string[]; skipped: number; left?: number; remaining?: string[]; moved: boolean }
export interface VerifyHost {
  /** A job of the engine: its events (progress, a name taken, the end) come to `on`. Resolves when it has started. */
  start(id: string, op: 'copy' | 'move' | 'delete', paths: string[], dest: string | undefined, conflict: string, on: (ev: SubEvent) => void): Promise<void>;
  cancelSub(id: string): void;
  /** A name taken at the destination: the page's question (its answer goes to the engine by the job's id). */ ask(ev: SubEvent): void;
  /** The names in a folder, hidden ones too. */ list(dir: string): Promise<Entry[]>;
  mkdir(path: string): Promise<void>;
  /** The SHA-256 of a file. */ hash(path: string): Promise<string>;
  progress(pct: number, meta: string): void;
  words: { copying: (name: string) => string; checking: (name: string, i: number, n: number) => string; placing: string; mismatch: (name: string) => string; kept: (name: string) => string };
}
export interface SubEvent { id: string; status: string; done?: number; total?: number; name?: string; failed?: string[]; skipped?: number; remaining?: string[]; files?: number; message?: string }
const KEY = 'kt.files.stages';
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;
const join = (a: string, b: string) => `${a.replace(/\/+$/, '')}/${b}`;
const kept = (): string[] => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; } };
const keep = (a: string[]) => { try { if (a.length) localStorage.setItem(KEY, JSON.stringify(a)); else localStorage.removeItem(KEY); } catch { /* none */ } };
const live = new Set<string>();

/** Stages left by an app that was killed mid-job: removed (never one of a job running now). */
export function sweepStages(del: (paths: string[]) => Promise<unknown>): void {
  const old = kept().filter((p) => !live.has(p)); if (!old.length) return;
  keep(kept().filter((p) => live.has(p))); void del(old).catch(() => undefined);
}

export function runVerified(host: VerifyHost, o: { id: string; op: 'copy' | 'move'; paths: string[]; dest: string; stage: string }): { cancel(): void; done: Promise<VerifyEnd> } {
  let stopped = false; let current = ''; let abandon: (() => void) | null = null;
  const cancel = () => { stopped = true; if (current) host.cancelSub(current); abandon?.(); };
  const sub = (suffix: string, op: 'copy' | 'move' | 'delete', paths: string[], dest: string | undefined, conflict: string, onProg?: (ev: SubEvent) => void, onAsk?: (ev: SubEvent) => void): Promise<SubEvent> => new Promise((res) => {
    const id = `${o.id}-${suffix}`; current = id;
    void host.start(id, op, paths, dest, conflict, (ev) => { if (ev.status === 'progress') onProg?.(ev); else if (ev.status === 'conflict') onAsk?.(ev); else { current = ''; res(ev); } }).catch((e) => { current = ''; res({ id, status: 'failed', message: String((e as Error).message ?? e) }); });
  });
  const done = (async (): Promise<VerifyEnd> => {
    const failed: string[] = []; const mismatch: string[] = []; let skipped = 0; let verified = 0;
    const end = (status: 'done' | 'cancelled', moved: boolean, remaining?: string[]): VerifyEnd => ({ status, files: verified, verified, failed, mismatch, skipped, moved, ...(o.op === 'move' ? { left: remaining?.length ?? 0, remaining: remaining ?? [] } : {}) });
    const cleanup = async () => { const ev = await sub('q', 'delete', [o.stage], undefined, 'ask'); void ev; live.delete(o.stage); keep(kept().filter((p) => p !== o.stage)); };
    live.add(o.stage); keep([...kept().filter((p) => p !== o.stage), o.stage]);
    try {
      await host.mkdir(o.stage);
      // ---- 1. into the stage (names taken cannot be: it is empty, and the page made the names different beforehand)
      const first = o.paths.length ? base(o.paths[0]) : '';
      const c = await sub('c', 'copy', o.paths, o.stage, 'keep', (ev) => host.progress(Math.round(((ev.done ?? 0) / Math.max(1, ev.total ?? 1)) * 45), `${host.words.copying(ev.name ?? first)}`));
      if (c.status === 'failed') throw new Error(c.message ?? 'failed');
      for (const f of c.failed ?? []) failed.push(f);
      if (stopped || c.status === 'cancelled') { await cleanup(); return end('cancelled', false, o.paths); }
      // ---- 2. every original against its copy
      type Pair = { top: number; src: string; dst: string; size: number };
      const pairs: Pair[] = []; const topBad = new Set<number>();
      const walk = async (top: number, src: string, dst: string, isDir: boolean, size: number): Promise<void> => {
        if (stopped) return;
        if (!isDir) { pairs.push({ top, src, dst, size }); return; }
        const [a, b] = await Promise.all([host.list(src), host.list(dst).catch(() => [] as Entry[])]);
        const have = new Map(b.map((e) => [e.name, e]));
        for (const e of a) { const m = have.get(e.name); if (!m || m.dir !== e.dir) { topBad.add(top); continue; } await walk(top, e.path, m.path, e.dir, e.size); }
      };
      for (let i = 0; i < o.paths.length && !stopped; i++) {
        const p = o.paths[i]; const ents = await host.list(o.paths[i].replace(/\/[^/]*$/, '')); const e = ents.find((x) => x.path === p || x.name === base(p));
        const st = await host.list(o.stage); const m = st.find((x) => x.name === base(p));
        if (!e || !m) { topBad.add(i); continue; }
        await walk(i, e.path, m.path, e.dir, e.size);
      }
      if (stopped) { await cleanup(); return end('cancelled', false, o.paths); }
      const total = pairs.reduce((s, x) => s + Math.max(1, x.size), 0); let doneB = 0; const bad: Pair[] = [];
      for (let i = 0; i < pairs.length; i++) {
        if (stopped) break; const x = pairs[i];
        host.progress(45 + Math.round((doneB / Math.max(1, total)) * 45), host.words.checking(base(x.src), i + 1, pairs.length));
        let same = false;
        if (x.size >= 0) {
          try {
            const gone = new Promise<never>((_, rej) => { abandon = () => rej(new Error('stopped')); });
            const [a, b] = await Promise.race([Promise.all([host.hash(x.src), host.hash(x.dst)]), gone]);
            same = !!a && a === b;
          } catch { same = false; } finally { abandon = null; }
        }
        if (stopped) break;
        doneB += Math.max(1, x.size);
        if (same) verified++; else { bad.push(x); topBad.add(x.top); mismatch.push(x.src); failed.push(host.words.mismatch(base(x.src))); }
      }
      if (stopped) { await cleanup(); return end('cancelled', false, o.paths); }
      if (bad.length) { await sub('b', 'delete', bad.map((x) => x.dst), undefined, 'ask'); }
      // ---- 3. what is whole moves from the stage to the destination
      host.progress(92, host.words.placing);
      const after = await host.list(o.stage); const present = new Set(after.map((e) => e.name));
      const items = o.paths.filter((p) => present.has(base(p))); let leftInStage: string[] = [];
      if (items.length) {
        const pl = await sub('p', 'move', items.map((p) => join(o.stage, base(p))), o.dest, 'ask', undefined, (ev) => host.ask(ev));
        if (pl.status === 'failed') throw new Error(pl.message ?? 'failed');
        for (const f of pl.failed ?? []) failed.push(f);
        skipped += pl.skipped ?? 0; leftInStage = (pl.remaining ?? []).map(base);
        if (stopped || pl.status === 'cancelled') { await cleanup(); return end('cancelled', true, o.paths); }
      }
      // ---- 4. a move: the originals that passed and arrived
      let remaining: string[] | undefined;
      if (o.op === 'move') {
        const gone: string[] = []; remaining = [];
        o.paths.forEach((p, i) => { const arrived = present.has(base(p)) && !leftInStage.includes(base(p)); if (arrived && !topBad.has(i)) gone.push(p); else { remaining!.push(p); if (arrived && topBad.has(i)) failed.push(host.words.kept(base(p))); } });
        if (gone.length) { const d = await sub('d', 'delete', gone, undefined, 'ask'); if (stopped || d.status === 'cancelled') { await cleanup(); return end('cancelled', true, [...remaining, ...gone]); } for (const f of d.failed ?? []) { failed.push(f); } remaining.push(...gone.filter((g) => (d.failed ?? []).some((f) => f.startsWith(`${base(g)}:`)))); }
      }
      await cleanup();
      return end('done', true, remaining);
    } catch (e) {
      failed.push(String((e as Error).message ?? e)); await cleanup().catch(() => undefined);
      return end('done', false, o.paths);
    }
  })();
  return { cancel, done };
}
