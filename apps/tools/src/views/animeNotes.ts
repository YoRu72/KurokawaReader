// A show's own cover and the user's notes and reviews (loaded the first time a show's page is opened):
// the cover chooser (a picture from the device or an address, or back to the original); the note editor (an
// episode's note or the show's, with a score), the review editor (AniList's rules shown before it is written); the
// «what will be public» sheet before anything is sent — nothing leaves the device without its Send pressed for that
// text —; the notes card on the show's page; and the MyAnimeList account (its own client ID, as MAL gives apps none).
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { t, localDigits, formatBytes } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import * as al from '../anilist';
import type { Anime } from '../anilist';
import * as N from '../anime/notes';
import * as C from '../anime/covers';
import { titleOf } from './anime';

/* ---------- the cover ---------- */
const coverFault = (e: unknown): string => {
  const f = e instanceof C.CoverError ? e : null;
  if (!f) return String((e as Error)?.message ?? e);
  return f.fault === 'badUrl' ? t('coverBadUrl') : f.fault === 'notImage' ? t('coverNotImage') : f.fault === 'tooLarge' ? t('coverTooLarge', { size: formatBytes(C.MAX_IN) }) : f.fault === 'decode' ? t('coverDecode') : f.status ? t('coverHttp', { s: f.status }) : t('coverUnreachable');
};
/** The cover chooser: a picture from the device (the system's picker on the phone, the file dialog on the computer),
 *  a picture's address, or back to the original. */
export function coverSheet(a: Anime, changed: () => void): void {
  const sh = openSheet(t('coverTitle'), t('close')); sh.el.classList.add('cover-sheet');
  const pic = h('span', { class: 'anime-cover cover-preview', style: a.color ? { '--cover-color': a.color } : undefined });
  const msg = h('p', { class: 'cover-msg', role: 'status' });
  const about = h('small', { class: 'src cover-about', dir: 'auto' });
  const reset = h('button', { type: 'button', class: 'btn tonal small cover-reset', onclick: async () => { await C.resetCover(a.id); paint(); say(t('coverReset')); changed(); } }, icon('undo'), t('coverOriginal')) as HTMLButtonElement;
  const paint = () => {
    const src = C.coverOf(a); pic.replaceChildren(src ? h('img', { src, alt: '' }) : icon('film'));
    const info = C.coverIndex()[a.id]; reset.hidden = !info;
    about.textContent = info ? `${info.from === 'url' && info.url ? t('coverFromUrl', { host: hostOf(info.url) }) : t('coverFromFile')} · ${localDigits(info.w)}×${localDigits(info.h)} · ${formatBytes(info.bytes)}` : t('coverIsOriginal');
  };
  const say = (text: string, bad = false) => { msg.textContent = text; msg.classList.toggle('bad', bad); };
  const busy = (on: boolean) => sh.el.querySelectorAll<HTMLButtonElement>('.cover-actions button, .cover-url button').forEach((b) => { b.disabled = on; });
  const done = async (p: Promise<unknown>) => { busy(true); say(t('coverWorking')); try { await p; paint(); say(t('coverSet')); changed(); } catch (e) { say(coverFault(e), true); } finally { busy(false); } };
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true, class: 'cover-file', onchange: () => { const f = file.files?.[0]; file.value = ''; if (f) void done(C.setCoverFromFile(a.id, f)); } }) as HTMLInputElement;
  const urlIn = h('input', { type: 'url', inputmode: 'url', dir: 'ltr', class: 'grow cover-url-in', placeholder: 'https://…/cover.jpg', enterkeyhint: 'done' }) as HTMLInputElement;
  const useUrl = () => { if (urlIn.value.trim()) void done(C.setCoverFromUrl(a.id, urlIn.value)); };
  urlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useUrl(); } });
  sh.body.append(
    h('div', { class: 'cover-head' }, pic, h('div', { class: 'grow' }, h('b', { dir: 'auto' }, titleOf(a)), h('p', { class: 'hint' }, t('coverHint')), about)),
    h('div', { class: 'row-actions cover-actions' }, h('button', { type: 'button', class: 'btn primary small cover-pick', onclick: () => file.click() }, icon('images'), t('coverChoose')), reset),
    h('label', { class: 'field' }, h('span', { class: 'label' }, t('coverAddress')), h('div', { class: 'cover-url' }, urlIn, h('button', { type: 'button', class: 'btn tonal small cover-use', onclick: useUrl }, icon('link'), t('coverUse')))),
    msg, file);
  paint();
}
const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return u; } };

