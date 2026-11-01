// The player's sound, VLC's way, through the browser's audio graph: a 10-band equaliser (VLC's bands and
// presets) with its preamp, loudness evened out (a compressor: VLC's «normalize», a night mode), mono, the
// left/right balance, the sound delayed against the picture, and a boost past 100%. The graph is made only when
// one of these is first used (a video's sound, once routed through it, stays routed).
import type { EqBands } from './prefs';

export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
/** VLC's presets (preamp, then the ten bands in dB); the preamp is given relative to Flat's (+12 dB in VLC). */
export const EQ_PRESETS: Record<string, { pre: number; bands: EqBands }> = {
  flat: { pre: 12, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  classical: { pre: 12, bands: [0, 0, 0, 0, 0, 0, -7.2, -7.2, -7.2, -9.6] },
  club: { pre: 6, bands: [0, 0, 8, 5.6, 5.6, 5.6, 3.2, 0, 0, 0] },
  dance: { pre: 5, bands: [9.6, 7.2, 2.4, 0, 0, -5.6, -7.2, -7.2, 0, 0] },
  fullbass: { pre: 5, bands: [-8, 9.6, 9.6, 5.6, 1.6, -4, -8, -10.4, -11.2, -11.2] },
  fullbasstreble: { pre: 4, bands: [7.2, 5.6, 0, -7.2, -4.8, 1.6, 8, 11.2, 12, 12] },
  fulltreble: { pre: 3, bands: [-9.6, -9.6, -9.6, -4, 2.4, 11.2, 16, 16, 16, 16.8] },
  headphones: { pre: 4, bands: [4.8, 11.2, 5.6, -3.2, -2.4, 1.6, 4.8, 9.6, 12.8, 14.4] },
  largehall: { pre: 5, bands: [10.4, 10.4, 5.6, 5.6, 0, -4.8, -4.8, -4.8, 0, 0] },
  live: { pre: 7, bands: [-4.8, 0, 4, 5.6, 5.6, 5.6, 4, 2.4, 2.4, 2.4] },
  party: { pre: 6, bands: [7.2, 7.2, 0, 0, 0, 0, 0, 0, 7.2, 7.2] },
  pop: { pre: 6, bands: [-1.6, 4.8, 7.2, 8, 5.6, 0, -2.4, -2.4, -1.6, -1.6] },
  reggae: { pre: 8, bands: [0, 0, 0, -5.6, 0, 6.4, 6.4, 0, 0, 0] },
  rock: { pre: 5, bands: [8, 4.8, -5.6, -8, -3.2, 4, 8.8, 11.2, 11.2, 11.2] },
  ska: { pre: 6, bands: [-2.4, -4.8, -4, 0, 4, 5.6, 8.8, 9.6, 11.2, 9.6] },
  soft: { pre: 5, bands: [4.8, 1.6, 0, -2.4, 0, 4, 8, 9.6, 11.2, 12] },
  softrock: { pre: 7, bands: [4, 4, 2.4, 0, -4, -5.6, -3.2, 0, 2.4, 8.8] },
  techno: { pre: 5, bands: [8, 5.6, 0, -5.6, -4.8, 0, 8, 9.6, 9.6, 8.8] },
  voice: { pre: 10, bands: [-6, -4, -2, 0, 3, 5, 5, 3, 0, -2] },
};
export interface SoundState { eqOn: boolean; eq: EqBands; eqPreamp: number; normalize: boolean; mono: boolean; balance: number; audioDelay: number; gain: number }
const db = (x: number) => Math.pow(10, x / 20);

export class SoundGraph {
  private ctx: AudioContext; private src: MediaElementAudioSourceNode; private pre: GainNode; private bands: BiquadFilterNode[]; private comp: DynamicsCompressorNode;
  private monoNode: GainNode; private pan: StereoPannerNode; private delay: DelayNode; private out: GainNode;
  constructor(video: HTMLMediaElement) {
    this.ctx = new AudioContext(); this.src = this.ctx.createMediaElementSource(video);
    this.pre = this.ctx.createGain();
    this.bands = EQ_FREQS.map((f, i) => { const b = this.ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1.1; b.gain.value = 0; return b; });
    this.comp = this.ctx.createDynamicsCompressor();
    this.monoNode = this.ctx.createGain(); this.pan = this.ctx.createStereoPanner(); this.delay = this.ctx.createDelay(10); this.out = this.ctx.createGain();
    this.wire(false);
  }
  private wired = '';
  /** The chain, rebuilt when the compressor or mono come or go (a node bypassed is left out of it). */
  private wire(normalize: boolean, mono = false) {
    const key = `${normalize}|${mono}`; if (key === this.wired) return; this.wired = key;
    for (const n of [this.src, this.pre, ...this.bands, this.comp, this.monoNode, this.pan, this.delay, this.out]) { try { n.disconnect(); } catch { /* not connected */ } }
    const chain: AudioNode[] = [this.src, this.pre, ...this.bands];
    if (normalize) { this.comp.threshold.value = -28; this.comp.knee.value = 24; this.comp.ratio.value = 8; this.comp.attack.value = 0.004; this.comp.release.value = 0.25; chain.push(this.comp); }
    if (mono) { this.monoNode.channelCount = 1; this.monoNode.channelCountMode = 'explicit'; this.monoNode.channelInterpretation = 'speakers'; chain.push(this.monoNode); }
    chain.push(this.pan, this.delay, this.out, this.ctx.destination);
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
  }
  apply(s: SoundState): void {
    void this.ctx.resume().catch(() => undefined);
    this.wire(s.normalize, s.mono);
    const on = s.eqOn; this.pre.gain.value = on ? db(s.eqPreamp) : 1;
    this.bands.forEach((b, i) => { b.gain.value = on ? s.eq[i] ?? 0 : 0; });
    this.pan.pan.value = Math.max(-1, Math.min(1, s.balance / 100));
    this.delay.delayTime.value = Math.max(0, Math.min(10, s.audioDelay));
    this.out.gain.value = Math.max(0, s.gain) * (s.normalize ? 1.6 : 1);
  }
  close(): void { try { void this.ctx.close(); } catch { /* closed */ } }
}
/** A preset's bands and preamp as the app keeps them (the preamp relative to Flat's). */
export function presetValues(name: string): { eq: EqBands; eqPreamp: number } | null { const p = EQ_PRESETS[name]; return p ? { eq: [...p.bands] as EqBands, eqPreamp: Math.round((p.pre - 12) * 10) / 10 } : null; }
