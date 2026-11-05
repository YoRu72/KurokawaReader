// A stream by its manifest (an .m3u8 playlist or an .mpd), with the headers a site wants — the page as referer, a
// cookie, a user agent —: an HLS playlist goes to the app's own piece-by-piece fetcher (a phone) or yt-dlp, a DASH
// manifest to yt-dlp, both with the headers given; the name chosen here.
import { h, icon, openSheet, toast } from '../ui/dom';
import { t } from '../i18n';
import { getEngine } from '../engine';
import { getSettings } from '../settings';
export function manifestSheet(initial = ''): void {
  const sh = openSheet(t('manifestTitle'), t('cancel'));
  const url = h('input', { type: 'url', dir: 'ltr', value: initial, placeholder: 'https://…/master.m3u8', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const name = h('input', { type: 'text', dir: 'auto', placeholder: t('manifestNameHint') }) as HTMLInputElement;
  const referer = h('input', { type: 'url', dir: 'ltr', placeholder: 'https://site.example/page', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const cookie = h('input', { type: 'text', dir: 'ltr', placeholder: 'session=…; token=…', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const ua = h('input', { type: 'text', dir: 'ltr', placeholder: 'Mozilla/5.0 …', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const extra = h('textarea', { rows: 3, dir: 'ltr', placeholder: 'X-Custom: value', autocapitalize: 'off', spellcheck: 'false' }) as HTMLTextAreaElement;
  const field = (label: string, el: HTMLElement) => h('label', { class: 'field' }, h('span', null, label), el);
  sh.body.append(h('p', { class: 'hint' }, t('manifestHint')), field(t('manifestUrl'), url), field(t('fileName'), name), field(t('refererPage'), referer), field('Cookie', cookie), field('User-Agent', ua), field(t('manifestExtra'), extra));
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: async () => {
    const u = url.value.trim(); if (!/^https?:\/\//i.test(u)) { toast(t('invalidLink'), 'error'); return; }
    const headers: Record<string, string> = {}; if (referer.value.trim()) headers.Referer = referer.value.trim(); if (cookie.value.trim()) headers.Cookie = cookie.value.trim(); if (ua.value.trim()) headers['User-Agent'] = ua.value.trim();
    for (const line of extra.value.split('\n')) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    const { nativeHls } = await import('./addVideo'); const s = getSettings(); const nm = name.value.trim();
    try {
      if (nativeHls(u)) { await getEngine().add({ source: { url: u, headers }, name: nm ? (/\.(mp4|ts|mkv)$/i.test(nm) ? nm : `${nm}.mp4`) : undefined, connections: 8, meta: { hls: true, quality: /^\d+$/.test(s.videoQuality) ? `${s.videoQuality}p` : undefined } }); }
      else { const { videoEnabled } = await import('../video/ytdlp'); if (!videoEnabled()) { const { needAddon } = await import('../addons/need'); if (!(await needAddon('video', t('addonWhyVideo'), { start: true }))) return; } const { preferredFormat } = await import('./addVideo'); const pf = preferredFormat(); await getEngine().add({ source: { url: u }, video: { ...pf, container: s.videoContainer, headers, title: nm || undefined, outName: nm || undefined } }); }
      toast(t('taskAdded', { name: nm || u })); sh.close();
    } catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); }
  } }, icon('download'), t('addStart')));
}
