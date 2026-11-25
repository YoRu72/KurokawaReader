// The comic reader's settings (src/views/comic.ts): the panel from the reader's bar — «Reading mode» (this book's
// mode, the default mode, the tap zones, the turns, the zoom) and «General» (fit, where a page starts, the page
// number, the screen kept on, the volume keys, the page between volumes) — and the same defaults under Settings →
// Reader («Comics»). Tap zones and the volume keys are a phone's (not offered on a computer); the keys' list is a
// computer's (not shown on a phone).
import { h, icon, pickButton } from '../ui/dom';
import { t } from '../i18n';
import type { Strings } from '../i18n/en';
import { fits } from '../platform';
import { keepAwake } from '../native';
import { getSettings, updateSettings, type VisualSettings } from '../settings';
import type { Mode } from './viewer';

export const MODE_LABEL: Record<Mode, keyof Strings> = { 1: 'comicModeLtr', 2: 'comicModeRtl', 3: 'comicModeVertical', 4: 'comicModeStrip', 5: 'comicModeContinuous' };
const MODES: Mode[] = [1, 2, 3, 4, 5];
export const modeName = (m: Mode): string => t(MODE_LABEL[m]);

function toggle(label: string, key: keyof VisualSettings, value: boolean, onChange: (v: boolean) => void, hint?: string): HTMLElement[] {
  const cb = h('input', { type: 'checkbox', onchange: () => onChange(cb.checked) }) as HTMLInputElement;
  cb.checked = value;
  const row = h('label', { class: 'row', dataset: { key } }, h('span', { class: 'label' }, label), h('span', { class: 'switch' }, cb, h('i')));
  return hint ? [row, h('p', { class: 'hint' }, hint)] : [row];
}
function pick<T extends string>(label: string, key: string, items: [T, string][], value: T, onPick: (v: T) => void): HTMLElement {
  const b = pickButton(label, items, value, onPick, t('close'));
  b.dataset.key = key;
  return h('div', { class: 'field' }, h('span', { class: 'label' }, label), b);
}

/** A slider with its value shown: the setting `key` set as it is dragged (the fill painted by `--p`). */
function slide(label: string, key: keyof VisualSettings, min: number, max: number, step: number, fmt: (v: number) => string = String): HTMLElement {
  const v = Number(getSettings()[key]); const out = h('output', null, fmt(v));
  const range = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(v), 'aria-label': label, dataset: { key } }) as HTMLInputElement;
  range.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
  range.addEventListener('input', () => { const n = Number(range.value); out.textContent = fmt(n); updateSettings({ [key]: n } as Partial<VisualSettings>); });
  return h('div', { class: 'cm-slider-row' }, h('div', { class: 'row' }, h('span', { class: 'label' }, label), out), range);
}
const sub = (text: string) => h('h5', { class: 'cm-group-sub' }, text);

const zoneItems = (): ['0' | '1' | '2' | '3' | '4' | '5', string][] => [['0', t('comicZoneDefault')], ['1', t('comicZoneL')], ['2', t('comicZoneKindle')], ['3', t('comicZoneEdge')], ['4', t('comicZoneRightLeft')], ['5', t('comicZoneOff')]];
const invertItems = (): [VisualSettings['comicInvertPaged'], string][] => [['none', t('comicInvertNone')], ['h', t('comicInvertH')], ['v', t('comicInvertV')], ['both', t('comicInvertBoth')]];

export interface ModeHost {
  /** This book's own mode (0: the default) and how to set it — in the reader only. */
  bookMode?: () => number;
  setBookMode?: (m: number) => void;
  /** «Show the zones» (in the reader, on a phone). */
  showZones?: () => void;
}

