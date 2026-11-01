// The app installer (Android): an APK, or a split bundle (.apks, .xapk, .apkm, a zip of APKs) — what it installs
// shown first (icon, name, package, the version here now and the new one: an update, the same, an older one),
// then installed through the system's installer session with its progress; a bundle's parts are streamed
// straight from it, so nothing is unpacked first. The file can go once the app is in.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { ktPlugin } from '../native';
import { uid } from '../db';

export const APK_RE = /\.(apk|apks|xapk|apkm)$/i;
export const isApkName = (n: string): boolean => APK_RE.test(n);
type ApkInfo = { choose?: { select: string; label: string; size: number }[]; select?: string; parts?: string[]; container?: boolean; free?: number; package: string; version: string; versionCode: number; label?: string; icon?: string; minSdk?: number; installed?: string; change: 'new' | 'upgrade' | 'same' | 'downgrade'; splits: number; size: number; bundle: boolean; supported: boolean; obb?: boolean };
type Ev = { id: string; status: 'progress' | 'committed' | 'confirm' | 'success' | 'failure'; done?: number; total?: number; message?: string; code?: number; package?: string };
type P = { apkInfo(o: { path: string; password?: string; select?: string }): Promise<ApkInfo>; apkInstall(o: { id: string; path: string; deleteAfter?: boolean; password?: string; select?: string; parts?: string[] }): Promise<void>; launchApp(o: { pkg: string }): Promise<void>; addListener(ev: 'apkInstall', fn: (e: Ev) => void): Promise<{ remove(): void }> };
const plug = (): P | null => { const p = ktPlugin() as unknown as P | null; return p?.apkInfo ? p : null; };
export const canInstallApps = (): boolean => !!plug();

/** The app installer for a file: an APK, a bundle, or any archive (ZIP, 7z, RAR, tar — password-protected too)
 *  with an app inside, streamed out of it with nothing extracted; several apps inside: the one to install asked. */
