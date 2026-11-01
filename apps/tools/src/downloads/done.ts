// When downloads finish, as Prism does it: a sound (eleven to choose from, Prism's own), another when one fails and
// another when everything has finished, at the volume set; and the «Download complete» card — the file, how long
// it took and its average speed, Open · Folder · Copy path · Convert · Make smaller · Verify, «Don't show again».
// On a computer, a system notification too when the app is not in front.
import { h, icon, toast } from '../ui/dom';
import { t, formatBytes } from '../i18n';
import { getEngine, displayName, onEngineChange } from '../engine';
import type { Task } from '../engine/types';
import { getSettings, updateSettings } from '../settings';
import { fmtSecs } from '../views/taskmap';

export const COMPLETE_SOUNDS: [string, string][] = [['classic', 'soundClassic'], ['prism', 'Prism'], ['pop', 'soundPop'], ['kalimba', 'soundKalimba'], ['snap', 'soundSnap'], ['cascade', 'soundCascade'], ['glide', 'soundGlide'], ['harp', 'soundHarp'], ['droplet', 'soundDroplet'], ['music-box', 'soundMusicBox'], ['sparkle', 'soundSparkle']];
export interface SoundPrefs { on: boolean; complete: string; failed: boolean; allDone: boolean; volume: number; card: boolean }
export const SOUND_DEFAULT: SoundPrefs = { on: true, complete: 'classic', failed: true, allDone: true, volume: 0.7, card: true };
export const soundPrefs = (): SoundPrefs => ({ ...SOUND_DEFAULT, ...(getSettings().sounds as Partial<SoundPrefs> | undefined) });

const base = () => (document.querySelector('base')?.href ?? location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, ''));
/** Plays one of the sounds: 'complete' (the chosen one), 'failed' or 'queue'. */
export function playSound(kind: 'complete' | 'failed' | 'queue', which?: string): void {
  const p = soundPrefs(); const id = which ?? p.complete;
  const file = kind === 'failed' ? 'failed' : kind === 'queue' ? 'queue' : id && id !== 'classic' ? `complete-${id}` : 'complete';
  try { const a = new Audio(new URL(`sounds/${file}.ogg`, base()).href); a.volume = Math.max(0, Math.min(1, p.volume)); void a.play().catch(() => undefined); } catch { /* no audio here */ }
}

let watching = false;
export function startDoneWatch(): void {
  if (watching) return; watching = true;
  const seen = new Map<string, string>(); let first = true; let busy = false;
  const look = (ts: Task[]) => {
    const p = soundPrefs();
    if (!first) for (const x of ts) {
      const was = seen.get(x.id);
      if (was && was !== x.state) {
        if (x.state === 'done' || (x.state === 'seeding' && was !== 'done' && was !== 'paused')) { if (p.on) playSound('complete'); if (p.card) doneCard(x); notify(x); void scanDone(x); void checkSha(x); }
        else if (x.state === 'failed') { if (p.on && p.failed) playSound('failed'); }
      }
    }
    for (const x of ts) seen.set(x.id, x.state);
    const nowBusy = ts.some((x) => x.state === 'downloading' || x.state === 'queued' || x.state === 'metadata' || x.state === 'checking');
    if (!first && busy && !nowBusy && ts.length > 1 && p.on && p.allDone) setTimeout(() => playSound('queue'), 900);
    busy = nowBusy; first = false;
  };
  let off = getEngine().onChange(look);
  onEngineChange((e) => { off(); first = true; off = e.onChange(look); });
}
function notify(x: Task): void {
  if (!getSettings().notifyDone || !document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { new Notification(t('doneTitle'), { body: displayName(x), silent: true }); } catch { /* not here */ }
}

/** The card: the file, its time and average speed, and what to do with it. */
export function doneCard(x: Task): void {
  document.querySelectorAll('.done-card').forEach((e) => e.remove());
  const name = displayName(x); const eng = getEngine();
  const took = x.doneAt && x.addedAt ? (x.doneAt - x.addedAt) / 1000 : 0; const avg = took > 0 && x.total ? x.total / took : 0;
  const path = x.dir && !x.dir.startsWith('content:') ? `${x.dir.replace(/[\\/]$/, '')}/${x.kind === 'torrent' && x.files.length > 1 ? x.name : name}` : '';
  let timer = 0; const close = () => { window.clearTimeout(timer); el.classList.add('leaving'); setTimeout(() => el.remove(), 180); };
  const btn = (ic: string, label: string, fn: () => void, cls = 'btn small tonal') => h('button', { type: 'button', class: cls, onclick: () => { fn(); close(); } }, icon(ic), label);
  const more = h('div', { class: 'done-more' });
  const el = h('div', { class: 'get-card done-card', role: 'status' },
    h('div', { class: 'get-head' }, h('span', { class: 'get-ic ok' }, icon('check')), h('div', { class: 'grow' }, h('b', null, t('doneTitle')), h('small', { dir: 'auto' }, name),
      took ? h('small', null, t('doneStats', { time: fmtSecs(took), speed: t('perSecond', { n: formatBytes(avg) }) })) : null),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('close'), onclick: close }, icon('close'))),
    more,
    h('div', { class: 'get-actions wrap' },
      h('button', { type: 'button', class: 'btn small text', onclick: () => { updateSettings({ sounds: { ...soundPrefs(), card: false } }); toast(t('doneNoMore')); close(); } }, t('doneDontShow')),
      h('span', { class: 'grow' }),
      eng.open ? btn('folder', t('openFolder'), () => void eng.open!(x.id, -1)) : null,
      eng.open ? btn('external', t('open'), () => void eng.open!(x.id), 'btn small primary') : null));
  if (path) {
    more.append(btn('copy', t('donePath'), () => void navigator.clipboard?.writeText(path).then(() => toast(t('copied')))));
    if (x.kind !== 'torrent') {
      more.append(btn('check', t('verifyTitle'), () => void import('./prism').then((m) => m.verifySheet(path))));
      void import('../views/convert').then((m) => { if (m.canConvert() && m.kindOf(name)) more.append(btn('convert', t('convertTitle'), () => void m.convertSheet(path, 'convert')), btn('archive', t('shrinkTitle'), () => void m.convertSheet(path, 'shrink'))); });
    }
  }
  document.body.append(el);
  timer = window.setTimeout(close, 14000);
  el.addEventListener('pointerenter', () => window.clearTimeout(timer)); el.addEventListener('focusin', () => window.clearTimeout(timer));
}