/** «Reading mode»: this book's mode (in the reader), the default mode, the tap zones, the turns, the zoom. */
export function comicModeFields(body: HTMLElement, o: ModeHost = {}): void {
  const s = getSettings(); const redraw = () => { body.replaceChildren(); comicModeFields(body, o); };
  if (o.bookMode && o.setBookMode) {
    const cur = String(o.bookMode() || 0) as '0' | '1' | '2' | '3' | '4' | '5';
    body.append(pick(t('comicModeBook'), 'comicBookMode', [['0', t('comicModeDefault', { mode: modeName(s.comicMode) })], ...MODES.map((m) => [String(m), modeName(m)] as ['1', string])], cur, (v) => { o.setBookMode!(Number(v)); redraw(); }));
  }
  body.append(pick(t('comicModeDefaultLabel'), 'comicMode', MODES.map((m) => [String(m), modeName(m)] as ['1', string]), String(s.comicMode) as '1', (v) => { updateSettings({ comicMode: Number(v) as Mode }); redraw(); }));
  // (The zones are a phone's: a computer's click goes to the default ones.)
  if (fits('phone')) {
    body.append(
      pick(t('comicTapZonesPaged'), 'comicZonesPaged', zoneItems(), String(s.comicZonesPaged) as '0', (v) => updateSettings({ comicZonesPaged: Number(v) as VisualSettings['comicZonesPaged'] })),
      pick(t('comicInvertPaged'), 'comicInvertPaged', invertItems(), s.comicInvertPaged, (v) => updateSettings({ comicInvertPaged: v })),
      pick(t('comicTapZonesStrip'), 'comicZonesStrip', zoneItems(), String(s.comicZonesStrip) as '0', (v) => updateSettings({ comicZonesStrip: Number(v) as VisualSettings['comicZonesStrip'] })),
      pick(t('comicInvertStrip'), 'comicInvertStrip', invertItems(), s.comicInvertStrip, (v) => updateSettings({ comicInvertStrip: v })));
    if (o.showZones) body.append(h('div', { class: 'actions-row' }, h('button', { type: 'button', class: 'btn tonal small cm-show-zones', onclick: () => o.showZones!() }, icon('grid'), t('comicShowZones'))));
  }
  body.append(
    ...toggle(t('comicTransitions'), 'comicTransitions', s.comicTransitions, (v) => updateSettings({ comicTransitions: v })),
    ...toggle(t('comicNavPan'), 'comicNavPan', s.comicNavPan, (v) => updateSettings({ comicNavPan: v }), t('comicNavPanHint')),
    ...toggle(t('comicLandscapeZoom'), 'comicLandscapeZoom', s.comicLandscapeZoom, (v) => updateSettings({ comicLandscapeZoom: v }), t('comicLandscapeZoomHint')),
    ...toggle(t('comicStripZoom'), 'comicStripZoom', s.comicStripZoom, (v) => updateSettings({ comicStripZoom: v })));
  // Wide pages, as the reference reader has them: split or turned (one page per screen; the strip's own four), and two pages side by side.
  body.append(sub(t('comicWideHead')),
    ...toggle(t('comicSplit'), 'comicSplit', s.comicSplit, (v) => updateSettings({ comicSplit: v })),
    ...toggle(t('comicSplitInvert'), 'comicSplitInvert', s.comicSplitInvert, (v) => updateSettings({ comicSplitInvert: v })),
    ...toggle(t('comicRotate'), 'comicRotate', s.comicRotate, (v) => updateSettings({ comicRotate: v })),
    ...toggle(t('comicRotateInvert'), 'comicRotateInvert', s.comicRotateInvert, (v) => updateSettings({ comicRotateInvert: v }), t('comicWideHint')),
    pick(t('comicDual'), 'comicDual', [['never', t('comicDualNever')], ['always', t('comicDualAlways')], ['wide', t('comicDualWide')]], s.comicDual, (v) => updateSettings({ comicDual: v })),
    h('p', { class: 'hint' }, t('comicDualHint')),
    sub(t('comicWideStripHead')),
    ...toggle(t('comicSplit'), 'comicSplitStrip', s.comicSplitStrip, (v) => updateSettings({ comicSplitStrip: v })),
    ...toggle(t('comicSplitInvert'), 'comicSplitInvertStrip', s.comicSplitInvertStrip, (v) => updateSettings({ comicSplitInvertStrip: v })),
    ...toggle(t('comicRotate'), 'comicRotateStrip', s.comicRotateStrip, (v) => updateSettings({ comicRotateStrip: v })),
    ...toggle(t('comicRotateInvert'), 'comicRotateInvertStrip', s.comicRotateInvertStrip, (v) => updateSettings({ comicRotateInvertStrip: v }), t('comicWideStripHint')));
}

