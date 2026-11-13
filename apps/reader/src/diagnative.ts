// How an earlier session ended, as the native app tells it (Android: KurokawaPlugin.takeCrashInfo — the WebView's renderer
// gone, the system's record of why the app's process ended, its memory warnings): put on the sessions and into the
// events of the app's own record (src/diag.ts). Loaded only when the native app has something to say: the recorder
// itself stays small at the start. Numbers and kinds only.
import { diagStore, diagFlush, type DiagSession } from './diag';

/** What the Android app kept (KurokawaPlugin.takeCrashInfo): its renderer's ends, the last memory warning, and why its
 *  earlier processes ended (ApplicationExitInfo: reason, importance, memory). */
export interface NativeCrashInfo {
  gone?: { at: number; crashed?: boolean; prio?: number; fg?: boolean; trim?: number; trimAgo?: number }[];
  exits?: { at: number; reason: number; status?: number; imp?: number; pss?: number; rss?: number; main?: boolean }[];
  trim?: number; trimAt?: number; sdk?: number; error?: string;
}
/** ApplicationExitInfo's reasons (their numbers), named. */
const EXIT: Record<number, string> = { 0: 'unknown', 1: 'exit self', 2: 'signaled', 3: 'low memory', 4: 'crash', 5: 'native crash', 6: 'anr', 7: 'init failure', 8: 'permission change', 9: 'excessive resource use', 10: 'user requested', 11: 'user stopped', 12: 'dependency died', 13: 'other', 14: 'freezer', 15: 'package state change', 16: 'package updated' };
/** The renderer's priority at its end (WebView.RENDERER_PRIORITY_*). */
const PRIO: Record<number, string> = { 0: 'waived', 1: 'bound', 2: 'important' };
/** The session (not the running one) whose time holds `at`: begun before it, the next begun after it. */
function sessionAt(at: number): DiagSession | undefined {
  const { s, cur } = diagStore(); for (let i = s.length - 2; i >= 0; i--) if (s[i] !== cur && s[i].at <= at && s[i + 1].at > at) return s[i];
  return undefined;
}
/** The native app's word on how earlier sessions ended, put on them and into the events. */
export function diagApplyNative(info: NativeCrashInfo): void {
  const store = diagStore();
  {
    for (const g of info.gone ?? []) {
      const s = sessionAt(g.at); const quiet = s ? Math.round((g.at - s.at - s.ran) / 1000) : undefined;
      const det = [g.crashed ? 'crashed' : 'killed', g.prio !== undefined && g.prio >= 0 ? `priority ${PRIO[g.prio] ?? g.prio}` : '', g.fg === false ? 'app in background' : g.fg ? 'app on screen' : '', g.trim ? `memory warning ${g.trim} ${Math.round((g.trimAgo ?? 0) / 1000)} s before` : '', quiet !== undefined ? `last record ${quiet} s before` : ''].filter(Boolean).join(', ');
      if (s) { s.why = g.crashed ? 'renderer-crash' : 'renderer-killed'; s.det = det; if (!s.end || s.end === 'bg') s.end = 'unexpected'; }
      store.e.push({ t: g.at, k: 'gone', how: g.crashed ? 'renderer crashed' : 'renderer killed', ...(g.prio !== undefined && g.prio >= 0 ? { prio: PRIO[g.prio] ?? g.prio } : {}), fg: g.fg, ...(g.trim ? { trim: g.trim } : {}), ...(quiet !== undefined ? { quiet } : {}) });
    }
    for (const x of info.exits ?? []) {
      const name = EXIT[x.reason] ?? `reason ${x.reason}`;
      const s = x.main === false ? undefined : sessionAt(x.at);
      const quiet = s ? Math.round((x.at - s.at - s.ran) / 1000) : undefined;
      // (A session already told apart by its renderer's end keeps that; one closed normally or by the user is left so.)
      if (s && (!s.why || s.why === 'unknown' || s.why === 'anr?') && s.end !== 'left' && x.reason !== 10 && x.reason !== 11 && x.reason !== 16) {
        s.why = x.reason === 6 ? 'anr' : x.reason === 3 ? 'app-memory' : x.reason === 4 || x.reason === 5 ? 'app-crash' : 'app-killed';
        s.det = [name, x.imp !== undefined ? `importance ${x.imp}` : '', x.pss ? `pss ${x.pss} MB` : '', x.rss ? `rss ${x.rss} MB` : '', quiet !== undefined ? `last record ${quiet} s before` : ''].filter(Boolean).join(', ');
      }
      store.e.push({ t: x.at, k: 'exit', reason: name, ...(x.main === false ? { proc: 'other' } : {}), ...(x.imp !== undefined ? { imp: x.imp } : {}), ...(x.pss ? { pss: x.pss } : {}), ...(x.rss ? { rss: x.rss } : {}), ...(quiet !== undefined ? { quiet } : {}) });
    }
    if (info.trimAt && !store.e.some((e) => e.k === 'trim' && e.t === info.trimAt)) store.e.push({ t: info.trimAt, k: 'trim', level: info.trim, src: 'native' });
    store.e.sort((a, b) => a.t - b.t);
  }
  diagFlush();
}

