// node tests/glossarytidy.cjs: the glossary's repeats (one key for «the same name», merged without losing a rendering),
// deleting a folder / a file / every glossary (nothing left in storage, Undo exact, the folder not made again by
// itself) and the search across languages (src/glossary.ts, src/glosssearch.ts). No browser, no network.
const esbuild = require('esbuild');
const store = {}; globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
const load = (f) => { const code = esbuild.buildSync({ entryPoints: [f], bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'error' }).outputFiles[0].text; const m = { exports: {} }; new Function('module', 'exports', code)(m, m.exports); return m.exports; };
// (One module instance for both: the search file imports the glossary, so it is bundled with its own copy — the lists are passed in.)
const G = load('src/glossary.ts'); const S = load('src/glosssearch.ts');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const wipe = () => { for (const k of Object.keys(store)) delete store[k]; G._forgetLegacy(); G.saveTerms([]); };
const T = (id, from, to, o = {}) => ({ id, from, to, lang: 'ar', kind: 'person', ...o });
const keys = () => Object.keys(store).filter((k) => /^kr\.glossary/.test(k)).sort();

// ---- Part B: the one key ----
ok('the key folds case, width, NFKC, spaces and trailing punctuation', ['Lin Feng', 'LIN FENG', 'ＬＩＮ　ＦＥＮＧ', ' lin   feng ', 'Lin Feng.', 'Lin-Feng', '“Lin Feng”'].every((x) => G.termKey(x) === 'lin feng'), ['Lin Feng', 'ＬＩＮ　ＦＥＮＧ', 'Lin-Feng'].map(G.termKey));
ok('… Arabic: vowel signs, tatweel, hamza and alef forms, ى/ي, ة/ه', new Set(['أحمد', 'احمد', 'إحمد', 'آحمد', 'أَحْمَد', 'أحـــمد'].map(G.termKey)).size === 1 && G.termKey('مدينة') === G.termKey('مدينه') && G.termKey('على') === G.termKey('علي') && G.termKey('مؤمن') === G.termKey('مومن') && G.termKey('كتاب') !== G.termKey('كتب'), ['أحمد', 'أَحْمَد'].map(G.termKey));
ok('… the dagger alef (long vowel mark) folded: «الرَّحْمٰن» = «الرحمن»', G.termKey('الرَّحْمٰن') === G.termKey('الرحمن'));
ok('… kana: katakana = hiragana, half-width katakana too; ・ and spaces loosened', G.termKey('ケヤル') === G.termKey('けやる') && G.termKey('ｹﾔﾙ') === G.termKey('けやる') && G.termKey('ケヤル・ガ') === G.termKey('ケヤル ガ') && G.termKey('が') !== G.termKey('か'));
ok('… a name of symbols alone keeps its own letters (not an empty key)', G.termKey('???') !== '' && G.termKey('★') !== '');
wipe();
// 1. one name written five ways in one place, saved together: one entry, every rendering kept
G.saveTerms([T('a', 'Lin Feng', 'لين فنغ', { book: 'b1' }), T('b', 'ＬＩＮ ＦＥＮＧ', 'لين فينغ', { book: 'b1' }), T('c', 'lin feng.', 'لين فنج', { book: 'b1', auto: true }), T('d', ' Lin  Feng ', 'لين فنغ', { book: 'b1', kind: 'place' })]);
let l = G.terms();
ok('the same name written differently: one entry, the earlier (hand-written) kept', l.length === 1 && l[0].id === 'a' && l[0].from === 'Lin Feng', l);
ok('… every different rendering kept as an alternative (none lost, none doubled)', JSON.stringify(l[0].alts) === JSON.stringify(['لين فينغ', 'لين فنج']), l[0].alts);
// 2. the one edited by the user wins over a detected one
wipe(); G.saveTerms([T('x', 'Keyaru', 'كيارو', { auto: true, book: 'b' }), T('y', 'keyaru', 'كيارُو', { book: 'b' })]);
ok('a detected entry gives way to the one edited by the user (hand-written first even when later)', G.terms().length === 1 && G.terms()[0].id === 'y' && !G.terms()[0].auto);
// 3. the same term in two files (kinds) of one folder
wipe(); const f = G.addFolder('Series'); G.saveTerms([T('p', 'Azure Sect', 'الطائفة', { folder: f.id, kind: 'group' }), T('q', 'Azure Sect', 'الطائفة اللازوردية', { folder: f.id, kind: 'place' }), T('r', 'Azure Sect', 'Azure', { folder: f.id, kind: 'group', lang: 'en' })]);
ok('the same term in two files of one folder: one entry; another language kept apart', G.terms().filter((x) => x.lang === 'ar').length === 1 && G.terms().length === 2 && G.terms().find((x) => x.lang === 'ar').alts.length === 1);
// 4. a book's own term its folder holds as it is
wipe(); const f2 = G.addFolder('Shared'); G.setLinked('b1', [f2.id]);
store['kr.glossary'] = JSON.stringify([T('f1', 'Wen Yu', 'ون يو', { folder: f2.id }), T('b1', 'wen yu', 'ون يو', { book: 'b1' }), T('b2', 'Min', 'مين', { book: 'b1' }), T('f2', 'Min', 'مِن', { folder: f2.id })]); G._forgetLegacy();
const GL = load('src/glossary.ts'); l = GL.terms();   // (as at the app's start: the tidy on load)
ok('a book\'s own term equal to its folder\'s (same rendering) is not kept twice', !l.some((x) => x.id === 'b1') && l.some((x) => x.id === 'f1'), l.map((x) => x.id));
ok('… a different rendering in the book is its own override, kept', l.some((x) => x.id === 'b2') && GL.termsFor('b1', 'ar').find((x) => G.termKey(x.from) === 'min').to === 'مين');
// 5. detection run twice / on the next chapter
wipe(); const d1 = G.addTerms([{ from: 'Keyaru', to: 'كيارو', kind: 'person', auto: true, lang: 'ar', book: 'b' }, { from: 'Flare', to: 'فلير', kind: 'person', auto: true, lang: 'ar', book: 'b' }]);
const d2 = G.addTerms([{ from: 'ケヤル', to: 'x', lang: 'ar', auto: true, book: 'b' }, { from: 'Keyaru', to: 'كيارو', kind: 'person', auto: true, lang: 'ar', book: 'b' }, { from: 'ＦＬＡＲＥ', to: 'فلير', kind: 'person', auto: true, lang: 'ar', book: 'b' }]);
ok('detection run twice: nothing doubled (width and case folded), the count says how many were new', d1 === 2 && d2 === 1 && G.terms().length === 3, [d1, d2, G.terms().length]);
G.addTerms([{ from: 'Keyaru', to: 'كايارو', auto: true, lang: 'ar', book: 'b' }]);
ok('… a different rendering found later is kept beside, not dropped', G.terms().find((x) => x.from === 'Keyaru').alts.includes('كايارو') && G.terms().find((x) => x.from === 'Keyaru').to === 'كيارو');
G.addTerms([{ from: 'Keyaru', to: 'كيارو بالإملاء', lang: 'ar', book: 'b' }]);
ok('… one written by hand takes the detected one\'s place, its rendering kept beside', G.terms().find((x) => x.from === 'Keyaru').to === 'كيارو بالإملاء' && G.terms().find((x) => x.from === 'Keyaru').alts.includes('كيارو') && !G.terms().find((x) => x.from === 'Keyaru').auto);
ok('… the same name in the book not added again when its folder or every book already holds it', (() => { wipe(); G.saveTerms([T('g', 'Keyaru', 'كيارو')]); const n = G.addTerms([{ from: 'keyaru', to: 'كيارو', lang: 'ar', book: 'bb' }]); return n === 0 && G.terms().length === 1; })());
// 6. paste / import overlapping the glossary
wipe(); G.addTerms(G.parseTerms('Lin Feng = لين فنغ\tperson\tar\nQi = التشي').map((x) => ({ ...x, lang: 'ar', book: 'b' })));
const n3 = G.addTerms(G.parseTerms('lin feng = لين فنغ\nQi = تشي\nZhao = تشاو').map((x) => ({ ...x, lang: 'ar', book: 'b' })));
ok('pasting an overlapping glossary: only the new line added; the other rendering kept as an alternative', n3 === 1 && G.terms().length === 3 && G.terms().find((x) => x.from === 'Qi').alts[0] === 'تشي');
// 7. copying a former volume's glossary twice
wipe(); G.saveTerms([T('t1', 'Lin Feng', 'لين فنغ', { book: 'v1' }), T('t2', 'Wen', 'ون', { book: 'v1' })]);
const cand = { bookId: 'v1', title: 'Gate Story Vol. 1', vol: 1, match: 'same', count: 2, folders: [] };
G.copyGlossary('v2', cand); G.copyGlossary('v2', cand);
ok('copying a former volume\'s glossary twice: this book has each term once', G.terms().filter((x) => x.book === 'v2').length === 2, G.terms().filter((x) => x.book === 'v2').length);
// 8. existing data: the tidy on load, and the manual action
wipe(); store['kr.glossary'] = JSON.stringify([T('o1', 'Lin Feng', 'لين فنغ', { book: 'b' }), T('o2', 'ＬＩＮ ＦＥＮＧ', 'لين فينغ', { book: 'b' }), T('o3', 'Qi', 'تشي', { book: 'b' })]); G._forgetLegacy();
{ const G2 = load('src/glossary.ts'); const l2 = G2.terms(); ok('old data tidied on load: the repeat merged, its rendering kept', l2.length === 2 && l2.find((x) => x.id === 'o1').alts[0] === 'لين فينغ', l2);
  ok('… and written back once', JSON.parse(store['kr.glossary']).length === 2); }