/* ---------- the antivirus check (Prism's), on a computer ---------- */
export const AV_EXTS = 'exe msi zip rar 7z apk dmg pkg deb rpm appimage bat cmd ps1 jar iso';
type AvResult = { result: 'clean' | 'infected' | 'error' | 'skipped'; detail?: string; scanner?: string };
async function scanDone(x: Task): Promise<void> {
  const av = getSettings().av; const d = window.kurokawaTools as unknown as { avScan?(o: { file: string; cfg: unknown }): Promise<AvResult> } | undefined;
  if (!av?.on || !d?.avScan || !x.dir) return;
  const name = displayName(x); const file = `${x.dir.replace(/[\\/]$/, '')}/${x.kind === 'torrent' && x.files.length > 1 ? x.name : name}`;
  // (Each line with «Turn off»: the check stopped for later downloads from where it shows, not only in Settings.)
  const off = () => h('button', { type: 'button', class: 'btn text small av-off', onclick: (e: Event) => { const now = getSettings().av; if (now) updateSettings({ av: { ...now, on: false } }); (e.currentTarget as HTMLElement).replaceWith(h('span', null, ` · ${t('avTurnedOff')}`)); toast(t('avTurnedOff')); } }, t('avTurnOff'));
  const line = (cls: string, text: string) => { const card = document.querySelector('.done-card .get-head .grow'); if (card) { card.querySelector('.av-line')?.remove(); card.append(h('small', { class: `av-line ${cls}` }, text, ' ', off())); } };
  line('busy', t('avScanning'));
  const r = await d.avScan({ file, cfg: { ...av, extensions: av.extensions.split(/[\s,]+/).filter(Boolean) } }).catch((e) => ({ result: 'error', detail: String((e as Error).message ?? e) }) as AvResult);
  if (r.result === 'clean') line('ok', t('avClean'));
  else if (r.result === 'infected') { line('bad', t('avThreat')); toast(t('avThreatToast', { name }), 'error', 15000); playSound('failed'); }
  else if (r.result === 'error') line('bad', r.detail === 'no-scanner' ? t('avNoScanner') : t('avError', { why: (r.detail ?? '').split('\n')[0] }));
  else document.querySelector('.done-card .av-line')?.remove();
}

/* ---------- a file with a known SHA-256 (Hugging Face) checked when it is done ---------- */
async function checkSha(x: Task): Promise<void> {
  const want = x.meta?.sha256; if (!want || !x.dir) return;
  const file = `${x.dir.replace(/[\\/]$/, '')}/${displayName(x)}`;
  try {
    const { hashFile } = await import('./prism'); const got = await hashFile(file);
    if (!got) return;
    if (got.sha256.toLowerCase() === want.toLowerCase()) toast(t('shaOk', { name: displayName(x) }));
    else { toast(t('shaBad', { name: displayName(x) }), 'error', 15000); playSound('failed'); }
  } catch { /* cannot read it here */ }
}