/** «General»: fit, where a page starts, the page number, the screen kept on, the volume keys, the page between volumes. */
export function comicGeneralFields(body: HTMLElement, o: { shared?: boolean } = {}): void {
  // (`shared`: the screen kept on and the volume keys, which Settings → Reader has above the group already.)
  const shared = o.shared ?? true;
  const s = getSettings(); const redraw = () => { body.replaceChildren(); comicGeneralFields(body, o); };
  body.append(
    pick(t('comicScale'), 'comicScale', [['fit', t('comicScaleFit')], ['stretch', t('comicScaleStretch')], ['width', t('comicScaleWidth')], ['height', t('comicScaleHeight')], ['original', t('comicScaleOriginal')], ['smart', t('comicScaleSmart')]], s.comicScale, (v) => updateSettings({ comicScale: v })),
    pick(t('comicZoomStart'), 'comicZoomStart', [['auto', t('comicZoomAuto')], ['left', t('comicZoomLeft')], ['right', t('comicZoomRight')], ['center', t('comicZoomCenter')]], s.comicZoomStart, (v) => updateSettings({ comicZoomStart: v })),
    pick(t('comicBackground'), 'comicBackground', [['black', t('comicBgBlack')], ['grey', t('comicBgGrey')], ['white', t('comicBgWhite')], ['auto', t('comicBgAuto')]], s.comicBackground, (v) => updateSettings({ comicBackground: v })),
    ...toggle(t('comicPageNumber'), 'comicPageNumber', s.comicPageNumber, (v) => updateSettings({ comicPageNumber: v })),
    ...toggle(t('comicCrop'), 'comicCrop', s.comicCrop, (v) => updateSettings({ comicCrop: v }), t('comicCropHint')),
    ...toggle(t('comicCropStrip'), 'comicCropStrip', s.comicCropStrip, (v) => updateSettings({ comicCropStrip: v })),
    ...toggle(t('comicLongPress'), 'comicLongPress', s.comicLongPress, (v) => updateSettings({ comicLongPress: v }), t('comicLongPressHint')),
    sub(t('comicStripHead')),
    slide(t('comicStripPadding'), 'comicStripPadding', 0, 25, 1, (v) => `${v}%`),
    ...toggle(t('comicStripNoZoomOut'), 'comicStripNoZoomOut', s.comicStripNoZoomOut, (v) => updateSettings({ comicStripNoZoomOut: v })));
  if (shared) body.append(...toggle(t('keepAwake'), 'keepAwake', s.keepAwake, (v) => { updateSettings({ keepAwake: v }); keepAwake(v); }));
  if (shared && fits('android')) {
    body.append(...toggle(t('volumeKeys'), 'volumeKeys', s.volumeKeys, (v) => { updateSettings({ volumeKeys: v }); redraw(); }, t('volumeKeysHint')));
    if (s.volumeKeys) body.append(...toggle(t('volumeSwap'), 'volumeSwap', s.volumeSwap, (v) => updateSettings({ volumeSwap: v }), t('volumeSwapHint')));
  }
  body.append(...toggle(t('comicBetween'), 'comicBetween', s.comicBetween, (v) => updateSettings({ comicBetween: v })));
  if (fits('computer')) body.append(h('p', { class: 'hint cm-keys-hint' }, t('comicKeysHint')));
}

/** «Colour filter»: custom brightness, a colour filter (R G B A, a blend mode), greyscale, inverted colours. No colour is offered
 *  ready-made: the reader mixes his own. */
export function comicColourFields(body: HTMLElement): void {
  const s = getSettings(); const redraw = () => { body.replaceChildren(); comicColourFields(body); };
  const sign = (v: number) => (v > 0 ? `+${v}` : String(v));
  body.append(...toggle(t('comicBright'), 'comicBrightOn', s.comicBrightOn, (v) => { updateSettings({ comicBrightOn: v }); redraw(); }, t('comicBrightHint')));
  if (s.comicBrightOn) body.append(slide(t('comicBrightValue'), 'comicBrightness', -75, 100, 1, sign));
  body.append(...toggle(t('comicTint'), 'comicTintOn', s.comicTintOn, (v) => { updateSettings({ comicTintOn: v }); redraw(); }));
  if (s.comicTintOn) {
    body.append(slide(t('comicTintR'), 'comicTintR', 0, 255, 1), slide(t('comicTintG'), 'comicTintG', 0, 255, 1), slide(t('comicTintB'), 'comicTintB', 0, 255, 1), slide(t('comicTintA'), 'comicTintA', 0, 255, 1),
      pick(t('comicBlend'), 'comicTintBlend', blendItems(), s.comicTintBlend, (v) => updateSettings({ comicTintBlend: v })));
  }
  body.append(...toggle(t('comicGrey'), 'comicGrey', s.comicGrey, (v) => updateSettings({ comicGrey: v })), ...toggle(t('comicInvertColours'), 'comicInvertColours', s.comicInvertColours, (v) => updateSettings({ comicInvertColours: v })));
}
const blendItems = (): [VisualSettings['comicTintBlend'], string][] => [['normal', t('comicBlendNormal')], ['multiply', t('comicBlendMultiply')], ['screen', t('comicBlendScreen')], ['overlay', t('comicBlendOverlay')], ['lighten', t('comicBlendLighten')], ['darken', t('comicBlendDarken')]];

/** Settings → Reader: the comics' defaults, and (for this version) the way back to opening them as before. */
export function comicSettingsGroup(container: HTMLElement): void {
  const mode = h('div', { class: 'cm-group' }); const general = h('div', { class: 'cm-group' }); const colour = h('div', { class: 'cm-group' });
  comicModeFields(mode); comicGeneralFields(general, { shared: false }); comicColourFields(colour);
  const s = getSettings();
  container.append(h('h4', { class: 'cm-group-head' }, t('comicsGroup')), mode, general, sub(t('comicTabColour')), colour,
    ...toggle(t('comicOldWay'), 'comicOldWay', s.comicOldWay, (v) => updateSettings({ comicOldWay: v }), t('comicOldWayHint')));
}
