// The filters' studio list: AniList's studios, the best liked first, narrowed as you type (accents and case aside),
// with any studio AniList finds by that name added under them; several can be ticked. Animation studios and
// producers can be shown apart.
import { h, icon, openSheet } from '../ui/dom';
import { t, localDigits } from '../i18n';
import * as al from '../anilist';

type Pick = { id: number; name: string };
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function studioPicker(chosen: Pick[], done: (picked: Pick[]) => void): void {
  const picked = new Map(chosen.map((s) => [s.id, s]));
  const sh = openSheet(t('dcStudios'), t('close'), { stack: true }); sh.el.classList.add('studio-picker');
  const q = h('input', { type: 'search', class: 'search-input', placeholder: t('animeStudioSearch'), autocomplete: 'off' }) as HTMLInputElement;
  let kind: 'all' | 'anim' | 'prod' = 'all';
  const kinds = h('div', { class: 'chip-row wrap' });
  const drawKinds = () => kinds.replaceChildren(...([['all', t('animeAny')], ['anim', t('dcAnimationStudio')], ['prod', t('dcProducer')]] as const).map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (kind === k ? ' on' : ''), onclick: () => { kind = k; drawKinds(); draw(); } }, l)));
  const count = h('small', { class: 'src sp-count' });
  const list = h('div', { class: 'sp-list', role: 'listbox', 'aria-multiselectable': 'true' }, h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  let all: al.StudioEntry[] = []; let found: al.StudioEntry[] = []; let asked = '';
  const row = (s: Pick & { animation?: boolean; favourites?: number }) => {
    const on = picked.has(s.id);
    return h('button', { type: 'button', class: 'sp-row' + (on ? ' on' : ''), role: 'option', 'aria-selected': String(on), onclick: () => { if (picked.has(s.id)) picked.delete(s.id); else picked.set(s.id, { id: s.id, name: s.name }); draw(); } },
      h('span', { class: 'sp-box' }, on ? icon('check') : null), h('span', { class: 'sp-name', dir: 'auto' }, s.name),
      h('small', { class: 'src' }, [s.animation === undefined ? '' : s.animation ? t('dcAnimationStudio') : t('dcProducer'), s.favourites ? `♥ ${localDigits(s.favourites)}` : ''].filter(Boolean).join(' · ')));
  };
  const draw = () => {
    const needle = fold(q.value); const fits = (s: al.StudioEntry) => (kind === 'all' || (kind === 'anim') === s.animation) && (!needle || fold(s.name).includes(needle));
    const seen = new Set<number>(); const rows: HTMLElement[] = [];
    // (The ticked ones first, then the list's, then what AniList found by the name that the list lacks.)
    for (const s of picked.values()) { seen.add(s.id); const e = all.find((x) => x.id === s.id) ?? found.find((x) => x.id === s.id); rows.push(row({ ...s, animation: e?.animation, favourites: e?.favourites })); }
    for (const s of [...all, ...found]) { if (seen.has(s.id) || !fits(s)) continue; seen.add(s.id); rows.push(row(s)); if (rows.length > 300) break; }
    list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'empty small' }, t('noResults'))]));
    count.textContent = picked.size ? t('spChosen', { n: localDigits(picked.size) }) : '';
    clear.hidden = !picked.size;
  };
  let timer = 0;
  q.addEventListener('input', () => { draw(); window.clearTimeout(timer); const s = q.value.trim(); if (s.length < 2 || s === asked) return;
    timer = window.setTimeout(() => { asked = s; void al.searchStudios(s).then((ss) => { if (q.value.trim() !== s) return; found = ss.map((x) => ({ id: x.id, name: x.name, animation: x.animation, favourites: x.favourites ?? 0 })); draw(); }).catch(() => undefined); }, 400); });
  const clear = h('button', { type: 'button', class: 'btn text', hidden: true, onclick: () => { picked.clear(); draw(); } }, t('clearAll'));
  sh.body.append(q, kinds, count, list);
  sh.actions.append(clear, h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); done([...picked.values()]); } }, icon('check'), t('done')));
  drawKinds(); draw();
  void al.studioList().then((v) => { all = v; draw(); }).catch((e) => { if (!all.length) list.replaceChildren(h('p', { class: 'empty small' }, String((e as Error)?.message ?? e))); });
  setTimeout(() => q.focus(), 80);
}
