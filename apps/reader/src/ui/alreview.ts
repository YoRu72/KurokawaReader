// A review of the book's novel, written for AniList: a one-line summary, the long text (AniList's markdown passes
// through), the score and a Private switch. What is typed is kept on the book as it is typed (a draft the backup
// carries), and nothing is sent until the reader presses Publish. Reached only with an AniList account linked and a
// media matched (the details page and the tracking sheet hide it otherwise).
import { h, icon, openSheet, toast } from './dom';
import { t, localDigits, formatDuration } from '../i18n';
import { db, type Book } from '../db';
import * as al from '../anilist';
import { ensureStyle } from './lazycss';
import CSS from './alreview.lazy.css' with { type: 'text' };

/** Whether the review entry may be offered for this book at all. */
export const reviewAllowed = (book: Book): boolean => al.anilistOn() && al.linked() && !!book.track;
/** Its label: «Edit your review» when one is known to exist. */
export const reviewLabel = (book: Book): string => t(book.track?.reviewId ? 'alrEdit' : 'alrAction');

/** The score to start from, 0–100: AniList's own for the book, else the app's stars. */
export function startScore(book: Book): number {
  const u = al.user(); const s = book.track?.entry.score ?? 0;
  if (s > 0 && u) return Math.round((s / al.scoreMax(u.scoreFormat)) * 100);
  return (book.rating ?? 0) * 20;
}

async function remember(book: Book, patch: (b: Book) => void): Promise<void> {
  patch(book); await db.updateBook(book.id, patch);
}

