// What was read and when (Mihon's History): the books opened, latest first, under the day they were last
// read — today, yesterday, then dates — each with where the reading stands; a tap carries on reading, the
// bin takes the book out of the history (the book stays in the library), and the whole history can be cleared.
import { h, icon, iconButton, openSheet, toast, coverColors } from './dom';
import { t, localDigits, getLang } from '../i18n';
import { db, type Book } from '../db';
import { coverUrl } from '../library';
import { navigate } from '../router';
import { getSettings, updateSettings } from '../settings';

const dayKey = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

function dayLabel(ms: number): string {
  const now = new Date(); const d = new Date(ms);
  const today = dayKey(now.getTime()), yest = dayKey(now.getTime() - 86400000);
  if (dayKey(ms) === today) return t('today');
  if (dayKey(ms) === yest) return t('yesterday');
  return d.toLocaleDateString(getLang() === 'ar' ? 'ar' : undefined, { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export async function historySheet(): Promise<void> {
  const sh = openSheet(t('history'), t('close'));
  sh.el.classList.add('history-sheet'); sh.body.style.fontFamily = 'var(--font-ui)';
  const find = h('input', { type: 'search', class: 'src-search', placeholder: t('search'), dir: 'auto' }) as HTMLInputElement;
  const list = h('div', { class: 'history-list' });
  // (Incognito: what is read from now on is not put here, nor in the reading stats, nor sent to AniList.)
  const inc = h('input', { type: 'checkbox', checked: getSettings().incognito }) as HTMLInputElement;
  inc.addEventListener('change', () => { updateSettings({ incognito: inc.checked }); toast(t(inc.checked ? 'incognitoOn' : 'incognitoOff')); });
  sh.body.append(h('label', { class: 'incognito-row' }, icon('eye'), h('span', { class: 'incognito-text' }, h('b', null, t('incognito')), h('small', { class: 'src' }, t('incognitoHint'))), inc), find, list);
  let books: Book[] = [];
  const draw = () => {
    const q = find.value.trim().toLowerCase();
    const shown = books.filter((b) => b.lastOpenedAt && (!q || b.title.toLowerCase().includes(q) || (b.author ?? '').toLowerCase().includes(q)))
      .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0));
    list.replaceChildren();
    if (!shown.length) { list.append(h('p', { class: 'hint history-empty' }, q ? t('noResults') : t('historyEmpty'))); return; }
    let day = '';
    for (const b of shown) {
      const k = dayKey(b.lastOpenedAt!);
      if (k !== day) { day = k; list.append(h('h4', { class: 'history-day' }, dayLabel(b.lastOpenedAt!))); }
      const url = coverUrl(b); const [c1, c2] = coverColors(b.title);
      const pct = Math.round((b.progress?.pct ?? 0) * 100);
      const time = new Date(b.lastOpenedAt!).toLocaleTimeString(getLang() === 'ar' ? 'ar' : undefined, { hour: 'numeric', minute: '2-digit' });
      const row = h('div', { class: 'history-row' },
        h('button', { type: 'button', class: 'history-open', onclick: () => { sh.close(); navigate(`/read/${b.id}`); } },
          url ? h('img', { class: 'history-cover', src: url, alt: '' }) : h('span', { class: 'history-cover', style: { background: `linear-gradient(160deg, ${c1}, ${c2})` } }),
          h('span', { class: 'history-text' },
            h('b', { dir: 'auto' }, b.title),
            h('small', null, h('bdi', null, time), pct ? ' · ' : '', pct ? h('bdi', null, getLang() === 'ar' ? `٪${localDigits(String(pct))}` : `${pct}%`) : '', b.author ? ' · ' : '', b.author ? h('bdi', { dir: 'auto' }, b.author) : ''))),
        iconButton('trash', t('removeFromHistory'), async () => {
          await db.updateBook(b.id, (x) => { delete x.lastOpenedAt; }); b.lastOpenedAt = undefined; draw(); toast(t('removedFromHistory'));
        }));
      list.append(row);
    }
  };
  find.addEventListener('input', draw);
  sh.actions.append(h('button', { type: 'button', class: 'btn text', onclick: async () => {
    if (!confirm(t('clearHistoryConfirm'))) return;
    for (const b of books.filter((x) => x.lastOpenedAt)) { await db.updateBook(b.id, (x) => { delete x.lastOpenedAt; }); b.lastOpenedAt = undefined; }
    draw(); toast(t('historyCleared'));
  } }, icon('trash'), t('clearHistory')));
  books = await db.allBooks();
  draw();
}
