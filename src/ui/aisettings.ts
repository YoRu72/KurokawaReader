// Provider, key, model, language and instructions for the AI features (shared by
// the translator pill and Settings). Choice lists open as stacked M3 sheets.
import { h, icon, openSheet, pickButton, pickSheet, toast } from './dom';
import { t, isRtlText } from '../i18n';
import { getSettings, updateSettings, type VisualSettings } from '../settings';
import { PROVIDERS, providerInfo, effectiveModel, defaultPrompt, langName, AI_VOICES, listModels, type AiProvider } from '../ai';

const TARGETS = ['ar', 'en', 'fr', 'tr', 'ur', 'fa', 'de', 'es', 'id', 'ja', 'zh-CN', 'ru'];

export function aiSettingsSheet(onDone?: () => void, extra?: HTMLElement): void {
  const s = getSettings();
  const sh = openSheet(t('aiTranslate'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const field = (label: string, control: HTMLElement, hint?: string) => h('div', { class: 'field' }, h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);

  const key = h('input', { type: 'password', value: s.aiKey, placeholder: 'API key', autocomplete: 'off', dir: 'ltr', onchange: () => updateSettings({ aiKey: key.value.trim() }) }) as HTMLInputElement;
  const keyLink = h('a', { class: 'btn small', href: providerInfo().keyUrl, target: '_blank', rel: 'noopener', hidden: !providerInfo().keyUrl }, icon('external'), t('getKey')) as HTMLAnchorElement;
  const model = h('input', { type: 'text', value: s.aiModel, placeholder: providerInfo().model, dir: 'ltr', spellcheck: 'false', onchange: () => updateSettings({ aiModel: model.value.trim() }) }) as HTMLInputElement;
  // "Browse models": asks the provider for its list with the key entered, then lets the reader pick one.
  const modelsBtn = h('button', { class: 'btn small', type: 'button', title: t('browseModels'), 'aria-label': t('browseModels'), onclick: async () => {
    if (!getSettings().aiKey.trim() && getSettings().aiProvider !== 'custom') { toast(t('aiNeedsKey'), 'error', 3000); return; }
    modelsBtn.disabled = true; modelsBtn.replaceChildren(h('span', { class: 'spinner', style: { width: '16px', height: '16px' } }));
    try {
      const names = await listModels();
      if (!names.length) { toast(t('noModelsFound'), 'error', 3000); return; }
      pickSheet(t('browseModels'), names.map((n): [string, string] => [n, n]), effectiveModel(), (v) => { model.value = v; updateSettings({ aiModel: v }); modelLine.textContent = `${t('aiModel')}: ${effectiveModel()}`; }, t('close'));
    } catch (err) { toast(String((err as Error).message ?? err), 'error', 5000); }
    finally { modelsBtn.disabled = false; modelsBtn.replaceChildren(icon('search'), t('browseModels')); }
  } }, icon('search'), t('browseModels'));
  const url = h('input', { type: 'text', value: s.aiBaseUrl, placeholder: providerInfo().baseUrl, dir: 'ltr', spellcheck: 'false', onchange: () => updateSettings({ aiBaseUrl: url.value.trim() }) }) as HTMLInputElement;
  // Direction follows the text when there is some, else the target language — a WebView's
  // dir="auto" ignores the placeholder, which left Arabic instructions left-aligned.
  const RTL = /^(ar|ur|fa|he)/i;
  // The box can start with the built-in instructions as real text so the reader adds to them;
  // text identical to the built-in version is stored as "" so it keeps following the language.
  const savePrompt = () => { const v = prompt.value.trim(); updateSettings({ aiPrompt: v === defaultPrompt(getSettings().aiTarget) ? '' : v }); };
  const prompt = h('textarea', { rows: '6', placeholder: defaultPrompt(s.aiTarget), onchange: savePrompt, oninput: () => promptDir() }, s.aiPrompt) as HTMLTextAreaElement;
  const promptDir = () => { prompt.dir = prompt.value.trim() ? (isRtlText(prompt.value) ? 'rtl' : 'ltr') : (RTL.test(getSettings().aiTarget) ? 'rtl' : 'ltr'); };
  const prefill = () => { if (getSettings().aiPromptPrefill && !prompt.value.trim()) prompt.value = defaultPrompt(getSettings().aiTarget); promptDir(); };
  prefill();
  const modelLine = h('p', { class: 'src' }, `${t('aiModel')}: ${effectiveModel()}`);

  const prov = pickButton<AiProvider>(t('aiProvider'), PROVIDERS.map((p) => [p.id, p.label]), s.aiProvider, (v) => {
    updateSettings({ aiProvider: v });
    model.placeholder = providerInfo().model; url.placeholder = providerInfo().baseUrl;
    keyLink.hidden = !providerInfo().keyUrl; keyLink.href = providerInfo().keyUrl;
    modelLine.textContent = `${t('aiModel')}: ${effectiveModel()}`;
  }, t('close'));
  const target = pickButton(t('translateTo'), TARGETS.map((c): [string, string] => [c, langName(c)]), s.aiTarget, (v) => { const wasDefault = !getSettings().aiPrompt; updateSettings({ aiTarget: v }); prompt.placeholder = defaultPrompt(v); if (wasDefault) prompt.value = ''; prefill(); }, t('close'));
  const task = pickButton<VisualSettings['aiTask']>(t('aiTask'), [['translate', t('aiTaskTranslate'), 'translate'], ['furigana', t('aiTaskFurigana'), 'type']], s.aiTask, (v) => { updateSettings({ aiTask: v }); langField.hidden = v !== 'translate'; promptField.hidden = v !== 'translate'; }, t('close'));

  const langField = field(t('translateTo'), target);
  const prefillCb = h('input', { type: 'checkbox', onchange: () => { updateSettings({ aiPromptPrefill: prefillCb.checked }); if (prefillCb.checked) prefill(); else if (!getSettings().aiPrompt) { prompt.value = ''; promptDir(); } } }) as HTMLInputElement;
  prefillCb.checked = s.aiPromptPrefill;
  const prefillRow = h('label', { class: 'row' }, h('span', { class: 'label' }, t('aiPromptPrefill')), h('span', { class: 'switch' }, prefillCb, h('i')));
  const promptField = field(t('aiPrompt'), h('div', { style: { display: 'grid', gap: '8px' } }, prompt, prefillRow), t('aiPromptHint'));
  langField.hidden = s.aiTask !== 'translate'; promptField.hidden = s.aiTask !== 'translate';

  // Read-aloud engine and AI voice live here too (same key / provider).
  const engine = pickButton<VisualSettings['speechEngine']>(t('speechEngine'), [['system', t('speechSystem'), 'speak'], ['ai', t('speechAi'), 'translate']], s.speechEngine, (v) => { updateSettings({ speechEngine: v }); voiceField.hidden = v !== 'ai'; ttsField.hidden = v !== 'ai'; }, t('close'));
  const voicesOf = () => AI_VOICES[s.aiProvider === 'openrouter' || s.aiProvider === 'custom' ? 'openai' : getSettings().aiProvider] ?? AI_VOICES.openai;
  const voice = pickButton(t('aiVoice'), voicesOf().map((v): [string, string] => [v, v]), s.aiVoice || voicesOf()[0], (v) => updateSettings({ aiVoice: v }), t('close'));
  const tts = h('input', { type: 'text', value: s.aiTtsModel, dir: 'ltr', spellcheck: 'false', placeholder: s.aiProvider === 'gemini' ? 'gemini-2.5-flash-preview-tts' : 'gpt-4o-mini-tts', onchange: () => updateSettings({ aiTtsModel: tts.value.trim() }) }) as HTMLInputElement;
  const voiceField = field(t('aiVoice'), voice); const ttsField = field(t('aiTtsModel'), tts);
  voiceField.hidden = s.speechEngine !== 'ai'; ttsField.hidden = s.speechEngine !== 'ai';

  sh.body.append(
    h('p', { class: 'src' }, t('aiTranslateBody')),
    field(t('aiTask'), task),
    field(t('aiProvider'), prov),
    field('API key', h('div', { style: { display: 'flex', gap: '8px' } }, key, keyLink)),
    field(t('aiModel'), h('div', { style: { display: 'flex', gap: '8px' } }, model, modelsBtn), t('aiModelHint')),
    field(t('aiBaseUrl'), url),
    langField,
    promptField,
    modelLine,
    ...(extra ? [extra] : []),
    h('h4', { class: 'upd-title', style: { marginTop: '14px' } }, t('readAloud')),
    field(t('speechEngine'), engine),
    field(t('speechScope'), pickButton<VisualSettings['speechScope']>(t('speechScope'), [['chapter', t('speechChapter'), 'books'], ['book', t('speechBook'), 'library']], s.speechScope, (v) => updateSettings({ speechScope: v }), t('close'))),
    voiceField,
    ttsField,
  );
  sh.actions.append(
    h('button', { class: 'btn small', type: 'button', onclick: () => { prompt.value = defaultPrompt(getSettings().aiTarget); updateSettings({ aiPrompt: '' }); promptDir(); prompt.focus(); } }, icon('type'), t('insertDefaultPrompt')),
    h('button', { class: 'btn small primary', type: 'button', onclick: () => { sh.close(); onDone?.(); } }, icon('check'), t('done')));
}
