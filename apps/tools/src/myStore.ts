// «My themes» in this app: their values in localStorage (kt.myThemes — so the settings backup carries them; read
// back through the same strict check as a file), their pictures in IndexedDB beside the theme packs' (not in the
// backup: a restored theme whose picture is not here shows its colour mesh until a picture is chosen again).
import type { MyStore, MyTheme } from './theme/custom';
import { themeIo } from './themeIo';

const KEY = 'kt.myThemes';
export const myStore: MyStore = {
  load: () => { try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown; } catch { return []; } },
  save: (list: MyTheme[]) => { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* full */ } },
  io: themeIo,
};
