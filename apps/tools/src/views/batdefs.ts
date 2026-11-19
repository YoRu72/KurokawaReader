// SPDX-License-Identifier: GPL-3.0-or-later
// Device battery W3 (the computer's Tauri build; Windows and Linux): «Your device definitions» — a device Tools does not
// know, taught without new code. A definition (kt-battery defs.rs) is data: where an input report the device sends by
// itself carries the level; it is listened to only and can never send anything. The card lists them (name, ids, an
// on/off switch; a menu to export one as a file, to put it before a built-in reader — «use mine instead», asked —, to
// remove it, asked first), imports a file the user picks (16 KB at most, checked by the shell, never run), and opens
// «Teach me a device»: the connected collections Tools may listen to (never a keyboard, a pointer, media keys, a pen
// tablet or a power supply; a device a built-in reader reads is sent to that family's switch), live rows of what one
// sends (bytes that never change dimmed), listening started and stopped by the user (and always stopped when the sheet
// closes, every captured byte dropped then — they live in the shell's memory only), the moments he marks, the values
// that follow them ranked with a plain explanation and what each would read now, and «Save and use». The shell's side:
// desktop-tauri/src-tauri/src/batdefs.rs. Loaded by the Battery page (battery.ts) on its first draw; its one timer (a
// look every second while listening) lives only while the sheet is open.
import { h, icon, iconButton, openSheet, pickButton, toast } from '../ui/dom';
import { t, localDigits, countMinutes } from '../i18n';

type Lvl = { kind: 'exact'; value: number } | { kind: 'coarse'; value: string; bars: number } | { kind: 'steps'; value: number; max: number } | { kind: 'unknown' };
export type DefEntry = { id: string; on: boolean; mineFirst: boolean; name: string; kind: string; note: string; vid: string; pid: string; usagePage: string | null; usage: string | null;
  interface: number | null; productName: string; builtin: string | null; level: { report: number; byte: number; mask: number; shift: number; how: 'scale' | 'steps' | 'table' }; charging: boolean };
type DefsReply = { list: DefEntry[]; max: number; teach: boolean; aside?: boolean };
type DefErr = { code: string; field: string };
type ImportReply = { ok: boolean; id?: string; list?: DefEntry[]; error?: DefErr };
type TeachDev = { id: string; unit: string; name: string; vid: string; pid: string; usagePage: string; usage: string; interface: number; verdict: string; family?: string | null };
type Cand = { i: number; report: number; byte: number; mask: number; shift: number; fit: 'percent' | 'range' | 'steps'; scale: { min: number; max: number; steps: boolean };
  values: { mark: string; value: number }[]; falling: boolean; weak: boolean; score: number; preview: Lvl | null };
type CCand = { i: number; report: number; byte: number; bit: number; on: boolean; score: number; now: 'yes' | 'no' | null };
type Row = { id: number; count: number; rate10: number; bytes: number[]; changing: boolean[] };
export type TeachState = { open: boolean; id?: string; name?: string; vid?: string; pid?: string; listening?: boolean; gone?: boolean; until?: number; now?: number; rows?: Row[];
  marks?: { kind: string; at: number }[]; level?: Cand[]; charging?: CCand[]; error?: 'quiet' | 'tooMany' };
/** The bridge's methods (desktop-tauri/bridge.js — the same names and arguments). */
export type DefsDesk = {
  batteryDefs(): Promise<DefsReply>; batteryDefImport(o: { text: string; mineFirst?: boolean }): Promise<ImportReply>; batteryDefExport(o: { id: string }): Promise<{ name: string; text: string }>;
  batteryDefRemove(o: { id: string }): Promise<{ list: DefEntry[] }>; batteryDefSet(o: { id: string; on?: boolean; mineFirst?: boolean }): Promise<{ list: DefEntry[] }>;
  batteryTeachList(): Promise<{ available: boolean; devices: TeachDev[] }>; batteryTeachStart(o: { id: string; seconds?: number; o: string }): Promise<TeachState>; batteryTeachStop(): Promise<TeachState>;
  batteryTeachState(): Promise<TeachState>; batteryTeachMark(o: { mark?: string; undo?: boolean }): Promise<TeachState>;
  batteryTeachSave(o: { level: number; charging?: number; name: string; kind: string }): Promise<ImportReply>; batteryTeachClose(o: { o: string }): Promise<boolean> };
