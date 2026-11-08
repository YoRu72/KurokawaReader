// The small card that offers something to download, the way the app's own updater does: what it is, why it is
// needed and how big, «Get it» — and then the download itself in the same card, each part with its bar, until it is
// ready and whatever asked for it carries on. Used when an add-on or a pack is missing (needAddon, ensurePacks).
import { h, icon } from './dom';
import { t, formatBytes, localDigits } from '../i18n';

export interface GetStep { label: string; size?: number }
export interface GetCardOptions {
  icon: string; title: string; why: string; steps: GetStep[];
  /** Runs the download; `progress(i, done, total)` moves step i's bar. Throws to fail (a message containing
   *  «cancel» counts as cancelled). */
  run(progress: (i: number, done: number, total: number) => void): Promise<void>;
  /** Stops a running download (Cancel). */
  cancel?(): void;
  /** Already asked for (an «Add it» pressed): the download starts at once, the card only shows it. */
  start?: boolean;
}
let current: { el: HTMLElement; finish: (v: boolean) => void; running: () => boolean; done: Promise<boolean> } | null = null;

/** Shows the card; true once everything is in, false when declined or cancelled. */
export async function getCard(o: GetCardOptions): Promise<boolean> {
  // (One card at a time: one still downloading is let finish — its download goes on either way — and this one follows;
  // one only offering is replaced.)
  while (current?.running()) await current.done.catch(() => false);
  current?.finish(false);
  let resolveDone!: (v: boolean) => void; const doneP = new Promise<boolean>((r) => (resolveDone = r));
  return new Promise((resolve0) => { const resolve = (v: boolean) => { resolve0(v); resolveDone(v); };
    // (A card that is not downloading — waiting for «Get it», or failed and offering Retry — leaves with the page it was
    // asked on; a running download keeps its card wherever the reader goes.)
    const onRoute = () => { if (!running) finish(false); };
    let done = false; const finish = (v: boolean) => { if (done) return; done = true; window.removeEventListener('hashchange', onRoute); el.classList.add('leaving'); setTimeout(() => el.remove(), 180); if (current?.el === el) current = null; resolve(v); };
    window.addEventListener('hashchange', onRoute);
    let running = false;
    const total = o.steps.reduce((s, x) => s + (x.size ?? 0), 0);
    const overall = h('div', { class: 'task-bar' }, h('i', { style: { width: '0%' } })); overall.hidden = true;
    // (One bar, the whole download's; each part says how far it is in words and is ticked when in.)
    const rows = o.steps.map((s) => { const line = h('small', null, s.size ? formatBytes(s.size) : ''); return { s, line, el: h('div', { class: 'get-step' }, h('span', { class: 'grow' }, s.label), line) }; });
    const status = h('p', { class: 'get-status', hidden: true });
    const get = h('button', { type: 'button', class: 'btn small primary' }, icon('download'), total ? t('getItSize', { size: formatBytes(total) }) : t('getIt')) as HTMLButtonElement;
    const later = h('button', { type: 'button', class: 'btn small text' }, t('notNow')) as HTMLButtonElement;
    // (While it downloads it can be folded into a small pill — out of the way — and opened again with a tap.)
    const pct = h('span', { class: 'get-pct' });
    const fold = h('button', { type: 'button', class: 'icon-btn get-fold', title: t('getHide'), 'aria-label': t('getHide') }, icon('chevronDown')) as HTMLButtonElement;
    const el = h('div', { class: 'get-card', role: 'dialog', 'aria-live': 'polite', 'aria-label': o.title },
      h('div', { class: 'get-head' }, h('span', { class: 'get-ic' }, icon(o.icon)), h('div', { class: 'grow' }, h('b', null, o.title), h('small', null, o.why)), pct, fold),
      h('div', { class: 'get-steps' }, ...rows.map((r) => r.el)), overall, status, h('div', { class: 'get-actions' }, later, get));
    document.body.append(el); current = { el, finish, running: () => running, done: doneP };
    fold.addEventListener('click', (e) => { e.stopPropagation(); el.classList.add('mini'); });
    el.addEventListener('click', () => { if (el.classList.contains('mini')) el.classList.remove('mini'); });
    const sizes = rows.map((r) => r.s.size ?? 0); const got = rows.map(() => 0);
    // (Only Cancel pressed here counts as cancelled: any other failure — a dropped link, a server saying «canceled» —
    // shows its reason and Retry, never a silent «Cancelled».)
    let stopped = false;
    later.addEventListener('click', () => { if (running) { stopped = true; o.cancel?.(); } finish(false); });
    get.addEventListener('click', async () => {
      running = true; get.disabled = true; later.textContent = t('cancel'); overall.hidden = false; status.hidden = true; el.classList.add('running');
      const move = (i: number, d: number, tt: number) => {
        const r = rows[i]; if (!r) return; if (tt && !sizes[i]) sizes[i] = tt; got[i] = d;
        const f = tt ? Math.min(1, d / tt) : d ? 1 : 0;
        r.line.textContent = tt ? `${formatBytes(d)} / ${formatBytes(tt)}` : f >= 1 ? t('packReady') : t('packStarting');
        r.el.classList.toggle('done', f >= 1);
        const all = sizes.reduce((a, b) => a + b, 0); const sum = got.reduce((a, b) => a + b, 0);
        const of = all ? sum / all : rows.filter((x) => x.el.classList.contains('done')).length / rows.length;
        (overall.firstChild as HTMLElement).style.width = `${Math.round(of * 100)}%`; get.lastChild!.textContent = pct.textContent = `${localDigits(Math.round(of * 100))}%`;
      };
      try {
        await o.run(move);
        rows.forEach((_, i) => move(i, sizes[i] || 1, sizes[i] || 1));
        el.classList.add('ready'); el.classList.remove('mini'); get.lastChild!.textContent = t('packReady');
        setTimeout(() => finish(true), 700);
      } catch (e) {
        running = false; const m = String((e as Error).message ?? e);
        if (stopped || done) { finish(false); return; }
        status.hidden = false; status.textContent = /checksum/i.test(m) ? t('packChecksum') : t('packFailed', { why: m });
        get.disabled = false; get.lastChild!.textContent = t('retry'); later.textContent = t('notNow'); el.classList.remove('running', 'mini');
      }
    });
    if (o.start) get.click(); else get.focus();
  });
}
