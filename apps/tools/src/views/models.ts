// The model window (Prism's): a Hugging Face model by its name, a link or a search; its files with their sizes,
// the ones worth downloading already ticked (a GGUF model's versions to pick from, smallest to largest), the
// folder they go to (<models folder>/<owner>/<name>, as LM Studio and llama.cpp expect), and Download — each file a
// multi-connection download, small files first, checked against its SHA-256 when it is done.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t, formatBytes, localDigits, countFiles } from '../i18n';
import { navigate } from '../router';
import { getEngine } from '../engine';
import { getSettings } from '../settings';
import { ktPlugin, openExternal } from '../native';
import * as HF from '../hf/hf';

const fmtCount = (n?: number) => (n === undefined ? '' : n >= 1e6 ? `${localDigits((n / 1e6).toFixed(1))}M` : n >= 1e3 ? `${localDigits((n / 1e3).toFixed(1))}k` : localDigits(n));
async function modelsRoot(): Promise<string> {
  const p = HF.hfPrefs(); if (p.folder) return p.folder.replace(/[\\/]+$/, '');
  let base = getSettings().downloadDir;
  if (!base || base.startsWith('content:')) { try { const d = window.kurokawaTools as unknown as { defaultDir?(): Promise<string> } | undefined; base = d?.defaultDir ? await d.defaultDir() : (await ktPlugin()?.defaultDir())?.dir ?? ''; } catch { base = ''; } }
  return base ? `${base.replace(/[\\/]+$/, '')}/Models` : '';
}

