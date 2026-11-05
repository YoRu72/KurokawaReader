// Inside an archive (a .zip, .cbz, .7z, .rar or tar the app downloaded or you picked), as a file manager shows it:
// its folders walked into and out of, a search across all it holds, sorted by name or size; a file opened by
// itself (taken out to the app's cache, then shown by the in-app player or the app that opens its kind), or the
// ticked files and folders taken out beside the archive — or everything, with the extraction sheet's choices.
import { h, icon, iconButton, toast, openSheet, pickSheet } from '../ui/dom';
import { t, formatBytes, localDigits, countFiles } from '../i18n';
import { ktPlugin } from '../native';
import { extractArchiveJob, entryUrl, entryThumb, nameCharsets, nameCharset, setNameCharset, parentOf, baseName, stem, type ArchiveEntry, type ArchiveInfo, listArchiveAuto, savePassword, rememberPasswords, setRememberPasswords } from '../archives';
import { kindOfFile } from './taskFiles';

const MIME: Record<string, string> = { video: 'video/*', audio: 'audio/*', image: 'image/*', ebook: 'application/epub+zip', doc: 'application/pdf' };
const mimeOf = (p: string): string => { const k = kindOfFile(p); if (/\.txt$|\.nfo$|\.md$|\.srt$|\.ass$|\.vtt$/i.test(p)) return 'text/plain'; if (/\.pdf$/i.test(p)) return 'application/pdf'; if (/\.apk$/i.test(p)) return 'application/vnd.android.package-archive'; return MIME[k] ?? '*/*'; };
const ICON: Record<string, string> = { video: 'film', audio: 'music', ebook: 'books', image: 'images', sub: 'subtitles', archive: 'archive', doc: 'file', other: 'file' };

interface Dir { name: string; path: string; dirs: Map<string, Dir>; files: ArchiveEntry[] }
function treeOf(entries: ArchiveEntry[]): Dir {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] };
  const dirAt = (parts: string[]): Dir => { let at = root; for (const p of parts) { let d = at.dirs.get(p); if (!d) { d = { name: p, path: at.path ? `${at.path}/${p}` : p, dirs: new Map(), files: [] }; at.dirs.set(p, d); } at = d; } return at; };
  for (const e of entries) {
    const clean = e.path.replace(/^\.\//, '').replace(/\/+$/, ''); if (!clean) continue; const parts = clean.split('/');
    if (e.dir) dirAt(parts); else { const name = parts.pop()!; dirAt(parts).files.push({ ...e, path: [...parts, name].join('/') }); }
  }
  return root;
}
const filesIn = (d: Dir): ArchiveEntry[] => [...d.files, ...[...d.dirs.values()].flatMap(filesIn)];

