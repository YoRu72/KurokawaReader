// The scanner's workers: as many as the device has cores to spare (up to four), each given the next piece of
// work as it frees up. Where workers cannot be started, the work is done here instead.
import type { Op } from './scanops';

type Slot = { w: Worker; busy: number; born: number };
let slots: Slot[] | null = null;
let failed = false;
let seq = 0;
const waiting = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void; slot: Slot; m: Op }>();

function start(): Slot[] | null {
  if (slots || failed) return slots;
  try {
    // (Two at least: one thread's page is waiting on the picture decoder while the other's is being worked out.)
    const n = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    const make = (slot: Slot) => {
      const w = new Worker(new URL('./scanworker.js', import.meta.url), { type: 'module' });
      slot.w = w; slot.busy = 0; slot.born = Date.now();
      w.addEventListener('message', (e: MessageEvent<{ id: number; ok: boolean; res?: unknown; error?: string }>) => {
        const job = waiting.get(e.data.id); if (!job) return;
        waiting.delete(e.data.id); job.slot.busy--;
        if (e.data.ok) job.res(e.data.res); else job.rej(new Error(e.data.error));
      });
      // A worker that dies (out of memory on one huge photo, say) is replaced, and the work it held is done
      // here; one that cannot start at all (an old browser, a page served oddly) means none can: all the work
      // is done here from then on.
      w.addEventListener('error', () => {
        const mine = [...waiting].filter(([, job]) => job.slot === slot);
        for (const [id, job] of mine) { waiting.delete(id); void import('./scanops').then((o) => o.handle(job.m)).then((r) => job.res(r.res), (e) => job.rej(e as Error)); }
        w.terminate();
        if (Date.now() - slot.born < 3000 && !mine.length) { failed = true; return; }
        make(slot);
      });
    };
    slots = Array.from({ length: n }, () => { const slot: Slot = { w: null as unknown as Worker, busy: 0, born: 0 }; make(slot); return slot; });
  } catch { failed = true; slots = null; }
  return slots;
}

/** Do one piece of picture work, in a worker when there is one (what it is given is copied, not handed over). */
export async function scanWork<T>(m: Op): Promise<T> {
  const pool = start();
  if (!pool || failed) { const { handle } = await import('./scanops'); return (await handle(m)).res as T; }
  const slot = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
  slot.busy++;
  const id = ++seq;
  return new Promise<T>((res, rej) => {
    waiting.set(id, { res: res as (v: unknown) => void, rej, slot, m });
    try { slot.w.postMessage({ id, m }); } catch (e) { waiting.delete(id); slot.busy--; rej(e as Error); }
  });
}

/** How many pieces of work run at once (the rest wait their turn). */
export const parallel = () => Math.max(1, start()?.length ?? 1);
