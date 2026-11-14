// The Electron bridge build's offer of the new computer app (Tools' stage P9; desktop/main.cjs's RUST_SWITCH block): a
// while after the start, the shell is asked whether a release carries the Rust (Tauri) build for this computer
// (window.kurokawaHandover.switchInfo() — null while the switch is off, as it is until the switch-over); when it does,
// a sheet says what it is, that the person's settings, lists and downloads come with it, and «Move now» runs the
// switch through the shell's installUpdate (the hand-over first — its own progress sheet —, then the new build's file
// downloaded with this sheet's progress, checked, installed). «Not now» asks again at the next update check's distance
// (a day; a week when updates are checked weekly), or at once for a newer version. Any refusal is said in words.
import { h, icon, openSheet, toast } from './ui/dom';
import { t, formatBytes, localDigits } from './i18n';
import { getSettings } from './settings';

type Info = { version: string; name: string; size: number; page: string; portable: boolean; os: string };
type Api = { switchInfo?(o?: { beta?: boolean }): Promise<Info | null> };
const LATER = 'kt.rustSwitch.later';

/** Whether «Not now» still holds for this version: { v, at } kept; asked again after a day (a week with weekly checks)
 *  or for another version. */
export function laterHolds(raw: string | null, version: string, now: number, every: 'launch' | 'daily' | 'weekly' = 'launch'): boolean {
  let j: { v?: string; at?: number } | null = null; try { j = raw ? JSON.parse(raw) as { v?: string; at?: number } : null; } catch { j = null; }
  if (!j || j.v !== version || typeof j.at !== 'number') return false;
  return now - j.at < (every === 'weekly' ? 7 : 1) * 86400000;
}

/** A shell's refusal («kt-update:<code> …», wherever it sits in the message — Electron wraps it) → the words, or null. */
export function switchErrorText(message: string, info?: { page?: string }): string | null {
  const m = /kt-update:([\w-]+)\s*(.*)$/s.exec(message); if (!m) return null;
  switch (m[1]) {
    case 'handover': return t('switchHandoverFailed');
    case 'portable-ready': return t('switchPortableReady', { page: info?.page ?? '' });
    case 'mac-opened': return t('switchMacOpened');
    case 'checksum': case 'size': return t('updateDamaged');
    case 'nochecksum': return t('switchNoChecksum');
    case 'norelease': return t('switchNoRelease');
    default: return t('installFailed', { error: m[1] });
  }
}

/** Asked a while after the start (main.ts), on the Electron build only. */
export async function offerRustSwitch(o: { force?: boolean } = {}): Promise<void> {
  const api = (window as unknown as { kurokawaHandover?: Api }).kurokawaHandover;
  if (!api?.switchInfo) return;
  const info = await api.switchInfo({ beta: getSettings().updateChannel === 'beta' }).catch(() => null);
  if (!info) return;
  let raw: string | null = null; try { raw = localStorage.getItem(LATER); } catch { /* private mode */ }
  if (!o.force && laterHolds(raw, info.version, Date.now(), getSettings().updateEvery ?? 'launch')) return;
  switchSheet(info);
}

export function switchSheet(info: Info): void {
  const sh = openSheet(t('switchTitle'), t('close')); sh.el.classList.add('switch-sheet'); sh.el.setAttribute('data-switch', 'offer');
  const status = h('p', { class: 'src', role: 'status', 'aria-live': 'polite' });
  const bar = h('div', { class: 'task-bar' }, h('i')); bar.hidden = true;
  sh.body.append(
    h('p', null, t('switchBody', { v: info.version })),
    h('p', { class: 'hint' }, t('switchKeeps')),
    h('p', { class: 'src switch-file', dir: 'auto' }, icon('file'), h('span', { dir: 'ltr' }, info.name), info.size ? h('b', null, ` · ${formatBytes(info.size)}`) : null),
    ...(info.portable ? [h('p', { class: 'hint' }, t('switchPortableHint'))] : []),
    bar, status);
  const setBar = (pct: number) => { bar.hidden = false; (bar.firstChild as HTMLElement).style.width = `${pct}%`; };
  const kt = window.kurokawaTools as unknown as { installUpdate?(u: string): Promise<unknown>; onUpdateProgress?(cb: (p: { pct: number; got: number; total: number; verifying?: boolean }) => void): () => void } | undefined;
  const later = h('button', { type: 'button', class: 'btn text', onclick: () => { try { localStorage.setItem(LATER, JSON.stringify({ v: info.version, at: Date.now() })); } catch { /* private mode */ } sh.close(); toast(t('switchLaterHint')); } }, t('switchLater'));
  const go = h('button', { type: 'button', class: 'btn primary', 'data-switch-go': '1', onclick: async () => {
    if (!kt?.installUpdate) return;
    go.disabled = true; later.hidden = true; sh.el.setAttribute('data-switch', 'running'); status.textContent = t('handoverMaking');
    const off = kt.onUpdateProgress?.((p) => { if (p.verifying) { status.textContent = t('updateVerifying'); setBar(100); return; } setBar(p.pct); status.textContent = `${localDigits(p.pct)}${document.documentElement.lang === 'ar' ? '٪' : '%'} · ${formatBytes(p.got)}${p.total ? ` / ${formatBytes(p.total)}` : ''}`; });
    try {
      // (No address: the shell takes the Tauri build's file of the release itself — «rust-switch» is never fetched.)
      await kt.installUpdate('rust-switch');
      sh.el.setAttribute('data-switch', 'installing'); status.textContent = t('switchInstalling');
    } catch (e) {
      sh.el.setAttribute('data-switch', 'refused'); bar.hidden = true;
      status.textContent = switchErrorText(String((e as Error)?.message ?? e), info) ?? t('installFailed', { error: String((e as Error)?.message ?? e) });
      go.disabled = false; go.replaceChildren(icon('refresh'), t('tryAgain')); later.hidden = false;
    } finally { off?.(); }
  } }, icon('download'), t('switchNow'));
  sh.actions.append(later, go);
}
