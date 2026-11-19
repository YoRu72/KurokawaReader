// «Your pictures and videos» (Settings → Appearance, a computer's background): the library grid (theme/bgLib.ts) —
// add a picture, a moving picture or a looping video (copied into the app), choose one, adjust it (fit, place, veil,
// blur, panel tint, light glass, the app's colours from it, each one overridable), rename, delete with Undo, the
// storage used — and the Wallpaper Engine browser (theme/weLib.ts, read only): the wallpapers on this computer in a
// windowed grid with search, type and tag filters, sort and counts; a VIDEO wallpaper copied in as a background, the
// others shown and marked for a later update, their preview picture usable as a still. Loaded on first use only; every
// listener, observer, timer and picture it makes is released when its sheet closes.
import { h, icon, toast, openSheet, pickButton } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { libItems, addFile, saveItem, renameItem, deleteItem, sweep, storageUsed, thumbUrl, setDraft, coloursOf, cleanName, baseName, BgError, RANGE, MAX_ITEMS, MAX_TOTAL, PIC_MAX_IN, ANIM_MAX_IN, VID_MAX_IN, VID_MAX_SEC, ANIM_MAX_FRAMES, NAME_MAX, type BgItem, type Fit, type GlassLight, type BgFault } from '../theme/bgLib';
import { weBridge, detect, listAll, sourcesFromChosen, previewBitmap, readInside, WeError, type WeItem, type WeSource, type WeType, type WeBridge } from '../theme/weLib';
import { MAX_PIXELS } from '../anime/covers';
import type { RGBA } from '../theme/themes';

