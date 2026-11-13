// The hand-over's screens (src/handover.ts): in the Rust build, the first start's «your library from the previous
// version» (how many books, how big, where the old data stays untouched, a progress bar while it comes) and Settings'
// rows to bring it later, from a folder or a backup file, and to free the space once it is here; in the Electron
// bridge build, the sheet shown while the library is made ready before the update is installed. Only on a computer's
// app: the rows and screens appear where the shell gives window.kurokawaHandover — never on a phone or the web.
import { h, icon, openSheet, toast } from './dom';
import { t, formatBytes } from '../i18n';
import type { Found, MakeResult } from '../handover';

const api = () => (window as unknown as { kurokawaHandover?: import('../handover').HandoverApi }).kurokawaHandover;
const pathLine = (p: string) => h('p', null, h('code', { dir: 'ltr', style: { wordBreak: 'break-all', userSelect: 'text' } }, p));

/** At the Rust build's start, when the first-run screen is not shown (its first run was done before): the hand-over
 *  offered alone, when one is there to bring and this profile is empty. (When the first-run screen shows, it carries
 *  the same offer itself — ui/firstrun.ts, through handoverOffer —: one screen, never two.) */
export async function handoverAtStart(): Promise<void> {
  const f = await handoverToOffer(); if (f) handoverSheet(f, { atStart: true });
}

/** The hand-over to offer at this start, if any (found whole, neither brought nor declined, this profile empty or a
 *  restore of it broken off); null where the shell reads none. */
export async function handoverToOffer(): Promise<Found | null> {
  const a = api(); if (!a?.find) return null;
  let f: Found; try { f = await a.find(); } catch { return null; }
  const { offerAtStart } = await import('../handover');
  return (await offerAtStart(f)) ? f : null;
}

/** Where the offer is shown: a sheet of its own (handoverSheet), or the first-run screen's tile (ui/firstrun.ts). */
export interface OfferHost {
  /** Carries data-handover: offer → done | failed (CI's check, desktop-tauri/handovercheck.js, reads it). */
  root: HTMLElement; body: HTMLElement; actions: HTMLElement;
  /** Offered by itself at the start: «Not now» then means «not at the start again» (marked declined). */
  atStart?: boolean;
  onLater(): void; onContinue(): void;
  onBusy?(busy: boolean): void; onDone?(): void;
}

/** The offer itself: what it holds, where the old data stays, «Bring it now» with its progress, then the result,
 *  «Free the space» and «Continue». */
export function handoverOffer(f: Found & { found: true; marker: NonNullable<Found['marker']>; dir: string }, host: OfferHost): void {
  const m = f.marker; const dir = f.dir;
  let busy = false;
  host.root.setAttribute('data-handover', 'offer');
  const books = m.counts?.books ?? 0;
  host.body.append(
    h('p', null, t('handoverFound')),
    h('p', { class: 'handover-count' }, h('b', null, t('handoverCount', { n: books })), ' · ', t('handoverSize', { size: formatBytes(m.bytes) })),
    h('p', { class: 'hint' }, t('handoverUntouched')), pathLine(dir));
  if (f.state?.id === m.id && f.state.state === 'restored') host.body.append(h('p', { class: 'hint' }, t('handoverAlreadyDone', { date: new Date(f.state.at).toLocaleString() })));
  const bar = h('progress', { max: 1, value: 0, style: { width: '100%' }, hidden: true }) as HTMLProgressElement;
  const status = h('p', { class: 'src', role: 'status' });
  host.body.append(bar, status);
  const setBusy = (b: boolean) => { busy = b; host.onBusy?.(b); };
  const later = h('button', { type: 'button', class: 'btn text', onclick: async () => {
    if (busy) return;
    if (host.atStart) { await api()?.mark?.({ id: m.id, state: 'declined' }).catch(() => false); if (!host.root.closest('.firstrun')) toast(t('handoverLaterHint'), 'info', 4000); }   // (the first-run tile says it itself)
    host.onLater();
  } }, t('handoverLater')) as HTMLButtonElement;
  const go = h('button', { type: 'button', class: 'btn primary', 'data-handover-go': '1', onclick: async () => {
    if (busy) return; setBusy(true); go.disabled = true; later.disabled = true; bar.hidden = false;
    try {
      const { restoreHandover } = await import('../handover');
      const r = await restoreHandover(f, (p) => {
        if (p.step === 'books') { bar.value = p.total ? p.done / p.total : 0; status.textContent = t('handoverBooksStep', { done: p.done, n: p.total }); }
        else { status.textContent = p.step === 'verify' ? t('handoverVerifying') : p.step === 'check' ? t('handoverVerifying') : t('handoverSettingsStep'); }
      });
      bar.value = 1; host.root.setAttribute('data-handover', 'done');
      status.textContent = t('handoverDone', { n: r.books, h: r.highlights });
      host.onDone?.(); setBusy(false);
      host.actions.replaceChildren(
        h('button', { type: 'button', class: 'btn text', 'data-handover-free': '1', onclick: () => freeSheet(dir, m.bytes) }, icon('trash'), t('handoverFree')),
        h('button', { type: 'button', class: 'btn primary', 'data-handover-continue': '1', onclick: () => host.onContinue() }, t('handoverContinue')));
    } catch (e) {
      const broken = (e as { code?: string })?.code === 'broken';
      host.root.setAttribute('data-handover', 'failed');
      status.textContent = `${broken ? t('handoverBroken') : t('handoverFailed')} — ${String((e as Error)?.message ?? e)}`;
      setBusy(false); go.disabled = broken; later.disabled = false;
    }
  } }, icon('import'), t('handoverBring')) as HTMLButtonElement;
  host.actions.append(later, go);
}

