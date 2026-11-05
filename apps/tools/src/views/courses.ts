// The Courses add-on: a course the reader is signed in to (Udemy and the other platforms yt-dlp reads with the
// right cookies), its outline read and shown by section, the sections and lectures ticked, and the ticked ones
// downloaded numbered in order — continuously across the course, or anew in each section — into one folder a
// course (a folder a section inside). Signing in happens once in the app's browser; its cookies become a jar the
// course uses. Lectures DRM protects fail with a plain word and are counted; nothing goes around protection.
import { h, icon, iconButton, toast, openSheet, pickButton } from '../ui/dom';
import { t, localDigits, countFiles } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { getEngine } from '../engine';
import { nativePlatform } from '../native';
import { navigate, type Route } from '../router';
import { pageInfo, videoEnabled, type PlaylistInfo } from '../video/ytdlp';

interface Course { url: string; title: string; at: number; jar?: string; dir?: string }
const KEY = 'kt.courses';
const courses = (): Course[] => { try { const a = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Course[]; return Array.isArray(a) ? a : []; } catch { return []; } };
const saveCourses = (a: Course[]) => { try { localStorage.setItem(KEY, JSON.stringify(a.slice(0, 40))); } catch { /* none */ } };
const safeName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
const dur = (s?: number) => { if (!s) return ''; s = Math.round(s); const m = Math.floor(s / 60), sec = s % 60; return `${localDigits(m)}:${String(sec).padStart(2, '0')}`; };

