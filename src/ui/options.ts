// Visual Options panel content.
import { h, clear } from './dom';
import { t } from '../i18n';
import { getSettings, updateSettings, resetSettings, type VisualSettings, type Theme, type LatinFont, type ArabicFont } from '../settings';

export function renderOptions(container: HTMLElement, opts: { pdf?: boolean } = {}): void {
  clear(container);
  const s = getSettings();
  const grid = h('div', { class: 'options-grid' });

  const themes: [Theme, string, string, string][] = [
    ['dark', t('themeDark'), '#14110f', '#e6dcc8'], ['black', t('themeBlack'), '#000', '#d9d2c4'], ['sepia', t('themeSepia'), '#f3e8d2', '#3b2f21'], ['paper', t('themePaper'), '#ebe5da', '#27221d'], ['light', t('themeLight'), '#fbfaf7', '#1d1a16'],
  ];
  grid.append(section(t('theme'), h('div', { class: 'theme-swatches' }, ...themes.map(([id, label, bg, fg]) =>
    h('button', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(s.theme === id), style: { background: bg, color: fg }, onclick: () => { updateSettings({ theme: id }); renderOptions(container, opts); } }, 'Aa')))));

  if (opts.pdf) {
    grid.append(toggle(t('invertColors'), s.pdfInvert, (v) => updateSettings({ pdfInvert: v })));
    container.append(grid, footer());
    return;
  }

  const latin: [LatinFont, string][] = [['lora', 'Lora'], ['inter', 'Inter'], ['serif', t('fontSystemSerif')], ['sans', t('fontSystemSans')], ['publisher', t('fontPublisher')]];
  const arabic: [ArabicFont, string][] = [['uthman', 'عثمان طه'], ['sultan', 'سلطان'], ['naskh', 'نسخ'], ['publisher', t('fontPublisher')]];
  grid.append(section(t('latinFont'), segmented(latin, s.latinFont, (v) => { updateSettings({ latinFont: v }); renderOptions(container); })));
  grid.append(section(t('arabicFont'), segmented(arabic, s.arabicFont, (v) => { updateSettings({ arabicFont: v }); renderOptions(container); }, true)));

  grid.append(stepper(t('fontSize'), s.fontSize, 12, 40, 1, (v) => updateSettings({ fontSize: v }), (v) => `${v}`));
  grid.append(stepper(t('lineHeight'), s.lineHeight, 1.2, 2.6, 0.1, (v) => updateSettings({ lineHeight: Math.round(v * 10) / 10 }), (v) => v.toFixed(1)));
  grid.append(stepper(t('paragraphSpacing'), s.paragraphSpacing, 0, 2.5, 0.1, (v) => updateSettings({ paragraphSpacing: Math.round(v * 10) / 10 }), (v) => v.toFixed(1)));
  grid.append(stepper(t('pageWidth'), s.textWidth, 420, 1400, 40, (v) => updateSettings({ textWidth: v }), (v) => `${v}`));
  grid.append(stepper(t('margins'), s.margin, 0, 80, 4, (v) => updateSettings({ margin: v }), (v) => `${v}`));
  grid.append(stepper(t('wordSpacing'), s.wordSpacing, -0.05, 0.5, 0.01, (v) => updateSettings({ wordSpacing: Math.round(v * 100) / 100 }), (v) => v.toFixed(2)));
  grid.append(stepper(t('letterSpacing'), s.letterSpacing, -0.05, 0.2, 0.005, (v) => updateSettings({ letterSpacing: Math.round(v * 1000) / 1000 }), (v) => v.toFixed(3)));

  const aligns: [VisualSettings['align'], string][] = [['start', t('alignStart')], ['justify', t('alignJustify')], ['center', t('alignCenter')]];
  grid.append(section(t('textAlign'), segmented(aligns, s.align, (v) => { updateSettings({ align: v }); renderOptions(container); })));

  grid.append(toggle(t('publisherStyles'), s.publisherStyles, (v) => { updateSettings({ publisherStyles: v }); container.dispatchEvent(new CustomEvent('kr-rerender', { bubbles: true })); }));
  grid.append(toggle(t('dimImages'), s.dimImages, (v) => updateSettings({ dimImages: v })));
  grid.append(toggle(t('hyphenate'), s.hyphenate, (v) => updateSettings({ hyphenate: v })));

  container.append(grid, footer());

  function footer() {
    return h('div', { style: { marginTop: '22px' } }, h('button', { class: 'btn small', onclick: () => { resetSettings(); renderOptions(container, opts); container.dispatchEvent(new CustomEvent('kr-rerender', { bubbles: true })); } }, t('resetDefaults')));
  }
}

function section(label: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'field' }, h('span', { class: 'label' }, label), control);
}

function segmented<T extends string>(items: [T, string][], value: T, onPick: (v: T) => void, arabicFont = false): HTMLElement {
  return h('div', { class: 'segmented' }, ...items.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(value === id), onclick: () => onPick(id), style: arabicFont && id !== 'publisher' ? { fontFamily: id === 'uthman' ? "'Uthman TN1'" : id === 'sultan' ? "'Sultan'" : "'Noto Naskh Arabic'", fontSize: '16px' } : id === 'lora' ? { fontFamily: "'Lora'" } : undefined }, label)));
}

function stepper(label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, fmt: (v: number) => string): HTMLElement {
  const out = h('output', null, fmt(value));
  let v = value;
  const set = (nv: number) => { v = Math.min(max, Math.max(min, nv)); out.textContent = fmt(v); range.value = String(v); onChange(v); };
  const range = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label, oninput: () => set(Number(range.value)) }) as HTMLInputElement;
  return h('div', { class: 'field' },
    h('div', { class: 'row' }, h('span', { class: 'label' }, label), h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': '−', onclick: () => set(v - step) }, '−'), out, h('button', { type: 'button', 'aria-label': '+', onclick: () => set(v + step) }, '+'))),
    range);
}

function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const cb = h('input', { type: 'checkbox', onchange: () => onChange(cb.checked) }) as HTMLInputElement;
  cb.checked = value;
  return h('label', { class: 'row' }, h('span', { class: 'label' }, label), cb);
}
