// Media snapshots: what a page's video was when last looked at (title, length, chapters), so a second download of the
// same link can say whether the media changed since — a re-upload, a cut, chapters added.
import { t } from '../i18n';
import type { VideoInfo } from './ytdlp';
interface Snap { title: string; duration?: number; chapters?: number; at: number }
const KEY = 'kt.mediaSnap';
const load = (): Record<string, Snap> => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Snap>; } catch { return {}; } };
const save = (m: Record<string, Snap>) => { try { const keys = Object.keys(m); if (keys.length > 400) for (const k of keys.sort((a, b) => m[a].at - m[b].at).slice(0, keys.length - 400)) delete m[k]; localStorage.setItem(KEY, JSON.stringify(m)); } catch { /* none */ } };
const keyOf = (i: VideoInfo): string => (i.site && i.id ? `${i.site}:${i.id}` : i.url);
const fmt = (s?: number) => { if (!s) return '—'; s = Math.round(s); const m = Math.floor(s / 60), sec = s % 60; return `${m}:${String(sec).padStart(2, '0')}`; };
/** The differences from the last look, in words; the new look remembered either way. */
export function noteChanges(i: VideoInfo): string | null {
  const m = load(); const k = keyOf(i); const prev = m[k]; const now: Snap = { title: i.title, duration: i.duration, chapters: i.chapters, at: Date.now() };
  m[k] = now; save(m);
  if (!prev) return null;
  const diffs: string[] = [];
  if (prev.title && i.title && prev.title !== i.title) diffs.push(t('mediaTitleChanged', { a: prev.title, b: i.title }));
  if (prev.duration && i.duration && Math.abs(prev.duration - i.duration) > 2) diffs.push(t('mediaLengthChanged', { a: fmt(prev.duration), b: fmt(i.duration) }));
  if ((prev.chapters ?? 0) !== (i.chapters ?? 0) && (prev.chapters || i.chapters)) diffs.push(t('mediaChaptersChanged', { a: String(prev.chapters ?? 0), b: String(i.chapters ?? 0) }));
  return diffs.length ? diffs.join(' · ') : null;
}
