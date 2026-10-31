// The extraction sheet, HatchZip's way: what the archive holds; a space plan before anything changes (free at the
// destination, what a normal extraction needs, what in place needs with the safety margin, what is left after);
// where it goes («here» puts a single top-level item beside the archive and several into a folder named after
// it); in place when space is short (ZIP and tar: the archive shrinks as files come out, resumable after a stop
// or a crash; or given up, the rest becoming a normal archive again); what to do with files already there (how
// many are counted first); every checksum read first when asked; a Test that writes nothing. Several archives
// go one after another. Also the sheet that makes a zip.
import { h, icon, toast, openSheet, pickButton } from '../ui/dom';
import { t, formatBytes, countFiles, localDigits } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { nativePlatform, openFolder, canOpenFolder } from '../native';
import { listArchive, extractArchiveJob, cancelArchive, createZip, pickFiles, parentOf, baseName, stem, testArchiveJob, restoreArchive, freeSpaceAt, existingIn, topLevel, type ArchiveInfo } from '../archives';

/** The margin an extraction in place never uses: the setting, or 2 GB on a computer and 512 MB on a phone. */
export const keepFreeNow = (): number => { const k = getSettings().archiveKeepFree; return k >= 0 ? k : nativePlatform() === 'desktop' ? 2 * 1024 ** 3 : 512 * 1024 ** 2; };
const errText = (m: string): string => {
  if (m === 'noSpace') return t('noSpace'); if (m === 'notArchive') return t('notAnArchive');
  const [k, ...rest] = m.split(' '); const what = rest.join(' ');
  return k === 'unsafePath' ? t('archiveUnsafe', { name: what }) : k === 'duplicateEntry' ? t('archiveDuplicate', { name: what }) : k === 'damaged' ? t('archiveDamaged', { names: what }) : k === 'sfvMismatch' ? t('archiveSfvBad', { names: what }) : k === 'crcMismatch' ? t('archiveDamaged', { names: what }) : m;
};

