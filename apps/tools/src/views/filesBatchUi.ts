// The batch rename sheet of the Files page («Rename 12 items»): name, number, extension, what to do when a name is
// taken, the saved presets, and a live list «old → new» (drawn a screenful at a time, so five thousand stay smooth) with
// each row's problems; then the run — a job with progress and Cancel — and an Undo after it. The logic is in
// filesBatch.ts (pure); the storage's own calls come from the page (`BatchHost`).
import { h, icon, openSheet, toast, iconButton } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { setName, nameDir } from '../ui/fileName';
import { nameDotExt } from '../ui/nameExt';
import { splitExt } from './filesNames';
import { defaultRecipe, planBatch, chipsFor, blocks, dirOf, joinPath, runRenames, undoRens, Journal, readJournal, dropJournal, whereNow, recoveryRens, type BItem, type Recipe, type Plan, type Row, type Ren, type RunResult, type NumOrder } from './filesBatch';
import { moveThumbs } from '../ui/thumbs';

export type BatchHost = {
  /** The items in the order they were picked. */ items: BItem[];
  /** The folder's items in the order shown now. */ shown: BItem[];
  /** The items were picked by hand (the order picked is the one to number by). */ byHand: boolean;
  /** The names in a folder (hidden ones too; null: not known). */ names(dir: string): Promise<string[] | null>;
  rename(dir: string, from: string, to: string): Promise<void>;
  /** A progress row of the page: `set` and `end`. */ progress(label: string, cancel: () => void): { set(done: number, total: number): void; end(): void };
  /** The names changed: old path → new path; the page follows the selection and reads the folder again. */ after(moved: Map<string, string>): void;
  fmtSize(n: number): string;
};
const PRESETS = 'kt.files.renamePresets';
type Preset = { name: string; recipe: Recipe };
const presets = (): Preset[] => { try { const a = JSON.parse(localStorage.getItem(PRESETS) ?? '[]') as Preset[]; return Array.isArray(a) ? a.filter((x) => x && typeof x.name === 'string' && x.recipe) : []; } catch { return []; } };
const savePresets = (a: Preset[]) => { try { localStorage.setItem(PRESETS, JSON.stringify(a)); } catch { /* none */ } };
const store = (): Storage | null => { try { return localStorage; } catch { return null; } };
const ROW_H = 66;