/* ---------- notes ---------- */
const labelOf = (n: N.ShowNote): string => (n.review ? t('reviewLabel') : n.ep ? t('episodeN', { n: n.ep }) : t('noteWholeShow'));
/** The text an activity carries — exactly what the «before sending» sheet shows. */
export function activityText(a: Anime, n: N.ShowNote): string {
  return `${titleOf(a)} — ${n.ep ? t('episodeN', { n: n.ep }) : t('noteWholeShow')}\n\n${n.text.trim()}${n.score ? `\n\n★ ${localDigits(n.score)}/${localDigits(10)}` : ''}`;
}
function askSheet(text: string, buttons: [string, string, () => void][]): void {
  const sh = openSheet(text, t('close'), { stack: true });
  sh.actions.append(...buttons.map(([label, cls, run]) => h('button', { type: 'button', class: `btn ${cls}`, onclick: () => { sh.close(); run(); } }, label)));
}
/** Deleting a note: here only, or here and where it was sent (its activity or review deleted, its line taken out). */
export function deleteNoteAsk(a: Anime, n: N.ShowNote, changed: () => void): void {
  const gone = async (remote: boolean) => {
    if (remote) {
      try { if (n.al) await N.unsendAniList(n); if (n.mal && a.idMal) await N.unsendMal(n, a.idMal); }
      catch (e) { toast(t('noteRemoteDeleteFailed', { e: String((e as Error).message ?? e) }), 'error', 6000); return; }
    }
    await N.deleteNote(n.show, n.id); toast(t('noteDeleted')); changed();
  };
  if (n.al || n.mal) askSheet(t('noteDeleteSentAsk'), [[t('cancel'), 'tonal', () => undefined], [t('noteDeleteHereOnly'), 'tonal', () => void gone(false)], [t('noteDeleteEverywhere'), 'primary danger', () => void gone(true)]]);
  else askSheet(t('noteDeleteAsk'), [[t('cancel'), 'tonal', () => undefined], [t('delete'), 'primary danger', () => void gone(false)]]);
}
/** The note editor: an episode's note (`ep`), the whole show's (0), or the show's full review (`review`). */
export function noteSheet(a: Anime, ep: number, had: N.ShowNote | undefined, changed: () => void, review = !!had?.review): void {
  const sh = openSheet(review ? t('reviewWrite') : ep ? `${t('episodeN', { n: ep })} · ${t('noteTitle')}` : t('noteWholeShow'), t('close')); sh.el.classList.add('note-sheet');
  let score = had?.score; let priv = !!had?.review?.private;
  const text = h('textarea', { class: 'note-text', rows: review ? 12 : 6, dir: 'auto', placeholder: review ? t('reviewPlaceholder') : t('notePlaceholder') }) as HTMLTextAreaElement; text.value = had?.text ?? '';
  const summary = h('input', { type: 'text', class: 'note-summary', dir: 'auto', maxlength: '160', placeholder: t('reviewSummaryHint') }) as HTMLInputElement; summary.value = had?.review?.summary ?? '';
  const bodyCount = h('small', { class: 'src note-count' }); const sumCount = h('small', { class: 'src note-count' });
  const save = h('button', { type: 'button', class: 'btn tonal note-save' }, t('save')) as HTMLButtonElement;
  const send = h('button', { type: 'button', class: 'btn primary note-send' }, icon('upload'), t('noteSaveSend')) as HTMLButtonElement;
  const sync = () => {
    const ok = !!text.value.trim(); save.disabled = !ok; send.disabled = !ok;
    if (review) {
      const b = N.chars(text.value), s = N.chars(summary.value);
      bodyCount.textContent = t('reviewBodyCount', { n: localDigits(b), min: localDigits(N.REVIEW_MIN) }); bodyCount.classList.toggle('short', b < N.REVIEW_MIN);
      sumCount.textContent = t('reviewSummaryCount', { n: localDigits(s), min: localDigits(N.SUMMARY_MIN), max: localDigits(N.SUMMARY_MAX) }); sumCount.classList.toggle('short', s < N.SUMMARY_MIN || s > N.SUMMARY_MAX);
    }
  };
  text.addEventListener('input', sync); summary.addEventListener('input', sync);
  if (review) {
    const out = h('output', { class: 'note-score-out' }, score ? localDigits(score) : '—');
    const range = h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(score ?? 0), 'aria-label': t('reviewScore'), oninput: () => { const v = Number(range.value); score = v || undefined; out.textContent = v ? localDigits(v) : '—'; } }) as HTMLInputElement;
    const privSw = h('input', { type: 'checkbox', checked: priv, onchange: () => { priv = privSw.checked; } }) as HTMLInputElement;
    sh.body.append(h('p', { class: 'hint note-rules' }, icon('info'), h('span', null, t('reviewRules', { body: localDigits(N.REVIEW_MIN), min: localDigits(N.SUMMARY_MIN), max: localDigits(N.SUMMARY_MAX) }))),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('reviewSummary')), summary, sumCount),
      h('label', { class: 'field' }, h('span', { class: 'label' }, t('reviewBody')), text, bodyCount),
      h('div', { class: 'field' }, h('span', { class: 'label' }, t('reviewScore')), h('div', { class: 'score-row' }, range, out)),
      h('label', { class: 'row switch-row' }, h('span', null, t('reviewPrivate'), h('small', { class: 'src' }, t('reviewPrivateHint'))), privSw));
  } else {
    const chips = h('div', { class: 'chip-row wrap note-scores' });
    const drawChips = () => chips.replaceChildren(...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((v) => h('button', { type: 'button', class: 'chip small' + ((score ?? 0) === v ? ' on' : ''), 'aria-pressed': String((score ?? 0) === v), onclick: () => { score = v || undefined; drawChips(); } }, v ? localDigits(v) : t('noteNoScore'))));
    drawChips();
    sh.body.append(h('label', { class: 'field' }, h('span', { class: 'label' }, t('noteText')), text), h('div', { class: 'field' }, h('span', { class: 'label' }, t('noteScore')), chips), h('p', { class: 'hint' }, t('noteLocalHint')));
  }
  const keep = async (): Promise<N.ShowNote> => N.saveNote({ id: had?.id, show: a.id, ep: review ? 0 : ep, text: text.value.trim(), score, ...(review ? { review: { summary: summary.value.trim(), private: priv } } : {}) });
  save.addEventListener('click', async () => { await keep(); sh.close(); toast(t('noteSaved')); changed(); });
  send.addEventListener('click', async () => { const n = await keep(); changed(); sendSheet(a, n, changed); });
  if (had) sh.actions.append(h('button', { type: 'button', class: 'btn text danger note-delete', onclick: () => deleteNoteAsk(a, had, () => { sh.close(); changed(); }) }, icon('trash'), t('delete')));
  sh.actions.append(save, send); sync(); setTimeout(() => text.focus(), 60);
}

