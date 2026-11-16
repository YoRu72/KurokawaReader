# Releasing Kurokawa Reader and Kurokawa Tools

The aim: the final push to `main` is boring. Everything that used to go wrong at that step is checked earlier, by one
command here and by the **Preflight** workflow on the work branch.

## The order

1. **Finish the list.** One piece at a time. Do not release update by update: release only when the whole list is done.
2. **Bump the version in both places** for each app you release: `apps/<app>/package.json` and
   `apps/<app>/desktop/package.json` (the preflight fails if they differ). The Tauri shells read the version from
   `package.json`, so there is nothing else to edit.
3. **Write the notes**: `apps/<app>/docs/notes/v<version>.md`, by hand. It must exist, must not be empty and must not
   contain the placeholder `«—»`.
4. **Run the preflight here:**
   ```
   node scripts/preflight.mjs tools        # or reader, or all
   ```
   (`--quick` while working: build, type check, budgets, parity checks, the tests your diff touches and a small smoke
   set. Run the full one before you push for the last time.) Exit code 0 means no new failure.
5. **Push the work branch** (`work-*`) with `[full]` in the head commit's message, or start the **Preflight** workflow by
   hand, and wait for it to be green. It runs the full preflight on Linux, and also compiles what cannot be compiled
   anywhere else: the Android code, the Rust (Tauri) shells with their runtime self-test, and, for Tools, the Rust core
   for Android. You can also start it by hand: Actions → Preflight → Run workflow (app: tools, reader or all).
6. **Read the Windows self-test** (see «Passed on retry» below).
7. **Merge to `main`.** The release workflows start by themselves (see «How a push releases»).
8. After the release is built, report the file sizes.

## What runs on a push to a work branch

The **Preflight** workflow is cheap on an ordinary push and complete on request:

- **Every push** to a `work-*` branch that changes `apps/**`, `shared/**` or `repo/**`: the **quick** preflight on Linux
  (build, type check, string parity, version and notes, budgets, the tests your diff touches and a smoke set), and the
  Android compile check of the app when the branch changes `native/android/**`, `capacitor.config.*` or `package.json`
  of that app (Tools also `tests/native/**`). That is the intended rule for the «skipped» Android jobs you see on a
  push that touched no Android paths. When a push itself already starts the Android check by its own trigger, the
  preflight does not start it a second time.
- **Full run**: Actions → Preflight → Run workflow (app: tools, reader or all), or a push whose head commit message
  contains **`[full]`**. It runs the full preflight (every test the release workflow runs) and also the Tauri checks
  (Windows, Linux, macOS, with the runtime self-test) and, for Tools, the Rust core for Android, when the branch changes
  that Rust code (always, when started by hand). Do this before the final push.

## What the preflight checks

Every line of the table is one of: `PASS`, `FAIL` (a new failure: the exit code is 1), `KNOWN` (a test that fails on the
untouched baseline and is listed with its reason), `FIXED` (a known failure that now passes: remove it from the list),
`WARN` (look, but it does not fail the run), `SKIP` (not run, the reason is printed), `FLAKY` (failed, then passed on
`--retry`; shown loudly).

| Step | What it means |
|---|---|
| build | `node scripts/build.mjs` works (with `KR_META=1`, as CI builds Tools). |
| tsc --noEmit | The type check, as `npm run typecheck`. |
| version parity | The two `package.json` files carry the same version. A warning if `src/` changed and the version is still the one on `main`. |
| release notes | `docs/notes/v<version>.md` exists, has text, has no `«—»` placeholder. |
| i18n parity | Every key of `en.ts` is in `ar.ts` (a missing Arabic string fails). Japanese, Korean and Chinese are partial on purpose (a missing key falls back to English): the preflight compares with the accepted count in `tests/i18n-baseline.json` and only warns when more keys are missing than that. A key that is in another language but not in `en.ts` fails. After translating, lower the baseline with `node scripts/preflight.mjs <app> --write-i18n-baseline`. |
| every test is in the workflow or listed | Each `tests/*.cjs` is run by the release workflow (`release-tools.yml`, `release.yml`) or is listed with a reason in `tests/not-in-ci.json`. A new test you forgot to add to the workflow fails here. |
| leftovers | No `.only(`, `debugger;`, `console.log('DEBUG…` or merge markers in lines you added. |
| big or junk files | No added file over 1 MB (allow-list in `scripts/preflight.config.json`), no `node_modules`, `dist`, logs or `meta.json` added. |
| yellow/amber colours | Report only: CSS lines you added that contain a yellow or amber colour (the house rule says none). |
| themes | `scripts/themes.mjs --check` (Tools): the generated theme files are up to date. |
| test … | Each test, with the arguments the workflow gives it, one after another, each with a time limit. |
| budget | The start-JS budget with its headroom, read from `perfstart.cjs` (Tools) and `perfbudget.cjs` (Reader). A warning when less than 5 % is left. |

