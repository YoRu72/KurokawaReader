// Settings → About → Open-source licences: the notices of what the app carries from others (the themes' for now),
// shown in full as their licences ask.
import { h, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { THEMES } from '../theme/themes';
import { themeName } from '../theme/gallery';
// (The palette themes, with the notices of those whose colours came from others.)
import '../theme/palettes';

const TOOLS_NOTICE = `Kurokawa Tools — Copyright (C) 2026 Kurokawa contributors.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public
License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later
version. This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the
implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more
details: <https://www.gnu.org/licenses/>.

Device battery is derived from Wireless Device Battery Monitor by krisgfx9 and its contributors (GPL-3.0-or-later):
https://github.com/krisgfx9/Wireless-Device-Battery-Monitor (commit 285d64254216857e94ca3ea3e1deb536f863e282).
The source of Kurokawa Tools, with the changes made, is at https://github.com/YoRu72/KurokawaReader.`;

export function licencesSheet(): void {
  const { body } = openSheet(t('licenses'), t('close'));
  const seen = new Map<string, string[]>();
  for (const d of THEMES) if (d.notice) seen.set(d.notice, [...(seen.get(d.notice) ?? []), themeName(d, (k) => t(k as 'appearance'))]);
  body.append(h('p', { class: 'hint' }, t('licensesHint')),
    // (0.21: Tools itself, GPL-3.0-or-later, and the work its device battery is derived from — apps/tools/NOTICE.md.)
    h('section', { class: 'licence' }, h('h4', null, t('batLicenceHead')), h('p', { class: 'hint' }, t('aboutLicence')), h('pre', { class: 'licence-text', dir: 'ltr' }, TOOLS_NOTICE)),
    ...[...seen].map(([notice, names]) => h('section', { class: 'licence' }, h('h4', null, names.join(', ')), h('pre', { class: 'licence-text', dir: 'ltr' }, notice))));
}