/** Why many names cannot be changed here (null: they can). */
export function whyNot(paths: string[], hasRename: boolean): string | null {
  if (paths.some((p) => /^arc:\/\//.test(p))) return t('btWhyArchive');
  if (!hasRename) return t('btWhyNoEngine');
  return null;
}

/** Runs the renames as a job (progress, Cancel), tells how it went, offers Undo, and tells the page. */
export async function runBatch(host: BatchHost, items: BItem[], rens: Ren[], of: number[]): Promise<void> {
  const id = Math.random().toString(36).slice(2, 8); let stop = false;
  const row = host.progress(t('btRenaming'), () => { stop = true; });
  const journal = new Journal(id, store());
  const io = { rename: (d: string, a: string, b: string) => host.rename(d, a, b), list: (d: string) => host.names(d) };
  let res: RunResult;
  try { res = await runRenames(rens, io, { id, progress: (k, n) => row.set(k, n), cancelled: () => stop, journal }); } finally { row.end(); }
  report(host, items, rens, of, res, id);
}
function report(host: BatchHost, items: BItem[], rens: Ren[], of: number[], res: RunResult, id: string): void {
  const moved = new Map<string, string>(); for (const i of res.moved) moved.set(joinPath(rens[i].dir, rens[i].from), joinPath(rens[i].dir, rens[i].to));
  const n = res.moved.length; const bad = res.failed.length;
  if (res.stranded.length) toast(t('btStranded', { n: localDigits(res.stranded.length), name: res.at[res.stranded[0]] }), 'error', 9000);
  else if (bad) toast(t('btPartial', { n: localDigits(n), m: localDigits(bad), why: whyText(res.failed[0].why) }), 'error', 6000);
  if (n || res.stranded.length) host.after(moved);
  if (!n) { if (!bad && !res.stranded.length) toast(t(res.cancelled ? 'btNoneDone' : 'btNothingToDo'), 'info'); return; }
  void import('../ui/undo').then(({ offerUndo }) => {
    const label = res.cancelled ? t('btCancelled', { n: localDigits(n) }) : bad ? t('btPartial', { n: localDigits(n), m: localDigits(bad), why: whyText(res.failed[0].why) }) : t('filesRenamedN', { n: localDigits(n) });
    let cur = res; let lastRens = rens;
    const back = async () => {
      const u = undoRens(lastRens, cur); if (!u.rens.length) return;
      const r2 = await runRenames(u.rens, { rename: (d, a, b) => host.rename(d, a, b), list: (d) => host.names(d) }, { id: `${id}u`, journal: new Journal(`${id}u`, store()) });
      const m = new Map<string, string>(); for (const i of r2.moved) m.set(joinPath(u.rens[i].dir, u.rens[i].from), joinPath(u.rens[i].dir, u.rens[i].to));
      host.after(m); if (r2.failed.length) throw new Error(t('renameBackBlocked', { name: u.rens[r2.failed[0].i].to }));
      cur = { ...cur, at: lastRens.map((r) => r.from), moved: [] };
    };
    const again = async () => {
      const keep = of; void keep; const r3 = await runRenames(lastRens, { rename: (d, a, b) => host.rename(d, a, b), list: (d) => host.names(d) }, { id: `${id}r`, journal: new Journal(`${id}r`, store()) });
      const m = new Map<string, string>(); for (const i of r3.moved) m.set(joinPath(lastRens[i].dir, lastRens[i].from), joinPath(lastRens[i].dir, lastRens[i].to));
      host.after(m); cur = r3;
    };
    offerUndo(label, back, again, { ms: 12000 });
  });
  void items; moveThumbs(res.moved.map((i) => [joinPath(rens[i].dir, rens[i].from), joinPath(rens[i].dir, rens[i].to)] as [string, string]));
}
const whyText = (w: string): string => (w === 'exists' ? t('filesNameTaken') : w === 'not found' ? t('btGone') : w);

/** A run left unfinished (the app was closed in the middle): what to do with it. Called when Files opens. */
export function interruptedBanner(host: Pick<BatchHost, 'names' | 'rename' | 'after'>, into: HTMLElement): void {
  const j = readJournal(store()); if (!j) return;
  const els: HTMLElement[] = []; const done = () => { dropJournal(store()); els.forEach((e) => e.remove()); };
  const has = new Map<string, Set<string>>();
  void (async () => {
    for (const d of j.data.dirs) { const l = await host.names(d).catch(() => null); has.set(d, new Set((l ?? []).map((x) => x.toLowerCase()))); }
    const w = whereNow(j, (d, n) => has.get(d)?.has(n.toLowerCase()) ?? false);
    const go = async (way: 'finish' | 'undo') => {
      const rens = recoveryRens(j, w.at, way); done();
      if (rens.length) { const r = await runRenames(rens, { rename: (d, a, b) => host.rename(d, a, b), list: (d) => host.names(d) }, { id: `${j.data.id}${way[0]}` }); if (r.failed.length) toast(t('btPartial', { n: localDigits(r.moved.length), m: localDigits(r.failed.length), why: whyText(r.failed[0].why) }), 'error', 6000); }
      host.after(new Map());
    };
    const el = h('div', { class: 'batch-banner', role: 'status' }, icon('pen'), h('span', { class: 'grow', dir: 'auto' }, t('btInterrupted', { n: localDigits(j.data.items.length) })),
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => void go('finish') }, t('btFinish')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void go('undo') }, t('btUndoIt')), h('button', { type: 'button', class: 'btn text small', onclick: () => { done(); } }, t('btLeave')));
    els.push(el); into.prepend(el);
  })();
}

