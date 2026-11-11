// What to get from a video page, the one place every way of adding a video asks: the saved default (the last choice,
// or what Settings said before there was a choice), the options turned into yt-dlp's arguments (src/downloads/videoArgs.ts),
// and the ffmpeg pack checked before a choice that needs it is added. The Add sheet's chooser, a clipboard hotkey, a followed
// channel, a course, a grabbed stream — all end here, so they agree.
import { getSettings, updateSettings } from '../settings';
import { t } from '../i18n';
import type { AddOptions } from '../engine/types';
import { DEFAULT_OPTIONS, buildVideoArgs, normaliseOptions, resolveFragments, type ArgsContext, type BuiltArgs, type VideoOptions } from '../downloads/videoArgs';

type Pick = NonNullable<AddOptions['video']>;

/** The options Settings implied before the chooser existed (quality, format, cover, SponsorBlock, chapters, name, numbering). */
export function legacyOptions(): VideoOptions {
  const s = getSettings(); const q = s.videoQuality;
  return normaliseOptions({ mode: q === 'audio' ? 'audio' : 'video', height: /^\d+$/.test(q) ? Number(q) : 0, container: s.videoContainer, embedThumb: s.videoEmbedThumb, sponsor: s.videoSponsorMode ?? (s.videoSponsor ? 'remove' : 'off'), sponsorCats: s.videoSponsorCats ?? ['sponsor'], chapters: s.videoChapters === false ? 'off' : 'embed', name: s.videoTemplate ? 'custom' : 'title', custom: s.videoTemplate ?? '', number: s.videoNumber !== false });
}
/** The default: the last choice kept, over what Settings said. */
export const defaultOptions = (): VideoOptions => normaliseOptions(getSettings().videoOpts, legacyOptions());
export const hasSavedChoice = (): boolean => !!getSettings().videoOpts;
/** Kept as the default (not the playlist part: that belongs to one link). */
export function saveDefaults(o: VideoOptions): void { updateSettings({ videoOpts: { ...o, playlist: 'one', range: '' } }); }
export const presetsList = (): { name: string; opts: VideoOptions }[] => (getSettings().videoPresets ?? []).map((p) => ({ name: String(p.name).slice(0, 40), opts: normaliseOptions(p.opts, DEFAULT_OPTIONS) }));
export function savePreset(name: string, o: VideoOptions): void { const n = name.trim().slice(0, 40); if (!n) return; updateSettings({ videoPresets: [...(getSettings().videoPresets ?? []).filter((p) => p.name !== n), { name: n, opts: { ...o, playlist: 'one' as const, range: '' } }].slice(-12) }); }
export function deletePreset(name: string): void { updateSettings({ videoPresets: (getSettings().videoPresets ?? []).filter((p) => p.name !== name) }); }
/** The four quick presets, as options (built in: nothing saved for them). */
export const BUILT_IN: { id: 'fast' | 'quality' | 'compact' | 'music'; label: 'presetFast' | 'presetQuality' | 'presetCompact' | 'presetMusic'; icon: string; opts: Partial<VideoOptions> }[] = [
  { id: 'fast', label: 'presetFast' as const, icon: 'flash', opts: { mode: 'video', height: 480, container: 'mp4', fps60: false } },
  { id: 'quality', label: 'presetQuality' as const, icon: 'star', opts: { mode: 'video', height: 0, container: 'mp4', fps60: true } },
  { id: 'compact', label: 'presetCompact' as const, icon: 'archive', opts: { mode: 'video', height: 720, container: 'mp4', fps60: false } },
  { id: 'music', label: 'presetMusic' as const, icon: 'music', opts: { mode: 'audio', audio: 'mp3', mp3Rate: '320' } },
];

