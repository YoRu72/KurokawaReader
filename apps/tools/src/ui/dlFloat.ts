// A download just started, shown where the user is instead of sending them to the Downloads page: a small floating
// bar with its name, its percentage and a thin line; several at once become one bar («Count: n») with their overall
// progress. Tapped, it goes to the Downloads; it leaves a moment after they finish, and a failure stays until seen.
// The old way — straight to the Downloads — is a setting (openDownloadsOnStart).
import { h, icon, iconButton, toast } from './dom';
import { t, localDigits } from '../i18n';
import { getSettings } from '../settings';
import { navigate, parseRoute, sectionOfRoute } from '../router';
import { getEngine } from '../engine';
import type { Task } from '../engine/types';

const ids = new Set<string>(); let el: HTMLElement | null = null; let off: (() => void) | null = null; let leaveTm = 0; let last: Task[] = [];
const pct = (x: Task) => (x.state === 'done' ? 100 : x.total > 0 ? Math.round((x.done / x.total) * 100) : 0);
function close(): void { off?.(); off = null; window.clearTimeout(leaveTm); ids.clear(); const e = el; el = null; if (e) { e.classList.add('leaving'); setTimeout(() => e.remove(), 200); } }
function paint(tasks: Task[]): void {
  if (!el) return; last = tasks;
  const mine = tasks.filter((x) => ids.has(x.id)); if (!mine.length) return;
  const failed = mine.filter((x) => x.state === 'failed'); const ended = mine.every((x) => x.state === 'done' || x.state === 'seeding' || x.state === 'failed');
  const total = mine.reduce((s, x) => s + (x.total > 0 ? x.total : 0), 0); const done = mine.reduce((s, x) => s + (x.total > 0 ? Math.min(x.done, x.total) : 0), 0);
  const p = mine.length === 1 ? pct(mine[0]) : total ? Math.round((done / total) * 100) : 0;
  el.querySelector('.dlf-name')!.textContent = mine.length === 1 ? mine[0].name || t('downloadsSection') : t('dlFloatMany', { n: mine.length });
  el.querySelector('.dlf-pct')!.textContent = failed.length ? t('dlFloatFailed') : ended ? t('downloaded') : `${localDigits(p, 'prose')}%`;
  (el.querySelector('.dlf-line i') as HTMLElement).style.width = `${Math.max(3, ended && !failed.length ? 100 : p)}%`;
  el.classList.toggle('failed', !!failed.length);
  window.clearTimeout(leaveTm); if (ended && !failed.length) leaveTm = window.setTimeout(close, 2500);
}
/** A download (or several) added: the floating bar, or the Downloads page when the setting says so. */
export function downloadStarted(task: Pick<Task, 'id' | 'name'> | null, name?: string): void {
  if (getSettings().openDownloadsOnStart) { navigate('/'); return; }
  if (!task) { toast(t('taskAdded', { name: name ?? '' })); return; }
  ids.add(task.id);
  if (!el) {
    el = h('div', { class: 'float-bar dl-float', role: 'status', 'aria-live': 'polite' },
      h('button', { type: 'button', class: 'dlf-main', onclick: () => { close(); navigate('/'); } }, icon('download'), h('span', { class: 'grow' }, h('span', { class: 'dlf-name', dir: 'auto' }, task.name || name || ''), h('small', { class: 'dlf-pct' }, '')), h('span', { class: 'dlf-line', 'aria-hidden': 'true' }, h('i'))),
      iconButton('close', t('close'), () => close()));
    document.body.append(el);
    // (Not on the Downloads page itself: the list is there.)
    el.hidden = sectionOfRoute(parseRoute()) === 'downloads';
    off = getEngine().onChange((ts) => { if (el) el.hidden = sectionOfRoute(parseRoute()) === 'downloads'; paint(ts); });
  }
  paint(last.some((x) => x.id === task.id) ? last : [...last, { id: task.id, name: task.name || name || '', state: 'queued', done: 0, total: 0 } as unknown as Task]);
}
/** Several downloads added at once (a model's files, a course's lessons). */
export function downloadsStarted(tasks: Pick<Task, 'id' | 'name'>[]): void { if (getSettings().openDownloadsOnStart) { navigate('/'); return; } for (const x of tasks) downloadStarted(x); }