/** The offer in a sheet of its own (at the start without the first-run screen, and Settings → Backup); after it came,
 *  closing the sheet reloads the page with what it brought. */
export function handoverSheet(f: Found, o: { atStart?: boolean } = {}): void {
  if (!f.found || !f.marker || !f.dir) { toast(t('handoverNone')); return; }
  let done = false;
  const sh = openSheet(t('handoverTitle'), t('close'), { onClose: () => { if (done) location.reload(); } });
  sh.body.style.fontFamily = 'var(--font-ui)';
  handoverOffer({ ...f, found: true, marker: f.marker, dir: f.dir }, { root: sh.el, body: sh.body, actions: sh.actions, atStart: o.atStart, onLater: () => sh.close(), onContinue: () => sh.close(), onDone: () => { done = true; } });
}

/** «Free the space»: asks, then deletes the copy the previous version left (never the old profile itself). */
function freeSheet(dir: string, bytes: number): void {
  const sh = openSheet(t('handoverFree'), t('cancel'), { stack: true });
  // (Asked from the first-run screen's offer: above that screen, which covers the sheets.)
  if (document.querySelector('.firstrun')) { sh.el.style.zIndex = '96'; const scrim = sh.el.previousElementSibling as HTMLElement | null; if (scrim?.classList.contains('scrim')) scrim.style.zIndex = '95'; }
  sh.body.style.fontFamily = 'var(--font-ui)';
  sh.body.append(h('p', null, t('handoverFreeAsk', { size: formatBytes(bytes) })), pathLine(dir), h('p', { class: 'hint' }, t('handoverFreeKeeps')));
  sh.actions.append(
    h('button', { type: 'button', class: 'btn text', onclick: () => sh.close() }, t('cancel')),
    h('button', { type: 'button', class: 'btn primary', 'data-handover-free-yes': '1', onclick: async () => {
      try { const r = await api()!.free!(dir); sh.close(); toast(t('handoverFreed', { size: formatBytes(r?.freed ?? bytes) })); }
      catch (e) { sh.close(); toast(String((e as Error)?.message ?? e), 'error', 5000); }
    } }, icon('trash'), t('handoverFreeYes')));
}

/** Settings → Backup, in the Rust build: bring the library from the previous version (again), from a folder, from a
 *  backup file; free the space after it came. Nothing where the shell has no hand-over reader. */