/** The sheet. */
export async function batchSheet(host: BatchHost): Promise<void> {
  const items = host.items; const n = items.length;
  const sh = openSheet(t('btTitle', { n: localDigits(n) }), t('cancel')); sh.el.classList.add('batch-sheet'); sh.body.append(h('div', { class: 'center' }, h('div', { class: 'spinner small' })));
  const dirs = [...new Set(items.map((i) => dirOf(i.path)))]; const have = new Map<string, Set<string>>();
  for (const d of dirs) { const l = await host.names(d).catch(() => null); if (l) have.set(d, new Set(l.map((x) => x.toLowerCase()))); }
  if (!sh.el.isConnected) return;
  const sortIndex = new Map<string, number>(); host.shown.forEach((x, i) => sortIndex.set(x.path, i));
  let R: Recipe = defaultRecipe(host.byHand ? 'selected' : 'sort'); let plan: Plan; let ack = false;
  const ctx = { existing: (d: string) => have.get(d), sortIndex, fmtSize: host.fmtSize };

  const sec = (title: string, ...kids: (HTMLElement | null)[]) => h('section', { class: 'batch-sec' }, h('h4', null, title), ...kids);
  const redo = (): void => { schedule(); };
  /** A row of choices: one on at a time. */
  const choice = <T extends string>(opts: [T, string][], get: () => T, set: (v: T) => void, label: string): HTMLElement => {
    const row = h('div', { class: 'chip-row batch-chips', role: 'radiogroup', 'aria-label': label }); const paint = () => row.replaceChildren(...opts.map(([v, l]) => h('button', { type: 'button', class: 'chip small' + (get() === v ? ' on' : ''), role: 'radio', 'aria-checked': String(get() === v), onclick: () => { set(v); paint(); redo(); syncVis(); } }, l)));
    paint(); (row as HTMLElement & { paint?: () => void }).paint = paint; repaints.push(paint); return row;
  };
  const repaints: (() => void)[] = []; const vis: (() => void)[] = []; const syncVis = () => vis.forEach((f) => f());
  const toggleChip = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement => { const b = h('button', { type: 'button', class: 'chip small', 'aria-pressed': 'false', onclick: () => { set(!get()); paint(); redo(); } }, label); const paint = () => { b.classList.toggle('on', get()); b.setAttribute('aria-pressed', String(get())); }; paint(); repaints.push(paint); return b; };
  const sw = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement => { const i = h('input', { type: 'checkbox', checked: get(), onchange: () => { set(i.checked); redo(); syncVis(); } }) as HTMLInputElement; repaints.push(() => { i.checked = get(); }); return h('label', { class: 'switch-row small' }, h('span', { class: 'grow' }, label), i); };
  const field = (label: string, input: HTMLElement): HTMLElement => h('label', { class: 'field batch-field' }, h('span', { class: 'label' }, label), input);
  const text = (get: () => string, set: (v: string) => void, o: { dir?: string; ph?: string } = {}): HTMLInputElement => { const i = h('input', { type: 'text', dir: o.dir ?? 'auto', placeholder: o.ph ?? '', value: get(), spellcheck: 'false', autocapitalize: 'off', oninput: () => { set(i.value); redo(); } }) as HTMLInputElement; repaints.push(() => { if (i.value !== get()) i.value = get(); }); return i; };
  const num = (get: () => number | null, set: (v: number | null) => void, o: { min?: number; ph?: string } = {}): HTMLInputElement => { const i = h('input', { type: 'number', inputmode: 'numeric', min: String(o.min ?? 0), placeholder: o.ph ?? '', value: get() === null ? '' : String(get()), oninput: () => { set(i.value === '' ? null : Math.max(o.min ?? 0, Math.floor(Number(i.value) || 0))); redo(); } }) as HTMLInputElement; repaints.push(() => { const v = get() === null ? '' : String(get()); if (i.value !== v) i.value = v; }); return i; };

  /* ----- name */
  const nameText = text(() => R.nameText, (v) => { R.nameText = v; }, { ph: t('btNameText') });
  const tokens = h('div', { class: 'chip-row batch-chips' }, ...['{name}', '{ext}', '{name.ext}', '{n}', '{n:3}', '{size}', '{date}', '{time}', '{now}'].map((v) => h('button', { type: 'button', class: 'chip small', dir: 'ltr', onclick: () => { nameText.value += v; R.nameText = nameText.value; redo(); } }, v)));
  const find = text(() => R.find, (v) => { R.find = v; }, { ph: t('filesFind') }); const repl = text(() => R.replace, (v) => { R.replace = v; }, { ph: t('filesReplaceWith') });
  const regexErr = h('p', { class: 'hint error', hidden: true });
  const nameSec = sec(t('btName'),
    choice<Recipe['nameMode']>([['keep', t('btNameKeep')], ['replace', t('btNameReplace')], ['before', t('btNameBefore')], ['after', t('btNameAfter')], ['pattern', t('btNamePattern')]], () => R.nameMode, (v) => { R.nameMode = v; }, t('btName')),
    nameText, tokens,
    h('div', { class: 'batch-pair' }, find, repl), regexErr,
    h('div', { class: 'batch-switches' }, sw(t('btRegex'), () => R.regex, (v) => { R.regex = v; }), sw(t('btMatchCase'), () => R.matchCase, (v) => { R.matchCase = v; })),
    h('div', { class: 'chip-row batch-chips' }, ...[['lower', t('btLower')], ['upper', t('btUpper')], ['title', t('btTitleCase')]].map(([v, l]) => toggleChip(l, () => R.tf.case === v, (on) => { R.tf.case = on ? (v as 'lower') : ''; })),
      toggleChip(t('btTrim'), () => R.tf.trim, (v) => { R.tf.trim = v; }), toggleChip(t('btCollapse'), () => R.tf.collapse, (v) => { R.tf.collapse = v; }),
      toggleChip(t('btSpToUs'), () => R.tf.spaces === 'toUnderscore', (on) => { R.tf.spaces = on ? 'toUnderscore' : ''; }), toggleChip(t('btUsToSp'), () => R.tf.spaces === 'toSpace', (on) => { R.tf.spaces = on ? 'toSpace' : ''; }),
      toggleChip(t('btTags'), () => R.tf.tags, (v) => { R.tf.tags = v; })));
  vis.push(() => { nameText.hidden = R.nameMode === 'keep'; tokens.hidden = R.nameMode !== 'pattern'; });

  /* ----- number */
  const start = num(() => R.num.start, (v) => { R.num.start = v ?? 0; }); const end = num(() => R.num.end, (v) => { R.num.end = v; }, { ph: '' }); const step = num(() => R.num.step, (v) => { R.num.step = Math.max(1, v ?? 1); }, { min: 1 }); const width = num(() => (R.num.pad || null), (v) => { R.num.pad = v ?? 0; }, { ph: t('btWidthAuto') });
  const sep = text(() => R.num.sep, (v) => { R.num.sep = v; }, { dir: 'auto' });
  const endNote = h('p', { class: 'hint', hidden: true }); const echo = h('p', { class: 'hint batch-echo' });
  const numBox = h('div', { class: 'batch-numbox' },
    h('div', { class: 'batch-grid4' }, field(t('btFrom'), start), field(t('btTo'), end), field(t('btStep'), step), field(t('btWidth'), width)),
    echo, endNote,
    choice<'before' | 'after'>([['before', t('btPosBefore')], ['after', t('btPosAfter')]], () => R.num.pos, (v) => { R.num.pos = v; }, t('btPos')), field(t('btSep'), sep),
    h('span', { class: 'label batch-lab' }, t('btOrder')),
    choice<NumOrder>([['selected', t('btOrderPicked')], ['sort', t('btOrderSort')], ['name', t('btOrderName')], ['date', t('btOrderDate')]], () => R.num.order, (v) => { R.num.order = v; }, t('btOrder')),
    h('p', { class: 'hint' }, t('btNumberHint')));
  const numSec = sec(t('btNumber'), sw(t('btNumberOn'), () => R.num.on, (v) => { R.num.on = v; }), numBox);
  vis.push(() => { numBox.hidden = !R.num.on; });

  /* ----- extension */
  const nameShow = h('input', { type: 'text', class: 'grow ext-name-show', readonly: true, tabindex: '-1', dir: 'auto', 'aria-label': t('btExtName') }) as HTMLInputElement;
  const extIn = text(() => R.ext.value, (v) => { R.ext.value = v; if (R.ext.mode !== 'set' && R.ext.mode !== 'add') { R.ext.mode = 'set'; } }, { dir: 'ltr', ph: t('extension') }); extIn.classList.add('ext-in'); extIn.autocapitalize = 'off';
  const extChips = h('div', { class: 'chip-row batch-chips' }, ...chipsFor(items).map((x) => h('button', { type: 'button', class: 'chip small', dir: 'ltr', onclick: () => { if (R.ext.mode !== 'add') R.ext.mode = 'set'; R.ext.value = x; extIn.value = x; repaints.forEach((f) => f()); redo(); syncVis(); } }, `.${x}`)));
  const kindBox = h('div', { class: 'batch-warn', hidden: true, role: 'alert' }); const ackSw = h('input', { type: 'checkbox', onchange: () => { ack = ackSw.checked; redo(); } }) as HTMLInputElement;
  const kindAck = h('label', { class: 'switch-row small', hidden: true }, h('span', { class: 'grow' }, t('btKindAck')), ackSw); const foldersNote = h('p', { class: 'hint', hidden: true });
  const extSec = sec(t('btExt'),
    choice<Recipe['ext']['mode']>([['keep', t('btExtKeep')], ['set', t('btExtSet')], ['add', t('btExtAdd')], ['remove', t('btExtRemove')], ['lower', t('btExtLower')], ['upper', t('btExtUpper')]], () => R.ext.mode, (v) => { R.ext.mode = v; }, t('btExt')),
    nameDotExt(nameShow, extIn), extChips,
    h('p', { class: 'hint' }, t('btExtOnly')), kindBox, kindAck, foldersNote);
  vis.push(() => { const on = R.ext.mode === 'set' || R.ext.mode === 'add'; extIn.disabled = !on; extChips.hidden = !on; });

  /* ----- clashes, presets */
  const clashSec = sec(t('btClash'), choice<Recipe['clash']>([['stop', t('btClashStop')], ['skip', t('btClashSkip')], ['number', t('btClashNumber')]], () => R.clash, (v) => { R.clash = v; }, t('btClash')));
  const presetBox = h('div', { class: 'chip-row batch-chips' });
  const drawPresets = () => {
    const ps = presets();
    presetBox.replaceChildren(...ps.map((p) => h('span', { class: 'chip-pair' },
      h('button', { type: 'button', class: 'chip small', onclick: () => { R = JSON.parse(JSON.stringify(p.recipe)) as Recipe; if (!host.byHand && R.num.order === 'selected') R.num.order = 'sort'; ack = false; ackSw.checked = false; repaints.forEach((f) => f()); syncVis(); redo(); } }, p.name),
      iconButton('close', t('btPresetDelete', { name: p.name }), () => { savePresets(presets().filter((x) => x.name !== p.name)); drawPresets(); }))),
    ...(ps.length ? [] : [h('span', { class: 'hint' }, t('btPresetNone'))]));
  };
  const presetName = h('input', { type: 'text', dir: 'auto', placeholder: t('btPresetName'), maxlength: '40' }) as HTMLInputElement;
  const presetSave = h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const nm = presetName.value.trim(); if (!nm) { presetName.focus(); return; } savePresets([...presets().filter((x) => x.name !== nm), { name: nm, recipe: JSON.parse(JSON.stringify(R)) as Recipe }]); presetName.value = ''; drawPresets(); toast(t('btPresetSaved', { name: nm })); } }, icon('bookmark'), t('btPresetSave'));
  const presetSec = sec(t('btPresets'), presetBox, h('div', { class: 'batch-preset-new' }, presetName, presetSave)); drawPresets();

  /* ----- the preview, drawn a screenful at a time */
  const sumLine = h('p', { class: 'batch-sum', role: 'status' }); const prevBox = h('div', { class: 'batch-prev', tabindex: '0', role: 'list', 'aria-label': t('btPreview') }); const spacer = h('div', { class: 'batch-prev-sp' }); prevBox.append(spacer);
  let from = -1, to = -1; const live = new Map<number, HTMLElement>();
  const flagText = (x: Row): string[] => { const f = x.flags; const out: string[] = []; if (f.empty) out.push(t('btFlagEmpty')); if (f.clashExisting) out.push(t('btFlagClashExisting')); if (f.clashResult) out.push(t('btFlagClashResult')); if (f.illegal) out.push(t('btFlagIllegal')); if (f.tooLong) out.push(t('btFlagTooLong')); if (f.hidden) out.push(t('btFlagHidden')); if (f.resolved === 'skip') out.push(t('btFlagSkipped')); if (f.resolved === 'number') out.push(t('btFlagNumbered')); if (f.folderExt && x.action === 'skip' && x.flags.unchanged) out.push(t('btFlagFolderExt')); else if (f.unchanged) out.push(t('btFlagUnchanged')); return out; };
  const rowEl = (x: Row, k: number): HTMLElement => {
    const bad = blocks(x, R.clash); const flags = flagText(x); const warn = !bad && flags.length && !x.flags.unchanged;
    const oldEl = h('span', { class: 'batch-old' }); setName(oldEl, x.from); const newEl = h('span', { class: 'batch-new' }); setName(newEl, x.action === 'rename' || x.flags.resolved ? x.to : x.flags.empty ? '' : x.from);
    return h('div', { class: 'batch-row' + (bad ? ' bad' : warn ? ' warn' : '') + (x.action === 'skip' ? ' skip' : '') + (flags.length ? ' has-flags' : ''), role: 'listitem', title: flags.join(' · ') || undefined, style: { transform: `translateY(${k * ROW_H}px)`, height: `${ROW_H}px` } },
      h('span', { class: 'batch-n', 'aria-label': t('btPicked', { n: localDigits(x.picked) }) }, localDigits(x.picked)),
      h('span', { class: 'batch-names' }, oldEl, h('span', { class: 'batch-line' }, h('span', { class: 'batch-arrow', 'aria-hidden': 'true' }, '→'), newEl), ...(flags.length ? [h('small', { class: 'batch-flags' }, flags.join(' · '))] : [])));
  };
  const paintRows = (force = false) => {
    const rows = plan.rows; const top = prevBox.scrollTop; const hgt = prevBox.clientHeight || 360; const a = Math.max(0, Math.floor(top / ROW_H) - 4); const b = Math.min(rows.length, Math.ceil((top + hgt) / ROW_H) + 4);
    if (!force && a === from && b === to) return; from = a; to = b;
    for (const [k, el] of live) if (k < a || k >= b || force) { el.remove(); live.delete(k); }
    const frag = document.createDocumentFragment(); for (let k = a; k < b; k++) if (!live.has(k)) { const el = rowEl(rows[k], k); live.set(k, el); frag.append(el); } prevBox.append(frag);
  };
  prevBox.addEventListener('scroll', () => requestAnimationFrame(() => paintRows()));
  const go = h('button', { type: 'button', class: 'btn primary', onclick: () => void start_() }, icon('pen'), t('rename')) as HTMLButtonElement;

  const recompute = (): void => {
    plan = planBatch(items, R, ctx); const s = plan.summary;
    const f0 = plan.rows.find((r) => !r.item.dir) ?? plan.rows[0]; const [stem0, ext0] = f0 ? splitExt(f0.to || f0.from, f0.item.dir) : ['', ''];
    nameShow.value = stem0; nameShow.dir = nameDir(stem0); extIn.placeholder = ext0 || t('extension');
    if (R.ext.mode !== 'set' && R.ext.mode !== 'add' && document.activeElement !== extIn) extIn.value = R.ext.mode === 'keep' ? '' : ext0;
    sumLine.replaceChildren(h('span', null, t('btToRename', { n: localDigits(s.rename) })), h('span', null, t('btSkipped', { n: localDigits(s.skipped + s.unchanged) })), h('span', { class: s.blocking ? 'bad' : '' }, t('btProblems', { n: localDigits(s.blocking) })), ...(s.warnings ? [h('span', null, t('btWarnings', { n: localDigits(s.warnings) }))] : []));
    regexErr.hidden = !plan.error; regexErr.textContent = plan.error ? t('btRegexBad', { why: plan.error }) : '';
    echo.textContent = R.num.on ? t('btEcho', { from: localDigits(R.num.start), to: localDigits(plan.last) }) : '';
    endNote.hidden = !plan.endShort; endNote.textContent = plan.endShort ? t('btEndShort', { last: localDigits(plan.last) }) : '';
    const kc = R.ext.mode === 'set' || R.ext.mode === 'add' ? plan.kindChanges : 0; kindBox.hidden = kindAck.hidden = !kc; if (kc) kindBox.textContent = t('btKindWarn', { n: localDigits(kc) }); if (!kc) { ack = false; ackSw.checked = false; }
    foldersNote.hidden = !(R.ext.mode !== 'keep' && plan.folderExt.length); if (!foldersNote.hidden) foldersNote.textContent = t('btFoldersSkipped', { names: plan.folderExt.slice(0, 3).join(', ') + (plan.folderExt.length > 3 ? ` +${localDigits(plan.folderExt.length - 3)}` : '') });
    spacer.style.height = `${plan.rows.length * ROW_H}px`; from = to = -1; paintRows(true);
    go.replaceChildren(icon('pen'), t('btRename', { n: localDigits(s.rename) }));
    go.disabled = !!plan.error || s.blocking > 0 || s.rename === 0 || (kc > 0 && !ack);
    (sh.el as HTMLElement).dataset.rows = String(live.size);
  };
  let pending = 0; const schedule = () => { if (pending) return; pending = requestAnimationFrame(() => { pending = 0; recompute(); }); };

  const start_ = async (): Promise<void> => {
    const rows = plan.rows.filter((r) => r.action === 'rename'); if (!rows.length) return;
    sh.close(); const rens: Ren[] = rows.map((r) => ({ dir: r.dir, from: r.from, to: r.to })); await runBatch(host, items, rens, rows.map((r) => r.i));
  };

  sh.body.replaceChildren(h('div', { class: 'batch' }, h('div', { class: 'batch-opts' }, nameSec, numSec, extSec, clashSec, presetSec), h('div', { class: 'batch-side' }, h('h4', null, t('btPreview')), sumLine, prevBox)));
  sh.actions.append(go);
  syncVis(); recompute();
  // (The preview's own height settled: drawn again once the sheet is in place.)
  requestAnimationFrame(() => paintRows(true));
}
