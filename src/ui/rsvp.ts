// Speed reading: one word at a time in the middle of the screen, at a pace the reader sets, with the letter
// the eye should rest on marked — no eye movement, no re-reading. Punctuation and long words get a little
// more time. Space plays and pauses, the arrows step, Escape leaves.
import { h, icon, iconButton } from './dom';
import { t, localDigits } from '../i18n';

const KEY = 'kr.rsvp.wpm';

/** Cut text into the units shown one by one (CJK in short runs, since it has no spaces). */
export function rsvpUnits(text: string): string[] {
  const out: string[] = [];
  for (const w of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (!w) continue;
    if (/[぀-ヿ㐀-鿿가-힯]/.test(w) && w.length > 4) { for (let i = 0; i < w.length; i += 3) out.push(w.slice(i, i + 3)); }
    else out.push(w);
  }
  return out;
}

export function speedReader(host: HTMLElement, units: string[], opts: { start?: number; onClose?(at: number): void } = {}): () => void {
  let i = Math.max(0, Math.min(units.length - 1, opts.start ?? 0));
  let wpm = Number(localStorage.getItem(KEY)) || 300;
  let timer = 0, playing = false;
  const word = h('div', { class: 'rsvp-word', dir: 'auto' });
  const pos = h('div', { class: 'rsvp-pos' });
  const speed = h('input', { type: 'range', min: '120', max: '900', step: '10', value: String(wpm), 'aria-label': t('speedWpm') }) as HTMLInputElement;
  const speedLabel = h('span', { class: 'rsvp-wpm' });
  const playBtn = iconButton('play', t('play'), () => (playing ? pause() : play()));
  const bar = h('div', { class: 'rsvp-bar' }, h('i'));
  const el = h('div', { class: 'rsvp', role: 'dialog', 'aria-label': t('speedReading') },
    h('div', { class: 'rsvp-top' }, iconButton('close', t('close'), () => close()), h('span', { class: 'spacer' }), pos),
    h('div', { class: 'rsvp-stage' }, h('div', { class: 'rsvp-guide' }), word),
    bar,
    h('div', { class: 'rsvp-controls' }, iconButton('chevronLeft', t('previousPage'), () => { step(-10); }), playBtn, iconButton('chevronRight', t('nextPage'), () => { step(10); }), speed, speedLabel));
  const show = () => {
    const u = units[i] ?? '';
    // The letter to rest the eye on: a little left of the middle (reading direction aside, the middle is safest).
    const chars = [...u]; const orp = Math.max(0, Math.min(chars.length - 1, Math.round(chars.length * 0.35)));
    word.replaceChildren(h('span', null, chars.slice(0, orp).join('')), h('b', null, chars[orp] ?? ''), h('span', null, chars.slice(orp + 1).join('')));
    pos.textContent = `${localDigits(String(i + 1))} / ${localDigits(String(units.length))}`;
    (bar.firstChild as HTMLElement).style.width = `${(100 * (i + 1)) / Math.max(1, units.length)}%`;
    speedLabel.textContent = `${localDigits(String(wpm))} ${t('wpm')}`;
  };
  const delayFor = (u: string) => { let d = 60000 / wpm; if (u.length > 9) d *= 1.3; if (/[.!?؟。！？]$/.test(u)) d *= 2; else if (/[,،;؛:]$/.test(u)) d *= 1.5; return d; };
  const tick = () => { if (!playing) return; if (i >= units.length - 1) { pause(); return; } i++; show(); timer = window.setTimeout(tick, delayFor(units[i])); };
  const play = () => { if (i >= units.length - 1) i = 0; playing = true; playBtn.replaceChildren(icon('pause')); playBtn.setAttribute('aria-label', t('pause')); show(); timer = window.setTimeout(tick, delayFor(units[i])); };
  const pause = () => { playing = false; window.clearTimeout(timer); playBtn.replaceChildren(icon('play')); playBtn.setAttribute('aria-label', t('play')); };
  const step = (n: number) => { pause(); i = Math.max(0, Math.min(units.length - 1, i + n)); show(); };
  speed.addEventListener('input', () => { wpm = Number(speed.value); localStorage.setItem(KEY, String(wpm)); show(); });
  const onKey = (e: KeyboardEvent) => { if (e.key === ' ') { e.preventDefault(); playing ? pause() : play(); } else if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1); else if (e.key === 'Escape') close(); };
  const close = () => { pause(); window.removeEventListener('keydown', onKey); el.remove(); opts.onClose?.(i); };
  window.addEventListener('keydown', onKey);
  el.querySelector('.rsvp-stage')!.addEventListener('click', () => (playing ? pause() : play()));
  host.appendChild(el);
  show();
  return close;
}
