// The app installer (Android): an APK, or a split bundle (.apks, .xapk, .apkm, a zip of APKs) — what it installs
// shown first (icon, name, package, the version here now and the new one: an update, the same, an older one),
// then installed through the system's installer session with its progress; a bundle's parts are streamed
// straight from it, so nothing is unpacked first. The file can go once the app is in. Also shown before
// installing: the Android it targets and needs, the processors its code is built for (and whether this phone's is
// one), what it asks to access, who signed it — and when an update is signed by someone else than the copy
// installed (which the system refuses), the way out: uninstall that one first. A bundle's languages and screen
// densities can be left out; a game's data (OBB) is put where the game reads it.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import { ktPlugin } from '../native';
import { uid } from '../db';

export const APK_RE = /\.(apk|apks|xapk|apkm)$/i;
export const isApkName = (n: string): boolean => APK_RE.test(n);
type Part = { name: string; size: number; kind: 'base' | 'abi' | 'density' | 'lang' | 'feature'; optional: boolean };
type ApkInfo = { targetSdk?: number; abis?: string[]; abiFits?: boolean; deviceAbis?: string[]; permissions?: { name: string; danger: boolean; label?: string }[]; riskyPermissions?: number; signer?: string; sameSigner?: boolean; installedSigner?: string; partsAll?: Part[]; obbFiles?: number; choose?: { select: string; label: string; size: number }[]; select?: string; parts?: string[]; container?: boolean; free?: number; package: string; version: string; versionCode: number; label?: string; icon?: string; minSdk?: number; installed?: string; change: 'new' | 'upgrade' | 'same' | 'downgrade'; splits: number; size: number; bundle: boolean; supported: boolean; obb?: boolean };
type Ev = { id: string; status: 'progress' | 'committed' | 'confirm' | 'success' | 'failure'; done?: number; total?: number; message?: string; code?: number; package?: string };
type P = { apkInfo(o: { path: string; password?: string; select?: string }): Promise<ApkInfo>; apkInstall(o: { id: string; path: string; deleteAfter?: boolean; password?: string; select?: string; parts?: string[] }): Promise<void>; launchApp(o: { pkg: string }): Promise<void>; uninstallApp?(o: { pkg: string }): Promise<void>; appDetails?(o: { pkg: string }): Promise<void>; appInstalled?(o: { pkg: string }): Promise<{ installed: boolean }>; apkObb?(o: { path: string; pkg: string }): Promise<{ copied: number; to: string; direct: boolean }>; addListener(ev: 'apkInstall', fn: (e: Ev) => void): Promise<{ remove(): void }> };
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
  let deleteAfter = false; let chosenParts: string[] | null = null;
  /** The copy installed now taken off (the system's own page asks), then the file read again. */
  const uninstallFirst = async () => {
    if (!p.uninstallApp) return; await p.uninstallApp({ pkg: info.package }).catch(() => undefined);
    for (let k = 0; k < 120; k++) { await new Promise((r) => setTimeout(r, 1000)); if (document.visibilityState !== 'visible') continue; const r = await p.appInstalled?.({ pkg: info.package }).catch(() => null); if (r && !r.installed) { sh.close(); void installSheet(path, o); return; } if (r && k > 5) return; }
  };
  const change = info.change === 'new' ? t('apkNew') : info.change === 'upgrade' ? t('apkUpgrade', { from: info.installed ?? '' }) : info.change === 'same' ? t('apkSame') : t('apkDowngrade', { from: info.installed ?? '' });
  sh.body.replaceChildren(
    h('div', { class: 'apk-head' }, info.icon ? h('img', { class: 'apk-icon', src: info.icon, alt: '' }) : h('span', { class: 'apk-icon none' }, icon('apps')),
      h('div', { class: 'grow' }, h('b', { dir: 'auto' }, info.label || info.package), h('small', { class: 'src', dir: 'ltr' }, info.package), h('small', { class: 'src' }, h('span', { dir: 'ltr' }, info.version), ' · ', formatBytes(info.size), info.bundle ? ` · ${t('apkSplits', { n: info.splits })}` : ''))),
    h('p', { class: 'apk-change ' + info.change }, change),
    ...(info.sameSigner === false ? [h('div', { class: 'plan-note bad' }, h('p', null, t('apkOtherSigner')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void uninstallFirst() }, icon('trash'), t('apkUninstallFirst')))] : []),
    ...(info.abiFits === false ? [h('p', { class: 'plan-note bad' }, t('apkWrongAbi', { abis: (info.abis ?? []).join(', '), dev: (info.deviceAbis ?? []).join(', ') }))] : []),
    details(info, (sel) => { chosenParts = sel; }),
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
      else if (e.status === 'success') {
        // (A game's data, from an .xapk: put where it reads it, then the archive let go when that was asked.)
        if (info.obb && !info.container && p.apkObb) void p.apkObb({ path, pkg: info.package }).then((r) => { if (r.copied) toast(r.direct ? t('apkObbCopied', { n: localDigits(r.copied) }) : t('apkObbMoveBy', { to: r.to }), 'info', r.direct ? 4000 : 9000); }).catch((er) => toast(String((er as Error).message ?? er), 'error'));
        sub.remove(); toast(t('apkDone', { name: info.label || info.package })); sh.body.replaceChildren(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('check')), h('p', null, t('apkDone', { name: info.label || info.package })))); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => sh.close() }, t('done')), ...(p.appDetails ? [h('button', { type: 'button', class: 'btn text', onclick: () => void p.appDetails!({ pkg: info.package }).catch(() => undefined) }, icon('info'), t('apkAppInfo'))] : []), h('button', { type: 'button', class: 'btn primary', onclick: () => { void p.launchApp({ pkg: info.package }).catch(() => undefined); sh.close(); } }, icon('external'), t('apkOpen'))); }
      else if (e.status === 'failure') { sub.remove(); line.textContent = t('apkFailed', { why: failWhy(e) }); line.classList.add('bad'); go.disabled = false; if (e.code === 5 && info.installed && p.uninstallApp) line.after(h('button', { type: 'button', class: 'btn tonal small', onclick: () => void uninstallFirst() }, icon('trash'), t('apkUninstallFirst'))); }
    });
    try { await p.apkInstall({ id, path, deleteAfter: deleteAfter && !info.obb, password: o.password, select: info.select, parts: chosenParts ?? info.parts }); }
    catch (e) { sub.remove(); const m = String((e as Error).message ?? e); line.textContent = m === 'permission' ? t('apkPermission') : t('apkFailed', { why: m }); go.disabled = false; }
  });
}
/** The system's failure codes in words (PackageInstaller.STATUS_FAILURE_*). */
function failWhy(e: Ev): string {
  const by: Record<number, string> = { 2: t('apkWhyBlocked'), 3: t('apkWhyAborted'), 4: t('apkWhyInvalid'), 5: t('apkWhyConflict'), 6: t('apkWhyStorage'), 7: t('apkWhyIncompatible') };
  return (e.code !== undefined && by[e.code]) || e.message || '';
}

