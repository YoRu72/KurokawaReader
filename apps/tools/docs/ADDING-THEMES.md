# Adding a theme (or a wallpaper) without an app update

The app reads `repo/themes/themes.json` and `repo/scenes/scenes.json` from `main` by itself (at start, when it comes
back to the foreground, every 6 hours). A new entry shows up in the theme browser (or the wallpaper picker on a
computer) marked «New»; an installed one whose `version` rises is updated by itself. The reader's own themes
(«My themes», ids `my-…`) are never touched.

## A theme

1. Make `apps/tools/themes-src/<id>/theme.json` (`<id>`: lower-case letters, digits, `-`; never `my-…`):
   - **with pictures**: as `frosted-glass/` — `assets` (files beside it), `license`, `preview`.
   - **light (colours only)**: no `assets`; `tokens` holds the values in the «My themes» format, wrapped:
     `"tokens": { "kurokawaTheme": 1, "theme": { "base": "frost", "radius": 1, "accent": "theme", "dark": { … }, "light": { … } } }`.
     Each mode is what the theme editor saves (`src/theme/custom.ts`, `MyMode`): surfaces, text and roles as
     `#rrggbb`, glass numbers (clamped to `RANGES`), `bg.kind` one of `theme | mesh | solid | drift | flow`.
     The app rebuilds every CSS value from these; any CSS or script text, an unknown key's value, a bad colour, or a
     picture background makes it refuse the pack.
2. Raise `version` when you change it (dotted numbers: `1.2` → `1.3`).
3. Run `node apps/tools/scripts/themes.mjs` — it writes `repo/themes/<id>.ktheme` and `themes.json` (size, SHA-256).
   `--check` (CI) fails when they are stale.

## A wallpaper (scene)

1. `apps/tools/scenes-src/<id>/scene.json` (ktscene/1, at most 256 KB) and `meta.json`:
   `{ "names": { "en", "ar", "ja", "ko", "zh" }, "version": "1.0", "engine": 2, "preview": { "dark": ["#…", "#…"], "light": [...] } }`.
   `engine` is the lowest engine level it needs (`ENGINE_LEVEL` in `src/theme/sceneRepo.ts`); an older app shows
   «needs the app update».
2. Run `node apps/tools/scripts/scenes.mjs` (writes `repo/scenes/<id>.json` and `scenes.json`).

## Add-ons

After changing a module under `repo/tools/`, raise its `version` and run `node apps/tools/scripts/addons-index.mjs`
(fills `sha256`/`size`). `minApp` holds an update back from older apps; `force: true` allows a lower version.
The preflight's static checks fail on a stale hash in either catalogue.

Note: any change under `repo/**` also starts the Reader's release workflow.