/** Before sending: where the text goes, who will see it, the text itself as it will be — and Send. Nothing is sent
 *  from anywhere else. A failed send keeps the text and this sheet, to try again. */
export function sendSheet(a: Anime, n0: N.ShowNote, changed: () => void): void {
  let n = n0; const isReview = !!n.review;
  const sh = openSheet(t('sendTitle'), t('close')); sh.el.classList.add('send-sheet');
  const s = getSettings(); let how: 'activity' | 'notes' = n.al?.how === 'notes' || n.al?.how === 'activity' ? n.al.how : s.animeNotesMode === 'notes' ? 'notes' : 'activity';
  // (AniList on at first for a review, for a note already there — to update it —, or when the setting sends notes.)
  let toAl = al.linked() && (isReview || !!n.al || (s.animeNotesMode ?? 'local') !== 'local'); let toMal = false;
  const alBox = h('section', { class: 'send-target' }); const malBox = h('section', { class: 'send-target' }); const status = h('p', { class: 'send-status', role: 'status' });
  const go = h('button', { type: 'button', class: 'btn primary send-go' }, icon('upload'), t('sendNow')) as HTMLButtonElement;
  const preview = (txt: string) => h('pre', { class: 'send-preview', dir: 'auto' }, txt);
  const sw = (label: string, on: boolean, set: (v: boolean) => void) => h('label', { class: 'row switch-row' }, h('span', null, label), h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => { set((e.target as HTMLInputElement).checked); drawAl(); drawMal(); } }));
  let listAdd: boolean | null = null;
  const drawAl = () => {
    if (!al.linked()) { alBox.replaceChildren(h('h4', null, 'AniList'), h('p', { class: 'hint' }, t('sendAlSignIn')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => void import('./anilistLink').then((m) => m.anilistSignIn(() => { toAl = true; drawAl(); syncGo(); })) }, icon('user'), t('anilistSignInWith'))); return; }
    const kids: (Node | null)[] = [h('h4', null, 'AniList'), sw(t('sendToAl'), toAl, (v) => { toAl = v; })];
    if (toAl) {
      if (isReview) {
        const p = N.reviewProblem(n);
        kids.push(h('p', { class: 'send-public' }, icon(n.review!.private ? 'lock' : 'globe'), h('span', null, n.review!.private ? t('pubReviewPrivate') : t('pubReview'))),
          p ? h('p', { class: 'send-problem' }, icon('alert'), h('span', null, p === 'body' ? t('reviewTooShort', { n: localDigits(N.chars(n.text)), min: localDigits(N.REVIEW_MIN) }) : p === 'summary' ? t('reviewSummaryBad', { min: localDigits(N.SUMMARY_MIN), max: localDigits(N.SUMMARY_MAX) }) : t('reviewNeedScore'))) : null,
          preview(`${n.review!.summary}\n\n${n.text.trim()}\n\n★ ${localDigits(n.score ?? 0)}/${localDigits(100)}`));
      } else {
        kids.push(h('div', { class: 'chip-row wrap send-how' }, ...([['activity', t('notesModeActivity')], ['notes', t('notesModeNotes')]] as const).map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (how === k ? ' on' : ''), 'aria-pressed': String(how === k), onclick: () => { how = k; drawAl(); } }, l))),
          h('p', { class: 'send-public' }, icon('globe'), h('span', null, how === 'activity' ? t('pubActivity') : t('pubNotes'))),
          how === 'notes' && listAdd ? h('p', { class: 'send-problem soft' }, icon('info'), h('span', null, t('pubNotesAdds'))) : null,
          preview(how === 'activity' ? activityText(a, n) : N.noteLine(n)));
        if (how === 'notes' && listAdd === null) { listAdd = false; void N.onAniListList(a.id).then((on) => { listAdd = !on; if (listAdd) drawAl(); }).catch(() => undefined); }
      }
    }
    alBox.replaceChildren(...kids.filter((k): k is Node => !!k)); syncGo();
  };
  const drawMal = () => {
    const kids: (Node | null)[] = [h('h4', null, 'MyAnimeList')];
    if (isReview) kids.push(h('p', { class: 'hint' }, t('malNoReviews')));
    else if (!a.idMal) kids.push(h('p', { class: 'hint' }, t('malNoPage')));
    else if (!malLinkedNow) kids.push(h('p', { class: 'hint' }, t('malSignInHint')), h('button', { type: 'button', class: 'btn text small', onclick: () => malSheet(() => { void loadMal().then(() => { toMal = malLinkedNow; drawMal(); }); }) }, icon('user'), t('malAccount')));
    else { kids.push(sw(t('sendToMal'), toMal, (v) => { toMal = v; })); if (toMal) kids.push(h('p', { class: 'send-public' }, icon('globe'), h('span', null, t('pubMal'))), preview(N.noteLine(n))); }
    malBox.replaceChildren(...kids.filter((k): k is Node => !!k)); syncGo();
  };
  let malLinkedNow = false;
  const loadMal = () => import('../anime/mal').then((m) => { malLinkedNow = m.malLinked(); });
  const syncGo = () => { go.disabled = !((toAl && al.linked() && !(isReview && N.reviewProblem(n))) || (toMal && malLinkedNow && !!a.idMal && !isReview)); };
  go.addEventListener('click', async () => {
    go.disabled = true; status.classList.remove('bad'); status.textContent = t('sending'); const fails: string[] = [];
    if (toAl && al.linked()) { try { n = await N.sendAniList(n, isReview ? 'review' : how, isReview ? '' : how === 'activity' ? activityText(a, n) : N.noteLine(n)); } catch (e) { const w = al.retryAfterOf(e); fails.push(`AniList: ${w ? t('sendWait', { n: localDigits(w) }) : String((e as Error).message ?? e)}`); } }
    if (toMal && malLinkedNow && a.idMal && !isReview) { try { n = await N.sendMal(n, a.idMal, N.noteLine(n)); } catch (e) { const w = (e as { retryAfter?: number }).retryAfter; fails.push(w ? `MyAnimeList: ${t('sendWait', { n: localDigits(w) })}` : String((e as Error).message ?? e)); } }
    changed();
    if (!fails.length) { sh.close(); toast(t('sentOk')); return; }
    status.textContent = `${t('sendFailedKept')} ${fails.join(' · ')}`; status.classList.add('bad'); go.lastChild!.textContent = t('tryAgain'); syncGo();
  });
  sh.body.append(h('p', { class: 'hint' }, t('sendIntro')), alBox, malBox, status);
  sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => sh.close() }, t('cancel')), go);
  drawAl(); drawMal(); void loadMal().then(() => { toMal = malLinkedNow && !!a.idMal && !isReview; drawMal(); });
}

