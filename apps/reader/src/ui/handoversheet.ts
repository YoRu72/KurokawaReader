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

/** At the Rust build's start: the first-run screen, when a hand-over is there to bring and this profile is empty. */
export async function handoverAtStart(): Promise<void> {
  const a = api(); if (!a?.find) return;
  let f: Found; try { f = await a.find(); } catch { return; }
  const { offerAtStart } = await import('../handover');
  if (await offerAtStart(f)) handoverSheet(f, { atStart: true });
}

/** The hand-over offered: what it holds, where the old data stays, «Bring it now» with its progress, then the
 *  result, «Free the space» and «Continue» (the page reloaded with its settings). */
export function handoverSheet(f: Found, o: { atStart?: boolean } = {}): void {
  if (!f.found || !f.marker || !f.dir) { toast(t('handoverNone')); return; }
  const m = f.marker; const dir = f.dir;
  let busy = false; let done = false;
  const sh = openSheet(t('handoverTitle'), t('close'), { onClose: () => { if (done) location.reload(); } });
  sh.body.style.fontFamily = 'var(--font-ui)';
  sh.el.setAttribute('data-handover', 'offer');
  const books = m.counts?.books ?? 0;
  sh.body.append(
    h('p', null, t('handoverFound')),
    h('p', { class: 'handover-count' }, h('b', null, t('handoverCount', { n: books })), ' · ', t('handoverSize', { size: formatBytes(m.bytes) })),
    h('p', { class: 'hint' }, t('handoverUntouched')), pathLine(dir));
  if (f.state?.id === m.id && f.state.state === 'restored') sh.body.append(h('p', { class: 'hint' }, t('handoverAlreadyDone', { date: new Date(f.state.at).toLocaleString() })));
  const bar = h('progress', { max: 1, value: 0, style: { width: '100%' }, hidden: true }) as HTMLProgressElement;
  const status = h('p', { class: 'src', role: 'status' });
  sh.body.append(bar, status);
  const later = h('button', { type: 'button', class: 'btn text', onclick: async () => {
    if (busy) return;
    if (o.atStart) { await api()?.mark?.({ id: m.id, state: 'declined' }).catch(() => false); toast(t('handoverLaterHint'), 'info', 4000); }
    sh.close();
  } }, t('handoverLater')) as HTMLButtonElement;
  const go = h('button', { type: 'button', class: 'btn primary', 'data-handover-go': '1', onclick: async () => {
    if (busy) return; busy = true; go.disabled = true; later.disabled = true; bar.hidden = false;
    try {
      const { restoreHandover } = await import('../handover');
      const r = await restoreHandover(f, (p) => {
        if (p.step === 'books') { bar.value = p.total ? p.done / p.total : 0; status.textContent = t('handoverBooksStep', { done: p.done, n: p.total }); }
        else { status.textContent = p.step === 'verify' ? t('handoverVerifying') : p.step === 'check' ? t('handoverVerifying') : t('handoverSettingsStep'); }
      });
      done = true; bar.value = 1; sh.el.setAttribute('data-handover', 'done');
      status.textContent = t('handoverDone', { n: r.books, h: r.highlights });
      sh.actions.replaceChildren(
        h('button', { type: 'button', class: 'btn text', 'data-handover-free': '1', onclick: () => freeSheet(dir, m.bytes) }, icon('trash'), t('handoverFree')),
        h('button', { type: 'button', class: 'btn primary', 'data-handover-continue': '1', onclick: () => { sh.close(); } }, t('handoverContinue')));
    } catch (e) {
      const broken = (e as { code?: string })?.code === 'broken';
      sh.el.setAttribute('data-handover', 'failed');
      status.textContent = `${broken ? t('handoverBroken') : t('handoverFailed')} — ${String((e as Error)?.message ?? e)}`;
      busy = false; go.disabled = broken; later.disabled = false;
    }
  } }, icon('import'), t('handoverBring')) as HTMLButtonElement;
  sh.actions.append(later, go);
}

/** «Free the space»: asks, then deletes the copy the previous version left (never the old profile itself). */
function freeSheet(dir: string, bytes: number): void {
  const sh = openSheet(t('handoverFree'), t('cancel'), { stack: true });
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
  const sh = openSheet(t('handoverMaking'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)'; sh.el.setAttribute('data-handover', 'making');
  const bar = h('progress', { max: 1, value: 0, style: { width: '100%' } }) as HTMLProgressElement;
  const status = h('p', { class: 'src', role: 'status' }, t('handoverMaking'));
  sh.body.append(bar, status);
  const { makeHandover } = await import('../handover');
  const r: MakeResult = await makeHandover((p) => {
    if (p.step === 'files') { bar.value = p.total ? p.done / p.total : 0; status.textContent = t('handoverMakingFiles', { done: p.done, n: p.total }); }
    else if (p.step === 'check') status.textContent = t('handoverVerifying');
  });
  if (r.ok) { sh.close(); toast(t('handoverMadeOk')); return true; }
  sh.el.setAttribute('data-handover', 'failed');
  bar.remove();
  status.textContent = r.reason === 'space' ? t('handoverNoSpace', { need: formatBytes(r.need ?? 0), free: formatBytes(r.free ?? 0) }) : `${t('handoverMakeFailed')}${r.detail ? ` (${r.detail})` : ''}`;
  sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => sh.close() }, t('close')));
  return false;
}
