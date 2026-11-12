// «Customise buttons»: where each of the reader's actions lives — the top bar (its start or its end), the toolbar,
// «More», or hidden — in what order, where the toolbar stands and how it looks; a list for flowing books and one for
// PDFs (src/readbuttons.ts). Opened from «More» in a book (always there) and from the reader's options. Every change
// is saved and applied to the open book at once; a small picture of the bars shows the result.
import { h, icon, openSheet } from './dom';
import { t, getLang } from '../i18n';
import type { Strings } from '../i18n/en';
import { getSettings, updateSettings, defaultOf, type VisualSettings } from '../settings';
import { groupedPlacesEditor, type PlaceChoice } from './placeditems';
import { normalizeButtons, toolbarOf, isSep, idsAt, FLOW_ACTIONS, PDF_ACTIONS, DEFAULT_FLOW_BUTTONS, DEFAULT_PDF_BUTTONS, type ButtonPlace, type PlacedButton, type BarAt } from '../readbuttons';

type Kind = 'flow' | 'pdf';
const rtl = () => document.documentElement.dir === 'rtl' || getLang() === 'ar';

/** A small picture of a place: a screen with its top bar, the button's spot marked. */
function glyph(at: ButtonPlace): Node {
  if (at === 'more') return icon('more');
  return h('span', { class: `pg pg-${at}` }, h('i'));
}

const placeLabel = (at: ButtonPlace, kind: Kind): string => t(({ topStart: 'placeTopStart', topEnd: 'placeTopEnd', bar: kind === 'pdf' ? 'placePageBar' : 'placeToolbar', more: 'placeMore', hidden: 'placeHidden' } as const)[at]);

/** Where a PDF's page bar stands, in the new terms, from its settings (an older side «right»/«left» read as the side
 *  it is on in this interface's direction). */
export function pdfBarAt(s: VisualSettings = getSettings()): BarAt {
  if (s.pdfBar === 'auto') return 'auto';
  if (s.pdfBar === 'side') return s.pdfBarSide === 'start' || s.pdfBarSide === 'end' ? s.pdfBarSide : (s.pdfBarSide === 'right') !== rtl() ? 'end' : 'start';
  return s.pdfBarRow === 'top' ? 'top' : 'bottom';
}
function setPdfBarAt(at: BarAt): void {
  const s = getSettings();
  if (at === 'auto') updateSettings({ pdfBar: 'auto' });
  // (From the side: two rows on a narrow screen, where one row leaves the slider no room; one where it is wide.)
  else if (at === 'bottom' || at === 'top') updateSettings({ pdfBar: s.pdfBar === 'rows' || s.pdfBar === 'row' ? s.pdfBar : window.innerWidth < 600 ? 'rows' : 'row', pdfBarRow: at });
  else updateSettings({ pdfBar: 'side', pdfBarSide: at });
}

