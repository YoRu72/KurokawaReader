// The app's settings in one file and back: every setting, the player's preferences and memory, add-on choices,
// search histories, notes — what lives in the app's own storage under «kt.» —, not the downloads themselves (the
// list has its own export) nor caches. Restored, the app reloads to take them up.
import { saveText } from './native';
import { safeStored } from './settingsSafe';

const SKIP = /^kt\.(cache|tmp|anilist\.token|debrid\.key)|token|secret|password/i;
export function backupText(): string {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('kt.') && !SKIP.test(k)) data[k] = localStorage.getItem(k) ?? ''; }
  return JSON.stringify({ app: 'kurokawa-tools', kind: 'settings', version: 1, at: new Date().toISOString(), data }, null, 1);
}
export async function saveBackup(): Promise<string | null> { return saveText(`kurokawa-tools-settings-${new Date().toISOString().slice(0, 10)}.json`, backupText(), 'application/json'); }
/** Whether a key travels in a backup and comes back from one: the app's own (`kr.` too for the full backup),
 *  never a secret, a cache or a scratch value. */
export const backupKey = (k: string, kr = false): boolean => (k.startsWith('kt.') || (kr && k.startsWith('kr.'))) && !SKIP.test(k);
/** The settings backup read: its keys and values, or an error when it is not one. */
export function parseBackup(text: string): Record<string, string> {
  const j = JSON.parse(text) as { app?: string; kind?: string; data?: Record<string, string> };
  if (j.app !== 'kurokawa-tools' || j.kind !== 'settings' || !j.data) throw new Error('not a settings backup');
  return j.data;
}
/** What a restore would do: the keys it writes, and how many of them differ from what is here now. */
export function restorePlan(data: Record<string, string>, kr = false): { keys: string[]; differ: number } {
  const keys = Object.keys(data).filter((k) => backupKey(k, kr) && typeof data[k] === 'string');
  return { keys, differ: keys.filter((k) => localStorage.getItem(k) !== safeStored(k, data[k])).length };
}
/** A restore that can be taken back: what each key held before (or that it was not there) kept first, until the
 *  «Undo restore» after the reload is dismissed; then the backup's keys written. How many were. */
const UNDO = 'kt.tmp.restoreUndo';
export function applyRestore(data: Record<string, string>, kr = false): number {
  const { keys } = restorePlan(data, kr); const prev: Record<string, string | null> = {};
  for (const k of keys) prev[k] = localStorage.getItem(k);
  localStorage.setItem(UNDO, JSON.stringify({ at: Date.now(), n: keys.length, prev }));
  // (Never a program to run nor its arguments: settingsSafe.ts.)
  let n = 0; for (const k of keys) { try { localStorage.setItem(k, safeStored(k, data[k])); n++; } catch { /* full */ } }
  return n;
}
/** Asked first — how many settings the backup writes, how many of them differ from these — then restored (null: not). */
export async function restoreAsked(data: Record<string, string>, kr = false): Promise<number | null> {
  const plan = restorePlan(data, kr); const [{ confirmSheet }, { t, localDigits }] = await Promise.all([import('./ui/undo'), import('./i18n')]);
  const ok = await confirmSheet(t('restoreAskTitle'), [t('restoreAskBody', { n: localDigits(plan.keys.length), d: localDigits(plan.differ) }), t('restoreAskUndo')], t('restoreAskGo'), false);
  return ok ? applyRestore(data, kr) : null;
}
/** A backup put back (only the app's own keys); how many were restored. */
export function restoreBackup(text: string): number { return applyRestore(parseBackup(text)); }
/** After the reload a restore asks for: «Undo restore», until dismissed — every key as it was before, and a reload. */
export async function offerRestoreUndo(): Promise<void> {
  type Snap = { n: number; prev: Record<string, string | null> }; let snap: Snap | null = null;
  try { snap = JSON.parse(localStorage.getItem(UNDO) ?? 'null') as Snap | null; } catch { snap = null; }
  if (!snap?.prev) return;
  const [{ offerUndo }, { t, localDigits }] = await Promise.all([import('./ui/undo'), import('./i18n')]);
  const prev = snap.prev;
  offerUndo(t('restoreUndoMsg', { n: localDigits(snap.n) }), () => {
    for (const [k, v] of Object.entries(prev)) { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); }
    localStorage.removeItem(UNDO); setTimeout(() => location.reload(), 900);
  }, undefined, { ms: 0, scope: '*', commit: () => localStorage.removeItem(UNDO) });
}
