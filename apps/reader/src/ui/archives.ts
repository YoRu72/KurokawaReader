// The archive sheets of the reader — the same as Kurokawa Tools': an archive's contents, extraction (in place for
// ZIP), making a zip.
import { h, icon, toast, openSheet, pickButton } from './dom';
import { t, formatBytes, countFiles, localDigits } from '../i18n';
import { listArchive, extractArchiveJob, cancelArchive, createZip, pickFiles, pickDir, parentOf, baseName, stem, type ArchiveInfo } from '../archives';

export async function extractSheet(path: string, opts: { onDone?: (dest: string) => void } = {}): Promise<void> {
  const sh = openSheet(baseName(path), t('close'));
  sh.body.append(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  let info: ArchiveInfo; let password = '';
  const load = async () => { try { info = await listArchive(path, password || undefined); draw(); } catch (e) { const m = String((e as Error).message ?? e); if (/password/i.test(m)) { drawPassword(m); return; } sh.body.replaceChildren(h('p', { class: 'empty small' }, m === 'notArchive' ? t('notAnArchive') : m)); } };
  const drawPassword = (why: string) => { const pw = h('input', { type: 'password', dir: 'ltr', autocomplete: 'off' }) as HTMLInputElement; sh.body.replaceChildren(h('p', { class: 'hint' }, /wrong/i.test(why) ? t('wrongPassword') : t('passwordNeeded')), h('label', { class: 'field' }, h('span', null, t('password')), pw)); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: () => { password = pw.value; void load(); } }, t('open'))); };
  let destMode: 'here' | 'folder' | 'other' = 'folder'; let other = ''; let inPlace = false; let replace: 'replace' | 'skip' | 'both' = 'replace'; let deleteAfter = false;
  const draw = () => {
    const files = info.entries.filter((e) => !e.dir);
    const summary = h('p', { class: 'src' }, [info.format.toUpperCase(), countFiles(files.length), info.total > 0 ? formatBytes(info.total) : '', info.encrypted ? t('encrypted') : '', info.resumable ? t('extractResumable') : ''].filter(Boolean).join(' · '));
    const list = h('div', { class: 'entry-list' }, ...info.entries.slice(0, 200).map((e) => h('div', { class: 'entry-row' + (e.dir ? ' dir' : '') }, icon(e.dir ? 'folder' : 'file'), h('span', { class: 'grow', dir: 'ltr' }, e.path), e.dir || e.size < 0 ? null : h('small', { class: 'src' }, formatBytes(e.size)))), info.entries.length > 200 ? h('p', { class: 'src' }, t('andMore', { n: info.entries.length - 200 })) : null);
    const destLabel = () => (destMode === 'here' ? parentOf(path) : destMode === 'folder' ? `${parentOf(path)}/${stem(baseName(path))}` : other || t('chooseFolder'));
    const destOut = h('span', { class: 'src', dir: 'ltr' }, destLabel());
    const destPick = pickButton(t('extractTo'), [['folder', t('extractNewFolder')], ['here', t('extractHere')], ['other', t('extractElsewhere')]], destMode, async (v) => { destMode = v; if (v === 'other') { const d = await pickDir(); if (d) other = d; else destMode = 'folder'; destPick.setValue(destMode); } destOut.textContent = destLabel(); }, t('close'));
    const inPlaceRow = info.inPlaceOk ? h('label', { class: 'row switch-row' }, h('span', null, t('extractInPlace'), h('small', { class: 'src' }, t('extractInPlaceHint'))), h('input', { type: 'checkbox', checked: inPlace, onchange: (e: Event) => { inPlace = (e.target as HTMLInputElement).checked; if (inPlace) { deleteAfter = false; (delRow.querySelector('input') as HTMLInputElement).checked = false; } } })) : null;
    const delRow = h('label', { class: 'row switch-row' }, h('span', null, t('deleteArchiveAfter')), h('input', { type: 'checkbox', checked: deleteAfter, onchange: (e: Event) => { deleteAfter = (e.target as HTMLInputElement).checked; if (deleteAfter && inPlace) { inPlace = false; const c = inPlaceRow?.querySelector('input') as HTMLInputElement | null; if (c) c.checked = false; } } }));
    sh.body.replaceChildren(summary, list, h('div', { class: 'row' }, h('span', null, t('extractTo'), h('br'), destOut), destPick), ...(inPlaceRow ? [inPlaceRow] : []), h('div', { class: 'row' }, h('span', null, t('existingFiles')), pickButton(t('existingFiles'), [['replace', t('replaceFiles')], ['skip', t('skipFiles')], ['both', t('keepBoth')]], replace, (v) => { replace = v; }, t('close'))), delRow);
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: () => void start() }, icon('archive'), info.resumable ? t('extractContinue') : t('extractNow')));
  };
  const start = async () => {
    const dest = destMode === 'here' ? parentOf(path) : destMode === 'folder' ? `${parentOf(path)}/${stem(baseName(path))}` : other;
    if (!dest) { toast(t('chooseFolder'), 'error'); return; }
    const bar = h('div', { class: 'task-bar big' }, h('i', { style: { width: '0%' } })); const line = h('p', { class: 'src', dir: 'ltr' }, ''); const pct = h('b', null, '0%');
    sh.body.replaceChildren(h('div', { class: 'extract-progress' }, h('div', { class: 'row' }, h('span', null, t('extracting')), pct), bar, line));
    const job = extractArchiveJob({ path, dest, inPlace, deleteAfter, replace, password: password || undefined }, (p) => { const f = p.total ? p.done / p.total : 0; (bar.firstChild as HTMLElement).style.width = `${Math.round(f * 100)}%`; pct.textContent = `${localDigits(Math.round(f * 100))}%`; line.textContent = p.file; });
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => void cancelArchive(job.id) }, t('cancel')));
    try { const r = await job.done; toast(t('extracted', { n: countFiles(r.files) })); sh.close(); opts.onDone?.(r.dest); }
    catch (e) { const m = String((e as Error).message ?? e); if (m === 'stopped') { toast(t(inPlace ? 'extractPausedInPlace' : 'cancelled')); sh.close(); return; } if (/password/i.test(m)) { drawPassword(m); return; } sh.body.replaceChildren(h('p', { class: 'empty small' }, m === 'noSpace' ? t('noSpace') : m)); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => { void load(); } }, t('back'))); }
  };
  await load();
}

