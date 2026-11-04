// The app's settings in one file and back: every setting, the player's preferences and memory, add-on choices,
// search histories, notes — what lives in the app's own storage under «kt.» —, not the downloads themselves (the
// list has its own export) nor caches. Restored, the app reloads to take them up.
import { saveText } from './native';

const SKIP = /^kt\.(cache|tmp|anilist\.token|debrid\.key)|token|secret|password/i;
export function backupText(): string {
  const data: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('kt.') && !SKIP.test(k)) data[k] = localStorage.getItem(k) ?? ''; }
  return JSON.stringify({ app: 'kurokawa-tools', kind: 'settings', version: 1, at: new Date().toISOString(), data }, null, 1);
}
export async function saveBackup(): Promise<string | null> { return saveText(`kurokawa-tools-settings-${new Date().toISOString().slice(0, 10)}.json`, backupText(), 'application/json'); }
/** A backup put back (only the app's own keys); how many were restored. */
export function restoreBackup(text: string): number {
  const j = JSON.parse(text) as { app?: string; kind?: string; data?: Record<string, string> };
  if (j.app !== 'kurokawa-tools' || j.kind !== 'settings' || !j.data) throw new Error('not a settings backup');
  let n = 0; for (const [k, v] of Object.entries(j.data)) if (k.startsWith('kt.') && !SKIP.test(k) && typeof v === 'string') { try { localStorage.setItem(k, v); n++; } catch { /* full */ } }
  return n;
}
