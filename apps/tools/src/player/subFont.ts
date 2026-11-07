// The player's main subtitle font: a font file of the reader's own (added to the app, kept in its storage) or the
// system's. Plain subtitles (SRT, VTT, the page's lines) are drawn in it; styled ones (ASS files, a video's own)
// take it too when the reader asks — each style's font replaced, the file handed to libass (JASSUB here, mpv on a
// phone) —, and a clip burnt with the subtitles keeps it.
import { h, icon, iconButton, openSheet, toast } from '../ui/dom';
import { t, localDigits, formatBytes } from '../i18n';
import { ktPlugin } from '../native';
import { getPrefs, updatePrefs } from './prefs';
import { db } from '../db';
import { assWithFont } from './assFont';
export { assWithFont };

const FONT_ACCEPT = '.ttf,.otf,.ttc,.otc,.woff,.woff2';
const faces = new Map<string, Promise<boolean>>();

/** The family loaded into the page from the app's fonts (once); false when it is not one of them (a system font). */
export function ensureFace(family: string): Promise<boolean> {
  if (!family) return Promise.resolve(false);
  let p = faces.get(family);
  if (!p) {
    p = (async () => {
      const F = await import('./fonts'); const f = (await F.library()).find((x) => x.families.some((n) => n.toLowerCase() === family.toLowerCase())); if (!f) return false;
      const blob = await db.getFile(`font:${f.id}`); if (!blob) return false;
      const face = new FontFace(family, await blob.arrayBuffer()); await face.load(); document.fonts.add(face); return true;
    })().catch(() => false);
    faces.set(family, p);
  }
  return p;
}

/** The text a styled subtitle is drawn from: in the main font when the reader wants it so. */
export function styledText(ass: string): string { const p = getPrefs(); return p.subFont && p.subFontAss ? assWithFont(ass, p.subFont) : ass; }

/** On a phone with mpv: the main font's file where mpv's libass finds it, and mpv told to use it. */
export async function mpvFont(set: (name: string, value: string) => void): Promise<void> {
  const p = getPrefs(); const pl = ktPlugin() as unknown as { writeTempBytes?(o: { name: string; sub: string; b64: string }): Promise<{ path: string }> } | null;
  set('sub-font', p.subFont || 'sans-serif');
  set('sub-ass-style-overrides', p.subFont && p.subFontAss ? `FontName=${p.subFont.replace(/[,=]/g, ' ')}` : '');
  if (!p.subFont || !pl?.writeTempBytes) return;
  try {
    const F = await import('./fonts'); const f = (await F.library()).find((x) => x.families.some((n) => n.toLowerCase() === p.subFont.toLowerCase())); if (!f) return;
    const blob = await db.getFile(`font:${f.id}`); if (!blob) return; const b = new Uint8Array(await blob.arrayBuffer());
    let b64 = ''; for (let i = 0; i < b.length; i += 0x8000) b64 += String.fromCharCode(...b.subarray(i, i + 0x8000));
    const r = await pl.writeTempBytes({ name: f.file.replace(/[^\w.-]/g, '_'), sub: 'subfont', b64: btoa(b64) });
    set('sub-fonts-dir', r.path.replace(/[\\/][^\\/]*$/, ''));
  } catch { /* the system's font, then */ }
}

/**
 * The «Font» row of the subtitle style: the font now (written in itself), and a sheet to choose another — the
 * system's, one of the fonts added to the app, or a font file added from here —; and «In styled subtitles too».
 * `changed` is told after each change.
 */
export function fontRows(changed: () => void): HTMLElement[] {
  const name = h('span', { class: 'sub-font-now', dir: 'auto' });
  const show = () => { const f = getPrefs().subFont; name.textContent = f || t('subFontSystem'); name.style.fontFamily = f ? `"${f}", sans-serif` : ''; if (f) void ensureFace(f); };
  show();
  const choose = async () => {
    const F = await import('./fonts'); const sh = openSheet(t('subFont'), t('close'));
    const file = h('input', { type: 'file', multiple: true, hidden: true, ...(ktPlugin() ? {} : { accept: FONT_ACCEPT }), onchange: async (e: Event) => {
      const fs = Array.from((e.target as HTMLInputElement).files ?? []); if (!fs.length) return;
      const before = new Set((await F.library()).map((x) => x.id)); const n = await F.addFonts(fs);
      if (!n) { toast(t('subFontNotFont'), 'error'); return; }
      const added = (await F.library()).filter((x) => !before.has(x.id)); toast(t('fontsAdded', { n: localDigits(n) }));
      if (added[0]) pick(added[0].families[0]); else void draw();
    } }) as HTMLInputElement;
    const pick = (fam: string) => { updatePrefs({ subFont: fam }); show(); changed(); void draw(); };
    const row = (fam: string, label: string, sub: string, extra?: HTMLElement) => { const on = getPrefs().subFont === fam; const r = h('div', { class: 'dest-row sub-font-row' + (on ? ' on' : ''), role: 'button', tabindex: 0, onclick: () => pick(fam) }, icon(on ? 'check' : 'type'), h('span', { class: 'grow' }, h('span', { class: 'sub-font-sample', dir: 'auto', style: { fontFamily: fam ? `"${fam}", sans-serif` : '' } }, label), sub ? h('small', { class: 'src', dir: 'ltr' }, sub) : null), extra ?? null); if (fam) void ensureFace(fam); return r; };
    const draw = async () => {
      const lib = await F.library(); const cur = getPrefs().subFont;
      const known = new Set(lib.flatMap((x) => x.families));
      sh.body.replaceChildren(
        h('p', { class: 'hint' }, t('subFontHint')),
        row('', t('subFontSystem'), ''),
        ...lib.map((x) => row(x.families[0] ?? x.file, x.families[0] ?? x.file, `${x.file} · ${formatBytes(x.size)}`, iconButton('trash', t('remove'), (ev) => { ev.stopPropagation(); void F.removeFont(x.id).then(() => { if (x.families.includes(getPrefs().subFont)) pick(''); else void draw(); }); }))),
        ...(cur && !known.has(cur) ? [row(cur, cur, t('subFontInstalled'))] : []),
        file,
        h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn tonal', onclick: () => file.click() }, icon('plus'), t('subFontAdd'))),
      );
    };
    await draw();
  };
  return [
    h('div', { class: 'row' }, h('span', null, t('subFont')), h('button', { type: 'button', class: 'btn tonal small sub-font-btn', onclick: () => void choose() }, icon('type'), name)),
    h('label', { class: 'row switch-row' }, h('span', null, t('subFontAss'), h('small', { class: 'src' }, t('subFontAssHint'))), h('input', { type: 'checkbox', checked: getPrefs().subFontAss, onchange: (e: Event) => { updatePrefs({ subFontAss: (e.target as HTMLInputElement).checked }); changed(); } })),
  ];
}
