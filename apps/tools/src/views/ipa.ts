// The iOS app installer (an IPA): what the app is, shown first — icon, name, bundle identifier, version and build,
// the iOS it needs and the devices it is for, its size, what it asks to use, its extensions — and how it is
// signed (by whom, until when, for which devices; or not at all). Then installed the way an iPhone allows an app
// from outside the App Store: handed to the sideloading app that signs and installs it — SideStore, AltStore,
// TrollStore — by its link, or the file itself through the share sheet. Elsewhere (Android, a computer) the app is
// looked into, and the way to put it on an iPhone said.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits, getLang } from '../i18n';
import type { IpaInfo } from '../ipa/read';
import { safeDecode } from '../downloads/probe';

export const IPA_RE = /\.ipa$/i;
export const isIpaName = (n: string): boolean => IPA_RE.test(n);
/** An iPhone or iPad (iPadOS shows itself as a Mac with a touch screen). */
export const isIos = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
/** The Kurokawa apps' AltStore/SideStore source (the Reader, published with each release). */
export const KUROKAWA_SOURCE = 'https://yoru72.github.io/KurokawaReader/altstore.json';

/** The installers an iPhone can hand an IPA's link to (each opens with the link and installs it). */
export const INSTALLERS: { id: string; name: string; scheme: (url: string) => string }[] = [
  { id: 'sidestore', name: 'SideStore', scheme: (u) => `sidestore://install?url=${encodeURIComponent(u)}` },
  { id: 'altstore', name: 'AltStore', scheme: (u) => `altstore://install?url=${encodeURIComponent(u)}` },
  { id: 'trollstore', name: 'TrollStore', scheme: (u) => `apple-magnifier://install?url=${encodeURIComponent(u)}` },
];

/** The IPA picked from the device (the Files app on an iPhone), then shown. */
export function pickIpa(): void {
  const input = h('input', { type: 'file', accept: '.ipa,application/octet-stream', hidden: true }) as HTMLInputElement;
  input.addEventListener('change', () => { const f = input.files?.[0]; input.remove(); if (f) void ipaSheet({ file: f, name: f.name }); });
  document.body.append(input); input.click();
}

