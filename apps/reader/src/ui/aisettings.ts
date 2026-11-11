// Provider, key, model, language and instructions for the AI features (shared by
// the translator pill and Settings). Choice lists open as stacked M3 sheets.
import { kittenPanel } from './kittenpanel';
import { copyText } from './share';
import { h, icon, iconButton, openSheet, pickButton, pickSheet, toast } from './dom';
import { t, isRtlText, localDigits } from '../i18n';
import { getSettings, updateSettings, type VisualSettings } from '../settings';
import { PROVIDERS, providerInfo, effectiveModel, defaultPrompt, langName, AI_VOICES, listModels, customApis, activeCustom, usageOf, testApi, appGet, type AiProvider, type CustomApi } from '../ai';
import { candidatesFor, probe, detectAt, SERVICES, type Detected, type KnownService, type ModelInfo } from '../aiDetect';

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

  const local = localPanel();
  const cloudFields: HTMLElement[] = [];
  const custom = customPanel(() => { modelLine.textContent = `${t('aiModel')}: ${effectiveModel()}`; });
  const syncLocal = () => { const p = getSettings().aiProvider; const on = p === 'local'; local.hidden = !on; custom.hidden = p !== 'custom'; for (const f of cloudFields) f.hidden = on || p === 'custom'; };
  const prov = pickButton<AiProvider>(t('aiProvider'), PROVIDERS.map((p) => [p.id, p.id === 'local' ? t('localModelProvider') : p.id === 'custom' ? t('customApiProvider') : p.label]), s.aiProvider, (v) => {
    updateSettings({ aiProvider: v }); syncLocal();
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
  // (The glossary: names and terms always rendered the same.)
  const glossaryBtn = h('button', { type: 'button', class: 'btn tonal small', onclick: () => void import('./glossarysheet').then((m) => m.glossarySheet()) }, icon('define'), t('glossary'));
  const promptField = field(t('aiPrompt'), h('div', { style: { display: 'grid', gap: '8px' } }, prompt, prefillRow, h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, glossaryBtn, h('span', { style: { flex: '1' } }), iconButton('copy', t('copyPrompt'), () => void copyText(prompt.value.trim() ? prompt.value : defaultPrompt(getSettings().aiTarget))))), t('aiPromptHint'));
  langField.hidden = s.aiTask !== 'translate'; promptField.hidden = s.aiTask !== 'translate';

  // Read-aloud engine and AI voice live here too (same key / provider).
  const engine = pickButton<VisualSettings['speechEngine']>(t('speechEngine'), [['system', t('speechSystem'), 'speak'], ['kitten', t('speechKitten'), 'download'], ['ai', t('speechAi'), 'translate']], s.speechEngine, (v) => { updateSettings({ speechEngine: v }); voiceField.hidden = v !== 'ai'; ttsField.hidden = v !== 'ai'; kittenField.hidden = v !== 'kitten'; }, t('close'));
  const kittenField = h('div', { class: 'field' }, h('span', { class: 'label' }, t('speechKitten')), kittenPanel()); kittenField.hidden = s.speechEngine !== 'kitten';
  const voicesOf = () => AI_VOICES[s.aiProvider === 'openrouter' || s.aiProvider === 'custom' ? 'openai' : getSettings().aiProvider] ?? AI_VOICES.openai;
  const voice = pickButton(t('aiVoice'), voicesOf().map((v): [string, string] => [v, v]), s.aiVoice || voicesOf()[0], (v) => updateSettings({ aiVoice: v }), t('close'));
  const tts = h('input', { type: 'text', value: s.aiTtsModel, dir: 'ltr', spellcheck: 'false', placeholder: s.aiProvider === 'gemini' ? 'gemini-2.5-flash-preview-tts' : 'gpt-4o-mini-tts', onchange: () => updateSettings({ aiTtsModel: tts.value.trim() }) }) as HTMLInputElement;
  const voiceField = field(t('aiVoice'), voice); const ttsField = field(t('aiTtsModel'), tts);
  voiceField.hidden = s.speechEngine !== 'ai'; ttsField.hidden = s.speechEngine !== 'ai';

  sh.body.append(
    h('p', { class: 'src' }, t('aiTranslateBody')),
    field(t('aiTask'), task),
    field(t('aiProvider'), prov),
    local,
    custom,
    ...(cloudFields.push(
      field('API key', h('div', { style: { display: 'flex', gap: '8px' } }, key, keyLink)),
      field(t('aiModel'), h('div', { style: { display: 'flex', gap: '8px' } }, model, modelsBtn), t('aiModelHint')),
      field(t('aiBaseUrl'), url)), cloudFields),
    langField,
    promptField,
    modelLine,
    ...(extra ? [extra] : []),
    h('h4', { class: 'upd-title', style: { marginTop: '14px' } }, t('readAloud')),
    field(t('speechEngine'), engine),
    field(t('speechScope'), pickButton<VisualSettings['speechScope']>(t('speechScope'), [['chapter', t('speechChapter'), 'books'], ['book', t('speechBook'), 'library']], s.speechScope, (v) => updateSettings({ speechScope: v }), t('close'))),
    kittenField,
    voiceField,
    ttsField,
  );
  syncLocal();
  sh.actions.append(
    h('button', { class: 'btn small', type: 'button', onclick: () => { prompt.value = defaultPrompt(getSettings().aiTarget); updateSettings({ aiPrompt: '' }); promptDir(); prompt.focus(); } }, icon('type'), t('insertDefaultPrompt')),
    h('button', { class: 'btn small primary', type: 'button', onclick: () => { sh.close(); onDone?.(); } }, icon('check'), t('done')));
}

