// The Reader's own side of the shared theme files (themes.ts, custom.ts, gallery.ts, editor.ts — the same in both
// apps): what KurokawaReader says of its themes. Not shared: Kurokawa Tools has its own src/theme/app.ts.
import type { AppTheme } from './themes';

/** Frost is the default; Classic (the app's own look, as it was) closes the gallery, keeps its name and has no pencil;
 *  no moving backgrounds (a theme brought in with one shows its still stand-in). */
export const APP_THEME: AppTheme = { defaultTheme: 'frost', mainNameKey: 'themeClassic', mainFirst: false, mainCopyable: false, mainTag: false, animBg: false, radiusLg: 20 };