export async function extractSheet(path: string, opts: { onDone?: (dest: string) => void; queue?: string[] } = {}): Promise<void> {
  const sh = openSheet(baseName(path), t('close'));
  sh.body.append(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  let info: ArchiveInfo; let password = '';
  const load = async () => { try { info = await listArchive(path, password || undefined); draw(); } catch (e) { const m = String((e as Error).message ?? e); if (/password/i.test(m)) { drawPassword(m); return; } sh.body.replaceChildren(h('p', { class: 'empty small' }, errText(m))); } };
  const drawPassword = (why: string) => { const pw = h('input', { type: 'password', dir: 'ltr', autocomplete: 'off' }) as HTMLInputElement; sh.body.replaceChildren(h('p', { class: 'hint' }, /wrong/i.test(why) ? t('wrongPassword') : t('passwordNeeded')), h('label', { class: 'field' }, h('span', null, t('password')), pw)); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: () => { password = pw.value; void load(); } }, t('open'))); };
  let destMode: 'here' | 'folder' | 'other' = 'here'; let other = ''; let inPlace = false; let replace: 'replace' | 'skip' | 'both' = 'both'; let deleteAfter = false; let verifyFirst = getSettings().archiveVerifyFirst;
  const destOf = () => (destMode === 'here' ? (topLevel(info.entries) === 'one' ? parentOf(path) : `${parentOf(path)}/${stem(baseName(path))}`) : destMode === 'folder' ? `${parentOf(path)}/${stem(baseName(path))}` : other);
  const draw = () => {
    const files = info.entries.filter((e) => !e.dir);
    if (info.unsafe) { sh.body.replaceChildren(h('p', { class: 'empty small' }, t('archiveUnsafe', { name: info.unsafe }))); sh.actions.replaceChildren(); return; }
    if (info.resumable) inPlace = true;
    const summary = h('p', { class: 'src' }, [info.format.toUpperCase(), countFiles(files.length), info.total > 0 ? formatBytes(info.total) : '', info.encrypted ? t('encrypted') : '', info.resumable ? t('extractResumable') : '', info.sfv ? `.sfv ✓` : ''].filter(Boolean).join(' · '));
    const list = h('details', { class: 'entry-details' }, h('summary', null, t('archiveContents')), h('div', { class: 'entry-list' }, ...info.entries.slice(0, 300).map((e) => h('div', { class: 'entry-row' + (e.dir ? ' dir' : '') }, icon(e.dir ? 'folder' : 'file'), h('span', { class: 'grow', dir: 'ltr' }, e.path), e.dir || e.size < 0 ? null : h('small', { class: 'src' }, formatBytes(e.size)))), info.entries.length > 300 ? h('p', { class: 'src' }, t('andMore', { n: info.entries.length - 300 })) : null));
    const plan = h('div', { class: 'space-plan' });
    const conflicts = h('p', { class: 'src conflicts' });
    const destOut = h('span', { class: 'src', dir: 'ltr' }, destOf());
    const redo = () => { destOut.textContent = destOf(); void drawPlan(); void countConflicts(); };
    const destPick = pickButton(t('extractTo'), [['here', t('extractHereSmart')], ['folder', t('extractNewFolder')], ['other', t('extractElsewhere')]], destMode, async (v) => { destMode = v; if (v === 'other') { let d: string | null = null; if (window.kurokawaTools?.pickDir) d = await window.kurokawaTools.pickDir(); else { const { ktPlugin } = await import('../native'); d = (await ktPlugin()?.pickDir())?.dir ?? null; } if (d) other = d; else destMode = 'here'; destPick.setValue(destMode); } redo(); }, t('close'));
    const canInPlace = info.inPlaceOk && !info.duplicate;
    const inPlaceRow = canInPlace ? h('label', { class: 'row switch-row' }, h('span', null, t('extractInPlace'), h('small', { class: 'src' }, t('extractInPlaceHint'))), h('input', { type: 'checkbox', checked: inPlace, disabled: !!info.resumable, onchange: (e: Event) => { inPlace = (e.target as HTMLInputElement).checked; if (inPlace) { deleteAfter = false; (delRow.querySelector('input') as HTMLInputElement).checked = false; } verifyRow.hidden = !inPlace || info.format !== 'zip'; void drawPlan(); } })) : null;
    const verifyRow = h('label', { class: 'row switch-row', hidden: !inPlace || info.format !== 'zip' }, h('span', null, t('archiveVerifyFirst'), h('small', { class: 'src' }, t('archiveVerifyFirstHint'))), h('input', { type: 'checkbox', checked: verifyFirst, onchange: (e: Event) => { verifyFirst = (e.target as HTMLInputElement).checked; } }));
    const delRow = h('label', { class: 'row switch-row' }, h('span', null, t('deleteArchiveAfter')), h('input', { type: 'checkbox', checked: deleteAfter, onchange: (e: Event) => { deleteAfter = (e.target as HTMLInputElement).checked; if (deleteAfter && inPlace) { inPlace = false; const c = inPlaceRow?.querySelector('input') as HTMLInputElement | null; if (c) c.checked = false; void drawPlan(); } } }));
    sh.body.replaceChildren(summary, plan, list, h('div', { class: 'row' }, h('span', null, t('extractTo'), h('br'), destOut), destPick), ...(inPlaceRow ? [inPlaceRow, verifyRow] : []), h('div', { class: 'row' }, h('span', null, t('existingFiles'), conflicts), pickButton(t('existingFiles'), [['both', t('keepBoth')], ['replace', t('replaceFiles')], ['skip', t('skipFiles')]], replace, (v) => { replace = v; }, t('close'))), delRow);
    const actions: HTMLElement[] = [];
    if (info.resumable) actions.push(h('button', { type: 'button', class: 'btn tonal', onclick: () => void giveUp() }, icon('undo'), t('archiveRestore')));
    else actions.push(h('button', { type: 'button', class: 'btn tonal', onclick: () => void runTest() }, icon('check'), t('archiveTest')));
    actions.push(h('button', { type: 'button', class: 'btn primary', onclick: () => void start() }, icon('archive'), info.resumable ? t('extractContinue') : t('extractNow')));
    sh.actions.replaceChildren(...actions);
    // The space plan: HatchZip's «check» — nothing changes until it says the extraction fits.
    const drawPlan = async () => {
      const dest = destOf(); const free = dest ? await freeSpaceAt(dest) : info.free ?? -1; if (free < 0 || info.total <= 0) { plan.replaceChildren(); return; }
      const margin = keepFreeNow(); const normal = info.total; const placeNeed = (info.largest ?? info.total) + margin;
      const fitsNormal = normal <= free; const fitsPlace = placeNeed <= free;
      if (!fitsNormal && fitsPlace && canInPlace && !inPlace && !deleteAfter) { inPlace = true; const c = inPlaceRow?.querySelector('input') as HTMLInputElement | null; if (c) c.checked = true; verifyRow.hidden = info.format !== 'zip'; }
      const after = inPlace ? free - normal + (sizeOfArchive() || normal) : free - normal;
      const go = sh.actions.querySelector<HTMLButtonElement>('.btn.primary'); if (go) go.disabled = !fitsNormal && !(canInPlace && fitsPlace && inPlace);
      const line = (label: string, v: string, ok?: boolean) => h('div', { class: 'plan-row' + (ok === false ? ' bad' : ok ? ' good' : '') }, h('span', null, label), h('b', { dir: 'ltr' }, v));
      plan.replaceChildren(
        line(t('planFree'), formatBytes(free)),
        line(t('planNormal'), formatBytes(normal), fitsNormal),
        ...(canInPlace ? [line(t('planInPlace'), `${formatBytes(info.largest ?? 0)} + ${formatBytes(margin)}`, fitsPlace)] : []),
        line(t('planAfter'), formatBytes(Math.max(0, after)), after >= 0),
        ...(!fitsNormal && !(canInPlace && fitsPlace) ? [h('p', { class: 'plan-note bad' }, t('planNoFit'))] : !fitsNormal && inPlace ? [h('p', { class: 'plan-note' }, t('planInPlaceChosen'))] : []));
    };
    const sizeOfArchive = () => info.entries.reduce((a, e) => a + (e.compressed ?? 0), 0) || 0;
    const countConflicts = async () => { const dest = destOf(); if (!dest) { conflicts.textContent = ''; return; } const names = info.entries.filter((e) => !e.dir).map((e) => e.path); const ex = await existingIn(dest, names.slice(0, 5000)); conflicts.textContent = ex.length ? ` · ${t('alreadyThere', { n: countFiles(ex.length) })}` : ''; };
    void drawPlan(); void countConflicts();
  };
  const progressUi = (title: string) => {
    const bar = h('div', { class: 'task-bar big' }, h('i', { style: { width: '0%' } })); const line = h('p', { class: 'src', dir: 'ltr' }, ''); const pct = h('b', null, '0%');
    sh.body.replaceChildren(h('div', { class: 'extract-progress' }, h('div', { class: 'row' }, h('span', null, title), pct), bar, line));
    return (p: { done: number; total: number; file: string }) => { const f = p.total ? p.done / p.total : 0; (bar.firstChild as HTMLElement).style.width = `${Math.round(f * 100)}%`; pct.textContent = `${localDigits(Math.round(f * 100))}%`; line.textContent = p.file; };
  };
  const failed = (m: string) => { sh.body.replaceChildren(h('p', { class: 'empty small' }, errText(m))); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => { void load(); } }, t('back'))); };
  const runTest = async () => {
    const job = testArchiveJob(path, password || undefined, progressUi(t('archiveTesting')));
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => void cancelArchive(job.id) }, t('cancel')));
    try { const r = await job.done; sh.body.replaceChildren(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon(r.ok ? 'check' : 'alert')), h('p', null, r.ok ? t('archiveTestOk', { n: countFiles(r.files) }) : t('archiveDamaged', { names: r.bad.join(', ') })))); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => void load() }, t('back'))); }
    catch (e) { const m = String((e as Error).message ?? e); if (m === 'stopped') { void load(); return; } failed(m); }
  };
  const giveUp = async () => {
    try { const left = await restoreArchive(path); toast(left >= 0 ? t('archiveRestored', { n: countFiles(left) }) : t('archiveRestoredTar')); void load(); }
    catch (e) { failed(String((e as Error).message ?? e)); }
  };
  const start = async () => {
    const dest = destOf(); if (!dest) { toast(t('chooseFolder'), 'error'); return; }
    const job = extractArchiveJob({ path, dest, inPlace, deleteAfter, replace, password: password || undefined, verifyFirst: inPlace && verifyFirst, keepFree: keepFreeNow() }, progressUi(t('extracting')));
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => void cancelArchive(job.id) }, t('cancel')));
    try {
      const r = await job.done; opts.onDone?.(r.dest);
      const next = opts.queue?.shift();
      if (next) { sh.close(); void extractSheet(next, opts); return; }
      if (getSettings().archiveCloseWhenDone) { toast(t('extracted', { n: countFiles(r.files) })); sh.close(); return; }
      sh.body.replaceChildren(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('check')), h('p', null, t('extracted', { n: countFiles(r.files) })), h('p', { class: 'src', dir: 'ltr' }, r.dest)));
      sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => sh.close() }, t('done')), ...(canOpenFolder() ? [h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); void openFolder(r.dest); } }, icon('folder'), t('openFolder'))] : []));
    }
    catch (e) { const m = String((e as Error).message ?? e); if (m === 'stopped') { toast(t(inPlace ? 'extractPausedInPlace' : 'cancelled')); sh.close(); return; } if (/password/i.test(m)) { drawPassword(m); return; } failed(m); }
  };
  await load();
}
/** Several archives, HatchZip's way: one after another, each with its own plan as it starts. */
export async function extractMany(paths: string[]): Promise<void> { const [first, ...rest] = paths; if (first) await extractSheet(first, { queue: rest }); }