export function coursesView(route: Extract<Route, { name: 'courses' }>): HTMLElement & { dispose?: () => void } {
  const body = h('div', { class: 'body courses-body' });
  const root = h('div', { class: 'view courses-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => navigate('/videos', true)), h('div', { class: 'title' }, h('span', null, t('coursesTitle'))), h('div', { class: 'topbar-actions' })), body) as HTMLElement & { dispose?: () => void };
  const s = getSettings();
  const url = h('input', { type: 'url', dir: 'ltr', value: route.url ?? '', placeholder: 'https://www.udemy.com/course/…', autocapitalize: 'off', spellcheck: 'false' }) as HTMLInputElement;
  let jar = ''; const jarRow = h('div');
  const refreshJar = async () => { let host = ''; try { host = new URL(url.value.trim()).host; } catch { host = ''; } const { jarPicker } = await import('../downloads/cookies'); const el = host ? await jarPicker(host, (id) => { jar = id; }) : null; jarRow.replaceChildren(...(el ? [el] : [])); if (el) { const fit = await (await import('../downloads/cookies')).jars(host); jar = fit[0]?.id ?? ''; } };
  const outline = h('div', { class: 'courses-outline' });
  let info: PlaylistInfo | null = null; const picked = new Set<string>();
  const read = async () => {
    const u = url.value.trim(); if (!/^https?:\/\//i.test(u)) { toast(t('invalidLink'), 'error'); return; }
    if (!videoEnabled()) { const { needAddon } = await import('../addons/need'); if (!(await needAddon('video', t('addonWhyVideo'), { start: true }))) return; }
    outline.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'spinner' }), ` ${t('coursesReading')}`));
    try {
      const got = await pageInfo(u, true, jar ? { cookieJar: jar } : {});
      if (got.kind !== 'playlist') { outline.replaceChildren(h('p', { class: 'empty small' }, t('coursesNotACourse'))); return; }
      info = got; picked.clear(); for (const e of got.entries) picked.add(e.url);
      const list = courses().filter((c) => c.url !== u); list.unshift({ url: u, title: got.title || u, at: Date.now(), jar: jar || undefined }); saveCourses(list);
      drawOutline();
    } catch (e) { const m = String((e as Error).message ?? e); outline.replaceChildren(h('p', { class: 'empty small' }, /login|sign|403|401|cookies|member/i.test(m) ? t('coursesNeedsSignIn') : m), ...(nativePlatform() === 'android' ? [h('button', { type: 'button', class: 'btn tonal small', onclick: () => void import('../browser').then((b) => b.openBrowser(u)) }, icon('globe'), t('coursesSignIn'))] : [])); }
  };
  const drawOutline = () => {
    if (!info) return; const i = info;
    // Sections: by the entries' chapters when the site tells, else one section.
    const sections = new Map<string, typeof i.entries>(); for (const e of i.entries) { const k = e.chapter ?? ''; if (!sections.has(k)) sections.set(k, []); sections.get(k)!.push(e); }
    const head = h('div', { class: 'courses-head' }, h('b', { dir: 'auto' }, i.title), h('small', { class: 'src' }, `${countFiles(i.entries.length)} · ${localDigits(sections.size)} ${t('coursesSections')}`));
    const rows: HTMLElement[] = []; let n = 0;
    for (const [sec, es] of sections) {
      const secBox = h('input', { type: 'checkbox', checked: es.every((e) => picked.has(e.url)), onchange: (ev: Event) => { const on = (ev.target as HTMLInputElement).checked; for (const e of es) { if (on) picked.add(e.url); else picked.delete(e.url); } drawOutline(); } });
      if (sec || sections.size > 1) rows.push(h('label', { class: 'check-row courses-section' }, secBox, h('b', { dir: 'auto' }, sec || t('coursesLectures'))));
      for (const e of es) { n++; const cb = h('input', { type: 'checkbox', checked: picked.has(e.url), onchange: (ev: Event) => { if ((ev.target as HTMLInputElement).checked) picked.add(e.url); else picked.delete(e.url); sync(); } }); rows.push(h('label', { class: 'check-row file-row courses-lecture' }, cb, h('span', { class: 'grow' }, h('span', { dir: 'auto' }, `${localDigits(String(n).padStart(2, '0'))} · ${e.title ?? e.url}`), e.duration ? h('small', { class: 'src' }, dur(e.duration)) : null))); }
    }
    const go = h('button', { type: 'button', class: 'btn primary', onclick: () => void download() }, icon('download'), t('coursesDownloadN', { n: countFiles(picked.size) }));
    const sync = () => { go.disabled = !picked.size; go.replaceChildren(icon('download'), t('coursesDownloadN', { n: countFiles(picked.size) })); };
    outline.replaceChildren(head, h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn text small', onclick: () => { for (const e of i.entries) picked.add(e.url); drawOutline(); } }, t('grabSelectAll', { n: localDigits(i.entries.length) })), h('button', { type: 'button', class: 'btn text small', onclick: () => { picked.clear(); drawOutline(); } }, t('grabSelectNone'))), ...rows, h('div', { class: 'row-actions' }, go)); sync();
  };
  const download = async () => {
    if (!info) return; const i = info; const eng = getEngine(); const { preferredFormat } = await import('./addVideo'); const st = getSettings();
    const base = `${st.downloadDir || ''}`.replace(/\/$/, ''); const courseDir = `${base}/${safeName(i.title || 'Course')}`;
    const continuous = st.coursesContinuous !== false; let n = 0, secNo = 0, inSec = 0; let lastSec: string | undefined; let added = 0;
    for (const e of i.entries) {
      if (e.chapter !== lastSec) { lastSec = e.chapter; secNo++; inSec = 0; }
      n++; inSec++;
      if (!picked.has(e.url)) continue;
      const dir = e.chapter ? `${courseDir}/${String(secNo).padStart(2, '0')} - ${safeName(e.chapter)}` : courseDir;
      const pf = preferredFormat();
      try { await eng.add({ source: { url: e.url }, dir, video: { ...pf, container: pf.audioOnly ? undefined : st.videoContainer, embedThumb: st.videoEmbedThumb, chapters: true, title: e.title, playlistIndex: continuous ? n : inSec, cookieJar: jar || undefined, subs: st.subLangs.length ? st.subLangs.join(',') : undefined } }); added++; } catch { /* the next */ }
    }
    toast(t('coursesAdded', { n: countFiles(added) })); navigate('/');
  };
  const recent = h('div', { class: 'dest-list' }, ...courses().map((c) => h('button', { type: 'button', class: 'dest-row', onclick: () => { url.value = c.url; jar = c.jar ?? ''; void refreshJar().then(read); } }, icon('books'), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'auto' }, c.title), h('small', { class: 'src', dir: 'ltr' }, c.url)))));
  body.append(h('p', { class: 'hint' }, t('coursesHint')),
    h('label', { class: 'field' }, h('span', null, t('coursesUrl')), url), jarRow,
    h('div', { class: 'row-actions' }, ...(nativePlatform() === 'android' ? [h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('../downloads/cookies').then((m) => m.cookiesSheet()) }, icon('key'), t('cookiesTitle'))] : []), h('button', { type: 'button', class: 'btn primary', onclick: () => void read() }, icon('search'), t('coursesRead'))),
    h('div', { class: 'row' }, h('span', null, t('coursesNumbering')), pickButton(t('coursesNumbering'), [['continuous', t('coursesNumberingContinuous')], ['section', t('coursesNumberingSection')]], s.coursesContinuous === false ? 'section' : 'continuous', (v) => updateSettings({ coursesContinuous: v === 'continuous' }), t('close'))),
    outline, ...(courses().length ? [h('p', { class: 'files-sec' }, t('coursesRecent')), recent] : []));
  url.addEventListener('change', () => void refreshJar());
  if (route.url) { void refreshJar().then(read); } else void refreshJar();
  return root;
}