/* ---------- local models ---------- */

/** Local AI: a model run inside the app on this device, or a server on this computer or the network. */
function localPanel(): HTMLElement {
  const wrap = h('div', { class: 'local-ai' });
  const draw = async () => {
    const L = await import('../localai');
    const s = getSettings();
    const seg = h('div', { class: 'segmented' }, ...([['device', t('localOnDevice')], ['server', t('localServer')]] as ['device' | 'server', string][]).map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(s.localEngine === v), onclick: () => { updateSettings({ localEngine: v }); void draw(); } }, l)));
    const body = h('div', { class: 'local-body' });
    if (s.localEngine === 'device') {
      if (!L.deviceSupported()) body.append(h('p', { class: 'hint' }, t('localNoDevice')));
      const list = h('div', { class: 'local-models' });
      const inst = L.installed();
      const row = (id: string, name: string, meta: string, isIn: boolean, imported = false) => {
        const bar = h('div', { class: 'progress-bar', hidden: true }, h('span'));
        const status = h('small', { class: 'local-status' });
        const use = h('input', { type: 'radio', name: 'kr-local-model', checked: getSettings().localModel === id, disabled: !isIn, onchange: () => updateSettings({ localModel: id }) }) as HTMLInputElement;
        const act = isIn
          ? h('button', { class: 'icon-btn small', type: 'button', title: t('delete'), 'aria-label': t('delete'), onclick: async () => { await L.removeModel(id); void draw(); } }, icon('trash'))
          : h('button', { class: 'btn small tonal', type: 'button', onclick: async (e: Event) => {
            const b = e.currentTarget as HTMLButtonElement; b.disabled = true; bar.hidden = false;
            const fill = bar.firstElementChild as HTMLElement;
            try {
              await L.downloadModel(id, (d, tot) => { fill.style.width = tot ? `${(d / tot) * 100}%` : '30%'; status.textContent = tot ? `${Math.round(d / 1048576)} / ${Math.round(tot / 1048576)} MB` : t('working'); });
              if (!getSettings().localModel) updateSettings({ localModel: id });
              toast(t('localModelReady', { name }));
              void draw();
            } catch (err) { status.textContent = String((err as Error).message ?? err); b.disabled = false; bar.hidden = true; }
          } }, icon('download'), t('download'));
        return h('label', { class: 'local-row' + (isIn ? ' in' : '') }, use, h('span', { class: 'local-name' }, h('b', { dir: 'ltr' }, name), h('small', null, meta), status, bar), imported ? h('span', { class: 'chip small' }, t('localImported')) : null, act);
      };
      // (Sizes kept left to right inside a right-to-left line: "398 MB", not "MB 398".)
      const iso = (x: string) => `\u2066${x}\u2069`;
      for (const m of L.CATALOG) list.append(row(m.id, m.name, `${iso(m.sizeMB >= 1000 ? (m.sizeMB / 1024).toFixed(1) + ' GB' : m.sizeMB + ' MB')} · ${t('localRam', { ram: iso(m.ram) })} · ${t(m.note === 'fast' ? 'localFast' : m.note === 'best' ? 'localBest' : m.note === 'balanced' ? 'localBalanced' : 'localMultilingual')}`, inst.some((x) => x.id === m.id)));
      for (const m of inst.filter((x) => x.imported)) list.append(row(m.id, m.name, iso(`${m.sizeMB} MB`), true, true));
      const importBtn = h('button', { class: 'btn small', type: 'button', onclick: () => {
        const input = h('input', { type: 'file', accept: '.gguf', style: { display: 'none' } }) as HTMLInputElement;
        input.addEventListener('change', async () => {
          const f = input.files?.[0]; input.remove(); if (!f) return;
          importBtn.disabled = true; const label = importBtn.textContent;
          try { const id = await L.importModel(f, (d, tot) => { importBtn.textContent = `${Math.round((d / tot) * 100)}%`; }); updateSettings({ localModel: id }); toast(t('localModelReady', { name: f.name })); void draw(); }
          catch (err) { toast(String((err as Error).message) === 'gguf' ? t('localNeedsGguf') : String((err as Error).message ?? err), 'error', 5000); }
          finally { importBtn.disabled = false; importBtn.textContent = label; }
        });
        document.body.append(input); input.click();
      } }, icon('folder'), t('localImport'));
      body.append(list, h('div', { class: 'tool-bar' }, importBtn), h('p', { class: 'hint' }, t('localDeviceHint')));
    } else {
      const url = h('input', { type: 'text', dir: 'ltr', spellcheck: 'false', value: s.localServer, placeholder: 'http://localhost:11434/v1', onchange: () => updateSettings({ localServer: url.value.trim() }) }) as HTMLInputElement;
      const found = h('div', { class: 'local-models' });
      const findBtn = h('button', { class: 'btn small tonal', type: 'button', onclick: async () => {
        findBtn.disabled = true; found.replaceChildren(h('p', { class: 'src' }, t('localSearching')));
        try {
          const host = /^https?:\/\/([^/:]+)/.exec(url.value.trim())?.[1] ?? 'localhost';
          const list = [...await L.findServers('localhost'), ...(host !== 'localhost' && host !== '127.0.0.1' ? await L.findServers(host) : [])];
          found.replaceChildren(...(list.length ? list.map((sv) => h('button', { type: 'button', class: 'local-row', onclick: () => { url.value = sv.url; updateSettings({ localServer: sv.url, localServerModel: sv.models[0] ?? '' }); void draw(); } }, icon('target'), h('span', { class: 'local-name' }, h('b', null, sv.name), h('small', { dir: 'ltr' }, `${sv.url} · ${t('localModelsN', { n: sv.models.length })}`)))) : [h('p', { class: 'hint' }, t('localNoServers'))]));
        } finally { findBtn.disabled = false; }
      } }, icon('search'), t('localFind'));
      const modelBtn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
        try { const names = await L.serverModels(getSettings().localServer || url.value.trim()); if (!names.length) { toast(t('noModelsFound'), 'error'); return; }
          pickSheet(t('browseModels'), names.map((n): [string, string] => [n, n]), getSettings().localServerModel, (v) => { updateSettings({ localServerModel: v }); void draw(); }, t('close')); }
        catch (err) { toast(String((err as Error).message ?? err), 'error', 5000); }
      } }, icon('search'), getSettings().localServerModel || t('browseModels'));
      body.append(h('div', { class: 'field' }, h('span', { class: 'label' }, t('aiBaseUrl')), h('div', { style: { display: 'flex', gap: '8px' } }, url, findBtn)), found,
        h('div', { class: 'field' }, h('span', { class: 'label' }, t('aiModel')), modelBtn), h('p', { class: 'hint' }, t('localServerHint')));
    }
    const tryBtn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
      tryBtn.disabled = true; const label = tryBtn.textContent; tryBtn.textContent = t('working');
      try { const { translateOne } = await import('../ai'); const out = await translateOne('The book is on the table.'); toast(out || '—', 'info', 6000); }
      catch (err) { toast(String((err as Error).message ?? err), 'error', 6000); }
      finally { tryBtn.disabled = false; tryBtn.textContent = label; }
    } }, icon('play'), t('localTry'));
    wrap.replaceChildren(h('div', { class: 'field' }, h('span', { class: 'label' }, t('localWhere')), seg), body, h('div', { class: 'tool-bar' }, tryBtn));
  };
  void draw();
  return wrap;
}

