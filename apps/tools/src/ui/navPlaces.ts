// The places of the bottom bar (the side rail on a computer), each with its icon, its name's key and its page: those
// the installed add-ons bring, Settings last. The reader orders them and leaves some off (Settings → The app).
import type { Settings } from '../settings';

export function navPlacesAll(s: Settings): [id: string, icon: string, key: string, path: string][] {
  return [
    ['downloads', 'download', 'navDownloads', '/'],
    ['search', 'search', 'navSearch', '/search'],
    ...(s.addons.includes('anime') ? [['anime', 'tv', 'navAnime', '/anime'] as [string, string, string, string]] : []),
    ...(s.addons.includes('tv') ? [['tv', 'film', 'navTv', '/tv'] as [string, string, string, string]] : []),
    ...(s.addons.includes('player') && s.videosTab !== false ? [['videos', 'playCircle', 'navVideos', '/videos'] as [string, string, string, string]] : []),
    ...(s.addons.includes('files') ? [['files', 'folder', 'navFiles', '/files'] as [string, string, string, string]] : []),
    ...(s.addons.includes('subtitles') ? [['subs', 'subtitles', 'navSubs', '/subs'] as [string, string, string, string]] : []),
    ['settings', 'settings', 'navSettings', '/settings'],
  ];
}
