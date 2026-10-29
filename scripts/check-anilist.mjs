// node scripts/check-anilist.mjs: the AniList tagging (src/sources/altagsmatch.ts) tried on AniList itself with
// series named as OTL's folders name them — which are found, as which entry, with which genres and tags, and
// which are not. Run where AniList is reachable (the "AniList check" workflow); prints a line per series, and on
// GitHub Actions an annotation per line too.
import esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'al-')), 'm.mjs');
await esbuild.build({ entryPoints: [new URL('../src/sources/altagsmatch.ts', import.meta.url).pathname], bundle: true, format: 'esm', outfile: out, platform: 'node', logLevel: 'error' });
const { searchName, buildQuery, pick } = await import(out);
const NAMES = [
  'Mushoku Tensei - Jobless Reincarnation', 'Spice and Wolf', "Didn't I Say to Make My Abilities Average in the Next Life", 'Re-ZERO -Starting Life in Another World-',
  'Monogatari Series', 'Goblin Slayer', 'Ascendance of a Bookworm', 'The Apothecary Diaries', 'Black Summoner', 'Solo Leveling',
  'Overlord', 'That Time I Got Reincarnated as a Slime', 'Classroom of the Elite', '86 [Eighty-Six]', 'The Eminence in Shadow',
  'Sword Art Online', 'Konosuba - God\'s Blessing on This Wonderful World!', 'The Rising of the Shield Hero', 'Bofuri - I Don\'t Want to Get Hurt, so I\'ll Max Out My Defense',
  'I\'m in Love with the Villainess', 'The Saga of Tanya the Evil', 'Ascendance of a Bookworm (Light Novel)', 'Kino\'s Journey', 'Toradora!', 'My Next Life as a Villainess - All Routes Lead to Doom!',
  'Arifureta - From Commonplace to World\'s Strongest', 'Seirei Gensouki - Spirit Chronicles', 'How a Realist Hero Rebuilt the Kingdom', 'The Faraway Paladin', 'Rascal Does Not Dream of Bunny Girl Senpai',
];
// (GitHub keeps ten annotations a step: one per batch.)
const notice = (msg) => { console.log(msg); if (process.env.GITHUB_ACTIONS) console.log(`::notice title=AniList::${msg.replace(/\n/g, ' ')}`); };
const lines = [];
let found = 0;
for (let i = 0; i < NAMES.length; i += 8) {
  const batch = NAMES.slice(i, i + 8);
  const { query, variables } = buildQuery(batch.map(searchName));
  const r = await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
  const json = await r.json();
  if (!r.ok || json.errors) { notice(`HTTP ${r.status} ${JSON.stringify(json.errors ?? '').slice(0, 300)}`); process.exitCode = 1; break; }
  batch.forEach((name, j) => {
    const list = json.data?.[`s${j}`]?.media ?? [];
    const other = json.data?.[`t${j}`]?.media ?? [];
    const p = pick(searchName(name), list, name, other);
    const m = p ? [...list, ...other].find((x) => x.id === p.id) : null;
    if (p) found++;
    lines.push(p ? `${name} → ${m.title.english || m.title.romaji} [${p.genres.join(', ')}] tags: ${p.tags.slice(0, 6).join(', ')}` : `${name} → (none; AniList offered: ${list.map((x) => x.title.english || x.title.romaji).join(' / ') || 'nothing'})`);
  });
  notice(lines.splice(0).join(' ‖ '));
  await new Promise((res) => setTimeout(res, 2500));
}
notice(`found ${found} of ${NAMES.length}`);
