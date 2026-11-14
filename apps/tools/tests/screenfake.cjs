// A pretend screen translator for the Tauri shell's tests (src-tauri/src/screentr.rs as its rules say): the bridge's
// screen* methods, kt_selftest_screen's acts, and a pixel reader over a pretend screen — one 1280×900 monitor, dark
// grey, with the self-test's drawn window (three colour bars on its left half, white on its right) where it was drawn.
// Pictures are data: addresses carrying their place on that screen after a «#» (data:image/png;base64,…#x,y,w,h).
// Used by tests/tauribridge.cjs (the self-test's screen rows against it) and tests/screentauri.cjs.
'use strict';

const KEYS = { region: 'Alt+Shift+T', full: 'Alt+Shift+F', repeat: 'Alt+Shift+R', auto: 'Alt+Shift+A', clipboard: 'Alt+Shift+C' };

module.exports = function fakeScreen(cfg, opts) {
  const o = Object.assign({ capture: 'x11', ocr: 'tesseract', trayPossible: true }, opts || {});
  const MON = { id: 'M@0,0', x: 0, y: 0, w: 1280, h: 900, scale: 1 };
  const S = { conf: {}, on: false, tray: false, auto: false, region: null, wins: new Map(), job: null, drawn: null, sent: 0, calls: [] };
  const pic = (x, y, w, h) => `data:image/png;base64,iVBORw0KGgo#${x},${y},${w},${h}`;
  const colour = (x, y) => {
    const d = S.drawn;
    if (!d || x < d.x || y < d.y || x >= d.x + d.w || y >= d.y + d.h) return [40, 40, 40, 255];
    const rx = x - d.x; const ry = y - d.y;
    if (rx >= d.w / 2) return [255, 255, 255, 255];
    return ry < d.h / 3 ? [255, 0, 0, 255] : ry < (2 * d.h) / 3 ? [0, 255, 0, 255] : [0, 0, 255, 255];
  };
  const keys = () => Object.assign({}, KEYS, (S.conf.pc && S.conf.pc.keys) || {});
  const status = () => {
    const k = {}; for (const [a, acc] of Object.entries(keys())) k[a] = { acc, ok: S.on && !!acc };
    return { platform: cfg.os, on: S.on, keys: k, tray: S.tray, auto: S.auto, region: S.region, ocr: S.conf.pc && S.conf.pc.ocr === 'ai' ? 'ai' : o.ocr, capture: { kind: o.capture, why: '' } };
  };
  const stopAuto = () => { S.auto = false; S.wins.delete('kts-caption'); };
  const kt = {
    screenStatus: async () => status(),
    screenConfig: async (x) => {
      S.calls.push(['config', x]); S.conf = (x && x.config) || {}; S.on = !!S.conf.pcOn; S.tray = S.on && !!(S.conf.pc && S.conf.pc.tray) && o.trayPossible;
      if (x && x.clearFixed) S.region = null;
      if (!S.on) stopAuto();
      return status();
    },
    screenAction: async (a) => {
      S.calls.push(['action', a]);
      if (a === 'auto') { if (S.auto) stopAuto(); else if (S.region) { S.auto = true; S.wins.set('kts-caption', { label: 'kts-caption', visible: true, focused: false, decorated: false }); S.sent++; } return true; }
      if (a === 'clipboard') return true;
      S.job = { mode: a === 'full' ? 'full' : a === 'repeat' && S.region ? 'result' : 'region', image: pic(0, 0, MON.w, MON.h), width: MON.w, height: MON.h, scale: MON.scale, cfg: S.conf };
      S.wins.set('kts-overlay', { label: 'kts-overlay', visible: true, focused: true, decorated: false });
      return true;
    },
    screenJob: async () => S.job,
    screenRegion: async (r) => {
      S.calls.push(['region', r]);
      if (!S.job || !S.job.image) return { blocks: [] };
      if (r && r.width > 3) S.region = Object.assign({}, r, { display: MON.id });
      const c = r && r.width > 3 ? r : { x: 0, y: 0, width: MON.w, height: MON.h };
      if (S.conf.pc && S.conf.pc.ocr === 'ai') return { ai: pic(c.x, c.y, c.width, c.height), offset: { x: c.x, y: c.y }, scale: 1 };
      return { blocks: [{ text: 'TOOLS', x: c.x + 300, y: c.y + 80, width: 120, height: 30 }] };
    },
    screenClose: async () => { S.calls.push(['close']); S.wins.delete('kts-overlay'); S.wins.delete('kts-popup'); return true; },
    screenOcrLangs: async () => ({ kind: o.ocr, langs: ['eng', 'osd'] }),
    screenCaptionSize: async () => true,
    onScreenCaption: () => () => undefined,
  };
  const act = (x) => {
    if (x.act === 'state') return { capture: o.capture, why: '', os: 'linux', monitors: [MON], cursor: [640, 450], under: MON.id, ocr: o.ocr, windows: [...S.wins.values()].concat(S.drawn ? [{ label: 'kts-test', visible: true, focused: false, decorated: false }] : []).filter((w) => w.label !== 'kts-test' || S.drawn),
      ocrRunning: 0, auto: S.auto, sent: S.sent, lastError: '', clickThrough: S.auto ? true : null, ignoreApi: true, focusableApi: true, emitTo: true, cursorApi: true, shortcuts: true,
      bound: S.on ? Object.entries(keys()).map(([a, acc]) => [acc, a]) : [], tray: S.tray, trayWhy: o.trayPossible ? '' : 'no libayatana-appindicator3', permission: null, keepInTray: S.on && S.tray };
    if (x.act === 'draw') { S.drawn = { x: 60, y: 60, w: x.w || 480, h: x.h || 240 }; return Object.assign({ monitor: MON.id, scale: 1, mx: 0, my: 0 }, S.drawn); }
    if (x.act === 'grab') return { w: x.w, h: x.h, png: pic(x.x, x.y, x.w, x.h), monitor: MON.id };
    if (x.act === 'ocr') return { kind: o.ocr, lines: o.ocr === 'none' ? [] : ['TOOLS', '2468'] };
    if (x.act === 'popup') { S.job = { mode: 'text', text: x.text, cfg: S.conf }; S.wins.set('kts-popup', { label: 'kts-popup', visible: true, focused: true, decorated: false }); return true; }
    if (x.act === 'undraw') { S.drawn = null; return true; }
    throw new Error('unknown act ' + x.act);
  };
  /** The self-test's env.pixels over the pretend screen. */
  const pixels = async (url, pts) => {
    const m = /#(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+)$/.exec(url); if (!m) throw new Error('not a pretend picture');
    const [ox, oy, w, h] = m.slice(1).map(Number);
    return { w, h, px: pts.map((p) => colour(Math.round(ox + p[0]), Math.round(oy + p[1]))) };
  };
  return { kt, act, pixels, S };
};
