// The live line of a stream or video download: what it is, where it is, and whether it has stalled.
import { t, localDigits, formatBytes } from '../i18n';
import type { Task } from '../engine/types';
export const phaseLabel = (p: string): string => p.startsWith('variant ') ? t('hlsVariant', { q: p.slice(8) }) : p === 'pieces' ? t('hlsPhasePieces') : p === 'join' ? t('hlsPhaseJoin') : p === 'remux' ? t('hlsPhaseRemux') : p === 'info' ? t('phaseInfo') : p === 'video' ? t('phaseVideo') : p === 'audio' ? t('phaseAudio') : p === 'merge' ? t('phaseMerge') : p === 'finish' ? t('phaseFinish') : p;
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