const ANDROID: Record<number, string> = { 19: '4.4', 21: '5.0', 22: '5.1', 23: '6', 24: '7', 25: '7.1', 26: '8', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16', 37: '17' };
const androidName = (sdk?: number) => (sdk ? `Android ${ANDROID[sdk] ?? `API ${sdk}`}` : '');
/** The app up close: Android, processors, signer, permissions (the risky ones first), and a bundle's parts to keep. */
function details(info: ApkInfo, onParts: (sel: string[]) => void): HTMLElement {
  const kv = (k: string, v: string | Node) => [h('dt', null, k), h('dd', { dir: 'auto' }, v)];
  const rows = h('dl', { class: 'kv' },
    ...(info.minSdk ? kv(t('apkNeeds'), androidName(info.minSdk)) : []), ...(info.targetSdk ? kv(t('apkTargets'), androidName(info.targetSdk)) : []),
    ...(info.abis?.length ? kv(t('apkProcessors'), info.abis.join(' · ')) : kv(t('apkProcessors'), t('apkAnyProcessor'))),
    ...(info.signer ? kv(t('apkSigner'), h('code', { dir: 'ltr', title: info.signer }, info.signer.match(/.{2}/g)!.slice(0, 8).join(':') + '…')) : []));
  const perms = [...(info.permissions ?? [])].sort((a, b) => Number(b.danger) - Number(a.danger));
  const permBox = perms.length ? h('details', { class: 'apk-perms' }, h('summary', null, t('apkPermissions'), h('small', { class: 'src' }, ` · ${localDigits(perms.length)}${info.riskyPermissions ? ` · ${t('apkRisky', { n: localDigits(info.riskyPermissions) })}` : ''}`)),
    h('ul', null, ...perms.map((x) => h('li', { class: x.danger ? 'danger' : '' }, x.danger ? icon('alert') : null, h('span', { dir: 'auto' }, x.label ? `${x.label[0].toUpperCase()}${x.label.slice(1)}` : x.name.replace(/^android\.permission\./, '')), x.label ? h('small', { class: 'src', dir: 'ltr' }, x.name.replace(/^android\.permission\./, '')) : null)))) : null;
  // A bundle's parts: languages and densities may be left out (smaller, and nothing lost on this phone).
  const opt = (info.partsAll ?? []).filter((x) => x.optional);
  let partsBox: HTMLElement | null = null;
  if (opt.length > 1) {
    const sel = new Set((info.parts ?? (info.partsAll ?? []).map((x) => x.name)));
    const kindName = (k: Part['kind']) => (k === 'lang' ? t('apkPartLang') : k === 'density' ? t('apkPartDensity') : k === 'abi' ? t('apkPartAbi') : k === 'feature' ? t('apkPartFeature') : t('apkPartBase'));
    const label = (n: string) => n.replace(/.*\//, '').replace(/\.apk$/i, '').replace(/^(split_)?config\./, '');
    partsBox = h('details', { class: 'apk-parts' }, h('summary', null, t('apkParts'), h('small', { class: 'src' }, ` · ${localDigits((info.partsAll ?? []).length)}`)),
      h('p', { class: 'hint' }, t('apkPartsHint')),
      ...(info.partsAll ?? []).map((x) => h('label', { class: 'row switch-row' }, h('span', null, h('span', { dir: 'ltr' }, label(x.name)), h('small', { class: 'src' }, `${kindName(x.kind)} · ${formatBytes(x.size)}`)), h('input', { type: 'checkbox', checked: sel.has(x.name), disabled: !x.optional, onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) sel.add(x.name); else sel.delete(x.name); onParts([...sel]); } }))));
  }
  return h('div', { class: 'apk-details' }, rows, permBox, partsBox);
}
