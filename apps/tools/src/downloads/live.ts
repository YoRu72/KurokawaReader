// The live line of a stream or video download: what it is, where it is, and whether it has stalled.
import { t, localDigits, formatBytes } from '../i18n';
import type { Task } from '../engine/types';
export const phaseLabel = (p: string): string => p.startsWith('variant ') ? t('hlsVariant', { q: p.slice(8) }) : p === 'pieces' ? t('hlsPhasePieces') : p === 'join' ? t('hlsPhaseJoin') : p === 'remux' ? t('hlsPhaseRemux') : p === 'info' ? t('phaseInfo') : p === 'video' ? t('phaseVideo') : p === 'audio' ? t('phaseAudio') : p === 'merge' ? t('phaseMerge') : p === 'finish' ? t('phaseFinish') : p.startsWith('convert') ? t('phaseConvert', { f: p.slice(8) || '…' }) : p === 'embed' ? t('phaseEmbed') : p;
/** The live line of a stream or video download: what it is (1080p · avc1/mp4a · mp4 · ~512 MB), where it is (piece i/n, the phase), and whether it has stalled. */
export function liveLine(x: Task): string {
  const m = x.meta ?? {}; const parts: string[] = [];
  const what = [m.res, [m.vcodec, m.acodec].filter(Boolean).join('/'), m.ext, m.sizeApprox ? `~${formatBytes(m.sizeApprox)}` : ''].filter(Boolean).join(' · '); if (what) parts.push(what);
  if (m.frags) parts.push(t('hlsPieces', { i: localDigits(String(m.frag ?? 0)), n: localDigits(String(m.frags)) }));
  if (m.phase) parts.push(phaseLabel(m.phase));
  if (isStalled(x)) parts.push(t('stalled'));
  return parts.join(' · ');
}
/** No byte moved for six seconds while downloading: stalled (the clock is per task, kept here). */
const lastMove = new Map<string, { done: number; at: number }>();
export function isStalled(x: Task): boolean {
  if (x.state !== 'downloading') { lastMove.delete(x.id); return false; }
  const now = Date.now(); const prev = lastMove.get(x.id);
  if (!prev || prev.done !== x.done) { lastMove.set(x.id, { done: x.done, at: now }); return false; }
  return now - prev.at >= 6000;
}

/** The short form for a list row: the phase alone. */
export const phaseShort = phaseLabel;

/** Time left that holds still (D4): the speed smoothed over some eight seconds (the engines send each moment's speed, and
 *  the clock jumped with it), the time from what is left; none when the size or the speed is unknown, when it stalled,
 *  or past 99 hours — a clock nobody reads, which a server trickling a byte a second made «1048:34:34». */
const smooth = new Map<string, { v: number; at: number }>();
export function steadyEta(x: Task): number | undefined {
  if (x.state !== 'downloading' || !(x.total > 0) || x.done >= x.total) { smooth.delete(x.id); return undefined; }
  const now = Date.now(); const s = smooth.get(x.id); const inst = Math.max(0, x.downSpeed || 0); let v: number;
  if (!s) v = inst; else if (now - s.at < 200) v = s.v; else { const dt = Math.min(30, (now - s.at) / 1000); v = s.v + (inst - s.v) * (1 - Math.exp(-dt / 8)); }
  if (!s || now - s.at >= 200) smooth.set(x.id, { v, at: now });
  if (!(v > 0) || isStalled(x)) return undefined;
  const eta = (x.total - x.done) / v; return Number.isFinite(eta) && eta >= 0 && eta <= 99 * 3600 ? eta : undefined;
}
/** A download waiting to ask again (the engine's retryAt / retryWhy): its words and the seconds left; null when not waiting. */
export function retryLine(x: Task, fmt: (s: number) => string): string | null {
  if (x.state !== 'downloading' || !x.retryAt) return null; const left = Math.ceil((x.retryAt - Date.now()) / 1000); if (left <= 0) return null;
  const tm = fmt(left); return x.retryWhy === 'net' ? t('retryNetIn', { t: tm }) : /^HTTP (429|503|502|504)$/.test(x.retryWhy ?? '') ? t('retryBusyIn', { t: tm }) : t('retryIn', { t: tm });
}