wipe(); const f3 = G.addFolder('S'); G.setLinked('bx', [f3.id]);
store['kr.glossary'] = JSON.stringify([T('m1', 'Wen', 'ون', { folder: f3.id }), T('m2', 'wen', 'ون', { book: 'bx' })]); store['kr.glossaryLinks'] = JSON.stringify({ bx: [f3.id] });
{ const G2 = load('src/glossary.ts'); G2.terms(); } // (the load tidy already took the cross repeat away)
store['kr.glossary'] = JSON.stringify([T('m1', 'Wen', 'ون', { folder: f3.id }), T('m2', 'wen', 'ون', { book: 'bx' })]);
{ const m = {}; const code = esbuild.buildSync({ entryPoints: ['src/glossary.ts'], bundle: true, format: 'cjs', write: false, platform: 'node', logLevel: 'error' }).outputFiles[0].text; const mm = { exports: {} }; new Function('module', 'exports', code)(mm, mm.exports); const G3 = mm.exports; G3.saveTerms([T('m1', 'Wen', 'ون', { folder: f3.id }), T('m2', 'wen', 'ون', { book: 'bx' })]);
  const n = G3.mergeRepeats(); ok('«Merge repeats» reports how many were merged (a book\'s own term its folder holds as it is)', n === 1 && G3.terms().length === 1 && G3.mergeRepeats() === 0, n); }
