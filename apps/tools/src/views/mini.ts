// Prism's mini window: a small window above the others with the speed down and up, how many are downloading, and
// the first few with their progress; pause or resume them all, back to the app, close. Dragged by its top.
import { h, icon } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { getEngine, displayName } from '../engine';
import type { Task } from '../engine/types';
import { stateLabel } from './downloads';

type Mini = { mini?(o: { action: string; on?: boolean }): Promise<unknown> };
const bridge = () => window.kurokawaTools as unknown as Mini | undefined;
const ACTIVE = ['downloading', 'metadata', 'checking', 'queued'];

export function miniView(): HTMLElement {
  const down = h('b', { class: 'mini-speed' }); const up = h('small', { class: 'src' }); const count = h('small', { class: 'src' });
  const rows = h('div', { class: 'mini-rows' });
  const pp = h('button', { type: 'button', class: 'mini-btn' }) as HTMLButtonElement;
  const root = h('div', { class: 'mini-view' },
    h('div', { class: 'mini-head' }, h('span', { class: 'mini-ic' }, icon('download')), h('div', { class: 'grow mini-nums' }, down, h('span', null, up, count)),
      pp, h('button', { type: 'button', class: 'mini-btn', title: t('miniMain'), 'aria-label': t('miniMain'), onclick: () => void bridge()?.mini?.({ action: 'main' }) }, icon('external')),
      h('button', { type: 'button', class: 'mini-btn', title: t('close'), 'aria-label': t('close'), onclick: () => void bridge()?.mini?.({ action: 'close' }) }, icon('close'))),
    rows);
  let tasks: Task[] = [];
  const draw = () => {
    const act = tasks.filter((x) => ACTIVE.includes(x.state)); const busy = act.filter((x) => x.state === 'downloading');
    const d = tasks.reduce((a, x) => a + (x.downSpeed || 0), 0), u = tasks.reduce((a, x) => a + (x.upSpeed || 0), 0);
    down.textContent = `↓ ${t('perSecond', { n: formatBytes(d) })}`; up.textContent = `↑ ${t('perSecond', { n: formatBytes(u) })}`;
    count.textContent = ` · ${t('miniActive', { n: localDigits(busy.length), q: localDigits(act.length - busy.length) })}`;
    const paused = tasks.some((x) => x.state === 'paused'); const anyActive = act.length > 0;
    pp.replaceChildren(icon(anyActive ? 'pause' : 'play')); pp.title = anyActive ? t('pauseAll') : t('resumeAll'); pp.setAttribute('aria-label', pp.title); pp.disabled = !anyActive && !paused;
    pp.onclick = () => { const e = getEngine(); void Promise.all(anyActive ? act.map((x) => e.pause(x.id)) : tasks.filter((x) => x.state === 'paused').map((x) => e.resume(x.id))); };
    const show = act.slice(0, 4);
    rows.replaceChildren(...(show.length ? show.map((x) => { const pct = x.total ? Math.min(100, (x.done / x.total) * 100) : 0; return h('div', { class: 'mini-row' },
      h('div', { class: 'mini-line' }, h('span', { class: 'grow mini-name', dir: 'auto' }, displayName(x)), h('small', { class: 'src' }, x.state === 'downloading' ? `${localDigits(Math.floor(pct))}% · ${t('perSecond', { n: formatBytes(x.downSpeed || 0) })}` : stateLabel(x.state))),
      h('div', { class: 'mini-bar' }, h('i', { style: { width: `${pct}%` } }))); }) : [h('p', { class: 'mini-idle' }, t('miniIdle'))]), ...(act.length > 4 ? [h('small', { class: 'src mini-more' }, t('miniMore', { n: localDigits(act.length - 4) }))] : []));
  };
  getEngine().onChange((ts) => { tasks = ts; draw(); });
  void getEngine().list().then((ts) => { tasks = ts; draw(); }).catch(() => undefined);
  draw();
  return root;
}
