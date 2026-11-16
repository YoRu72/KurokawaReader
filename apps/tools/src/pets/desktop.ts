// Tier B: the pets on the desktop. Each pet has a window of its own — transparent, frameless, above the others, not on
// the taskbar, never taking the focus — exactly the size of its picture, moved as it walks (no window over the whole
// screen). Clicks pass through the window except over the pet's opaque pixels (the shell's click-through switched as
// the pointer comes and goes: Electron forwards the pointer's moves to a click-through window, the Tauri build is
// asked for the pointer's place ten times a second). The pet walks on the screen's work area (above the taskbar) and,
// in the Tauri build when chosen, along the top of the active window (petwin.rs / activewin.rs; not on Wayland).
// The main window opens and closes the pet windows (startDesktop); each pet window runs its own pet (petWindow).
import { getSettings } from '../settings';
import { petPrefs, type PetPrefs } from './prefs';
import { PetSim, drawScale, type Surface, type World } from './runtime';
import { loadPet } from './store';
import { drawFrame, hitView } from './draw';

interface Rect { x: number; y: number; w: number; h: number }
interface ScreenInfo { work: Rect; cursor?: { x: number; y: number } | null }
interface ActiveInfo { rect?: Rect | null; why?: string }
type PetBridge = { pet(o: Record<string, unknown>): Promise<unknown> };
const bridge = (): PetBridge | null => { const b = window.kurokawaTools as unknown as Partial<PetBridge> | undefined; return typeof b?.pet === 'function' ? (b as PetBridge) : null; };
const isTauri = () => (window as unknown as { __KT_SHELL__?: string }).__KT_SHELL__ === 'tauri';
const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;

/* ---------- the main window: which pet windows are open ---------- */
export function startDesktop(): { stop(): void; apply(ids: string[]): Promise<void> } {
  const open = new Set<string>();
  return {
    async apply(ids: string[]) {
      const b = bridge(); if (!b) return;
      for (const id of [...open]) if (!ids.includes(id)) { open.delete(id); await b.pet({ action: 'close', id }).catch(() => undefined); }
      for (const id of ids) { if (open.has(id) || !SAFE_ID.test(id)) continue; open.add(id); await b.pet({ action: 'open', id, x: 0, y: 0, w: 4, h: 4 }).catch(() => open.delete(id)); }
    },
    stop() { open.clear(); void bridge()?.pet({ action: 'closeAll' }).catch(() => undefined); },
  };
}