Tests run one after another on purpose: several use the same fixed ports (for example 5483 in Tools, 5196, 5197 and
5199 in Reader) and the same temp folders, so running them side by side would make false failures.

**When a test fails:** run it alone, `node scripts/preflight.mjs <app> --only <name> --verbose`. If it also fails on
`main` (check out `main` in another folder and run the same command), it is a known failure: add it to
`apps/<app>/tests/known-failures.json` with the true reason, how to run it properly and the date. If it passes alone but
failed in the run, it is probably flaky: run with `--retry`, and look at it before releasing.

## «Passed on retry» in the Windows self-test

The Windows job of **Tauri check** (`tauri-check.yml`, «Self-test (Windows)») runs the app and lets it check itself. Two of
its screen-translator rows used to fail now and then on the runner with no change of code (2026-11-15). They now try
again once, and say so:

- The row's result reads `PASSED ON RETRY — the first attempt failed: …` with the first failure in full (what the
  picture showed, where the window was, the column of colour bars as letters, the state of «auto»).
- The job summary has a line `PASSED ON RETRY: n check(s)` above the table, and the row shows `ok (PASSED ON RETRY)`.

What to do:

1. **Once**, on a branch you are about to release: it is the known runner timing. Read the first failure in the row.
   If it says the window or the caption was slow (`painted … ms`, `showed no caption in 15 s`), run the job once more
   and go on.
2. **Again on the next run** (the same row, two runs in a row), or any row that says `FAILED TWICE`, or any other
   failure message («the caption took the focus», «not click-through», «the caption went away by itself»; these are
   never tried again): it is probably a real fault in `src-tauri/src/screentr.rs` or `screencap.rs`. Do not release;
   send the row's text to the orchestrator.
3. Never edit a row to hide it. The retry is for timing only, and it is always visible.

## How a push releases, and the second workflow

A push to `main` starts a release workflow by the paths it changes:

- `release-tools.yml`: `apps/tools/**`, `shared/**`, or the workflow itself. It builds and publishes the pre-release
  `tools-v<version>` from `apps/tools/package.json`.
- `release.yml` (the Reader): `apps/reader/**`, `repo/**`, `shared/**`, or the workflow itself. It builds and publishes
  `v<version>` from `apps/reader/package.json`.

Both can also be started by hand («Run workflow»).

So a merge that touches `shared/**` starts **both**, whichever app you meant. The other app's workflow does not make
a new version: it rebuilds the version already in its `package.json` and refreshes that existing release with the new
builds (they now contain the shared change, but the version number did not move). That is the unwanted second one. Choose
before you merge:

- **Both apps are meant to ship the shared change:** bump both versions, write both notes, run `preflight all`, merge
  once. Two workflows, two new releases. This is the clean way.
- **Only one app is meant to ship it:** merge, then open the Actions tab at once and **cancel the other app's run**
  (it only publishes in its last step, so there is time). Its release stays as it was.
- Keep `shared/` changes out of a release that does not need them: do them on their own branch, and merge that branch
  together with the app releases that need it.

Check the Actions tab after the merge: you should see exactly the workflows you meant to start. (A guard in the release
workflows, for example skipping a push whose commit message says «[tools only]», would remove the manual cancel; it is not
there, because the release workflows are not changed by the preflight work.)

## Files

- `scripts/preflight.mjs`: the preflight; `scripts/preflight.config.json`: time limits, smoke sets, budget patterns, size limit.
- `apps/<app>/tests/known-failures.json`, `not-in-ci.json`, `i18n-baseline.json`: what the preflight accepts.
- `.github/workflows/preflight.yml`: the workflow that runs the preflight and the compile checks on a work branch.
