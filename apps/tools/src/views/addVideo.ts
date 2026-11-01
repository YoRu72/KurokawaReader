// The Add sheet's smart part: a link that is a page rather than a file is shown to yt-dlp (the Video add-on), and
// what it finds — the title and picture, the qualities, the audio, the subtitles, a playlist's videos — appears in
// the same sheet to pick from. A page yt-dlp cannot read is downloaded as an ordinary link; a video site's page
// without the add-on offers to add it there and then.
import { h, icon, toast } from '../ui/dom';
import { t, formatBytes, localDigits, countVideos } from '../i18n';
import { getSettings } from '../settings';
import type { AddOptions } from '../engine/types';
import { VIDEO_ADDON, isVideoHost, looksLikeFile, pageInfo, videoEnabled, videoSupported, type PageInfo, type VideoChoice } from '../video/ytdlp';

export type VideoPick = NonNullable<AddOptions['video']>;
export interface VideoPanel {
  el: HTMLElement;
  /** Looks at one link (or clears the panel for anything else). */
  check(url: string | null): void;
  /** What to add for the link checked: one video, a playlist's videos, or null (an ordinary download). */
  picks(): { url: string; video: VideoPick }[] | null;
  /** Whether a check is still running (the Download button waits for it). */
  busy(): Promise<void>;
}

const dur = (s?: number) => { if (!s || !isFinite(s)) return ''; s = Math.round(s); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return localDigits((hh ? `${hh}:${String(m).padStart(2, '0')}:` : `${m}:`) + String(sec).padStart(2, '0')); };
/** The preferred quality as a yt-dlp format (for links added without a look, and a playlist's videos). */
export function preferredFormat(): Pick<VideoPick, 'format' | 'audioOnly' | 'label'> {
  const q = getSettings().videoQuality;
  if (q === 'audio') return { format: 'bestaudio/best', audioOnly: true, label: t('videoAudioOnly') };
  if (q === 'best') return { format: undefined, label: t('videoBest') };
  return { format: `bestvideo[height<=${q}]+bestaudio/best[height<=${q}]`, label: `${q}p` };
}
/** A link worth asking yt-dlp about: a web page (a video site's, or any page not naming a file). */
export const pageLike = (url: string): boolean => /^https?:\/\//i.test(url) && (isVideoHost(url) || /\.(m3u8|mpd)(\?|$)/i.test(url) || !looksLikeFile(url));