export function reviewSheet(book: Book, onChange: () => void = () => {}): void {
  ensureStyle('alr-css', CSS);
  const L = al.REVIEW_LIMITS; const media = book.track!.media;
  const sh = openSheet(reviewLabel(book), t('close'), { stack: true, onClose: () => { void flush(); } });
  sh.el.classList.add('alr-sheet'); sh.body.style.fontFamily = 'var(--font-ui)';
  let existing: al.AlReview | null = null; let checked = false; let siteUrl = '';
  const draft0 = book.alDraft;
  const num = (n: number) => localDigits(String(n));

  // ---- fields
  const summary = h('input', { type: 'text', class: 'alr-summary', dir: 'auto', autocomplete: 'off', placeholder: t('alrSummaryPh') }) as HTMLInputElement;
  const body = h('textarea', { class: 'alr-body', rows: 12, dir: 'auto', placeholder: t('alrBodyPh') }) as HTMLTextAreaElement;
  const slider = h('input', { type: 'range', min: String(L.scoreMin), max: String(L.scoreMax), step: '1', 'aria-label': t('alrScore') }) as HTMLInputElement;
  const scoreIn = h('input', { type: 'text', inputmode: 'numeric', class: 'alr-score-n', dir: 'ltr', 'aria-label': t('alrScore') }) as HTMLInputElement;
  const priv = h('input', { type: 'checkbox', role: 'switch', class: 'alr-private' }) as HTMLInputElement;
  const sumCount = h('span', { class: 'alr-count' }); const bodyCount = h('span', { class: 'alr-count' });
  const status = h('div', { class: 'alr-status', role: 'alert', hidden: true });
  const choice = h('div', { class: 'alr-choice', hidden: true });

  const score = (): number => Math.max(L.scoreMin, Math.min(L.scoreMax, Math.round(Number(scoreIn.value.replace(/\D/g, '')) || 0)));
  const values = () => ({ summary: summary.value.trim(), body: body.value.trim(), score: score(), private: priv.checked });
  const setValues = (v: { summary: string; body: string; score: number; private: boolean }) => { summary.value = v.summary; body.value = v.body; scoreIn.value = String(v.score); slider.value = String(v.score); priv.checked = v.private; refresh(); };

  const refresh = () => {
    const v = values(); const p = al.reviewProblems(v);
    const sl = [...v.summary].length;
    sumCount.textContent = t('alrCountOf', { n: num(sl), max: num(L.summaryMax) });
    sumCount.classList.toggle('bad', !!p.summary);
    bodyCount.textContent = t('alrBodyCount', { n: num([...v.body].length) }) + (p.body ? ' · ' + t('alrMissing', { n: num(p.body), min: num(L.bodyMin) }) : ' ✓');
    bodyCount.classList.toggle('bad', !!p.body);
    publish.disabled = !!(p.body || p.summary || p.score) || busy;
  };

  // ---- the draft, kept as typed
  let timer = 0; let dirty = false;
  async function flush(): Promise<void> {
    window.clearTimeout(timer); timer = 0; if (!dirty) return;
    const v = values(); const blank = !v.summary && !v.body;
    if (blank && !book.alDraft) return;
    await remember(book, (b) => { if (blank) delete b.alDraft; else b.alDraft = { ...v, at: Date.now() }; });
  }
  const changed = () => { dirty = true; refresh(); status.hidden = true; window.clearTimeout(timer); timer = window.setTimeout(() => void flush(), 400); };
  for (const el of [summary, body]) el.addEventListener('input', changed);
  priv.addEventListener('change', changed);
  slider.addEventListener('input', () => { scoreIn.value = slider.value; changed(); });
  scoreIn.addEventListener('input', () => { slider.value = String(score()); changed(); });
  scoreIn.addEventListener('blur', () => { scoreIn.value = String(score()); });

  // ---- inserts at the cursor
  const insert = (text: string, wrap?: [string, string]) => {
    const a = body.selectionStart ?? body.value.length, z = body.selectionEnd ?? a; const sel = body.value.slice(a, z);
    const put = wrap ? wrap[0] + (sel || '') + wrap[1] : text;
    body.setRangeText(put, a, z, 'end');
    if (wrap && !sel) { const c = a + wrap[0].length; body.setSelectionRange(c, c); }
    body.focus(); changed();
  };
  const tool = (label: string, title: string, fn: () => void, cls = '') => h('button', { type: 'button', class: 'btn tonal alr-tool ' + cls, title, 'aria-label': title, onclick: fn }, label) as HTMLButtonElement;
  const marks = h('div', { class: 'alr-tools' },
    tool('B', t('alrBold'), () => insert('', ['**', '**']), 'b'), tool('I', t('alrItalic'), () => insert('', ['_', '_']), 'i'),
    tool('~!', t('alrSpoiler'), () => insert('', ['~!', '!~'])), tool('❝', t('alrQuote'), () => insert('', ['> ', ''])));
  const helpers = h('div', { class: 'alr-helpers' });
  const factsBtn = h('button', { type: 'button', class: 'btn tonal', onclick: () => {
    const bits: string[] = [];
    const fin = book.doneAt ? new Date(book.doneAt) : null; const fd = al.dateOf(book.track?.entry.completedAt) || (fin ? `${fin.getFullYear()}-${String(fin.getMonth() + 1).padStart(2, '0')}-${String(fin.getDate()).padStart(2, '0')}` : '');
    if (fd) bits.push(t('alrFactFinished', { d: fd }));
    if (book.stats?.ms) bits.push(t('alrFactTime', { time: formatDuration(book.stats.ms) }));
    if (!bits.length) { toast(t('alrNoFacts')); return; }
    insert(bits.join(' · ') + '\n\n');
  } }, icon('clock'), t('alrFacts'));
  helpers.append(factsBtn);
  if ((book.highlights ?? []).length) helpers.prepend(h('button', { type: 'button', class: 'btn tonal', onclick: () => void pickHighlights() }, icon('highlight'), t('alrHighlights')));

  async function pickHighlights(): Promise<void> {
    const fresh = (await db.getBook(book.id)) ?? book; const list = fresh.highlights ?? []; if (!list.length) return;
    const pk = openSheet(t('alrHighlights'), t('close'), { stack: true }); pk.el.classList.add('alr-pick');
    const rows = list.map((hl) => { const cb = h('input', { type: 'checkbox', role: 'switch' }) as HTMLInputElement; return { hl, cb, row: h('label', { class: 'row alr-hl' }, h('span', { class: 'label', dir: 'auto' }, hl.text.trim()), h('span', { class: 'switch' }, cb, h('i'))) }; });
    pk.body.append(h('p', { class: 'hint' }, t('alrHighlightsHint')), ...rows.map((r) => r.row));
    pk.actions.append(h('button', { type: 'button', class: 'btn', onclick: pk.close }, t('cancel')), h('button', { type: 'button', class: 'btn primary', onclick: () => {
      const picked = rows.filter((r) => r.cb.checked).map((r) => r.hl.text.trim().split(/\n+/).map((l) => '> ' + l).join('\n'));
      pk.close(); if (picked.length) insert(picked.join('\n\n') + '\n\n');
    } }, icon('check'), t('alrInsert')));
  }

  // ---- publish and delete
  let busy = false;
  const fail = (e: unknown) => {
    const x = e as { later?: boolean; rate?: boolean };
    status.replaceChildren();
    if (!al.linked()) {
      status.append(h('span', null, t('alrNeedLink')), h('button', { type: 'button', class: 'btn tonal', onclick: () => void import('./anilistlink').then((m) => m.anilistSignIn(() => { status.hidden = true; })) }, icon('user'), t('alrRelink')));
    } else if (x.rate) status.append(h('span', null, t('alrRateLimit')));
    else if (x.later) status.append(h('span', null, t('alrOffline')));
    else status.append(h('span', { dir: 'auto' }, t('alrRefused', { m: al.refusalText(e) })));
    status.hidden = false; status.scrollIntoView?.({ block: 'nearest' });
  };
  const publish = h('button', { type: 'button', class: 'btn primary alr-publish', onclick: () => void doPublish() }, icon('check'), t('alrPublish')) as HTMLButtonElement;
  const del = h('button', { type: 'button', class: 'btn danger alr-delete', hidden: true, onclick: () => void doDelete() }, icon('trash'), t('alrDelete')) as HTMLButtonElement;
  const open = h('a', { class: 'btn tonal alr-open', href: '#', target: '_blank', rel: 'noopener', hidden: true }, icon('external'), t('alrOpen')) as HTMLAnchorElement;
  const setBusy = (b: boolean) => { busy = b; publish.disabled = b; del.disabled = b; if (!b) refresh(); };

  async function known(): Promise<boolean> {
    if (checked) return true;
    try { existing = await al.myReview(media.id); checked = true; return true; } catch (e) { fail(e); return false; }
  }
  async function doPublish(): Promise<void> {
    const v = values(); if (al.reviewProblems(v).body || al.reviewProblems(v).summary) return;
    status.hidden = true; setBusy(true);
    try {
      if (!al.linked()) { const e = new Error('token'); fail(e); return; }
      // (Never post a second review over one that exists: when the site could not be asked before, ask now.)
      if (!await known()) return;
      const r = await al.saveReview({ id: existing?.id ?? book.track?.reviewId, mediaId: media.id, ...v });
      existing = { id: r.id, ...v, siteUrl: r.siteUrl };
      siteUrl = r.siteUrl || `https://anilist.co/review/${r.id}`;
      dirty = false;
      await remember(book, (b) => { delete b.alDraft; if (b.track) b.track = { ...b.track, reviewId: r.id }; });
      onChange();
      open.href = siteUrl; open.hidden = false; del.hidden = false;
      sh.el.querySelector('.sheet-head h3')!.textContent = t('alrEdit');
      toast(t('alrPublished'));
    } catch (e) { fail(e); await flush(); }
    finally { setBusy(false); }
  }
  async function doDelete(): Promise<void> {
    const id = existing?.id ?? book.track?.reviewId; if (!id) return;
    if (!confirm(t('alrDeleteConfirm'))) return;
    setBusy(true);
    try {
      await al.deleteReview(id); existing = null;
      await remember(book, (b) => { if (b.track) { const { reviewId: _r, ...rest } = b.track; b.track = rest as typeof b.track; } });
      onChange(); toast(t('alrDeleted')); sh.close();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }

  // ---- layout
  const start = { summary: '', body: '', score: startScore(book), private: false };
  setValues(draft0 ? { summary: draft0.summary, body: draft0.body, score: draft0.score, private: draft0.private } : start);
  sh.body.append(
    h('div', { class: 'alr-head' }, media.cover ? h('img', { src: media.cover, alt: '' }) : null, h('div', null, h('b', { dir: 'auto' }, media.title), h('div', { class: 'src' }, t('alrDraftNote')))),
    choice,
    h('div', { class: 'field' }, h('label', { class: 'label' }, t('alrSummary')), summary, sumCount),
    h('div', { class: 'field' }, h('label', { class: 'label' }, t('alrBody')), marks, helpers, body, bodyCount, h('p', { class: 'hint' }, t('alrMarkdownHint'))),
    h('div', { class: 'field alr-scorebox' }, h('label', { class: 'label' }, t('alrScore')), h('div', { class: 'alr-scorerow' }, slider, scoreIn), h('span', { class: 'hint' }, t('alrScoreHint'))),
    h('label', { class: 'row alr-privrow' }, h('span', { class: 'label' }, t('alrPrivate'), h('small', null, t('alrPrivateHint'))), h('span', { class: 'switch' }, priv, h('i'))),
    status);
  sh.actions.append(open, del, publish);
  refresh();

  // ---- what is on the site (the sheet is usable meanwhile; offline it stays a draft)
  void (async () => {
    if (!al.linked()) return;
    try { existing = await al.myReview(media.id); checked = true; } catch { return; }
    if (!existing) { if (book.track?.reviewId) await remember(book, (b) => { if (b.track) { const { reviewId: _r, ...rest } = b.track; b.track = rest as typeof b.track; } }); return; }
    const ex = existing;
    del.hidden = false; sh.el.querySelector('.sheet-head h3')!.textContent = t('alrEdit');
    if (book.track && book.track.reviewId !== ex.id) await remember(book, (b) => { if (b.track) b.track = { ...b.track, reviewId: ex.id }; });
    if (ex.siteUrl) { siteUrl = ex.siteUrl; open.href = siteUrl; open.hidden = false; }
    const pub = { summary: ex.summary, body: ex.body, score: ex.score, private: ex.private };
    const cur = values(); const same = (a: typeof pub, b: typeof pub) => a.summary.trim() === b.summary.trim() && a.body.trim() === b.body.trim() && a.score === b.score && a.private === b.private;
    const draft = book.alDraft;
    if (!draft || (!cur.summary && !cur.body)) { setValues(pub); if (draft) await remember(book, (b) => { delete b.alDraft; }); return; }
    if (same(cur, pub)) { await remember(book, (b) => { delete b.alDraft; }); return; }
    // (A draft and a published one that differ: the later is shown, and the other is one tap away.)
    const draftNewer = draft.at >= (ex.updatedAt ?? 0) * 1000;
    if (!draftNewer) setValues(pub);
    const pick = (which: 'draft' | 'pub') => { if (which === 'pub') setValues(pub); else setValues({ summary: draft.summary, body: draft.body, score: draft.score, private: draft.private }); choice.hidden = true; changed(); };
    choice.replaceChildren(h('p', { class: 'hint' }, t('alrBothHint')),
      h('div', { class: 'alr-choice-row' }, h('button', { type: 'button', class: 'btn tonal alr-pick-draft', onclick: () => pick('draft') }, t('alrYourDraft')), h('button', { type: 'button', class: 'btn tonal alr-pick-pub', onclick: () => pick('pub') }, t('alrThePublished'))));
    choice.hidden = false;
  })();
}
