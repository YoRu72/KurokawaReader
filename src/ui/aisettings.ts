// Provider, key, model, language and instructions for the AI features (shared by
// the translator pill and Settings). Choice lists open as stacked M3 sheets.
import { h, icon, openSheet, pickButton } from './dom';
import { t } from '../i18n';
import { getSettings, updateSettings, type VisualSettings } from '../settings';
import { PROVIDERS, providerInfo, effectiveModel, defaultPrompt, langName, type AiProvider } from '../ai';

const TARGETS = ['ar', 'en', 'fr', 'tr', 'ur', 'fa', 'de', 'es', 'id', 'ja', 'zh-CN', 'ru'];

export function aiSettingsSheet(onDone?: () => void): void {
  const s = getSettings();
  const sh = openSheet(t('aiTranslate'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const field = (label: string, control: HTMLElement, hint?: string) => h('div', { class: 'field' }, h('span', { class: 'label' }, label), control, hint ? h('span', { class: 'hint' }, hint) : null);

  const key = h('input', { type: 'password', value: s.aiKey, placeholder: 'API key', autocomplete: 'off', dir: 'ltr', onchange: () => updateSettings({ aiKey: key.value.trim() }) }) as HTMLInputElement;
  const keyLink = h('a', { class: 'btn small', href: providerInfo().keyUrl, target: '_blank', rel: 'noopener', hidden: !providerInfo().keyUrl }, icon('external'), t('getKey')) as HTMLAnchorElement;
  const model = h('input', { type: 'text', value: s.aiModel, placeholder: providerInfo().model, dir: 'ltr', spellcheck: 'false', onchange: () => updateSettings({ aiModel: model.value.trim() }) }) as HTMLInputElement;
  const url = h('input', { type: 'text', value: s.aiBaseUrl, placeholder: providerInfo().baseUrl, dir: 'ltr', spellcheck: 'false', onchange: () => updateSettings({ aiBaseUrl: url.value.trim() }) }) as HTMLInputElement;
  const prompt = h('textarea', { rows: '5', placeholder: defaultPrompt(s.aiTarget), dir: 'auto', onchange: () => updateSettings({ aiPrompt: prompt.value.trim() }) }, s.aiPrompt) as HTMLTextAreaElement;
  const modelLine = h('p', { class: 'src' }, `${t('aiModel')}: ${effectiveModel()}`);

  const prov = pickButton<AiProvider>(t('aiProvider'), PROVIDERS.map((p) => [p.id, p.label]), s.aiProvider, (v) => {
    updateSettings({ aiProvider: v });
    model.placeholder = providerInfo().model; url.placeholder = providerInfo().baseUrl;
    keyLink.hidden = !providerInfo().keyUrl; keyLink.href = providerInfo().keyUrl;
    modelLine.textContent = `${t('aiModel')}: ${effectiveModel()}`;
  }, t('close'));
  const target = pickButton(t('translateTo'), TARGETS.map((c): [string, string] => [c, langName(c)]), s.aiTarget, (v) => { updateSettings({ aiTarget: v }); prompt.placeholder = defaultPrompt(v); }, t('close'));
  const task = pickButton<VisualSettings['aiTask']>(t('aiTask'), [['translate', t('aiTaskTranslate'), 'translate'], ['furigana', t('aiTaskFurigana'), 'type']], s.aiTask, (v) => { updateSettings({ aiTask: v }); langField.hidden = v !== 'translate'; promptField.hidden = v !== 'translate'; }, t('close'));

  const langField = field(t('translateTo'), target);
  const promptField = field(t('aiPrompt'), prompt, t('aiPromptHint'));
  langField.hidden = s.aiTask !== 'translate'; promptField.hidden = s.aiTask !== 'translate';

  sh.body.append(
    h('p', { class: 'src' }, t('aiTranslateBody')),
    field(t('aiTask'), task),
    field(t('aiProvider'), prov),
    field('API key', h('div', { style: { display: 'flex', gap: '8px' } }, key, keyLink)),
    field(t('aiModel'), model),
    field(t('aiBaseUrl'), url),
    langField,
    promptField,
    modelLine,
  );
  sh.actions.append(
    h('button', { class: 'btn small', type: 'button', onclick: () => { prompt.value = ''; updateSettings({ aiPrompt: '' }); prompt.placeholder = defaultPrompt(getSettings().aiTarget); } }, t('resetPrompt')),
    h('button', { class: 'btn small primary', type: 'button', onclick: () => { sh.close(); onDone?.(); } }, icon('check'), t('done')));
}
