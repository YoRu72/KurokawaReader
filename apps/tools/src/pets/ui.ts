// Settings → Pets (a computer only) and its sheets: «Add a pet» (choose a folder or a zip of the user's own; the
// «Suggested» links, his to edit, opened in the browser — nothing fetched, hosted or pictured by the app — with the
// steps of a manual import), the mapping of «a folder of frames» with a live preview, the library (rename, remove,
// shown or not — up to three —, credit and licence). The app carries no pet: until one is added, the card holds only
// «Add a pet».
import { h, icon, iconButton, openSheet, pickButton, toast } from '../ui/dom';
import { t, localDigits, formatBytes } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { openExternal } from '../native';
import { petPrefs, cleanLink, linkHost, plain, MAX_ACTIVE, type PetPrefs } from './prefs';
import type { PetState } from './model';
import type { PackFile, ImportResult } from './source';
import type { FrameGroup } from './frames';

const row = (label: string, control: Node, hint?: string) => h('div', { class: 'row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), control);
const toggle = (label: string, on: boolean, set: (v: boolean) => void, hint?: string, cls?: string) => { const c = h('input', { type: 'checkbox', class: cls, checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }); return h('label', { class: 'row switch-row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), c); };
const prefs = (): PetPrefs => petPrefs(getSettings().pets);
const setPrefs = (o: Partial<PetPrefs>): void => { updateSettings({ pets: { ...prefs(), ...o } }); };
const isTauri = () => (window as unknown as { __KT_SHELL__?: string }).__KT_SHELL__ === 'tauri';
const STATE_LABEL = (s: PetState): string => t(({ idle: 'petsStateIdle', walk: 'petsStateWalk', sit: 'petsStateSit', sleep: 'petsStateSleep', fall: 'petsStateFall', dragged: 'petsStateDragged', click: 'petsStateClick', thrown: 'petsStateFall', climb: 'petsStateWalk' } as const)[s]);

/** The card (Settings → Pets). */
export function petsCard(rerender: () => void): HTMLElement {
  const p = prefs();
  // (The rows go straight into the card, as every settings card's: a placeholder until the library is read.)
  const lib = h('div', { class: 'row pet-wait' });
  const card = h('section', { class: 'card', id: 'pets' }, h('h3', null, t('petsTitle')), h('p', { class: 'hint' }, t('petsHint')), lib);
  const addBtn = (filled: boolean) => h('button', { type: 'button', class: `btn ${filled ? 'filled' : 'tonal'} small pet-add`, onclick: () => addPetSheet(rerender) }, icon('plus'), t('petsAdd'));
  void import('./store').then(async (st) => {
    const list = await st.listPets();
    const caps = await import('./boot').then((m) => m.desktopCaps());
    if (!card.isConnected && !document.contains(card)) { /* drawn later */ }
    if (!list.length) { lib.replaceWith(h('div', { class: 'row pet-empty' }, h('span', null, t('petsAdd'), h('small', { class: 'src' }, t('petsEmptyHint'))), addBtn(true))); return; }
    const active = p.active.filter((id) => list.some((x) => x.id === id));
    const rows = list.map((e) => {
      const thumb = h('span', { class: 'pet-thumb' });
      void st.frameBlob(e.id, 0).then((b) => { if (!b) return; const u = URL.createObjectURL(b); const im = h('img', { alt: '', src: u }); im.onload = im.onerror = () => URL.revokeObjectURL(u); thumb.append(im); });
      const on = active.includes(e.id);
      const sw = h('input', { type: 'checkbox', class: 'pet-shown', checked: on, 'aria-label': t('petsShown'), onchange: (ev: Event) => {
        const want = (ev.target as HTMLInputElement).checked; const cur = prefs().active.filter((id) => list.some((x) => x.id === id));
        if (want && cur.length >= MAX_ACTIVE) { (ev.target as HTMLInputElement).checked = false; toast(t('petsMax3')); return; }
        setPrefs({ active: want ? [...cur, e.id] : cur.filter((x) => x !== e.id), on: want ? true : prefs().on }); rerender();
      } });
      return h('div', { class: 'row pet-row', 'data-pet': e.id }, thumb,
        h('span', { class: 'grow' }, h('b', { dir: 'auto' }, e.name), h('small', { class: 'src' }, [e.credit ? t('petsCredit', { who: e.credit }) : t(({ pet: 'petsSourcePet', shimeji: 'petsSourceShimeji', frames: 'petsSourceFrames' } as const)[e.source]), t('petsFrames', { n: localDigits(e.frames) }), formatBytes(e.bytes)].join(' · '))),
        h('label', { class: 'switch-row pet-shown-label' }, h('span', { class: 'src' }, t('petsShown')), sw),
        iconButton('more', t('petsMore'), (ev) => petMenu(e, ev, rerender)));
    });
    lib.replaceWith(
      toggle(t('petsOn'), p.on && active.length > 0, (v) => { if (v && !active.length) { toast(t('petsPickOne')); rerender(); return; } setPrefs({ on: v }); rerender(); }, t('petsOnHint'), 'pets-on'),
      h('h4', null, t('petsLibrary')), ...rows, h('div', { class: 'row-actions' }, addBtn(false)), ...optionRows(p, rerender, caps));
  }).catch(() => lib.replaceWith(addBtn(true)));
  return card;
}
function optionRows(p: PetPrefs, rerender: () => void, caps: { desktop: boolean; follow: boolean; why: string }): HTMLElement[] {
  // (On the desktop: where the shell can place the pet's own window — not on Wayland itself, not the Tauri build on a
  // Mac, whose windows cannot be transparent without a private API: there a line says why, and the pets stay in the app.)
  const desk = caps.desktop;
  const out: HTMLElement[] = [h('h4', null, t('petsBehaviour'))];
  if (!desk && (caps.why === 'wayland' || caps.why === 'transparency')) out.push(row(t('petsWhere'), h('span', { class: 'src' }, t('petsWhereApp')), t(caps.why === 'wayland' ? 'petsNoDesktopWayland' : 'petsNoDesktopMac')));
  if (desk) out.push(row(t('petsWhere'), pickButton(t('petsWhere'), [['app', t('petsWhereApp')], ['desktop', t('petsWhereDesktop')]], p.where, (v) => { setPrefs({ where: v }); rerender(); }, t('close')), p.where === 'desktop' ? t('petsWhereDesktopHint') : t('petsWhereAppHint')));
  // (Following the active window needs the Tauri shell's native code; Electron has no way without an addon: no row.)
  if (desk && caps.follow && p.where === 'desktop') out.push(toggle(t('petsFollow'), p.follow, (v) => setPrefs({ follow: v }), t('petsFollowHint')));
  out.push(row(t('petsSize'), pickButton(t('petsSize'), [['S', t('petsSizeS')], ['M', t('petsSizeM')], ['L', t('petsSizeL')], ['custom', t('petsSizeCustom')]], p.size, (v) => { setPrefs({ size: v }); rerender(); }, t('close'))));
  if (p.size === 'custom') {
    const val = h('b', { class: 'pet-scale-val' }, `${localDigits(Math.round(p.custom * 100))}%`);
    const r = h('input', { type: 'range', min: '0.25', max: '4', step: '0.05', value: String(p.custom), 'aria-label': t('petsScale'), oninput: (e: Event) => { val.textContent = `${localDigits(Math.round(Number((e.target as HTMLInputElement).value) * 100))}%`; }, onchange: (e: Event) => setPrefs({ custom: Number((e.target as HTMLInputElement).value) }) });
    out.push(row(t('petsScale'), h('span', { class: 'row-actions pet-scale' }, r, val)));
  }
  out.push(row(t('petsActivity'), pickButton(t('petsActivity'), [['calm', t('petsCalm')], ['normal', t('petsNormal')], ['lively', t('petsLively')]], p.activity, (v) => setPrefs({ activity: v }), t('close'))));
  out.push(toggle(t('petsChase'), p.chase, (v) => setPrefs({ chase: v }), t('petsChaseHint')));
  out.push(toggle(t('petsPauseVideo'), p.pauseVideo, (v) => setPrefs({ pauseVideo: v })));
  out.push(toggle(t('petsPauseBattery'), p.pauseBattery, (v) => setPrefs({ pauseBattery: v })));
  out.push(toggle(t('petsSpeech'), p.speech, (v) => setPrefs({ speech: v }), t('petsSpeechHint')));
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) out.push(h('p', { class: 'hint' }, t('petsReducedHint')));
  return out;
}
function petMenu(e: { id: string; name: string; credit: string; licence: string }, ev: Event, rerender: () => void): void {
  const x = openSheet(e.name, t('close'), { at: ev });
  const item = (ic: string, label: string, run: () => void, danger = false) => h('button', { type: 'button', class: 'dest-row' + (danger ? ' danger' : ''), onclick: () => { x.close(); run(); } }, icon(ic), h('span', null, label));
  x.body.append(h('div', { class: 'dest-list' },
    item('pen', t('petsRename'), () => renameSheet(e, rerender)),
    item('info', t('petsAbout'), () => aboutSheet(e)),
    item('trash', t('petsRemove'), () => { const y = openSheet(t('petsRemove'), t('close')); y.body.append(h('p', null, t('petsRemoveAsk', { name: e.name }))); y.actions.append(h('button', { type: 'button', class: 'btn text', onclick: () => y.close() }, t('cancel')), h('button', { type: 'button', class: 'btn filled danger', onclick: async () => { y.close(); const st = await import('./store'); await st.removePet(e.id); setPrefs({ active: prefs().active.filter((a) => a !== e.id) }); rerender(); } }, icon('trash'), t('petsRemove'))); }, true)));
}
function renameSheet(e: { id: string; name: string }, rerender: () => void): void {
  const x = openSheet(t('petsRename'), t('close'));
  const inp = h('input', { type: 'text', value: e.name, maxlength: '80', dir: 'auto', 'aria-label': t('petsName') }) as HTMLInputElement;
  x.body.append(h('label', { class: 'field' }, h('span', { class: 'label' }, t('petsName')), inp));
  x.actions.append(h('button', { type: 'button', class: 'btn filled', onclick: async () => { const st = await import('./store'); await st.renamePet(e.id, inp.value); x.close(); rerender(); } }, icon('check'), t('petsSave')));
  setTimeout(() => inp.select(), 50);
}
function aboutSheet(e: { name: string; credit: string; licence: string }): void {
  const x = openSheet(e.name, t('close'));
  x.body.append(h('div', { class: 'pet-about' },
    h('h4', null, t('petsCreditTitle')), h('p', { dir: 'auto' }, e.credit || t('petsNoCredit')),
    h('h4', null, t('petsLicence')), e.licence ? h('pre', { class: 'pet-licence', dir: 'auto' }, e.licence) : h('p', null, t('petsNoLicence'))));
}

/* ---------- «Add a pet» ---------- */
export function addPetSheet(rerender: () => void): void {
  // (A long import can be stopped: the button beside its progress, or the sheet closed.)
  let job: AbortController | null = null;
  const x = openSheet(t('petsAdd'), t('close'), { onClose: () => job?.abort() });
  const busyText = h('span', { 'aria-live': 'polite' });
  const stop = h('button', { type: 'button', class: 'btn text small', hidden: true, onclick: () => job?.abort() }, t('cancel')) as HTMLButtonElement;
  const busy = h('p', { class: 'hint pet-busy' }, busyText, stop);
  // (The loader fetched as the sheet opens: the chooser then opens within the click.)
  const ldP = import('./load');
  const run = (pick: (ld: typeof import('./load')) => Promise<PackFile[] | null>) => async () => {
    let files: PackFile[] | null = null;
    try { files = await pick(await ldP); } catch (err) { toast(errText(err), 'error', 6000); return; }
    if (!files) return; job?.abort(); const me = (job = new AbortController()); busyText.textContent = t('petsReading'); stop.hidden = false; busy.classList.add('on');
    try { await importFiles(files, (m) => { busyText.textContent = m; }, () => { x.close(); rerender(); }, me.signal); } catch (err) { if (!me.signal.aborted) toast(errText(err), 'error', 7000); }
    finally { if (job === me) { job = null; busyText.textContent = ''; stop.hidden = true; busy.classList.remove('on'); } }
  };
  const links = h('div', { class: 'pet-links' });
  const drawLinks = () => {
    const p = prefs();
    links.replaceChildren(...p.links.map((l, i) => h('div', { class: 'row pet-link' },
      h('span', { class: 'grow' }, h('b', { dir: 'auto' }, plain(l.title)), h('span', { class: 'pet-link-host', dir: 'ltr' }, linkHost(l.url)), h('small', { class: 'src', dir: 'ltr' }, plain(l.url))),
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => void openExternal(l.url) }, icon('external'), t('petsOpenLink')),
      iconButton('trash', t('petsRemoveLink'), () => { setPrefs({ links: p.links.filter((_, j) => j !== i) }); drawLinks(); }))),
      ...(p.links.length ? [] : [h('p', { class: 'hint' }, t('petsNoLinks'))]), addLinkForm(drawLinks));
  };
  drawLinks();
  x.body.append(h('div', { class: 'pet-import' },
    h('p', null, t('petsImportIntro')),
    h('div', { class: 'row-actions pet-pick' },
      h('button', { type: 'button', class: 'btn filled', onclick: () => void run((ld) => ld.pickFolder())() }, icon('folder'), t('petsChooseFolder')),
      h('button', { type: 'button', class: 'btn tonal', onclick: () => void run((ld) => ld.pickZip())() }, icon('archive'), t('petsChooseZip'))),
    h('small', { class: 'src' }, t('petsFormats')), busy,
    h('h4', null, t('petsSuggested')),
    h('p', { class: 'pet-allowed' }, icon('info'), h('span', null, t('petsAllowed'))),
    h('p', { class: 'hint' }, t('petsSuggestedHint')), links,
    h('h4', null, t('petsHowTitle')),
    h('ol', { class: 'pet-steps' }, ...(['petsHow1', 'petsHow2', 'petsHow3', 'petsHow4', 'petsHow5'] as const).map((k) => h('li', null, t(k))))));
}
function addLinkForm(redraw: () => void): HTMLElement {
  const box = h('div', { class: 'pet-link-form' });
  const closed = () => box.replaceChildren(h('button', { type: 'button', class: 'btn text small', onclick: open }, icon('plus'), t('petsAddLink')));
  function open(): void {
    const title = h('input', { type: 'text', maxlength: '80', dir: 'auto', placeholder: t('petsLinkTitle'), 'aria-label': t('petsLinkTitle') }) as HTMLInputElement;
    const url = h('input', { type: 'url', maxlength: '500', dir: 'ltr', placeholder: 'https://…', 'aria-label': t('petsLinkUrl') }) as HTMLInputElement;
    const err = h('small', { class: 'src pet-link-err', 'aria-live': 'polite' });
    box.replaceChildren(h('label', { class: 'field' }, h('span', { class: 'label' }, t('petsLinkTitle')), title), h('label', { class: 'field' }, h('span', { class: 'label' }, t('petsLinkUrl')), url), err,
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn text small', onclick: closed }, t('cancel')), h('button', { type: 'button', class: 'btn filled small', onclick: () => {
        const l = cleanLink(title.value, url.value); if (!l) { err.textContent = t('petsLinkBad'); return; }
        setPrefs({ links: [...prefs().links, l].slice(0, 20) }); redraw();
      } }, icon('check'), t('petsSave'))));
    setTimeout(() => title.focus(), 30);
  }
  closed(); return box;
}
function errText(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/tooManyFiles/.test(m)) return t('petsErrTooMany');
  if (/tooBig|tooManyPixels/.test(m)) return t('petsErrTooBig');
  if (/tooManyFrames|frameTooBig/.test(m)) return t('petsErrFrames');
  if (/badPicture|encode/.test(m)) return t('petsErrPicture');
  if (/notZip/.test(m)) return t('petsErrNotZip');
  if (/tooComplex/.test(m)) return t('petsErrComplex');
  if (/libraryFull/.test(m)) return t('petsErrLibraryFull');
  if (/badCell|badFrame/.test(m)) return t('petsErrFrames');
  if (/noPictures|noFrames|nothing/.test(m)) return t('petsErrNothing');
  return t('petsErrBad', { why: m.replace(/^[a-zA-Z]+:/, '').slice(0, 80) });
}
/** A pack read: our format, a Shimeji pack, or a folder of frames (the mapping screen); then kept and shown. */
async function importFiles(raw: PackFile[], say: (m: string) => void, done: () => void, signal?: AbortSignal): Promise<void> {
  const [src, model] = await Promise.all([import('./source'), import('./model')]);
  const report = model.newReport(); const files = src.cleanFiles(raw, report);
  const pj = await import('./petJson');
  if (pj.findPetJson(files)) { const r = pj.fromPetJson(files); mergeReport(r, report); await keep(r, files, say, signal); done(); return; }
  const sh = await import('./shimeji');
  if (sh.isShimeji(files)) {
    const chars = sh.shimejiCharacters(files);
    const go = async (c: string) => { const r = sh.fromShimeji(files, c); mergeReport(r, report); await keep(r, files, say, signal); done(); };
    if (chars.length > 1) { await new Promise<void>((res) => { const x = openSheet(t('petsCharacter'), t('close'), { stack: true, onClose: () => res() }); x.body.append(h('div', { class: 'dest-list' }, ...chars.map((c) => h('button', { type: 'button', class: 'dest-row', onclick: () => { x.close(); void go(c).catch((e) => toast(errText(e), 'error', 7000)); } }, icon('image'), h('span', { dir: 'auto' }, c))))); }); return; }
    await go(chars[0]); return;
  }
  const fr = await import('./frames');
  const groups = fr.groupFrames(files); if (!groups.length) throw new Error('nothing');
  const root = raw[0]?.path.includes('/') ? raw[0].path.split('/')[0] : '';
  mappingSheet(files, groups, root, report, done);
}
function mergeReport(r: ImportResult, extra: { skipped: string[]; notes: string[] }): void { r.report.skipped.unshift(...extra.skipped); r.report.notes.unshift(...extra.notes); }
async function keep(r: ImportResult, files: PackFile[], say: (m: string) => void, signal?: AbortSignal): Promise<void> {
  const ld = await import('./load'); const st = await import('./store');
  say(t('petsMaking', { n: localDigits(r.frames.length) }));
  const { blobs, sizes } = await ld.makeFrames(r.frames, files, (d, n) => say(t('petsMakingOf', { n: localDigits(d), all: localDigits(n) })), signal);
  let fw = 0, fh = 0; for (const s of sizes) { fw = Math.max(fw, s[0]); fh = Math.max(fh, s[1]); }
  if (r.pack.source !== 'pet') { r.pack.frameW = fw; r.pack.frameH = fh; if (r.pack.source === 'frames') r.pack.anchor = [fw / 2, fh]; }
  const e = await st.addPet(r.pack, blobs, sizes);
  const p = prefs(); const active = p.active.length < MAX_ACTIVE ? [...p.active, e.id] : p.active;
  setPrefs({ active, on: active.includes(e.id) ? true : p.on });
  const n = r.report.skipped.length + r.report.notes.length;
  toast(t('petsAdded', { name: e.name }), 'info', 6000, n ? { label: t('petsReport'), run: () => reportSheet(r) } : undefined);
}
function reportSheet(r: ImportResult): void {
  const x = openSheet(t('petsReport'), t('close'));
  x.body.append(h('p', { class: 'hint' }, t('petsReportHint')),
    ...(r.report.skipped.length ? [h('h4', null, t('petsSkipped', { n: localDigits(r.report.skipped.length) }))] : []),
    h('ul', { class: 'pet-report', dir: 'ltr' }, ...r.report.skipped.slice(0, 80).map((s) => h('li', null, s)), ...r.report.notes.slice(0, 40).map((s) => h('li', { class: 'src' }, s))));
}

