// node tests/glossary.cjs: the translation glossary (src/glossary.ts) — the terms a passage holds, a book's own
// first, given to the model; a term it left as it was put right.
const esbuild = require('esbuild');
const store = {}; globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const code = esbuild.buildSync({ entryPoints: ['src/glossary.ts'], bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'error' }).outputFiles[0].text;
const m = { exports: {} }; new Function('module', 'exports', code)(m, m.exports); const G = m.exports;
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
G.saveTerms([{ id: '1', from: 'Lin Feng', to: 'لين فنغ' }, { id: '2', from: 'Azure Sect', to: 'الطائفة اللازوردية' }, { id: '3', from: 'Lin Feng', to: 'لين فِنغ', book: 'b1' }, { id: '4', from: 'Qi', to: 'التشي' }]);
const inB1 = G.termsIn(['Lin Feng joined the Azure Sect.'], 'b1');
ok('the terms a passage holds; the book\'s own rendering first', inB1.length === 2 && inB1[0].to === 'لين فِنغ' && inB1.some((x) => x.from === 'Azure Sect'), inB1);
ok('… the general one in another book; a term not there left out', G.termsIn(['Lin Feng smiled.'], 'b2').map((x) => x.to).join() === 'لين فنغ');
ok('given to the model as lines', /"Lin Feng" → "لين فِنغ"/.test(G.glossaryPrompt(inB1)));
ok('a term left untranslated put right', G.applyGlossary('ابتسم Lin Feng ثم مضى', inB1) === 'ابتسم لين فِنغ ثم مضى');
const s1 = G.glossaryStamp(); G.saveTerms(G.terms().slice(1)); ok('a changed glossary changes the stamp (translations made again)', s1 && s1 !== G.glossaryStamp());
// Each term for the language it renders into: English names stay out of an Arabic translation.
G.saveTerms([{ id: 'a', from: 'Keyaru', to: 'كيارو', lang: 'ar' }, { id: 'b', from: 'Keyaru', to: 'Keyaru', lang: 'en' }, { id: 'c', from: 'Jioral', to: 'Jioral Kingdom' }, { id: 'd', from: 'Flare', to: 'فلير' }]);
const ar = G.termsIn(['Keyaru met Flare in Jioral.'], 'b1', 'ar').map((x) => x.to); const en = G.termsIn(['Keyaru met Flare in Jioral.'], 'b1', 'en').map((x) => x.to);
ok('into Arabic: the Arabic renderings only (one in English letters left out)', ar.join() === 'كيارو,فلير', ar);
// («Jioral Kingdom» has no language and Latin letters: made before languages were kept, while Arabic was chosen —
// the language it was made for cannot be known, so it is used for none and shown as «language not set».)
ok('into English: the English ones (an old Latin term without a language is not taken as English)', en.join() === 'Keyaru', en);
ok('… that old term kept, its language not set', G.terms().some((x) => x.id === 'c' && !x.lang) && G.termLang(G.terms().find((x) => x.id === 'c')) === '');
ok('the same name kept for both languages, not taken for a double', G.terms().filter((x) => x.from === 'Keyaru').length === 2);
// Doubles merged: the same name twice in one place — the one written by hand kept.
G.saveTerms([{ id: 'x', from: 'Lin Feng', to: 'لين فينغ', book: 'b1', auto: true, lang: 'ar' }, { id: 'y', from: 'lin feng', to: 'لين فنغ', book: 'b1', lang: 'ar' }]);
ok('doubles merged, the hand-written one kept', G.terms().length === 1 && G.terms()[0].id === 'y');
ok('one added again is not doubled', G.addTerms([{ from: 'Lin Feng', to: 'لين', book: 'b1', lang: 'ar', auto: true }]) === 0 && G.terms().length === 1);
// Folders: a series' names, for the books that use it.
const f = G.addFolder('Series'); G.addTerms([{ from: 'Setsuna', to: 'سيتسونا', folder: f.id, lang: 'ar' }]);
ok('a folder\'s names not for a book that does not use it', !G.termsIn(['Setsuna'], 'b2', 'ar').length);
G.setLinked('b2', [f.id]); ok('… and for one that does', G.termsIn(['Setsuna'], 'b2', 'ar').length === 1);
// Where found names go: a folder made by itself for the series, found again for the next volume.
ok('a series\' name from a volume\'s title', G.seriesOf('回復術士のやり直し 8 ～即死魔法とスキルコピー～') === '回復術士のやり直し' && G.seriesOf('Overlord Vol. 3: The Bloody Valkyrie') === 'Overlord', [G.seriesOf('回復術士のやり直し 8 ～即死魔法とスキルコピー～'), G.seriesOf('Overlord Vol. 3: The Bloody Valkyrie')]);
G.setDest('v8', { to: 'auto', addNew: true }); const p8 = G.namesTarget('v8', 'Overlord Vol. 8'); G.setDest('v9', { to: 'auto', addNew: true }); const p9 = G.namesTarget('v9', 'Overlord Vol. 9');
ok('the series folder made once, used by both volumes', !!p8.folder && p8.folder === p9.folder && G.linkedFolders('v9').includes(p8.folder));
G.setDest('v10', { to: p8.folder, addNew: false }); ok('a folder only used: new names stay with the book', G.namesTarget('v10', 'x').book === 'v10' && G.linkedFolders('v10').includes(p8.folder));
// Putting right what the model left: whole words in scripts written with spaces, the longest term first, the
// rendering taken as it is written (no «$&» or «$1» read in it); Arabic and Japanese words met inside longer ones.
const T = (from, to) => ({ id: from, from, to });
ok('a term inside a longer word left alone (Lin in Linda)', G.applyGlossary('Linda met Lin.', [T('Lin', 'لين')]) === 'Linda met لين.', G.applyGlossary('Linda met Lin.', [T('Lin', 'لين')]));
ok('… and Ren not taken out of Karen\'s middle, nor of «Ren\'s» end', G.applyGlossary("Karen saw Ren's sword", [T('Ren', 'رين')]) === "Karen saw رين's sword", G.applyGlossary("Karen saw Ren's sword", [T('Ren', 'رين')]));
ok('the longest term first, whatever their order', G.applyGlossary('ثم جاء Lin Feng.', [T('Lin', 'لين'), T('Lin Feng', 'لين فنغ')]) === 'ثم جاء لين فنغ.', G.applyGlossary('ثم جاء Lin Feng.', [T('Lin', 'لين'), T('Lin Feng', 'لين فنغ')]));
ok('a rendering with «$&» and «$1» kept as written', G.applyGlossary('Gold coins', [T('Gold', '$& $1 $$')]) === '$& $1 $$ coins', G.applyGlossary('Gold coins', [T('Gold', '$& $1 $$')]));
ok('one replacement not replaced again by another term', G.applyGlossary('Azure', [T('Azure', 'Sky Sect'), T('Sky', 'سماء')]) === 'Sky Sect', G.applyGlossary('Azure', [T('Azure', 'Sky Sect'), T('Sky', 'سماء')]));
// Arabic: a name with «و» or «بـ» joined to it is still the name (the letters before it are not a word break).
ok('Arabic: a name with a prefix joined to it still put right', G.applyGlossary('وكيارو قال لفلير', [T('كيارو', 'Keyaru'), T('فلير', 'Flare')]) === 'وKeyaru قال لFlare', G.applyGlossary('وكيارو قال لفلير', [T('كيارو', 'Keyaru'), T('فلير', 'Flare')]));
ok('Arabic: the longer name first («لين فنغ» over «لين»)', G.applyGlossary('قال لين فنغ', [T('لين', 'Lin'), T('لين فنغ', 'Lin Feng')]) === 'قال Lin Feng', G.applyGlossary('قال لين فنغ', [T('لين', 'Lin'), T('لين فنغ', 'Lin Feng')]));
// Japanese: no spaces between words, so a name is found inside the sentence; the longer one wins.
ok('Japanese: a name in a sentence without spaces put right', G.applyGlossary('ケヤルは笑った', [T('ケヤル', 'Keyaru')]) === 'Keyaruは笑った', G.applyGlossary('ケヤルは笑った', [T('ケヤル', 'Keyaru')]));
ok('Japanese: the longer name first (ケヤルガ over ケヤル)', G.applyGlossary('ケヤルガは笑った', [T('ケヤル', 'Keyaru'), T('ケヤルガ', 'Keyaruga')]) === 'Keyarugaは笑った', G.applyGlossary('ケヤルガは笑った', [T('ケヤル', 'Keyaru'), T('ケヤルガ', 'Keyaruga')]));
ok('an English name left in Japanese text still put right (the kana beside it is not part of it)', G.applyGlossary('Keyaruは笑った', [T('Keyaru', 'ケヤル')]) === 'ケヤルは笑った', G.applyGlossary('Keyaruは笑った', [T('Keyaru', 'ケヤル')]));
// ---- Every term for the language it renders into (R3b): for every language, not Arabic alone. ----
const reset = (target) => { for (const k of Object.keys(store)) delete store[k]; store['kr.visual'] = JSON.stringify({ aiTarget: target }); G._forgetLegacy(); G.saveTerms([]); };
const V = G.scriptVerdict;
ok('a rendering in Latin letters is plainly not Arabic, Persian, Japanese, Chinese, Korean, Russian, Greek, Hebrew, Thai, Hindi', ['ar', 'fa', 'ur', 'ja', 'zh-CN', 'ko', 'ru', 'el', 'he', 'th', 'hi'].every((l) => V('Keyaru', l) === 'bad'), ['ar', 'fa', 'ja', 'zh-CN', 'ko', 'ru', 'el', 'he', 'th', 'hi'].map((l) => V('Keyaru', l)));
ok('… and each in its own script is', V('كيارو', 'ar') === 'ok' && V('کیارو', 'fa') === 'ok' && V('ケヤル', 'ja') === 'ok' && V('剣崎', 'ja') === 'ok' && V('凯亚鲁', 'zh-CN') === 'ok' && V('케야루', 'ko') === 'ok' && V('Кеяру', 'ru') === 'ok' && V('Κεγιαρού', 'el') === 'ok' && V('קיארו', 'he') === 'ok' && V('เคยารุ', 'th') === 'ok' && V('केयारू', 'hi') === 'ok');
ok('kana is not Chinese; an Arabic or kana rendering is not English or French', V('ケヤル', 'zh-CN') === 'bad' && V('كيارو', 'en') === 'bad' && V('ケヤル', 'fr') === 'bad');
ok('English and French share a script: no test possible (the language kept with the term decides)', V('Keyaru', 'fr') === 'ok' && V('Keyaru', 'en') === 'ok');
ok('a language whose script is not known: unknown, not refused', V('Keyaru', 'xx') === 'unknown');
// A term tagged for a language but written in another script (the name finder's «Keyaru» kept as Arabic): not used.
reset('ar');
G.saveTerms([{ id: 'k1', from: 'ケヤル', to: 'Keyaru', lang: 'ar', auto: true }, { id: 'k2', from: 'フレア', to: 'فلير', lang: 'ar', auto: true }]);
const arK = G.termsIn(['ケヤルとフレア'], 'b', 'ar').map((x) => x.to);
ok('into Arabic: a term kept as Arabic but in Latin letters is not used (nor sent to the model)', arK.join() === 'فلير', arK);
ok('… and is still kept (not deleted), marked as in the wrong script', G.terms().some((x) => x.id === 'k1') && G.misScripted(G.terms().find((x) => x.id === 'k1')));
ok('… the name finder\'s Arabic rendering then takes its place (it was the translator\'s)', G.addTerms([{ from: 'ケヤル', to: 'كيارو', lang: 'ar', auto: true }]) === 1 && G.terms().find((x) => x.id === 'k1').to === 'كيارو');
G.saveTerms([{ id: 'h1', from: 'ケヤル', to: 'Keyaru', lang: 'ar' }]); G.addTerms([{ from: 'ケヤル', to: 'كيارو', lang: 'ar', auto: true }]);
ok('… one written by hand is never rewritten by it', G.terms().find((x) => x.id === 'h1').to === 'Keyaru');
// The same name for several languages in one place: each kept (an English one no longer replaced by a French one,
// an Arabic one by a Persian one).
reset('ar');
G.saveTerms([{ id: 'e', from: 'Keyaru', to: 'Keyaru', lang: 'en' }, { id: 'f', from: 'Keyaru', to: 'Kéyaru', lang: 'fr' }, { id: 'a', from: 'Keyaru', to: 'كيارو', lang: 'ar' }, { id: 'p', from: 'Keyaru', to: 'کیارو', lang: 'fa' }, { id: 'j', from: 'Keyaru', to: 'ケヤル', lang: 'ja' }]);
ok('the same name kept for English, French, Arabic, Persian and Japanese side by side', G.terms().length === 5, G.terms().map((x) => x.id));
const pick = (l) => G.termsIn(['Keyaru smiled.'], 'b', l).map((x) => x.to).join();
ok('switching ar → ja → fr → fa → en: each language\'s own term', pick('ar') === 'كيارو' && pick('ja') === 'ケヤル' && pick('fr') === 'Kéyaru' && pick('fa') === 'کیارو' && pick('en') === 'Keyaru', ['ar', 'ja', 'fr', 'fa', 'en'].map(pick));
ok('a language with no term of its own: the name has no rendering yet', pick('ko') === '' && pick('de') === '');
ok('… and the glossary handed to the model names the language', /renderings in Arabic/.test(G.glossaryPrompt(G.termsIn(['Keyaru'], 'b', 'ar'), 'Arabic')));
// Terms made before languages were kept: never rewritten; used only for the language they can be known to be for.
reset('ar');
const old = [{ id: 'o1', from: 'Lin Feng', to: 'لين فنغ' }, { id: 'o2', from: 'Azure Sect', to: 'Azure Sect' }, { id: 'o3', from: 'Min', to: '민' }, { id: 'o4', from: 'Ren', to: 'レン' }];
store['kr.glossary'] = JSON.stringify(old); G._forgetLegacy();
// (A fresh read, as at the app's start.)
const G2 = (() => { const m2 = { exports: {} }; new Function('module', 'exports', code)(m2, m2.exports); return m2.exports; })();
const l2 = G2.terms();
ok('old terms without a language all kept, none given one in storage', l2.length === 4 && JSON.parse(store['kr.glossary']).every((x) => !x.lang), l2);
ok('… the language they were made for taken from the one chosen when first met (Arabic), kept once', store['kr.glossaryLegacyLang'] === 'ar' && G2.termLang(l2[0]) === 'ar');
ok('… an old Arabic-script term used for Arabic only, not for Persian or Urdu', G2.termsIn(['Lin Feng'], 'b', 'ar').length === 1 && !G2.termsIn(['Lin Feng'], 'b', 'fa').length && !G2.termsIn(['Lin Feng'], 'b', 'ur').length);
ok('… an old Latin one used for no language (not English, French, Spanish…), its language not set', ['ar', 'en', 'fr', 'es'].every((l) => !G2.termsIn(['Azure Sect'], 'b', l).length) && G2.termLang(l2[1]) === '');
ok('… a script one language alone uses tells its language (Korean, Japanese kana)', G2.termLang(l2[2]) === 'ko' && G2.termLang(l2[3]) === 'ja' && G2.termsIn(['Min'], 'b', 'ko').length === 1 && !G2.termsIn(['Min'], 'b', 'zh-CN').length);
ok('… and the language set by the reader is then the one used', (G2.saveTerms(G2.terms().map((x) => (x.id === 'o2' ? { ...x, lang: 'en' } : x))), G2.termsIn(['Azure Sect'], 'b', 'en').length === 1 && !G2.termsIn(['Azure Sect'], 'b', 'fr').length));
// Pasted or imported lines without a language: the one translated into when the rendering can be in it.
ok('pasted: an Arabic rendering kept as Arabic; an English one not taken for Arabic; a Korean one as Korean', G.langForNew('كيارو', 'ar') === 'ar' && G.langForNew('Keyaru', 'ar') === '' && G.langForNew('케야루', 'ar') === 'ko' && G.langForNew('Keyaru', 'fr') === 'fr');
// The stored format: read by the version before (the same fields; `lang` was already optional).
reset('ar'); G.saveTerms([{ id: 's', from: 'Keyaru', to: 'كيارو', lang: 'ar', kind: 'person', book: 'b1' }]);
ok('stored as before: an array of {id, from, to, lang, kind, book}', JSON.stringify(JSON.parse(store['kr.glossary'])[0]) === JSON.stringify({ id: 's', from: 'Keyaru', to: 'كيارو', lang: 'ar', kind: 'person', book: 'b1' }));
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
