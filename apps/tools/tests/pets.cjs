// node tests/pets.cjs: the pets' engine without a page (src/pets/*): the safe XML reader (a document type, entities,
// a «billion laughs», depth and size refused), the condition language (no eval: hostile text refused), our pet.json
// (strict: missing pictures, bad numbers, unsafe paths, pictures lying about their kind, huge pictures, too many
// files), the Shimeji subset (actions, behaviours, sequences, conditions, Japanese names, per-character conf, hostile
// XML, the standard numbered pictures without XML), the frame grouping of «a folder of frames» (names, folders, strips,
// GIFs) and its mapping, the GIF reader, and the runtime with a fake clock and fake rectangles (falling, landing,
// walking and turning at edges, a panel's top, carried by a moving window, dropped when it goes, dragged, thrown,
// bouncing, a click, moving aside, chasing the pointer, conditions).
// Every picture is generated here: plain coloured rectangles with a frame number drawn in. Made-up names only.
const path = require('node:path'); const zlib = require('node:zlib');
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); if (!c) fails++; };
const throws = (f) => { try { f(); return null; } catch (e) { return String(e.message || e); } };

const entry = `export * from './src/pets/xml'; export * from './src/pets/expr'; export * from './src/pets/model'; export * from './src/pets/source';
export * from './src/pets/petJson'; export * from './src/pets/shimeji'; export * from './src/pets/frames'; export * from './src/pets/gif'; export * from './src/pets/runtime';`;
const code = esbuild.buildSync({ stdin: { contents: entry, resolveDir: path.join(__dirname, '..'), loader: 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent' }).outputFiles[0].text;
const M = { exports: {} }; new Function('module', 'exports', 'require', code)(M, M.exports, require); const P = M.exports;

const { png, pngHeader, gif } = require('./pets-fixtures.cjs');
const F = (p, b) => ({ path: p, bytes: typeof b === 'string' ? new TextEncoder().encode(b) : b });
const rep = () => P.newReport();

(async () => {
  /* ---------- 1. XML ---------- */
  {
    const x = P.parseXml('<?xml version="1.0"?>\n<!-- c --><m:Mascot xmlns:m="urn:x" a="1 &amp; 2 &#x41;&#66;"><A Name="x"/><B><![CDATA[<raw>]]></B></m:Mascot>');
    ok('xml: elements, prefixes off, entities and references read', x.name === 'Mascot' && x.attrs.a === '1 & 2 AB' && x.kids.length === 2 && x.kids[1].text === '<raw>' && !('xmlns:m' in x.attrs) && !('m' in x.attrs), x);
    const lol = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';
    ok('xml: a document type («billion laughs») refused', /doctype/.test(throws(() => P.parseXml(lol))));
    ok('xml: an entity declaration alone refused', /doctype/.test(throws(() => P.parseXml('<a><!ENTITY x SYSTEM "file:///etc/passwd"></a>'))));
    ok('xml: an unknown entity refused', /unknownEntity/.test(throws(() => P.parseXml('<a>&ext;</a>'))));
    ok('xml: a bare ampersand refused', /badAmp/.test(throws(() => P.parseXml('<a b="x & y"/>'))));
    ok('xml: depth capped', /tooDeep/.test(throws(() => P.parseXml('<a>'.repeat(80) + '</a>'.repeat(80)))));
    ok('xml: size capped', /tooBig/.test(throws(() => P.parseXml('<a>' + 'x'.repeat(1100000) + '</a>'))));
    ok('xml: mismatched and unclosed tags refused', /mismatch/.test(throws(() => P.parseXml('<a><b></a></b>'))) && /unclosed/.test(throws(() => P.parseXml('<a><b>'))));
    ok('xml: nodes capped', /tooManyNodes/.test(throws(() => P.parseXml('<a>' + '<b/>'.repeat(20001) + '</a>'))));
    ok('xml: __proto__ attributes dropped', (() => { const n = P.parseXml('<a __proto__="1" constructor="2" k="v"/>'); return Object.getPrototypeOf(n.attrs) === Object.prototype && n.attrs.k === 'v' && !Object.prototype.hasOwnProperty.call(n.attrs, '__proto__'); })());
  }
  /* ---------- 2. expressions ---------- */
  {
    const N = new Set(['x', 'onFloor', 'area.width']);
    const v = (s, env = {}, r = () => 0.5) => P.evaluate(P.compile(s, N), env, r);
    ok('expr: arithmetic and precedence', v('1 + 2 * 3 - 4 / 2') === 5 && v('(1 + 2) * 3') === 9 && v('7 % 4') === 3 && v('-x + 1', { x: 3 }) === -2);
    ok('expr: comparisons and logic (words and symbols)', v('x > 2 && onFloor', { x: 3, onFloor: true }) === true && v('x > 2 and not onFloor', { x: 3, onFloor: true }) === false && v('x === 3 || false', { x: 3 }) === true && v('x != 3 or x <= 1', { x: 3 }) === false);
    ok('expr: the allowed Math calls', v('Math.floor(Math.random() * 10)') === 5 && v('Math.max(1, x, 2)', { x: 9 }) === 9 && v('Math.abs(-4)') === 4);
    ok('expr: dotted names', v('area.width / 2', { 'area.width': 800 }) === 400);
    const hostile = ['constructor', 'x.constructor', "constructor.constructor('return process')()", 'this', 'globalThis', 'process.exit(1)', 'alert(1)', 'x[0]', '__proto__', 'Math.pow(2, 3)', 'Math', 'eval("1")', 'Function("x")', 'x = 1', '`x`', 'new Date()', '1;2', 'require("fs")', "'a'"];
    const allRefused = hostile.every((h) => { try { P.compile(h, N); return false; } catch (e) { return e instanceof P.ExprError; } });
    ok('expr: hostile text refused (no eval, no property lookup, no unknown call)', allRefused, hostile.filter((h) => { try { P.compile(h, N); return true; } catch { return false; } }));
    ok('expr: length, token and depth capped', /tooLong/.test(throws(() => P.compile('1+'.repeat(300) + '1', N))) && /tooDeep|tooLong/.test(throws(() => P.compile('('.repeat(60) + '1' + ')'.repeat(60), N))));
    ok('expr: division by zero gives 0, not Infinity', v('1 / 0') === 0 && v('1 % 0') === 0);
    ok('expr: test() answers null for refused text', P.test('foo > 1', N, {}) === null && P.test('x > 1', N, { x: 2 }) === true);
  }
  /* ---------- 3. our pet.json ---------- */
  {
    const files = [F('pet.json', JSON.stringify({ format: 'kurokawa-pet', version: 1, name: 'Square', credit: 'Made-up maker', licence: 'Test licence', anchor: [16, 32], facing: 'right', extra: 1,
      sheets: { w: { file: 'walk.png', columns: 4, rows: 1 } },
      animations: { idle: { frames: ['idle_1.png', 'idle_2.png'], fps: 4 }, walk: { frames: ['w:0', 'w:1', 'w:2', 'w:3'], fps: 8, speed: 40 }, wave: { frames: ['wave.gif'], fps: 10, loop: false }, one: { frames: ['wave.gif#1'] } },
      states: { idle: [{ animation: 'idle', weight: 3, duration: [2, 6] }], walk: ['walk'], click: ['wave'], dance: ['one'] }, speech: ['Hi', 5, ''] })),
      F('idle_1.png', png(32, 32, 1)), F('idle_2.png', png(32, 32, 2)), F('walk.png', png(128, 32, 3)), F('wave.gif', gif(16, 16, 3))];
    const r = P.fromPetJson(P.cleanFiles(files, rep()));
    ok('pet.json: a full pack read (frames: 2 + 4 cells + 3 GIF frames)', r.pack.frames === 9 && r.frames.length === 9 && r.pack.animations.walk.frames.length === 4 && r.pack.animations.wave.frames.length === 3 && r.pack.animations.one.frames.length === 1, r.pack);
    ok('pet.json: sheet cells cut where they are', JSON.stringify(r.frames.filter((f) => f.cell).map((f) => f.cell)) === JSON.stringify([[0, 0, 32, 32], [32, 0, 32, 32], [64, 0, 32, 32], [96, 0, 32, 32]]));
    ok('pet.json: names, credit, licence, anchor, speech cleaned', r.pack.name === 'Square' && r.pack.credit === 'Made-up maker' && r.pack.anchor[1] === 32 && JSON.stringify(r.pack.speech) === '["Hi"]');
    ok('pet.json: unknown keys and states noted, not fatal', r.report.notes.some((n) => /extra/.test(n)) && r.report.notes.some((n) => /dance/.test(n)));
    const variant = (patch, extra = []) => throws(() => P.fromPetJson(P.cleanFiles([F('pet.json', JSON.stringify({ name: 'X', animations: { idle: { frames: ['a.png'] } }, states: { idle: ['idle'] }, ...patch })), F('a.png', png(16, 16, 1)), ...extra], rep())));
    ok('pet.json: the minimal pack is accepted', variant({}) === null);
    ok('pet.json: a missing picture refused', /frame:idle/.test(variant({ animations: { idle: { frames: ['nope.png'] } } })));
    ok('pet.json: bad numbers refused (fps, scale, weight)', /fps/.test(variant({ animations: { idle: { frames: ['a.png'], fps: 1000 } } })) && /scale/.test(variant({ scale: -1 })) && /weight/.test(variant({ states: { idle: [{ animation: 'idle', weight: 'x' }] } })));
    ok('pet.json: a state naming no animation refused', /stateAnim/.test(variant({ states: { idle: ['ghost'] } })));
    ok('pet.json: no name refused', /name/.test(variant({ name: '' })));
    ok('pet.json: a format of another kind refused', /format/.test(variant({ format: 'other' })));
    ok('pet.json: a text file named .png refused (kind by content)', /frame/.test(variant({ animations: { idle: { frames: ['b.png'] } } }, [F('b.png', 'not a picture at all')])));
    ok('pet.json: a huge picture refused by its header (no decoding)', /frame/.test(variant({ animations: { idle: { frames: ['big.png'] } } }, [F('big.png', pngHeader(20000, 20000))])));
    ok('pet.json: a frame larger than 1024 refused', /frameTooBig/.test(variant({ animations: { idle: { frames: ['big.png'] } } }, [F('big.png', pngHeader(2000, 100))])));
    ok('pet.json: not JSON refused', /notJson/.test(throws(() => P.fromPetJson([F('pet.json', '{ nope')]))));
    const r2 = rep(); const cleaned = P.cleanFiles([F('../evil.png', png(4, 4, 1)), F('/abs.png', png(4, 4, 1)), F('C:/x.png', png(4, 4, 1)), F('a/../../b.png', png(4, 4, 1)), F('ok/run.exe', 'MZ'), F('ok/script.js', 'x'), F('ok/a\u0001b.png', png(4, 4, 1)), F('ok/fine.png', png(4, 4, 1)), F('ok/pet.json', '{}')], r2);
    ok('files: unsafe paths, programs and scripts left out and reported; the top folder taken off', cleaned.length === 2 && cleaned.some((f) => f.path === 'fine.png') && r2.skipped.length === 7, { cleaned: cleaned.map((f) => f.path), skipped: r2.skipped });
    ok('files: too many files refused', /tooManyFiles/.test(throws(() => P.cleanFiles(Array.from({ length: 2001 }, (_, i) => F(`f${i}.png`, png(2, 2, 1))), rep()))));
    ok('files: too many bytes refused', /tooBig/.test(throws(() => P.cleanFiles(Array.from({ length: 10 }, (_, i) => F(`f${i}.png`, new Uint8Array(7 << 20))), rep()))));
    ok('files: one file over 8 MB left out', (() => { const rr = rep(); const c = P.cleanFiles([F('x.png', new Uint8Array(9 << 20))], rr); return c.length === 0 && /tooBig/.test(rr.skipped[0]); })());
    ok('pet.json: too many frames refused', /tooManyFrames/.test(variant({ sheets: { s: { file: 'grid.png', columns: 256, rows: 3 } }, animations: { idle: { frames: Array.from({ length: 300 }, (_, i) => `s:${i}`) }, b: { frames: Array.from({ length: 300 }, (_, i) => `s:${i + 300}`) }, c: { frames: Array.from({ length: 100 }, (_, i) => `s:${i + 600}`) } } }, [F('grid.png', pngHeader(256 * 8, 24))])));
  }
  /* ---------- 4. Shimeji ---------- */
  const imgs = (dir, n) => Array.from({ length: n }, (_, i) => F(`${dir}shime${i + 1}.png`, png(32, 32, i + 1, [90, 120 + i * 2, 150])));
  const ACTIONS = `<?xml version="1.0" encoding="UTF-8"?>
<Mascot xmlns="http://www.group-finity.com/Mascot">
  <ActionList>
    <Action Name="Look" Type="Embedded" Class="com.group_finity.mascot.action.Look" />
    <Action Name="Stand" Type="Stay" BorderType="Floor"><Animation><Pose Image="/shime1.png" ImageAnchor="16,32" Velocity="0,0" Duration="250" /></Animation></Action>
    <Action Name="Walk" Type="Move" BorderType="Floor"><Animation>
      <Pose Image="/shime1.png" ImageAnchor="16,32" Velocity="-2,0" Duration="6" /><Pose Image="/shime2.png" ImageAnchor="16,32" Velocity="-2,0" Duration="6" />
      <Pose Image="/shime1.png" ImageAnchor="16,32" Velocity="-2,0" Duration="6" /><Pose Image="/shime3.png" ImageAnchor="16,32" Velocity="-2,0" Duration="6" /></Animation></Action>
    <Action Name="Sit" Type="Stay" BorderType="Floor"><Animation><Pose Image="/shime11.png" ImageAnchor="16,32" Velocity="0,0" Duration="250" /></Animation></Action>
    <Action Name="Sprawl" Type="Stay" BorderType="Floor"><Animation><Pose Image="/shime21.png" ImageAnchor="16,32" Velocity="0,0" Duration="250" /></Animation></Action>
    <Action Name="Falling" Type="Embedded" Class="com.group_finity.mascot.action.Fall"><Animation><Pose Image="/shime4.png" ImageAnchor="16,32" Velocity="0,0" Duration="250" /></Animation></Action>
    <Action Name="Pinched" Type="Embedded" Class="com.group_finity.mascot.action.Dragged"><Animation><Pose Image="/shime5.png" ImageAnchor="16,32" Velocity="0,0" Duration="5" /><Pose Image="/shime6.png" ImageAnchor="16,32" Velocity="0,0" Duration="5" /></Animation></Action>
    <Action Name="Teleport" Type="Embedded" Class="com.example.Teleport" />
    <Action Name="Wave" Type="Animate"><Animation><Pose Image="/shime9.png" ImageAnchor="16,32" Velocity="0,0" Duration="5" /><Pose Image="/shime10.png" ImageAnchor="16,32" Velocity="0,0" Duration="5" /></Animation></Action>
  </ActionList>
  <ActionList>
    <Action Name="StandUp" Type="Sequence" Loop="false"><ActionReference Name="Stand" Duration="\${100+Math.random()*100}" /></Action>
    <Action Name="SitDown" Type="Sequence" Loop="false"><ActionReference Name="Sit" Duration="\${250+Math.random()*250}" /><ActionReference Name="Sprawl" Duration="\${500}" /></Action>
    <Action Name="WalkAlong" Type="Sequence" Loop="false"><ActionReference Name="Walk" TargetX="\${mascot.environment.workArea.left+64}" /></Action>
    <Action Name="Mystery" Type="Sequence"><ActionReference Name="Teleport" /></Action>
  </ActionList>
</Mascot>`;
  const BEHAVIORS = `<?xml version="1.0" encoding="UTF-8"?>
<Mascot xmlns="http://www.group-finity.com/Mascot">
  <BehaviorList>
    <Behavior Name="Fall" Frequency="0" Hidden="true" />
    <Behavior Name="Dragged" Frequency="0" Hidden="true" />
    <Behavior Name="ChaseMouse" Frequency="10" />
    <Condition Condition="#{mascot.environment.floor.isOn(mascot.anchor) || mascot.environment.activeIE.topBorder.isOn(mascot.anchor)}">
      <Behavior Name="StandUp" Frequency="200" />
      <Behavior Name="SitDown" Frequency="100" />
      <Behavior Name="WalkAlong" Frequency="100" Condition="#{mascot.anchor.x &gt; mascot.environment.workArea.left + 10}" />
      <Behavior Name="WaveHello" Action="Wave" Frequency="20" Condition="#{mascot.environment.floor.isOn(mascot.anchor)}" />
      <Behavior Name="Weird" Action="Stand" Frequency="30" Condition="#{java.lang.System.exit(0)}" />
      <Behavior Name="Mystery" Frequency="10" />
    </Condition>
  </BehaviorList>
</Mascot>`;
  {
    const files = P.cleanFiles([...imgs('img/Blocky/', 21), F('conf/actions.xml', ACTIONS), F('conf/behaviors.xml', BEHAVIORS), F('img/Blocky/readme.txt', 'Made-up credits for a made-up pack.')], rep());
    ok('shimeji: characters found', JSON.stringify(P.shimejiCharacters(files)) === '["Blocky"]' && P.isShimeji(files));
    const r = P.fromShimeji(files);
    const st = r.pack.states;
    ok('shimeji: behaviours become states (idle, sit, walk) with weights', st.idle?.some((c) => c.name === 'StandUp' && c.weight === 200) && st.sit?.some((c) => c.name === 'SitDown' && c.steps.length === 2) && st.walk?.some((c) => c.name === 'WalkAlong'), st);
    ok('shimeji: fall, dragged and thrown from the embedded actions', st.fall?.[0].steps[0].anim === 'Falling' && st.dragged?.[0].steps[0].anim === 'Pinched' && st.thrown?.[0].steps[0].anim === 'Falling');
    const walk = r.pack.animations.Walk;
    ok('shimeji: poses → frames, durations in seconds, speed from velocity, anchors', walk.frames.length === 4 && Math.abs(walk.durations[0] - 0.24) < 1e-9 && Math.abs(walk.speed - 50) < 1e-9 && walk.anchors[0][1] === 32 && walk.frames[0] === walk.frames[2], walk);
    const up = st.idle.find((c) => c.name === 'StandUp').steps[0];
    ok('shimeji: a Duration expression read as its range (ticks → seconds)', Math.abs(up.min - 4) < 1e-6 && up.max > 7.9 && up.max <= 8, up);
    ok('shimeji: conditions converted to our language', /onFloor/.test(st.walk.find((c) => c.name === 'WalkAlong').when) && /x > area\.left/.test(st.walk.find((c) => c.name === 'WalkAlong').when));
    ok('shimeji: unknown conditions, actions, ChaseMouse skipped and listed', ['condition: Weird', 'behaviour: ChaseMouse', 'embedded: Teleport', 'behaviour: Mystery'].every((k) => r.report.skipped.includes(k)), r.report);
    ok('shimeji: facing left, name from the character, readme as licence text', r.pack.facing === 'left' && r.pack.name === 'Blocky' && /Made-up credits/.test(r.pack.licence));
    // The runtime takes it.
    const sim = new P.PetSim(r.pack, Array(r.pack.frames).fill([32, 32]), { scale: 2, activity: 'normal', chase: false, seed: 7 }, { width: 800, height: 600, floor: 600, surfaces: [] });
    for (let i = 0; i < 300; i++) sim.step(1 / 30, { width: 800, height: 600, floor: 600, surfaces: [] });
    ok('shimeji: the converted pack lives (falls, lands, does things)', sim.on === 'floor' && ['idle', 'walk', 'sit', 'sleep'].includes(sim.state), { on: sim.on, state: sim.state });
    // Per-character conf, Japanese names.
    const JA = ACTIONS.replace(/<Action /g, '<動作 ').replace(/<\/Action>/g, '</動作>').replace(/Name=/g, '名前=').replace(/Type="Stay"/g, '種類="静止"').replace(/Type="Move"/g, '種類="移動"').replace(/<Animation>/g, '<アニメーション>').replace(/<\/Animation>/g, '</アニメーション>').replace(/<Pose /g, '<ポーズ ').replace(/Image=/g, '画像=').replace(/ImageAnchor=/g, '基準座標=').replace(/Velocity=/g, '移動速度=').replace(/Duration=/g, '長さ=');
    const r2 = P.fromShimeji(P.cleanFiles([...imgs('img/Two/', 6), ...imgs('img/One/', 4), F('img/Two/conf/actions.xml', JA)], rep()), 'Two');
    ok('shimeji: Japanese element names and the character\'s own conf read', r2.pack.name === 'Two' && r2.pack.animations.Walk?.frames.length === 4 && r2.pack.animations.Stand && r2.report.notes.includes('noBehaviors'), Object.keys(r2.pack.animations));
    // Hostile XML: refused, reported, the standard pictures used instead.
    const r3 = P.fromShimeji(P.cleanFiles([...imgs('img/Evil/', 12), F('conf/actions.xml', '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><Mascot>&x;</Mascot>'), F('conf/behaviors.xml', '<Mascot><BehaviorList>' + '<a>'.repeat(100) + '</BehaviorList></Mascot>')], rep()));
    ok('shimeji: hostile XML refused and reported; the standard pictures used', r3.report.skipped.some((s) => /actions\.xml: doctype/.test(s)) && r3.report.skipped.some((s) => /behaviors\.xml/.test(s)) && r3.pack.animations['std-walk']?.frames.length === 4 && r3.pack.states.fall?.length === 1, r3.report);
    // No XML at all.
    const r4 = P.fromShimeji(P.cleanFiles(imgs('', 4), rep()));
    ok('shimeji: no XML → the standard meaning of shime1..N (only the pictures there)', r4.report.notes.includes('standardSlots') && r4.pack.animations['std-idle'] && r4.pack.animations['std-walk'] && r4.pack.animations['std-fall'] && !r4.pack.animations['std-sit'] && r4.pack.frames === 4, Object.keys(r4.pack.animations));
    ok('shimeji: no pictures refused', /noPictures/.test(throws(() => P.fromShimeji([F('conf/actions.xml', ACTIONS)]))));
    ok('shimeji: an Image path climbing out is not followed', (() => { const rr = P.fromShimeji(P.cleanFiles([...imgs('img/A/', 3), F('img/secret.png', png(8, 8, 1)), F('conf/actions.xml', ACTIONS.replace('/shime1.png" ImageAnchor="16,32" Velocity="0,0" Duration="250"', '/../secret.png" ImageAnchor="16,32" Velocity="0,0" Duration="250"'))], rep())); return rr.report.skipped.some((s) => /picture/.test(s)) && !rr.frames.some((f) => /secret/.test(f.file)); })());
  }
  /* ---------- 5. a folder of frames ---------- */
  {
    const files = P.cleanFiles([F('Hero/walk_1.png', png(24, 32, 1)), F('Hero/walk_2.png', png(24, 32, 2)), F('Hero/walk_10.png', png(24, 32, 10)), F('Hero/idle-02.png', png(24, 32, 2)), F('Hero/idle-01.png', png(24, 32, 1)),
      F('Hero/sitting/01.png', png(24, 32, 1)), F('Hero/sitting/02.png', png(24, 32, 2)), F('Hero/fall_strip.png', png(96, 24, 4)), F('Hero/hold.gif', gif(12, 12, 2)), F('Hero/notes.txt', 'x')], rep());
    const g = P.groupFrames(files); const by = Object.fromEntries(g.map((x) => [x.label, x]));
    ok('frames: grouped by name and folder', !!by.walk && !!by.idle && !!by.sitting && by.walk.frames.length === 3 && by.idle.frames.length === 2, g.map((x) => [x.label, x.frames.length]));
    ok('frames: numbered order (walk_10 after walk_2)', by.walk.frames.map((f) => f.file).join() === 'walk_1.png,walk_2.png,walk_10.png' && by.idle.frames[0].file === 'idle-01.png');
    ok('frames: a strip cut into square cells, a GIF into its frames', by.fall_strip?.frames.length === 4 && by.fall_strip.frames[3].cell[0] === 72 && by.hold?.frames.length === 2 && by.hold.frames[1].gif === 1, g.map((x) => x.label));
    ok('frames: states suggested by names', by.walk.suggested === 'walk' && by.idle.suggested === 'idle' && by.sitting.suggested === 'sit' && by.fall_strip.suggested === 'fall' && by.hold.suggested === 'dragged');
    const m = P.suggestMapping(g);
    ok('frames: the first mapping offered', m.walk === by.walk.key && m.idle === by.idle.key && m.sit === by.sitting.key && m.dragged === by.hold.key);
    const r = P.buildFromMapping(files, g, m, { name: 'Hero', facing: 'right', fps: { walk: 12 } });
    ok('frames: the mapping becomes a pack (states, animations, thrown from fall)', r.pack.source === 'frames' && r.pack.animations.walk.fps === 12 && r.pack.states.thrown?.[0].steps[0].anim === 'fall' && r.pack.frames === 3 + 2 + 2 + 4 + 2 && r.pack.frameW === 24, r.pack);
    ok('frames: a mapping without idle or walk refused', /noIdle/.test(throws(() => P.buildFromMapping(files, g, { sit: by.sitting.key }, { name: 'x' }))));
    ok('frames: a key for a picture path', JSON.stringify(P.groupKey('a/Run 3.png')) === JSON.stringify({ key: 'a|run', label: 'a/Run', n: 3 }) && P.groupKey('pack/jump/0007.png').key === 'pack/jump');
  }
  /* ---------- 6. GIF ---------- */
  {
    const b = gif(6, 4, 3); const info = P.gifInfo(b); const d = P.gifFrames(b);
    const px = (fr, x, y) => Array.from(fr.rgba.slice((y * 6 + x) * 4, (y * 6 + x) * 4 + 4));
    ok('gif: size and frame count', info.w === 6 && info.h === 4 && info.frames === 3);
    ok('gif: frames decoded with their colours and transparency', JSON.stringify(px(d.frames[0], 2, 1)) === '[200,60,60,255]' && px(d.frames[0], 2, 0)[3] === 0 && JSON.stringify(px(d.frames[1], 3, 3)) === '[60,200,60,255]' && px(d.frames[1], 3, 1)[3] === 0 && Math.abs(d.frames[0].delay - 0.1) < 1e-9, [px(d.frames[0], 2, 1), px(d.frames[1], 3, 3)]);
    ok('gif: a truncated GIF refused', /truncated|badBlock/.test(throws(() => P.gifFrames(b.slice(0, 40)))));
    ok('gif: a huge logical screen refused', /tooBig/.test(throws(() => P.gifInfo(new Uint8Array([...Buffer.from('GIF89a'), 255, 255, 255, 255, 0, 0, 0, 0x3b]), 1024 * 1024))));
  }
  /* ---------- 7. the runtime ---------- */
  {
    const pack = { v: 1, name: 'T', credit: '', licence: '', source: 'pet', frameW: 20, frameH: 30, anchor: [10, 30], scale: 1, facing: 'right', frames: 6,
      animations: { idle: { frames: [0], fps: 2, loop: true }, walk: { frames: [1, 2], fps: 8, loop: true, speed: 50 }, fall: { frames: [3], fps: 1, loop: true }, drag: { frames: [4], fps: 1, loop: true }, wave: { frames: [5], fps: 4, loop: false } },
      states: { idle: [{ steps: [{ anim: 'idle', min: 1, max: 1 }], weight: 1 }], walk: [{ steps: [{ anim: 'walk', min: 3, max: 3 }], weight: 1 }], fall: [{ steps: [{ anim: 'fall', min: 1, max: 1 }], weight: 1 }], dragged: [{ steps: [{ anim: 'drag', min: 1, max: 1 }], weight: 1 }], click: [{ steps: [{ anim: 'wave', min: 0.5, max: 0.5 }], weight: 1 }] } };
    const sizes = Array(6).fill([20, 30]);
    const W = (surfaces = [], extra = {}) => ({ width: 800, height: 600, floor: 600, surfaces, ...extra });
    const run = (sim, s, world) => { for (let i = 0; i < Math.round(s * 30); i++) sim.step(1 / 30, typeof world === 'function' ? world(i) : world); };
    const mk = (o = {}, start) => new P.PetSim(pack, sizes, { scale: 1, activity: 'normal', chase: false, seed: 3, ...o }, W(), start);
    let s = mk({}, { x: 400, y: 0 });
    ok('runtime: starts falling', s.state === 'fall' && !s.on);
    run(s, 1, W());
    ok('runtime: falls with gravity and lands on the floor', s.on === 'floor' && s.y === 600 && s.vy === 0, { on: s.on, y: s.y });
    // Two sims, same seed and steps: the same story.
    const a1 = mk({ seed: 11 }, { x: 300, y: 0 }), a2 = mk({ seed: 11 }, { x: 300, y: 0 }); run(a1, 20, W()); run(a2, 20, W());
    ok('runtime: deterministic (same seed, same steps → same place and state)', a1.x === a2.x && a1.state === a2.state && a1.frame() === a2.frame());
    // Walking to the right edge turns it.
    s = mk({}, { x: 770, y: 600 }); run(s, 0.1, W()); s.dir = 1; s.state = 'walk'; s['enter']('walk'); s.dir = 1;
    run(s, 2, W());
    ok('runtime: walking into the screen\'s edge turns it around, never past it', s.dir === -1 && s.x <= 790 && s.x >= 10, { x: s.x, dir: s.dir, st: s.state });
    // Lands on a panel's top.
    const panel = { id: 'p1', x: 200, y: 300, w: 200 };
    s = mk({}, { x: 300, y: 100 }); run(s, 1, W([panel]));
    ok('runtime: lands on a panel\'s top edge', s.on === 'p1' && s.y === 300, { on: s.on, y: s.y });
    // Walks along it; at its edge turns or steps off (never floats beyond it).
    let offOrTurn = true; s['enter']('walk'); s.dir = 1;
    for (let i = 0; i < 300; i++) { s.step(1 / 30, W([panel])); if (s.on === 'p1' && (s.x < 199.9 || s.x > 400.1)) offOrTurn = false; }
    ok('runtime: walks along the panel and never stands past its ends', offOrTurn);
    // Carried by a moving surface (a window dragged), and dropped when it goes.
    s = mk({}, { x: 300, y: 100 }); run(s, 1, W([panel]));
    const x0 = s.x; run(s, 0.03, W([{ ...panel, x: 260, y: 280 }]));
    ok('runtime: carried by a surface that moves', s.on === 'p1' && Math.abs(s.x - (x0 + 60)) < 3 && s.y === 280, { x: s.x, x0 });
    run(s, 1.2, W());
    ok('runtime: falls when its surface is gone, lands on the floor', s.on === 'floor' && s.y === 600);
    // A window top from the desktop's active window (the same thing: a surface the source gives).
    const winTop = (i) => W([{ id: 'win', x: 100 + i, y: 250, w: 400 }]);
    s = mk({}, { x: 300, y: 0 }); run(s, 3, winTop);
    ok('runtime: walks on a window top that follows the active window (fake rectangle source)', s.on === 'win' && s.y === 250, { on: s.on });
    // Dragged and thrown: bounce, then lands.
    s = mk({}, { x: 400, y: 600 }); run(s, 0.2, W());
    s.grab(400, 580, 0); ok('runtime: grabbed → dragged', s.state === 'dragged' && s.dragging && s.on === null);
    for (let i = 1; i <= 6; i++) s.dragTo(400 + i * 40, 580 - i * 50, i * 16);
    ok('runtime: follows the pointer while dragged', Math.abs(s.x - 640) < 1 && Math.abs(s.y - 300) < 1, { x: s.x, y: s.y });
    s.release(6 * 16 + 5);
    ok('runtime: released fast → thrown with the pointer\'s speed', s.state === 'thrown' && s.vx > 1000 && s.vy < -1000, { vx: s.vx, vy: s.vy });
    let bounced = false, prevVy = 0; for (let i = 0; i < 300; i++) { s.step(1 / 30, W()); if (prevVy > 0 && s.vy < 0 && !s.on) bounced = true; prevVy = s.vy; }
    ok('runtime: thrown → hits walls and floor, bounces, then rests on the floor', bounced && s.on === 'floor' && s.x >= 10 && s.x <= 790, { on: s.on, x: s.x });
    s.grab(s.x, 590, 1000); s.dragTo(s.x, 500, 1050); s.release(1400);
    ok('runtime: released after holding still → just falls', s.state === 'fall' && s.vx === 0);
    // Click.
    s = mk({}, { x: 400, y: 600 }); run(s, 0.2, W()); s.click();
    ok('runtime: a click plays the click animation', s.state === 'click' && s.frame() === 5);
    run(s, 0.6, W()); ok('runtime: … and then goes on', s.state !== 'click');
    const noClick = { ...pack, states: { ...pack.states, click: undefined } };
    const s2 = new P.PetSim(noClick, sizes, { scale: 1, activity: 'normal', chase: false, seed: 3 }, W(), { x: 400, y: 600 }); run(s2, 0.2, W()); s2.click();
    ok('runtime: no click animation → a small hop', !s2.on && s2.vy < 0); run(s2, 1, W()); ok('runtime: … and lands again', s2.on === 'floor');
    // Moving aside.
    s = mk({}, { x: 400, y: 600 }); run(s, 0.2, W()); s['enter']('idle'); s.flee(430);
    ok('runtime: flee → walks away from the pointer, faster', s.state === 'walk' && s.dir === -1);
    const fx = s.x; run(s, 0.5, W()); ok('runtime: … several pixels in half a second', fx - s.x > 40, { moved: fx - s.x });
    // Chasing the pointer (rate-limited).
    s = mk({ chase: true, seed: 5 }, { x: 100, y: 600 }); let toward = 0, frames = 0;
    for (let i = 0; i < 30 * 40; i++) { const px = { x: 700, y: 500 }; s.step(1 / 30, W([], { pointer: px })); if (s.state === 'walk') { frames++; if (s.dir === 1) toward++; } }
    ok('runtime: chases the pointer when allowed (mostly walks toward it)', s.x > 400 && toward / Math.max(1, frames) > 0.6, { x: s.x, toward, frames });
    const sOff = mk({ chase: false, seed: 5 }, { x: 100, y: 600 }); let offTowardOnly = 0; for (let i = 0; i < 30 * 40; i++) sOff.step(1 / 30, W([], { pointer: { x: 700, y: 500 } }));
    void offTowardOnly; ok('runtime: chase off: the pointer changes nothing', (() => { const t2 = mk({ chase: false, seed: 5 }, { x: 100, y: 600 }); for (let i = 0; i < 30 * 40; i++) t2.step(1 / 30, W()); return Math.abs(t2.x - sOff.x) < 1e-9; })());
    // Conditions choose: a behaviour only on the floor, another only on a window top.
    const condPack = { ...pack, states: { ...pack.states, idle: [{ steps: [{ anim: 'idle', min: 0.5, max: 0.5 }], weight: 1, when: 'onFloor', name: 'floorOnly' }, { steps: [{ anim: 'wave', min: 0.5, max: 0.5 }], weight: 1, when: 'onWindowTop', name: 'topOnly' }], walk: [] } };
    const c1 = new P.PetSim(condPack, sizes, { scale: 1, activity: 'normal', chase: false, seed: 9 }, W(), { x: 300, y: 590 }); const seenFloor = new Set();
    for (let i = 0; i < 300; i++) { c1.step(1 / 30, W()); if (c1.on === 'floor') seenFloor.add(c1.frame()); }
    const c2 = new P.PetSim(condPack, sizes, { scale: 1, activity: 'normal', chase: false, seed: 9 }, W(), { x: 300, y: 100 }); const seenTop = new Set();
    for (let i = 0; i < 300; i++) { c2.step(1 / 30, W([panel])); if (c2.on === 'p1') seenTop.add(c2.frame()); }
    ok('runtime: conditions decide (floor-only on the floor, top-only on a panel)', seenFloor.has(0) && !seenFloor.has(5) && seenTop.has(5) && !seenTop.has(0), { floor: [...seenFloor], top: [...seenTop] });
    // Drawing: flips by direction against the pictures' side; anchor at the feet; scale.
    s = mk({ scale: 2 }, { x: 400, y: 600 }); run(s, 0.2, W()); s.dir = -1; let v = s.view();
    ok('runtime: the view: feet at the anchor, scaled, flipped when walking against the pictures\' side', v.w === 40 && v.h === 60 && v.y === 540 && Math.abs(v.x - 380) < 1e-9 && v.flip === true && (s.dir = 1, !s.view().flip), v);
    ok('runtime: busy (30 a second) while moving, not while idle', (() => { const t = mk({}, { x: 400, y: 0 }); const b1 = t.busy(); run(t, 1, W()); t['enter']('idle'); return b1 && !t.busy(); })());
    const lively = mk({ activity: 'lively', seed: 21 }, { x: 400, y: 0 }), calm = mk({ activity: 'calm', seed: 21 }, { x: 400, y: 0 }); let wl = 0, wc = 0;
    for (let i = 0; i < 30 * 120; i++) { lively.step(1 / 30, W()); calm.step(1 / 30, W()); if (lively.state === 'walk') wl++; if (calm.state === 'walk') wc++; }
    ok('runtime: Lively walks more than Calm', wl > wc, { wl, wc });
    ok('runtime: drawScale brings packs near 96 px (M), S < M < L, custom clamped', Math.abs(P.drawScale({ ...pack, frameH: 48 }, 'M') - 2) < 1e-9 && P.drawScale(pack, 'S') < P.drawScale(pack, 'M') && P.drawScale(pack, 'M') < P.drawScale(pack, 'L') && P.drawScale({ ...pack, frameH: 96 }, 'custom', 99) === 4);
    // Speech: off by default; on, a line now and then.
    const sp = new P.PetSim({ ...pack, speech: ['Made-up line'] }, sizes, { scale: 1, activity: 'calm', chase: false, seed: 2, speech: true }, W(), { x: 400, y: 590 }); let said = null;
    for (let i = 0; i < 30 * 200 && !said; i++) { sp.step(1 / 30, W()); said = sp.view().say; }
    const quiet = new P.PetSim({ ...pack, speech: ['Made-up line'] }, sizes, { scale: 1, activity: 'calm', chase: false, seed: 2 }, W(), { x: 400, y: 590 }); let q = null; for (let i = 0; i < 30 * 200 && !q; i++) { quiet.step(1 / 30, W()); q = quiet.view().say; }
    ok('runtime: speech only when turned on', said === 'Made-up line' && q === null, { said, q });
  }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
