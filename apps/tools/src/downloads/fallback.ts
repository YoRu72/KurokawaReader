// An extractor that ends with no file (or does not know the link) on a link that answers with a file: the link is
// downloaded once more by the direct engine, in the task's place, with a line in its log. Once: the new task is marked
// and never goes back, so a link that fails both ways stops with the direct engine's own error.
import { getEngine } from '../engine';
import type { Engine, Task } from '../engine/types';
import { probeUrl } from './probe';
import { probeSaysFile } from './direct';
import { EXTRACTOR_MISS, retried } from './errors';

const seen = new Set<string>();           // (failed video tasks looked at — each one once)

/** Whether the failed extractor task should be tried as a plain file; the task is only looked at once. */
export const eligible = (x: Task): boolean => x.kind === 'video' && x.state === 'failed' && !!x.source.url && /^https?:\/\//i.test(x.source.url) && EXTRACTOR_MISS.test(x.error ?? '') && !x.meta?.directTried && !seen.has(x.id);

/** One failed task: asked (HEAD, then the first bytes), and — when a file answers — replaced by a direct download. Returns the new task. */
export async function directRetry(x: Task, eng: Engine = getEngine()): Promise<Task | null> {
  if (!eligible(x)) return null; seen.add(x.id);
  const url = x.source.url!;
  let p; try { p = await probeUrl(url, x.source.headers ?? {}); } catch { return null; }
  if (!probeSaysFile(p)) return null;
  const keep: NonNullable<Task['meta']> = {}; const m = x.meta ?? {};
  for (const k of ['wifiOnly', 'noRetry', 'hidden', 'later', 'schedPaused', 'cookieJar'] as const) if (m[k] !== undefined) (keep as Record<string, unknown>)[k] = m[k];
  try {
    await eng.remove(x.id, false);
    const nt = await eng.add({ source: { url, ...(x.source.headers ? { headers: x.source.headers } : {}) }, dir: x.dir || undefined, meta: { ...keep, directTried: true, directRetry: true } });
    retried.add(nt.id); return nt;
  } catch { return null; }
}
let started = false;
/** Every failed extractor task looked at as it fails (the page's own watch, for every engine). */
export function startDirectFallback(): void {
  if (started) return; started = true;
  getEngine().onChange((ts) => { for (const x of ts) if (eligible(x)) void directRetry(x); });
}