/** An IPA, from a file, a link, or both: looked into, then installed. */
export async function ipaSheet(src: { file?: Blob; url?: string; name?: string }): Promise<void> {
  const sh = openSheet(t('ipaTitle'), t('close')); sh.el.classList.add('ipa-sheet');
  const name = src.name ?? (src.url ? safeDecode(src.url.split('?')[0].split('/').pop() ?? '') : 'app.ipa');
  let info: IpaInfo | null = null;
  if (src.file) {
    sh.body.append(h('div', { class: 'center' }, h('div', { class: 'spinner' }), h('p', { class: 'src small' }, t('ipaReading'))));
    try { const { readIpa } = await import('../ipa/read'); info = await readIpa(src.file); }
    catch (e) { const m = String((e as Error).message ?? e); sh.body.replaceChildren(h('p', { class: 'empty small' }, /notZip|notIpa/.test(m) ? t('ipaNotApp') : m)); return; }
  }
  sh.body.replaceChildren();
  const dl = (k: string, v: string | null, cls = '') => (v ? h('div', { class: 'ipa-row ' + cls }, h('dt', null, k), h('dd', null, v)) : null);
  if (info) {
    const iconEl = info.icon ? h('img', { class: 'ipa-icon', alt: '', src: URL.createObjectURL(info.icon) }) : h('span', { class: 'ipa-icon none' }, icon('apps'));
    const fmtDate = (d: Date) => d.toLocaleDateString(getLang(), { year: 'numeric', month: 'short', day: 'numeric' });
    const pf = info.profile; const expired = !!pf?.expires && pf.expires.getTime() < Date.now();
    const signing = !info.signed ? t('ipaUnsigned') : !pf ? t('ipaSignedNoProfile') : [t(`ipaKind_${pf.kind.replace('-', '')}` as 'ipaKind_adhoc'), pf.team, pf.expires ? (expired ? t('ipaExpired', { date: fmtDate(pf.expires) }) : t('ipaExpires', { date: fmtDate(pf.expires) })) : '', pf.devices !== undefined ? t('ipaDevices', { n: localDigits(pf.devices) }) : ''].filter(Boolean).join(' · ');
    sh.body.append(...[
      h('div', { class: 'ipa-head' }, iconEl, h('div', { class: 'grow' }, h('b', { dir: 'auto' }, info.name || name), h('small', { class: 'src', dir: 'ltr' }, info.bundleId), h('small', { class: 'src' }, `${info.version}${info.build && info.build !== info.version ? ` (${info.build})` : ''} · ${formatBytes(info.size)}`))),
      h('dl', { class: 'ipa-facts' },
        dl(t('ipaNeeds'), info.minOS ? `iOS ${info.minOS}` : null),
        dl(t('ipaFor'), info.devices.join(' · ')),
        dl(t('ipaSigning'), signing, expired || !info.signed ? 'warn' : ''),
        dl(t('ipaUnpacked'), formatBytes(info.unpacked)),
        dl(t('ipaExtensions'), info.extensions.length ? info.extensions.join(', ') : null),
        dl(t('ipaFrameworks'), info.frameworks ? localDigits(info.frameworks) : null)),
      info.uses.length ? h('details', { class: 'ipa-uses' }, h('summary', null, t('ipaUses', { n: localDigits(info.uses.length) })), h('ul', null, ...info.uses.map((u) => h('li', null, h('b', null, u.key), h('small', { class: 'src', dir: 'auto' }, u.text))))) : null,
      expired ? h('p', { class: 'plan-note bad' }, t('ipaExpiredNote')) : null].filter((x): x is NonNullable<typeof x> => !!x));
  } else sh.body.append(h('div', { class: 'ipa-head' }, h('span', { class: 'ipa-icon none' }, icon('apps')), h('div', { class: 'grow' }, h('b', { dir: 'auto' }, name), src.url ? h('small', { class: 'src', dir: 'ltr' }, src.url) : null)));

  if (isIos()) {
    // On the iPhone: the link handed to the installer chosen, or the file shared to it.
    const fileToShare = src.file ? new File([src.file], name.endsWith('.ipa') ? name : `${name}.ipa`, { type: 'application/octet-stream' }) : null;
    const canShare = !!fileToShare && !!navigator.canShare?.({ files: [fileToShare] });
    sh.body.append(h('h4', { class: 'ipa-sub' }, t('ipaInstallWith')), h('p', { class: 'hint' }, src.url ? t('ipaLinkHint') : t('ipaShareHint')));
    // (The installer used last time is remembered: then one «Install» does it all.)
    const used = (() => { try { return localStorage.getItem('kt.ipaInstaller') ?? ''; } catch { return ''; } })(); const last = INSTALLERS.find((i) => i.id === used);
    const pick = (id: string) => { try { localStorage.setItem('kt.ipaInstaller', id); } catch { /* none */ } };
    if (src.url && last) sh.body.append(h('a', { class: 'btn primary ipa-go', href: last.scheme(src.url), onclick: () => toast(t('ipaOpening', { app: last.name })) }, icon('download'), t('ipaInstallVia', { app: last.name })));
    if (src.url) sh.body.append(h('div', { class: 'ipa-installers' }, ...INSTALLERS.filter((i) => i !== last).map((i) => h('a', { class: 'btn tonal', href: i.scheme(src.url!), onclick: () => { pick(i.id); toast(t('ipaOpening', { app: i.name })); } }, icon('download'), i.name))));
    if (canShare) sh.body.append(h('button', { type: 'button', class: 'btn primary', onclick: () => void navigator.share({ files: [fileToShare!], title: info?.name ?? name }).catch(() => undefined) }, icon('share'), t('ipaShareTo')));
    if (!src.url && !canShare) sh.body.append(h('p', { class: 'plan-note' }, t('ipaNoWay')));
  } else sh.body.append(h('p', { class: 'plan-note' }, t('ipaElsewhere')));
  sh.body.append(h('details', { class: 'ipa-help' }, h('summary', null, t('ipaWhich')), h('p', { class: 'hint' }, t('ipaWhichBody')),
    h('div', { class: 'ipa-installers' }, ...(isIos() ? [h('a', { class: 'btn text small', href: `sidestore://source?url=${encodeURIComponent(KUROKAWA_SOURCE)}` }, icon('plus'), t('ipaAddSource', { app: 'SideStore' })), h('a', { class: 'btn text small', href: `altstore://source?url=${encodeURIComponent(KUROKAWA_SOURCE)}` }, icon('plus'), t('ipaAddSource', { app: 'AltStore' }))] : []),
      h('button', { type: 'button', class: 'btn text small', onclick: () => void navigator.clipboard?.writeText(KUROKAWA_SOURCE).then(() => toast(t('copied'))) }, icon('copy'), t('ipaCopySource')))));
}
