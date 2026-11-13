// The reader's bars drawn from the placed buttons (src/readbuttons.ts): the top bar — the back arrow (fixed), the
// buttons at its start, the title, the buttons at its end —, the toolbar (a flowing book's floating toolbar, a PDF's
// page bar), and the list «More» shows. What a bar cannot hold at the width it has goes to «More» (measured, from
// the bar's end), not cut or wrapped; it comes back when there is room again.
import { h, icon, iconButton } from './dom';
import { t } from '../i18n';
import type { Strings } from '../i18n/en';
import { getSettings } from '../settings';
import { normalizeButtons, isSep, FLOW_ACTIONS, PDF_ACTIONS, type PlacedButton, type ButtonPlace } from '../readbuttons';

/** What an action does in the open book; its name and icon when they change (read aloud / stop…), and whether it
 *  can be done here at all (a PDF with no ink has nothing to export with it). `bar`: its own control on the toolbar
 *  (a PDF's «go to page» field). */
export interface ActionRun { run: () => void; label?: () => string; icon?: () => string; available?: () => boolean; bar?: () => HTMLElement }

export interface BarsHost {
  kind: 'flow' | 'pdf';
  root: HTMLElement;
  topbar: HTMLElement;
  back: HTMLElement;
  title: HTMLElement;
  /** Where the toolbar's buttons go (a flowing book's toolbar itself; a PDF's tools part of its page bar). */
  toolbar: HTMLElement;
  /** The element whose room is measured for the toolbar (the toolbar, or the PDF's whole page bar). */
  toolbarBox: HTMLElement;
  /** Other parts of that bar that must keep their room (the PDF's page slider). */
  keepRoom?: () => HTMLElement[];
  /** The «More» button, kept: on the toolbar (a flowing book's, while it holds anything) or at the top bar's end. */
  more: HTMLElement;
  actions: Record<string, ActionRun>;
  /** A button made for the toolbar (a computer's toolbar adds its name). */
  dress?: (b: HTMLElement) => HTMLElement;
  /** A PDF's page slider shown or not (the place of its «pageNav»). */
  onNav?: (shown: boolean) => void;
  /** After each drawing (the toolbar's state for the styles). */
  after?: (state: { toolbarEmpty: boolean }) => void;
}

const infoOf = (kind: 'flow' | 'pdf', id: string) => (kind === 'pdf' ? PDF_ACTIONS : FLOW_ACTIONS).find((a) => a.id === id);
export const actionLabel = (kind: 'flow' | 'pdf', id: string): string => { const a = infoOf(kind, id); return a ? t(a.label as keyof Strings) : id; };
export const actionIcon = (kind: 'flow' | 'pdf', id: string): string => infoOf(kind, id)?.icon ?? 'more';

export interface Bars { render(): void; moreIds(): string[]; overflowed(): string[]; dispose(): void }