/* ---------- custom APIs: any service, told apart from its key, its models listed with what it says of them ---------- */
const kTok = (n?: number) => (n ? (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)) : '');
const price = (n?: number) => (n === undefined ? '' : n === 0 ? '0' : n < 0.01 ? n.toFixed(4) : n < 1 ? n.toFixed(2) : n.toFixed(n < 10 ? 2 : 0));
function badges(m: { free?: boolean; priceIn?: number; priceOut?: number; context?: number; output?: number; active?: boolean }): HTMLElement {
  return h('span', { class: 'api-badges' },
    ...(m.free ? [h('b', { class: 'api-badge free' }, t('apiFree'))] : m.priceIn !== undefined ? [h('b', { class: 'api-badge paid', dir: 'ltr', title: t('apiPriceHint') }, `$${price(m.priceIn)} / $${price(m.priceOut)}`)] : []),
    ...(m.context ? [h('b', { class: 'api-badge', dir: 'ltr', title: t('apiContextHint') }, `${kTok(m.context)} ${t('apiIn')}`)] : []),
    ...(m.output ? [h('b', { class: 'api-badge', dir: 'ltr' }, `${kTok(m.output)} ${t('apiOut')}`)] : []),
    ...(m.active === false ? [h('b', { class: 'api-badge off' }, t('apiUnavailable'))] : []));
}
function usageLine(model: string, c?: CustomApi): HTMLElement {
  const u = usageOf(model); if (!u.req) return h('small', { class: 'src' }, t('apiNoUse'));
  const cost = (tin: number, tout: number) => (c?.priceIn !== undefined && !c.free ? ` · ≈ $${price(((tin * (c.priceIn ?? 0)) + (tout * (c.priceOut ?? 0))) / 1e6)}` : '');
  return h('small', { class: 'src', dir: 'auto' }, t('apiUsage', { today: localDigits(u.dReq), tin: localDigits(kTok(u.dIn) || '0'), tout: localDigits(kTok(u.dOut) || '0'), all: localDigits(u.req) }) + cost(u.dIn, u.dOut));
}
function customPanel(changed: () => void): HTMLElement {
  const wrap = h('div', { class: 'custom-apis' });
  const draw = () => {
    const list = customApis(); const cur = activeCustom();
    wrap.replaceChildren(h('p', { class: 'hint' }, t('apiCustomHint')),
      ...list.map((c) => h('div', { class: 'api-card' + (cur?.id === c.id ? ' on' : '') },
        h('label', { class: 'api-pick' }, h('input', { type: 'radio', name: 'kr-api', checked: cur?.id === c.id, onchange: () => { updateSettings({ aiCustomId: c.id }); draw(); changed(); } }),
          h('span', { class: 'grow' }, h('b', { dir: 'auto' }, c.name), h('small', { class: 'src', dir: 'ltr' }, `${c.model} · ${c.style === 'openai' ? 'OpenAI' : c.style === 'anthropic' ? 'Anthropic' : 'Gemini'} API`), badges(c), usageLine(c.model, c))),
        h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn text small', onclick: () => apiSheet(c, () => { draw(); changed(); }) }, icon('pen'), t('edit')), h('button', { type: 'button', class: 'btn text small', onclick: () => { if (!confirm(t('apiRemoveAsk', { name: c.name }))) return; updateSettings({ aiCustomApis: customApis().filter((x) => x.id !== c.id) }); draw(); changed(); } }, icon('trash'), t('delete'))))),
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => apiSheet(null, () => { draw(); changed(); }) }, icon('plus'), t('apiAdd')));
  };
  draw();
  return wrap;
}
/** Adding (or changing) a custom API: the key (and its address, for a service not known by its key), the service
 *  found, its models listed with free/paid, price and token limits; one chosen, tried, kept. */
