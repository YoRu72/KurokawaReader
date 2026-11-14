// A sign-in for yt-dlp on a computer (the Tauri build, and Electron's): the app's own browser opens on the site; once
// the person has signed in there, «Use my sign-in» keeps the cookies of THAT site only, in a file of the app's data
// folder that only this user may read — given to yt-dlp (--cookies) for that site's links, the look and the download
// alike, never logged, never shown. Settings → Video lists the sites kept, each removable.
import { h, icon, openSheet, toast } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { openBrowser } from '../browser';

export interface KeptSite { site: string; count: number; at: number }
type Cookies = { videoCookies?(o: { op: string; url?: string; site?: string }): Promise<unknown> };
const bridge = (): Cookies | null => { const d = window.kurokawaTools as unknown as Cookies | undefined; return d?.videoCookies ? d : null; };
/** Whether this build keeps sign-ins per site (a shell that knows kt:videoCookies). */
export const canKeepSignIn = (): boolean => !!bridge();
const home = (u: string): string => { try { const x = new URL(u); return `${x.protocol}//${x.host}/`; } catch { return u; } };

/** The sign-in sheet for `url`'s site; `done` runs once a sign-in was kept (the link read again). */
export function pcSignIn(url: string, done: () => void): void {
  const b = bridge();
  // (A shell from before this: its own way — a browser's cookies, Settings → Video.)
  if (!b) { void import('../router').then((r) => r.navigate('/settings/video')); return; }
  const sh = openSheet(t('vSignInTitle'), t('close'), { stack: true });
  const note = h('p', { class: 'src small', dir: 'auto' });
  sh.body.append(h('p', { dir: 'auto' }, t('vSignInSteps')), h('p', { class: 'hint', dir: 'auto' }, icon('lock'), ' ', t('vSignInPrivacy')), note);
  const open = h('button', { type: 'button', class: 'btn tonal' }, icon('globe'), t('vSignInOpen')) as HTMLButtonElement;
  const use = h('button', { type: 'button', class: 'btn primary' }, icon('check'), t('vSignInUse')) as HTMLButtonElement;
  open.onclick = () => openBrowser(home(url));
  use.onclick = async () => {
    use.disabled = true;
    try {
      const r = (await b.videoCookies!({ op: 'save', url })) as { site: string; count: number };
      if (!r.count) { note.textContent = t('vSignInNone', { site: r.site }); use.disabled = false; return; }
      toast(t('vSignInKept', { site: r.site, n: localDigits(r.count) })); sh.close(); done();
    } catch (e) { note.textContent = String((e as Error).message ?? e); use.disabled = false; }
  };
  sh.actions.append(open, use);
  openBrowser(home(url));
}
export async function keptSites(): Promise<KeptSite[]> { const b = bridge(); if (!b) return []; try { return ((await b.videoCookies!({ op: 'list' })) as KeptSite[]) ?? []; } catch { return []; } }
export async function forgetSite(site: string): Promise<boolean> { const b = bridge(); if (!b) return false; try { return !!((await b.videoCookies!({ op: 'remove', site })) as { removed?: boolean }).removed; } catch { return false; } }
/** Settings → Video: «Signed-in sites», each with Remove (only on a build that keeps them). */
export function keptSitesCard(): HTMLElement | null {
  if (!canKeepSignIn()) return null;
  const list = h('div', { class: 'addons-list kept-sites' });
  const draw = async () => {
    const xs = await keptSites();
    list.replaceChildren(...(xs.length ? xs.map((x) => h('div', { class: 'addon-row' }, icon('key'), h('div', { class: 'grow' }, h('b', { dir: 'ltr' }, x.site), h('small', { class: 'src' }, t('vSignedInCount', { n: localDigits(x.count) }))),
      h('button', { type: 'button', class: 'btn text small', onclick: async () => { await forgetSite(x.site); toast(t('vSignedInRemoved', { site: x.site })); void draw(); } }, icon('trash'), t('remove')))) : [h('p', { class: 'src small' }, t('vSignedInNone'))]));
  };
  void draw();
  return h('div', { class: 'kept-sites-box' }, h('div', { class: 'row' }, h('span', null, t('vSignedInSites'), h('small', { class: 'src' }, t('vSignedInHint')))), list);
}
