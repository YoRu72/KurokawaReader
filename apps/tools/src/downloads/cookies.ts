// Cookie jars (Android): saved signed-in states a site — from the app's browser or a cookies.txt — named, tested,
// chosen per download. The values never reach the page: the native side keeps them encrypted and hands out only
// what describes each jar.
import { h, icon, iconButton, openSheet, toast, pickButton } from '../ui/dom';
import { t, dateLocale, localDigits } from '../i18n';
import { ktPlugin } from '../native';

export interface Jar { id: string; name: string; domain: string; savedAt: number; count: number; expiresAt?: number; source: 'browser' | 'text'; testedAt?: number; testOk?: boolean }
type P = { cookieJars(o: { host?: string }): Promise<{ list: Jar[] }>; cookieJarSave(o: { id?: string; name: string; domain: string; text: string }): Promise<{ id: string; count: number }>; cookieJarFromBrowser(o: { id?: string; name: string; url: string }): Promise<{ id: string; count: number }>; cookieJarDelete(o: { id: string }): Promise<void>; cookieJarTest(o: { id: string; url?: string }): Promise<{ ok: boolean; status: number }> };
const pl = (): P | null => ktPlugin() as unknown as P | null;
export const jarsAvailable = (): boolean => !!pl();
export async function jars(host?: string): Promise<Jar[]> { const p = pl(); if (!p) return []; try { const r = await p.cookieJars(host ? { host } : {}); return Array.isArray(r?.list) ? r.list : []; } catch { return []; } }

const fmt = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : '');
/** Fresh while its soonest cookie has more than a day; stale after. */
export const freshness = (j: Jar): 'fresh' | 'soon' | 'stale' => (!j.expiresAt ? 'fresh' : j.expiresAt < Date.now() ? 'stale' : j.expiresAt - Date.now() < 86400e3 ? 'soon' : 'fresh');