/** Where a note is: only here, on AniList (how), on MyAnimeList, changed since, or its last send failed. */
function statusOf(n: N.ShowNote): HTMLElement {
  const bits: string[] = [];
  if (n.al) bits.push(n.al.how === 'activity' ? t('noteOnAlActivity') : n.al.how === 'notes' ? t('noteOnAlNotes') : n.review?.private ? t('noteOnAlReviewPrivate') : t('noteOnAlReview'));
  if (n.mal) bits.push(t('noteOnMal'));
  if (!bits.length) bits.push(t('noteLocal'));
  if (N.changedSince(n, n.al) || N.changedSince(n, n.mal)) bits.push(t('noteChanged'));
  return h('small', { class: 'src note-status' + (n.fail ? ' bad' : '') }, n.fail ? [icon('alert'), ` ${t('noteFailed')} · `] : null, bits.join(' · '));
}
/** The show's notes and review, on its page. */
export function notesCard(a: Anime, notes: N.ShowNote[], changed: () => void): HTMLElement {
  const rv = notes.find((x) => x.review); const showNote = notes.find((x) => !x.review && !x.ep);
  const row = (n: N.ShowNote) => h('div', { class: 'note-row' + (n.review ? ' is-review' : ''), dataset: { id: n.id } },
    h('div', { class: 'grow' }, h('div', { class: 'note-row-head' }, h('b', null, labelOf(n)), n.score ? h('span', { class: 'note-score' }, icon('star'), localDigits(n.score), n.review ? `/${localDigits(100)}` : `/${localDigits(10)}`) : null),
      n.review ? h('p', { class: 'note-summary-line', dir: 'auto' }, n.review.summary) : null,
      h('p', { class: 'note-body clamp', dir: 'auto' }, n.text), statusOf(n)),
    h('div', { class: 'note-actions' }, iconButton(n.fail ? 'refresh' : 'upload', n.fail ? t('tryAgain') : t('noteSend'), () => sendSheet(a, n, changed)), iconButton('pen', t('noteEdit'), () => noteSheet(a, n.ep, n, changed)), iconButton('trash', t('delete'), () => deleteNoteAsk(a, n, changed))));
  return h('section', { class: 'card anime-notes' },
    h('div', { class: 'card-head' }, h('h3', null, t('notesTitle')), h('div', { class: 'grow' }),
      showNote ? null : h('button', { type: 'button', class: 'btn text small note-add-show', onclick: () => noteSheet(a, 0, undefined, changed) }, icon('note'), t('noteWholeShow')),
      h('button', { type: 'button', class: 'btn tonal small note-review', onclick: () => noteSheet(a, 0, rv, changed, true) }, icon('star'), rv ? t('reviewEdit') : t('reviewWrite'))),
    ...(notes.length ? notes.map(row) : [h('p', { class: 'hint' }, t('notesEmpty'))]));
}

