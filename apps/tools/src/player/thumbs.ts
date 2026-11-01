// Seek previews (VLC's and REX Player's): a frame of the time under the finger, shown over the seek bar while it
// is dragged — read from a second, silent copy of the video (local files and the app's own streams), drawn small.
export class SeekPreview {
  private v: HTMLVideoElement; private c: HTMLCanvasElement; private busy = false; private want: number | null = null; private ok = true;
  readonly el: HTMLElement;
  constructor(src: string, private fmt: (s: number) => string) {
    this.v = document.createElement('video'); this.v.muted = true; this.v.preload = 'metadata'; this.v.crossOrigin = 'anonymous'; this.v.src = src; this.v.playsInline = true;
    this.v.addEventListener('error', () => { this.ok = false; });
    this.c = document.createElement('canvas'); this.c.width = 192; this.c.height = 108;
    this.el = document.createElement('div'); this.el.className = 'kt-preview'; this.el.hidden = true;
    const label = document.createElement('b'); this.el.append(this.c, label);
    this.v.addEventListener('seeked', () => { this.draw(); this.busy = false; if (this.want !== null) { const w = this.want; this.want = null; this.seek(w); } });
  }
  private draw() { try { const g = this.c.getContext('2d'); if (!g || !this.v.videoWidth) return; const h = Math.round(192 * this.v.videoHeight / this.v.videoWidth); if (this.c.height !== h) this.c.height = Math.max(60, Math.min(160, h)); g.drawImage(this.v, 0, 0, this.c.width, this.c.height); this.c.hidden = false; } catch { this.c.hidden = true; } }
  private seek(t: number) { if (!this.ok) return; if (this.busy) { this.want = t; return; } this.busy = true; try { this.v.currentTime = t; } catch { this.busy = false; } setTimeout(() => { this.busy = false; }, 1500); }
  /** Shown at `fraction` of the bar (x in px within it), for time `t`. */
  show(t: number, x: number, barWidth: number): void {
    this.el.hidden = false; (this.el.lastChild as HTMLElement).textContent = this.fmt(t);
    const w = 192; this.el.style.left = `${Math.max(0, Math.min(barWidth - w, x - w / 2))}px`;
    if (!this.ok) { this.c.hidden = true; return; }
    this.seek(t);
  }
  hide(): void { this.el.hidden = true; this.want = null; }
  dispose(): void { this.v.removeAttribute('src'); this.v.load(); this.el.remove(); }
}