export function buttonSheet(start: Kind = 'flow'): void {
  const sh = openSheet(t('customiseButtons'), t('close'));
  sh.el.classList.add('buttons-sheet');
  sh.body.style.fontFamily = 'var(--font-ui)';
  let kind: Kind = start;
  const body = h('div');
  sh.body.append(h('p', { class: 'hint' }, t('buttonsIntro')), h('div', { class: 'segmented buttons-kind', role: 'tablist' },
    ...(['flow', 'pdf'] as Kind[]).map((k) => h('button', { type: 'button', role: 'tab', dataset: { kind: k }, 'aria-pressed': String(k === kind), 'aria-selected': String(k === kind), onclick: (e: Event) => { kind = k; (e.currentTarget as HTMLElement).parentElement!.querySelectorAll('button').forEach((b) => { const on = b.dataset.kind === k; b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-selected', String(on)); }); draw(); } }, t(k === 'flow' ? 'buttonsBooks' : 'buttonsPdfs')))), body);
  const draw = () => body.replaceChildren(...editorFor(kind, draw));
  draw();
}

function editorFor(kind: Kind, redraw: () => void): HTMLElement[] {
  const s = getSettings();
  const actions = kind === 'pdf' ? PDF_ACTIONS : FLOW_ACTIONS;
  const key = kind === 'pdf' ? 'pdfButtons' : 'readerButtons';
  const list = normalizeButtons(s[key], kind);
  const save = (next: PlacedButton[]) => { updateSettings(kind === 'pdf' ? { pdfButtons: next } : { readerButtons: next, readerToolbar: toolbarOf(next) }); paint(); };
  const nameOf = (id: string) => (isSep(id) ? t('separator') : t((actions.find((a) => a.id === id)?.label ?? 'more') as keyof Strings));
  const iconOf = (id: string) => (isSep(id) ? 'minus' : actions.find((a) => a.id === id)?.icon ?? 'more');

  // A small picture of the bars as they are now chosen.
  const preview = h('div', { class: 'btn-preview', 'aria-hidden': 'true' });
  const paint = () => {
    const cur = normalizeButtons(getSettings()[key], kind);
    const at = kind === 'pdf' ? pdfBarAt() : getSettings().toolbarAt;
    const look = kind === 'pdf' ? getSettings().pdfBarLook : getSettings().toolbarLook;
    const ic = (id: string) => (isSep(id) ? h('span', { class: 'pv-sep' }) : h('span', { class: 'pv-ic' }, icon(iconOf(id))));
    const barIds = idsAt(cur, 'bar');
    const moreOnBar = kind === 'flow' && barIds.length > 0;
    preview.dataset.at = at === 'auto' ? (kind === 'pdf' ? 'end' : document.documentElement.classList.contains('pc') ? 'inline' : 'bottom') : at;
    preview.dataset.look = look;
    preview.replaceChildren(
      h('div', { class: 'pv-top' }, h('span', { class: 'pv-ic fixed' }, icon('back')), ...idsAt(cur, 'topStart').map(ic), h('span', { class: 'pv-title' }), ...idsAt(cur, 'topEnd').map(ic), moreOnBar ? null : h('span', { class: 'pv-ic fixed' }, icon('more'))),
      h('div', { class: 'pv-lines' }, ...Array.from({ length: 7 }, () => h('i'))),
      ...(barIds.length || moreOnBar ? [h('div', { class: 'pv-bar' }, ...barIds.map((id) => (id === 'pageNav' ? h('span', { class: 'pv-slider' }) : ic(id))), moreOnBar ? h('span', { class: 'pv-ic fixed' }, icon('more')) : null)] : []));
  };
  paint();

  // Where the toolbar stands and how it looks.
  const seg = <T extends string>(items: [T, string][], value: T, pick: (v: T) => void, label: string) => h('div', { class: 'field' }, h('span', { class: 'label' }, label),
    h('div', { class: 'segmented', role: 'group', 'aria-label': label }, ...items.map(([id, l]) => h('button', { type: 'button', 'aria-pressed': String(value === id), dataset: { v: id }, onclick: () => { pick(id); redraw(); } }, l))));
  const ats: [BarAt, string][] = [['auto', t(kind === 'pdf' ? 'barAtOrientation' : 'barAtAuto')], ['bottom', t('posBottom')], ['top', t('posTop')], ['start', t('barAtStart')], ['end', t('barAtEnd')]];
  const where = kind === 'pdf'
    ? seg(ats, pdfBarAt(s), (v) => setPdfBarAt(v), t('pageBarPlace'))
    : seg(ats, s.toolbarAt, (v) => updateSettings({ toolbarAt: v }), t('toolbarPlace'));
  const look = seg([['pill', t('barLookPill')], ['docked', t('barLookDocked')]], (kind === 'pdf' ? s.pdfBarLook : s.toolbarLook) ?? 'pill', (v) => updateSettings(kind === 'pdf' ? { pdfBarLook: v } : { toolbarLook: v }), t('barLook'));
  const rows = kind === 'pdf' && (s.pdfBar === 'row' || s.pdfBar === 'rows') ? seg([['row', t('pdfBarRow')], ['rows', t('pdfBarRows')]] as [VisualSettings['pdfBar'], string][], s.pdfBar, (v) => updateSettings({ pdfBar: v }), t('pdfBarLines')) : null;

  const places: PlaceChoice<ButtonPlace>[] = (['topStart', 'topEnd', 'bar', 'more', 'hidden'] as ButtonPlace[]).map((p) => ({ id: p, label: placeLabel(p, kind), glyph: () => glyph(p) }));
  let seps = list.filter((x) => isSep(x.id)).length;
  const editor = groupedPlacesEditor(list, {
    places,
    label: nameOf, icon: iconOf,
    allowed: (id, at) => { const a = actions.find((x) => x.id === id); return !a?.only || a.only.includes(at); },
    removable: (id) => isSep(id),
    fixed: (at) => [
      ...(at === 'topStart' ? [{ icon: 'back', label: t('back'), note: t('fixedBack') }] : []),
      ...(kind === 'flow' && at === 'bar' ? [{ icon: 'more', label: t('more'), note: t('fixedMoreToolbar') }] : []),
      ...(kind === 'pdf' && at === 'topEnd' ? [{ icon: 'more', label: t('more'), note: t('fixedMoreTop') }] : []),
      ...(at === 'more' ? [{ icon: 'settings', label: t('customiseButtons'), note: t('fixedCustomise') }] : []),
      ...(kind === 'pdf' && at === 'bar' ? [] : []),
    ],
    extra: (at, add) => (kind === 'flow' && at === 'bar' ? h('button', { type: 'button', class: 'btn small outlined add-sep', onclick: () => { const used = new Set(normalizeButtons(getSettings()[key], kind).map((x) => x.id)); let n = ++seps; let id = n === 1 ? 'sep' : `sep${n}`; while (used.has(id)) { n = ++seps; id = `sep${n}`; } add(id); } }, icon('plus'), t('addSeparator')) : null),
    onChange: save,
  });
  const reset = h('button', { type: 'button', class: 'btn small outlined', onclick: () => {
    if (kind === 'pdf') updateSettings({ pdfButtons: DEFAULT_PDF_BUTTONS.map((x) => ({ ...x })), pdfBar: defaultOf('pdfBar'), pdfBarSide: defaultOf('pdfBarSide'), pdfBarRow: defaultOf('pdfBarRow'), pdfBarLook: 'pill' });
    else updateSettings({ readerButtons: DEFAULT_FLOW_BUTTONS.map((x) => ({ ...x })), readerToolbar: defaultOf('readerToolbar'), toolbarAt: 'auto', toolbarLook: 'pill' });
    redraw();
  } }, icon('undo'), t('resetDefaults'));
  return [preview, where, look, ...(rows ? [rows] : []), h('p', { class: 'hint' }, t('buttonsHidden')), editor, h('div', { class: 'buttons-foot' }, reset)];
}

/** The reader's options: a line that opens the sheet. */
export function buttonsField(kind: Kind): HTMLElement {
  return h('div', { class: 'field' }, h('span', { class: 'label' }, t('readerButtons')), h('p', { class: 'hint' }, t('readerButtonsHint')),
    h('button', { type: 'button', class: 'btn small outlined open-buttons', onclick: () => buttonSheet(kind) }, icon('settings'), t('customiseButtons')));
}
