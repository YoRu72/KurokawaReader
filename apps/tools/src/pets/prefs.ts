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
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
/** Control and direction-changing characters (a title or address that would show other than it reads) taken out. */
export const plain = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g, '');
/** The choices as stored (or carried over from another install): every value checked against what it may be. */
export function petPrefs(p: Partial<PetPrefs> | undefined): PetPrefs {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>; const d = PET_DEFAULTS;
  const links = Array.isArray(o.links) ? o.links.map((l) => (l && typeof l === 'object' ? cleanLink((l as PetLink).title, (l as PetLink).url) : null)).filter((l): l is PetLink => !!l).slice(0, 20) : DEFAULT_LINKS;
  const custom = Number(o.custom);
  return {
    on: bool(o.on, d.on), where: oneOf(o.where, ['app', 'desktop'] as const, d.where), follow: bool(o.follow, d.follow),
    size: oneOf(o.size, ['S', 'M', 'L', 'custom'] as const, d.size), custom: Number.isFinite(custom) ? Math.min(4, Math.max(0.25, custom)) : 1,
    activity: oneOf(o.activity, ['calm', 'normal', 'lively'] as const, d.activity), chase: bool(o.chase, d.chase),
    pauseVideo: bool(o.pauseVideo, d.pauseVideo), pauseBattery: bool(o.pauseBattery, d.pauseBattery), speech: bool(o.speech, d.speech),
    active: Array.isArray(o.active) ? [...new Set(o.active.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x)))].slice(0, MAX_ACTIVE) : [],
    links,
  };
}
/** A link typed or stored: an https address with a host (no user or password in it), a title that is a string, both
 *  without control or direction characters, capped. Null when it is not one. */
export function cleanLink(title: unknown, url: unknown): PetLink | null {
  if (typeof url !== 'string') return null;
  const u = plain(url).trim(); if (!u || u.length > 500) return null;
  let x: URL; try { x = new URL(u); } catch { return null; }
  if (x.protocol !== 'https:' || !x.hostname || x.username || x.password) return null;
  const t = typeof title === 'string' ? plain(title).trim().slice(0, 80) : '';
  return { title: t || x.hostname, url: x.href };
}
/** The host shown apart from the title (as the browser will show it: an internationalised name in its ASCII form). */
export function linkHost(url: string): string { try { return new URL(url).host; } catch { return ''; } }