export function mountBars(host: BarsHost): Bars {
  const { kind, root, topbar, back, title, toolbar, toolbarBox, more, actions } = host;
  let over: string[] = [];
  const list = (): PlacedButton[] => normalizeButtons(kind === 'pdf' ? getSettings().pdfButtons : getSettings().readerButtons, kind);
  const can = (id: string) => { try { return isSep(id) || (!!actions[id] && actions[id].available?.() !== false); } catch { return false; } };
  // (A name or icon that follows the book's state, read while the reader is still opening, may not be ready: the
  // action's own then.)
  const labelOf = (id: string) => { try { return actions[id]?.label?.() ?? actionLabel(kind, id); } catch { return actionLabel(kind, id); } };
  const iconOf = (id: string) => { try { return actions[id]?.icon?.() ?? actionIcon(kind, id); } catch { return actionIcon(kind, id); } };
  const button = (id: string, where: ButtonPlace): HTMLElement => {
    if (isSep(id)) return h('span', { class: 'sep', dataset: { action: id } });
    const own = where === 'bar' ? actions[id]?.bar?.() : undefined;
    const b = own ?? iconButton(iconOf(id), labelOf(id), () => actions[id].run());
    b.dataset.action = id;
    return where === 'bar' && host.dress ? host.dress(b) : b;
  };
  /** The toolbar's ids with separators only between buttons (none at an end, none twice). */
  const tidy = (ids: string[]): string[] => { const out: string[] = []; for (const id of ids) { if (isSep(id) && (!out.length || isSep(out[out.length - 1]))) continue; out.push(id); } while (out.length && isSep(out[out.length - 1])) out.pop(); return out; };
  // (Laid out — not hidden, not out of the page — and its content beyond its box.)
  // (Along the bar's own line only: a bar down a side may be a few pixels too narrow for a field, as it always was.)
  const overflows = (el: HTMLElement) => { if (!el.isConnected || !el.getClientRects().length) return false; const col = getComputedStyle(el).flexDirection.startsWith('column'); return col ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1; };
  /** The first button after the title (pushed to the end on a computer, where the title does not stretch). */
  const markFirst = () => { for (const c of topbar.children) c.classList.remove('top-end-first'); title.nextElementSibling?.classList.add('top-end-first'); };

  function render(): void {
    const all = list().filter((x) => can(x.id));
    const at = (p: ButtonPlace) => all.filter((x) => x.at === p).map((x) => x.id);
    let barIds = at('bar');
    if (kind === 'pdf') { host.onNav?.(barIds.includes('pageNav')); barIds = barIds.filter((id) => id !== 'pageNav'); }
    barIds = tidy(barIds);
    const startIds = at('topStart'), endIds = at('topEnd');
    // (A flowing book's «More» stays on its toolbar while the toolbar has anything; else, as a PDF's, at the top's end.)
    const moreOnBar = kind === 'flow' && barIds.length > 0;
    const startEls = startIds.map((id) => button(id, 'topStart'));
    const endEls = endIds.map((id) => button(id, 'topEnd'));
    const barEls = barIds.map((id) => button(id, 'bar'));
    topbar.replaceChildren(back, ...startEls, title, ...endEls, ...(moreOnBar ? [] : [more]));
    markFirst();
    toolbar.replaceChildren(...barEls, ...(moreOnBar ? [host.dress ? host.dress(more) : more] : []));
    toolbar.hidden = kind === 'flow' && !moreOnBar;
    over = [];
    host.after?.({ toolbarEmpty: kind === 'flow' ? !moreOnBar : !barIds.length });
    fit(barEls, startEls, endEls);
  }

  /** What does not fit goes to «More»: the toolbar's last buttons first, then the top bar's (its end's, then its
   *  start's) — measured as laid out now. A computer's toolbar first drops the buttons' names. */
  function fit(barEls: HTMLElement[], startEls: HTMLElement[], endEls: HTMLElement[]): void {
    toolbar.classList.remove('tb-compact');
    // (The room the top bar's own buttons take at its start and its end — a computer's toolbar sits between them.)
    const room = () => { const w = (els: Element[]) => els.reduce((n, e) => n + (e as HTMLElement).offsetWidth + 4, 0); const kids = [...topbar.children]; const ti = kids.indexOf(title); root.style.setProperty('--ts-w', `${w(kids.slice(1, ti))}px`); root.style.setProperty('--te-w', `${Math.max(56, w(kids.slice(ti + 1)) + 4)}px`); };
    room();
    const barOver: string[] = [], topOver: string[] = [];
    const drop = (els: HTMLElement[], into: string[]) => {
      const el = els.pop(); if (!el) return false;
      el.remove(); if (!isSep(el.dataset.action ?? '')) into.unshift(el.dataset.action ?? '');
      // (A separator left at the end goes too.)
      while (els.length && isSep(els[els.length - 1].dataset.action ?? '')) els.pop()!.remove();
      return true;
    };
    const tight = () => overflows(toolbarBox) || overflows(toolbar) || (host.keepRoom?.() ?? []).some(overflows);
    if (!toolbar.hidden && tight()) {
      if (toolbar.querySelector('.tb-label') && getComputedStyle(toolbar.querySelector('.tb-label')!).display !== 'none') { toolbar.classList.add('tb-compact'); }
      for (let i = 0; i < 60 && tight(); i++) if (!drop(barEls, barOver)) break;
    }
    for (let i = 0; i < 60 && overflows(topbar); i++) if (!drop(endEls, topOver) && !drop(startEls, topOver)) break;
    markFirst();
    if (topOver.length) room();
    over = [...topOver, ...barOver];
    root.dataset.overflow = String(over.length);
  }

  // Drawn again when the settings change, and when the room changes (the window, the screen turned, a panel docked).
  let lastW = 0, lastH = 0, raf = 0;
  const ro = new ResizeObserver(() => {
    const w = root.clientWidth, hh = root.clientHeight;
    if (Math.abs(w - lastW) < 1 && Math.abs(hh - lastH) < 1) return;
    lastW = w; lastH = hh; cancelAnimationFrame(raf); raf = requestAnimationFrame(render);
  });
  ro.observe(root);
  return {
    render,
    /** «More»'s list: what did not fit on the bars (in their order), then the actions placed in it. */
    moreIds: () => [...over, ...list().filter((x) => x.at === 'more' && !isSep(x.id) && can(x.id)).map((x) => x.id)].filter((id, i, a) => a.indexOf(id) === i),
    overflowed: () => [...over],
    dispose: () => { ro.disconnect(); cancelAnimationFrame(raf); },
  };
}

/** «More»'s list drawn from the placed buttons, with «Customise buttons» last, always. */
export function moreList(kind: 'flow' | 'pdf', ids: string[], actions: Record<string, ActionRun>, close: () => void, customise: () => void): HTMLElement {
  const item = (id: string, name: string, label: string, fn: () => void) => h('li', null, h('button', { type: 'button', dataset: { action: id }, onclick: () => { close(); fn(); } }, icon(name), label));
  return h('ul', { class: 'plain-list more-list' },
    ...ids.map((id) => item(id, actions[id]?.icon?.() ?? actionIcon(kind, id), actions[id]?.label?.() ?? actionLabel(kind, id), () => actions[id]?.run())),
    h('li', { class: 'more-fixed' }, h('button', { type: 'button', dataset: { action: 'customise' }, onclick: () => { close(); customise(); } }, icon('settings'), t('customiseButtons'))));
}