// 9. the Names found tab: names already in the glossary, and the same name several times
wipe(); G.saveTerms([T('e1', 'Keyaru', 'كيارو', { book: 'b' })]);
const found = [{ from: 'keyaru', to: 'كيارو' }, { from: 'Flare', to: 'فلير' }, { from: 'ＦＬＡＲＥ', to: 'فلير' }, { from: 'Setsuna', to: 'سيتسونا' }];
ok('names found: those in the glossary left out, one name listed once', JSON.stringify(G.newNames(found, 'b', 'ar').map((x) => x.from)) === JSON.stringify(['Flare', 'Setsuna']), G.newNames(found, 'b', 'ar'));
ok('… a name in the glossary for another language is still offered for this one', G.newNames([{ from: 'Keyaru', to: 'ケヤル' }], 'b', 'ja').length === 1);

// ---- Part A: deleting ----
const BASE = () => { wipe(); const fo = G.addFolder('Gate Story'); G.setLinked('v1', [fo.id]); G.setLinked('v2', [fo.id]); G.setDest('v2', { to: fo.id, addNew: true }); G.setDest('*', { to: 'book', addNew: true });
  G.saveTerms([T('1', 'Lin Feng', 'لين فنغ', { folder: fo.id }), T('2', 'Iron Palm', 'كف الحديد', { folder: fo.id, kind: 'skill' }), T('3', 'The gate sang.', 'غنت البوابة.', { folder: fo.id, kind: 'quote' }), T('4', 'Spell', 'تعويذة', { folder: fo.id, kind: 'u:Lore' }), T('5', 'Own', 'خاص', { book: 'v1' }), T('6', 'Other', 'آخر', { book: 'v9' }), T('7', 'Every', 'كل', {})]);
  G.setVolChoice('v1', { choice: 'share', from: 'v0' }); return fo; };