const CSS_ID = 'kt-bglib-css';
const STYLE = `.bgl .abg-thumb{position:relative}
.bgl-badge{position:absolute;inset-inline-start:6px;bottom:6px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;background:var(--md-surface-container-highest,var(--md-surface));color:var(--md-on-surface);box-shadow:0 0 0 1px var(--md-outline-variant)}
.bgl-missing .abg-thumb{opacity:.45}
.bgl-icon{display:grid;place-items:center;opacity:1;background:color-mix(in srgb,var(--md-primary) 10%,transparent);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--md-primary) 40%,transparent)}
.bgl-icon svg{width:28px;height:28px;fill:none;stroke:var(--md-primary);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.bgl-tile-act .abg-name{color:var(--md-primary);font-weight:600}
.bgl-notes{display:flex;flex-direction:column;gap:4px;margin-top:10px}
.bg-sheet .mix-section{display:flex;flex-direction:column;gap:10px;padding:10px 14px 12px;border-radius:var(--sh-md,14px);background:color-mix(in srgb,var(--md-primary) 6%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--md-primary) 16%,transparent)}
.bg-sheet .mix-section>h4{margin:0;font-size:13.5px;font-weight:650;color:var(--md-on-surface)}
.bgl-swrow{display:grid;grid-template-columns:minmax(0,1fr);gap:6px}
.bgl-swrow>span{font-size:13px;color:var(--md-on-surface-variant)}
.bgl-sws{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.bgl-sw{width:32px;height:32px;border-radius:50%;border:0;padding:0;cursor:pointer;background:var(--sw);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--md-on-surface) 25%,transparent);position:relative;flex:none}
.bgl-sw.on{box-shadow:0 0 0 2px var(--md-surface),0 0 0 4px var(--md-on-surface)}
.bgl-sw.auto{width:auto;min-width:72px;padding-block:0;padding-inline:34px 12px;border-radius:999px;background:var(--md-surface-container-high,var(--md-surface));color:var(--md-on-surface);font:inherit;font-size:13px;height:32px}
.bgl-sw.auto::before{content:'';position:absolute;inset-inline-start:8px;top:7px;width:18px;height:18px;border-radius:50%;background:var(--sw)}
.bgl-sw.own{display:grid;place-items:center;background:var(--md-surface-container-high,var(--md-surface));overflow:hidden}
.bgl-sw.own svg{width:16px;height:16px;fill:none;stroke:var(--md-on-surface);stroke-width:2}
.bgl-sw.own input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;border:0;padding:0}
.bg-sheet .switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:48px}
.bg-sheet .switch-row small{display:block;font-size:12.5px;color:var(--md-on-surface-variant);margin-top:2px}
html.pc .sheet.we-sheet{max-width:1040px;width:min(1040px,calc(100vw - 48px))}
.we-sheet .sheet-body{display:flex;flex-direction:column;gap:12px;padding-bottom:24px;font-size:14px}
.we-sheet .sheet-body>*{flex:none;margin:0}
.we-acts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;max-width:520px}
.we-acts .btn{min-width:0}
.we-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.we-filters .chip{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 14px;border-radius:999px;border:0;cursor:pointer;font:inherit;font-size:13px;background:var(--md-surface-container-high,var(--md-surface));color:var(--md-on-surface);box-shadow:inset 0 0 0 1px var(--md-outline-variant)}
.we-filters .chip.on{background:var(--md-primary);color:var(--md-on-primary);box-shadow:none}
.we-picks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 24px}
@media (max-width:640px){.we-picks{grid-template-columns:minmax(0,1fr)}}
.we-search input{height:44px}
.we-grid{position:relative;width:100%}
.we-tile{position:absolute;top:0;left:0;display:flex;flex-direction:column;gap:6px;padding:4px;border:0;border-radius:var(--sh-md,14px);background:none;color:var(--md-on-surface);font:inherit;font-size:13px;text-align:start;cursor:pointer;box-sizing:border-box}
.we-tile:focus-visible{outline:2px solid var(--md-primary);outline-offset:2px}
.we-tile canvas{display:block;width:100%;aspect-ratio:16/9;border-radius:var(--sh-sm,10px);background:var(--md-surface-container-high,var(--md-surface));box-shadow:inset 0 0 0 1px var(--md-outline-variant)}
.we-tile .we-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-inline:2px}
.we-tile .we-type{position:absolute;inset-inline-start:10px;top:10px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:600;background:var(--md-surface-container-highest,var(--md-surface));color:var(--md-on-surface);box-shadow:0 0 0 1px var(--md-outline-variant)}
.we-tile .we-later{position:absolute;inset-inline-end:10px;top:10px;padding:2px 8px;border-radius:999px;font-size:11.5px;background:color-mix(in srgb,var(--md-tertiary,var(--md-primary)) 22%,var(--md-surface));color:var(--md-on-surface)}
.we-detail canvas{display:block;width:100%;max-width:640px;aspect-ratio:16/9;border-radius:var(--sh-md,14px);background:var(--md-surface-container-high,var(--md-surface))}
.we-detail .sheet-body{display:flex;flex-direction:column;gap:10px}
.we-tags{display:flex;flex-wrap:wrap;gap:6px}
.we-tags span{padding:2px 10px;border-radius:999px;font-size:12px;background:var(--md-surface-container-high,var(--md-surface));box-shadow:inset 0 0 0 1px var(--md-outline-variant)}`;
function css(): void { if (!document.getElementById(CSS_ID)) { const s = document.createElement('style'); s.id = CSS_ID; s.textContent = STYLE; document.head.append(s); } }
const tk = (k: string, v?: Record<string, string | number>): string => t(k as 'bgAdd', v);
const pct = (v: number): string => `${localDigits(Math.round(v * 100))}%`;
const cssCol = (c: RGBA): string => `rgb(${Math.round(c[0])} ${Math.round(c[1])} ${Math.round(c[2])})`;
const isPc = (): boolean => document.documentElement.classList.contains('pc');

