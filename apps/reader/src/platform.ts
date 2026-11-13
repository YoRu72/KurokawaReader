// Where an option applies. A setting is shown only where it can do something, and where it is not shown its stored
// value stays (backups and sync carry it) but does nothing — the same test decides both (the reader asks `onPhone()`
// before it acts on a tap zone, the options ask `fits('phone')` before they show it).
//
// The rule:
//  - A phone (or tablet) is the Android or iOS app, or a plain web page whose main pointer is a finger (a phone's
//    browser). A computer is the desktop app, or a plain web page whose main pointer is a mouse — a touch-screen
//    laptop is a computer. `phone` options are those that need a finger on a touch-first screen (tap zones, edge
//    swipes, pinching the text) or a phone's screen (turning it); `computer` options those that need a keyboard.
//  - Some options need a part of the app's own shell rather than a kind of device: `android` (the volume keys, the
//    edge kept from the system's back gesture, Back twice to leave the app), `phoneApp` (the Android or iOS app: the
//    gallery's folder), `desktopApp` (the window's zoom), `shell` (either app: the system bars hidden on a phone, the
//    window made full screen on a computer — a web page cannot do either), `windowBar` (a desktop shell that draws the
//    window's title bar itself, its buttons included — the Tauri shell for now: desktop-tauri/bridge.js marks itself
//    with window.__KR_SHELL__; Electron's keeps the system's buttons, so the choice of bar is not offered there),
//    `touchScreen` (any screen that takes a
//    finger, a computer's included: pinching a PDF), `notIos` (iOS has no Back), `battery` (the device tells it).
// (No imports: settings, the options and the reader all use this.)

export type Need = 'phone' | 'computer' | 'android' | 'phoneApp' | 'desktopApp' | 'windowBar' | 'shell' | 'touchScreen' | 'notIos' | 'battery';

type W = { kurokawaDesktop?: unknown; __KR_SHELL__?: string; Capacitor?: { isNativePlatform?(): boolean; getPlatform?(): string } };
/** 'android' | 'ios' (the phone apps), 'desktop' (the desktop app) or 'web' (a plain web page). */
export function shellOf(): 'android' | 'ios' | 'desktop' | 'web' {
  const w = window as unknown as W;
  if (w.kurokawaDesktop) return 'desktop';
  const p = w.Capacitor?.isNativePlatform?.() ? w.Capacitor.getPlatform?.() : 'web';
  return p === 'android' || p === 'ios' ? p : 'web';
}
const coarse = (): boolean => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** A phone or tablet (see above); otherwise a computer. */
export function onPhone(): boolean {
  const s = shellOf();
  return s === 'android' || s === 'ios' ? true : s === 'desktop' ? false : coarse();
}

/** Whether what `need` asks for is here. */
export function fits(need: Need): boolean {
  const s = shellOf();
  switch (need) {
    case 'phone': return onPhone();
    case 'computer': return !onPhone();
    case 'android': return s === 'android';
    case 'phoneApp': return s === 'android' || s === 'ios';
    case 'desktopApp': return s === 'desktop';
    case 'windowBar': return s === 'desktop' && (window as unknown as W).__KR_SHELL__ === 'tauri';
    case 'shell': return s !== 'web';
    case 'touchScreen': return onPhone() || (typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0);
    case 'notIos': return s !== 'ios';
    case 'battery': return typeof navigator !== 'undefined' && typeof (navigator as Navigator & { getBattery?: unknown }).getBattery === 'function';
  }
}

/** The rows, where `need` is met; nothing elsewhere. */
export function only<T>(need: Need, ...rows: T[]): T[] { return fits(need) ? rows : []; }
