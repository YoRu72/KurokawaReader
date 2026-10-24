// The scanner's own camera: the back camera's picture full screen, the page found in it as you hold the phone
// (outlined), and — when "Auto" is on — the photo taken by itself once the page has been held steady for a
// moment, as a scanning app does; then it waits for the next page (the picture changing) before taking another.
// Where the camera cannot be had here (no camera, no permission, an old web view) the caller falls back to the
// system's camera.
import { h, icon, toast } from './dom';
import { t, countPages } from '../i18n';
import { scanWork } from '../scanpool';
import type * as S from '../scan';

type Found = { how: 'shape' | 'edges' | 'frame'; score: number; quad: S.Quad };

const STEADY_MS = 900; // held this long, the photo is taken
const AUTO_KEY = 'kr.scan.auto';

/**
 * Open the camera; each photo taken is given to `onShot` as it is taken. Resolves false at once when the camera
 * cannot be opened (the caller then uses the system's camera), true when the camera view is closed.
 */
export async function openCamera(onShot: (f: File) => void): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } } });
  } catch (e) {
    const name = (e as DOMException).name;
    if (name === 'NotAllowedError' || name === 'SecurityError') toast(t('cameraDenied'), 'error', 5000);
    return false;
  }
  return new Promise<boolean>((resolve) => {
    const track = stream.getVideoTracks()[0];
    const video = h('video', { class: 'cam-video', playsinline: true, muted: true, autoplay: true }) as HTMLVideoElement;
    video.setAttribute('playsinline', ''); video.muted = true; video.srcObject = stream;
    const overlay = h('canvas', { class: 'cam-overlay', 'aria-hidden': 'true' }) as HTMLCanvasElement;
    const hint = h('p', { class: 'cam-hint', role: 'status' }, t('cameraLooking'));
    let auto = (() => { try { return localStorage.getItem(AUTO_KEY) !== '0'; } catch { return true; } })();
    const autoChip = h('button', { type: 'button', class: 'chip cam-auto', 'aria-pressed': String(auto), onclick: () => {
      auto = !auto; try { localStorage.setItem(AUTO_KEY, auto ? '1' : '0'); } catch { /* private mode */ }
      autoChip.classList.toggle('on', auto); autoChip.setAttribute('aria-pressed', String(auto)); steadySince = 0; paintRing(0);
    } }, t('cameraAuto')) as HTMLButtonElement;
    autoChip.classList.toggle('on', auto);
    const shutter = h('button', { type: 'button', class: 'cam-shutter', title: t('scanTakePhoto'), 'aria-label': t('scanTakePhoto'), onclick: () => void take() }) as HTMLButtonElement;
    const counter = h('span', { class: 'cam-count' });
    const doneBtn = h('button', { type: 'button', class: 'btn small primary cam-done', onclick: () => close() }, icon('check'), t('done'));
    const closeBtn = h('button', { type: 'button', class: 'icon-btn cam-close', title: t('close'), 'aria-label': t('close'), onclick: () => close() }, icon('close'));
    // The torch, where the camera has one.
    let torch = false;
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
    const torchBtn = caps.torch ? h('button', { type: 'button', class: 'icon-btn cam-torch', title: t('cameraTorch'), 'aria-label': t('cameraTorch'), 'aria-pressed': 'false', onclick: async () => {
      torch = !torch;
      try { await track.applyConstraints({ advanced: [{ torch } as MediaTrackConstraintSet] }); } catch { torch = !torch; }
      torchBtn!.replaceChildren(icon(torch ? 'flash' : 'flashOff')); torchBtn!.setAttribute('aria-pressed', String(torch));
    } }, icon('flashOff')) : null;
    const flash = h('div', { class: 'cam-flash' });
    const view = h('div', { class: 'cam-view', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('scanTakePhoto') },
      video, overlay, flash,
      h('div', { class: 'cam-top' }, closeBtn, hint, torchBtn ?? h('span')),
      h('div', { class: 'cam-bar' }, h('div', { class: 'cam-side' }, autoChip), shutter, h('div', { class: 'cam-side end' }, counter, doneBtn)));
    document.body.append(view);
    void video.play().catch(() => undefined);

    let shots = 0, closed = false, timer = 0, raf = 0;
    const showCount = () => { counter.textContent = shots ? countPages(shots) : ''; doneBtn.hidden = !shots; };
    showCount();
    const paintRing = (f: number) => shutter.style.setProperty('--ring', `${Math.round(Math.min(1, f) * 360)}deg`);

    // ---- what the camera sees: the page found every few frames, on a small copy, in a worker thread
    const small = document.createElement('canvas'); const sctx = small.getContext('2d', { willReadFrequently: true })!;
    let prev: Uint8ClampedArray | null = null; let found: Found | null = null; let shown: S.Quad | null = null;
    let steadySince = 0, armed = true, lostTicks = 0, busy = false, taking = false; let anchor: S.Quad | null = null;
    const moved = (a: S.Quad, b: S.Quad) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));
    const tick = async () => {
      if (closed) return;
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!busy && !taking && vw && vh && video.readyState >= 2) {
        busy = true;
        try {
          const k = 360 / Math.max(vw, vh); const w = Math.max(1, Math.round(vw * k)), hh = Math.max(1, Math.round(vh * k));
          if (small.width !== w || small.height !== hh) { small.width = w; small.height = hh; prev = null; }
          sctx.drawImage(video, 0, 0, w, hh);
          const id = sctx.getImageData(0, 0, w, hh);
          // How much the picture moved since the last look (mean change of brightness, every 4th pixel).
          let motion = 0;
          if (prev) { let s = 0, c = 0; for (let i = 0; i < id.data.length; i += 16) { s += Math.abs(id.data[i + 1] - prev[i + 1]); c++; } motion = s / c; }
          prev = new Uint8ClampedArray(id.data);
          const f = await scanWork<Found>({ op: 'detect', preview: { data: id.data, width: w, height: hh } });
          const ok = f.how !== 'frame' && f.score >= 0.45;
          const last = found; found = ok ? f : null;
          if (!ok) { lostTicks++; steadySince = 0; anchor = null; }
          else {
            lostTicks = 0;
            // Steady: the page where it was when the hold began (a hand trembles; the outline's own jitter is
            // smaller still), and the picture not sweeping (which would blur the photo).
            const still = motion < 8 && !!last && moved(anchor ?? last.quad, f.quad) < 0.022;
            if (!still) { steadySince = 0; anchor = null; } else if (!steadySince) { steadySince = performance.now(); anchor = f.quad; }
            if (!armed && (motion > 10 || (last && moved(last.quad, f.quad) > 0.08))) armed = true;
          }
          if (!armed && lostTicks >= 2) armed = true;
          (window as unknown as { __cam?: string[] }).__cam?.push(`${Math.round(performance.now())} ${f.how} ${f.score.toFixed(2)} motion ${motion.toFixed(1)} moved ${last ? moved(last.quad, f.quad).toFixed(3) : '-'} armed ${armed} steady ${steadySince ? Math.round(performance.now() - steadySince) : 0}`);
          hint.textContent = !ok ? t('cameraLooking') : !armed ? t('cameraNext') : auto && steadySince ? t('cameraHold') : auto ? t('cameraSteady') : t('cameraFound');
          const held = steadySince ? performance.now() - steadySince : 0;
          paintRing(auto && armed && ok ? held / STEADY_MS : 0);
          if (auto && armed && ok && held >= STEADY_MS) void take();
        } catch (e) { console.warn(e); }
        busy = false;
      }
      timer = window.setTimeout(() => void tick(), 110);
    };
    void tick();

    // ---- the outline, eased toward where the page was last found
    const draw = () => {
      if (closed) return;
      const W = view.clientWidth, H = view.clientHeight, dpr = window.devicePixelRatio || 1;
      if (overlay.width !== Math.round(W * dpr) || overlay.height !== Math.round(H * dpr)) { overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr); }
      const c = overlay.getContext('2d')!; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
      const vw = video.videoWidth, vh = video.videoHeight;
      if (found && vw) {
        shown = shown ? shown.map((p, i) => ({ x: p.x + (found!.quad[i].x - p.x) * 0.35, y: p.y + (found!.quad[i].y - p.y) * 0.35 })) as S.Quad : found.quad;
        // The video is drawn whole ("contain"): where its picture lies in the view.
        const k = Math.min(W / vw, H / vh), ox = (W - vw * k) / 2, oy = (H - vh * k) / 2;
        const accent = getComputedStyle(view).getPropertyValue('--cam-accent').trim() || '#4dd8ea';
        c.beginPath(); shown.forEach((p, i) => { const x = ox + p.x * vw * k, y = oy + p.y * vh * k; if (i) c.lineTo(x, y); else c.moveTo(x, y); }); c.closePath();
        c.fillStyle = accent; c.globalAlpha = 0.18; c.fill(); c.globalAlpha = 1; c.lineJoin = 'round';
        c.lineWidth = 5; c.strokeStyle = 'rgba(0,0,0,.35)'; c.stroke(); c.lineWidth = 3; c.strokeStyle = accent; c.stroke();
      } else shown = null;
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    // ---- taking the photo: at the camera's full size where it can (ImageCapture), else the video's frame
    const grab = async (): Promise<Blob | null> => {
      const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
      if (IC) { try { const b = await new IC(track).takePhoto(); if (b?.size) return b; } catch { /* the video's frame instead */ } }
      const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
      if (!c.width) return null;
      c.getContext('2d')!.drawImage(video, 0, 0);
      return new Promise((r) => c.toBlob((b) => r(b), 'image/jpeg', 0.93));
    };
    let shooting: Promise<void> | null = null;
    function take(): Promise<void> {
      if (taking || closed) return shooting ?? Promise.resolve();
      return (shooting = shoot());
    }
    async function shoot(): Promise<void> {
      taking = true; armed = false; steadySince = 0; paintRing(0);
      flash.classList.remove('on'); void flash.offsetWidth; flash.classList.add('on');
      navigator.vibrate?.(25);
      try {
        const b = await grab();
        if (b) { shots++; showCount(); onShot(new File([b], `scan-${Date.now()}.jpg`, { type: b.type || 'image/jpeg' })); }
      } finally { taking = false; prev = null; }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === ' ' || e.key === 'Enter') { if ((e.target as HTMLElement).closest?.('button')) return; e.preventDefault(); void take(); }
    };
    document.addEventListener('keydown', onKey, true);
    const onHide = () => { if (document.hidden) close(); };
    document.addEventListener('visibilitychange', onHide);
    function close(): void {
      if (closed) return; closed = true;
      clearTimeout(timer); cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true); document.removeEventListener('visibilitychange', onHide);
      // (A photo being taken as the camera is closed — "Done" pressed as it fired — is let finish: the camera
      // stopped under it would give a black page.)
      const stop = () => stream.getTracks().forEach((tr) => tr.stop());
      view.remove();
      if (taking && shooting) void shooting.finally(() => { stop(); resolve(true); });
      else { stop(); resolve(true); }
    }
    shutter.focus();
  });
}
