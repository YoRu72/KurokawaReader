// «Mix your own» (Settings → Appearance, a computer's scenes): a sheet with a live preview where the reader builds a
// background from a ground, a base scene and up to two overlays (theme/sceneMix.ts composes them), each overlay with
// its amount and size, one wind for all; saved as a named preset (settings.animBgMixes, cleaned on every read), renamed
// and deleted from the picker. Loaded on first use only.
import { h, icon, toast, openSheet, pickButton } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { SCENES_ALL } from '../theme/sceneList';
import { GROUNDS, OVERLAY_KINDS, RANGE, MAX_SAVED, MAX_OVERLAYS, MIX_BUDGET, PRESETS, cleanMix, cleanName, savedMixes, newMixId, setDraft, mixById, type Mix, type OverlayKind, type GroundId } from '../theme/sceneMix';
import { composeMix } from '../theme/sceneHost';

const GROUND_KEY: Record<GroundId, string> = { scene: 'mixGroundScene', frost: 'mixGroundFrost', night: 'mixGroundNight', dusk: 'mixGroundDusk', teal: 'mixGroundTeal', ink: 'mixGroundInk' };
const KIND_KEY: Record<OverlayKind, string> = { snow: 'mixKSnow', flakes: 'mixKFlakes', rain: 'mixKRain', mist: 'mixKMist', frost: 'mixKFrost', petals: 'mixKPetals', motes: 'mixKMotes', stars: 'mixKStars', bubbles: 'mixKBubbles' };
const tk = (k: string): string => t(k as 'mixNew');
/** What a new mix starts from: the chosen mix when there is one, else snowflakes on a cold ground with a little snow. */
function startFrom(): Mix {
  const pref = getSettings().animBg ?? ''; const cur = pref.startsWith('scene:mix:') ? mixById(pref.slice(10)) : null;
  if (cur) return { ...cur, overlays: cur.overlays.map((o) => ({ ...o })), name: '' };
  const base = pref.startsWith('scene:') && SCENES_ALL.some((s) => s.id === pref.slice(6)) ? pref.slice(6) : 'snowflakes';
  return { id: 'draft', name: '', ground: 'scene', base, overlays: [{ kind: 'snow', amount: 0.5, size: 1 }], wind: 0 };
}

/** An own slider (a styled range, never a number spinner): its label, its value in words, the track filled to it. */
function slider(label: string, [lo, hi]: readonly [number, number], step: number, value: number, say: (v: number) => string, set: (v: number) => void, key: string): HTMLElement {
  const out = h('output', { class: 'mix-val' }, say(value));
  const input = h('input', { type: 'range', min: String(lo), max: String(hi), step: String(step), value: String(value), 'aria-label': label, 'data-mix': key }) as HTMLInputElement;
  const fill = (): void => { input.style.setProperty('--p', `${((Number(input.value) - lo) / (hi - lo)) * 100}%`); }; fill();
  input.addEventListener('input', () => { const v = Number(input.value); out.textContent = say(v); fill(); set(v); });
  return h('div', { class: 'mix-slider' }, h('div', { class: 'mix-slider-head' }, h('span', null, label), out), input);
}
const pct = (v: number): string => `${localDigits(Math.round(v * 100))}%`;