function apiSheet(edit: CustomApi | null, done: () => void): void {
  const sh = openSheet(edit ? edit.name : t('apiAdd'), t('close'), { stack: true }); sh.body.style.fontFamily = 'var(--font-ui)';
  const key = h('input', { type: 'password', dir: 'ltr', autocomplete: 'off', placeholder: t('apiKeyPh'), value: edit?.key ?? '' }) as HTMLInputElement;
  const url = h('input', { type: 'url', dir: 'ltr', placeholder: t('apiUrlPh'), value: edit && edit.service === 'custom' ? edit.base : '' }) as HTMLInputElement;
  const status = h('p', { class: 'src', 'aria-live': 'polite' }); const out = h('div', { class: 'api-found' });
  const go = h('button', { type: 'button', class: 'btn primary small' }, icon('search'), t('apiDetect')) as HTMLButtonElement;
  let found: Detected | null = null; let model = edit?.model ?? ''; let modelInfo: ModelInfo | undefined;
  const nameIn = h('input', { type: 'text', dir: 'auto', placeholder: t('apiName'), value: edit?.name ?? '' }) as HTMLInputElement;
  const headers = h('textarea', { rows: '2', dir: 'ltr', placeholder: '{"X-Header": "value"}', value: edit?.headers ?? '' }) as HTMLTextAreaElement; headers.value = edit?.headers ?? '';
  const record = (): CustomApi | null => { if (!found || !model) return null; return { id: edit?.id ?? Date.now().toString(36), name: nameIn.value.trim() || found.service.name, style: found.style, base: found.base, key: key.value.trim(), model, headers: headers.value.trim() || undefined, service: found.service.id, priceIn: modelInfo?.priceIn, priceOut: modelInfo?.priceOut, context: modelInfo?.context, free: modelInfo?.free }; };
  const showFound = (d: Detected) => {
    found = d; const search = h('input', { type: 'search', placeholder: t('apiFilterModels') }) as HTMLInputElement; const rows = h('div', { class: 'api-models' });
    const free = d.models.filter((m) => m.free).length;
    const drawRows = () => { const q = search.value.trim().toLowerCase(); rows.replaceChildren(...d.models.filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q)).slice(0, 250).map((m) => h('button', { type: 'button', class: 'api-model' + (m.id === model ? ' on' : ''), onclick: () => { model = m.id; modelInfo = m; drawRows(); test.disabled = false; save.disabled = false; } }, h('span', { class: 'grow' }, h('b', { dir: 'ltr' }, m.id), m.name && m.name !== m.id ? h('small', { class: 'src', dir: 'auto' }, m.name) : null), badges(m)))); };
    search.addEventListener('input', drawRows); modelInfo = d.models.find((m) => m.id === model); drawRows();
    out.replaceChildren(h('div', { class: 'api-service' }, icon('check'), h('b', null, d.service.name), h('small', { class: 'src', dir: 'ltr' }, `${d.style === 'openai' ? 'OpenAI' : d.style === 'anthropic' ? 'Anthropic' : 'Gemini'} API · ${d.base}`)),
      h('p', { class: 'src' }, t('apiModelsFound', { n: localDigits(d.models.length), free: localDigits(free) }), d.service.freeNote === 'tier' ? ` ${t('apiFreeTier')}` : ''),
      search, rows, nameIn, h('details', null, h('summary', null, t('apiHeaders')), headers));
    status.textContent = '';
  };
  const run = async (c?: KnownService) => {
    go.disabled = true; status.textContent = t('checking'); out.replaceChildren();
    try {
      const cands = c ? [c] : candidatesFor(key.value, url.value);
      if (!cands.length) { status.textContent = t('apiUnknownKey'); return; }
      // (A key whose form fits several services is sent to none of them unasked: the person says which.)
      if (cands.length > 1 && cands[0].id !== 'custom') { status.textContent = t('apiWhich'); out.replaceChildren(h('div', { class: 'chips' }, ...cands.map((x) => h('button', { type: 'button', class: 'chip', onclick: () => void run(x) }, x.name)))); return; }
      showFound(cands[0].id === 'custom' ? await detectAt(cands, key.value, appGet) : await probe(cands[0], key.value, appGet));
    } catch (e) { const st = (e as { status?: number }).status; status.textContent = st === 401 || st === 403 ? t('apiKeyRefused') : String((e as Error).message ?? e); }
    finally { go.disabled = false; }
  };
  go.addEventListener('click', () => void run());
  const test = h('button', { type: 'button', class: 'btn tonal', disabled: !edit, onclick: async () => { const r = record(); if (!r) return; test.disabled = true; status.textContent = t('apiTesting'); const res = await testApi(r); test.disabled = false; status.textContent = res.ok ? t('apiWorks', { s: localDigits((res.ms / 1000).toFixed(1)) }) : /\b402\b/.test(res.why ?? '') ? t('apiNeedsCredit') : /\b429\b/.test(res.why ?? '') ? t('apiLimited') : /\b40[13]\b/.test(res.why ?? '') ? t('apiKeyRefused') : res.why ?? ''; } }, icon('play'), t('apiTest')) as HTMLButtonElement;
  const save = h('button', { type: 'button', class: 'btn primary', disabled: !edit, onclick: () => { const r = record(); if (!r) return; updateSettings({ aiCustomApis: [...customApis().filter((x) => x.id !== r.id), r], aiCustomId: r.id, aiProvider: 'custom' }); sh.close(); done(); toast(t('apiSaved', { name: r.name })); } }, icon('check'), t('save')) as HTMLButtonElement;
  sh.body.append(h('p', { class: 'hint' }, t('apiAddHint')), key, url, h('div', { class: 'row-actions' }, go), status, out);
  sh.actions.append(test, save);
  if (edit) void run(SERVICES.find((x) => x.id === edit.service) ? { ...SERVICES.find((x) => x.id === edit.service)!, base: edit.base, style: edit.style } : { id: 'custom', name: edit.name, style: edit.style, base: edit.base });
}
