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
import { preflightFor, shelfAct, type Answers, type Choice, type Report } from '../archives/safety';
import { extractArchiveJob, cancelArchive, createZip, pickFiles, parentOf, baseName, stem, testArchiveJob, restoreArchive, freeSpaceAt, existingIn, topLevel, type ArchiveInfo, listArchiveAuto, savePassword, rememberPasswords, setRememberPasswords } from '../archives';

/** The margin an extraction in place never uses: the setting, or 2 GB on a computer and 512 MB on a phone. */
export const keepFreeNow = (): number => { const k = getSettings().archiveKeepFree; return k >= 0 ? k : nativePlatform() === 'desktop' ? 2 * 1024 ** 3 : 512 * 1024 ** 2; };
const errText = (m: string): string => {
  if (m === 'noSpace') return t('errNoSpace'); if (m === 'notArchive') return t('notAnArchive'); if (m === 'busy' || m === 'journalExists') return t('errBusy');
  if (m === 'nothingToRestore') return t('errNothingToRestore'); if (/^refused oldJob\b/.test(m)) return `${t('pf_oldJob')}. ${t('fixOldJob')}`; if (/^refused staleJob\b/.test(m)) return `${t('pf_staleJob')}. ${t('fixStaleJob')}`;
  const [k, ...rest] = m.split(' '); const what = rest.join(' ').replace(/ — nothing was modified$/, '');
  if (k === 'refused') { const [kind, ...nm] = what.split(' '); return t('errRefused', { what: `${pfTitle(kind)}${nm.length ? ` — ${nm.join(' ')}` : ''}` }); }
  if (k === 'unsupportedMethod') return t('errRefused', { what: `${t('pf_method')} — ${rest.slice(1).join(' ').replace(/ — nothing was modified$/, '')}` });
  if (k === 'encryptedInPlace') return t('errRefused', { what: t('pf_encryptedInPlace') });
  if (k === 'throughLink') return t('errThroughLink', { name: what }); if (k === 'syncFailed') return t('errSyncFailed'); if (k === 'readBack') return t('errReadBack', { name: what });
  return k === 'unsafePath' ? t('archiveUnsafe', { name: what }) : k === 'duplicateEntry' ? t('archiveDuplicate', { name: what }) : k === 'damaged' ? t('archiveDamaged', { names: what }) : k === 'sfvMismatch' ? t('archiveSfvBad', { names: what }) : k === 'crcMismatch' ? t('archiveDamaged', { names: what }) : k === 'overlapping' ? t('archiveOverlap', { name: what }) : k === 'hardLinked' ? t('archiveHardLinked') : k === 'specialEntry' ? t('archiveSpecial', { name: what }) : k === 'sizeExceeded' ? t('archiveTooBig', { name: what }) : k === 'memoryLimit' ? t('archiveMemory') : /^(journal|tail|archive)(Corrupt|Future|V1|Changed|Gone|Missing)$/.test(k) ? shelfWhy(k) : m;
};
type PfKey = Parameters<typeof t>[0];
const pfTitle = (kind: string): string => { const k = `pf_${kind}` as PfKey; const v = t(k); return v === k ? kind : v; };
export const shelfWhy = (why: string): string => { const k = `shelfWhy_${why}` as PfKey; const v = t(k); return v === k ? why : v; };
const countN = (n: number): string => t('pfCount', { n: localDigits(n, 'prose') });

