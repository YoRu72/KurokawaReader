// Visual Options panel: theme & custom colours, background systems (texture,
// picture), comfort filters (warmth, dimming), type and layout.
import { h, clear, icon, toast, pickButton } from './dom';
import { colorField } from './colorpicker';
import { isTouchDevice, t } from '../i18n';
import { keepAwake, setVolumeKeys, nativePlatform } from '../native';
import { AI_VOICES, aiReady } from '../ai';
import { getSettings, updateSettings, resetSettings, isDefault, resetSetting, setBgImage, loadBgImage, type VisualSettings, type Theme, type Texture, type LatinFont, type ArabicFont } from '../settings';
import { fontsSync } from '../fonts';

type Section = 'theme' | 'background' | 'comfort' | 'type' | 'layout' | 'behaviour';

export function renderOptions(container: HTMLElement, opts: { pdf?: boolean } = {}): void {
  clear(container);
  const s = getSettings();
  const grid = h('div', { class: 'options-grid' });
  const rerender = () => renderOptions(container, opts);
  grid.addEventListener('kr-options-rerender', (e) => { e.stopPropagation(); rerender(); bump(); });
  const bump = () => container.dispatchEvent(new CustomEvent('kr-rerender', { bubbles: true }));

  /* ----- Theme ----- */
  const themes: [Theme, string, string, string][] = [
    ['grey', t('themeGrey'), '#1b1b1b', '#d2d2d2'], ['dark', t('themeDark'), '#141414', '#cfcbc4'], ['black', t('themeBlack'), '#000', '#c9c9c9'], ['slate', t('themeSlate'), '#1e2228', '#d3d8de'], ['night', t('themeNight'), '#0f1626', '#cfd8e8'],
    ['sepia', t('themeSepia'), '#f3e8d2', '#3b2f21'], ['paper', t('themePaper'), '#ebe5da', '#27221d'], ['mintpaper', t('themeMintPaper'), '#e6efe6', '#1f2a22'], ['rosepaper', t('themeRosePaper'), '#f3e6e6', '#2c1e20'], ['light', t('themeLight'), '#fbfaf7', '#1d1a16'], ['sand', t('themeSand'), '#efe4cf', '#3a3024'],
    ['olive', t('themeOlive'), '#1d2017', '#d6d8c6'], ['amber', t('themeAmber'), '#1f1a12', '#e3cfa8'], ['forest', t('themeForest'), '#10201a', '#cbd9cf'], ['plum', t('themePlum'), '#1e1520', '#ddd0dc'], ['ink', t('themeInk'), '#0b1120', '#dfe6f3'], ['coffee', t('themeCoffee'), '#1c1512', '#d9c9b8'], ['lavender', t('themeLavender'), '#efeaf6', '#2b2436'], ['sky', t('themeSky'), '#e9f1f7', '#1f2a33'],
    ['charcoal', t('themeCharcoal'), '#232323', '#dcdcdc'], ['nord', t('themeNord'), '#2e3440', '#d8dee9'], ['dracula', t('themeDracula'), '#282a36', '#f8f8f2'], ['solardark', t('themeSolarizeddark'), '#002b36', '#a9b7b8'], ['gruvbox', t('themeGruvbox'), '#282828', '#ebdbb2'], ['solarlight', t('themeSolarizedlight'), '#fdf6e3', '#586e75'], ['cream', t('themeCream'), '#fff8e7', '#2d2a26'], ['peach', t('themePeach'), '#fbeee4', '#3a2a22'], ['custom', t('themeCustom'), s.customBg, s.customFg],
  ];
  grid.append(head('theme', t('theme')), h('div', { class: 'theme-swatches' }, ...themes.map(([id, label, bg, fg]) =>
    h('button', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(s.theme === id), style: { background: bg, color: fg }, onclick: () => { updateSettings({ theme: id, fgOverride: '', bgOverride: '' }); rerender(); } }, id === 'custom' ? icon('type') : 'Aa'))));
  if (s.theme === 'custom') {
    grid.append(h('div', { class: 'row' }, h('span', { class: 'label' }, t('textColor')), colorInput(s.customFg, (v) => updateSettings({ customFg: v }))),
      h('div', { class: 'row' }, h('span', { class: 'label' }, t('backgroundColor')), colorInput(s.customBg, (v) => updateSettings({ customBg: v }))));
  } else {
    // Colour overrides on top of the chosen theme
    const cur = getComputedStyle(document.querySelector('.reader') ?? document.body);
    const fgNow = s.fgOverride || cur.getPropertyValue('--r-fg').trim() || '#d2d2d2';
    const bgNow = s.bgOverride || cur.getPropertyValue('--r-bg').trim() || '#1b1b1b';
    grid.append(
      h('div', { class: 'row' }, h('span', { class: 'label' }, t('textColorOverride')), h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, s.fgOverride ? h('button', { class: 'btn small outlined', type: 'button', onclick: () => { updateSettings({ fgOverride: '' }); rerender(); } }, t('useThemeColor')) : null, colorInput(toHex(fgNow), (v) => updateSettings({ fgOverride: v })))),
      h('div', { class: 'row' }, h('span', { class: 'label' }, t('pageColorOverride')), h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, s.bgOverride ? h('button', { class: 'btn small outlined', type: 'button', onclick: () => { updateSettings({ bgOverride: '' }); rerender(); } }, t('useThemeColor')) : null, colorInput(toHex(bgNow), (v) => updateSettings({ bgOverride: v })))),
    );
  }

  // Highlight colours (also used by notes and PDF pins)
  grid.append(section([t('highlightColors'), 'highlightPalette'], h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, ...(Object.keys(s.highlightPalette) as (keyof typeof s.highlightPalette)[]).map((k) => colorField(s.highlightPalette[k], (v) => updateSettings({ highlightPalette: { ...getSettings().highlightPalette, [k]: v } }), k)))));

  // Presets: one-tap comfortable combinations.
  const presets: [string, Partial<VisualSettings>][] = [
    [t('presetNight'), { theme: 'night', texture: 'none', warmth: 0.12, dimOverlay: 0.08, bgImage: false, fgOverride: '', bgOverride: '' }],
    [t('presetCandle'), { theme: 'custom', customBg: '#2a1d12', customFg: '#f1dcb8', texture: 'paper', textureOpacity: 0.45, warmth: 0.25, dimOverlay: 0, bgImage: false }],
    [t('presetManuscript'), { theme: 'custom', customBg: '#e9d9b6', customFg: '#3a2a16', texture: 'parchment', textureOpacity: 0.6, warmth: 0.05, dimOverlay: 0, bgImage: false }],
    [t('presetDaylight'), { theme: 'light', texture: 'none', warmth: 0, dimOverlay: 0, bgImage: false }],
    [t('presetEink'), { theme: 'custom', customBg: '#dcdcd8', customFg: '#1a1a1a', texture: 'dots', textureOpacity: 0.25, warmth: 0, dimOverlay: 0, bgImage: false }],
    [t('presetClassic'), { theme: 'sepia', texture: 'paper', textureOpacity: 0.35, warmth: 0.08, dimOverlay: 0, bgImage: false, align: 'justify', hyphenate: true, fontSize: 19, lineHeight: 1.65, textWidth: 640 }],
    [t('presetLargePrint'), { fontSize: 26, lineHeight: 1.8, paragraphSpacing: 1.1, textWidth: 820, align: 'start', hyphenate: false }],
    [t('presetCompact'), { fontSize: 16, lineHeight: 1.45, paragraphSpacing: 0.5, textWidth: 900, margin: 14, align: 'start' }],
    [t('presetFocus'), { theme: 'black', texture: 'none', warmth: 0, dimOverlay: 0.12, bgImage: false, textWidth: 560, margin: 32, lineHeight: 1.9, readingMode: 'chapters', showStatusLine: false }],
    [t('presetMushaf'), { theme: 'custom', customBg: '#f6efd9', customFg: '#2b2416', texture: 'parchment', textureOpacity: 0.3, warmth: 0.04, dimOverlay: 0, bgImage: false, arabicFont: 'uthman', align: 'justify', lineHeight: 2.1, fontSize: 22 }],
  ];
  grid.append(section(t('presets'), h('div', { class: 'segmented' }, ...presets.map(([label, patch]) => h('button', { type: 'button', onclick: () => { updateSettings(patch); rerender(); } }, label)))));

  if (opts.pdf) {
    grid.append(toggle([t('invertColors'), 'pdfInvert'], s.pdfInvert, (v) => updateSettings({ pdfInvert: v })));
    grid.append(head('comfort', t('comfort')));
    grid.append(stepper([t('warmth'), 'warmth'], s.warmth, 0, 0.6, 0.05, (v) => updateSettings({ warmth: round2(v) }), pct));
    grid.append(section([t('brightnessMode'), 'brightnessMode'], segmented([['device', t('brightnessDevice')], ['app', t('brightnessApp')]], s.brightnessMode, (v) => { updateSettings({ brightnessMode: v, ...(v === 'device' ? { dimOverlay: 0 } : {}) }); rerender(); })));
    if (s.brightnessMode === 'app') grid.append(stepper([t('dimScreen'), 'dimOverlay'], s.dimOverlay, 0, 0.7, 0.05, (v) => updateSettings({ dimOverlay: round2(v) }), pct));
    container.append(grid, footer());
    return;
  }

  /* ----- Background ----- */
  grid.append(head('background', t('background')));
  const textures: [Texture, string][] = [['none', t('textureNone')], ['paper', t('texturePaper')], ['linen', t('textureLinen')], ['parchment', t('textureParchment')], ['dots', t('textureDots')]];
  grid.append(section([t('texture'), 'texture'], segmented(textures, s.texture, (v) => { updateSettings({ texture: v }); rerender(); })));
  if (s.texture !== 'none') grid.append(stepper([t('textureStrength'), 'textureOpacity'], s.textureOpacity, 0.1, 1, 0.05, (v) => updateSettings({ textureOpacity: round2(v) }), pct));

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
    grid.append(stepper([t('imageOpacity'), 'bgImageOpacity'], s.bgImageOpacity, 0.05, 1, 0.05, (v) => updateSettings({ bgImageOpacity: round2(v) }), pct));
    grid.append(stepper([t('imageBlur'), 'bgBlur'], s.bgBlur, 0, 30, 1, (v) => updateSettings({ bgBlur: v }), (v) => `${v}`));
    grid.append(stepper([t('imageShade'), 'bgShade'], s.bgShade, 0, 0.8, 0.05, (v) => updateSettings({ bgShade: round2(v) }), pct));
    grid.append(stepper([t('imageSaturation'), 'bgSaturate'], s.bgSaturate, 0, 2, 0.1, (v) => updateSettings({ bgSaturate: round2(v) }), pct));
    const fits: [VisualSettings['bgFit'], string][] = [['cover', t('fitCover')], ['contain', t('fitContain')], ['tile', t('fitTile')]];
    grid.append(section([t('imageFit'), 'bgFit'], segmented(fits, s.bgFit, (v) => { updateSettings({ bgFit: v }); rerender(); })));
    const poss: [VisualSettings['bgPosition'], string][] = [['top', t('posTop')], ['center', t('posCenter')], ['bottom', t('posBottom')]];
    grid.append(section([t('imagePosition'), 'bgPosition'], segmented(poss, s.bgPosition, (v) => { updateSettings({ bgPosition: v }); rerender(); })));
  }

  /* ----- Comfort ----- */
  grid.append(head('comfort', t('comfort')));
  grid.append(stepper([t('warmth'), 'warmth'], s.warmth, 0, 0.6, 0.05, (v) => updateSettings({ warmth: round2(v) }), pct));
  grid.append(section([t('brightnessMode'), 'brightnessMode'], segmented([['device', t('brightnessDevice')], ['app', t('brightnessApp')]], s.brightnessMode, (v) => { updateSettings({ brightnessMode: v, ...(v === 'device' ? { dimOverlay: 0 } : {}) }); rerender(); })));
  if (s.brightnessMode === 'app') {
    grid.append(stepper([t('dimScreen'), 'dimOverlay'], s.dimOverlay, 0, 0.7, 0.05, (v) => updateSettings({ dimOverlay: round2(v) }), pct));
  if (isTouchDevice()) grid.append(toggle([t('edgeBrightness'), 'edgeBrightness'], s.edgeBrightness, (v) => updateSettings({ edgeBrightness: v })));
  }
  grid.append(toggle([t('dimImages'), 'dimImages'], s.dimImages, (v) => updateSettings({ dimImages: v })));
  grid.append(toggle([t('invertLineArt'), 'invertLineArt'], s.invertLineArt, (v) => updateSettings({ invertLineArt: v })));

  /* ----- Type ----- */
  grid.append(head('type', t('typeSection')));
  const customLatin = fontsSync().filter((f) => f.script === 'latin').map((f): [LatinFont, string] => [`custom:${f.id}`, f.name]);
  const customArabic = fontsSync().filter((f) => f.script === 'arabic').map((f): [ArabicFont, string] => [`custom:${f.id}`, f.name]);
  const sys = s.systemFonts.map((f): [string, string] => [`system:${f}`, f]);
  const latin: [LatinFont, string][] = [['lora', 'Lora'], ['inter', 'Inter'], ['serif', t('fontSystemSerif')], ['sans', t('fontSystemSans')], ...customLatin, ...sys, ['publisher', t('fontPublisher')]];
  const arabic: [ArabicFont, string][] = [['uthman', 'عثمان طه'], ['sultan', 'سلطان'], ['naskh', 'نسخ'], ...customArabic, ...sys, ['publisher', t('fontPublisher')]];
  grid.append(section([t('latinFont'), 'latinFont'], segmented(latin, s.latinFont, (v) => { updateSettings({ latinFont: v }); rerender(); })));
  grid.append(section([t('arabicFont'), 'arabicFont'], segmented(arabic, s.arabicFont, (v) => { updateSettings({ arabicFont: v }); rerender(); }, true)));
  grid.append(stepper([t('fontSize'), 'fontSize'], s.fontSize, 12, 40, 1, (v) => updateSettings({ fontSize: v }), (v) => `${v}`));
  grid.append(stepper([t('lineHeight'), 'lineHeight'], s.lineHeight, 1.2, 2.6, 0.1, (v) => updateSettings({ lineHeight: Math.round(v * 10) / 10 }), (v) => v.toFixed(1)));
  grid.append(stepper([t('wordSpacing'), 'wordSpacing'], s.wordSpacing, -0.05, 0.5, 0.01, (v) => updateSettings({ wordSpacing: round2(v) }), (v) => v.toFixed(2)));
  grid.append(stepper([t('letterSpacing'), 'letterSpacing'], s.letterSpacing, -0.05, 0.2, 0.005, (v) => updateSettings({ letterSpacing: Math.round(v * 1000) / 1000 }), (v) => v.toFixed(3)));

  /* ----- Layout ----- */
  grid.append(head('layout', t('layoutSection')));
  grid.append(stepper([t('paragraphSpacing'), 'paragraphSpacing'], s.paragraphSpacing, 0, 2.5, 0.1, (v) => updateSettings({ paragraphSpacing: Math.round(v * 10) / 10 }), (v) => v.toFixed(1)));
  grid.append(stepper([t('pageWidth'), 'textWidth'], s.textWidth, 420, 1400, 40, (v) => updateSettings({ textWidth: v }), (v) => `${v}`));
  grid.append(stepper([t('margins'), 'margin'], s.margin, 0, 80, 4, (v) => updateSettings({ margin: v }), (v) => `${v}`));
  const aligns: [VisualSettings['align'], string][] = [['start', t('alignStart')], ['justify', t('alignJustify')], ['center', t('alignCenter')]];
  grid.append(section([t('textAlign'), 'align'], segmented(aligns, s.align, (v) => { updateSettings({ align: v }); rerender(); })));
  grid.append(toggle([t('hyphenate'), 'hyphenate'], s.hyphenate, (v) => updateSettings({ hyphenate: v })));

  /* ----- Behaviour ----- */
  grid.append(head('behaviour', t('behaviourSection')));
  const modes: [VisualSettings['readingMode'], string][] = [['chapters', t('modeChapters')], ['flow', t('modeFlow')], ['continuous', t('modeContinuous')]];
  grid.append(section([t('readingMode'), 'readingMode'], segmented(modes, s.readingMode, (v) => { updateSettings({ readingMode: v }); rerender(); bump(); })));
  grid.append(toggle([t('hideSystemBars'), 'hideSystemBars'], s.hideSystemBars, (v) => updateSettings({ hideSystemBars: v })));
  grid.append(toggle([t('tapToTurn'), 'tapToTurn'], s.tapToTurn, (v) => updateSettings({ tapToTurn: v })));
  grid.append(toggle([t('showStatusLine'), 'showStatusLine'], s.showStatusLine, (v) => updateSettings({ showStatusLine: v })));
  if (isTouchDevice()) grid.append(toggle([t('pinchText'), 'pinchText'], s.pinchText, (v) => updateSettings({ pinchText: v })));
  grid.append(toggle([t('keepAwake'), 'keepAwake'], s.keepAwake, (v) => { updateSettings({ keepAwake: v }); keepAwake(v); }));
  if (nativePlatform() === 'android') grid.append(toggle([t('volumeKeys'), 'volumeKeys'], s.volumeKeys, (v) => { updateSettings({ volumeKeys: v }); void setVolumeKeys(v); }));
  grid.append(toggle([t('pdfPinchZoom'), 'pdfPinchZoom'], s.pdfPinchZoom, (v) => updateSettings({ pdfPinchZoom: v })));
  grid.append(toggle([t('pdfPageNumbers'), 'pdfPageNumbers'], s.pdfPageNumbers, (v) => updateSettings({ pdfPageNumbers: v })));
  const pinStyles: [VisualSettings['pdfNoteStyle'], string][] = [['badge', t('pinBadge')], ['pin', t('pinIcon')], ['dot', t('pinDot')]];
  grid.append(section([t('pdfNoteStyle'), 'pdfNoteStyle'], segmented(pinStyles, s.pdfNoteStyle, (v) => { updateSettings({ pdfNoteStyle: v }); rerender(); })));
  grid.append(toggle([t('furigana'), 'furigana'], s.furigana, (v) => { updateSettings({ furigana: v }); bump(); }));
  grid.append(toggle([t('publisherStyles'), 'publisherStyles'], s.publisherStyles, (v) => { updateSettings({ publisherStyles: v }); bump(); }));
  const translators: [VisualSettings['translator'], string][] = [['builtin', t('translatorBuiltin')], ['system', t('translatorSystem')]];
  grid.append(section([t('translatorChoice'), 'translator'], segmented(translators, s.translator, (v) => { updateSettings({ translator: v }); rerender(); })));

  /* ----- Read aloud ----- */
  if ('speechSynthesis' in window) {
    grid.append(head('behaviour', t('readAloud')));
    grid.append(stepper([t('speechRate'), 'speechRate'], s.speechRate, 0.5, 2, 0.1, (v) => updateSettings({ speechRate: round2(v) }), (v) => `${v.toFixed(1)}×`));
    const engines: [VisualSettings['speechEngine'], string][] = [['system', t('speechSystem')], ['ai', t('speechAi')]];
    grid.append(section([t('speechEngine'), 'speechEngine'], segmented(engines, s.speechEngine, (v) => { updateSettings({ speechEngine: v }); rerender(); })));
    if (s.speechEngine === 'ai') {
      const list = AI_VOICES[s.aiProvider === 'openrouter' || s.aiProvider === 'custom' ? 'openai' : s.aiProvider] ?? [];
      if (list.length) {
        grid.append(section([t('aiVoice'), 'aiVoice'], pickButton(t('aiVoice'), list.map((v): [string, string] => [v, v]), s.aiVoice || list[0], (v) => updateSettings({ aiVoice: v }), t('close'))));
      } else {
        const vin = h('input', { type: 'text', value: s.aiVoice, dir: 'ltr', placeholder: 'alloy', onchange: () => updateSettings({ aiVoice: vin.value.trim() }) }) as HTMLInputElement;
        grid.append(section([t('aiVoice'), 'aiVoice'], vin));
      }
      const tm = h('input', { type: 'text', value: s.aiTtsModel, dir: 'ltr', placeholder: s.aiProvider === 'gemini' ? 'gemini-2.5-flash-preview-tts' : 'gpt-4o-mini-tts', onchange: () => updateSettings({ aiTtsModel: tm.value.trim() }) }) as HTMLInputElement;
      grid.append(section([t('aiTtsModel'), 'aiTtsModel'], tm));
      if (!aiReady()) grid.append(h('p', { class: 'src' }, t('aiNeedsKey')));
    }
    const voices = speechSynthesis.getVoices();
    if (voices.length && s.speechEngine === 'system') {
      grid.append(section([t('speechVoice'), 'speechVoice'], pickButton(t('speechVoice'), [['', t('voiceDefault')] as [string, string], ...voices.map((v): [string, string] => [v.name, `${v.name} (${v.lang})`])], s.speechVoice, (v) => updateSettings({ speechVoice: v }), t('close'))));
    }
  }

  /* ----- Snapshots ----- */
  grid.append(head('behaviour', t('snapshot')));
  const snaps: [VisualSettings['snapStyle'], string][] = [['plain', t('snapPlain')], ['card', t('snapCard')]];
  grid.append(section([t('snapStyle'), 'snapStyle'], segmented(snaps, s.snapStyle, (v) => { updateSettings({ snapStyle: v }); rerender(); })));
  grid.append(toggle([t('snapWatermark'), 'snapWatermark'], s.snapWatermark, (v) => updateSettings({ snapWatermark: v })));
  const folderInput = h('input', { type: 'text', value: s.snapFolder, spellcheck: 'false', dir: 'ltr', placeholder: 'Screenshots', onchange: () => updateSettings({ snapFolder: folderInput.value.trim() || 'Screenshots' }) }) as HTMLInputElement;
  grid.append(section(t('snapFolder'), folderInput));

  container.append(grid, footer());

  function footer() {
    return h('div', { style: { marginTop: '24px' } }, h('button', { class: 'btn small outlined', onclick: async () => { resetSettings(); await setBgImage(null); rerender(); bump(); toast(t('done')); } }, t('resetDefaults')));
  }
}

