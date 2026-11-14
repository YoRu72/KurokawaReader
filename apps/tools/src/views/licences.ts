// Settings → About → Open-source licences: the notices of what the app carries from others (the themes' for now),
// shown in full as their licences ask.
import { h, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { THEMES } from '../theme/themes';
import { themeName } from '../theme/gallery';

export function licencesSheet(): void {
  const { body } = openSheet(t('licenses'), t('close'));
  const seen = new Map<string, string[]>();
  for (const d of THEMES) if (d.notice) seen.set(d.notice, [...(seen.get(d.notice) ?? []), themeName(d, (k) => t(k as 'appearance'))]);
  body.append(h('p', { class: 'hint' }, t('licensesHint')),
    ...[...seen].map(([notice, names]) => h('section', { class: 'licence' }, h('h4', null, names.join(', ')), h('pre', { class: 'licence-text', dir: 'ltr' }, notice))));
}
