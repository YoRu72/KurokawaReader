// «Find duplicate files» (a lazy chunk): the files of a folder (and, when asked, of the folders under it) grouped by size,
// then the ones of one size compared by checksum — never a file whose size nobody else shares. Progress and Cancel; the
// result grouped, each group with the space the copies waste; the user ticks the copies to delete (nothing is ticked at
// first, and one file of every group cannot be ticked: at least one stays), and the delete goes through the page's own
// delete (its question, the recycle bin).
import { h, icon, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits } from '../i18n';
import type { Entry } from './files';
import type { FileHost } from './filesCompare';

export interface Group { size: number; files: Entry[] }
const STAGE = '.kurokawa-extract-';

export async function dupSheet(dir: string, host: FileHost, del: (paths: string[]) => void): Promise<void> {
  let stopped = false; let closed = false; let running = false;
  const sh = openSheet(t('filesDups'), t('close'), { onClose: () => { closed = true; stopped = true; } });
  const sub = h('input', { type: 'checkbox', role: 'switch', checked: false }) as HTMLInputElement;
  const subRow = h('label', { class: 'row switch-row files-dups-sub' }, h('span', null, t('filesDupsSub'), h('small', { class: 'src' }, t('filesDupsSubHint'))), sub);
  const out = h('div', { class: 'files-dups-out' }); const where = h('p', { class: 'hint', dir: 'ltr' }, dir);
  const go = h('button', { type: 'button', class: 'btn primary', onclick: () => void start() }, icon('search'), t('filesDupsStart'));
  const stopB = h('button', { type: 'button', class: 'btn tonal', onclick: () => { stopped = true; } }, t('cancel'));
  sh.body.append(where, subRow, out); sh.actions.append(go);
  const progress = (pct: number, text: string) => { out.replaceChildren(h('div', { class: 'files-job' }, h('div', { class: 'grow' }, h('span', { class: 'files-job-label', dir: 'auto' }, text), h('div', { class: 'files-job-bar' }, h('i', { style: `width:${pct}%` })))), h('div', { class: 'row' }, stopB)); };
  const start = async () => {
    if (running) return; running = true; stopped = false; go.disabled = true; subRow.hidden = true;
    const files: Entry[] = []; let seen = 0; const stack = [dir];
    try {
      while (stack.length && !stopped) {
        const d = stack.pop()!; let es: Entry[] = []; try { es = await host.list(d); } catch { es = []; }
        for (const e of es) { if (e.name.startsWith(STAGE)) continue; if (e.dir) { if (sub.checked) stack.push(e.path); } else if (e.size > 0) files.push(e); }
        seen = files.length; progress(0, t('filesDupsListing', { n: localDigits(seen) }));
      }
      if (stopped) return done([], true);
      const bySize = new Map<number, Entry[]>(); for (const e of files) { const a = bySize.get(e.size); if (a) a.push(e); else bySize.set(e.size, [e]); }
      const cand = [...bySize.values()].filter((a) => a.length > 1); const todo = cand.reduce((s, a) => s + a.length, 0); let doneN = 0;
      const groups: Group[] = [];
      for (const same of cand) {
        const sums = new Map<string, Entry[]>();
        for (const e of same) {
          if (stopped) break; progress(Math.round((doneN / Math.max(1, todo)) * 100), t('filesDupsChecking', { name: e.name, i: localDigits(doneN + 1), n: localDigits(todo) }));
          try { const s = await host.hash(e.path); const a = sums.get(s); if (a) a.push(e); else sums.set(s, [e]); } catch { /* unreadable: not a candidate */ }
          doneN++;
        }
        if (stopped) break;
        for (const a of sums.values()) if (a.length > 1) groups.push({ size: a[0].size, files: a });
      }
      done(groups, stopped);
    } finally { running = false; if (!closed) { go.disabled = false; go.hidden = true; } }
  };
  const done = (groups: Group[], cut: boolean) => {
    if (closed) return; groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
    const wasted = groups.reduce((s, g) => s + g.size * (g.files.length - 1), 0);
    if (!groups.length) { out.replaceChildren(h('p', { class: 'empty small' }, cut ? t('filesCompareStopped') : t('filesDupsNone'))); return; }
    const ticked = new Set<string>(); const delB = h('button', { type: 'button', class: 'btn primary danger', disabled: true, onclick: () => { const ps = [...ticked]; sh.close(); del(ps); } }, icon('trash'), t('delete')) as HTMLButtonElement;
    const head = h('p', { class: 'files-dups-sum' }, t('filesDupsFound', { g: localDigits(groups.length), size: formatBytes(wasted) }), cut ? h('small', { class: 'src' }, t('filesDupsPartial')) : null);
    const paint = () => {
      delB.disabled = !ticked.size; delB.replaceChildren(icon('trash'), ticked.size ? t('filesDupsDelete', { n: localDigits(ticked.size) }) : t('delete'));
      for (const row of out.querySelectorAll<HTMLElement>('.files-dup-file')) {
        const p = row.dataset.path!; const g = groups[+row.dataset.g!]; const on = ticked.has(p); row.classList.toggle('on', on); row.setAttribute('aria-checked', String(on));
        const lastLeft = !on && g.files.filter((f) => !ticked.has(f.path)).length <= 1; row.classList.toggle('locked', lastLeft); row.setAttribute('aria-disabled', String(lastLeft));
      }
    };
    out.replaceChildren(head, ...groups.map((g, gi) => h('section', { class: 'files-dup-group' },
      h('div', { class: 'files-dup-head' }, h('b', null, formatBytes(g.size)), h('small', { class: 'src' }, t('filesDupsGroup', { n: localDigits(g.files.length), size: formatBytes(g.size * (g.files.length - 1)) }))),
      ...g.files.map((f) => h('button', { type: 'button', role: 'checkbox', class: 'files-dup-file', 'data-path': f.path, 'data-g': String(gi), 'aria-checked': 'false', onclick: (ev: Event) => {
        const row = ev.currentTarget as HTMLElement; if (row.classList.contains('locked')) return;
        if (ticked.has(f.path)) ticked.delete(f.path); else ticked.add(f.path); paint(); } },
        h('span', { class: 'files-dup-tick' }, icon('check')), h('span', { class: 'grow files-main' }, h('span', { dir: 'auto' }, f.name), h('small', { class: 'src', dir: 'ltr' }, f.path.replace(/\/[^/]*$/, ''))))))));
    sh.actions.replaceChildren(delB); paint();
  };
}
