// The pets' choices (Settings → Pets, a computer only), with their defaults; small, so the settings can name its type.
export interface PetLink { title: string; url: string }
export interface PetPrefs {
  /** Shown at all (off until a pet was added). */
  on: boolean;
  /** In the app's window (works everywhere) or on the desktop (a window of its own). */
  where: 'app' | 'desktop';
  /** The desktop: walks on the active window's top (the Tauri build; not on Wayland). */
  follow: boolean;
  size: 'S' | 'M' | 'L' | 'custom'; custom: number;
  activity: 'calm' | 'normal' | 'lively';
  chase: boolean;
  pauseVideo: boolean; pauseBattery: boolean;
  speech: boolean;
  /** The pets shown (library ids), up to three. */
  active: string[];
  /** «Suggested»: links to pages outside the app, the user's to edit. */
  links: PetLink[];
}
export const MAX_ACTIVE = 3;
/** The one suggestion the app starts with (the owner's choice): a page, opened in the browser; nothing is fetched. */
export const DEFAULT_LINKS: PetLink[] = [{ title: 'MikuPet — CharlesWiiFlowers', url: 'https://github.com/CharlesWiiFlowers/MikuPet' }];
export const PET_DEFAULTS: PetPrefs = { on: false, where: 'app', follow: true, size: 'M', custom: 1, activity: 'normal', chase: false, pauseVideo: true, pauseBattery: true, speech: false, active: [], links: DEFAULT_LINKS };
export function petPrefs(p: Partial<PetPrefs> | undefined): PetPrefs {
  const o = { ...PET_DEFAULTS, ...(p ?? {}) };
  return { ...o, active: Array.isArray(o.active) ? o.active.filter((x) => typeof x === 'string').slice(0, MAX_ACTIVE) : [], links: Array.isArray(o.links) ? o.links.filter((l) => l && typeof l.url === 'string' && /^https:\/\//i.test(l.url)).slice(0, 20) : DEFAULT_LINKS, custom: Math.min(4, Math.max(0.25, Number(o.custom) || 1)) };
}
/** A link the user typed: https only, a sane length. */
export function cleanLink(title: string, url: string): PetLink | null {
  const u = url.trim(); let ok = false; try { const x = new URL(u); ok = x.protocol === 'https:' && !!x.hostname && !x.username && !x.password; } catch { ok = false; }
  if (!ok || u.length > 500) return null;
  return { title: (title.trim() || new URL(u).hostname).slice(0, 80), url: u };
}