let fo = BASE(); const snap = G.glossarySnapshot(); const raw0 = JSON.stringify(store);
const st = G.folderStats(fo.id); ok('what a folder holds is counted for the question: files, terms, citations, the books', st.files === 4 && st.terms === 4 && st.quotes === 1 && st.books.sort().join() === 'v1,v2', st);
G.removeFolder(fo.id);
ok('folder deleted: its files of every kind (the reader\'s own too) and citations gone; the book\'s own, another book\'s and every book\'s kept', G.terms().map((x) => x.id).sort().join() === '5,6,7', G.terms().map((x) => x.id));
ok('… nothing of it left in storage: no folder, no link, no destination to it', !JSON.stringify(Object.entries(store).filter(([k]) => k !== 'kr.glossary')).includes(fo.id) && !store['kr.glossaryFolders'] && !store['kr.glossaryLinks'], keys().map((k) => [k, store[k]]));
ok('… the destination of another book kept', JSON.parse(store['kr.glossaryDest'])['*'].to === 'book' && !JSON.parse(store['kr.glossaryDest']).v2);
ok('… the books that used it simply have no glossary (v2: none; v1: its own term only)', !G.hasGlossary('v2') && G.linkedFolders('v1').length === 0);
ok('… the folder is not made again by itself: a book with no glossary is not handed a former volume\'s on the next open', G.volChoice('v2')?.choice === 'empty' && G.volDecision({ id: 'v2', title: 'Gate Story Vol. 2' }, [{ id: 'v1', title: 'Gate Story Vol. 1' }, { id: 'v2', title: 'Gate Story Vol. 2' }], 'auto').kind === 'none' && !G.folders().length);
ok('… not by names being found either, until detection runs (then the series folder is made, as asked)', (() => { G.setDest('v2', { to: 'auto', addNew: true }); const was = G.folders().length; const r = G.namesTarget('v2', 'Gate Story Vol. 2'); return was === 0 && !!r.folder && G.folders().length === 1; })());
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
G.glossaryRestore(snap);
ok('Undo: terms, kinds, links, destinations and choices exactly as they were', same(store, JSON.parse(raw0)), [JSON.stringify(store).length, raw0.length]);
// a folder shared by several volumes
fo = BASE(); G.removeBookGlossary('v2');
ok('the glossary of a book that shares a folder: the shared folder goes for every volume (v1 too), the others kept', !G.folders().length && !G.hasGlossary('v1') === false /* v1 keeps its own term */ && G.linkedFolders('v1').length === 0 && G.terms().some((x) => x.id === '5'));
// one file
fo = BASE(); const n = G.removeFile('skill', (x) => x.folder === fo.id);
ok('one file deleted whole (its kind in this place only)', n === 1 && !G.terms().some((x) => x.id === '2') && G.terms().length === 6);
fo = BASE(); const nq = G.removeFile('quote', (x) => x.folder === fo.id); ok('… a file of citations too', nq === 1 && !G.terms().some((x) => x.id === '3'));
// all
fo = BASE(); const snapAll = G.glossarySnapshot(); const rawAll = JSON.stringify(store); G.removeAllGlossaries();
ok('delete all glossaries: no glossary key left in storage', keys().filter((k) => k !== 'kr.glossaryLegacyLang').length === 0, keys());
G.glossaryRestore(snapAll); ok('… Undo: everything back', same(store, JSON.parse(rawAll)));

