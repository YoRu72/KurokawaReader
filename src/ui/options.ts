// Visual Options panel: theme & custom colours, background systems (texture,
// picture), comfort filters (warmth, dimming), type and layout.
import { h, clear, icon, toast } from './dom';
import { t } from '../i18n';
import { getSettings, updateSettings, resetSettings, setBgImage, loadBgImage, type VisualSettings, type Theme, type Texture, type LatinFont, type ArabicFont } from '../settings';

type Section = 'theme' | 'background' | 'comfort' | 'type' | 'layout' | 'behaviour';

export function renderOptions(container: HTMLElement, opts: { pdf?: boolean } = {}): void {
  clear(container);
  const s = getSettings();
  const grid = h('div', { class: 'options-grid' });
  const rerender = () => renderOptions(container, opts);
  const bump = () => container.dispatchEvent(new CustomEvent('kr-rerender', { bubbles: true }));

  /* ----- Theme ----- */
  const themes: [Theme, string, string, string][] = [
    ['dark', t('themeDark'), '#14110f', '#e6dcc8'], ['black', t('themeBlack'), '#000', '#d9d2c4'], ['sepia', t('themeSepia'), '#f3e8d2', '#3b2f21'],
    ['paper', t('themePaper'), '#ebe5da', '#27221d'], ['light', t('themeLight'), '#fbfaf7', '#1d1a16'], ['custom', t('themeCustom'), s.customBg, s.customFg],
  ];
  grid.append(head('theme', t('theme')), h('div', { class: 'theme-swatches' }, ...themes.map(([id, label, bg, fg]) =>
    h('button', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(s.theme === id), style: { background: bg, color: fg }, onclick: () => { updateSettings({ theme: id }); rerender(); } }, id === 'custom' ? icon('type') : 'Aa'))));
  if (s.theme === 'custom') {
    grid.append(h('div', { class: 'row' }, h('span', { class: 'label' }, t('backgroundColor')), colorInput(s.customBg, (v) => updateSettings({ customBg: v }))),
      h('div', { class: 'row' }, h('span', { class: 'label' }, t('textColor')), colorInput(s.customFg, (v) => updateSettings({ customFg: v }))));
  }

  // Presets: one-tap comfortable combinations.
  const presets: [string, Partial<VisualSettings>][] = [
    [t('presetNight'), { theme: 'black', texture: 'none', warmth: 0.18, dimOverlay: 0.1, bgImage: false }],
    [t('presetCandle'), { theme: 'custom', customBg: '#2a1d12', customFg: '#f1dcb8', texture: 'paper', textureOpacity: 0.45, warmth: 0.25, dimOverlay: 0, bgImage: false }],
    [t('presetManuscript'), { theme: 'custom', customBg: '#e9d9b6', customFg: '#3a2a16', texture: 'parchment', textureOpacity: 0.6, warmth: 0.05, dimOverlay: 0, bgImage: false }],
    [t('presetDaylight'), { theme: 'light', texture: 'none', warmth: 0, dimOverlay: 0, bgImage: false }],
    [t('presetEink'), { theme: 'custom', customBg: '#dcdcd8', customFg: '#1a1a1a', texture: 'dots', textureOpacity: 0.25, warmth: 0, dimOverlay: 0, bgImage: false }],
  ];
  grid.append(section(t('presets'), h('div', { class: 'segmented' }, ...presets.map(([label, patch]) => h('button', { type: 'button', onclick: () => { updateSettings(patch); rerender(); } }, label)))));

  if (opts.pdf) {
    grid.append(toggle(t('invertColors'), s.pdfInvert, (v) => updateSettings({ pdfInvert: v })));
    grid.append(head('comfort', t('comfort')));
    grid.append(stepper(t('warmth'), s.warmth, 0, 0.6, 0.05, (v) => updateSettings({ warmth: round2(v) }), pct));
    grid.append(stepper(t('dimScreen'), s.dimOverlay, 0, 0.7, 0.05, (v) => updateSettings({ dimOverlay: round2(v) }), pct));
    container.append(grid, footer());
    return;
  }

  /* ----- Background ----- */
  grid.append(head('background', t('background')));
  const textures: [Texture, string][] = [['none', t('textureNone')], ['paper', t('texturePaper')], ['linen', t('textureLinen')], ['parchment', t('textureParchment')], ['dots', t('textureDots')]];
  grid.append(section(t('texture'), segmented(textures, s.texture, (v) => { updateSettings({ texture: v }); rerender(); })));
  if (s.texture !== 'none') grid.append(stepper(t('textureStrength'), s.textureOpacity, 0.1, 1, 0.05, (v) => updateSettings({ textureOpacity: round2(v) }), pct));

  const preview = h('div', { class: 'bg-preview' }, s.bgImage ? '' : t('backgroundImage'));
  if (s.bgImage) void loadBgImage().then((u) => { if (u) preview.style.backgroundImage = `url("${u}")`; });
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
    const f = file.files?.[0];
    if (!f) return;
    await setBgImage(await downscale(f));
    rerender();
  } }) as HTMLInputElement;
  grid.append(h('div', { class: 'field' }, h('span', { class: 'label' }, t('backgroundImage')), preview,
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
      h('button', { class: 'btn small', type: 'button', onclick: () => file.click() }, icon('images'), t('chooseImage')),
      s.bgImage ? h('button', { class: 'btn small danger', type: 'button', onclick: async () => { await setBgImage(null); rerender(); } }, icon('trash'), t('removeImage')) : null), file));
  if (s.bgImage) {
    grid.append(stepper(t('imageOpacity'), s.bgImageOpacity, 0.05, 1, 0.05, (v) => updateSettings({ bgImageOpacity: round2(v) }), pct));
    grid.append(stepper(t('imageBlur'), s.bgBlur, 0, 30, 1, (v) => updateSettings({ bgBlur: v }), (v) => `${v}`));
  }

  /* ----- Comfort ----- */
  grid.append(head('comfort', t('comfort')));
  grid.append(stepper(t('warmth'), s.warmth, 0, 0.6, 0.05, (v) => updateSettings({ warmth: round2(v) }), pct));
  grid.append(stepper(t('dimScreen'), s.dimOverlay, 0, 0.7, 0.05, (v) => updateSettings({ dimOverlay: round2(v) }), pct));
  grid.append(toggle(t('dimImages'), s.dimImages, (v) => updateSettings({ dimImages: v })));

  /* ----- Type ----- */
  grid.append(head('type', t('typeSection')));
  const latin: [LatinFont, string][] = [['lora', 'Lora'], ['inter', 'Inter'], ['serif', t('fontSystemSerif')], ['sans', t('fontSystemSans')], ['publisher', t('fontPublisher')]];
  const arabic: [ArabicFont, string][] = [['uthman', 'عثمان طه'], ['sultan', 'سلطان'], ['naskh', 'نسخ'], ['publisher', t('fontPublisher')]];
  grid.append(section(t('latinFont'), segmented(latin, s.latinFont, (v) => { updateSettings({ latinFont: v }); rerender(); })));
  grid.append(section(t('arabicFont'), segmented(arabic, s.arabicFont, (v) => { updateSettings({ arabicFont: v }); rerender(); }, true)));
  grid.append(stepper(t('fontSize'), s.fontSize, 12, 40, 1, (v) => updateSettings({ fontSize: v }), (v) => `${v}`));
  grid.append(stepper(t('lineHeight'), s.lineHeight, 1.2, 2.6, 0.1, (v) => updateSettings({ lineHeight: Math.round(v * 10) / 10 }), (v) => v.toFixed(1)));
  grid.append(stepper(t('wordSpacing'), s.wordSpacing, -0.05, 0.5, 0.01, (v) => updateSettings({ wordSpacing: round2(v) }), (v) => v.toFixed(2)));
  grid.append(stepper(t('letterSpacing'), s.letterSpacing, -0.05, 0.2, 0.005, (v) => updateSettings({ letterSpacing: Math.round(v * 1000) / 1000 }), (v) => v.toFixed(3)));

  /* ----- Layout ----- */
  grid.append(head('layout', t('layoutSection')));
  grid.append(stepper(t('paragraphSpacing'), s.paragraphSpacing, 0, 2.5, 0.1, (v) => updateSettings({ paragraphSpacing: Math.round(v * 10) / 10 }), (v) => v.toFixed(1)));
  grid.append(stepper(t('pageWidth'), s.textWidth, 420, 1400, 40, (v) => updateSettings({ textWidth: v }), (v) => `${v}`));
  grid.append(stepper(t('margins'), s.margin, 0, 80, 4, (v) => updateSettings({ margin: v }), (v) => `${v}`));
  const aligns: [VisualSettings['align'], string][] = [['start', t('alignStart')], ['justify', t('alignJustify')], ['center', t('alignCenter')]];
  grid.append(section(t('textAlign'), segmented(aligns, s.align, (v) => { updateSettings({ align: v }); rerender(); })));
  grid.append(toggle(t('hyphenate'), s.hyphenate, (v) => updateSettings({ hyphenate: v })));

  /* ----- Behaviour ----- */
  grid.append(head('behaviour', t('behaviourSection')));
  grid.append(toggle(t('publisherStyles'), s.publisherStyles, (v) => { updateSettings({ publisherStyles: v }); bump(); }));

  container.append(grid, footer());

  function footer() {
    return h('div', { style: { marginTop: '24px' } }, h('button', { class: 'btn small outlined', onclick: async () => { resetSettings(); await setBgImage(null); rerender(); bump(); toast(t('done')); } }, t('resetDefaults')));
  }
}