export function handoverRows(): HTMLElement | null {
  const a = api(); if (!a?.find) return null;
  const row = h('div', { class: 'field handover-rows', style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } });
  const pickDir = (window as unknown as { kurokawaDesktop?: { pickFolder?(): Promise<string | null> } }).kurokawaDesktop?.pickFolder;
  row.append(
    h('p', { class: 'hint', style: { flexBasis: '100%' } }, t('handoverSettingsHint')),
    h('button', { type: 'button', class: 'btn small tonal', onclick: async () => { const f = await a.find!().catch(() => null); if (f?.found) handoverSheet(f); else toast(t('handoverNone')); } }, icon('import'), t('handoverSettingsBring')),
    ...(pickDir ? [h('button', { type: 'button', class: 'btn small outlined', onclick: async () => {
      const d = await pickDir().catch(() => null); if (!d) return;
      const f = await a.find!(d).catch(() => null); if (f?.found) handoverSheet(f); else toast(t('handoverNotFolder'), 'error', 4000);
    } }, icon('folder'), t('handoverSettingsFolder'))] : []),
    h('button', { type: 'button', class: 'btn small outlined', onclick: () => void import('./restoresheet').then((m) => m.restoreSheet()) }, icon('undo'), t('handoverSettingsFile')));
  // (Once it came: the copy's space can be given back.)
  void a.find().then((f) => {
    if (f.found && f.dir && f.marker && f.state?.id === f.marker.id && f.state.state === 'restored') {
      const dir = f.dir, bytes = f.marker.bytes;
      row.append(h('button', { type: 'button', class: 'btn small text', onclick: () => freeSheet(dir, bytes) }, icon('trash'), t('handoverFree')));
    }
  }).catch(() => undefined);
  return row;
}

/** The Electron bridge build, before it installs the Rust build: the library made ready (with its progress), and
 *  true only when the hand-over is written and checked. On false the update must NOT be installed: the reader has
 *  been told why, plainly, and this version keeps working as it was. */
export async function handoverBeforeInstall(): Promise<boolean> {
  // (Over the update sheet that asked — its download's progress comes after this —, not in its place.)
  const sh = openSheet(t('handoverMaking'), t('close'), { stack: !!document.querySelector('.sheet') });
  sh.body.style.fontFamily = 'var(--font-ui)'; sh.el.setAttribute('data-handover', 'making');
  const bar = h('progress', { max: 1, value: 0, style: { width: '100%' } }) as HTMLProgressElement;
  const status = h('p', { class: 'src', role: 'status' }, t('handoverMaking'));
  sh.body.append(bar, status);
  const { makeHandover } = await import('../handover');
  const make = (spaceUnknownOk: boolean) => makeHandover((p) => {
    if (p.step === 'files') { bar.value = p.total ? p.done / p.total : 0; status.textContent = t('handoverMakingFiles', { done: p.done, n: p.total }); }
    else if (p.step === 'check') status.textContent = t('handoverVerifying');
  }, { spaceUnknownOk });
  let r: MakeResult = await make(false);
  // (The free space could not be read: never gone on with silently — the estimate shown, and made only on «Continue».)
  if (!r.ok && r.reason === 'unknown') {
    sh.el.setAttribute('data-handover', 'ask-space'); bar.hidden = true;
    status.textContent = t('handoverSpaceUnknown', { need: formatBytes(r.need ?? 0), profile: formatBytes(r.profile ?? 0) });
    let answer: (go: boolean) => void = () => undefined;
    const said = new Promise<boolean>((res) => { answer = res; });
    const no = h('button', { type: 'button', class: 'btn', 'data-act': 'space-no', onclick: () => answer(false) }, t('cancel'));
    const yes = h('button', { type: 'button', class: 'btn primary', 'data-act': 'space-go', onclick: () => answer(true) }, t('handoverSpaceGoOn'));
    sh.actions.append(no, yes);
    const watch = window.setInterval(() => { if (!sh.el.isConnected) answer(false); }, 300);
    const go = await said; window.clearInterval(watch); no.remove(); yes.remove();
    if (!go) { sh.close(); toast(t('handoverNotMade')); return false; }
    sh.el.setAttribute('data-handover', 'making'); bar.hidden = false; bar.value = 0; status.textContent = t('handoverMaking');
    r = await make(true);
  }
  if (r.ok) { sh.close(); toast(t('handoverMadeOk')); return true; }
  sh.el.setAttribute('data-handover', 'failed');
  bar.remove();
  status.textContent = r.reason === 'space' ? t('handoverNoSpace', { need: formatBytes(r.need ?? 0), free: formatBytes(r.free ?? 0) }) : `${t('handoverMakeFailed')}${r.detail ? ` (${r.detail})` : ''}`;
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => sh.close() }, t('close')));
  return false;
}
