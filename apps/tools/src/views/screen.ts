// Translate on screen (the add-on, Android): a floating bubble over every app that translates what the screen
// shows — its text read exactly (accessibility), or a picture of it read by OCR for games, comics and videos —
// with Google Translate, DeepL or an AI model set up as in the Reader. This page sets it up: what Android must
// allow, the translator, how the screen is read, auto translation, how the translations look, the bubble and
// what its taps do, reading aloud, and the history of what was translated.
import { h, icon, iconButton, toast } from '../ui/dom';
import { t, getLang } from '../i18n';
import { back } from '../router';
import { ktPlugin, nativePlatform } from '../native';
import { AI_PRESETS, SCREEN_LANGS, engineReady, loadScreen, nativeConfig, saveScreen, type Action, type ScreenConfig } from '../screen/config';

type Status = { overlay: boolean; a11y: boolean; a11yLive?: boolean; running: boolean; capture: boolean; notify: boolean; battery: boolean; tile: boolean };
type Plug = {
  screenStatus?(): Promise<Status>; screenPermission?(o: { what: string }): Promise<void>; screenConfig?(o: { config: Record<string, unknown>; clearFixed?: boolean }): Promise<void>;
  screenStart?(): Promise<void>; screenStop?(): Promise<void>; screenTranslate?(o: { texts: string[]; config?: Record<string, unknown> }): Promise<{ texts: string[] }>;
  screenHistory?(o: { clear?: boolean }): Promise<{ items: { o: string; t: string; at: number }[] }>;
};
const plug = (): Plug | null => ktPlugin() as unknown as Plug | null;

/** Whether the add-on can run here (the floating translator is Android's). */
export const screenHere = (): boolean => nativePlatform() === 'android';

