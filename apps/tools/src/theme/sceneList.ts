// The scenes the engine ships (src/theme/scenes/*.json), grouped as the Appearance picker shows them, with the keys of
// their names and one-line hints. Tiny on purpose: the picker reads it without loading the engine or the scene files.
export interface SceneEntry { id: string; name: string; hint: string }
export interface SceneGroup { key: string; scenes: SceneEntry[] }
const e = (id: string, n: string): SceneEntry => ({ id, name: `animBg${n}`, hint: `animBg${n}Hint` });
export const SCENE_GROUPS: SceneGroup[] = [
  { key: 'animBgGroupSnow', scenes: [e('night-snowfall', 'NightSnow'), e('snowflakes', 'Snowflakes'), e('blizzard', 'Blizzard'), e('first-snow', 'FirstSnow')] },
  { key: 'animBgGroupWater', scenes: [e('rain', 'Rain'), e('waves', 'Waves'), e('underwater', 'Underwater'), e('fireflies', 'Fireflies')] },
  { key: 'animBgGroupSky', scenes: [e('aurora-lake', 'Aurora'), e('starfield', 'Starfield'), e('meteors', 'Meteors'), e('petals', 'Petals')] },
  { key: 'animBgGroupAbstract', scenes: [e('motes', 'Motes'), e('neon-night', 'Neon')] },
];
export const SCENES_ALL: SceneEntry[] = SCENE_GROUPS.flatMap((g) => g.scenes);
export const sceneEntry = (id: string): SceneEntry | undefined => SCENES_ALL.find((s) => s.id === id);
