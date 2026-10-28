// The KittenTTS voice's own settings, shown in the AI settings and in the reader's read-aloud options: which
// model is on the device (download, remove), the voice, the speed, a line to hear.
import { h, icon, toast, pickButton } from './dom';
import { t, formatBytes, localDigits } from '../i18n';
import { getSettings, updateSettings } from '../settings';
import { KITTEN_MODELS, KITTEN_VOICES, installedKitten, downloadKitten, removeKitten, kittenSpeak, kittenSupported, kittenReady } from '../kittentts';

export function kittenPanel(onChange?: () => void): HTMLElement {
  const wrap = h('div', { class: 'kitten-panel' });
  const draw = () => {
    wrap.replaceChildren();
    if (!kittenSupported()) { wrap.append(h('p', { class: 'hint' }, t('notSupportedHere'))); return; }
    const s = getSettings(); const have = installedKitten();
    wrap.append(h('p', { class: 'hint' }, t('kittenBody')));
    const list = h('div', { class: 'dest-list' });
    for (const m of KITTEN_MODELS) {
      const on = have.includes(m.id); const chosen = s.kittenModel === m.id;
      const row = h('div', { class: 'local-model-row' + (chosen ? ' on' : '') });
      const text = h('span', { class: 'grow' }, h('b', null, `KittenTTS ${m.name}`), h('small', null, ` · ${formatBytes(m.sizeMB * 1024 * 1024)} · ${t(`kittenNote_${m.note.split(',')[0].replace(/\s.*/, '')}` as 'kittenNote_smallest') }`));
      row.append(text);
      if (on) {
        if (!chosen) row.append(h('button', { type: 'button', class: 'btn small tonal', onclick: () => { updateSettings({ kittenModel: m.id }); draw(); onChange?.(); } }, t('useThis')));
        else row.append(h('span', { class: 'badge' }, icon('check'), t('inUse')));
        row.append(h('button', { type: 'button', class: 'icon-btn', title: t('remove'), 'aria-label': t('remove'), onclick: async () => { await removeKitten(m.id); draw(); onChange?.(); } }, icon('trash')));
      } else {
        const btn = h('button', { type: 'button', class: 'btn small primary' }, icon('download'), t('download')) as HTMLButtonElement;
        btn.addEventListener('click', async () => {
          btn.disabled = true; const bar = h('span'); const track = h('span', { class: 'progress-bar small' }, bar); btn.replaceChildren(track, h('small', null, '0%'));
          try {
            await downloadKitten(m.id, (done, total) => { const pct = total ? Math.round((done / total) * 100) : 0; bar.style.width = `${pct}%`; (btn.lastChild as HTMLElement).textContent = `${localDigits(pct)}%`; });
            toast(t('kittenDownloaded', { name: m.name })); draw(); onChange?.();
          } catch (e) { btn.disabled = false; btn.replaceChildren(icon('download'), t('download')); toast(`${t('kittenDownloadFailed')} — ${String((e as Error).message ?? e)}`, 'error', 6000); }
        });
        row.append(btn);
      }
      list.append(row);
    }
    wrap.append(list);
    if (have.length) {
      const voice = pickButton(t('kittenVoice'), KITTEN_VOICES.map((v): [string, string] => [v.id, v.name]), s.kittenVoice || 'leo', (v) => { updateSettings({ kittenVoice: v }); onChange?.(); }, t('close'));
      const speedVal = h('b', null, `${(s.kittenSpeed ?? 1).toFixed(1)}×`);
      const speed = h('input', { type: 'range', min: '0.6', max: '1.6', step: '0.1', value: String(s.kittenSpeed ?? 1), oninput: () => { updateSettings({ kittenSpeed: Math.round(+speed.value * 10) / 10 }); speedVal.textContent = `${(+speed.value).toFixed(1)}×`; onChange?.(); } }) as HTMLInputElement;
      const test = h('button', { type: 'button', class: 'btn small tonal' }, icon('speak'), t('kittenTry')) as HTMLButtonElement;
      test.addEventListener('click', async () => {
        test.disabled = true; test.replaceChildren(h('span', { class: 'spinner small' }));
        try { const blob = await kittenSpeak(t('kittenSample')); const a = new Audio(URL.createObjectURL(blob)); a.onended = () => URL.revokeObjectURL(a.src); await a.play(); }
        catch (e) { toast(`${t('kittenFailed')} — ${String((e as Error).message ?? e)}`, 'error', 6000); }
        finally { test.disabled = false; test.replaceChildren(icon('speak'), t('kittenTry')); }
      });
      wrap.append(
        h('div', { class: 'field' }, h('span', { class: 'label' }, t('kittenVoice')), voice),
        h('div', { class: 'field' }, h('span', { class: 'label' }, t('kittenSpeed')), h('div', { class: 'lib-slider' }, speed, speedVal)),
        test);
      if (!kittenReady()) wrap.append(h('p', { class: 'hint' }, t('kittenPickOne')));
    }
  };
  draw();
  return wrap;
}