/** Why a file was refused, in the reader's words, with its cap. */
export function faultText(f: BgFault | string): string {
  switch (f) {
    case 'notMedia': return t('bgErrNotMedia');
    case 'tooLarge': return t('bgErrTooLarge', { pic: formatBytes(PIC_MAX_IN), anim: formatBytes(ANIM_MAX_IN), vid: formatBytes(VID_MAX_IN) });
    case 'tooBig': return t('bgErrTooBig', { n: localDigits(Math.round(MAX_PIXELS / 1e6)) });
    case 'tooLong': return t('bgErrTooLong', { min: localDigits(VID_MAX_SEC / 60), frames: localDigits(ANIM_MAX_FRAMES) });
    case 'tooShort': return t('bgErrTooShort');
    case 'store': return t('bgErrStore');
    case 'full': return t('bgErrFull', { n: localDigits(MAX_ITEMS) });
    case 'total': return t('bgErrTotal', { size: formatBytes(MAX_TOTAL) });
    case 'missing': return t('weErrMissing');
    case 'outside': return t('weErrOutside');
    case 'notImage': return t('bgErrNotMedia');
    default: return t('bgErrDecode');
  }
}
/** A file chosen on the computer (null when the chooser was closed). */
function pickLocal(): Promise<File | null> {
  return new Promise((res) => {
    const f = h('input', { type: 'file', accept: 'image/*,video/mp4,video/webm,video/quicktime,.gif,.apng,.webp,.mp4,.webm,.mov,.m4v', style: { display: 'none' } }) as HTMLInputElement;
    f.addEventListener('change', () => { res(f.files?.[0] ?? null); f.remove(); });
    f.addEventListener('cancel', () => { res(null); f.remove(); });
    document.body.append(f); f.click();
  });
}
const reload = (): Promise<void> => import('../theme/animbg').then((m) => m.reloadAnimBg());
/** A file put into the library and chosen as the background, with what happened said. */
async function addAndUse(file: Blob, name: string, from: 'file' | 'we', rerender: () => void): Promise<boolean> {
  toast(t('bgAdding', { name }), 'info', 60_000);
  try {
    const it = await addFile(file, name, from);
    updateSettings({ animBg: `scene:user:${it.id}` });
    toast(t('bgAdded', { name: it.name })); rerender(); return true;
  } catch (e) { toast(faultText(e instanceof BgError || e instanceof WeError ? e.fault : 'decode'), 'error', 7000); return false; }
}

/* ---------- the grid in Appearance ---------- */
/** The library's rows (filled into `host`, a row the Appearance page drew): the tiles, the chosen one's actions, the
 *  storage used. */
export function fillLibrary(host: HTMLElement, rerender: () => void): void {
  css(); void sweep();
  const s = getSettings(); const items = libItems(); const cur = (s.animBg ?? '').startsWith('scene:user:') ? (s.animBg as string).slice(11) : '';
  const tiles: HTMLElement[] = [];
  const kindLabel = (it: BgItem): string => t(it.kind === 'video' ? 'bgKindVideo' : it.kind === 'anim' && !it.still ? 'bgKindAnim' : 'bgKindImage');
  for (const it of items) {
    const on = it.id === cur; const th = h('span', { class: 'abg-thumb' }, it.kind !== 'image' ? h('span', { class: 'bgl-badge' }, kindLabel(it)) : null);
    const b = h('button', { type: 'button', class: 'abg-tile' + (on ? ' on' : ''), role: 'radio', 'aria-checked': on ? 'true' : 'false', 'data-bg': it.id, title: `${it.name} · ${kindLabel(it)} · ${formatBytes(it.bytes)}`, onclick: () => { updateSettings({ animBg: `scene:user:${it.id}` }); rerender(); } },
      th, h('span', { class: 'abg-name', dir: 'auto' }, it.name));
    tiles.push(b);
    void thumbUrl(it.id).then((u) => { if (u) { th.style.backgroundImage = `url("${u}")`; th.classList.add('drawn'); } else b.classList.add('bgl-missing'); });
  }
  const act = (cls: string, ic: string, label: string, hint: string, run: () => void, data: string) => h('button', { type: 'button', class: `abg-tile bgl-tile-act ${cls}`, title: hint, [`data-${data}`]: '', onclick: run }, h('span', { class: 'abg-thumb bgl-icon' }, icon(ic)), h('span', { class: 'abg-name' }, label));
  const add = act('', 'plus', t('bgAdd'), t('bgAddHint', { pic: formatBytes(PIC_MAX_IN), vid: formatBytes(VID_MAX_IN), min: localDigits(VID_MAX_SEC / 60) }), () => void pickLocal().then((f) => { if (f) void addAndUse(f, baseName(f.name), 'file', rerender); }), 'bg-add');
  const we = isPc() && weBridge() ? act('', 'images', t('bgWe'), t('bgWeHint'), () => openWe(rerender), 'bg-we') : null;
  const head = h('div', { class: 'abg-group-title' }, items.length ? t('bgLibTitleN', { n: localDigits(items.length) }) : t('animBgMine'));
  const grid = h('div', { class: 'abg-tiles', role: 'radiogroup', 'aria-label': t('animBgMine') }, add, we, ...tiles);
  const chosen = items.find((x) => x.id === cur);
  const acts = h('div', { class: 'abg-mix-acts', hidden: !chosen },
    h('button', { type: 'button', class: 'btn tonal small', 'data-bg-act': 'adjust', onclick: () => chosen && openControls(chosen, rerender) }, icon('pen'), t('bgAdjust')),
    h('button', { type: 'button', class: 'btn tonal small', 'data-bg-act': 'rename', onclick: () => chosen && renameBg(chosen, rerender) }, icon('type'), t('bgRename')),
    h('button', { type: 'button', class: 'btn tonal small danger', 'data-bg-act': 'delete', onclick: () => chosen && deleteBg(chosen, rerender) }, icon('trash'), t('bgDelete')));
  const notes = h('div', { class: 'bgl-notes' },
    h('small', { class: 'src bgl-store', 'aria-live': 'polite' }, t('bgStorage', { size: formatBytes(storageUsed()), max: formatBytes(MAX_TOTAL) })),
    chosen?.still ? h('small', { class: 'src' }, t('bgStillNote')) : null);
  if (chosen) void thumbUrl(chosen.id).then((u) => { if (!u && notes.isConnected) notes.append(h('small', { class: 'src bgl-missing-note' }, t('bgMissing'))); });
  host.replaceChildren(h('div', { class: 'abg-group bgl' }, head, grid, acts, notes));
}