/** The pre-flight report: one line, then the problems by kind — how many, the first names, what can be done. */
export function reportEl(rep: Report): HTMLElement {
  const rank: Record<string, number> = { block: 0, inPlace: 1, ask: 2, info: 3 }; const shown = rep.problems.filter((p) => p.kind !== 'existing').sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4));
  const look = shown.filter((p) => p.severity !== 'info');
  const head = h('div', { class: 'pf-head' + (look.length ? '' : ' good') }, icon(look.length ? 'info' : 'check'), h('span', null, look.length ? t('pfSummary') : t('pfAllClear')));
  const groups = shown.map((p) => {
    const fix = p.fix ? t(p.fix as PfKey, { packed: formatBytes(p.packed ?? 0), total: formatBytes(p.total ?? 0), ratio: localDigits(p.ratio ?? 0) }) : '';
    const names = p.kind === 'rewrite' ? (p.rewrites ?? []).slice(0, 3).map((r) => h('div', { class: 'pf-name', dir: 'ltr' }, h('span', null, r.from), h('span', { class: 'pf-arrow', 'aria-hidden': 'true' }, '→'), h('span', null, r.to))) : p.names.filter((n) => !['wrong', 'missing', 'busy', 'saf', 'archive', 'destination', 'space', 'otherVolume'].includes(n)).slice(0, 3).map((n) => h('div', { class: 'pf-name', dir: 'auto' }, n));
    return h('div', { class: `pf-group ${p.severity}` }, h('div', { class: 'pf-title' }, h('b', null, pfTitle(p.kind)), p.count > 1 || p.kind === 'rewrite' || p.kind === 'names' ? h('small', { class: 'pf-count' }, countN(p.count)) : null),
      ...names, p.methods?.length ? h('div', { class: 'pf-name', dir: 'ltr' }, t('pfMethods', { ids: p.methods.join(', ') })) : null, fix ? h('p', { class: 'pf-fix' }, fix) : null);
  });
  return h('div', { class: 'pf-report', role: 'status' }, head, ...groups);
}
/** The fit check as two small bars: what each way needs at its peak against what is free; the one recommended and why. */
export function fitEl(rep: Report, canInPlace: boolean): HTMLElement {
  const sp = rep.space; const free = sp.free;
  const row = (label: string, need: number, fits: boolean, rec: boolean, off: boolean) => {
    const pct = free > 0 ? Math.min(100, Math.round(((need + sp.margin) / free) * 100)) : 100;
    return h('div', { class: 'fit-row' + (fits ? ' fits' : ' short') + (off ? ' off' : '') }, h('div', { class: 'fit-label' }, h('span', null, label), rec ? h('small', { class: 'fit-rec' }, t('fitRecommended')) : null),
      h('div', { class: 'fit-track', role: 'img', 'aria-label': `${label}: ${t('fitNeeds', { need: formatBytes(need + sp.margin), free: formatBytes(free) })}` }, h('i', { style: { width: `${Math.max(2, pct)}%` } })),
      h('small', { class: 'fit-num', dir: 'auto' }, t('fitNeeds', { need: formatBytes(need + sp.margin), free: formatBytes(free) })));
  };
  return h('div', { class: 'fit' }, row(t('fitNormal'), sp.normal, sp.fitsNormal, rep.recommend === 'normal', false), ...(canInPlace || rep.inPlace.ok ? [row(t('fitInPlace'), sp.inPlace, sp.fitsInPlace, rep.recommend === 'inPlace', !rep.inPlace.ok)] : []), h('p', { class: 'fit-why' }, t(`fitWhy_${rep.why}` as PfKey)));
}
/** Already there: asked one by one (Replace, Skip, Keep both), with «for the rest» and «for the rest of the files». */
export function askConflicts(names: string[]): Promise<Answers | null> {
  return new Promise((resolve) => {
    const answers: Answers = { per: {} }; let i = 0; let done = false;
    const sh = openSheet(t('cfTitle'), t('cancel'), { stack: true, onClose: () => { if (!done) resolve(null); } });
    const rest = h('input', { type: 'checkbox' }) as HTMLInputElement; const restKind = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const nameEl = h('p', { class: 'cf-name', dir: 'auto' }); const of = h('small', { class: 'src' });
    const pick = (c: Choice) => {
      if (rest.checked) answers.default = c; else if (restKind.checked) answers.files = c; else answers.per![names[i]] = c;
      i++; if (rest.checked || restKind.checked || i >= names.length) { done = true; sh.close(); resolve(answers); return; } draw();
    };
    const draw = () => { nameEl.textContent = names[i]; of.textContent = t('cfOf', { i: localDigits(i + 1, 'prose'), n: localDigits(names.length, 'prose') }); };
    sh.body.classList.add('cf-sheet');
    sh.body.append(of, nameEl, h('p', { class: 'hint' }, t('cfReplaceHint')),
      h('label', { class: 'row switch-row' }, h('span', null, t('cfRest')), rest), h('label', { class: 'row switch-row' }, h('span', null, t('cfRestKind')), restKind));
    rest.onchange = () => { if (rest.checked) restKind.checked = false; }; restKind.onchange = () => { if (restKind.checked) rest.checked = false; };
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => pick('skip') }, t('cfSkip')), h('button', { type: 'button', class: 'btn tonal', onclick: () => pick('both') }, t('cfBoth')), h('button', { type: 'button', class: 'btn primary', onclick: () => pick('replace') }, t('cfReplace')));
    draw();
  });
}