/** The manager: every jar, with take-from-browser, paste, test, delete. */
export function cookiesSheet(): void {
  const sh = openSheet(t('cookiesTitle'), t('close')); const list = h('div', { class: 'dest-list' });
  const draw = async () => {
    const js = await jars();
    list.replaceChildren(...(js.length ? js.map((j) => { const f = freshness(j); return h('div', { class: 'dest-row' }, icon(j.source === 'browser' ? 'globe' : 'file'), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'auto' }, j.name), h('small', { class: 'src', dir: 'auto' }, [j.domain, t('cookiesCount', { n: localDigits(String(j.count)) }), t('cookiesSaved', { d: fmt(j.savedAt) }), f === 'stale' ? t('cookiesStale') : f === 'soon' ? t('cookiesSoon') : j.expiresAt ? t('cookiesUntil', { d: fmt(j.expiresAt) }) : '', j.testedAt ? (j.testOk ? t('cookiesTestOk') : t('cookiesTestNo')) : ''].filter(Boolean).join(' · '))),
      iconButton('check', t('cookiesTest'), async () => { try { const r = await pl()!.cookieJarTest({ id: j.id }); toast(r.ok ? t('cookiesTestOk') : t('cookiesTestNoStatus', { n: localDigits(String(r.status)) }), r.ok ? undefined : 'error'); void draw(); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } }),
      iconButton('refresh', t('cookiesRetake'), () => fromBrowser(j, draw)),
      iconButton('trash', t('delete'), async () => { await pl()!.cookieJarDelete({ id: j.id }).catch(() => undefined); void draw(); })); }) : [h('p', { class: 'hint' }, t('cookiesNone'))]));
  };
  sh.body.append(h('p', { class: 'hint' }, t('cookiesHint')), list);
  sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => fromBrowser(null, draw) }, icon('globe'), t('cookiesFromBrowser')), h('button', { type: 'button', class: 'btn primary', onclick: () => pasteSheet(draw) }, icon('plus'), t('cookiesPaste')));
  void draw();
}
/** A sign-in for a site that wants one (a video page yt-dlp could not read): its cookies taken from the app's browser, signed in there. */
export function signInFor(link: string, done: () => void): void { let site = ''; try { site = `${new URL(link).origin}/`; } catch { /* as typed */ } fromBrowser(null, done, site); }
function fromBrowser(j: Jar | null, done: () => void, preset = ''): void {
  const sh = openSheet(t('cookiesFromBrowser'), t('cancel'), { stack: true });
  const url = h('input', { type: 'url', dir: 'ltr', value: j ? `https://${j.domain}/` : preset, placeholder: 'https://example.com/', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const name = h('input', { type: 'text', dir: 'auto', value: j?.name ?? '', placeholder: t('cookiesNameHint') }) as HTMLInputElement;
  sh.body.append(h('p', { class: 'hint' }, t('cookiesFromBrowserHint')), h('label', { class: 'field' }, h('span', null, t('cookiesSite')), url), h('label', { class: 'field' }, h('span', null, t('ruleName')), name));
  sh.actions.append(h('button', { type: 'button', class: 'btn text', onclick: () => { const u = url.value.trim(); if (u) void import('../browser').then((m) => m.openBrowser(u)); } }, icon('globe'), t('cookiesOpenSite')),
    h('button', { type: 'button', class: 'btn primary', onclick: async () => { const u = url.value.trim(); if (!/^https?:\/\//i.test(u)) { toast(t('invalidLink'), 'error'); return; } try { const r = await pl()!.cookieJarFromBrowser({ id: j?.id, name: name.value.trim(), url: u }); toast(t('cookiesTaken', { n: localDigits(String(r.count)) })); sh.close(); done(); } catch (e) { toast(/noCookies/.test(String((e as Error).message)) ? t('cookiesNoneInBrowser') : String((e as Error).message ?? e), 'error', 6000); } } }, icon('check'), t('cookiesTake')));
}
function pasteSheet(done: () => void): void {
  const sh = openSheet(t('cookiesPaste'), t('cancel'), { stack: true });
  const name = h('input', { type: 'text', dir: 'auto', placeholder: t('cookiesNameHint') }) as HTMLInputElement;
  const domain = h('input', { type: 'text', dir: 'ltr', placeholder: 'example.com', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const ta = h('textarea', { rows: 8, dir: 'ltr', placeholder: '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tTRUE\t0\tsession\tabc…\n\nor: session=abc; token=xyz', autocapitalize: 'off', spellcheck: 'false' }) as HTMLTextAreaElement;
  sh.body.append(h('p', { class: 'hint' }, t('cookiesPasteHint')), h('label', { class: 'field' }, h('span', null, t('ruleName')), name), h('label', { class: 'field' }, h('span', null, t('cookiesDomain')), domain), ta);
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => { try { const r = await pl()!.cookieJarSave({ name: name.value.trim(), domain: domain.value.trim(), text: ta.value }); toast(t('cookiesTaken', { n: localDigits(String(r.count)) })); sh.close(); done(); } catch (e) { toast(/noCookies/.test(String((e as Error).message)) ? t('cookiesNoneInText') : String((e as Error).message ?? e), 'error', 6000); } } }, icon('check'), t('save')));
}
/** A picker for one download: the jars that fit the host first, then the rest; none by default. */
export async function jarPicker(host: string, onChange: (id: string) => void): Promise<HTMLElement | null> {
  if (!jarsAvailable()) return null;
  const fit = await jars(host); const all = await jars(); if (!all.length) return null;
  const opts: [string, string][] = [['', t('cookiesNoneOpt')], ...fit.map((j) => [j.id, `${j.name} · ${j.domain}`] as [string, string]), ...all.filter((j) => !fit.some((f) => f.id === j.id)).map((j) => [j.id, `${j.name} · ${j.domain}`] as [string, string])];
  return h('label', { class: 'field row' }, h('span', { class: 'label' }, t('cookiesTitle')), pickButton(t('cookiesTitle'), opts, fit[0]?.id ?? '', onChange, t('close')));
}
