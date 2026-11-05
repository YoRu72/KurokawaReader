// Batch pre-flight: every link of a batch looked at before any is added — unsupported, needs sign-in, not found,
// already here, a page — and the sizes added up against the free space of the folder.
import { probeUrl, type Probe } from './probe';
import type { TaskSource, Task } from '../engine/types';
import { getEngine } from '../engine';
import { getSettings } from '../settings';
import { freeSpaceAt } from '../archives';

export type Verdict = 'ok' | 'unsupported' | 'auth' | 'notFound' | 'page' | 'have' | 'video' | 'torrent' | 'error';
export interface Checked { src: TaskSource; verdict: Verdict; size?: number; name?: string; probe?: Probe; status?: number }
export interface Preflight { items: Checked[]; need: number; free: number; short: boolean }

const label = (s: TaskSource): string => s.url ?? s.magnet ?? 'torrent';
/** Every source looked at, a few at a time; the free space of the folder read once. */
export async function preflight(srcs: TaskSource[], opts: { dir?: string; videoEnabled: boolean; isVideoHost: (u: string) => boolean; pageLike: (u: string) => boolean; concurrency?: number } ): Promise<Preflight> {
  const tasks = await getEngine().list().catch(() => [] as Task[]);
  const doneNames = new Map<string, Task>(); for (const x of tasks) if (x.state === 'done') { doneNames.set(x.name, x); if (x.source.url) doneNames.set(x.source.url, x); }
  const out: Checked[] = new Array(srcs.length);
  let i = 0; const n = Math.max(1, Math.min(opts.concurrency ?? 6, 12));
  const worker = async () => { while (i < srcs.length) { const k = i++; out[k] = await one(srcs[k]); } };
  const one = async (src: TaskSource): Promise<Checked> => {
    if (src.magnet || src.torrent) { if (src.magnet && doneNames.has(src.magnet)) return { src, verdict: 'have' }; return { src, verdict: 'torrent' }; }
    const url = src.url ?? '';
    if (!/^https?:\/\//i.test(url)) return { src, verdict: 'unsupported' };
    if (doneNames.has(url)) { const x = doneNames.get(url)!; return { src, verdict: 'have', name: x.name, size: x.total }; }
    if (opts.isVideoHost(url) || (opts.pageLike(url) && !/\.m3u8(\?|#|$)/i.test(url))) return opts.videoEnabled ? { src, verdict: 'video' } : { src, verdict: 'unsupported' };
    try {
      const p = await probeUrl(url, src.headers ?? {});
      if (p.status === 401 || p.status === 403 || p.status === 407) return { src, verdict: 'auth', status: p.status, probe: p };
      if (p.status === 404 || p.status === 410) return { src, verdict: 'notFound', status: p.status, probe: p };
      if (p.status && p.status >= 500) return { src, verdict: 'error', status: p.status, probe: p };
      if (p.page) return { src, verdict: 'page', probe: p, status: p.status };
      const had = doneNames.get(p.name); if (had && (!p.size || had.total === p.size)) return { src, verdict: 'have', name: p.name, size: p.size, probe: p };
      return { src, verdict: 'ok', name: p.name, size: p.size, probe: p, status: p.status };
    } catch { return { src, verdict: 'error' }; }
  };
  await Promise.all(Array.from({ length: n }, worker));
  const need = out.reduce((a, c) => a + (c.verdict === 'ok' ? (c.size ?? 0) : 0), 0);
  const free = await freeSpaceAt(opts.dir ?? getSettings().downloadDir ?? '').catch(() => -1);
  return { items: out, need, free, short: free >= 0 && need > free };
}
/** Which of the verdicts are worth adding without a look. */
export const addable = (v: Verdict): boolean => v === 'ok' || v === 'video' || v === 'torrent';
export const describeSource = label;