export const defsDesk = (): DefsDesk | null => { const d = (window as unknown as { kurokawaTools?: Partial<DefsDesk> }).kurokawaTools; return d?.batteryDefs && d.batteryTeachList ? d as DefsDesk : null; };

/** What the page lends: redrawing it, a level's words, a kind's drawing and words, a family's brand and its switch. */
export type DefsCtx = { redraw(): void; levelText(l: Lvl): string; kindIcon(kind: string): SVGElement; familyName(f: string): string; showFamily(f: string): void; refreshAll(): void };

const KINDS = ['controller', 'headset', 'earbuds', 'mouse', 'keyboard', 'speaker', 'phone', 'microphone', 'other'];
const MARKS = ['full', 'half', 'low', 'charging', 'notCharging'] as const;
const MAX_FILE = 16 * 1024;

const CSS = `
.battery-view .bat-defs { gap: 4px; }
.battery-view .bat-defs h3 { margin-bottom: 4px; }
.battery-view .bat-defs > .hint { margin: 0 0 10px; }
.bat-eq-row { display: flex; flex-wrap: wrap; gap: 10px; }
.bat-eq-row > .btn { flex: 1 1 0; min-width: min(100%, 180px); justify-content: center; }
.battery-view .bat-defs .bat-def-list { display: flex; flex-direction: column; margin-top: 12px; border-top: 1px solid var(--md-outline-variant); }
.battery-view .bat-defs .bat-def.switch-row { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto auto; align-items: center; gap: 12px; padding: 12px 0; }
.battery-view .bat-defs .bat-def.switch-row + .bat-def { border-top: 1px solid var(--md-outline-variant); }
.battery-view .bat-defs .bat-def-ic { width: 40px; height: 40px; border-radius: 14px; display: grid; place-items: center; background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
.battery-view .bat-defs .bat-def-ic svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.battery-view .bat-defs .bat-def-who { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.battery-view .bat-defs .bat-def-name { color: var(--md-on-surface); font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.battery-view .bat-defs .bat-def-sub { color: var(--md-on-surface-variant); font-size: 12.5px; line-height: 1.45; }
.battery-view .bat-defs .bat-def.off .bat-def-name { color: var(--md-on-surface-variant); }
.battery-view .bat-defs .bat-def-none { margin: 12px 0 0; color: var(--md-on-surface-variant); }
.battery-view .bat-defs .bat-def-count { margin: 10px 0 0; font-size: 12.5px; color: var(--md-on-surface-variant); }
.sheet .bat-teach { display: flex; flex-direction: column; gap: 14px; }
.sheet .bat-teach .hint, .sheet .bat-teach p { margin: 0; line-height: 1.5; }
.sheet .bat-teach h4 { margin: 6px 0 0; font-size: 15px; font-weight: 650; color: var(--md-on-surface); }
.sheet .bat-teach .bat-t-dev { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: start; }
.sheet .bat-teach .bat-t-dev small, .sheet .bat-teach .bat-t-why { color: var(--md-on-surface-variant); font-size: 12.5px; line-height: 1.45; }
.sheet .bat-teach .bat-t-refused { display: flex; flex-direction: column; gap: 8px; }
.sheet .bat-teach .bat-t-ref { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 10px 14px; border-radius: 16px; background: var(--md-surface-container); }
.sheet .bat-teach .bat-t-ref > span { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.sheet .bat-teach .bat-t-status { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
.sheet .bat-teach .bat-t-status > p { flex: 1 1 220px; color: var(--md-on-surface-variant); font-size: 13px; }
.sheet .bat-teach .bat-t-status > .btn { flex: 0 0 auto; min-width: 180px; justify-content: center; }
.sheet .bat-teach .bat-t-rows { display: flex; flex-direction: column; gap: 10px; }
.sheet .bat-teach .bat-t-row { padding: 10px 12px; border-radius: 16px; background: var(--md-surface-container); }
.sheet .bat-teach .bat-t-row-head { font-size: 12.5px; color: var(--md-on-surface-variant); margin-bottom: 6px; }
.sheet .bat-teach .bat-t-bytes { display: flex; flex-wrap: wrap; gap: 4px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; direction: ltr; }
.sheet .bat-teach .bat-t-bytes > span { min-width: 26px; padding: 3px 4px; border-radius: 6px; text-align: center; background: var(--md-surface-container-high); color: var(--md-on-surface); }
.sheet .bat-teach .bat-t-bytes > span.still { opacity: .38; }
.sheet .bat-teach .bat-t-bytes > span.moving { background: var(--md-primary-container); color: var(--md-on-primary-container); }
.sheet .bat-teach .bat-t-marks { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 8px; }
.sheet .bat-teach .bat-t-marks > .btn { justify-content: center; }
.sheet .bat-teach .bat-t-marked { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; font-size: 13px; color: var(--md-on-surface-variant); }
.sheet .bat-teach .bat-t-marked > span { flex: 1 1 200px; }
.sheet .bat-teach .bat-t-cands { display: flex; flex-direction: column; gap: 8px; }
.sheet .bat-teach .bat-t-cand { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; width: 100%; padding: 12px 14px; border-radius: 16px; border: 1px solid var(--md-outline-variant); background: var(--md-surface-container-low); color: var(--md-on-surface); font: inherit; text-align: start; cursor: pointer; }
.sheet .bat-teach .bat-t-cand[aria-checked="true"] { border-color: transparent; outline: 2px solid var(--md-primary); background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
.sheet .bat-teach .bat-t-cand:focus-visible { outline: 2px solid var(--md-primary); outline-offset: 2px; }
.sheet .bat-teach .bat-t-cand b { font-weight: 650; font-size: 14.5px; }
.sheet .bat-teach .bat-t-cand small { font-size: 12.5px; line-height: 1.45; color: inherit; opacity: .85; }
.sheet .bat-teach .bat-t-cand .bat-t-prev { font-size: 13px; font-weight: 600; }
.sheet .bat-teach .bat-t-save { display: flex; flex-wrap: wrap; gap: 10px 12px; align-items: flex-end; }
.sheet .bat-teach .bat-t-save > label { flex: 1 1 200px; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--md-on-surface-variant); }
.sheet .bat-teach .bat-t-save input { height: 44px; padding: 0 14px; border-radius: 12px; font: inherit; }
.sheet .bat-teach .bat-t-save .pick-btn { width: 100%; }
`;
function style(): void {
  if (document.getElementById('kt-batdefs-css')) return;
  const s = document.createElement('style'); s.id = 'kt-batdefs-css'; s.textContent = CSS; document.head.append(s);
}

