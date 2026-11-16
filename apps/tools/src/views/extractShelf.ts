// «Unfinished extractions»: a calm card at the top of Files (and checked once at start) listing every extraction a
// stop, a crash or a full disk left half done — each with Finish, Restore the archive, or Leave as is, each said in one
// line. A job whose record cannot be trusted (damaged, from a newer version, its archive changed since) is never
// replayed: it says why and offers only to leave it. The computer keeps the list (desktop/inplace.cjs's registry);
// the phone shows its half-done archive when it is opened (the sheet's Continue / Restore).
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { shelfJobs, shelfAct, type ShelfJob } from '../archives/safety';
import { baseName } from '../archives';

const LEFT = 'kt.extract.left';
const leftNow = (): string[] => { try { return JSON.parse(sessionStorage.getItem(LEFT) ?? '[]') as string[]; } catch { return []; } };
const leave = (j: string) => { try { sessionStorage.setItem(LEFT, JSON.stringify([...leftNow(), j])); } catch { /* none */ } };
type K = Parameters<typeof t>[0];
const why = (w: string): string => { const k = `shelfWhy_${w}` as K; const v = t(k); return v === k ? w : v; };

/** What an Undo or a Restore did, said plainly (P11 review): the files that could not go back into the archive, the archive made again
 *  under another name (a file took its name), originals put back beside an edited file, files kept in the hidden folder. */
export function undoSummary(r: unknown): string {
  const o = (r ?? {}) as { identical?: boolean; keptOut?: string[]; restoredTo?: string; originals?: string[]; asideKept?: string };
  const say: string[] = []; const names = (a: string[]) => a.slice(0, 5).join(document.documentElement.lang === 'ar' ? '، ' : ', ') + (a.length > 5 ? ' …' : '');
  if (o.keptOut?.length) say.push(t('undoPartial', { n: localDigits(o.keptOut.length), names: names(o.keptOut) }));
  else say.push(o.identical === false ? t('restoredPart', { n: localDigits(0) }) : t('undone'));
  if (o.restoredTo) say.push(t('undoBeside', { name: baseName(o.restoredTo) }));
  if (o.originals?.length) say.push(t('undoOriginals', { names: names(o.originals) }));
  if (o.asideKept) say.push(t('undoAsideKept', { name: baseName(o.asideKept) }));
  return say.join(' ');
}
/** The archive's password for a Finish (a stopped job of a locked archive); null when the sheet is closed. */
function askPassword(name: string, wrong: boolean): Promise<string | null> {
  return new Promise((res) => {
    let done = false; const sh = openSheet(name, t('cancel'), { onClose: () => { if (!done) res(null); } });
    const pw = h('input', { type: 'password', dir: 'ltr', autocomplete: 'off' }) as HTMLInputElement;
    const go = () => { if (!pw.value) return; done = true; sh.close(); res(pw.value); };
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    sh.body.append(h('p', { class: 'hint' }, wrong ? t('wrongPassword') : t('shelfPasswordAsk')), h('label', { class: 'field' }, h('span', null, t('password')), pw));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: go }, t('shelfFinish')));
    setTimeout(() => pw.focus(), 50);
  });
}

/** The card, drawn into `el` (empty and hidden when nothing is left unfinished). */
export async function shelfBanner(el: HTMLElement, jobs?: ShelfJob[]): Promise<void> {
  const all = (jobs ?? (await shelfJobs())).filter((j) => j.state !== 'done' && !leftNow().includes(j.journal));
  el.hidden = !all.length; if (!all.length) { el.replaceChildren(); return; }
  const redraw = () => void shelfBanner(el);
  const act = async (j: ShelfJob, a: 'finish' | 'restore' | 'restoreV1', btn: HTMLButtonElement) => {
    btn.disabled = true; btn.classList.add('busy');
    try {
      let r: unknown; let pw: string | undefined; let wrong = false;
      for (;;) {
        try { r = await shelfAct(j.journal, a, undefined, pw); break; }
        catch (e) { const m = String((e as Error).message ?? e); if (a !== 'finish' || !/password/i.test(m)) throw e; const got = await askPassword(baseName(j.archive), wrong); if (got === null) { btn.disabled = false; btn.classList.remove('busy'); return; } pw = got; wrong = true; }
      }
      const o = r as { identical?: boolean; keptOut?: string[] } | undefined;
      toast(a === 'finish' ? t('shelfFinished') : o?.keptOut?.length || (r as { restoredTo?: string })?.restoredTo || (r as { originals?: string[] })?.originals?.length || (r as { asideKept?: string })?.asideKept ? undoSummary(r) : t('restoredWhole'), o?.keptOut?.length ? 'error' : undefined, o?.keptOut?.length ? 8000 : undefined);
    }
    catch (e) { toast(why(String((e as Error).message ?? e)), 'error'); }
    redraw();
  };
  const rows = all.map((j) => {
    const blocked = j.state === 'blocked'; const line = blocked ? why(j.why ?? '') : [t('shelfProgress', { done: localDigits(j.done), total: localDigits(j.total) }), j.why ? why(j.why) : ''].filter(Boolean).join(' · ');
    const btn = (label: string, cls: string, run: (b: HTMLButtonElement) => void) => { const b = h('button', { type: 'button', class: `btn ${cls}` }, label) as HTMLButtonElement; b.onclick = () => run(b); return b; };
    const buttons: HTMLElement[] = []; const hints: HTMLElement[] = [];
    if (j.can.includes('finish')) { buttons.push(btn(t('shelfFinish'), 'primary', (b) => void act(j, 'finish', b))); hints.push(h('li', null, h('b', null, t('shelfFinish')), ' — ', t('shelfFinishHint'))); }
    if (j.can.includes('restore')) { buttons.push(btn(t('shelfRestore'), 'tonal', (b) => void act(j, 'restore', b))); hints.push(h('li', null, h('b', null, t('shelfRestore')), ' — ', t(j.mode === 'normal' ? 'shelfRestoreHintNormal' : 'shelfRestoreHint'))); }
    if (j.can.includes('restoreV1')) { buttons.push(btn(t('shelfRestoreV1'), 'tonal', (b) => void act(j, 'restoreV1', b))); hints.push(h('li', null, h('b', null, t('shelfRestoreV1')), ' — ', t('shelfRestoreV1Hint'))); }
    buttons.push(btn(t('shelfLeave'), 'text', () => { leave(j.journal); redraw(); })); hints.push(h('li', null, h('b', null, t('shelfLeave')), ' — ', t('shelfLeaveHint')));
    return h('div', { class: 'shelf-job' + (blocked ? ' blocked' : '') }, h('div', { class: 'shelf-name' }, icon('archive'), h('span', { dir: 'auto' }, baseName(j.archive))), h('small', { class: 'src', dir: 'auto' }, line), h('ul', { class: 'shelf-hints' }, ...hints), h('div', { class: 'shelf-actions' }, ...buttons));
  });
  el.replaceChildren(h('div', { class: 'shelf-card', role: 'region', 'aria-label': t('shelfTitle') }, h('div', { class: 'shelf-head' }, icon('clock'), h('b', null, t('shelfTitle'))), ...rows));
}
/** At start: finished jobs whose Undo offer ended are tidied (their set-aside files and saved tails removed). */
export async function shelfAtStart(): Promise<number> { const jobs = await shelfJobs(true); return jobs.filter((j) => j.state !== 'done').length; }
