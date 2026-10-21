// "Define" and "Translate" for selected text. The reader is offline-first, so
// these are the only features that touch the network — and they say so when
// there is none.
import { h, icon, openSheet } from './dom';
import { t, getLang, isRtlText } from '../i18n';
import { getSettings } from '../settings';
import { hasSystemText, translateWithSystem } from './share';

const TARGETS = ['ar', 'en', 'fr', 'tr', 'ur', 'fa', 'de', 'es', 'id', 'ja', 'zh-CN', 'ru'] as const;
const NAMES: Record<string, string> = { ar: 'العربية', en: 'English', fr: 'Français', tr: 'Türkçe', ur: 'اردو', fa: 'فارسی', de: 'Deutsch', es: 'Español', id: 'Bahasa Indonesia', ja: '日本語', 'zh-CN': '中文', ru: 'Русский' };

function sampleWord(text: string): string {
  return text.trim().split(/\s+/)[0]?.replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '') ?? '';
}

export function showDefinition(text: string): void {
  const word = sampleWord(text);
  const arabic = isRtlText(word);
  const s = openSheet(`${t('define')}: ${word}`, t('close'));
  const dictUrl = arabic ? `https://www.almaany.com/ar/dict/ar-ar/${encodeURIComponent(word)}/` : `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}`;
  s.actions.append(h('a', { class: 'btn small', href: dictUrl, target: '_blank', rel: 'noopener' }, icon('external'), t('openInDictionary')));
  if (!navigator.onLine) { s.body.append(h('p', { class: 'src' }, t('offlineService'))); return; }
  s.body.append(h('div', { class: 'center' }, h('div', { class: 'spinner' }), t('lookingUp')));
  (arabic ? defineArabic(word) : defineLatin(word))
    .then((html) => { s.body.innerHTML = ''; if (html) { const d = h('div', { class: arabic ? 'ar' : '' }); d.innerHTML = html; s.body.append(d); } else s.body.append(h('p', { class: 'src' }, t('noDefinition'))); })
    .catch(() => { s.body.innerHTML = ''; s.body.append(h('p', { class: 'src' }, t('serviceFailed'))); });
}

function esc(s: string): string { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!); }

async function defineLatin(word: string): Promise<string | null> {
  const lower = word.toLowerCase();
  // Wiktionary REST definitions (multi-language), then dictionaryapi.dev as a fallback.
  try {
    const r = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(lower)}?redirect=true`, { headers: { accept: 'application/json' } });
    if (r.ok) {
      const data = (await r.json()) as Record<string, { partOfSpeech: string; language: string; definitions: { definition: string; examples?: string[] }[] }[]>;
      const sections = data.en ?? Object.values(data)[0];
      if (sections?.length) {
        return sections.slice(0, 4).map((sec) => `<div class="pos">${esc(sec.partOfSpeech)} · ${esc(sec.language)}</div><ol>${sec.definitions.slice(0, 5).map((d) => `<li>${stripLinks(d.definition)}${d.examples?.[0] ? `<br><small style="color:var(--text-dim)">${stripLinks(d.examples[0])}</small>` : ''}</li>`).join('')}</ol>`).join('');
      }
    }
  } catch { /* try next */ }
  const r2 = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(lower)}`);
  if (!r2.ok) return null;
  const entries = (await r2.json()) as { phonetic?: string; meanings: { partOfSpeech: string; definitions: { definition: string; example?: string }[] }[] }[];
  return entries.slice(0, 2).map((e) => `${e.phonetic ? `<div class="src">${esc(e.phonetic)}</div>` : ''}${e.meanings.map((m) => `<div class="pos">${esc(m.partOfSpeech)}</div><ol>${m.definitions.slice(0, 4).map((d) => `<li>${esc(d.definition)}${d.example ? `<br><small style="color:var(--text-dim)">${esc(d.example)}</small>` : ''}</li>`).join('')}</ol>`).join('')}`).join('');
}