export function modelsSheet(initial = ''): void {
  const sh = openSheet(t('hfTitle'), t('close')); sh.el.classList.add('models-sheet');
  const input = h('input', { type: 'search', class: 'search-input', placeholder: t('hfSearchPh'), value: initial, dir: 'auto', enterkeyhint: 'search' }) as HTMLInputElement;
  const go = h('button', { type: 'button', class: 'btn tonal small' }, icon('search'), t('search'));
  const out = h('div', { class: 'models-out' });
  sh.body.append(h('div', { class: 'row models-q' }, input, go), out);
  const busy = () => out.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' })));
  const problem = (e: unknown) => {
    const code = e instanceof HF.HfProblem ? e.code : 'net'; const msg = code === 'net' ? String((e as Error).message ?? e) : t(`hf_${code}` as 'hf_notFound');
    out.replaceChildren(h('div', { class: 'empty small' }, h('p', null, msg), ...(code === 'needsToken' || code === 'badToken' ? [h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); navigate('/settings/models'); } }, icon('settings'), t('hfTokenSet'))] : [])));
  };
  const find = async () => {
    const q = input.value.trim(); const link = q ? HF.parse(q) : null;
    if (link?.kind === 'file') { sh.close(); void import('./add').then((m) => m.addSheet(link.url)); return; }
    if (link?.kind === 'repo') { void openRepo(link.repo); return; }
    busy();
    try { const hits = await HF.search(q); out.replaceChildren(h('p', { class: 'hint' }, q ? t('hfResults') : t('hfTrending')), ...(hits.length ? hits.map(hitRow) : [h('p', { class: 'empty small' }, t('noResults'))])); }
    catch (e) { problem(e); }
  };
  const hitRow = (x: HF.Hit) => h('button', { type: 'button', class: 'result-row', onclick: () => void openRepo({ id: x.id, kind: 'model' }) },
    h('span', { class: 'task-kind' }, icon(x.gated ? 'lock' : 'puzzle')),
    h('span', { class: 'grow' }, h('span', { class: 'result-title', dir: 'ltr' }, x.id), h('small', { class: 'src' }, [x.task, x.downloads !== undefined ? `↓ ${fmtCount(x.downloads)}` : '', x.likes ? `♥ ${fmtCount(x.likes)}` : '', x.gated ? t('hfGated') : ''].filter(Boolean).join(' · '))));
  const openRepo = async (ref: { id: string; kind: HF.RepoKind; revision?: string; path?: string }) => {
    busy(); let repo: HF.Repo;
    try { repo = await HF.readRepo(ref); } catch (e) { problem(e); return; }
    const chosen = new Set(repo.suggestion.files); let variant = repo.suggestion.variant;
    const root = await modelsRoot(); const folder = root ? `${root}/${repo.kind === 'dataset' ? 'datasets/' : ''}${repo.id}` : '';
    const list = h('div', { class: 'file-rows models-files' }); const total = h('p', { class: 'models-total' }); const varRow = h('div', { class: 'chip-row wrap' });
    const draw = () => {
      varRow.replaceChildren(...repo.suggestion.variants.map((v) => h('button', { type: 'button', class: 'chip small' + (variant === v.label ? ' on' : ''), onclick: () => { for (const vv of repo.suggestion.variants) for (const f of vv.files) chosen.delete(f); for (const f of v.files) chosen.add(f); variant = v.label; draw(); } }, h('span', { dir: 'ltr' }, v.label), h('small', { class: 'src' }, ` ${formatBytes(v.size)}`))));
      list.replaceChildren(...HF.downloadOrder(repo.files.filter((f) => f.path !== '.gitattributes')).map((f) => h('label', { class: 'file-row' + (chosen.has(f.path) ? ' on' : '') },
        h('input', { type: 'checkbox', checked: chosen.has(f.path), onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosen.add(f.path); else chosen.delete(f.path); draw(); } }),
        h('span', { class: 'grow', dir: 'ltr' }, f.path), f.sha256 ? h('small', { class: 'sha-mark', title: 'SHA-256' }, icon('check')) : null, h('small', { class: 'src' }, formatBytes(f.size)))));
      const pick = repo.files.filter((f) => chosen.has(f.path)); const size = pick.reduce((s, f) => s + f.size, 0);
      total.textContent = t('hfTotal', { files: countFiles(pick.length), size: formatBytes(size) }); dl.disabled = !pick.length || !folder;
    };
    const dl = h('button', { type: 'button', class: 'btn primary' }, icon('download'), t('download')) as HTMLButtonElement;
    dl.addEventListener('click', async () => {
      dl.disabled = true; const tok = HF.hfPrefs().token.trim(); const eng = getEngine(); let n = 0;
      for (const f of HF.downloadOrder(repo.files.filter((x) => chosen.has(x.path)))) {
        const rel = HF.safePath(f.path); if (!rel) continue;
        const sub = rel.includes('/') ? `/${rel.slice(0, rel.lastIndexOf('/'))}` : '';
        try { await eng.add({ source: { url: HF.fileUrl(repo, rel), ...(tok && (repo.gated || repo.private) ? { headers: { Authorization: `Bearer ${tok}` } } : {}) }, dir: folder + sub, name: rel.split('/').pop(), connections: 8, meta: { hf: repo.id, sha256: f.sha256, title: repo.id } }); n++; }
        catch (e) { toast(t('taskFailed', { error: String((e as Error).message ?? e) }), 'error', 5000); }
      }
      if (n) { toast(t('hfAdded', { n: countFiles(n), id: repo.id })); sh.close(); navigate('/'); } else dl.disabled = false;
    });
    out.replaceChildren(
      h('div', { class: 'models-head' }, h('b', { dir: 'ltr' }, repo.id), h('small', { class: 'src' }, [repo.task, repo.downloads !== undefined ? `↓ ${fmtCount(repo.downloads)}` : '', repo.likes ? `♥ ${fmtCount(repo.likes)}` : '', `@ ${repo.sha.slice(0, 7)}`].filter(Boolean).join(' · ')),
        h('div', { class: 'kt-badges' }, repo.gated ? h('span', { class: 'kt-badge' }, icon('lock'), t('hfGated')) : null, repo.private ? h('span', { class: 'kt-badge' }, icon('lock'), t('hfPrivate')) : null,
          h('button', { type: 'button', class: 'btn text small', onclick: () => void openExternal(`https://huggingface.co/${repo.kind === 'dataset' ? 'datasets/' : ''}${repo.id}`) }, icon('external'), t('hfPage')))),
      ...(repo.suggestion.variants.length ? [h('span', { class: 'label' }, t('hfVersion')), varRow] : []),
      h('p', { class: 'hint' }, t('hfSuggested')), list, total,
      h('div', { class: 'row models-dest' }, icon('folder'), h('span', { class: 'src grow', dir: 'ltr' }, folder || t('hfNoFolder'))));
    sh.actions.replaceChildren(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.actions.replaceChildren(); void find(); } }, t('back')), dl);
    draw();
  };
  go.addEventListener('click', () => void find()); input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void find(); });
  void find();
}