function head(_id: Section, label: string): HTMLElement { return h('h4', null, label); }
function section(label: string, control: HTMLElement): HTMLElement { return h('div', { class: 'field' }, h('span', { class: 'label' }, label), control); }
function pct(v: number): string { return `${Math.round(v * 100)}%`; }
function round2(v: number): number { return Math.round(v * 100) / 100; }

function colorInput(value: string, onChange: (v: string) => void): HTMLElement {
  const inp = h('input', { type: 'color', value, oninput: () => onChange(inp.value) }) as HTMLInputElement;
  return inp;
}

function segmented<T extends string>(items: [T, string][], value: T, onPick: (v: T) => void, arabicFont = false): HTMLElement {
  return h('div', { class: 'segmented' }, ...items.map(([id, label]) => h('button', { type: 'button', 'aria-pressed': String(value === id), onclick: () => onPick(id), style: arabicFont && id !== 'publisher' ? { fontFamily: id === 'uthman' ? "'Uthman TN1'" : id === 'sultan' ? "'Sultan'" : "'Noto Naskh Arabic'", fontSize: '16px' } : id === 'lora' ? { fontFamily: "'Lora'" } : undefined }, label)));
}

function stepper(label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void, fmt: (v: number) => string): HTMLElement {
  const out = h('output', null, fmt(value));
  let v = value;
  const paint = () => range.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
  const set = (nv: number) => { v = Math.min(max, Math.max(min, nv)); out.textContent = fmt(v); range.value = String(v); paint(); onChange(v); };
  const range = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': label, oninput: () => set(Number(range.value)) }) as HTMLInputElement;
  paint();
  return h('div', { class: 'field' },
    h('div', { class: 'row' }, h('span', { class: 'label' }, label), h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': '−', onclick: () => set(v - step) }, '−'), out, h('button', { type: 'button', 'aria-label': '+', onclick: () => set(v + step) }, '+'))),
    range);
}

function toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const cb = h('input', { type: 'checkbox', onchange: () => onChange(cb.checked) }) as HTMLInputElement;
  cb.checked = value;
  return h('label', { class: 'row' }, h('span', { class: 'label' }, label), h('span', { class: 'switch' }, cb, h('i')));
}

/** Keep background pictures reasonable (≤ 1600px, JPEG) before storing them. */
async function downscale(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((res) => c.toBlob((b) => res(b ?? file), 'image/jpeg', 0.86));
  } catch { return file; }
}
