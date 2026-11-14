// Translate on screen (the add-on, Android): a floating bubble over every app that translates what the screen
// shows — its text read exactly (accessibility), or a picture of it read by OCR for games, comics and videos —
// with Google Translate, DeepL or an AI model set up as in the Reader. This page sets it up: what Android must
// allow, the translator, how the screen is read, auto translation, how the translations look, the bubble and
// what its taps do, reading aloud, and the history of what was translated.
import { h, icon, iconButton, toast } from '../ui/dom';
import { t, getLang } from '../i18n';
import { back } from '../router';
import { ktPlugin, nativePlatform } from '../native';
import { parseTerms } from '../screen/lettering';
import { AI_PRESETS, PC_KEYS, SCREEN_LANGS, TEXT_KINDS, engineReady, loadScreen, nativeConfig, saveScreen, type Action, type GlossaryEntry, type PcKey, type ScreenConfig, type TextKind } from '../screen/config';

/** An Electron accelerator from a key press (a modifier and a key): «Alt+Shift+T», «CommandOrControl+F9». */
export function accelerator(e: { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return '';
  const k = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.key) ? e.key : ({ Space: 'Space', Enter: 'Enter', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', PrintScreen: 'PrintScreen' } as Record<string, string>)[e.code] ?? '';
  if (!k) return '';
  const mods = [e.ctrlKey ? 'Control' : '', e.metaKey ? 'Super' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean);
  if (!mods.length && !/^F\d{1,2}$/.test(k) && k !== 'PrintScreen') return '';
  return [...mods, k].join('+');
}

type Status = { sdk?: number; overlay: boolean; a11y: boolean; a11yLive?: boolean; a11yBuild?: boolean; running: boolean; capture: boolean; notify: boolean; battery: boolean; tile: boolean };
type Plug = {
  screenStatus?(): Promise<Status>; screenPermission?(o: { what: string }): Promise<void>; screenConfig?(o: { config: Record<string, unknown>; clearFixed?: boolean }): Promise<void>;
  screenStart?(): Promise<void>; screenStop?(): Promise<void>; screenTranslate?(o: { texts: string[]; config?: Record<string, unknown> }): Promise<{ texts: string[] }>;
  screenHistory?(o: { clear?: boolean }): Promise<{ items: { o: string; t: string; at: number }[] }>;
  screenShortcut?(o: { show?: boolean; pin?: boolean }): Promise<{ shown: boolean; pinned: boolean }>;
};
const plug = (): Plug | null => ktPlugin() as unknown as Plug | null;
const A11Y_RELEASES = 'https://github.com/YoRu72/KurokawaReader/releases/latest';

type PcStatus = { platform: string; on: boolean; keys: Record<string, { acc: string; ok: boolean }>; tray: boolean; auto: boolean; region: unknown; ocr: 'windows' | 'vision' | 'tesseract' | 'ai' | 'none';
  /** The Tauri shell's own: how the screen is taken here (and why it cannot be); a Mac's Screen Recording permission. */
  capture?: { kind: string; why?: string }; permission?: 'granted' | 'denied' };
type Desk = { screenConfig(o: { config: Record<string, unknown>; clearFixed?: boolean }): Promise<PcStatus>; screenStatus(): Promise<PcStatus>; screenAction(a: string): Promise<void>; screenOcrLangs(): Promise<{ kind: string; langs?: string[]; error?: string }> };
const desk = (): Desk | null => { const d = (window as unknown as { kurokawaTools?: Partial<Desk> }).kurokawaTools; return d?.screenStatus ? d as Desk : null; };
/** Whether the add-on can run here: the floating bubble on Android; shortcuts and the tray on a computer. */
export const screenHere = (): boolean => nativePlatform() === 'android' || !!desk();

export function screenView(): HTMLElement & { dispose?: () => void } {
  let cfg = loadScreen();
  const body = h('div', { class: 'body screen-body' });
  const root = h('div', { class: 'view settings-view screen-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/settings/addons')), h('div', { class: 'title' }, h('span', null, t('scrTitle')))), body) as HTMLElement & { dispose?: () => void };
  if (!screenHere()) { body.append(h('section', { class: 'card' }, h('p', null, t('scrAndroidOnly')))); return root; }
  const PC = nativePlatform() !== 'android' && !!desk();
  const sendCfg = (extra: { clearFixed?: boolean } = {}) => (PC ? desk()!.screenConfig({ config: nativeConfig(cfg), ...extra }).then(() => { void refresh(); }) : plug()?.screenConfig?.({ config: nativeConfig(cfg), ...extra }));
  const push = (() => { let tm = 0; return (extra: { clearFixed?: boolean } = {}) => { saveScreen(cfg); clearTimeout(tm); tm = window.setTimeout(() => void sendCfg(extra)?.catch(() => undefined), 250); }; })();
  const set = (f: (c: ScreenConfig) => void, redraw = false) => { f(cfg); push(); if (redraw) draw(); };

  // ---- the big button and the state ----
  const go = h('button', { type: 'button', class: 'btn filled screen-go' });
  const state = h('p', { class: 'hint screen-state' });
  const hero = h('section', { class: 'card screen-hero' }, h('div', { class: 'screen-hero-ic' }, icon('translate')), h('p', null, t('scrIntro')), go, state);
  // ---- what Android must allow ----
  const steps = h('div', { class: 'screen-steps' });
  const setup = h('section', { class: 'card', id: 'scr-setup' }, h('h3', null, t('scrSetup')), steps);
  let st: Status | null = null;
  const step = (ok: boolean, title: string, hint: string, what: string, need = false) => h('div', { class: 'screen-step' + (ok ? ' done' : need ? ' need' : ''), 'data-step': what },
    h('span', { class: 'screen-step-ic' }, icon(ok ? 'check' : need ? 'alert' : 'info')), h('span', { class: 'grow' }, h('b', null, title), h('small', { class: 'src' }, hint)),
    ok ? null : h('button', { type: 'button', class: 'btn tonal small', onclick: () => void plug()?.screenPermission?.({ what }) }, t('scrAllow')));
  async function refresh(): Promise<void> {
    if (PC) { await refreshPc(); return; }
    const s = await plug()?.screenStatus?.().catch(() => null) ?? null; st = s;
    if (!s) { state.textContent = t('scrNoNative'); go.setAttribute('disabled', ''); return; }
    go.removeAttribute('disabled');
    go.replaceChildren(icon(s.running ? 'close' : 'play'), s.running ? t('scrStop') : t('scrStart')); go.classList.toggle('danger', s.running);
    state.textContent = !s.overlay ? t('scrNeedOverlay') : s.running ? t('scrRunning') : !engineReady(cfg) ? t('scrNeedEngine') : t('scrReady');
    steps.replaceChildren(
      step(s.overlay, t('scrStepOverlay'), t('scrStepOverlayHint'), 'overlay', true),
      // (The ordinary build has no accessibility service — Play Protect blocks the install of an app from a file that
      // declares one — so it reads the screen as a picture; the «-a11y» build, offered here, reads the text.)
      ...(s.a11yBuild === false ? [h('div', { class: 'screen-step', 'data-step': 'a11yBuild' }, h('span', { class: 'screen-step-ic' }, icon('info')), h('span', { class: 'grow' }, h('b', null, t('scrNoA11yBuild')), h('small', { class: 'src' }, t('scrNoA11yBuildHint'))), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void import('../native').then((n) => n.openExternal(A11Y_RELEASES)) }, t('scrGetA11yBuild')))]
        : [step(s.a11y, t('scrStepA11y'), t('scrStepA11yHint'), 'a11y', cfg.read === 'text')]),
      // (Android 13+: an app installed from a file has its accessibility switch «restricted» until it is allowed
      // in the app's info page — ⋮ → Allow restricted settings.)
      ...(!s.a11y && s.a11yBuild !== false && (s.sdk ?? 0) >= 33 ? [h('div', { class: 'screen-step', 'data-step': 'restricted' }, h('span', { class: 'screen-step-ic' }, icon('lock')), h('span', { class: 'grow' }, h('b', null, t('scrRestricted')), h('small', { class: 'src' }, t('scrRestrictedHint'))), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void plug()?.screenPermission?.({ what: 'app' }) }, t('scrAppInfo')))] : []),
      step(s.notify, t('scrStepNotify'), t('scrStepNotifyHint'), 'app'),
      step(s.battery, t('scrStepBattery'), t('scrStepBatteryHint'), 'battery'),
      ...(s.tile ? [h('div', { class: 'screen-step', 'data-step': 'tile' }, h('span', { class: 'screen-step-ic' }, icon('grid')), h('span', { class: 'grow' }, h('b', null, t('scrStepTile')), h('small', { class: 'src' }, t('scrStepTileHint'))), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void plug()?.screenPermission?.({ what: 'tile' }) }, t('scrAddTile')))] : []));
    // (Translate screen as an app of its own: the app drawer, the phone's sidebar, the home screen.)
    const sc = await plug()?.screenShortcut?.({}).catch(() => null);
    if (sc) steps.append(h('div', { class: 'screen-step' + (sc.shown ? ' done' : ''), 'data-step': 'shortcut' }, h('span', { class: 'screen-step-ic' }, icon(sc.shown ? 'check' : 'apps')), h('span', { class: 'grow' }, h('b', null, t('scrStepApp')), h('small', { class: 'src' }, t('scrStepAppHint'))),
      h('span', { class: 'row-actions wrap' },
        h('button', { type: 'button', class: 'btn tonal small', 'data-act': 'show', onclick: async () => { await plug()?.screenShortcut?.({ show: !sc.shown }); toast(sc.shown ? t('scrAppHidden') : t('scrAppShown')); void refresh(); } }, sc.shown ? t('scrAppHide') : t('scrAppShow')),
        h('button', { type: 'button', class: 'btn tonal small', 'data-act': 'pin', onclick: async () => { const r = await plug()?.screenShortcut?.({ pin: true }); if (r && !r.pinned) toast(t('scrPinNo'), 'error', 4000); void refresh(); } }, t('scrPin')))));
  }
  go.addEventListener('click', async () => {
    if (PC) { set((c) => { c.pcOn = !c.pcOn; }, true); return; }
    if (!st) return;
    if (st.running) { await plug()?.screenStop?.().catch(() => undefined); }
    else {
      if (!st.overlay) { toast(t('scrNeedOverlay'), 'error', 4000); await plug()?.screenPermission?.({ what: 'overlay' }); return; }
      if (!engineReady(cfg)) { toast(t('scrNeedEngine'), 'error', 4000); document.getElementById('scr-engine')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      saveScreen(cfg); await plug()?.screenConfig?.({ config: nativeConfig(cfg) }).catch(() => undefined);
      await plug()?.screenStart?.().catch((e) => toast(String((e as Error).message ?? e), 'error'));
    }
    setTimeout(() => void refresh(), 500);
  });

  // ---- controls ----
  const row = (label: string, control: Node, hint?: string) => h('div', { class: 'row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), control);
  const toggle = (label: string, on: boolean, f: (v: boolean) => void, hint?: string) => h('label', { class: 'row switch-row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => f((e.target as HTMLInputElement).checked) }));
  const select = <T extends string>(value: T, opts: [T, string][], f: (v: T) => void, name?: string) => h('select', { class: 'select', name: name ?? '', onchange: (e: Event) => f((e.target as HTMLSelectElement).value as T) }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  const num = (value: number, min: number, max: number, stepN: number, f: (v: number) => void, name: string, unit = '') => { const out = h('output', null, `${value}${unit}`); const r = h('input', { type: 'range', min, max, step: stepN, value, name, oninput: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); out.textContent = `${v}${unit}`; f(v); } }); return h('span', { class: 'screen-range' }, r, out); };
  const text = (value: string, f: (v: string) => void, opts: { type?: string; placeholder?: string; name: string }) => h('input', { class: 'input', type: opts.type ?? 'text', value, placeholder: opts.placeholder ?? '', name: opts.name, autocomplete: 'off', spellcheck: false, dir: 'auto', oninput: (e: Event) => f((e.target as HTMLInputElement).value) });
  const colour = (value: string, f: (v: string) => void, name: string) => h('input', { type: 'color', value, name, class: 'screen-colour', oninput: (e: Event) => f((e.target as HTMLInputElement).value) });
  const segs = <T extends string>(value: T, opts: [T, string][], f: (v: T) => void, name: string) => h('div', { class: 'segmented', role: 'radiogroup', 'data-name': name }, ...opts.map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), 'aria-pressed': String(v === value), class: v === value ? 'on' : '', 'data-v': v, onclick: () => f(v) }, l)));

  // ---- on a computer: on or off, the shortcuts, working in the background ----
  async function refreshPc(): Promise<void> {
    const s = await desk()!.screenStatus().catch(() => null); if (!s) return;
    go.replaceChildren(icon(s.on ? 'close' : 'play'), s.on ? t('scrPcOff') : t('scrPcOn')); go.classList.toggle('danger', s.on);
    state.textContent = !s.on ? t('scrPcIntroOff') : !engineReady(cfg) ? t('scrNeedEngine') : t('scrPcRunning', { key: s.keys.region?.acc ?? '' });
    const kind = { windows: t('scrOcrWindows'), vision: t('scrOcrVision'), tesseract: 'Tesseract', ai: t('scrEngineAi'), none: t('scrOcrNone') }[s.ocr] ?? s.ocr;
    steps.replaceChildren(
      h('div', { class: 'screen-step' + (s.ocr === 'none' ? ' need' : ' done'), 'data-step': 'ocr' }, h('span', { class: 'screen-step-ic' }, icon(s.ocr === 'none' ? 'alert' : 'check')), h('span', { class: 'grow' }, h('b', null, t('scrOcrIs', { kind })), h('small', { class: 'src' }, s.ocr === 'none' ? t('scrOcrNoneHint') : s.ocr === 'windows' ? t('scrOcrWindowsHint') : s.ocr === 'tesseract' ? t('scrOcrTessHint') : s.ocr === 'ai' ? t('scrOcrAiHint') : t('scrOcrVisionHint')))),
      // (The Tauri shell: the screen cannot be taken here, or each picture goes through the desktop portal; a Mac's
      // Screen Recording permission not given — its button shows the system's request once, then its settings.)
      ...(s.capture?.kind === 'none' ? [h('div', { class: 'screen-step need', 'data-step': 'capture' }, h('span', { class: 'screen-step-ic' }, icon('alert')), h('span', { class: 'grow' }, h('b', null, t('scrCapNone')), h('small', { class: 'src', dir: 'auto' }, s.capture.why ?? '')))] : []),
      ...(s.capture?.kind === 'portal' ? [h('div', { class: 'screen-step', 'data-step': 'capture' }, h('span', { class: 'screen-step-ic' }, icon('info')), h('span', { class: 'grow' }, h('b', null, t('scrCapPortal')), h('small', { class: 'src' }, t('scrCapPortalHint'))))] : []),
      ...(s.permission === 'denied' ? [h('div', { class: 'screen-step need', 'data-step': 'perm' }, h('span', { class: 'screen-step-ic' }, icon('lock')), h('span', { class: 'grow' }, h('b', null, t('scrPermNeed')), h('small', { class: 'src' }, t('scrPermHint'))), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void desk()?.screenAction('permission') }, t('scrPermOpen')))] : []),
      ...Object.entries(s.keys).filter(([, v]) => v.acc && s.on && !v.ok).map(([k, v]) => h('div', { class: 'screen-step need', 'data-step': 'key-' + k }, h('span', { class: 'screen-step-ic' }, icon('alert')), h('span', { class: 'grow' }, h('b', null, t('scrKeyTaken', { key: v.acc })), h('small', { class: 'src' }, t('scrKeyTakenHint'))))));
  }
  const engineCard = h('section', { class: 'card', id: 'scr-engine' }); const readCard = h('section', { class: 'card', id: 'scr-read' }); const autoCard = h('section', { class: 'card', id: 'scr-auto' });
  const lookCard = h('section', { class: 'card', id: 'scr-look' }); const bubbleCard = h('section', { class: 'card', id: 'scr-bubble' }); const histCard = h('section', { class: 'card', id: 'scr-history' });
  const keysCard = h('section', { class: 'card', id: 'scr-keys' }); const bgCard = h('section', { class: 'card', id: 'scr-bg' });
  const letterCard = h('section', { class: 'card', id: 'scr-letter' }); const glossCard = h('section', { class: 'card', id: 'scr-glossary' });
  if (PC) { hero.querySelector('p')!.textContent = t('scrPcIntro'); setup.querySelector('h3')!.textContent = t('scrPcState'); body.append(hero, setup, keysCard, bgCard, engineCard, readCard, autoCard, lookCard, letterCard, glossCard); }
  else body.append(hero, setup, engineCard, readCard, autoCard, lookCard, letterCard, glossCard, bubbleCard, histCard);

  // Lettering: the reader's own fonts, one for each kind of text (Ascent's lettering font, taken further).
  const KIND_LABEL = (): Record<'default' | TextKind, string> => ({ default: t('scrKindDefault'), dialogue: t('scrKindDialogue'), thought: t('scrKindThought'), box: t('scrKindBox'), sfx: t('scrKindSfx'), sign: t('scrKindSign') });
  // (No type filter on a phone: Android's picker knows no type for fonts and would grey them out.)
  const fontIn = h('input', { type: 'file', ...(nativePlatform() === 'android' ? {} : { accept: '.ttf,.otf,.ttc' }), hidden: true, onchange: () => void addFont() }) as HTMLInputElement;
  async function addFont(): Promise<void> {
    const f = fontIn.files?.[0]; fontIn.value = ''; if (!f) return;
    if (cfg.letter.lib.length >= 16) { toast(t('scrFontsFull'), 'error'); return; }
    if (/\.woff2?$/i.test(f.name)) { toast(t('scrFontWoff'), 'error', 5000); return; }
    if (!/\.(ttf|otf|ttc)$/i.test(f.name)) { toast(t('scrFontNotFont'), 'error', 5000); return; }
    const b = new Uint8Array(await f.arrayBuffer()); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
    try {
      const kp = ktPlugin() as unknown as { screenFontAdd?(o: { name: string; b64: string }): Promise<{ path: string }> } | null; const dp = window.kurokawaTools as unknown as { screenFontAdd?(o: { name: string; b64: string }): Promise<{ path: string }> } | undefined;
      const r = kp?.screenFontAdd ? await kp.screenFontAdd({ name: f.name, b64: btoa(bin) }) : await dp!.screenFontAdd!({ name: f.name, b64: btoa(bin) });
      set((c) => { c.letter.lib.push({ id: `f${Date.now().toString(36)}`, name: f.name.replace(/\.[^.]+$/, ''), path: r.path }); }, true);
    } catch (e) { toast(/font|size/.test(String((e as Error).message)) ? t('scrFontNotFont') : String((e as Error).message ?? e), 'error', 5000); }
  }
  function drawLetter(): void {
    const L = cfg.letter; const labels = KIND_LABEL(); const fonts: [string, string][] = [['', t('scrFontSystem')], ...L.lib.map((f) => [f.id, f.name] as [string, string])];
    const sample = async (el: HTMLElement, id: string) => { const lib = L.lib.find((x) => x.id === id); if (!lib) { el.style.fontFamily = ''; return; } const { fontFamily } = await import('../screen/lettering'); const fam = await fontFamily(lib.path); if (fam) el.style.fontFamily = `"${fam}"`; };
    const kindRow = (k: 'default' | TextKind) => { const prev = h('span', { class: 'scr-font-sample', dir: 'auto' }, t(k === 'sfx' ? 'scrSampleSfx' : k === 'thought' ? 'scrSampleThought' : 'scrSampleDialogue')); void sample(prev, L.fonts[k]); return row(labels[k], h('span', { class: 'scr-font-pick' }, prev, select(L.fonts[k], fonts, (v) => set((c) => { c.letter.fonts[k] = v; }, true), `font-${k}`))); };
    letterCard.replaceChildren(h('h3', null, t('scrLetter')), h('p', { class: 'hint' }, t('scrLetterHint')), fontIn,
      h('div', { class: 'dest-list scr-fonts' }, ...L.lib.map((f) => h('div', { class: 'dest-row' }, icon('text'), h('span', { class: 'name grow', dir: 'auto' }, f.name), iconButton('trash', t('scrRemove'), () => { const kp = ktPlugin() as unknown as { screenFontRemove?(o: { path: string }): Promise<void> } | null; const dp = window.kurokawaTools as unknown as { screenFontRemove?(o: { path: string }): Promise<void> } | undefined; void (kp?.screenFontRemove ?? dp?.screenFontRemove)?.({ path: f.path }); set((c) => { c.letter.lib = c.letter.lib.filter((x) => x.id !== f.id); for (const k of Object.keys(c.letter.fonts) as ('default' | TextKind)[]) if (c.letter.fonts[k] === f.id) c.letter.fonts[k] = ''; }, true); })))),
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => fontIn.click() }, icon('plus'), t('scrFontAdd')),
      kindRow('default'),
      toggle(t('scrKinds'), L.kinds, (v) => set((c) => { c.letter.kinds = v; }, true), t('scrKindsHint')),
      ...(L.kinds ? TEXT_KINDS.map((k) => kindRow(k)) : []));
  }
  // The glossary: terms always translated the reader's way, each for one language or any, some with a kind.
  function drawGlossary(): void {
    const G = cfg.glossary; const labels = KIND_LABEL();
    const kinds: [string, string][] = [['', t('scrKindAuto')], ...TEXT_KINDS.map((k) => [k, labels[k]] as [string, string])];
    const langs: [string, string][] = [['', t('scrAnyLang')], ...SCREEN_LANGS.filter(([c]) => c !== 'auto')];
    const rowOf = (e: GlossaryEntry, i: number) => h('div', { class: 'scr-term' },
      h('input', { class: 'input', type: 'text', value: e.from, placeholder: t('scrTermFrom'), dir: 'auto', 'aria-label': t('scrTermFrom'), onchange: (ev: Event) => set((c) => { c.glossary.entries[i].from = (ev.target as HTMLInputElement).value; }) }),
      h('span', { class: 'scr-term-arrow' }, '→'),
      h('input', { class: 'input', type: 'text', value: e.to, placeholder: t('scrTermTo'), dir: 'auto', 'aria-label': t('scrTermTo'), onchange: (ev: Event) => set((c) => { c.glossary.entries[i].to = (ev.target as HTMLInputElement).value; }) }),
      select(e.kind ?? '', kinds, (v) => set((c) => { c.glossary.entries[i].kind = v as TextKind | ''; }), `gk-${i}`),
      select(e.lang ?? '', langs, (v) => set((c) => { c.glossary.entries[i].lang = v; }), `gl-${i}`),
      iconButton('trash', t('scrRemove'), () => set((c) => { c.glossary.entries.splice(i, 1); }, true)));
    const bulk = h('textarea', { class: 'input', rows: 4, dir: 'auto', placeholder: t('scrGlossaryBulkHint') }) as HTMLTextAreaElement;
    glossCard.replaceChildren(h('h3', null, t('scrGlossary')), h('p', { class: 'hint' }, t('scrGlossaryHint')),
      toggle(t('scrGlossaryOn'), G.on, (v) => set((c) => { c.glossary.on = v; }, true)),
      h('div', { class: 'scr-terms' }, ...G.entries.map(rowOf)),
      h('div', { class: 'chip-row wrap' },
        h('button', { type: 'button', class: 'btn tonal small', onclick: () => set((c) => { c.glossary.entries.push({ from: '', to: '', kind: '', lang: c.target }); }, true) }, icon('plus'), t('scrTermAdd')),
        h('button', { type: 'button', class: 'btn text small', onclick: () => { void navigator.clipboard?.writeText(G.entries.map((e) => `${e.from} = ${e.to}${e.kind ? ` [${e.kind}]` : ''}`).join('\n')).then(() => toast(t('copied'))).catch(() => undefined); } }, icon('copy'), t('scrGlossaryCopy'))),
      h('details', { class: 'scr-bulk' }, h('summary', null, t('scrGlossaryBulk')), bulk,
        h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const add = parseTerms(bulk.value, cfg.target); if (!add.length) { toast(t('scrGlossaryNone'), 'error'); return; } set((c) => { c.glossary.entries.push(...add); }, true); toast(t('scrGlossaryAdded', { n: String(add.length) })); } }, icon('plus'), t('scrGlossaryAddAll'))));
  }
  function draw(): void {
    const langs: [string, string][] = SCREEN_LANGS;
    // The translator
    const tryIn = text(t('scrTrySample'), () => undefined, { name: 'try' }); const tryOut = h('p', { class: 'screen-try-out', dir: 'auto' });
    const tryBtn = h('button', { type: 'button', class: 'btn tonal small', onclick: async () => {
      tryOut.textContent = '…';
      try { const r = await plug()?.screenTranslate?.({ texts: [(tryIn as HTMLInputElement).value], config: nativeConfig(cfg) }); tryOut.textContent = r?.texts?.[0] ?? ''; tryOut.classList.remove('bad'); }
      catch (e) { tryOut.textContent = /deeplKey/.test(String((e as Error).message)) ? t('scrNeedEngine') : String((e as Error).message ?? e); tryOut.classList.add('bad'); }
    } }, icon('translate'), t('scrTry'));
    const preset = AI_PRESETS.find((p) => p.id === cfg.ai.preset) ?? AI_PRESETS[0];
    engineCard.replaceChildren(h('h3', null, t('scrEngine')),
      segs(cfg.engine, [['google', 'Google'], ['microsoft', 'Microsoft'], ['deepl', 'DeepL'], ['ai', t('scrEngineAi')]], (v) => set((c) => { c.engine = v; }, true), 'engine'),
      h('p', { class: 'hint' }, cfg.engine === 'google' ? t('scrGoogleHint') : cfg.engine === 'microsoft' ? t('scrMicrosoftHint') : cfg.engine === 'deepl' ? t('scrDeeplHint') : t('scrAiHint')),
      row(t('scrFrom'), select(cfg.source, [['auto', t('scrDetect')], ...langs], (v) => set((c) => { c.source = v; }), 'source'), t('scrFromHint')),
      row(t('scrTo'), select(cfg.target, langs, (v) => set((c) => { c.target = v; }), 'target')),
      ...(cfg.engine === 'deepl' ? [row(t('scrDeeplKey'), text(cfg.deeplKey, (v) => set((c) => { c.deeplKey = v; }), { type: 'password', name: 'deeplKey', placeholder: 'xxxxxxxx-…:fx' }), t('scrDeeplKeyHint'))] : []),
      ...(cfg.engine === 'ai' ? [
        row(t('scrAiProvider'), select(cfg.ai.preset, AI_PRESETS.map((p) => [p.id, p.id === 'custom' ? t('scrAiCustom') : p.label] as [typeof p.id, string]), (v) => set((c) => { c.ai.preset = v; }, true), 'preset')),
        row(t('scrAiKey'), text(cfg.ai.key, (v) => set((c) => { c.ai.key = v; }), { type: 'password', name: 'aiKey' }), preset.keyUrl ? t('scrAiKeyHint', { url: preset.keyUrl }) : undefined),
        row(t('scrAiModel'), text(cfg.ai.model, (v) => set((c) => { c.ai.model = v; }), { name: 'aiModel', placeholder: preset.model || 'model' })),
        ...(cfg.ai.preset === 'custom' ? [
          row(t('scrAiBase'), text(cfg.ai.base, (v) => set((c) => { c.ai.base = v; }), { name: 'aiBase', placeholder: 'http://192.168.1.5:11434/v1' })),
          row(t('scrAiStyle'), select(cfg.ai.style, [['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['gemini', 'Gemini']], (v) => set((c) => { c.ai.style = v; }), 'aiStyle')),
        ] : []),
        h('label', { class: 'screen-prompt' }, h('span', null, t('scrAiPrompt'), h('small', { class: 'src' }, t('scrAiPromptHint'))), h('textarea', { class: 'input', rows: 3, name: 'aiPrompt', dir: 'auto', oninput: (e: Event) => set((c) => { c.ai.prompt = (e.target as HTMLTextAreaElement).value; }) }, cfg.ai.prompt)),
      ] : []),
      h('div', { class: 'screen-try' }, tryIn, tryBtn), tryOut);

    if (PC) {
      const keyIn = (k: PcKey) => { const inp = h('input', { class: 'input screen-key', readonly: true, value: cfg.pc.keys[k] ?? '', name: 'key-' + k, placeholder: t('scrKeyPress'), onkeydown: (e: KeyboardEvent) => { e.preventDefault(); if (e.key === 'Backspace' || e.key === 'Delete') { set((c) => { c.pc.keys[k] = ''; }, true); return; } const acc = accelerator(e); if (acc) set((c) => { c.pc.keys[k] = acc; }, true); } });
        return h('div', { class: 'row' }, h('span', null, t(`scrKey_${k}` as 'scrKey_region')), h('span', { class: 'screen-colours' }, inp, iconButton('refresh', t('scrKeyDefault'), () => set((c) => { c.pc.keys[k] = PC_KEYS[k]; }, true)))); };
      keysCard.replaceChildren(h('h3', null, t('scrKeys')), h('p', { class: 'hint' }, t('scrKeysHint')), ...(Object.keys(PC_KEYS) as PcKey[]).map(keyIn),
        h('div', { class: 'row-actions wrap' }, h('button', { type: 'button', class: 'btn tonal small', onclick: () => void desk()?.screenAction('region') }, icon('target'), t('scrKey_region')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void desk()?.screenAction('clipboard') }, icon('copy'), t('scrKey_clipboard'))));
      bgCard.replaceChildren(h('h3', null, t('scrBg2')),
        toggle(t('scrTray'), cfg.pc.tray, (v) => set((c) => { c.pc.tray = v; }), t('scrTrayHint')),
        toggle(t('scrStartup'), cfg.pc.startup, (v) => set((c) => { c.pc.startup = v; }), t('scrStartupHint')),
        toggle(t('scrCloseBlur'), cfg.pc.closeOnBlur, (v) => set((c) => { c.pc.closeOnBlur = v; }), t('scrCloseBlurHint')));
      readCard.replaceChildren(h('h3', null, t('scrRead')),
        segs(cfg.pc.ocr, [['system', t('scrOcrSystem')], ['ai', t('scrEngineAi')]], (v) => set((c) => { c.pc.ocr = v; }, true), 'ocr'),
        h('p', { class: 'hint' }, cfg.pc.ocr === 'ai' ? t('scrOcrAiHint') : t('scrOcrSystemHint')),
        h('button', { type: 'button', class: 'btn text small', onclick: () => { push({ clearFixed: true }); toast(t('scrFixedCleared')); } }, icon('close'), t('scrPcForget')));
      autoCard.replaceChildren(h('h3', null, t('scrAuto')), h('p', { class: 'hint' }, t('scrPcAutoHint')),
        row(t('scrInterval'), num(cfg.interval, 1, 15, 1, (v) => set((c) => { c.interval = v; }), 'interval', t('scrSec'))),
        row(t('scrAutoStop'), num(cfg.autoStop, 0, 120, 5, (v) => set((c) => { c.autoStop = v; }), 'autoStop', t('scrMin')), t('scrAutoStopHint')));
    }
    // How the screen is read, and what a translation covers
    if (!PC) readCard.replaceChildren(h('h3', null, t('scrRead')),
      segs(cfg.read, ([['auto', t('scrReadAuto')], ...(st?.a11yBuild === false ? [] : [['text', t('scrReadText')]]), ['picture', t('scrReadPicture')]] as [typeof cfg.read, string][]), (v) => set((c) => { c.read = v; }, true), 'read'),
      h('p', { class: 'hint' }, cfg.read === 'text' ? t('scrReadTextHint') : cfg.read === 'picture' ? t('scrReadPictureHint') : t('scrReadAutoHint')),
      row(t('scrMode'), select(cfg.mode, [['full', t('scrModeFull')], ['fixed', t('scrModeFixed')]], (v) => set((c) => { c.mode = v; }), 'mode'), t('scrModeHint')),
      h('button', { type: 'button', class: 'btn text small', onclick: () => { push({ clearFixed: true }); toast(t('scrFixedCleared')); } }, icon('close'), t('scrFixedClear')),
      row(t('scrDisplay'), select(cfg.display, [['overlay', t('scrDisplayOverlay')], ['panel', t('scrDisplayPanel')]], (v) => set((c) => { c.display = v; }), 'display')));

    // Auto
    if (!PC) autoCard.replaceChildren(h('h3', null, t('scrAuto')), h('p', { class: 'hint' }, t('scrAutoHint')),
      segs(cfg.auto, [['scroll', t('scrAutoScroll')], ['interval', t('scrAutoInterval')]], (v) => set((c) => { c.auto = v; }, true), 'auto'),
      cfg.auto === 'interval' ? row(t('scrInterval'), num(cfg.interval, 1, 15, 1, (v) => set((c) => { c.interval = v; }), 'interval', t('scrSec'))) : row(t('scrSettle'), num(cfg.settle, 0.3, 3, 0.1, (v) => set((c) => { c.settle = Math.round(v * 10) / 10; }), 'settle', t('scrSec')), t('scrSettleHint')),
      row(t('scrAutoStop'), num(cfg.autoStop, 0, 120, 5, (v) => set((c) => { c.autoStop = v; }), 'autoStop', t('scrMin')), t('scrAutoStopHint')),
      toggle(t('scrLookAhead'), cfg.lookAhead, (v) => set((c) => { c.lookAhead = v; }), t('scrLookAheadHint')));

    // How the translations look
    const sty = cfg.style;
    lookCard.replaceChildren(h('h3', null, t('scrLook')),
      h('div', { class: 'screen-preview', style: `--bg:${sty.bg};--fg:${sty.fg};--a:${sty.bgAlpha};--r:${sty.radius}px;--s:${sty.size}px` }, h('span', { class: sty.bgMode === 'none' ? 'bare' : '', style: `${sty.bold ? 'font-weight:700;' : ''}${sty.center ? 'text-align:center;' : ''}${sty.outline ? 'text-shadow:0 0 3px #000,0 0 2px #000;' : ''}` }, t('scrPreview'))),
      row(t('scrSize'), num(sty.size, 9, 28, 1, (v) => set((c) => { c.style.size = v; }), 'size')),
      toggle(t('scrSmart'), sty.smart, (v) => set((c) => { c.style.smart = v; }), t('scrSmartHint')),
      row(t('scrBg'), h('span', { class: 'screen-colours' }, colour(sty.bg, (v) => set((c) => { c.style.bg = v; }, true), 'bg'), select(sty.bgMode, [['erase', t('scrBgErase')], ['fill', t('scrBgFill')], ['none', t('scrBgNone')]], (v) => set((c) => { c.style.bgMode = v; }, true), 'bgMode'))),
      row(t('scrOpacity'), num(Math.round(sty.bgAlpha * 100), 30, 100, 5, (v) => set((c) => { c.style.bgAlpha = v / 100; }), 'bgAlpha', '%')),
      row(t('scrFg'), colour(sty.fg, (v) => set((c) => { c.style.fg = v; }, true), 'fg')),
      row(t('scrRadius'), num(sty.radius, 0, 16, 1, (v) => set((c) => { c.style.radius = v; }), 'radius')),
      toggle(t('scrBold'), sty.bold, (v) => set((c) => { c.style.bold = v; }, true)), toggle(t('scrCenter'), sty.center, (v) => set((c) => { c.style.center = v; }, true)), toggle(t('scrOutline'), sty.outline, (v) => set((c) => { c.style.outline = v; }, true), t('scrOutlineHint')),
      row(t('scrHideAfter'), num(cfg.hideAfter, 0, 60, 1, (v) => set((c) => { c.hideAfter = v; }), 'hideAfter', t('scrSec')), t('scrHideAfterHint')),
      ...(PC ? [] : [toggle(t('scrTapClose'), cfg.tapClose, (v) => set((c) => { c.tapClose = v; }), t('scrTapCloseHint'))]),
      ...(PC ? [] : [toggle(t('scrSpeak'), cfg.speak, (v) => set((c) => { c.speak = v; }, true), t('scrSpeakHint')),
      ...(cfg.speak ? [row(t('scrRate'), num(cfg.ttsRate, 0.5, 2, 0.1, (v) => set((c) => { c.ttsRate = Math.round(v * 10) / 10; }), 'ttsRate', '×'))] : [])]));
    drawLetter(); drawGlossary();
    if (PC) return;

    // The bubble and its taps
    const acts: [Action, string][] = [['translate', t('scrActTranslate')], ['region', t('scrActRegion')], ['fixed', t('scrActFixed')], ['auto', t('scrActAuto')], ['panel', t('scrActPanel')], ['menu', t('scrActMenu')], ['clear', t('scrActClear')], ['none', t('scrActNone')]];
    const b = cfg.bubble;
    bubbleCard.replaceChildren(h('h3', null, t('scrBubble')),
      row(t('scrTap'), select(cfg.actions.tap, acts, (v) => set((c) => { c.actions.tap = v; }), 'tap')),
      row(t('scrDouble'), select(cfg.actions.double, acts, (v) => set((c) => { c.actions.double = v; }), 'double'), t('scrDoubleHint')),
      row(t('scrLong'), select(cfg.actions.long, acts, (v) => set((c) => { c.actions.long = v; }), 'long')),
      row(t('scrBubbleSize'), num(b.size, 36, 80, 2, (v) => set((c) => { c.bubble.size = v; }), 'bubbleSize')),
      row(t('scrOpacity'), num(Math.round(b.alpha * 100), 30, 100, 5, (v) => set((c) => { c.bubble.alpha = v / 100; }), 'bubbleAlpha', '%')),
      row(t('scrBubbleColour'), colour(b.color, (v) => set((c) => { c.bubble.color = v; }), 'bubbleColor')),
      toggle(t('scrDim'), b.dim, (v) => set((c) => { c.bubble.dim = v; }, true), t('scrDimHint')),
      ...(b.dim ? [row(t('scrDimAfter'), num(b.dimAfter, 2, 30, 1, (v) => set((c) => { c.bubble.dimAfter = v; }), 'dimAfter', t('scrSec')))] : []),
      toggle(t('scrEdge'), b.edge, (v) => set((c) => { c.bubble.edge = v; })),
      h('p', { class: 'hint' }, t('scrBubbleHint')));

    // History
    const list = h('div', { class: 'screen-history' });
    histCard.replaceChildren(h('h3', null, t('scrHistory')), toggle(t('scrKeepHistory'), cfg.history, (v) => set((c) => { c.history = v; })), list,
      h('div', { class: 'row-actions wrap' }, h('button', { type: 'button', class: 'btn text small', onclick: () => void loadHistory(list) }, icon('refresh'), t('scrHistoryRefresh')), h('button', { type: 'button', class: 'btn text small danger', onclick: async () => { await plug()?.screenHistory?.({ clear: true }).catch(() => undefined); void loadHistory(list); } }, icon('trash'), t('scrHistoryClear'))));
    void loadHistory(list);
  }
  async function loadHistory(list: HTMLElement): Promise<void> {
    const r = await plug()?.screenHistory?.({}).catch(() => null);
    const items = r?.items ?? [];
    if (!items.length) { list.replaceChildren(h('p', { class: 'empty small' }, t('scrHistoryEmpty'))); return; }
    const fmt = new Intl.DateTimeFormat(getLang(), { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
    list.replaceChildren(...items.slice(0, 80).map((x) => h('div', { class: 'screen-hist-item' },
      h('div', { class: 'grow' }, h('b', { dir: 'auto' }, x.t), h('small', { class: 'src', dir: 'auto' }, x.o), h('small', { class: 'src' }, fmt.format(new Date(x.at)))),
      iconButton('copy', t('copy'), () => void navigator.clipboard?.writeText(x.t).then(() => toast(t('copied'))).catch(() => undefined)))));
  }

  draw(); void refresh();
  // (Back from Android's settings: what is allowed now read again.)
  const again = () => { if (!document.hidden) void refresh(); };
  document.addEventListener('visibilitychange', again); window.addEventListener('focus', again);
  const tm = window.setInterval(again, 3000);
  root.dispose = () => { document.removeEventListener('visibilitychange', again); window.removeEventListener('focus', again); clearInterval(tm); };
  // (The settings the bubble reads, written at once — it may be started from its tile without this page.)
  void plug()?.screenConfig?.({ config: nativeConfig(cfg) }).catch(() => undefined);
  return root;
}
