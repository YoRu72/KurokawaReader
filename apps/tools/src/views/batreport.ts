// SPDX-License-Identifier: GPL-3.0-or-later
// Device battery, W4: «Report a device» (after the original v1.1.0's «Request support for a device» — BatteryHub,
// GPL-3.0-or-later; NOTICE.md). Loaded on first use from battery.ts (the page's «More» button). A sheet with a text the
// shell built (kt-battery report.rs): the devices the app sees, their HID collections, the reader that matched, the
// versions — no serial number, Bluetooth address, computer or user name, folder or report content. The user reads all
// of it, may edit it, and copies it or saves it; nothing is sent by the app, and no link carries any of it. The text is
// English (it is for the people who add support) — the sheet says so. The computer's build only.
import { h, icon, openSheet, toast } from '../ui/dom';
import { osT as t } from './batplat';

export type ReportReply = { text: string; devices: number; collections: number };
export type ReportDesk = { batteryReport(): Promise<ReportReply> };

const CSS = `
.sheet .bat-rep { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.sheet .bat-rep p { margin: 0; line-height: 1.55; font-size: 14px; color: var(--md-on-surface); }
.sheet .bat-rep p.hint { font-size: 12.5px; color: var(--md-on-surface-variant); }
.sheet .bat-rep textarea { width: 100%; box-sizing: border-box; min-height: 260px; max-height: 46vh; resize: vertical; padding: 12px 14px; border-radius: 16px; border: 1px solid var(--md-outline-variant); background: var(--md-surface-container); color: var(--md-on-surface); font: 12.5px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; direction: ltr; text-align: left; white-space: pre; overflow: auto; }
.sheet .bat-rep textarea:focus-visible { outline: 2px solid var(--md-primary); outline-offset: 2px; }
.sheet .bat-rep .bat-rep-counts { font-size: 12.5px; color: var(--md-on-surface-variant); }
.sheet .dest-row .name small { display: block; margin-top: 2px; color: var(--md-on-surface-variant); font-size: 12.5px; font-weight: 400; }
`;
function style(): void {
  if (document.getElementById('kt-batreport-css')) return;
  const s = document.createElement('style'); s.id = 'kt-batreport-css'; s.textContent = CSS; document.head.append(s);
}

/** The page's «More» sheet: one row today, «Report a device». */
export function openMore(d: ReportDesk, ev?: Event): void {
  style();
  const sh = openSheet(t('batMoreTitle'), t('close'), { at: ev });
  sh.body.append(h('div', { class: 'dest-list' },
    h('button', { type: 'button', class: 'dest-row', 'data-act': 'report', onclick: () => { sh.close(); openReport(d); } }, icon('file'), h('span', { class: 'name' }, t('batReportRow'), h('small', null, t('batReportRowHint'))))));
}

/** The report's sheet: the text whole, Copy, Save. */
export function openReport(d: ReportDesk): void {
  style();
  const sh = openSheet(t('batReportTitle'), t('close'));
  const area = h('textarea', { class: 'bat-rep-text', spellcheck: 'false', dir: 'ltr', 'aria-label': t('batReportLabel'), 'data-name': 'report-text' }) as HTMLTextAreaElement;
  area.value = t('batReportBusy');
  const counts = h('p', { class: 'bat-rep-counts' });
  const copy = h('button', { type: 'button', class: 'btn tonal bat-eq', 'data-act': 'copy', disabled: true, onclick: () => void doCopy() }, icon('copy'), t('copy')) as HTMLButtonElement;
  const save = h('button', { type: 'button', class: 'btn primary bat-eq', 'data-act': 'save', disabled: true, onclick: () => void doSave() }, icon('download'), t('save')) as HTMLButtonElement;
  const doCopy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(area.value); toast(t('copied')); }
    catch { area.focus(); area.select(); try { if (document.execCommand('copy')) toast(t('copied')); } catch { /* the text stays selected for the user's own copy */ } }
  };
  const doSave = async (): Promise<void> => {
    try { const p = await (await import('../native')).saveText('kurokawa-tools-device-report.txt', area.value, 'text/plain'); if (p) toast(t('saved')); }
    catch (e) { toast(t('batReportFail', { error: String((e as Error)?.message ?? e) }), 'error'); }
  };
  sh.body.append(h('div', { class: 'bat-rep' },
    h('p', null, t('batReportIntro')), h('p', { class: 'hint' }, t('batReportEnglish')), h('p', { class: 'hint' }, t('batReportLeftOut')),
    area, counts, h('p', { class: 'hint' }, t('batReportEdit')), h('p', { class: 'hint' }, t('batReportSend'))));
  sh.actions.append(copy, save);
  d.batteryReport().then((r) => {
    if (!area.isConnected) return;
    area.value = r.text; counts.textContent = t('batReportCounts', { d: String(r.devices), c: String(r.collections) });
    copy.disabled = false; save.disabled = false;
  }).catch((e) => { if (area.isConnected) { area.value = t('batReportFail', { error: String((e as Error)?.message ?? e) }); } });
}