export function screenView(): HTMLElement & { dispose?: () => void } {
  let cfg = loadScreen();
  const body = h('div', { class: 'body screen-body' });
  const root = h('div', { class: 'view settings-view screen-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/settings/addons')), h('div', { class: 'title' }, h('span', null, t('scrTitle')))), body) as HTMLElement & { dispose?: () => void };
  if (!screenHere()) { body.append(h('section', { class: 'card' }, h('p', null, t('scrAndroidOnly')))); return root; }

  const push = (() => { let tm = 0; return (extra: { clearFixed?: boolean } = {}) => { saveScreen(cfg); clearTimeout(tm); tm = window.setTimeout(() => void plug()?.screenConfig?.({ config: nativeConfig(cfg), ...extra }).catch(() => undefined), 250); }; })();
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
    const s = await plug()?.screenStatus?.().catch(() => null) ?? null; st = s;
    if (!s) { state.textContent = t('scrNoNative'); go.setAttribute('disabled', ''); return; }
    go.removeAttribute('disabled');
    go.replaceChildren(icon(s.running ? 'close' : 'play'), s.running ? t('scrStop') : t('scrStart')); go.classList.toggle('danger', s.running);
    state.textContent = !s.overlay ? t('scrNeedOverlay') : s.running ? t('scrRunning') : !engineReady(cfg) ? t('scrNeedEngine') : t('scrReady');
    steps.replaceChildren(
      step(s.overlay, t('scrStepOverlay'), t('scrStepOverlayHint'), 'overlay', true),
      step(s.a11y, t('scrStepA11y'), t('scrStepA11yHint'), 'a11y', cfg.read === 'text'),
      step(s.notify, t('scrStepNotify'), t('scrStepNotifyHint'), 'app'),
      step(s.battery, t('scrStepBattery'), t('scrStepBatteryHint'), 'battery'),
      ...(s.tile ? [h('div', { class: 'screen-step', 'data-step': 'tile' }, h('span', { class: 'screen-step-ic' }, icon('grid')), h('span', { class: 'grow' }, h('b', null, t('scrStepTile')), h('small', { class: 'src' }, t('scrStepTileHint'))), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void plug()?.screenPermission?.({ what: 'tile' }) }, t('scrAddTile')))] : []));
  }
  go.addEventListener('click', async () => {
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
  const text = (value: string, f: (v: string) => void, opts: { type?: string; placeholder?: string; name: string }) => h('input', { class: 'input', type: opts.type ?? 'text', value, placeholder: opts.placeholder ?? '', name: opts.name, autocomplete: 'off', spellcheck: false, oninput: (e: Event) => f((e.target as HTMLInputElement).value) });
  const colour = (value: string, f: (v: string) => void, name: string) => h('input', { type: 'color', value, name, class: 'screen-colour', oninput: (e: Event) => f((e.target as HTMLInputElement).value) });
  const segs = <T extends string>(value: T, opts: [T, string][], f: (v: T) => void, name: string) => h('div', { class: 'segmented', role: 'radiogroup', 'data-name': name }, ...opts.map(([v, l]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '', 'data-v': v, onclick: () => f(v) }, l)));

  const engineCard = h('section', { class: 'card', id: 'scr-engine' }); const readCard = h('section', { class: 'card', id: 'scr-read' }); const autoCard = h('section', { class: 'card', id: 'scr-auto' });
  const lookCard = h('section', { class: 'card', id: 'scr-look' }); const bubbleCard = h('section', { class: 'card', id: 'scr-bubble' }); const histCard = h('section', { class: 'card', id: 'scr-history' });
  body.append(hero, setup, engineCard, readCard, autoCard, lookCard, bubbleCard, histCard);

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
      segs(cfg.engine, [['google', 'Google'], ['deepl', 'DeepL'], ['ai', t('scrEngineAi')]], (v) => set((c) => { c.engine = v; }, true), 'engine'),
      h('p', { class: 'hint' }, cfg.engine === 'google' ? t('scrGoogleHint') : cfg.engine === 'deepl' ? t('scrDeeplHint') : t('scrAiHint')),
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

    // How the screen is read, and what a translation covers
    readCard.replaceChildren(h('h3', null, t('scrRead')),
      segs(cfg.read, [['auto', t('scrReadAuto')], ['text', t('scrReadText')], ['picture', t('scrReadPicture')]], (v) => set((c) => { c.read = v; }, true), 'read'),
      h('p', { class: 'hint' }, cfg.read === 'text' ? t('scrReadTextHint') : cfg.read === 'picture' ? t('scrReadPictureHint') : t('scrReadAutoHint')),
      row(t('scrMode'), select(cfg.mode, [['full', t('scrModeFull')], ['fixed', t('scrModeFixed')]], (v) => set((c) => { c.mode = v; }), 'mode'), t('scrModeHint')),
      h('button', { type: 'button', class: 'btn text small', onclick: () => { push({ clearFixed: true }); toast(t('scrFixedCleared')); } }, icon('close'), t('scrFixedClear')),
      row(t('scrDisplay'), select(cfg.display, [['overlay', t('scrDisplayOverlay')], ['panel', t('scrDisplayPanel')]], (v) => set((c) => { c.display = v; }), 'display')));

    // Auto
    autoCard.replaceChildren(h('h3', null, t('scrAuto')), h('p', { class: 'hint' }, t('scrAutoHint')),
      segs(cfg.auto, [['scroll', t('scrAutoScroll')], ['interval', t('scrAutoInterval')]], (v) => set((c) => { c.auto = v; }, true), 'auto'),
      cfg.auto === 'interval' ? row(t('scrInterval'), num(cfg.interval, 1, 15, 1, (v) => set((c) => { c.interval = v; }), 'interval', t('scrSec'))) : row(t('scrSettle'), num(cfg.settle, 0.3, 3, 0.1, (v) => set((c) => { c.settle = Math.round(v * 10) / 10; }), 'settle', t('scrSec')), t('scrSettleHint')),
      row(t('scrAutoStop'), num(cfg.autoStop, 0, 120, 5, (v) => set((c) => { c.autoStop = v; }), 'autoStop', t('scrMin')), t('scrAutoStopHint')));

    // How the translations look
    const sty = cfg.style;
    lookCard.replaceChildren(h('h3', null, t('scrLook')),
      h('div', { class: 'screen-preview', style: `--bg:${sty.bg};--fg:${sty.fg};--a:${sty.bgAlpha};--r:${sty.radius}px;--s:${sty.size}px` }, h('span', { class: sty.bgMode === 'none' ? 'bare' : '', style: `${sty.bold ? 'font-weight:700;' : ''}${sty.center ? 'text-align:center;' : ''}${sty.outline ? 'text-shadow:0 0 3px #000,0 0 2px #000;' : ''}` }, t('scrPreview'))),
      row(t('scrSize'), num(sty.size, 9, 28, 1, (v) => set((c) => { c.style.size = v; }), 'size')),
      toggle(t('scrSmart'), sty.smart, (v) => set((c) => { c.style.smart = v; }), t('scrSmartHint')),
      row(t('scrBg'), h('span', { class: 'screen-colours' }, colour(sty.bg, (v) => set((c) => { c.style.bg = v; }, true), 'bg'), select(sty.bgMode, [['fill', t('scrBgFill')], ['none', t('scrBgNone')]], (v) => set((c) => { c.style.bgMode = v; }, true), 'bgMode'))),
      row(t('scrOpacity'), num(Math.round(sty.bgAlpha * 100), 30, 100, 5, (v) => set((c) => { c.style.bgAlpha = v / 100; }), 'bgAlpha', '%')),
      row(t('scrFg'), colour(sty.fg, (v) => set((c) => { c.style.fg = v; }, true), 'fg')),
      row(t('scrRadius'), num(sty.radius, 0, 16, 1, (v) => set((c) => { c.style.radius = v; }), 'radius')),
      toggle(t('scrBold'), sty.bold, (v) => set((c) => { c.style.bold = v; }, true)), toggle(t('scrCenter'), sty.center, (v) => set((c) => { c.style.center = v; }, true)), toggle(t('scrOutline'), sty.outline, (v) => set((c) => { c.style.outline = v; }, true), t('scrOutlineHint')),
      row(t('scrHideAfter'), num(cfg.hideAfter, 0, 60, 1, (v) => set((c) => { c.hideAfter = v; }), 'hideAfter', t('scrSec')), t('scrHideAfterHint')),
      toggle(t('scrTapClose'), cfg.tapClose, (v) => set((c) => { c.tapClose = v; }), t('scrTapCloseHint')),
      toggle(t('scrSpeak'), cfg.speak, (v) => set((c) => { c.speak = v; }, true), t('scrSpeakHint')),
      ...(cfg.speak ? [row(t('scrRate'), num(cfg.ttsRate, 0.5, 2, 0.1, (v) => set((c) => { c.ttsRate = Math.round(v * 10) / 10; }), 'ttsRate', '×'))] : []));

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
      iconButton('copy', t('copy'), () => void navigator.clipboard?.writeText(x.t).then(() => toast(t('copied')))))));
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