/** A background renamed (a small sheet with its name). */
function renameBg(it: BgItem, rerender: () => void): void {
  const sh = openSheet(t('bgRenameTitle'), t('close'));
  const input = h('input', { type: 'text', dir: 'auto', maxlength: String(NAME_MAX), value: it.name, 'aria-label': t('bgName'), 'data-bg': 'rename' }) as HTMLInputElement;
  const go = (): void => { if (!renameItem(it.id, input.value)) { input.focus(); return; } sh.close(); rerender(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  sh.body.append(h('label', { class: 'field' }, h('span', { class: 'label' }, t('bgName')), input));
  sh.actions.classList.add('mix-actions');
  sh.actions.append(h('button', { type: 'button', class: 'btn', onclick: () => sh.close() }, t('bgCancel')), h('button', { type: 'button', class: 'btn primary', 'data-bg-act': 'rename-ok', onclick: go }, icon('check'), t('bgRename')));
  queueMicrotask(() => { input.focus(); input.select(); });
}
/** A background deleted — at once, with Undo; its files go when the Undo is no longer offered. */
function deleteBg(it: BgItem, rerender: () => void): void {
  const ms = 6000; const { item, restore } = deleteItem(it.id, ms); if (!item) return;
  rerender();
  toast(t('bgDeleted', { name: item.name }), 'info', ms, { label: t('undo'), run: () => { restore(); rerender(); } });
}

/* ---------- the controls sheet ---------- */
/** An own slider (as the mixer's: a styled range, never a number spinner). */
function slider(label: string, [lo, hi]: readonly [number, number], step: number, value: number, say: (v: number) => string, set: (v: number) => void, key: string): HTMLElement {
  const out = h('output', { class: 'mix-val' }, say(value));
  const input = h('input', { type: 'range', min: String(lo), max: String(hi), step: String(step), value: String(value), 'aria-label': label, 'data-bg': key }) as HTMLInputElement;
  const fill = (): void => { input.style.setProperty('--p', `${((Number(input.value) - lo) / (hi - lo)) * 100}%`); }; fill();
  input.addEventListener('input', () => { const v = Number(input.value); out.textContent = say(v); fill(); set(v); });
  return h('div', { class: 'mix-slider' }, h('div', { class: 'mix-slider-head' }, h('span', null, label), out), input);
}
const sw = (label: string, on: boolean, set: (v: boolean) => void, hint: string, key: string): HTMLElement => {
  const i = h('input', { type: 'checkbox', role: 'switch', checked: on, 'data-bg': key, onchange: () => set(i.checked) }) as HTMLInputElement;
  return h('label', { class: 'switch-row' }, h('span', null, label, h('small', null, hint)), i);
};
/** The sheet that adjusts one background, with a live preview of it. */
export function openControls(item: BgItem, rerender: () => void): void {
  css();
  const work: BgItem = { ...item, col: { ...item.col }, pal: [...item.pal] };
  let stop: (() => void) | null = null; let timer = 0; let gone = false;
  const sh = openSheet(t('bgCtlTitle', { name: item.name }), t('close'), { onClose: () => { gone = true; clearTimeout(timer); timer = 0; stop?.(); stop = null; setDraft(null); } });
  sh.el.classList.add('mix-sheet', 'bg-sheet');
  const box = h('div', { class: 'abg-preview mix-preview', role: 'img', 'aria-label': t('animBgPreview') });
  // (The preview: the draft drawn as it will be — re-made a moment after a change.)
  const show = (): void => {
    if (gone) return; setDraft(work);
    clearTimeout(timer); timer = window.setTimeout(() => { timer = 0; if (gone) return; void import('../theme/animbg').then((m) => { if (gone) return; stop?.(); stop = m.previewAnimBg(box, 'scene:user:~draft', { art: true }); }); }, stop ? 220 : 0);
  };
  const controls = h('div', { class: 'mix-controls' });
  const build = (): void => {
    controls.replaceChildren();
    const row = (label: string, control: Node) => h('div', { class: 'mix-row' }, h('span', { class: 'mix-label' }, label), control);
    const fits: [Fit, string][] = [['cover', t('bgFitCover')], ['contain', t('bgFitContain')], ['fill', t('bgFitFill')], ['center', t('bgFitCenter')]];
    controls.append(row(t('bgFit'), pickButton(t('bgFit'), fits, work.fit, (v) => { work.fit = v; build(); show(); }, t('close'))));
    if (work.fit !== 'fill') controls.append(h('div', { class: 'mix-pair' },
      slider(t('bgPosX'), RANGE.pos, 0.01, work.x, pct, (v) => { work.x = v; show(); }, 'x'),
      slider(t('bgPosY'), RANGE.pos, 0.01, work.y, pct, (v) => { work.y = v; show(); }, 'y')));
    controls.append(h('div', { class: 'mix-pair' },
      slider(t('bgDim'), RANGE.dim, 0.01, work.dim, pct, (v) => { work.dim = v; show(); }, 'dim'),
      slider(t('bgBlur'), RANGE.blur, 1, work.blur, (v) => t('bgPx', { n: localDigits(v) }), (v) => { work.blur = v; show(); }, 'blur')),
      slider(t('bgVeil'), RANGE.veil, 0.01, work.veil, pct, (v) => { work.veil = v; }, 'veil'),
      row(t('bgLight'), pickButton(t('bgLight'), [['auto', t('bgLightAuto')], ['on', t('bgLightOn')], ['off', t('bgLightOff')]] as [GlassLight, string][], work.light, (v) => { work.light = v; }, t('close'))),
      h('p', { class: 'hint' }, t('bgCtlHint')));
    // (The app's colours from this background: the switch is the page's own («Match the app's colours to the
    //  background»); each colour Auto, one of the picture's, or the reader's own.)
    const sec = h('div', { class: 'mix-section' }, h('h4', null, t('bgColours')),
      sw(t('animBgTintRow'), getSettings().animBgTint === true, (v) => { updateSettings({ animBgTint: v }); }, t('bgColoursHint'), 'tint-on'));
    const auto = coloursOf({ pal: work.pal, col: { accent: 'auto', accent2: 'auto', tint: 'auto' } });
    for (const role of ['accent', 'accent2', 'tint'] as const) {
      const ch = work.col[role]; const wrap = h('div', { class: 'bgl-sws', role: 'radiogroup', 'aria-label': t(role === 'accent' ? 'bgAccent' : role === 'accent2' ? 'bgAccent2' : 'bgTint') });
      const pick = (v: string): void => { work.col[role] = v; build(); };
      const a = auto?.[role];
      wrap.append(h('button', { type: 'button', class: 'bgl-sw auto' + (ch === 'auto' ? ' on' : ''), role: 'radio', 'aria-checked': String(ch === 'auto'), 'data-sw': `${role}:auto`, style: { '--sw': a ? cssCol(a) : 'var(--md-primary)' }, onclick: () => pick('auto') }, t('bgColAuto')));
      work.pal.forEach((hex, i) => wrap.append(h('button', { type: 'button', class: 'bgl-sw' + (ch === `p${i}` ? ' on' : ''), role: 'radio', 'aria-checked': String(ch === `p${i}`), 'data-sw': `${role}:p${i}`, 'aria-label': t('bgColSwatch', { n: localDigits(i + 1) }), title: hex, style: { '--sw': hex }, onclick: () => pick(`p${i}`) })));
      const own = ch.startsWith('#'); const input = h('input', { type: 'color', value: own ? ch : '#6f8fd8', 'aria-label': t('bgColCustom'), 'data-sw': `${role}:own`, onchange: (e: Event) => pick((e.target as HTMLInputElement).value.toLowerCase()) });
      wrap.append(h('label', { class: 'bgl-sw own' + (own ? ' on' : ''), title: t('bgColCustom'), style: own ? { background: ch } : {} }, own ? null : icon('pen'), input));
      sec.append(h('div', { class: 'bgl-swrow' }, h('span', null, t(role === 'accent' ? 'bgAccent' : role === 'accent2' ? 'bgAccent2' : 'bgTint')), wrap));
    }
    sec.append(h('p', { class: 'hint' }, t('bgColNote')));
    controls.append(sec);
  };
  build();
  sh.body.append(box, controls);
  sh.actions.classList.add('mix-actions');
  sh.actions.append(h('button', { type: 'button', class: 'btn', onclick: () => sh.close() }, t('bgCancel')),
    h('button', { type: 'button', class: 'btn primary', 'data-bg-act': 'save', onclick: () => { saveItem(work); sh.close(); void reload(); rerender(); toast(t('bgSaved', { name: work.name })); } }, icon('check'), t('bgSave')));
  show();
}

/* ---------- the Wallpaper Engine browser ---------- */
const TYPE_KEY: Record<WeType, string> = { video: 'weVideo', scene: 'weScene', web: 'weWeb', application: 'weApp', unknown: 'weUnknown' };
type Filter = 'all' | WeType;
/** The browser: what was found, the wallpapers in a windowed grid. */
export function openWe(rerender: () => void): void {
  css(); const b = weBridge(); if (!b) return;
  let gone = false; const cache = new Map<string, ImageBitmap | null>(); const queue: string[] = []; let loading = 0;
  let items: WeItem[] = []; let shown: WeItem[] = []; let filter: Filter = 'all'; let tag = ''; let sort: 'name' | 'new' = 'name'; let query = '';
  let ro: ResizeObserver | null = null; let raf = 0;
  const sh = openSheet(t('weTitle'), t('close'), { onClose: () => { gone = true; ro?.disconnect(); ro = null; cancelAnimationFrame(raf); raf = 0; sh.body.removeEventListener('scroll', onScroll); for (const x of cache.values()) x?.close(); cache.clear(); queue.length = 0; } });
  sh.el.classList.add('we-sheet');
  const status = h('p', { class: 'src we-status', 'aria-live': 'polite' }, t('weSearching'));
  const acts = h('div', { class: 'we-acts' },
    h('button', { type: 'button', class: 'btn tonal', 'data-we': 'rescan', onclick: () => void scan(null) }, icon('refresh'), t('weRescan')),
    h('button', { type: 'button', class: 'btn tonal', 'data-we': 'choose', onclick: () => void b.pickDir?.().then((p) => { if (p && !gone) void scan(p); }) }, icon('folder'), t('weChoose')));
  const search = h('input', { type: 'search', dir: 'auto', placeholder: t('weSearch'), 'aria-label': t('weSearch'), 'data-we': 'search' }) as HTMLInputElement;
  search.addEventListener('input', () => { query = search.value.trim().toLocaleLowerCase(); apply(); });
  const chips = h('div', { class: 'we-filters', role: 'radiogroup', 'aria-label': t('weType') });
  const picks = h('div', { class: 'we-picks' });
  const count = h('p', { class: 'src we-count', 'aria-live': 'polite' });
  const grid = h('div', { class: 'we-grid', role: 'list' });
  const note = h('p', { class: 'hint' }, t('weReadOnly'));
  sh.body.append(status, acts, h('label', { class: 'field we-search' }, search), chips, picks, count, grid, note);
  const tileW = 200, gap = 12; let cols = 1, tw = tileW, th = 150;
  const layout = (): void => { const W = grid.clientWidth || 800; cols = Math.max(1, Math.floor((W + gap) / (tileW + gap))); tw = (W - gap * (cols - 1)) / cols; th = tw * 9 / 16 + 8 + 30; grid.style.height = `${Math.ceil(shown.length / cols) * (th + gap)}px`; };
  /** Only the rows in view (and one each side) are on the page. */
  const draw = (): void => {
    raf = 0; if (gone) return;
    const top = sh.body.getBoundingClientRect().top - grid.getBoundingClientRect().top; const vh = sh.body.clientHeight || 600;
    const r0 = Math.max(0, Math.floor(top / (th + gap)) - 1), r1 = Math.ceil((top + vh) / (th + gap)) + 1;
    const want = new Set<string>(); const nodes: HTMLElement[] = [];
    for (let i = r0 * cols; i < Math.min(shown.length, r1 * cols); i++) {
      const it = shown[i]; want.add(it.key);
      const later = it.type !== 'video';
      const cv = h('canvas', { width: '320', height: '180', 'aria-hidden': 'true' }) as HTMLCanvasElement;
      const tile = h('button', { type: 'button', class: 'we-tile', role: 'listitem', 'data-we-key': it.key, 'data-we-type': it.type, title: it.title, style: { width: `${tw}px`, transform: `translate(${(document.documentElement.dir === 'rtl' ? cols - 1 - (i % cols) : i % cols) * (tw + gap)}px, ${Math.floor(i / cols) * (th + gap)}px)` }, onclick: () => detail(it) },
        cv, h('span', { class: 'we-type' }, t(TYPE_KEY[it.type] as 'weVideo')), later ? h('span', { class: 'we-later' }, t('weLater')) : null, h('span', { class: 'we-name', dir: 'auto' }, it.title));
      nodes.push(tile); paint(it, cv);
    }
    grid.replaceChildren(...nodes);
    for (let i = queue.length - 1; i >= 0; i--) if (!want.has(queue[i])) queue.splice(i, 1);
  };
  const later = (): void => { if (!raf && !gone) raf = requestAnimationFrame(draw); };
  function onScroll(): void { later(); }
  sh.body.addEventListener('scroll', onScroll, { passive: true });
  ro = new ResizeObserver(() => { layout(); later(); }); ro.observe(grid);
  /** A tile's picture: from the cache, or read (four at a time) and drawn when it comes. */
  function paint(it: WeItem, cv: HTMLCanvasElement): void {
    const g = cv.getContext('2d'); if (!g) return;
    const have = cache.get(it.key);
    if (have) { g.drawImage(have, 0, 0); cv.dataset.drawn = 'picture'; return; }
    if (have === null || !it.preview) { g.clearRect(0, 0, 320, 180); cv.dataset.drawn = 'none'; return; }
    if (!queue.includes(it.key)) queue.push(it.key); pump();
  }
  function pump(): void {
    while (loading < 4 && queue.length && !gone) {
      const key = queue.shift()!; const it = items.find((x) => x.key === key); if (!it || cache.has(key)) continue;
      loading++;
      void previewBitmap(b!, it).then((bmp) => { if (gone) { bmp.close(); return; } cache.set(key, bmp); if (cache.size > 400) { const [k0, v0] = cache.entries().next().value as [string, ImageBitmap | null]; v0?.close(); cache.delete(k0); } }, () => { if (!gone) cache.set(key, null); })
        .finally(() => { loading--; if (gone) return; const cv = grid.querySelector<HTMLElement>(`[data-we-key="${CSS.escape(key)}"] canvas`) as HTMLCanvasElement | null; const it2 = items.find((x) => x.key === key); if (cv && it2) paint(it2, cv); pump(); });
    }
  }
  /** The filters, the search and the sort applied; the counts said. */
  function apply(): void {
    const byType = new Map<Filter, number>([['all', items.length]]); for (const x of items) byType.set(x.type, (byType.get(x.type) ?? 0) + 1);
    chips.replaceChildren(...(['all', 'video', 'scene', 'web', 'application', 'unknown'] as Filter[]).filter((f) => f === 'all' || byType.get(f)).map((f) => h('button', { type: 'button', class: 'chip' + (filter === f ? ' on' : ''), role: 'radio', 'aria-checked': String(filter === f), 'data-we-filter': f, onclick: () => { filter = f; apply(); } }, `${t(f === 'all' ? 'weAll' : TYPE_KEY[f] as 'weVideo')} · ${localDigits(byType.get(f) ?? 0)}`)));
    const tags = new Map<string, number>(); for (const x of items) for (const tg of x.tags) tags.set(tg, (tags.get(tg) ?? 0) + 1);
    const tagOpts: [string, string][] = [['', t('weTagAll')], ...[...tags].sort((a, z) => z[1] - a[1]).slice(0, 60).map(([k, n]): [string, string] => [`t:${k}`, `${k} · ${localDigits(n)}`])];
    picks.replaceChildren(
      h('div', { class: 'mix-row' }, h('span', { class: 'mix-label' }, t('weTag')), pickButton(t('weTag'), tagOpts, tag ? `t:${tag}` : '', (v) => { tag = v ? v.slice(2) : ''; apply(); }, t('close'))),
      h('div', { class: 'mix-row' }, h('span', { class: 'mix-label' }, t('weSort')), pickButton(t('weSort'), [['name', t('weSortName')], ['new', t('weSortNew')]], sort, (v) => { sort = v as 'name' | 'new'; apply(); }, t('close'))));
    shown = items.filter((x) => (filter === 'all' || x.type === filter) && (!tag || x.tags.includes(tag)) && (!query || x.title.toLocaleLowerCase().includes(query) || x.tags.some((g) => g.toLocaleLowerCase().includes(query))));
    shown.sort(sort === 'new' ? (a, z) => z.mtime - a.mtime || a.title.localeCompare(z.title) : (a, z) => a.title.localeCompare(z.title));
    count.textContent = t('weCount', { n: localDigits(shown.length) });
    layout(); draw();
  }
  /** Looked for (or a chosen folder read), then listed. */
  async function scan(chosen: string | null): Promise<void> {
    status.textContent = t('weSearching'); items = []; apply();
    let sources: WeSource[];
    try { sources = chosen ? await sourcesFromChosen(b!, chosen) : (await detect(b!)).sources; } catch { sources = []; }
    if (gone) return;
    if (!sources.length) { status.textContent = chosen ? t('weChooseNone') : t('weNone'); return; }
    const r = await listAll(b!, sources, (d, n) => { if (!gone) status.textContent = t('weReading', { n: localDigits(d), total: localDigits(n) }); }, () => gone);
    if (gone) return;
    items = r.items;
    status.textContent = t('weFound', { n: localDigits(sources.length) }) + (r.unreadable ? ' · ' + t('weUnreadable', { n: localDigits(r.unreadable) }) : '');
    if (chosen && !items.length) status.textContent = t('weChooseNone');
    apply();
  }
  /** One wallpaper: its picture, type, tags, what it can be used for. */
  function detail(it: WeItem): void {
    let closed = false;
    const d = openSheet(it.title, t('close'), { stack: true, onClose: () => { closed = true; } }); d.el.classList.add('we-detail');
    const cv = h('canvas', { width: '640', height: '360', 'aria-hidden': 'true' }) as HTMLCanvasElement;
    if (it.preview) void previewBitmap(b!, it, 640, 360).then((x) => { if (!closed && cv.isConnected) cv.getContext('2d')?.drawImage(x, 0, 0); x.close(); }, () => undefined);
    d.body.append(...[cv, h('p', null, h('b', null, t(TYPE_KEY[it.type] as 'weVideo'))),
      it.tags.length ? h('div', { class: 'we-tags' }, ...it.tags.map((x) => h('span', { dir: 'auto' }, x))) : null,
      it.type !== 'video' ? h('p', { class: 'hint' }, t('weLaterHint')) : null,
      it.refused.length ? h('p', { class: 'hint we-refused' }, t('weRefused', { what: it.refused.join(', ') })) : null].filter((x): x is NonNullable<typeof x> => !!x));
    d.actions.classList.add('mix-actions');
    const use = async (p: string | null, max: number): Promise<void> => {
      try {
        toast(t('weCopying', { name: it.title }), 'info', 60_000);
        const bytes = await readInside(b!, it, p, max);
        if (await addAndUse(new Blob([bytes as BlobPart]), cleanName(it.title) || 'Wallpaper', 'we', rerender)) { d.close(); sh.close(); }
      } catch (e) { toast(e instanceof WeError && e.fault === 'tooLarge' ? faultText('tooLarge') : faultText(e instanceof WeError ? e.fault : 'decode'), 'error', 7000); }
    };
    d.actions.append(h('button', { type: 'button', class: 'btn', onclick: () => d.close() }, t('close')),
      it.type === 'video' && it.file ? h('button', { type: 'button', class: 'btn primary', 'data-we-use': 'video', onclick: () => void use(it.file, VID_MAX_IN) }, icon('check'), t('weUseVideo'))
        : h('button', { type: 'button', class: 'btn primary', 'data-we-use': 'picture', disabled: !it.preview, onclick: () => void use(it.preview, PIC_MAX_IN) }, icon('images'), t('weUsePicture')));
  }
  void scan(null);
}
export type { WeBridge };