export async function extractSheet(path: string, opts: { onDone?: (dest: string) => void; queue?: string[]; /** A folder to extract into (each archive in a folder of its name): an archive handed in by another app and copied to the cache is not extracted beside its copy. */ dest?: string; /** Told when the sheet goes (another app's «Extract with Kurokawa» then hands back). */ onClose?: () => void } = {}): Promise<void> {
  const sh = openSheet(baseName(path), t('close'), { onClose: () => { if (!handedOn) opts.onClose?.(); } }); let handedOn = false;
  sh.el.classList.add('extract-sheet');
  sh.body.append(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  let info: ArchiveInfo; let password = '';
  const load = async () => { try { const r = await listArchiveAuto(path, password || undefined); info = r.info; password = r.password ?? ''; if (password) savePassword(password); draw(); } catch (e) { const m = String((e as Error).message ?? e); if (/password/i.test(m)) { drawPassword(m); return; } sh.body.replaceChildren(h('p', { class: 'empty small' }, errText(m))); } };
  const drawPassword = (why: string) => { const pw = h('input', { type: 'password', dir: 'ltr', autocomplete: 'off' }) as HTMLInputElement; sh.body.replaceChildren(h('p', { class: 'hint' }, /wrong/i.test(why) ? t('wrongPassword') : t('passwordNeeded')), h('label', { class: 'field' }, h('span', null, t('password')), pw), h('label', { class: 'row switch-row' }, h('span', null, t('archiveRememberPw')), h('input', { type: 'checkbox', checked: rememberPasswords(), onchange: (e: Event) => setRememberPasswords((e.target as HTMLInputElement).checked) }))); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: () => { password = pw.value; void load(); } }, t('open'))); };
  let destMode: 'here' | 'folder' | 'other' = opts.dest ? 'other' : 'here'; let other = opts.dest ? `${opts.dest.replace(/\/+$/, '')}/${stem(baseName(path))}` : ''; let inPlace = false; let deleteAfter = false; let verifyFirst = getSettings().archiveVerifyFirst !== false;
  let report: Report | null = null; let existing: string[] = []; let answers: Answers | undefined; let skip: string[] | undefined; let finishBeside = false;
  const destOf = () => (destMode === 'here' ? (topLevel(info.entries) === 'one' ? parentOf(path) : `${parentOf(path)}/${stem(baseName(path))}`) : destMode === 'folder' ? `${parentOf(path)}/${stem(baseName(path))}` : other);
  const draw = () => {
    const files = info.entries.filter((e) => !e.dir);
    if (info.resumable) inPlace = true;
    const summary = h('p', { class: 'src' }, [info.format.toUpperCase(), countFiles(files.length), info.total > 0 ? formatBytes(info.total) : '', info.encrypted ? t('encrypted') : '', info.volumes ? t('archiveVolumes', { n: localDigits(info.volumes) }) : '', info.resumable ? t('extractResumable') : '', info.sfv ? `.sfv ✓` : ''].filter(Boolean).join(' · '));
    const list = h('details', { class: 'entry-details' }, h('summary', null, t('archiveContents')), h('div', { class: 'entry-list' }, ...info.entries.slice(0, 300).map((e) => h('div', { class: 'entry-row' + (e.dir ? ' dir' : '') }, icon(e.dir ? 'folder' : 'file'), h('span', { class: 'grow', dir: 'ltr' }, e.path), e.dir || e.size < 0 ? null : h('small', { class: 'src' }, formatBytes(e.size)))), info.entries.length > 300 ? h('p', { class: 'src' }, t('andMore', { n: info.entries.length - 300 })) : null));
    const pfBox = h('div', { class: 'pf-box' }, h('div', { class: 'center' }, h('div', { class: 'spinner small' })));
    const fitBox = h('div', { class: 'fit-box' });
    const conflicts = h('small', { class: 'src conflicts' });
    const destOut = h('span', { class: 'src', dir: 'ltr' }, destOf());
    const redo = () => { destOut.textContent = destOf(); answers = undefined; void check(); };
    const destPick = pickButton(t('extractTo'), [['here', t('extractHereSmart')], ['folder', t('extractNewFolder')], ['other', t('extractElsewhere')]], destMode, async (v) => { destMode = v; if (v === 'other') { let d: string | null = null; if (window.kurokawaTools?.pickDir) d = await window.kurokawaTools.pickDir(); else { const { ktPlugin } = await import('../native'); d = (await ktPlugin()?.pickDir())?.dir ?? null; } if (d) other = d; else destMode = 'here'; destPick.setValue(destMode); } redo(); }, t('close'));
    const inPlaceIn = h('input', { type: 'checkbox', checked: inPlace, disabled: !!info.resumable, onchange: () => { inPlace = inPlaceIn.checked; if (inPlace) { deleteAfter = false; delIn.checked = false; } sync(); } }) as HTMLInputElement;
    const inPlaceWhy = h('small', { class: 'src inplace-why' });
    const inPlaceRow = h('label', { class: 'row switch-row' }, h('span', null, t('extractInPlace'), h('small', { class: 'src' }, t('extractInPlaceHint')), inPlaceWhy), inPlaceIn);
    const verifyIn = h('input', { type: 'checkbox', checked: verifyFirst, onchange: () => { verifyFirst = verifyIn.checked; sync(); } }) as HTMLInputElement;
    const verifyWarn = h('p', { class: 'pf-warn', hidden: true }, icon('info'), h('span', null, t('verifyOffWarn')));
    const verifyRow = h('label', { class: 'row switch-row' }, h('span', null, t('archiveVerifyFirstSafer'), h('small', { class: 'src' }, t('archiveVerifyFirstHint'))), verifyIn);
    const delIn = h('input', { type: 'checkbox', checked: deleteAfter, onchange: () => { deleteAfter = delIn.checked; if (deleteAfter && inPlace) { inPlace = false; inPlaceIn.checked = false; } sync(); } }) as HTMLInputElement;
    const delRow = h('label', { class: 'row switch-row' }, h('span', null, t('deleteArchiveAfter')), delIn);
    const existRow = h('div', { class: 'row', hidden: true }, h('span', null, t('existingFiles'), h('br'), conflicts));
    sh.body.replaceChildren(summary, pfBox, fitBox, h('div', { class: 'row' }, h('span', null, t('extractTo'), h('br'), destOut), destPick), inPlaceRow, verifyRow, verifyWarn, existRow, delRow, list);
    const actions: HTMLElement[] = [];
    if (files.some((e) => /\.(apk|apks|xapk|apkm)$/i.test(e.path)) && !info.resumable) void import('./apk').then((m) => { if (m.canInstallApps()) sh.actions.prepend(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); void m.installSheet(path); } }, icon('apps'), t('installApp'))); });
    if (info.resumable) actions.push(h('button', { type: 'button', class: 'btn tonal', onclick: () => void giveUp() }, icon('undo'), t('archiveRestore')));
    else actions.push(h('button', { type: 'button', class: 'btn tonal', onclick: () => void runTest() }, icon('check'), t('archiveTest')));
    const go = h('button', { type: 'button', class: 'btn primary', onclick: () => void start() }, icon('archive'), info.resumable ? t('extractContinue') : t('extractNow')) as HTMLButtonElement;
    actions.push(go); sh.actions.replaceChildren(...actions);
    // What the switches allow, from the report: in place only where it can be done, with the reason when it cannot.
    const sync = () => {
      const ok = !!report?.inPlace.ok || !!info.resumable; inPlaceIn.disabled = !!info.resumable || !ok; if (!ok && inPlace && !info.resumable) { inPlace = false; inPlaceIn.checked = false; }
      inPlaceWhy.textContent = !ok && report ? t('inPlaceOffWhy', { why: [...new Set(report.inPlace.why)].map(pfTitle).join(' · ') }) : '';
      verifyRow.hidden = !inPlace || !!info.resumable; verifyWarn.hidden = verifyRow.hidden || verifyFirst;
      go.disabled = !info.resumable && !!report && !(inPlace ? report.inPlace.ok : report.normal.ok);
      if (report) fitBox.replaceChildren(fitEl(report, !!info.inPlaceOk));
    };
    // The pre-flight: everything checked for this destination before anything changes; in place chosen when only it fits.
    const check = async () => {
      const dest = destOf(); const names = files.map((e) => e.path);
      const [free, ex] = await Promise.all([dest ? freeSpaceAt(dest) : Promise.resolve(info.free ?? -1), dest ? existingIn(dest, names.slice(0, 5000)) : Promise.resolve([])]); existing = ex;
      report = await preflightFor(info, path, dest, { password: password || undefined, free, keepFree: keepFreeNow(), existing: ex });
      pfBox.replaceChildren(reportEl(report));
      // (Round six: a stopped job beside this archive that cannot be used for it — said with its reason, and Forget offered here as on the shelf.)
      const stale = (report as { staleJob?: { journal: string; why: string } }).staleJob;
      if (stale) { const sx = await import('./extractShelf'); pfBox.append(h('div', { class: 'pf-stale' }, h('p', { class: 'hint' }, t('besideStale'), ' ', sx.why(stale.why)), h('button', { type: 'button', class: 'btn tonal', onclick: () => void sx.forgetJob({ journal: stale.journal, archive: path, dest: '' }, () => void check(), true) }, t('shelfForget')))); }
      if (!info.resumable && report.recommend === 'inPlace' && !deleteAfter) { inPlace = true; inPlaceIn.checked = true; }
      existRow.hidden = !ex.length; conflicts.textContent = ex.length ? t('existingAsk', { n: countFiles(ex.length) }) : '';
      sync();
    };
    sync(); void check();
  };
  const progressUi = (title: string) => {
    const bar = h('div', { class: 'task-bar big' }, h('i', { style: { width: '0%' } })); const line = h('p', { class: 'src', dir: 'ltr' }, ''); const pct = h('b', null, '0%');
    sh.body.replaceChildren(h('div', { class: 'extract-progress' }, h('div', { class: 'row' }, h('span', null, title), pct), bar, line));
    const stat = h('p', { class: 'src', dir: 'auto' }, ''); (sh.body.firstChild as HTMLElement).append(stat); const t0 = Date.now(); let lastT = t0, lastDone = 0, speed = 0;
    return (p: { done: number; total: number; file: string }) => {
      const f = p.total ? p.done / p.total : 0; (bar.firstChild as HTMLElement).style.width = `${Math.round(f * 100)}%`; pct.textContent = `${localDigits(Math.round(f * 100))}%`; line.textContent = p.file;
      const now = Date.now(); if (now - lastT >= 1000) { const inst = ((p.done - lastDone) * 1000) / (now - lastT); speed = speed ? speed * 0.6 + inst * 0.4 : inst; lastT = now; lastDone = p.done; }
      const left = speed > 0 && p.total > p.done ? (p.total - p.done) / speed : -1;
      stat.textContent = [speed > 0 ? `${formatBytes(speed)}/s` : '', left >= 0 ? t('archiveTimeLeft', { t: left < 60 ? `${localDigits(Math.ceil(left))} s` : left < 3600 ? `${localDigits(Math.ceil(left / 60))} min` : `${localDigits(Math.floor(left / 3600))} h ${localDigits(Math.ceil((left % 3600) / 60))} min` }) : '', p.total ? `${formatBytes(p.done)} / ${formatBytes(p.total)}` : ''].filter(Boolean).join(' · ');
    };
  };
  const failed = (m: string) => { sh.body.replaceChildren(h('p', { class: 'empty small' }, errText(m))); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => { void load(); } }, t('back'))); };
  const runTest = async () => {
    const job = testArchiveJob(path, password || undefined, progressUi(t('archiveTesting')));
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => void cancelArchive(job.id) }, t('cancel')));
    try { const r = await job.done; sh.body.replaceChildren(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon(r.ok ? 'check' : 'alert')), h('p', null, r.ok ? t('archiveTestOk', { n: countFiles(r.files) }) : t('archiveDamaged', { names: r.bad.join(', ') })))); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => void load() }, t('back'))); }
    catch (e) { const m = String((e as Error).message ?? e); if (m === 'stopped') { void load(); return; } failed(m); }
  };
  const giveUp = async () => {
    try { const left = await restoreArchive(path); toast(left === -2 ? t('restoredWhole') : left >= 0 ? t('archiveRestored', { n: countFiles(left) }) : t('archiveRestoredTar')); void load(); }
    catch (e) { failed(String((e as Error).message ?? e)); }
  };
  /** An unfinished job beside the archive that this app did not start: where its files go, then Finish, Restore the archive or Leave it. */
  const besideChoice = (dest: string) => {
    sh.body.replaceChildren(h('div', { class: 'pf-report' }, h('div', { class: 'pf-head' }, icon('info'), h('span', null, t('besideAsk'))), h('p', { class: 'src', dir: 'ltr' }, dest)));
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => sh.close() }, t('shelfLeave')), h('button', { type: 'button', class: 'btn tonal', onclick: () => void giveUp() }, t('shelfRestore')),
      h('button', { type: 'button', class: 'btn primary', onclick: () => { finishBeside = true; void start(); } }, t('shelfFinish')));
  };
  /** A damaged file found before anything changed: extract the rest normally, or stop. */
  const damagedChoice = (names: string[]) => {
    sh.body.replaceChildren(h('div', { class: 'pf-report' }, h('div', { class: 'pf-head' }, icon('info'), h('span', null, t('pf_damaged'))), ...names.slice(0, 5).map((n) => h('div', { class: 'pf-name', dir: 'auto' }, n)), h('p', { class: 'pf-fix' }, t('fixDamaged'))));
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => sh.close() }, t('damagedStop')), h('button', { type: 'button', class: 'btn primary', onclick: () => { inPlace = false; skip = names; void start(); } }, t('damagedRest')));
  };
  const start = async () => {
    const dest = destOf(); if (!dest) { toast(t('chooseFolder'), 'error'); return; }
    if (existing.length && !answers && !info.resumable) { const a = await askConflicts(existing); if (!a) return; answers = a; }
    const job = extractArchiveJob({ path, dest, inPlace, deleteAfter, replace: answers?.default ?? 'both', answers, skip, password: password || undefined, verifyFirst: inPlace && verifyFirst, keepFree: keepFreeNow(), ...(finishBeside ? { finishBeside } : {}) }, progressUi(t('extracting')));
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => void cancelArchive(job.id) }, t('cancel')));
    try {
      const r = await job.done; opts.onDone?.(r.dest);
      const next = opts.queue?.shift();
      if (next) { if (r.job) void shelfAct(r.job, 'dismiss').catch(() => {}); handedOn = true; sh.close(); void extractSheet(next, opts); return; }
      if (getSettings().archiveCloseWhenDone && !r.job) { toast(t('extracted', { n: countFiles(r.files) })); sh.close(); return; }
      doneView(r);
    }
    catch (e) {
      const m = String((e as Error).message ?? e);
      if (m === 'stopped') { toast(t(inPlace ? 'extractPausedInPlace' : 'cancelled')); sh.close(); return; }
      if (/password/i.test(m)) { drawPassword(m); return; }
      if (m === 'conflictsUnanswered') { answers = undefined; void load(); return; }
      { const ab = /(?:^|: )askBeside (.+)$/s.exec(m); if (ab) { besideChoice(ab[1]); return; } }
      if (/^refused damaged /.test(m) || /^damaged /.test(m)) { damagedChoice(m.replace(/^refused damaged |^damaged /, '').split(', ')); return; }
      failed(m);
    }
  };
  /** Done: the count, where, and Undo while the sheet is open (dismissing it ends the offer and tidies the set-aside files). */
  const doneView = (r: { files: number; dest: string; job?: string; damaged?: string[]; appeared?: string[] }) => {
    let undone = false; sh.el.classList.add('done-undo');
    sh.body.replaceChildren(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('check')), h('p', null, t('extracted', { n: countFiles(r.files) })), h('p', { class: 'src', dir: 'ltr' }, r.dest)),
      ...(r.damaged?.length ? [h('p', { class: 'pf-warn' }, icon('info'), h('span', null, t('archiveDamaged', { names: r.damaged.join(', ') })))] : []),
      ...(r.appeared?.length ? [h('p', { class: 'hint' }, t('appearedKept', { n: countFiles(r.appeared.length) }))] : []),
      ...(r.job ? [h('p', { class: 'hint undo-hint' }, t(inPlace ? 'doneUndoHintInPlace' : 'doneUndoHint'))] : []));
    const finish = () => { if (r.job && !undone) void shelfAct(r.job, 'dismiss').catch(() => {}); };
    sh.actions.replaceChildren(...(r.job ? [h('button', { type: 'button', class: 'btn tonal', onclick: async () => { undone = true; try { const u = await shelfAct(r.job!, 'undo'); const { undoSummary } = await import('./extractShelf'); const partial = !!(u as { keptOut?: string[] } | undefined)?.keptOut?.length; toast(undoSummary(u), partial ? 'error' : undefined, partial ? 8000 : undefined); } catch (e) { toast(errText(String((e as Error).message ?? e)), 'error'); } sh.close(); } }, icon('undo'), t('doneUndo'))] : []),
      h('button', { type: 'button', class: 'btn tonal', onclick: () => { finish(); sh.close(); } }, t('done')), ...(canOpenFolder() ? [h('button', { type: 'button', class: 'btn primary', onclick: () => { finish(); sh.close(); void openFolder(r.dest); } }, icon('folder'), t('openFolder'))] : []));
  };
  await load();
}
/** Several archives, HatchZip's way: one after another, each with its own plan as it starts. */
export async function extractMany(paths: string[], o: { dest?: string; onClose?: () => void } = {}): Promise<void> { const [first, ...rest] = paths; if (first) await extractSheet(first, { queue: rest, ...o }); }

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
    try { const r = await createZip(out, files, (p) => { (bar.firstChild as HTMLElement).style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`; line.textContent = p.file; }); if (!r.cancelled) toast(t('zipped', { name: baseName(r.path), size: formatBytes(r.size) })); sh.close(); }
    catch (e) { sh.body.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); }
  } }, icon('archive'), t('createZip')));
}
/** Settings → Archives: the margin, verify first, close when done. */
export function archiveSettingsRows(row: (label: string, control: Node, hint?: string) => HTMLElement, toggle: (label: string, on: boolean, set: (v: boolean) => void, hint?: string) => HTMLElement): HTMLElement[] {
  const s = getSettings(); const gb = (n: number) => String(Math.round((n / 1024 ** 3) * 10) / 10);
  const kf = h('input', { type: 'number', min: '0', step: '0.5', value: gb(keepFreeNow()), style: { width: '6em' }, onchange: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); updateSettings({ archiveKeepFree: Number.isFinite(v) && v >= 0 ? Math.round(v * 1024 ** 3) : -1 }); } });
  return [row(t('archiveKeepFree'), kf, t('archiveKeepFreeHint')), toggle(t('archiveVerifyFirst'), s.archiveVerifyFirst, (v) => updateSettings({ archiveVerifyFirst: v }), t('archiveVerifyFirstHint')), toggle(t('archiveCloseWhenDone'), s.archiveCloseWhenDone, (v) => updateSettings({ archiveCloseWhenDone: v }))];
}