function head(_id: Section, label: string): HTMLElement { return h('h4', null, label); }
type Label = string | [string, keyof VisualSettings];
/** A field label, with a small "back to default" button once the setting differs from the factory value. */
function labelEl(label: Label, cls = 'label'): HTMLElement {
  if (typeof label === 'string') return h('span', { class: cls }, label);
  const [text, key] = label;
  const span = h('span', { class: cls }, text);
  if (!isDefault(key)) span.append(h('button', { type: 'button', class: 'reset-one', title: t('resetThis'), 'aria-label': t('resetThis'), onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); resetSetting(key); span.closest('.options-grid')?.dispatchEvent(new CustomEvent('kr-options-rerender', { bubbles: true })); } }, icon('undo')));
  return span;
}
function section(label: Label, control: HTMLElement): HTMLElement { return h('div', { class: 'field' }, labelEl(label), control); }
function pct(v: number): string { return `${Math.round(v * 100)}%`; }
function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (!m) return '#888888';
  return '#' + [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('');
}
function round2(v: number): number { return Math.round(v * 100) / 100; }

function colorInput(value: string, onChange: (v: string) => void): HTMLElement { return colorField(value, onChange); }

function segmented<T extends string>(items: [T, string][], value: T, onPick: (v: T) => void, arabicFont = false): HTMLElement {
  const fam = (id: string): string | undefined => {
    if (id.startsWith('custom:')) { const f = fontsSync().find((x) => x.id === id.slice(7)); return f ? `'${f.family}'` : undefined; }
    if (arabicFont) return id === 'uthman' ? "'Uthman TN1'" : id === 'sultan' ? "'Sultan'" : id === 'naskh' ? "'Noto Naskh Arabic'" : undefined;
    return id === 'lora' ? "'Lora'" : undefined;
  };
  return h('div', { class: 'segmented' }, ...items.map(([id, label]) => { const f = fam(id); return h('button', { type: 'button', 'aria-pressed': String(value === id), onclick: () => onPick(id), style: f ? { fontFamily: f, fontSize: arabicFont ? '16px' : undefined } : undefined }, label); }));
}

function stepper(label: Label, value: number, min: number, max: number, step: number, onChange: (v: number) => void, fmt: (v: number) => string): HTMLElement {
  const out = h('output', null, fmt(value));
  let v = value;
  const paint = () => range.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
  const set = (nv: number) => { v = Math.min(max, Math.max(min, nv)); out.textContent = fmt(v); range.value = String(v); paint(); onChange(v); };
  const range = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value), 'aria-label': typeof label === 'string' ? label : label[0], oninput: () => set(Number(range.value)) }) as HTMLInputElement;
  paint();
  return h('div', { class: 'field' },
    h('div', { class: 'row' }, labelEl(label), h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': '−', onclick: () => set(v - step) }, '−'), out, h('button', { type: 'button', 'aria-label': '+', onclick: () => set(v + step) }, '+'))),
    range);
}

function toggle(label: Label, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const cb = h('input', { type: 'checkbox', onchange: () => onChange(cb.checked) }) as HTMLInputElement;
  cb.checked = value;
  return h('label', { class: 'row' }, labelEl(label), h('span', { class: 'switch' }, cb, h('i')));
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