// ---- Part C: the search ----
wipe();
const labels = { person: 'Characters', place: 'Places', skill: 'Skills', term: 'Terms', quote: 'Citations' };
const kn = (k) => labels[k] ?? k;
G.saveTerms([T('s1', 'ケヤル', 'كيارو', { book: 'b' }), T('s2', 'ケヤル', 'Keyaru', { book: 'b', lang: 'en' }), T('s3', '回復術士', 'المعالج', { book: 'b', kind: 'skill', alts: ['المُداوي'] }), T('s4', 'ひのき', 'سرو', { book: 'b', kind: 'place' }), T('s5', 'Lin Feng', 'لين فنغ', { book: 'b', note: 'the hero' }), T('s6', 'Iron Palm', 'كف الحديد', { book: 'b', kind: 'skill', lang: 'ar' })]);
const IX = S.buildIndex(G.terms(), kn); const find = (q, o = {}) => S.searchIndex(IX, q, { target: 'en', ...o });
const fromsOf = (r) => r.hits.map((h) => h.shown.from).join();
ok('the Arabic rendering finds the Japanese original', fromsOf(find('كيارو')) === 'ケヤル');
ok('… the English finds the Arabic (one name, its renderings together)', fromsOf(find('keyaru')) === 'ケヤル' && find('keyaru').hits[0].shown.lang === 'en');
ok('… katakana finds hiragana, and hiragana katakana', fromsOf(find('ヒノキ')) === 'ひのき' && fromsOf(find('けやる')) === 'ケヤル');
ok('… the Arabic with or without its vowel signs and hamza forms', fromsOf(find('الْمُعَالِج')) === '回復術士' && fromsOf(find('المعالج')) === '回復術士' && fromsOf(find('مُدَاوِي')) === '回復術士' && fromsOf(find('مداوي')) === '回復術士');
ok('… width and case (full-width capitals), spaces loosened («linfeng», «LIN  FENG»)', fromsOf(find('ＬＩＮ')) === 'Lin Feng' && fromsOf(find('linfeng')) === 'Lin Feng' && fromsOf(find('LIN   FENG')) === 'Lin Feng');
ok('… the note and the kind\'s name too', fromsOf(find('hero')) === 'Lin Feng' && find('skills').hits.map((h) => h.shown.from).sort().join() === 'Iron Palm,回復術士');
const hk = find('كيارو').hits[0]; ok('a match in another language than the one shown: the row shows «also» with that rendering', hk.shown.lang === 'en' && hk.also.length === 1 && hk.also[0].text === 'كيارو' && hk.also[0].field === 'to' && termLangOf(hk.also[0].term) === 'ar');
function termLangOf(t) { return t.lang; }
ok('… an alternative matched: shown as «also» (field alt)', find('المداوي').hits[0].also[0].field === 'alt');
ok('nothing typed or nothing matching: no results', find('').total === 0 && find('zzzz').total === 0);
ok('the best match first (equal, then beginning with, then containing)', (() => { const ix = S.buildIndex([T('z1', 'Palm Reader', 'قارئ'), T('z2', 'Palm', 'نخلة'), T('z3', 'Iron Palm', 'كف')], kn); return S.searchIndex(ix, 'palm').hits.map((h) => h.shown.id).join() === 'z2,z1,z3'; })());
// 16,000 terms: the filter per keystroke
const big = []; for (let i = 0; i < 16000; i++) big.push(T('n' + i, `名前${i}ケヤル${i % 97}`, `اسم${i} ${'كيارو'.repeat(1 + (i % 3))}`, { book: 'b', kind: i % 5 ? 'person' : 'place', ...(i % 7 === 0 ? { lang: 'en', to: 'Name' + i } : {}) }));
let t0 = Date.now(); const bix = S.buildIndex(big, kn); const tIndex = Date.now() - t0;
const times = []; for (const q of ['け', 'ケヤ', 'ケヤル9', 'كيارو', 'اسم12', 'name1', 'zzz', 'ｎａｍｅ']) { t0 = process.hrtime.bigint(); const r = S.searchIndex(bix, q, { target: 'ar', limit: 60 }); times.push([q, Number(process.hrtime.bigint() - t0) / 1e6, r.total]); }
console.log('index of 16,000 built in', tIndex, 'ms; per keystroke (ms, matches):', JSON.stringify(times.map((x) => [x[0], Math.round(x[1] * 10) / 10, x[2]])));
ok('16,000 terms: every keystroke filtered in under 150 ms (the slowest ' + Math.round(Math.max(...times.map((x) => x[1]))) + ' ms)', Math.max(...times.map((x) => x[1])) < 150, times);
ok('… the index of 16,000 made in under 3 s (once, until the terms change)', tIndex < 3000, tIndex);
// folding the same everywhere: the key and the search agree
ok('the search folds as the key does (one function)', G.foldKey('ＫＥＹａｒｕ ケヤル', true) === 'keyaruけやる');
{ const m = G.foldMap('Ｌin Ｆeng'); ok('the folded text maps back to where it stood (for the mark)', m.f === 'linfeng' && m.from[0] === 0 && m.to[m.f.length - 1] === 8, m); }
console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