/* ---------- MyAnimeList's account ---------- */
/** Signing in to MyAnimeList with the user's own client ID (MAL gives apps none; the type «other» has no secret). */
export function malSheet(changed: () => void): void {
  const sh = openSheet(t('malAccount'), t('close')); sh.el.classList.add('mal-sheet');
  void import('../anime/mal').then((m) => {
    const draw = () => {
      const who = m.malUser();
      if (m.malLinked()) { sh.body.replaceChildren(h('p', { class: 'hint' }, t('malWhat')), h('div', { class: 'track-user' }, h('span', null, t('malLinkedAs', { name: who || '—' })), h('button', { type: 'button', class: 'btn small', onclick: () => { m.malUnlink(); draw(); changed(); } }, icon('close'), t('anilistUnlink')))); return; }
      const idIn = h('input', { type: 'text', dir: 'ltr', class: 'mal-id', value: getSettings().malClientId ?? '', placeholder: t('malClientId'), onchange: () => updateSettings({ malClientId: idIn.value.trim() }) }) as HTMLInputElement;
      const paste = h('textarea', { rows: 2, dir: 'ltr', class: 'mal-paste', placeholder: `${m.MAL_REDIRECT}?code=…` }) as HTMLTextAreaElement;
      const pasteRow = h('div', { class: 'field', hidden: true }, h('span', { class: 'label' }, t('malPasteAddress')), paste, h('button', { type: 'button', class: 'btn primary small', onclick: () => void finish(paste.value) }, icon('check'), t('anilistLink')));
      const finish = async (address: string) => { try { const name = await m.malFinish(address); toast(t('malLinkedAs', { name })); draw(); changed(); } catch (e) { toast(String((e as Error).message ?? e), 'error', 6000); } };
      const signIn = async () => {
        updateSettings({ malClientId: idIn.value.trim() }); if (!m.malClientId()) { toast(t('malNeedClient'), 'error'); idIn.focus(); return; }
        const url = m.malAuthUrl(); const { capture } = await import('./anilistLink');
        const at = await capture(url, 'code=', t('malAccount'));
        if (at === undefined) { window.open(url, '_blank', 'noopener'); pasteRow.hidden = false; return; }
        if (at) await finish(at);
      };
      const copy = (text: string) => h('button', { type: 'button', class: 'btn text small', onclick: () => void navigator.clipboard?.writeText(text).then(() => toast(t('copied'))) }, icon('copy'), t('copy'));
      sh.body.replaceChildren(h('p', { class: 'hint' }, t('malWhat')), h('p', { class: 'hint' }, t('malGuide')),
        h('div', { class: 'al-field' }, h('span', null, t('anilistRedirect')), h('code', { dir: 'ltr' }, m.MAL_REDIRECT), copy(m.MAL_REDIRECT)),
        h('label', { class: 'field' }, h('span', { class: 'label' }, t('malClientId')), idIn),
        h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn primary small mal-signin', onclick: () => void signIn() }, icon('user'), t('malSignIn')), h('a', { class: 'btn text small', href: 'https://myanimelist.net/apiconfig', target: '_blank', rel: 'noopener' }, icon('external'), t('malOpenApi'))),
        pasteRow);
    };
    draw();
  });
}
/** The settings rows: where an episode's note goes on AniList, and MyAnimeList's account. */
export function notesSettingsRows(rerender: () => void): HTMLElement[] {
  const s = getSettings(); const mode = s.animeNotesMode ?? 'local';
  const pick = h('div', { class: 'chip-row wrap notes-mode' }, ...([['activity', t('notesModeActivity')], ['notes', t('notesModeNotes')], ['local', t('notesModeLocal')]] as const).map(([k, l]) => h('button', { type: 'button', class: 'chip small' + (mode === k ? ' on' : ''), 'aria-pressed': String(mode === k), onclick: () => { updateSettings({ animeNotesMode: k }); rerender(); } }, l)));
  const malRow = h('div', { class: 'row notes-mal' }, h('span', null, 'MyAnimeList', h('small', { class: 'src mal-state' }, t('malWhatShort'))), h('button', { type: 'button', class: 'btn tonal small', onclick: () => malSheet(rerender) }, icon('user'), t('malAccount')));
  void import('../anime/mal').then((m) => { const st = malRow.querySelector('.mal-state'); if (st && m.malLinked()) st.textContent = t('malLinkedAs', { name: m.malUser() || '—' }); });
  const sw = (label: string, hint: string, on: boolean, set: (v: boolean) => void) => h('label', { class: 'row switch-row' }, h('span', null, label, h('small', { class: 'src' }, hint)), h('input', { type: 'checkbox', checked: on, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }));
  const after = [sw(t('trackAfterWatch'), t('trackAfterWatchHint'), s.animeTrackAfterWatch !== false, (v) => updateSettings({ animeTrackAfterWatch: v })), sw(t('askReview'), t('askReviewHint'), s.animeAskReview !== false, (v) => updateSettings({ animeAskReview: v }))];
  return [h('h4', null, t('afterWatchTitle')), ...after, h('h4', null, t('notesTitle')), h('div', { class: 'field notes-mode-field' }, h('span', { class: 'label' }, t('notesModeLabel')), pick, h('small', { class: 'hint' }, mode === 'activity' ? t('pubActivity') : mode === 'notes' ? t('pubNotes') : t('notesModeLocalHint'))), malRow];
}