/** A zip from files the user picks (stored for what gains nothing by squeezing). */
export async function createZipSheet(): Promise<void> {
  const files = await pickFiles(true); if (!files.length) return;
  const sh = openSheet(t('createZip'), t('close'));
  const first = files[0]; const name = h('input', { type: 'text', value: `${files.length > 1 ? baseName(parentOf(first)) : stem(baseName(first)).replace(/\.[^.]+$/, '')}.zip`, dir: 'ltr' }) as HTMLInputElement;
  const dir = getSettings().downloadDir && !getSettings().downloadDir.startsWith('content:') ? getSettings().downloadDir : parentOf(first);
  sh.body.append(h('p', { class: 'src' }, countFiles(files.length)), h('div', { class: 'entry-list' }, ...files.slice(0, 50).map((f) => h('div', { class: 'entry-row' }, icon('file'), h('span', { class: 'grow', dir: 'ltr' }, baseName(f))))), h('label', { class: 'field' }, h('span', null, t('fileName')), name), h('p', { class: 'src', dir: 'ltr' }, dir));
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    const out = `${dir.replace(/[\\/]$/, '')}/${name.value.trim() || 'archive.zip'}`;
    const bar = h('div', { class: 'task-bar big' }, h('i', { style: { width: '0%' } })); const line = h('p', { class: 'src', dir: 'ltr' });
    sh.body.replaceChildren(h('div', { class: 'extract-progress' }, h('span', null, t('zipping')), bar, line)); sh.actions.replaceChildren();
    try { const r = await createZip(out, files, (p) => { (bar.firstChild as HTMLElement).style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`; line.textContent = p.file; }); toast(t('zipped', { name: baseName(r.path), size: formatBytes(r.size) })); sh.close(); }
    catch (e) { sh.body.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); }
  } }, icon('archive'), t('createZip')));
}
/** Settings → Archives: the margin, verify first, close when done. */
export function archiveSettingsRows(row: (label: string, control: Node, hint?: string) => HTMLElement, toggle: (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => HTMLElement): HTMLElement[] {
  const s = getSettings(); const gb = (n: number) => String(Math.round((n / 1024 ** 3) * 10) / 10);
  const kf = h('input', { type: 'number', min: '0', step: '0.5', value: gb(keepFreeNow()), style: { width: '6em' }, onchange: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); updateSettings({ archiveKeepFree: Number.isFinite(v) && v >= 0 ? Math.round(v * 1024 ** 3) : -1 }); } });
  return [row(t('archiveKeepFree'), kf, t('archiveKeepFreeHint')), toggle(t('archiveVerifyFirst'), s.archiveVerifyFirst, (v) => updateSettings({ archiveVerifyFirst: v }), t('archiveVerifyFirstHint')), toggle(t('archiveCloseWhenDone'), s.archiveCloseWhenDone, (v) => updateSettings({ archiveCloseWhenDone: v }))];
}
