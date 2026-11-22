// The scenes the engine ships (src/theme/scenes/*.json), grouped as the Appearance picker shows them, with the keys of
// their names and one-line hints. Tiny on purpose: the picker reads it without loading the engine or the scene files.
export interface SceneEntry { id: string; name: string; hint: string; /** A scene from the repository: its name as the catalogue gives it (not an i18n key). */ label?: string; repo?: boolean }
export interface SceneGroup { key: string; scenes: SceneEntry[] }
const e = (id: string, n: string): SceneEntry => ({ id, name: `animBg${n}`, hint: `animBg${n}Hint` });
export const SCENE_GROUPS: SceneGroup[] = [
  { key: 'animBgGroupSnow', scenes: [e('night-snowfall', 'NightSnow'), e('snowflakes', 'Snowflakes'), e('blizzard', 'Blizzard'), e('first-snow', 'FirstSnow')] },
  { key: 'animBgGroupWater', scenes: [e('rain', 'Rain'), e('waves', 'Waves'), e('underwater', 'Underwater'), e('fireflies', 'Fireflies')] },
  { key: 'animBgGroupSky', scenes: [e('aurora-lake', 'Aurora'), e('starfield', 'Starfield'), e('meteors', 'Meteors'), e('petals', 'Petals')] },
  { key: 'animBgGroupAbstract', scenes: [e('motes', 'Motes'), e('neon-night', 'Neon')] },
];
export const SCENES_ALL: SceneEntry[] = SCENE_GROUPS.flatMap((g) => g.scenes);
/** The mixer's ready-made presets (theme/sceneMix.ts PRESETS holds what they are made of), as «mix:<id>». */
const m = (id: string, n: string): SceneEntry => ({ id: `mix:${id}`, name: `mixP${n}`, hint: `mixP${n}Hint` });
export const MIX_GROUPS: SceneGroup[] = [
  { key: 'animBgGroupSnowy', scenes: [m('cold-light', 'ColdLight'), m('night-snow', 'NightSnow'), m('blizzard-dusk', 'BlizzardDusk'), m('frosted-window', 'Frosted'), m('aurora-snow', 'AuroraSnow'), m('first-snow', 'FirstSnow')] },
  { key: 'animBgGroupRainy', scenes: [m('soft-rain', 'SoftRain'), m('night-rain', 'NightRain')] },
];
export const sceneEntry = (id: string): SceneEntry | undefined => SCENES_ALL.find((s) => s.id === id) ?? MIX_GROUPS.flatMap((g) => g.scenes).find((s) => s.id === id) ?? REPO_SCENES.find((s) => s.id === id);
/** Scenes from the repository (theme/sceneRepo.ts fills these): listed after the built-in ones, usable in mixes; their
 *  documents, once downloaded and checked, are handed to the engine from REPO_DOCS (sceneHost.ts reads it). */
export const REPO_SCENES: SceneEntry[] = [];
export const REPO_DOCS: Record<string, unknown> = {};
let listed = false;
/** Whether the repository's scenes known here have been listed yet (a saved mix on one waits for it). */
export const repoListed = (): boolean => listed;
export function setRepoScenes(list: SceneEntry[]): void { listed = true; REPO_SCENES.splice(0, REPO_SCENES.length, ...list.filter((x) => !SCENES_ALL.some((b) => b.id === x.id))); }
/** Every scene a mix may start from: the built-in ones, then the repository's known here. */
export const baseScenes = (): SceneEntry[] => [...SCENES_ALL, ...REPO_SCENES];