/* ---------- after watching: «Episode n watched. Review it?» ---------- */
/** A small bar at the top of the show's page: tapped, the episode's note editor; it leaves by itself after a few
 *  seconds (its line running down, stopped while it is pointed at, touched or focused; a still line and longer with
 *  reduced motion), never takes the focus, and is read out politely. Returns its dismissal. */
export function reviewBar(ep: number, open: () => void): () => void {
  document.querySelector('.review-bar')?.remove();
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches; const total = still ? 14000 : 8000;
  let left = total; let since = Date.now(); let timer = 0; let held = 0;
  const line = h('i', { style: { animationDuration: `${total}ms` } });
  const gone = () => { window.clearTimeout(timer); el.classList.add('leaving'); setTimeout(() => el.remove(), 200); };
  const run = () => { since = Date.now(); window.clearTimeout(timer); timer = window.setTimeout(gone, left); el.classList.remove('held'); };
  const hold = () => { if (held++ === 0) { window.clearTimeout(timer); left = Math.max(1500, left - (Date.now() - since)); el.classList.add('held'); } };
  const letGo = () => { if (held > 0 && --held === 0) run(); };
  const el = h('div', { class: 'float-bar review-bar' + (still ? ' still' : ''), role: 'status', 'aria-live': 'polite' },
    h('button', { type: 'button', class: 'rb-main', onclick: () => { gone(); open(); } }, icon('pen'), h('span', { class: 'grow', dir: 'auto' }, t('reviewAskBar', { n: ep }))),
    iconButton('close', t('close'), () => gone()), h('span', { class: 'rb-line', 'aria-hidden': 'true' }, line));
  el.addEventListener('pointerenter', hold); el.addEventListener('pointerleave', letGo); el.addEventListener('focusin', hold); el.addEventListener('focusout', letGo);
  el.addEventListener('touchstart', hold, { passive: true }); el.addEventListener('touchend', letGo); el.addEventListener('touchcancel', letGo);
  document.body.append(el); run();
  return gone;
}