/** The archive at `path`, opened to look through. */
export async function browseArchive(path: string): Promise<void> {
  const sh = openSheet(baseName(path), t('close')); sh.el.classList.add('archive-browse');
  sh.body.append(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  let info: ArchiveInfo; let password = '';
  const load = async () => {
    try { const r = await listArchiveAuto(path, password || undefined); info = r.info; password = r.password ?? ''; if (password) savePassword(password); start(); }
    catch (e) {
      const m = String((e as Error).message ?? e);
      if (/password/i.test(m)) { const pw = h('input', { type: 'password', dir: 'ltr', autocomplete: 'off' }) as HTMLInputElement; sh.body.replaceChildren(h('p', { class: 'hint' }, /wrong/i.test(m) ? t('wrongPassword') : t('passwordNeeded')), h('label', { class: 'field' }, h('span', null, t('password')), pw), h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: rememberPasswords(), onchange: (e: Event) => setRememberPasswords((e.target as HTMLInputElement).checked) }), h('span', null, t('archiveRememberPw')))); sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn primary', onclick: () => { password = pw.value; void load(); } }, t('open'))); return; }
      sh.body.replaceChildren(h('p', { class: 'empty small' }, m === 'notArchive' ? t('notAnArchive') : m));
    }
  };
  const start = () => {
    const root = treeOf(info.entries); let at = ''; let query = ''; let sort: 'name' | 'size' = 'name'; const picked = new Set<string>();
    const thumbs = (() => { const want = new WeakMap<Element, string>(); const io = new IntersectionObserver((es) => { for (const x of es) { if (!x.isIntersecting) continue; io.unobserve(x.target); const p = want.get(x.target); if (!p) continue; void entryThumb(path, p, 96, password || undefined).then((u) => { if (u && x.target.isConnected) x.target.replaceChildren(h('img', { src: u, alt: '', class: 'kt-file-thumb' })); }); } }, { root: null, rootMargin: '200px' }); return { observe: (el: Element, p: string) => { want.set(el, p); io.observe(el); } }; })();
    const search = h('input', { type: 'search', class: 'kt-files-search', placeholder: t('archiveSearch'), oninput: (e: Event) => { query = (e.target as HTMLInputElement).value.trim().toLowerCase(); draw(); } }) as HTMLInputElement;
    const crumbs = h('div', { class: 'kt-files-crumbs' }); const list = h('div', { class: 'file-rows kt-files-list' }); const foot = h('p', { class: 'models-total' });
    const charsetBtn = h('button', { type: 'button', class: 'chip small', title: t('archiveNames'), onclick: () => pickSheet(t('archiveNames'), nameCharsets.map(([v, l]): [string, string, string] => [v, l, 'text']), nameCharset(), (v) => { setNameCharset(v); void load(); }, t('close')) }, icon('text'), nameCharsets.find((c) => c[0] === nameCharset())?.[1] ?? 'Auto');
    const sortBtn = h('button', { type: 'button', class: 'chip small', onclick: () => { sort = sort === 'name' ? 'size' : 'name'; draw(); } });
    const files = info.entries.filter((e) => !e.dir);
    sh.body.replaceChildren(h('p', { class: 'src' }, [info.format.toUpperCase(), countFiles(files.length), info.total > 0 ? formatBytes(info.total) : '', info.encrypted ? t('encrypted') : ''].filter(Boolean).join(' · ')),
      h('div', { class: 'kt-files-tools' }, search, h('div', { class: 'chip-row' }, sortBtn, ...(info.format === 'zip' ? [charsetBtn] : []))), crumbs, list, foot);
    const takeOut = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: () => void extractPicked() }, icon('archive'), h('span', null, t('extractChosen'))) as HTMLButtonElement;
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); void import('./extract').then((m) => m.extractSheet(path)); } }, icon('archive'), t('extractAll')), takeOut);
    const toggle = (key: string, on: boolean) => { if (on) picked.add(key); else picked.delete(key); draw(); };
    const box = (key: string, label: string) => h('input', { type: 'checkbox', class: 'kt-file-box', checked: picked.has(key), 'aria-label': label, onclick: (e: Event) => e.stopPropagation(), onchange: (e: Event) => toggle(key, (e.target as HTMLInputElement).checked) });
    const fileRow = (e: ArchiveEntry, showDir: boolean) => {
      const name = e.path.split('/').pop() ?? e.path; const dir = showDir ? e.path.slice(0, e.path.length - name.length).replace(/\/$/, '') : '';
      const ic = h('span', { class: 'kt-file-ic' }, icon(ICON[kindOfFile(e.path)] ?? 'file'));
      if (kindOfFile(e.path) === 'image' && e.size > 0 && e.size < 24 << 20) thumbs.observe(ic, e.path);
      return h('div', { class: 'file-row kt-file', role: 'button', tabindex: '0', onclick: () => void openOne(e) }, ic,
        h('span', { class: 'grow kt-file-main' }, h('span', { class: 'kt-file-name', dir: 'auto' }, name), h('small', { class: 'src', dir: 'auto' }, [e.size >= 0 ? formatBytes(e.size) : '', e.compressed && e.size > 0 ? t('packedTo', { pct: localDigits(Math.round((e.compressed / e.size) * 100)) }) : '', dir].filter(Boolean).join(' · '))),
        iconButton('external', t('open'), () => void openOne(e)), box(e.path, name));
    };
    const dirRow = (d: Dir) => {
      const fs = filesIn(d); const size = fs.reduce((n, f) => n + Math.max(0, f.size), 0);
      return h('div', { class: 'file-row kt-file kt-folder', role: 'button', tabindex: '0', onclick: () => { at = d.path; draw(); } },
        h('span', { class: 'kt-file-ic' }, icon('folder')), h('span', { class: 'grow kt-file-main' }, h('span', { class: 'kt-file-name', dir: 'auto' }, d.name), h('small', { class: 'src' }, `${countFiles(fs.length)} · ${formatBytes(size)}`)),
        box(`${d.path}/`, d.name));
    };
    function draw() {
      sortBtn.replaceChildren(icon('sort'), t(sort === 'name' ? 'sortName' : 'sortSize'));
      let here = root; if (at) for (const p of at.split('/')) { const d = here.dirs.get(p); if (!d) { at = ''; here = root; break; } here = d; }
      const by = <T extends { name?: string; path: string; size?: number }>(a: T, b: T, sa: number, sb: number) => (sort === 'size' ? sb - sa : 0) || (a.name ?? a.path).localeCompare(b.name ?? b.path, undefined, { numeric: true });
      crumbs.hidden = !!query || !root.dirs.size;
      if (!crumbs.hidden) { const parts = at ? at.split('/') : []; crumbs.replaceChildren(h('button', { type: 'button', class: 'chip small', onclick: () => { at = ''; draw(); } }, icon('archive'), stem(baseName(path))), ...parts.map((p, i) => [h('span', { class: 'kt-crumb-sep' }, '›'), h('button', { type: 'button', class: 'chip small', onclick: () => { at = parts.slice(0, i + 1).join('/'); draw(); } }, p)]).flat()); }
      const rows: HTMLElement[] = [];
      if (query) rows.push(...files.filter((e) => e.path.toLowerCase().includes(query)).sort((a, b) => by(a, b, a.size, b.size)).slice(0, 500).map((e) => fileRow(e, true)));
      else {
        if (at) rows.push(h('div', { class: 'file-row kt-file kt-folder up', role: 'button', tabindex: '0', onclick: () => { at = at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : ''; draw(); } }, h('span', { class: 'kt-file-ic' }, icon('up')), h('span', { class: 'grow kt-file-name' }, '..')));
        const size = (d: Dir) => filesIn(d).reduce((n, f) => n + Math.max(0, f.size), 0);
        rows.push(...[...here.dirs.values()].sort((a, b) => by(a, b, size(a), size(b))).map(dirRow));
        rows.push(...[...here.files].sort((a, b) => by(a, b, a.size, b.size)).slice(0, 1000).map((e) => fileRow(e, false)));
      }
      if (!rows.length) rows.push(h('p', { class: 'empty small' }, t('filesNoMatch')));
      list.replaceChildren(...rows);
      const n = files.filter((e) => [...picked].some((k) => e.path === k || (k.endsWith('/') && e.path.startsWith(k)))).length;
      takeOut.disabled = !n; (takeOut.lastChild as HTMLElement).textContent = n ? t('extractChosenN', { n: localDigits(n) }) : t('extractChosen');
      foot.textContent = n ? t('selectedFiles', { n: localDigits(n), total: localDigits(files.length) }) : '';
    }
    // Pictures, video and audio play straight from the archive (nothing written); the rest is taken out to the app's cache and opened.
    async function openOne(e: ArchiveEntry) {
      const name = e.path.split('/').pop() ?? e.path; const k0 = kindOfFile(e.path);
      if (k0 === 'image') {
        const pics = files.filter((x) => kindOfFile(x.path) === 'image' && (query ? x.path.toLowerCase().includes(query) : x.path.slice(0, x.path.lastIndexOf('/') + 1).replace(/\/$/, '') === at));
        const u0 = await entryUrl(path, e.path, password || undefined);
        if (u0) { const m = await import('./filesMore'); await m.imageViewer(pics.map((x) => ({ name: x.path.split('/').pop() ?? x.path, path: x.path, dir: false, size: x.size, mtime: 0 })), Math.max(0, pics.indexOf(e)), (p) => entryUrl(path, p, password || undefined), () => undefined, { readOnly: true }); return; }
      }
      if (k0 === 'video' || k0 === 'audio') { const u = await entryUrl(path, e.path, password || undefined); if (u) { const { openPlayer } = await import('./player'); await openPlayer(u, name); return; } }
      const busy = toast(t('archiveOpening', { name }));
      try {
        const job = extractArchiveJob({ path, dest: 'cache:', only: [e.path], replace: 'replace', password: password || undefined });
        const r = await job.done; void busy; const local = `${r.dest.replace(/[\\/]$/, '')}/${e.path}`; const k = kindOfFile(e.path);
        if (k === 'video' || k === 'audio') { const { openPlayer } = await import('./player'); const { localFileUrl } = await import('../player/files'); const u = await localFileUrl(local); if (u) { await openPlayer(u, name, { localPath: local }); return; } }
        if (/\.(apk|apks|xapk|apkm)$/i.test(name)) { const m = await import('./apk'); if (m.canInstallApps()) { await m.installSheet(local); return; } }
        if (/\.ipa$/i.test(name)) { const { localFileUrl } = await import('../player/files'); const u = await localFileUrl(local); const file = u ? await (await fetch(u)).blob() : undefined; await (await import('./ipa')).ipaSheet({ file, name }); return; }
        if (k === 'archive') { void browseArchive(local); return; }
        const p = ktPlugin() as unknown as { openWith?(o: { path: string; mime: string; title: string }): Promise<void> } | null;
        if (p?.openWith) { await p.openWith({ path: local, mime: mimeOf(name), title: name }); return; }
        const d = window.kurokawaTools as { openPath?(p: string): Promise<void> } | undefined; if (d?.openPath) { await d.openPath(local); return; }
        toast(t('archiveCantOpen'), 'error');
      } catch (er) { toast(String((er as Error).message ?? er), 'error', 5000); }
    }
    // The ticked ones, beside the archive in a folder named after it (their folders kept).
    async function extractPicked() {
      const dest = `${parentOf(path)}/${stem(baseName(path))}`; takeOut.disabled = true;
      const bar = h('div', { class: 'progress' }, h('span', { style: 'width:2%' })); foot.replaceChildren(bar);
      try {
        const job = extractArchiveJob({ path, dest, only: [...picked], replace: 'both', password: password || undefined }, (p) => { (bar.firstChild as HTMLElement).style.width = `${Math.max(2, (p.done / Math.max(1, p.total)) * 100)}%`; });
        const r = await job.done; toast(t('extractedTo', { n: localDigits(r.files), dest: r.dest })); picked.clear(); draw();
      } catch (er) { toast(String((er as Error).message ?? er), 'error', 5000); draw(); }
    }
    draw();
  };
  await load();
}