/* ---------- a pet window (#/pet/<id>) ---------- */
const PAD = 2; const BUBBLE_H = 54; const MENU_W = 200, MENU_H = 104;
const readPrefs = (): PetPrefs => { try { return petPrefs((JSON.parse(localStorage.getItem('kt.settings') ?? '{}') as { pets?: Partial<PetPrefs> }).pets); } catch { return petPrefs(getSettings().pets); } };
function writePrefs(patch: Partial<PetPrefs>): void {
  try { const all = JSON.parse(localStorage.getItem('kt.settings') ?? '{}') as Record<string, unknown>; all.pets = { ...readPrefs(), ...patch }; localStorage.setItem('kt.settings', JSON.stringify(all)); } catch { /* private */ }
}
export async function petWindow(id: string, labels: { hide: string; settings: string }): Promise<void> {
  const b = bridge(); const html = document.documentElement; html.classList.add('pet-window');
  const app = document.getElementById('app')!;
  const cv = document.createElement('canvas'); cv.className = 'pet-win-cv'; const ctx = cv.getContext('2d')!;
  const bubble = document.createElement('div'); bubble.className = 'pet-win-say'; bubble.hidden = true;
  const menu = document.createElement('div'); menu.className = 'kt-pet-menu pet-win-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  app.replaceChildren(cv, bubble, menu);
  if (!b || !SAFE_ID.test(id)) return;
  const lp = await loadPet(id); if (!lp) { void b.pet({ action: 'close', id }); return; }
  let prefs = readPrefs();
  let scr = (await b.pet({ action: 'screen' }).catch(() => null)) as ScreenInfo | null;
  let work: Rect = scr?.work ?? { x: 0, y: 0, w: screen.availWidth || 1280, h: screen.availHeight || 800 };
  let surfaces: Surface[] = []; let pointer: { x: number; y: number } | null = null; let fullscreen = false;
  const world = (): World => ({ width: work.w, height: work.h, floor: work.h, surfaces, pointer });
  const opts = () => ({ scale: drawScale(lp.pack, prefs.size, prefs.custom), activity: prefs.activity, chase: prefs.chase, seed: (Date.now() % 100000) + id.length, speech: prefs.speech });
  let sim = new PetSim(lp.pack, lp.sizes, opts(), world(), { x: work.w * (0.2 + 0.6 * Math.random()), y: 0 });
  const masks: (Uint8Array | null)[] = [];
  let through = true; let menuOpen = false; let last = performance.now(); let lastPoll = 0; let timer = 0; let placed = '';
  let press: { x: number; y: number; t: number; moved: boolean; id: number } | null = null;
  const setThrough = (on: boolean) => { if (on === through) return; through = on; void b.pet({ action: 'through', id, on }).catch(() => undefined); };
  /** The window's rectangle on the screen (the sprite, room for a bubble above, the menu beside). */
  const frameRect = (v: ReturnType<PetSim['view']>): Rect => {
    const top = v.say ? BUBBLE_H : 0; let w = Math.ceil(v.w) + PAD * 2, h = Math.ceil(v.h) + PAD * 2 + top;
    // (The menu above the pet: it stands on the floor most of the time.)
    const up = menuOpen ? MENU_H : 0; if (menuOpen) { w = Math.max(w, MENU_W); h += MENU_H; }
    return { x: Math.round(work.x + v.x - PAD), y: Math.round(work.y + v.y - PAD - top - up), w, h };
  };
  const draw = () => {
    const v = sim.view(); const im = lp.images[v.frame]; const r = frameRect(v);
    const key = `${r.x},${r.y},${r.w},${r.h}`; if (key !== placed) { placed = key; void b.pet({ action: 'move', id, ...r }).catch(() => undefined); }
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(r.w * dpr) || cv.height !== Math.round(r.h * dpr)) { cv.width = Math.round(r.w * dpr); cv.height = Math.round(r.h * dpr); cv.style.width = `${r.w}px`; cv.style.height = `${r.h}px`; }
    if (im && !fullscreen) drawFrame(cv, ctx, im, v, PAD, PAD + (v.say ? BUBBLE_H : 0) + (menuOpen ? MENU_H : 0), sim.k < 1.5); else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); }
    bubble.hidden = !v.say || fullscreen || menuOpen; if (v.say) bubble.textContent = v.say;
    html.dataset.state = v.state;
  };
  /** The pointer over an opaque pixel: the window takes the click; else it passes through. */
  const hover = (sx: number, sy: number) => {
    if (press || menuOpen) return;
    const v = sim.view(); setThrough(fullscreen || !hitView(v, lp.images[v.frame], masks, sx - work.x, sy - work.y));
  };
  const poll = async () => {
    const now = performance.now(); if (now - lastPoll < 100) return; lastPoll = now;
    const s = (await b.pet({ action: 'screen' }).catch(() => null)) as ScreenInfo | null;
    if (s?.work) work = s.work;
    if (s?.cursor) { pointer = { x: s.cursor.x - work.x, y: s.cursor.y - work.y }; hover(s.cursor.x, s.cursor.y); }
    if (isTauri() && prefs.follow) {
      const a = (await b.pet({ action: 'active' }).catch(() => null)) as ActiveInfo | null; const r = a?.rect;
      fullscreen = !!r && prefs.pauseVideo && r.w >= work.w && r.h >= work.h - 2;
      surfaces = r && !fullscreen && r.y - work.y > 40 && r.y < work.y + work.h ? [{ id: 'win', x: Math.max(0, r.x - work.x), y: r.y - work.y, w: Math.min(r.w, work.w) }] : [];
    } else surfaces = [];
  };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  // (On battery, when chosen: it stays where it is.)
  let onBattery = false;
  void (navigator as Navigator & { getBattery?(): Promise<EventTarget & { charging: boolean }> }).getBattery?.().then((bt) => { const read = () => { onBattery = !bt.charging; }; read(); bt.addEventListener('chargingchange', read); }).catch(() => undefined);
  const frame = async () => {
    timer = 0;
    await poll();
    const now = performance.now(); const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (reduced()) { sim.rest(work.h); draw(); return; }
    if (!fullscreen && !(prefs.pauseBattery && onBattery && !press)) sim.step(dt, world());
    draw();
    timer = window.setTimeout(() => void frame(), sim.busy() ? 33 : 100);
  };
  // (Electron: the moves of the pointer reach the page even while clicks go through.)
  window.addEventListener('pointermove', (e) => { pointer = { x: e.screenX - work.x, y: e.screenY - work.y }; hover(e.screenX, e.screenY); }, { passive: true });
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; e.preventDefault(); cv.setPointerCapture(e.pointerId); closeMenu();
    press = { x: e.screenX, y: e.screenY, t: e.timeStamp, moved: false, id: e.pointerId }; setThrough(false);
  });
  cv.addEventListener('pointermove', (e) => {
    const pr = press; if (!pr || e.pointerId !== pr.id) return;
    if (!pr.moved && Math.hypot(e.screenX - pr.x, e.screenY - pr.y) > 4) { pr.moved = true; sim.grab(pr.x - work.x, pr.y - work.y, pr.t); }
    if (pr.moved) { sim.dragTo(e.screenX - work.x, e.screenY - work.y, e.timeStamp); draw(); }
  });
  const up = (e: PointerEvent) => { const pr = press; if (!pr || e.pointerId !== pr.id) return; press = null; if (pr.moved) sim.release(e.timeStamp); else if (e.type === 'pointerup') sim.click(); if (!timer) void frame(); };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  // The pet's own menu: the window grows to hold it for a moment.
  const item = (label: string, run: () => void) => { const x = document.createElement('button'); x.type = 'button'; x.setAttribute('role', 'menuitem'); x.textContent = label; x.onclick = () => { closeMenu(); run(); }; return x; };
  menu.append(item(labels.hide, () => { writePrefs({ on: false }); void b.pet({ action: 'closeAll' }); }), item(labels.settings, () => { void b.pet({ action: 'main', hash: '#/settings/pets' }); }));
  function closeMenu(): void { if (!menuOpen) return; menuOpen = false; menu.hidden = true; setThrough(true); draw(); }
  cv.addEventListener('contextmenu', (e) => { e.preventDefault(); menuOpen = true; menu.hidden = false; setThrough(false); draw(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('blur', () => closeMenu());
  // Choices changed in the main window: taken at once.
  window.addEventListener('storage', (e) => {
    if (e.key !== 'kt.settings') return; const p = readPrefs();
    if (!p.on || !p.active.includes(id)) return; // (the main window closes this one)
    const resize = p.size !== prefs.size || p.custom !== prefs.custom; prefs = p;
    if (resize) sim = new PetSim(lp.pack, lp.sizes, opts(), world(), { x: sim.x, y: sim.y - 1 }); else sim.opts = { ...sim.opts, activity: p.activity, chase: p.chase, speech: p.speech };
  });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => { if (!timer) void frame(); });
  void scr; scr = null;
  await frame();
}