export function videoPanel(onChange: () => void): VideoPanel {
  const el = h('div', { class: 'video-panel', hidden: true });
  let url: string | null = null; let info: PageInfo | null = null; let chosen: VideoChoice | null = null; let subs = false; let token = 0; let running: Promise<void> = Promise.resolve();
  const s = getSettings();
  const pickDefault = (i: PageInfo) => {
    if (i.kind !== 'video') return;
    const q = s.videoQuality;
    if (q === 'audio') chosen = i.audio[0] ?? null;
    else if (q === 'best') chosen = i.choices[0] ?? null;
    else chosen = i.choices.find((c) => (c.height ?? 0) <= Number(q)) ?? i.choices[i.choices.length - 1] ?? null;
    subs = s.subLangs.some((l) => i.subtitles.some((x) => x === l || x.startsWith(`${l}-`)));
  };
  const draw = () => {
    if (!info) return;
    if (info.kind === 'playlist') {
      const pf = preferredFormat();
      el.replaceChildren(h('div', { class: 'video-card' }, h('span', { class: 'video-thumb none' }, icon('list')),
        h('div', { class: 'video-text' }, h('b', { dir: 'auto' }, info.title || url || ''), h('small', { class: 'src' }, `${countVideos(info.count)} · ${pf.label}`))));
      return;
    }
    const i = info;
    const chip = (c: VideoChoice) => h('button', { type: 'button', class: `chip small${chosen?.id === c.id ? ' on' : ''}`, 'aria-pressed': String(chosen?.id === c.id), onclick: () => { chosen = c; draw(); onChange(); } },
      c.kind === 'audio' ? icon('music') : null, h('span', { dir: 'ltr' }, c.label), c.size ? h('small', { class: 'src' }, formatBytes(c.size)) : null);
    const meta = [i.uploader, dur(i.duration), i.site].filter(Boolean).join(' · ');
    const langs = s.subLangs.filter((l) => i.subtitles.some((x) => x === l || x.startsWith(`${l}-`)));
    el.replaceChildren(...[
      h('p', { class: 'video-ready' }, icon('check'), t('videoYtdlpReadyShort')),
      h('div', { class: 'video-card' },
        i.thumbnail ? h('img', { class: 'video-thumb', src: i.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'video-thumb none' }, icon('film')),
        h('div', { class: 'video-text' }, h('b', { dir: 'auto' }, i.title), meta ? h('small', { class: 'src', dir: 'auto' }, meta) : null, i.live ? h('span', { class: 'badge live' }, t('videoLive')) : null)),
      i.choices.length ? h('div', { class: 'video-choices' }, h('span', { class: 'label' }, t('videoQuality')), h('div', { class: 'chip-row wrap' }, ...i.choices.map(chip))) : null,
      i.audio.length ? h('div', { class: 'video-choices' }, h('span', { class: 'label' }, t('videoAudioOnly')), h('div', { class: 'chip-row wrap' }, ...i.audio.map(chip))) : null,
      langs.length ? h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: subs, onchange: (e: Event) => { subs = (e.target as HTMLInputElement).checked; } }), h('span', null, t('videoSubs', { langs: langs.join('، ') }))) : null].filter((x): x is NonNullable<typeof x> => !!x));
  };
  const offerAddon = () => {
    el.hidden = false;
    el.replaceChildren(h('div', { class: 'video-card offer' }, h('span', { class: 'video-thumb none' }, icon('film')), h('div', { class: 'video-text' }, h('span', null, t('videoYtdlpMissingLong'))),
      h('button', { type: 'button', class: 'btn tonal small', onclick: async (e: Event) => { const b = e.currentTarget as HTMLButtonElement; b.disabled = true; const { needAddon } = await import('../addons/need'); if (await needAddon(VIDEO_ADDON, t('addonWhyVideo'))) { const u = url; url = null; check(u); } else b.disabled = false; } }, t('videoAddIt')),
      h('button', { type: 'button', class: 'btn text small', onclick: () => { document.querySelectorAll('.sheet, .sheet-scrim').forEach((x) => x.remove()); void import('../router').then((r) => r.navigate('/settings/addons')); } }, t('videoOpenAddons'))));
  };
  const check = (u: string | null) => {
    if (u === url) return; url = u; info = null; chosen = null; const my = ++token;
    if (!u || !pageLike(u)) { el.hidden = true; el.replaceChildren(); onChange(); return; }
    if (!videoEnabled()) { if (videoSupported() && isVideoHost(u)) offerAddon(); else { el.hidden = true; el.replaceChildren(); } onChange(); return; }
    el.hidden = false; el.replaceChildren(h('div', { class: 'center small' }, h('div', { class: 'spinner small' }), ` ${t('videoChecking')}`));
    const playlist = /[?&]list=|\/playlist\b|\/sets\/|\/album\//i.test(u) && !/[?&]v=/.test(u);
    running = pageInfo(u, playlist).then((got) => { if (my !== token) return; info = got; pickDefault(got); draw(); onChange(); }, () => {
      if (my !== token) return;
      // Not a page yt-dlp reads: an ordinary download, said quietly only when a video site was expected.
      if (isVideoHost(u)) { el.replaceChildren(h('p', { class: 'src small' }, t('videoFallback'))); } else { el.hidden = true; el.replaceChildren(); }
      onChange();
    });
  };
  const base = (audio = false): Omit<VideoPick, 'format' | 'audioOnly' | 'label'> => ({ container: audio ? undefined : s.videoContainer, embedThumb: s.videoEmbedThumb, sponsorblock: s.videoSponsor });
  return {
    el, check, busy: () => running,
    picks() {
      if (!url || !info) return null;
      if (info.kind === 'playlist') return info.entries.filter((e) => e.url).map((e, n) => ({ url: e.url, video: { ...base(preferredFormat().audioOnly), ...preferredFormat(), title: e.title, playlistIndex: n + 1 } }));
      const i = info; const c = chosen;
      const langs = s.subLangs.filter((l) => i.subtitles.some((x) => x === l || x.startsWith(`${l}-`)));
      return [{ url: i.url || url, video: { ...base(c?.kind === 'audio'), format: c?.id, audioOnly: c?.kind === 'audio', label: c?.label, title: i.title, site: i.site, thumbnail: i.thumbnail, subs: subs && langs.length ? langs.join(',') : undefined } }];
    },
  };
}