/** The mixer sheet; `edit`: a saved mix opened to be changed (Save changes, or Save as a new preset). */
export function openMixer(rerender: () => void, edit?: Mix): void {
  const work: Mix = edit ? { ...edit, overlays: edit.overlays.map((o) => ({ ...o })) } : startFrom();
  let stop: (() => void) | null = null; let timer = 0; let gone = false;
  const sh = openSheet(edit ? t('mixEditTitle', { name: edit.name }) : t('mixTitle'), t('close'), { onClose: () => { gone = true; clearTimeout(timer); timer = 0; stop?.(); stop = null; setDraft(null); } });
  sh.el.classList.add('mix-sheet');
  // (The art as it will be drawn — no scrim: the page's own panels and halos keep the text readable over it.)
  const box = h('div', { class: 'abg-preview mix-preview', role: 'img', 'aria-label': t('animBgPreview') });
  const budget = h('small', { class: 'src mix-budget', 'aria-live': 'polite' });
  const controls = h('div', { class: 'mix-controls' });
  // (The preview: the draft composed and shown by the same engine as the background; made again a moment after a change.)
  const show = (): void => {
    if (gone) return; setDraft(work);
    const c = composeMix(work); budget.textContent = t('mixParticles', { n: localDigits(c.total), max: localDigits(MIX_BUDGET) });
    clearTimeout(timer); timer = window.setTimeout(() => { timer = 0; if (gone) return; void import('../theme/animbg').then((m) => { if (gone) return; stop?.(); stop = m.previewAnimBg(box, 'scene:mix:~draft', { art: true }); }); }, stop ? 220 : 0);
  };
  const scenes: [string, string][] = [['none', t('mixBaseNone')], ...SCENES_ALL.map((s): [string, string] => [s.id, tk(s.name)])];
  const build = (): void => {
    controls.replaceChildren();
    const row = (label: string, control: Node) => h('div', { class: 'mix-row' }, h('span', { class: 'mix-label' }, label), control);
    const grounds = GROUNDS.filter((g) => g !== 'scene' || work.base !== 'none').map((g): [GroundId, string] => [g, tk(GROUND_KEY[g])]);
    if (work.base === 'none' && work.ground === 'scene') work.ground = 'frost';
    controls.append(
      row(t('mixBase'), pickButton(t('mixBase'), scenes, work.base, (v) => { work.base = v; build(); show(); }, t('close'))),
      row(t('mixGround'), pickButton(t('mixGround'), grounds, work.ground, (v) => { work.ground = v; show(); }, t('close'))));
    for (let i = 0; i < MAX_OVERLAYS; i++) {
      const o = work.overlays[i];
      const kinds: [string, string][] = [['none', t('mixOverlayNone')], ...OVERLAY_KINDS.map((k): [string, string] => [k, tk(KIND_KEY[k])])];
      const label = t(i ? 'mixOverlay2' : 'mixOverlay1');
      const group = h('div', { class: 'mix-overlay' + (o ? ' on' : '') }, row(label, pickButton(label, kinds, o?.kind ?? 'none', (v) => {
        if (v === 'none') work.overlays.splice(i, 1); else if (work.overlays[i]) work.overlays[i].kind = v as OverlayKind; else work.overlays.push({ kind: v as OverlayKind, amount: 0.5, size: 1 });
        build(); show();
      }, t('close'))));
      if (o) group.append(h('div', { class: 'mix-pair' },
        slider(t('mixAmount'), RANGE.amount, 0.05, o.amount, pct, (v) => { o.amount = v; show(); }, `amount${i}`),
        slider(t('mixSize'), RANGE.size, 0.05, o.size, (v) => `×${localDigits(v.toFixed(2).replace(/0$/, ''))}`, (v) => { o.size = v; show(); }, `size${i}`)));
      controls.append(group);
      if (!o) break; // (the second only once the first is chosen)
    }
    const windSay = (v: number): string => (Math.abs(v) < 0.025 ? t('mixWindCalm') : t(v < 0 ? 'mixWindLeft' : 'mixWindRight', { n: localDigits(Math.round(Math.abs(v) * 100)) }));
    controls.append(h('div', { class: 'mix-wind' }, slider(t('mixWind'), RANGE.wind, 0.05, work.wind, windSay, (v) => { work.wind = Math.abs(v) < 0.025 ? 0 : v; show(); }, 'wind')));
  };
  const nameIn = h('input', { type: 'text', dir: 'auto', maxlength: '40', placeholder: t('mixNamePh'), value: edit?.name ?? '', 'aria-label': t('mixName'), 'data-mix': 'name' }) as HTMLInputElement;
  build();
  sh.body.append(box, budget, controls, h('label', { class: 'field mix-name' }, h('span', { class: 'label' }, t('mixName')), nameIn), h('p', { class: 'hint' }, t('mixBudgetHint')));
  const save = (asNew: boolean): void => {
    const list = savedMixes();
    if (asNew && list.length >= MAX_SAVED) { toast(t('mixFull', { n: localDigits(MAX_SAVED) }), 'error'); return; }
    const name = cleanName(nameIn.value) || t('mixDefaultName', { n: localDigits(list.length + 1) });
    const id = asNew || !edit ? newMixId([...list.map((x) => x.id), ...PRESETS.map((p) => p.id)]) : edit.id;
    const m = cleanMix({ ...work, id, name }); if (!m) return;
    const next = !asNew && edit ? list.map((x) => (x.id === id ? m : x)) : [...list, m];
    updateSettings({ animBgMixes: next, animBg: `scene:mix:${id}` });
    toast(t('mixSaved', { name })); sh.close(); rerender();
  };
  sh.actions.classList.add('mix-actions');
  sh.actions.append(
    h('button', { type: 'button', class: 'btn', onclick: () => sh.close() }, t('mixCancel')),
    ...(edit ? [h('button', { type: 'button', class: 'btn tonal', 'data-mix-act': 'update', onclick: () => save(false) }, icon('check'), t('mixUpdate'))] : []),
    h('button', { type: 'button', class: 'btn primary', 'data-mix-act': 'save', onclick: () => save(true) }, icon('bookmarkAdd'), t('mixSave')));
  show();
}

/** A saved mix renamed (a small sheet with its name). */
export function renameMix(id: string, rerender: () => void): void {
  const list = savedMixes(); const m = list.find((x) => x.id === id); if (!m) return;
  const sh = openSheet(t('mixRenameTitle'), t('close'));
  const input = h('input', { type: 'text', dir: 'auto', maxlength: '40', value: m.name, 'aria-label': t('mixName'), 'data-mix': 'rename' }) as HTMLInputElement;
  const go = (): void => { const name = cleanName(input.value); if (!name) { input.focus(); return; } updateSettings({ animBgMixes: savedMixes().map((x) => (x.id === id ? { ...x, name } : x)) }); sh.close(); rerender(); };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  sh.body.append(h('label', { class: 'field' }, h('span', { class: 'label' }, t('mixName')), input));
  sh.actions.classList.add('mix-actions');
  sh.actions.append(h('button', { type: 'button', class: 'btn', onclick: () => sh.close() }, t('mixCancel')), h('button', { type: 'button', class: 'btn primary', 'data-mix-act': 'rename', onclick: go }, icon('check'), t('mixRename')));
  queueMicrotask(() => { input.focus(); input.select(); });
}

/** A saved mix deleted — at once, with Undo; the background, when it was this mix, goes back to its base scene. */
export function deleteMix(id: string, rerender: () => void): void {
  const s = getSettings(); const list = savedMixes(); const m = list.find((x) => x.id === id); if (!m) return;
  const before = { animBgMixes: s.animBgMixes, animBg: s.animBg };
  const using = s.animBg === `scene:mix:${id}`;
  updateSettings({ animBgMixes: list.filter((x) => x.id !== id), ...(using ? { animBg: `scene:${m.base !== 'none' ? m.base : 'snowflakes'}` as const } : {}) });
  rerender();
  toast(t('mixDeleted', { name: m.name }), 'info', 6000, { label: t('undo'), run: () => { updateSettings(before); rerender(); } });
}
