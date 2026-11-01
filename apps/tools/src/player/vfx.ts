// The picture, VLC's and REX Player's way: brightness, contrast, saturation, hue (the browser's own filters),
// gamma, sharpness and colour temperature (an SVG filter of the app's), presets of them, rotation, mirroring and
// cropping to a ratio.
import type { PlayerPrefs } from './prefs';

type F = PlayerPrefs['filters'];
export const FILTER_PRESETS: Record<string, Partial<F> & { css?: string }> = {
  vivid: { saturation: 135, contrast: 112, sharpness: 25 },
  cinema: { contrast: 115, saturation: 90, temperature: 12, gamma: 92 },
  warm: { temperature: 30, saturation: 105 },
  cool: { temperature: -30 },
  soft: { contrast: 92, sharpness: 0, brightness: 104 },
  sharp: { sharpness: 60, contrast: 106 },
  night: { brightness: 80, temperature: 40, contrast: 95 },
  anime: { saturation: 118, contrast: 108, sharpness: 35, gamma: 96 },
  grey: { saturation: 0 },
  sepia: { css: 'sepia(0.85)' },
  invert: { css: 'invert(1) hue-rotate(180deg)' },
};
export const CROPS = ['', '16:9', '16:10', '4:3', '5:4', '1:1', '1.85:1', '2.21:1', '2.35:1', '2.39:1'];
const ratio = (r: string) => { const [a, b] = r.split(':').map(Number); return a && b ? a / b : 0; };

let seq = 0;
/** One player's picture: its filters, its SVG filter (made when gamma, sharpness or temperature are used). */
export class Picture {
  private svg: SVGSVGElement | null = null; private id = `kt-fx-${++seq}`;
  constructor(private video: HTMLVideoElement, private layer: HTMLElement) {}
  private ensureSvg(): SVGSVGElement {
    if (this.svg) return this.svg;
    const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.style.position = 'absolute';
    svg.innerHTML = `<filter id="${this.id}" color-interpolation-filters="sRGB"><feComponentTransfer result="g"><feFuncR type="gamma" amplitude="1" exponent="1"/><feFuncG type="gamma" amplitude="1" exponent="1"/><feFuncB type="gamma" amplitude="1" exponent="1"/></feComponentTransfer><feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0" result="t"/><feConvolveMatrix order="3" preserveAlpha="true" kernelMatrix="0 0 0 0 1 0 0 0 0"/></filter>`;
    this.layer.append(svg); this.svg = svg; return svg;
  }
  /** The filters, the extra brightness of a swipe (`swipe`), and a preset's own look. */
  apply(f: F, swipe = 1, preset = ''): void {
    const p = preset ? FILTER_PRESETS[preset] : undefined;
    const v = { ...f, ...(p ?? {}) } as F;
    const css = [swipe !== 1 || v.brightness !== 100 ? `brightness(${(swipe * v.brightness) / 100})` : '', v.contrast !== 100 ? `contrast(${v.contrast / 100})` : '', v.saturation !== 100 ? `saturate(${v.saturation / 100})` : '', v.hue ? `hue-rotate(${v.hue}deg)` : '', p?.css ?? ''].filter(Boolean);
    const needSvg = v.gamma !== 100 || v.sharpness || v.temperature;
    if (needSvg) {
      const svg = this.ensureSvg(); const e = 1 / Math.max(0.2, v.gamma / 100);
      svg.querySelectorAll('feFuncR, feFuncG, feFuncB').forEach((n) => n.setAttribute('exponent', e.toFixed(3)));
      const k = v.temperature / 100 * 0.18; svg.querySelector('feColorMatrix')!.setAttribute('values', `${1 + k} 0 0 0 0 0 1 0 0 0 0 0 ${1 - k} 0 0 0 0 0 1 0`);
      const s = Math.max(0, v.sharpness) / 100 * 1.2; svg.querySelector('feConvolveMatrix')!.setAttribute('kernelMatrix', `0 ${-s} 0 ${-s} ${1 + 4 * s} ${-s} 0 ${-s} 0`);
      css.unshift(`url(#${this.id})`);
    }
    this.video.style.filter = css.join(' ');
  }
  /** Rotation, mirroring, zoom and pan, and a crop to a ratio (the picture scaled so the ratio fills the frame). */
  transform(o: { rotate: number; flipH: boolean; flipV: boolean; zoom: number; panX: number; panY: number; crop: string }): string {
    const vw = this.video.videoWidth || 16, vh = this.video.videoHeight || 9; const box = this.video.getBoundingClientRect();
    let cropScale = 1;
    const r = ratio(o.crop); if (r) { const src = vw / vh; cropScale = r > src ? r / src : src / r; cropScale = Math.min(cropScale, 3); }
    // A quarter turn: the picture scaled to fit the turned frame.
    let turnScale = 1; if (o.rotate % 180 && box.width && box.height) { const wv = Math.min(box.width, box.height * vw / vh), hv = wv * vh / vw; turnScale = Math.min(box.width / hv, box.height / wv); }
    const parts = [o.panX || o.panY ? `translate(${o.panX}px, ${o.panY}px)` : '', o.rotate ? `rotate(${o.rotate}deg)` : '', `scale(${(o.flipH ? -1 : 1) * o.zoom * cropScale * turnScale}, ${(o.flipV ? -1 : 1) * o.zoom * cropScale * turnScale})`];
    const t = parts.filter(Boolean).join(' '); this.video.style.transform = t === 'scale(1, 1)' ? '' : t; return this.video.style.transform;
  }
  dispose(): void { this.svg?.remove(); }
}
