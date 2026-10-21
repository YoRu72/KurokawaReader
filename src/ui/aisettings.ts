// Provider, key, model and prompt for the AI features (shared by the translator pill and Settings).
import { h, icon, openSheet } from './dom';
import { t } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { PROVIDERS, providerInfo, effectiveModel, effectivePrompt, DEFAULT_PROMPT_AR, DEFAULT_PROMPT_EN, langName } from '../ai';

const TARGETS = ['ar', 'en', 'fr', 'tr', 'ur', 'fa', 'de', 'es', 'id', 'ja', 'zh-CN', 'ru'];

export function aiSettingsSheet(onDone?: () => void): void {
  const s = getSettings();
  const sh = openSheet(t('aiTranslate'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const field = (label: string, control: HTMLElement) => h('div', { class: 'field' }, h('span', { class: 'label' }, label), control);
  const prov = h('select', { onchange: () => { updateSettings({ aiProvider: prov.value as typeof s.aiProvider }); model.placeholder = providerInfo().model; url.placeholder = providerInfo().baseUrl; keyLink.hidden = !providerInfo().keyUrl; keyLink.href = providerInfo().keyUrl; } }, ...PROVIDERS.map((p) => h('option', { value: p.id }, p.label))) as HTMLSelectElement;
  prov.value = s.aiProvider;
  const key = h('input', { type: 'password', value: s.aiKey, placeholder: 'API key', autocomplete: 'off', dir: 'ltr', onchange: () => updateSettings({ aiKey: key.value.trim() }) }) as HTMLInputElement;
  const keyLink = h('a', { class: 'btn small', href: providerInfo().keyUrl, target: '_blank', rel: 'noopener', hidden: !providerInfo().keyUrl }, icon('external'), t('getKey')) as HTMLAnchorElement;
  const model = h('input', { type: 'text', value: s.aiModel, placeholder: providerInfo().model, dir: 'ltr', spellcheck: 'false', onchange: () => updateSettings({ aiModel: model.value.trim() }) }) as HTMLInputElement;
  const url = h('input', { type: 'text', value: s.aiBaseUrl, placeholder: providerInfo().baseUrl, dir: 'ltr', spellcheck: 'false', onchange: () => updateSettings({ aiBaseUrl: url.value.trim() }) }) as HTMLInputElement;
  const target = h('select', { onchange: () => { updateSettings({ aiTarget: target.value }); prompt.placeholder = target.value === 'ar' ? DEFAULT_PROMPT_AR : DEFAULT_PROMPT_EN.replace('{lang}', langName(target.value)); } }, ...TARGETS.map((c) => h('option', { value: c }, langName(c)))) as HTMLSelectElement;
  target.value = s.aiTarget;
  const prompt = h('textarea', { rows: '5', placeholder: effectivePrompt(), dir: 'auto', onchange: () => updateSettings({ aiPrompt: prompt.value.trim() }) }, s.aiPrompt) as HTMLTextAreaElement;
  sh.body.append(
    h('p', { class: 'src' }, t('aiTranslateBody')),
    field(t('aiProvider'), prov),
    field('API key', h('div', { style: { display: 'flex', gap: '8px' } }, key, keyLink)),
    field(t('aiModel'), model),
    field(t('aiBaseUrl'), url),
    field(t('translateTo'), target),
    field(t('aiPrompt'), prompt),
    h('p', { class: 'src' }, `${t('aiModel')}: ${effectiveModel()}`),
  );
  sh.actions.append(
    h('button', { class: 'btn small', type: 'button', onclick: () => { prompt.value = ''; updateSettings({ aiPrompt: '' }); prompt.placeholder = effectivePrompt(); } }, t('resetPrompt')),
    h('button', { class: 'btn small primary', type: 'button', onclick: () => { sh.close(); onDone?.(); } }, icon('check'), t('done')));
}