/** Whether ffmpeg is here (the pack): merging, converting and embedding need it; an audio file taken as it is does not. */
export async function ffmpegHere(): Promise<boolean> {
  try { const { status, packsHere } = await import('../packs'); if (!packsHere()) return true; const st = await status(); return !!st?.ffmpeg?.version; } catch { return true; }
}
/** Offers the ffmpeg pack when this choice needs it and it is not here (the same card as everywhere); false when declined — nothing is added then. */
export async function gateFfmpeg(needs: string[]): Promise<boolean> {
  if (!needs.length || await ffmpegHere()) return true;
  const { ensurePacks } = await import('../packs'); const ok = await ensurePacks(['ffmpeg'], t('vcNeedsFfmpeg'));
  return ok && await ffmpegHere();
}
/** What Settings adds beside a video: sidecars for a media server, comments, a live stream's chat, the cover picture. */
export function settingsExtras(): NonNullable<ArgsContext['extras']> {
  const s = getSettings();
  return { infoJson: (s.sidecarNfo || s.sidecarComments || s.sidecarChapters || s.sidecarLyrics) || undefined, cover: s.sidecarCover || undefined, comments: s.sidecarComments || undefined, liveChat: s.sidecarLiveChat || undefined };
}
export const fragmentsNow = (): number => resolveFragments(getSettings().videoFragments, getSettings().connections);
export const argsContext = (ffmpeg: boolean, more: ArgsContext = {}): ArgsContext => ({ fragments: fragmentsNow(), ffmpeg, ...more, extras: { ...settingsExtras(), ...(more.extras ?? {}) } });
export const build = (o: VideoOptions, ffmpeg: boolean, more: ArgsContext = {}): BuiltArgs => buildVideoArgs(o, argsContext(ffmpeg, more));

/** The audio format's name for the phase line («converting to MP3»). */
export const audioName = (o: VideoOptions): string => (o.mode === 'audio' ? o.audio.toUpperCase() : '');

/** Options for a video added without the chooser (a hotkey, a follow, a course, a stream): the default, with what that caller said. */
export function optionsFromPick(v: Pick): VideoOptions {
  const o = defaultOptions();
  if (v.audioOnly === true) o.mode = 'audio';
  if (v.subs) o.subs = { ...o.subs, on: true, langs: String(v.subs).split(',').map((x) => x.trim()).filter(Boolean), how: o.subs.how };
  if (v.chapters === true && o.chapters === 'off') o.chapters = 'embed';
  if (v.splitChapters) o.chapters = 'split';
  return normaliseOptions(o);
}
/** The extras a pick carries (parts, headers, a bilingual pair). */
export const extrasOfPick = (v: Pick): NonNullable<ArgsContext['extras']> => ({ section: v.section, chapterMatch: v.chapterMatch, headers: v.headers, bilingual: !!v.bilingual, outName: v.outName, ...(v.infoJson !== undefined ? { infoJson: v.infoJson } : {}), ...(v.cover !== undefined ? { cover: v.cover } : {}), ...(v.comments !== undefined ? { comments: v.comments } : {}), ...(v.liveChat !== undefined ? { liveChat: v.liveChat } : {}) });

/** A video add with no argument list yet (every caller but the sheet): the list built from the default and what the caller said, ffmpeg checked.
 *  Throws the reason when the choice needs ffmpeg and it was declined. */
export async function withVideoArgs(o: AddOptions): Promise<AddOptions> {
  const v = o.video; if (!v || v.args) return o;
  const opts = optionsFromPick(v); const have = await ffmpegHere();
  if (!(await gateFfmpeg(build(opts, false, { playlistIndex: v.playlistIndex, extras: extrasOfPick(v) }).needs))) throw new Error(t('vcNeedsFfmpeg'));
  const b = build(opts, await ffmpegHere() || have, { playlistIndex: v.playlistIndex, playlistTitle: v.playlistTitle, extras: extrasOfPick(v) });
  return { ...o, video: { ...v, args: b.args, audioFmt: audioName(opts), audioOnly: opts.mode === 'audio', container: opts.mode === 'audio' ? undefined : opts.container } };
}