/* ---------- the mapping of a folder of frames ---------- */
const MAP_STATES: PetState[] = ['idle', 'walk', 'sit', 'sleep', 'fall', 'dragged', 'click'];
function mappingSheet(files: PackFile[], groups: FrameGroup[], root: string, report: { skipped: string[]; notes: string[] }, done: () => void): void {
  const job = new AbortController();
  const x = openSheet(t('petsMapTitle'), t('close'), { onClose: () => { job.abort(); stopPreview(); } });
  x.el.classList.add('pet-map-sheet');
  let mapping: Partial<Record<PetState, string>> = {}; let fps = 8; let facing: 'left' | 'right' = 'right';
  void import('./frames').then((fr) => { mapping = fr.suggestMapping(groups); draw(); });
  const name = h('input', { type: 'text', maxlength: '80', dir: 'auto', value: root || 'Pet', 'aria-label': t('petsName') }) as HTMLInputElement;
  const rows = h('div', { class: 'pet-map-rows' });
  const preview = h('div', { class: 'pet-preview', role: 'img', 'aria-label': t('petsPreview') });
  const opts: [string, string][] = [['', t('petsMapNone')], ...groups.map((g) => [g.key, `${g.label} · ${localDigits(g.frames.length)}`] as [string, string])];
  // The live preview: each state's frames, drawn at the chosen speed (one timer, stopped with the sheet).
  const cache = new Map<string, Promise<ImageBitmap[]>>(); let queue: Promise<unknown> = Promise.resolve(); let timer = 0; let tiles: { cv: HTMLCanvasElement; ims: ImageBitmap[] }[] = []; let tick = 0;
  function stopPreview(): void { clearInterval(timer); timer = 0; for (const p of cache.values()) void p.then((ims) => ims.forEach((i) => i.close())).catch(() => undefined); cache.clear(); }
  const framesOf = (key: string): Promise<ImageBitmap[]> => {
    let p = cache.get(key); if (p) return p;
    const g = groups.find((y) => y.key === key)!;
    // (One group at a time, each checked against the limits before it is decoded; stopped with the sheet.)
    p = (queue = queue.catch(() => undefined).then(() => import('./load')).then((ld) => ld.makeFrames(g.frames.slice(0, 24), files, undefined, job.signal)).then(async ({ blobs }) => { const out: ImageBitmap[] = []; for (const b of blobs) out.push(await createImageBitmap(b)); return out; })) as Promise<ImageBitmap[]>;
    cache.set(key, p); return p;
  };
  const drawPreview = async () => {
    const want = MAP_STATES.filter((s) => mapping[s]);
    const made: { s: PetState; ims: ImageBitmap[] }[] = []; for (const s of want) made.push({ s, ims: await framesOf(mapping[s]!).catch(() => [] as ImageBitmap[]) });
    if (!preview.isConnected) return;
    tiles = []; preview.replaceChildren(...made.map(({ s, ims }) => { const cv = h('canvas', { width: '72', height: '72', class: 'pet-tile-cv' }) as HTMLCanvasElement; tiles.push({ cv, ims }); return h('figure', { class: 'pet-tile' }, cv, h('figcaption', null, STATE_LABEL(s))); }));
    clearInterval(timer); timer = window.setInterval(paint, 1000 / fps); paint();
  };
  function paint(): void {
    if (!preview.isConnected) { clearInterval(timer); timer = 0; return; }
    tick++;
    for (const { cv, ims } of tiles) { const c = cv.getContext('2d')!; c.clearRect(0, 0, 72, 72); const im = ims[tick % Math.max(1, ims.length)]; if (!im) continue; const k = Math.min(64 / im.width, 64 / im.height); const w = im.width * k, hh = im.height * k; c.save(); if (facing === 'left') { c.translate(72, 0); c.scale(-1, 1); } c.imageSmoothingEnabled = k < 1.5; c.drawImage(im, (72 - w) / 2, 72 - hh - 2, w, hh); c.restore(); }
  }
  function draw(): void {
    rows.replaceChildren(...MAP_STATES.map((s) => row(STATE_LABEL(s), pickButton(STATE_LABEL(s), opts, mapping[s] ?? '', (v) => { mapping = { ...mapping, [s]: v || undefined }; void drawPreview(); }, t('close')))));
    void drawPreview();
  }
  x.body.append(h('p', { class: 'hint' }, t('petsMapHint')),
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('petsName')), name),
    preview, rows,
    row(t('petsMapFps'), pickButton(t('petsMapFps'), [['4', localDigits(4)], ['6', localDigits(6)], ['8', localDigits(8)], ['10', localDigits(10)], ['12', localDigits(12)], ['16', localDigits(16)]], String(fps), (v) => { fps = Number(v); void drawPreview(); }, t('close'))),
    row(t('petsMapFacing'), pickButton(t('petsMapFacing'), [['right', t('petsFacingRight')], ['left', t('petsFacingLeft')]], facing, (v) => { facing = v as 'left'; paint(); }, t('close')), t('petsMapFacingHint')));
  const save = h('button', { type: 'button', class: 'btn filled', onclick: async () => {
    if (!mapping.idle && !mapping.walk) { toast(t('petsMapNeed'), 'error'); return; }
    save.disabled = true;
    try {
      const fr = await import('./frames');
      const r = fr.buildFromMapping(files, groups, mapping, { name: name.value.trim() || 'Pet', facing, fps: Object.fromEntries(MAP_STATES.map((s) => [s, fps])) });
      mergeReport(r, report); await keep(r, files, () => undefined, job.signal); x.close(); done();
    } catch (err) { if (!job.signal.aborted) toast(errText(err), 'error', 7000); save.disabled = false; }
  } }, icon('check'), t('petsSave')) as HTMLButtonElement;
  x.actions.append(h('button', { type: 'button', class: 'btn text', onclick: () => x.close() }, t('cancel')), save);
}