export async function installSheet(path: string, o: { password?: string; select?: string } = {}): Promise<void> {
  const p = plug(); if (!p) { toast(t('apkAndroidOnly'), 'error'); return; }
  const name = path.split(/[\\/]/).pop() ?? path;
  const sh = openSheet(t('apkInstallTitle'), t('close'));
  sh.body.append(h('div', { class: 'center' }, h('div', { class: 'spinner' }), h('p', { class: 'src small' }, t('apkReading'))));
  let info: ApkInfo;
  try { info = await p.apkInfo({ path, password: o.password, select: o.select }); }
  catch (e) {
    const m = String((e as Error).message ?? e);
    // (A locked archive: its password asked here, then read again.)
    if (m === 'password') {
      const pw = h('input', { type: 'password', class: 'text-input', autocomplete: 'off', placeholder: t('password') }) as HTMLInputElement;
      const go = () => { if (!pw.value) return; sh.close(); void installSheet(path, { ...o, password: pw.value }); };
      pw.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
      sh.body.replaceChildren(h('p', null, o.password ? t('wrongPassword') : t('passwordNeeded')), h('p', { class: 'src', dir: 'ltr' }, name), pw);
      sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: go }, icon('key'), t('apkUnlock'))); setTimeout(() => pw.focus(), 60); return;
    }
    sh.body.replaceChildren(h('p', { class: 'empty small' }, /noApkInside|notAnApk/.test(m) ? t('apkNotApp') : m)); return;
  }
  // (Several apps in the archive: one chosen, then read.)
  if (info.choose) {
    sh.body.replaceChildren(h('p', null, t('apkChooseApp')), h('p', { class: 'src', dir: 'ltr' }, name),
      ...info.choose.map((c) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); void installSheet(path, { ...o, select: c.select }); } }, icon(/^bundle:/.test(c.select) ? 'archive' : 'apps'), h('span', { class: 'grow' }, h('span', { dir: 'ltr' }, c.label), h('small', { class: 'src' }, `${/^dir:/.test(c.select) ? t('apkSplitFolder') : /^bundle:/.test(c.select) ? t('apkBundle') : 'APK'}${c.size > 0 ? ` · ${formatBytes(c.size)}` : ''}`)))));
    return;
  }
  let deleteAfter = false;
  const change = info.change === 'new' ? t('apkNew') : info.change === 'upgrade' ? t('apkUpgrade', { from: info.installed ?? '' }) : info.change === 'same' ? t('apkSame') : t('apkDowngrade', { from: info.installed ?? '' });
  sh.body.replaceChildren(
    h('div', { class: 'apk-head' }, info.icon ? h('img', { class: 'apk-icon', src: info.icon, alt: '' }) : h('span', { class: 'apk-icon none' }, icon('apps')),
      h('div', { class: 'grow' }, h('b', { dir: 'auto' }, info.label || info.package), h('small', { class: 'src', dir: 'ltr' }, info.package), h('small', { class: 'src' }, h('span', { dir: 'ltr' }, info.version), ' · ', formatBytes(info.size), info.bundle ? ` · ${t('apkSplits', { n: info.splits })}` : ''))),
    h('p', { class: 'apk-change ' + info.change }, change),
    ...(info.supported ? [] : [h('p', { class: 'plan-note bad' }, t('apkTooNew', { n: info.minSdk ?? 0 }))]),
    ...(info.obb ? [h('p', { class: 'hint' }, t('apkObb'))] : []),
    ...(info.container ? [h('p', { class: 'hint' }, t('apkFromArchive'))] : []),
    // (Room: the system copies the app in and prepares it, which takes about twice its size.)
    ...(info.free !== undefined && info.free < info.size * 2 ? [h('p', { class: 'plan-note bad' }, t('apkLowSpace', { need: formatBytes(info.size * 2), free: formatBytes(info.free) }))] : []),
    h('p', { class: 'src', dir: 'ltr' }, name),
    h('label', { class: 'row switch-row' }, h('span', null, info.container ? t('apkDeleteAfterArchive') : t('apkDeleteAfter')), h('input', { type: 'checkbox', onchange: (e: Event) => { deleteAfter = (e.target as HTMLInputElement).checked; } })));
  const go = h('button', { type: 'button', class: 'btn primary', disabled: !info.supported }, icon('download'), info.change === 'upgrade' ? t('apkUpdate') : t('apkInstall')) as HTMLButtonElement;
  sh.actions.replaceChildren(go);
  go.addEventListener('click', async () => {
    const id = uid(); go.disabled = true;
    const bar = h('div', { class: 'task-bar big' }, h('i', { style: { width: '0%' } })); const line = h('p', { class: 'src' }, t('apkWriting'));
    sh.body.append(h('div', { class: 'extract-progress' }, bar, line));
    const sub = await p.addListener('apkInstall', (e) => {
      if (e.id !== id) return;
      if (e.status === 'progress' && e.total) { const f = e.done! / e.total; (bar.firstChild as HTMLElement).style.width = `${Math.round(f * 100)}%`; line.textContent = `${t('apkWriting')} ${localDigits(Math.round(f * 100))}%`; }
      else if (e.status === 'committed' || e.status === 'confirm') { (bar.firstChild as HTMLElement).style.width = '100%'; line.textContent = t('apkConfirm'); }
      else if (e.status === 'success') { sub.remove(); toast(t('apkDone', { name: info.label || info.package })); sh.body.replaceChildren(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('check')), h('p', null, t('apkDone', { name: info.label || info.package })))); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => sh.close() }, t('done')), h('button', { type: 'button', class: 'btn primary', onclick: () => { void p.launchApp({ pkg: info.package }).catch(() => undefined); sh.close(); } }, icon('external'), t('apkOpen'))); }
      else if (e.status === 'failure') { sub.remove(); line.textContent = t('apkFailed', { why: failWhy(e) }); line.classList.add('bad'); go.disabled = false; }
    });
    try { await p.apkInstall({ id, path, deleteAfter, password: o.password, select: info.select, parts: info.parts }); }
    catch (e) { sub.remove(); const m = String((e as Error).message ?? e); line.textContent = m === 'permission' ? t('apkPermission') : t('apkFailed', { why: m }); go.disabled = false; }
  });
}
/** The system's failure codes in words (PackageInstaller.STATUS_FAILURE_*). */
function failWhy(e: Ev): string {
  const by: Record<number, string> = { 2: t('apkWhyBlocked'), 3: t('apkWhyAborted'), 4: t('apkWhyInvalid'), 5: t('apkWhyConflict'), 6: t('apkWhyStorage'), 7: t('apkWhyIncompatible') };
  return (e.code !== undefined && by[e.code]) || e.message || '';
}