function stripLinks(html: string): string {
  const d = document.createElement('div');
  d.innerHTML = html;
  d.querySelectorAll('a').forEach((a) => a.replaceWith(...a.childNodes));
  d.querySelectorAll('script, style, img').forEach((e) => e.remove());
  return d.innerHTML;
}

async function defineArabic(word: string): Promise<string | null> {
  // Strip diacritics and the definite article for a better hit rate.
  const bare = word.replace(/[ً-ْٰـ]/g, '');
  const candidates = [bare, bare.replace(/^(ال|و|ف|ب|ل|ك)/, '')].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const c of candidates) {
    const url = `https://ar.wiktionary.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&origin=*&titles=${encodeURIComponent(c)}`;
    const r = await fetch(url);
    if (!r.ok) continue;
    const data = (await r.json()) as { query?: { pages?: Record<string, { extract?: string }> } };
    const page = Object.values(data.query?.pages ?? {})[0];
    const extract = page?.extract?.trim();
    if (!extract) continue;
    // Keep the Arabic section, drop the rest; render paragraphs.
    const arSection = extract.split(/\n==\s*[^=\n]+\s*==\n/).find((sec, i, arr) => i === 0 ? /== *عربية|== *العربية/.test(extract.slice(0, 80)) || arr.length === 1 : false) ?? extract;
    const paras = arSection.split(/\n{2,}/).slice(0, 12).map((p) => `<p>${esc(p.replace(/^=+\s*|\s*=+$/g, ''))}</p>`);
    return paras.join('');
  }
  return null;
}

export function showTranslation(text: string): void {
  // The reader can hand the passage to a translator app instead of its own (slow) lookup.
  if (getSettings().translator === 'system' && hasSystemText()) { void translateWithSystem(text); return; }
  const sourceIsArabic = isRtlText(text);
  let target = localStorage.getItem('kr.translateTo') || (sourceIsArabic ? 'en' : getLang() === 'ar' ? 'ar' : 'en');
  if (sourceIsArabic && target === 'ar') target = 'en';
  const s = openSheet(t('translate'), t('close'));
  const sel = h('select', { 'aria-label': t('translateTo'), onchange: () => { target = sel.value; localStorage.setItem('kr.translateTo', target); void run(); } }, ...TARGETS.map((code) => h('option', { value: code }, NAMES[code]))) as HTMLSelectElement;
  sel.value = target;
  const out = h('div');
  s.body.append(h('div', { class: 'src', dir: 'auto' }, text.length > 300 ? text.slice(0, 300) + '…' : text), out);
  s.actions.append(h('label', { class: 'field', style: { flexDirection: 'row', alignItems: 'center', gap: '8px' } }, h('span', { class: 'label' }, t('translateTo')), sel));
  const link = h('a', { class: 'btn small', href: '#', target: '_blank', rel: 'noopener' }, icon('external'), t('openInTranslator')) as HTMLAnchorElement;
  s.actions.append(link);
  if (hasSystemText()) s.actions.append(h('button', { class: 'btn small', onclick: () => { s.close(); void translateWithSystem(text); } }, icon('translate'), t('translatorSystem')));

  async function run() {
    link.href = `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(target)}&text=${encodeURIComponent(text.slice(0, 2000))}&op=translate`;
    out.innerHTML = '';
    if (!navigator.onLine) { out.append(h('p', { class: 'src' }, t('offlineService'))); return; }
    out.append(h('div', { class: 'center' }, h('div', { class: 'spinner' }), t('translating')));
    try {
      const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(target)}&dt=t&q=${encodeURIComponent(text.slice(0, 4000))}`);
      if (!r.ok) throw new Error(String(r.status));
      const data = (await r.json()) as [[string, string][]];
      const translated = (data[0] ?? []).map((seg) => seg[0]).join('');
      out.innerHTML = '';
      out.append(h('div', { dir: 'auto', class: isRtlText(translated) ? 'ar' : '' }, translated || t('serviceFailed')));
    } catch {
      out.innerHTML = '';
      out.append(h('p', { class: 'src' }, t('serviceFailed')));
    }
  }
  void run();
}
