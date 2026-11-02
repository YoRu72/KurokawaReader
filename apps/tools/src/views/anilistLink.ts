// Linking AniList, the way Mihon does it — one «Sign in with AniList», the token taken from the page AniList ends
// on — when the app has its own API client; else a short guide that makes one with you: AniList's developer page
// opened, the name and the redirect address to put (one tap to copy), and the new client's ID found by itself
// (from the client's page opened in the app's window) or pasted — its number or its link, either is read. On the
// web, where no window can be watched, the token AniList shows is pasted.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import * as al from '../anilist';
import { ktPlugin } from '../native';

/** The app's own AniList API client (implicit grant: public by design, no secret), redirecting to AniList's pin
 *  page. Empty until one is registered for the app; the user's own client is used meanwhile. */
export const BUILTIN_ANILIST_CLIENT = al.BUILTIN_CLIENT;
export const PIN_REDIRECT = 'https://anilist.co/api/v2/oauth/pin';
export const clientId = (): string => getSettings().anilistClientId.trim() || BUILTIN_ANILIST_CLIENT;
/** A client's ID from what is pasted: the number itself, or its page's link (…/settings/client/12345). */
export const idFrom = (x: string): string => /client\/(\d+)/.exec(x)?.[1] ?? /\b(\d{3,8})\b/.exec(x)?.[1] ?? '';

async function capture(url: string, marker: string, title: string): Promise<string | null | undefined> {
  const d = window.kurokawaTools as (typeof window.kurokawaTools & { captureUrl?(o: { url: string; marker: string; title: string }): Promise<string | null> }) | undefined;
  if (d?.captureUrl) return d.captureUrl({ url, marker, title });
  const p = ktPlugin() as (ReturnType<typeof ktPlugin> & { captureUrl?(o: { url: string; marker: string; title: string }): Promise<{ url: string | null }> }) | null;
  if (p?.captureUrl) return (await p.captureUrl({ url, marker, title })).url;
  return undefined;
}

export function anilistLinkSheet(linked: () => void): void {
  const sh = openSheet(t('anilistLinkTitle'), t('close')); sh.el.classList.add('al-link');
  const linkWith = async (token: string) => { try { const u = await al.link(token.trim()); toast(t('anilistLinkedAs', { name: u.name })); sh.close(); linked(); } catch (e) { toast(`AniList: ${(e as Error).message}`, 'error', 6000); } };
  const tokenBox = h('textarea', { rows: 3, placeholder: t('anilistTokenPlaceholder'), dir: 'ltr', class: 'al-token' }) as HTMLTextAreaElement;
  const pasteRow = h('div', { class: 'al-paste', hidden: true }, h('p', { class: 'hint' }, t('anilistPasteToken')), tokenBox, h('button', { type: 'button', class: 'btn primary small', onclick: () => void linkWith(tokenBox.value) }, icon('check'), t('anilistLink')));
  const signIn = async () => {
    const id = clientId(); if (!id) { toast(t('anilistNeedClient'), 'error'); return; }
    const at = await capture(al.authUrl(), 'access_token=', t('anilistSignInWindow'));
    // (No window to watch — the web: AniList opened in a tab, its pin page showing the token to paste.)
    if (at === undefined) { window.open(al.authUrl(), '_blank', 'noopener'); pasteRow.hidden = false; return; }
    const token = at ? /access_token=([^&]+)/.exec(at)?.[1] : null;
    if (token) await linkWith(decodeURIComponent(token)); else if (at) toast(t('anilistDenied'), 'error', 6000);
  };
  const big = () => h('button', { type: 'button', class: 'btn primary al-signin', onclick: () => void signIn() }, icon('user'), t('anilistSignInWith'));
  const idIn = h('input', { type: 'text', dir: 'ltr', inputmode: 'url', value: getSettings().anilistClientId, placeholder: t('anilistIdOrLink'), class: 'al-id' }) as HTMLInputElement;
  const setId = (v: string) => { const id = idFrom(v); if (id) { idIn.value = id; updateSettings({ anilistClientId: id }); } return id; };
  idIn.addEventListener('change', () => { if (!setId(idIn.value) && idIn.value.trim()) toast(t('anilistIdBad'), 'error'); });
  const copy = (text: string) => h('button', { type: 'button', class: 'btn text small', onclick: () => void navigator.clipboard?.writeText(text).then(() => toast(t('copied'))) }, icon('copy'), t('copy'));
  const step = (n: number, title: string, ...kids: (Node | null)[]) => h('li', { class: 'al-step' }, h('span', { class: 'al-n' }, String(n)), h('div', { class: 'grow' }, h('b', null, title), ...kids.filter((k): k is Node => !!k)));
  const guide = h('ol', { class: 'al-steps' },
    step(1, t('anilistStep1'), h('p', { class: 'hint' }, t('anilistStep1Hint')), h('button', { type: 'button', class: 'btn tonal small', onclick: async () => {
      // (The client's page opened in the app's window gives its ID by itself.)
      const at = await capture('https://anilist.co/settings/developer', '/settings/client/', t('anilistDevWindow'));
      if (at === undefined) { window.open('https://anilist.co/settings/developer', '_blank', 'noopener'); return; }
      if (at && setId(at)) { toast(t('anilistIdFound', { id: idIn.value })); void signIn(); }
    } }, icon('external'), t('anilistOpenDev'))),
    step(2, t('anilistStep2'), h('div', { class: 'al-field' }, h('span', null, t('anilistName')), h('code', null, 'Kurokawa'), copy('Kurokawa')), h('div', { class: 'al-field' }, h('span', null, t('anilistRedirect')), h('code', { dir: 'ltr' }, PIN_REDIRECT), copy(PIN_REDIRECT))),
    step(3, t('anilistStep3'), h('p', { class: 'hint' }, t('anilistStep3Hint')), h('div', { class: 'al-idrow' }, idIn, h('button', { type: 'button', class: 'btn text small', onclick: async () => { try { const x = await navigator.clipboard.readText(); if (!setId(x)) toast(t('anilistIdBad'), 'error'); } catch { idIn.focus(); } } }, icon('import'), t('paste')))),
    step(4, t('anilistStep4'), big()));
  if (BUILTIN_ANILIST_CLIENT && !getSettings().anilistClientId) {
    // (The app's own client: one tap, as in Mihon; a client of one's own still possible below.)
    sh.body.append(h('p', { class: 'hint' }, t('anilistOneTap')), big(), h('details', { class: 'al-own' }, h('summary', null, t('anilistOwnClient')), guide));
  } else sh.body.append(h('p', { class: 'hint' }, t('anilistGuideIntro')), guide);
  sh.body.append(pasteRow, h('button', { type: 'button', class: 'btn text small al-show-paste', onclick: () => { pasteRow.hidden = !pasteRow.hidden; } }, t('anilistHaveToken')));
}
