// Reading in order: books chosen and put in a sequence — the volumes of a story, say — read one after the
// other. When one ends, scrolling on (or the pill at the bottom) opens the next. The order is kept until it
// is cleared, and can be changed at any time from the reader's menu.
import { h, icon, openSheet, toast, coverColors } from './dom';
import { t, localDigits } from '../i18n';
import { db, type Book } from '../db';
import { navigate } from '../router';

const KEY = 'kr.queue';

export function getQueue(): string[] { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]; } catch { return []; } }
export function setQueue(ids: string[]): void { try { if (ids.length) localStorage.setItem(KEY, JSON.stringify(ids)); else localStorage.removeItem(KEY); } catch { /* private mode */ } }
export const inQueue = (id: string): boolean => getQueue().includes(id);
export function nextInQueue(id: string): string | null { const q = getQueue(); const i = q.indexOf(id); return i >= 0 && i + 1 < q.length ? q[i + 1] : null; }

/** Arrange the order (from a selection, or the order in force), then start or keep it. */
export async function queueSheet(ids: string[], opts: { start?: boolean; onChange?(): void } = {}): Promise<void> {
  const all = await db.allBooks();
  const byId = new Map(all.map((b) => [b.id, b]));
  let order = ids.filter((id) => byId.has(id));
  if (!order.length) { toast(t('noResults')); return; }
  const sh = openSheet(t('readInOrder'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  const list = h('div', { class: 'queue-list' });
  const draw = () => {
    list.replaceChildren(...order.map((id, k) => {
      const b = byId.get(id)!; const [c1, c2] = coverColors(b.title); const pct = Math.round((b.progress?.pct ?? 0) * 100);
      return h('div', { class: 'queue-row', dataset: { k: String(k) } },
        h('span', { class: 'queue-no' }, localDigits(String(k + 1))),
        h('div', { class: 'cover small gen', style: { background: `linear-gradient(135deg, ${c1}, ${c2})` } }),
        h('div', { class: 'queue-text' }, h('div', { class: 'queue-title', dir: 'auto' }, b.title), h('div', { class: 'src' }, pct ? `${localDigits(String(pct))}%` : t('statusUnread'))),
        h('button', { type: 'button', class: 'icon-btn small', 'aria-label': t('moveUp'), disabled: k === 0, onclick: () => { [order[k - 1], order[k]] = [order[k], order[k - 1]]; draw(); } }, icon('chevronUp')),
        h('button', { type: 'button', class: 'icon-btn small', 'aria-label': t('moveDown'), disabled: k === order.length - 1, onclick: () => { [order[k + 1], order[k]] = [order[k], order[k + 1]]; draw(); } }, icon('chevronDown')),
        h('button', { type: 'button', class: 'icon-btn small', 'aria-label': t('remove'), onclick: () => { order.splice(k, 1); draw(); } }, icon('close')));
    }));
  };
  sh.body.append(h('p', { class: 'hint' }, t('readInOrderHint')), list);
  const start = h('button', { type: 'button', class: 'btn small primary', onclick: () => {
    if (!order.length) { setQueue([]); sh.close(); opts.onChange?.(); return; }
    setQueue(order); sh.close(); opts.onChange?.();
    if (opts.start) { const first = order.find((id) => (byId.get(id)!.progress?.pct ?? 0) < 0.98 && !byId.get(id)!.done) ?? order[0]; navigate(`/read/${first}`); }
    else toast(t('orderKept'));
  } }, icon('play'), opts.start ? t('startReading') : t('done'));
  sh.actions.append(
    h('button', { type: 'button', class: 'btn small danger', onclick: () => { setQueue([]); sh.close(); opts.onChange?.(); toast(t('orderCleared')); } }, icon('close'), t('stopOrder')),
    start);
  draw();
}

/** The book after `id` in the order, if any (as a book). */
export async function nextQueued(id: string): Promise<Book | null> {
  const next = nextInQueue(id); if (!next) return null;
  return (await db.getBook(next)) ?? null;
}