/** A definition's error in the page's words. */
export function errText(e: DefErr | undefined): string {
  if (!e) return t('batDefErr_notJson');
  if (e.code === 'count' && e.field === 'list') return t('batDefErr_full');
  const known = ['tooBig', 'notJson', 'notObject', 'version', 'unknown', 'missing', 'type', 'range', 'length', 'count', 'duplicate', 'kind', 'scale', 'text', 'forbidden', 'exists', 'save'];
  return t(`batDefErr_${known.includes(e.code) ? e.code : 'notJson'}` as 'batDefErr_notJson', { field: '\u2068' + e.field + '\u2069' });
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
const iso = (s: string) => '\u2068' + s + '\u2069';
/** Ids (hex, «vid:pid») kept left to right inside a right-to-left sentence. */
const ltr = (s: string) => '\u2066' + s + '\u2069';

export function defsPanel(d: DefsDesk, ctx: DefsCtx): { card(): HTMLElement | null; teach(pre?: { vid: number; pid: number }): void; dispose(): void } {
  style();
  let state: DefsReply | null = null; let gone = false;
  const load = () => d.batteryDefs().then((r) => { if (gone) return; state = r; ctx.redraw(); }, () => undefined);
  void load();
  const setList = (list: DefEntry[] | undefined) => { if (state && list) state.list = list; ctx.redraw(); };
  const ids = (x: { vid: string; pid: string }) => `${x.vid}:${x.pid}`;

  // Import: a file the user picks — its size checked here first, its text checked by the shell, never run.
  const importFile = () => {
    const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const f = input.files?.[0]; input.remove(); if (!f) return;
      if (f.size > MAX_FILE) { toast(t('batDefErr_tooBig'), 'error'); return; }
      void f.text().then((text) => send(text, false), () => toast(t('batDefErr_notJson'), 'error'));
    });
    document.body.append(input); input.click();
  };
  const send = async (text: string, mineFirst: boolean): Promise<void> => {
    let r: ImportReply; try { r = await d.batteryDefImport({ text, mineFirst }); } catch (e) { toast(String((e as Error)?.message ?? e), 'error'); return; }
    if (r.ok) { setList(r.list); const n = r.list?.find((x) => x.id === r.id)?.name ?? ''; toast(t('batDefImported', { name: iso(n) })); ctx.refreshAll(); return; }
    if (r.error?.code === 'builtin') { askMine(r.error.field, () => void send(text, true)); return; }
    toast(errText(r.error), 'error', 5000);
  };
  // A built-in reader's device: the user's definition goes first only when he says so.
  const askMine = (family: string, yes: () => void, stack = false) => {
    const sh = openSheet(t('batDefMineAsk', { family: ctx.familyName(family) }), t('close'), { stack });
    sh.body.append(h('p', { class: 'hint', 'data-ask': 'mine' }, t('batDefMineAskHint')));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal bat-eq', 'data-act': 'keepBuiltin', onclick: () => sh.close() }, t('batDefKeepBuiltIn')),
      h('button', { type: 'button', class: 'btn primary bat-eq', 'data-act': 'useMine', onclick: () => { sh.close(); yes(); } }, t('batDefUseMineBtn')));
  };
  const set = (x: DefEntry, o: { on?: boolean; mineFirst?: boolean }) => void d.batteryDefSet({ id: x.id, ...o }).then((r) => { setList(r.list); ctx.refreshAll(); }, (e) => toast(String((e as Error)?.message ?? e), 'error'));
  const exportOne = async (x: DefEntry) => {
    try { const r = await d.batteryDefExport({ id: x.id }); const { saveText } = await import('../native'); const p = await saveText(r.name, r.text, 'application/json'); if (p) toast(t('batDefExported')); }
    catch (e) { toast(String((e as Error)?.message ?? e), 'error'); }
  };
  const remove = (x: DefEntry) => {
    const sh = openSheet(t('batDefRemoveAsk', { name: iso(x.name) }), t('close'));
    sh.body.append(h('p', { class: 'hint' }, t('batDefRemoveHint')));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal bat-eq', 'data-act': 'cancel', onclick: () => sh.close() }, t('cancel')),
      h('button', { type: 'button', class: 'btn primary bat-eq', 'data-act': 'remove', onclick: () => { sh.close(); void d.batteryDefRemove({ id: x.id }).then((r) => { setList(r.list); toast(t('batDefRemoved')); ctx.refreshAll(); }, (e) => toast(String((e as Error)?.message ?? e), 'error')); } }, t('batDefRemove')));
  };
  const menu = (x: DefEntry, ev: Event) => {
    const sh = openSheet(x.name, t('close'), { at: ev });
    const act = (ic: string, label: string, fn: () => void, name: string) => h('button', { type: 'button', class: 'dest-row', 'data-act': name, onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    sh.body.append(h('div', { class: 'dest-list' },
      act('download', t('batDefExport'), () => void exportOne(x), 'export'),
      ...(x.builtin ? [x.mineFirst ? act('undo', t('batDefUseBuiltIn', { family: ctx.familyName(x.builtin) }), () => set(x, { mineFirst: false }), 'builtin')
        : act('swap', t('batDefUseMine', { family: ctx.familyName(x.builtin) }), () => askMine(x.builtin!, () => set(x, { mineFirst: true })), 'mine')] : []),
      act('trash', t('batDefRemove'), () => remove(x), 'remove')));
  };

  const row = (x: DefEntry): HTMLElement => {
    const sw = h('input', { type: 'checkbox', role: 'switch', checked: x.on, 'aria-label': t('batDefOnLabel', { name: iso(x.name) }), onchange: () => set(x, { on: sw.checked }) }) as HTMLInputElement;
    const more = iconButton('more', t('batDefMenu', { name: iso(x.name) }), (e) => menu(x, e));
    const where = t('batDefSub', { ids: ltr(ids(x)), report: localDigits(x.level.report), byte: localDigits(x.level.byte) });
    const note = x.builtin ? (x.mineFirst ? t('batDefMineFirst', { family: ctx.familyName(x.builtin) }) : t('batDefBuiltInUsed', { family: ctx.familyName(x.builtin) })) : '';
    return h('div', { class: 'bat-def switch-row' + (x.on ? '' : ' off'), 'data-id': x.id, 'data-kind': x.kind },
      h('span', { class: 'bat-def-ic' }, ctx.kindIcon(x.kind)),
      h('span', { class: 'bat-def-who' }, h('span', { class: 'bat-def-name', dir: 'auto', title: x.name }, x.name), h('span', { class: 'bat-def-sub' }, where),
        note ? h('span', { class: 'bat-def-sub', 'data-note': x.mineFirst ? 'mine' : 'builtin' }, note) : null),
      sw, more);
  };

  const card = (): HTMLElement | null => {
    if (!state || !state.teach) return null;
    const list = state.list;
    return h('section', { class: 'card bat-settings bat-defs', 'data-group': 'defs' }, h('h3', null, t('batDefTitle')), h('p', { class: 'hint' }, t('batDefHint')),
      // (The shell set a damaged file aside on its first read: said calmly, once per visit.)
      state.aside ? h('p', { class: 'hint', 'data-state': 'aside' }, t('batDefAside')) : null,
      h('div', { class: 'bat-eq-row' },
        h('button', { type: 'button', class: 'btn tonal', 'data-act': 'teach', onclick: () => teach() }, icon('target'), t('batDefTeach')),
        h('button', { type: 'button', class: 'btn tonal', 'data-act': 'import', onclick: importFile }, icon('import'), t('batDefImport'))),
      list.length ? h('div', { class: 'bat-def-list' }, ...list.map(row)) : h('p', { class: 'bat-def-none' }, t('batDefNone')),
      list.length ? h('p', { class: 'bat-def-count' }, t('batDefCount', { n: localDigits(list.length) })) : null);
  };

  // «Teach me a device».
  const teach = (pre?: { vid: number; pid: number }) => {
    let closed = false; let timer = 0; let st: TeachState = { open: false };
    let pickL = ''; let pickC = ''; let name = ''; let kind = 'other';
    // (This sheet's own token, sent with start and close: a start still on the way when the sheet closes is stopped by
    // the shell, and dropped here too.)
    const sheetId = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const closeRun = () => void d.batteryTeachClose({ o: sheetId }).catch(() => false);
    const stopPoll = () => { if (timer) { clearInterval(timer); timer = 0; } };
    const sh = openSheet(t('batTeachTitle'), t('close'), { onClose: () => { closed = true; stopPoll(); closeRun(); } });
    sh.el.classList.add('bat-teach-sheet');
    const wrap = h('div', { class: 'bat-teach' }); sh.body.append(wrap);
    const fail = (e: unknown) => toast(String((e as Error)?.message ?? e), 'error');

    const pickStep = async () => {
      wrap.replaceChildren(h('p', { class: 'hint' }, t('batTeachPickHint')), h('div', { class: 'spinner small' }));
      let r: { available: boolean; devices: TeachDev[] };
      try { r = await d.batteryTeachList(); } catch (e) { fail(e); return; }
      if (closed) return;
      const want = (x: TeachDev) => !pre || (parseInt(x.vid, 16) === pre.vid && parseInt(x.pid, 16) === pre.pid);
      const devs = r.devices.filter(want);
      const ok = devs.filter((x) => x.verdict === 'allowed');
      // (A unit refused once: its first reason, shown once.)
      const refused: TeachDev[] = []; for (const x of devs) if (x.verdict !== 'allowed' && !ok.some((o) => o.unit === x.unit) && !refused.some((o) => o.unit === x.unit)) refused.push(x);
      const okList = ok.length ? h('div', { class: 'dest-list', role: 'list' }, ...ok.map((x) => h('button', { type: 'button', class: 'dest-row', 'data-id': x.id, onclick: () => listenStep(x) }, icon('target'),
        h('span', { class: 'name bat-t-dev' }, h('span', { dir: 'auto' }, x.name || t('batUnnamed')), h('small', null, t('batTeachIds', { ids: ltr(`${x.vid}:${x.pid}`), channel: ltr(`${x.usagePage}:${x.usage}`) })))))) : h('p', { class: 'bat-t-why', 'data-none': '1' }, t('batTeachNone'));
      const refList = refused.length ? h('div', { class: 'bat-t-refused' }, h('h4', null, t('batTeachRefused')), ...refused.map((x) => h('div', { class: 'bat-t-ref', 'data-verdict': x.verdict, 'data-id': x.id },
        h('span', null, h('span', null, x.name || t('batUnnamed')), h('small', { class: 'bat-t-why' }, t(`batTeachWhy_${x.verdict}` as 'batTeachWhy_keyboard', { family: ctx.familyName(x.family ?? '') }))),
        x.verdict === 'builtin' && x.family ? h('button', { type: 'button', class: 'btn tonal small', 'data-act': 'showFamily', onclick: () => { sh.close(); ctx.showFamily(x.family!); } }, t('batTeachShowSwitch')) : null))) : null;
      wrap.replaceChildren(...[h('p', { class: 'hint' }, t('batTeachPickHint')), okList, refList].filter(Boolean) as HTMLElement[]);
    };

    const listenStep = (dev: TeachDev) => {
      name = dev.name.slice(0, 64);
      const status = h('div', { class: 'bat-t-status' }); const rows = h('div', { class: 'bat-t-rows', 'aria-live': 'off' });
      const marked = h('div', { class: 'bat-t-marked' }); const cands = h('div', { class: 'bat-t-cands', role: 'radiogroup', 'aria-label': t('batTeachLevel') });
      const ccands = h('div', { class: 'bat-t-cands', role: 'radiogroup', 'aria-label': t('batTeachCharging') });
      const markBtns = MARKS.map((m) => h('button', { type: 'button', class: 'btn tonal', 'data-mark': m, onclick: () => void mark(m) }, t(`batTeachMark_${m}` as 'batTeachMark_full'))) as HTMLButtonElement[];
      const nameIn = h('input', { type: 'text', value: name, maxlength: '64', dir: 'auto', 'aria-label': t('batTeachName'), oninput: () => { name = nameIn.value; paintSave(); } }) as HTMLInputElement;
      const kindBtn = pickButton(t('batTeachKind'), KINDS.map((k) => [k, t(`batKind_${k}` as 'batKind_mouse')] as [string, string]), kind, (v) => { kind = v; }, t('close'));
      kindBtn.dataset.name = 'kind';
      const saveBtn = h('button', { type: 'button', class: 'btn primary bat-eq', 'data-act': 'save', onclick: () => void save() }, icon('check'), t('batTeachSave')) as HTMLButtonElement;
      const paintSave = () => { saveBtn.disabled = !name.trim() || !(st.level ?? []).some((c) => key(c) === pickL); };
      const key = (c: Cand) => `${c.report}:${c.byte}:${c.mask}`; const ckey = (c: CCand) => `${c.report}:${c.byte}:${c.bit}`;
      wrap.replaceChildren(
        h('p', { class: 'hint' }, h('b', null, dev.name || t('batUnnamed')), ' · ', ltr(`${dev.vid}:${dev.pid}`)),
        status,
        h('h4', null, t('batTeachRows')), h('p', { class: 'bat-t-why' }, t('batTeachRowsHint')), rows,
        h('h4', null, t('batTeachMarks')), h('p', { class: 'bat-t-why' }, t('batTeachMarksHint')), h('div', { class: 'bat-t-marks' }, ...markBtns), marked,
        h('h4', null, t('batTeachLevel')), cands,
        h('h4', null, t('batTeachCharging')), ccands,
        h('div', { class: 'bat-t-save' }, h('label', null, h('span', null, t('batTeachName')), nameIn), h('label', null, h('span', null, t('batTeachKind')), kindBtn)));
      sh.actions.replaceChildren(saveBtn);

      const paint = () => {
        if (closed) return;
        const listening = !!st.listening;
        const left = Math.max(0, Math.ceil(((st.until ?? 0) - (st.now ?? 0)) / 60000));
        const btn = h('button', { type: 'button', class: 'btn ' + (listening ? 'tonal' : 'primary'), 'data-act': listening ? 'stop' : 'start', onclick: () => void (listening ? stop() : start()) }, icon(listening ? 'stop' : 'play'), listening ? t('batTeachListenStop') : t('batTeachListenStart'));
        status.replaceChildren(h('p', { 'data-listening': String(listening) }, st.gone ? t('batTeachGone') : listening ? t('batTeachListening', { left: countMinutes(Math.max(1, left)) }) : t('batTeachStopped')), btn);
        const rs = st.rows ?? [];
        rows.replaceChildren(...(rs.length ? rs.map((r) => h('div', { class: 'bat-t-row', 'data-report': String(r.id) },
          h('div', { class: 'bat-t-row-head' }, t('batTeachRowHead', { id: localDigits(r.id), rate: localDigits((r.rate10 / 10).toFixed(1)), n: localDigits(r.count) })),
          h('div', { class: 'bat-t-bytes' }, ...r.bytes.map((b, i) => h('span', { class: i === 0 || !r.changing[i] ? 'still' : 'moving', title: t('batTeachByte', { n: localDigits(i) }) }, hex2(b))))))
          : [h('p', { class: 'bat-t-why', 'data-none': '1' }, t('batTeachNothing'))]));
        for (const b of markBtns) b.disabled = !listening;
        const ms = st.marks ?? [];
        marked.replaceChildren(...(ms.length ? [h('span', null, t('batTeachMarked', { list: ms.map((m) => t(`batTeachMark_${m.kind}` as 'batTeachMark_full')).join(t('batListSep')) })),
          h('button', { type: 'button', class: 'btn tonal small', 'data-act': 'undo', onclick: () => void d.batteryTeachMark({ undo: true }).then(took, fail) }, icon('undo'), t('batTeachUndo'))] : []));
        const lv = st.level ?? [];
        if (pickL && !lv.some((c) => key(c) === pickL)) pickL = '';
        if (!pickL && lv[0] && !lv[0].weak) pickL = key(lv[0]);
        cands.replaceChildren(...(lv.length ? lv.map((c) => {
          const vals = c.values.map((v) => t('batTeachValueAt', { v: localDigits(v.value), mark: t(`batTeachMark_${v.mark}` as 'batTeachMark_full') })).join(t('batListSep'));
          const fit = t(`batTeachFit_${c.fit}` as 'batTeachFit_percent', { max: localDigits(c.scale.steps ? c.scale.max : Math.max(c.scale.min, c.scale.max)) });
          const extra = [c.falling ? t('batTeachFalling') : '', c.weak ? t('batTeachWeak') : ''].filter(Boolean).join(' ');
          const prev = c.preview ? t('batTeachPreview', { level: ctx.levelText(c.preview) }) : t('batTeachPreviewNone');
          const head = c.mask === 255 ? t('batTeachCand', { report: localDigits(c.report), byte: localDigits(c.byte) }) : t('batTeachCandMask', { report: localDigits(c.report), byte: localDigits(c.byte), mask: '0x' + hex2(c.mask) });
          return h('button', { type: 'button', role: 'radio', class: 'bat-t-cand', 'aria-checked': String(key(c) === pickL), 'data-key': key(c), 'data-weak': String(c.weak), onclick: () => { pickL = key(c); paint(); } },
            h('b', null, head), h('small', null, t('batTeachWhy', { values: vals, fit }) + (extra ? ' ' + extra : '')), h('span', { class: 'bat-t-prev', 'data-preview': '1' }, prev));
        }) : [h('p', { class: 'bat-t-why', 'data-none': '1' }, t('batTeachLevelNone'))]));
        const cc = st.charging ?? [];
        if (pickC && !cc.some((c) => ckey(c) === pickC)) pickC = '';
        ccands.replaceChildren(...(cc.length ? [...cc.map((c) => h('button', { type: 'button', role: 'radio', class: 'bat-t-cand', 'aria-checked': String(ckey(c) === pickC), 'data-key': ckey(c), onclick: () => { pickC = ckey(c); paint(); } },
          h('b', null, t('batTeachChargeCand', { report: localDigits(c.report), byte: localDigits(c.byte), bit: localDigits(c.bit) })),
          h('small', null, c.on ? t('batTeachChargeSet') : t('batTeachChargeClear')),
          c.now ? h('span', { class: 'bat-t-prev' }, t(`batTeachChargeNow_${c.now}` as 'batTeachChargeNow_yes')) : null)),
          h('button', { type: 'button', role: 'radio', class: 'bat-t-cand', 'aria-checked': String(!pickC), 'data-key': '', onclick: () => { pickC = ''; paint(); } }, h('b', null, t('batTeachChargeNone')))]
          : [h('p', { class: 'bat-t-why', 'data-none': '1' }, t('batTeachChargingHint'))]));
        paintSave();
      };
      const took = (s: TeachState) => {
        // (The sheet closed while this answer was on the way — a start that began listening after all: closed again.)
        if (closed) { closeRun(); return; }
        if (s.error) { toast(t(s.error === 'quiet' ? 'batTeachQuiet' : 'batTeachTooMany'), 'error'); return; }
        st = s; paint();
        if (st.listening && !timer) timer = window.setInterval(() => void d.batteryTeachState().then(took, () => undefined), 1000);
        if (!st.listening) stopPoll();
      };
      const start = () => d.batteryTeachStart({ id: dev.id, o: sheetId }).then(took, fail);
      const stop = () => d.batteryTeachStop().then(took, fail);
      const mark = (m: string) => d.batteryTeachMark({ mark: m }).then(took, fail);
      const save = async () => {
        const L = (st.level ?? []).find((c) => key(c) === pickL); if (!L || !name.trim()) return;
        const C = (st.charging ?? []).find((c) => ckey(c) === pickC);
        let r: ImportReply; try { r = await d.batteryTeachSave({ level: L.i, ...(C ? { charging: C.i } : {}), name: name.trim(), kind }); } catch (e) { fail(e); return; }
        if (!r.ok) { toast(errText(r.error), 'error', 5000); return; }
        stopPoll(); setList(r.list); toast(t('batTeachSaved', { name: iso(name.trim()) })); sh.close(); ctx.refreshAll();
      };
      paint();
    };
    void pickStep();
  };

  return { card, teach, dispose: () => { gone = true; } };
}