/** A zip from files the user picks (stored for what gains nothing by squeezing). */
export async function createZipSheet(): Promise<void> {
  const files = await pickFiles(true); if (!files.length) return;
  const sh = openSheet(t('createZip'), t('close'));
  const first = files[0]; const name = h('input', { type: 'text', value: `${files.length > 1 ? baseName(parentOf(first)) : stem(baseName(first)).replace(/\.[^.]+$/, '')}.zip`, dir: 'ltr' }) as HTMLInputElement;
  const dir = parentOf(first);
  sh.body.append(h('p', { class: 'src' }, countFiles(files.length)), h('div', { class: 'entry-list' }, ...files.slice(0, 50).map((f) => h('div', { class: 'entry-row' }, icon('file'), h('span', { class: 'grow', dir: 'ltr' }, baseName(f))))), h('label', { class: 'field' }, h('span', null, t('fileName')), name), h('p', { class: 'src', dir: 'ltr' }, dir));
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    const out = `${dir.replace(/[\\/]$/, '')}/${name.value.trim() || 'archive.zip'}`;
    const bar = h('div', { class: 'task-bar big' }, h('i', { style: { width: '0%' } })); const line = h('p', { class: 'src', dir: 'ltr' });
    sh.body.replaceChildren(h('div', { class: 'extract-progress' }, h('span', null, t('zipping')), bar, line)); sh.actions.replaceChildren();
    try { const r = await createZip(out, files, (p) => { (bar.firstChild as HTMLElement).style.width = `${p.total ? Math.round((p.done / p.total) * 100) : 0}%`; line.textContent = p.file; }); toast(t('zipped', { name: baseName(r.path), size: formatBytes(r.size) })); sh.close(); }
    catch (e) { sh.body.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); }
  } }, icon('archive'), t('createZip')));
}

/** Picks an archive from the device and opens its sheet. */
export async function openArchivePicker(): Promise<void> { const [f] = await pickFiles(false); if (f) await extractSheet(f); }
