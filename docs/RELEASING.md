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
  (build, type check, string parity, version and notes, budgets, the tests that **this push** touches and a smoke set; a
  new branch or a forced push, whose old head is not in the history, falls back to the branch's diff against `main`;
  the summary says which of the two chose the tests, and why), and the
  Android compile check of the app when the branch changes `native/android/**`, `capacitor.config.*` or `package.json`
  of that app (Tools also `tests/native/**`). That is the intended rule for the «skipped» Android jobs you see on a
  push that touched no Android paths. When a push itself already starts the Android check by its own trigger, the
  preflight does not start it a second time.
- **Full run**: Actions → Preflight → Run workflow (app: tools, reader or all), or a push whose head commit message
  contains **`[full]`**. It runs the full preflight (every test the release workflow runs) and also the Tauri checks
  (Windows, Linux, macOS, with the runtime self-test) and, for Tools, the Rust core for Android, when the branch changes
  that Rust code (always, when started by hand). Do this before the final push.

## One result: shards and the verdict

The tests of an app are split over parallel machines (**shards**), because they cannot share one: they use fixed ports and
shared temp folders, but separate machines do not. `node scripts/preflight.mjs <app> --shard i/n` runs the i-th of n
slices. The split is by measured seconds (`scripts/preflight.timings.json`: test name and arguments → seconds), greedy,
longest test first, so every shard takes about as long; the same inputs always give the same split. A full run uses
4 shards per app, a quick run 1, or 2 when its planned tests take more than 12 minutes. Build, tsc and the static checks run
in shard 1 only (its planned time includes them); every shard builds what its tests need. A test the config splits into parts
(`parts` in `scripts/preflight.config.json`; Reader's `uihunt.cjs` runs as `uihunt.cjs en` and `uihunt.cjs ar`) is timed and
placed part by part.

- `node scripts/preflight.mjs reader --list --shard 2/4` prints that shard's planned tests and seconds as JSON and runs
  nothing; without `--shard` it prints the whole plan.
- The job **Preflight verdict** waits for every shard, merges their results into ONE table in the run's summary (every FAIL,
  KNOWN, FIXED, FLAKY and WARN row with its app and shard, and how the tests were chosen), and fails when any row is a FAIL or
  a shard left no result (a cancelled shard is a failure, not a silence). That job is the single result to read, and the one to
  require. Its name carries what the run covered: `Preflight verdict [full: reader,tools]`, or `[full: none]` for a quick run.
- **Whole logs.** For every FAIL and FLAKY test the complete output is kept as `preflight-logs/<test>.log`; each shard uploads
  that folder, the tests' pictures and the run's text as the artifact `logs-<app>-<shard>` (7 days), and its result as
  `pf-json-<app>-<shard>`. The table keeps only a test's last lines; the artifact has the rest.
- **Keeping the timings true.** After a full run, download the `pf-json-*` artifacts into one folder and run
  `node scripts/preflight.mjs --write-timings <folder>` (by hand; it merges the measured seconds into the timings file;
  commit it). `scripts/preflight-timings-from-log.mjs` seeds the file from run logs (it did the first time). A test without a
  figure counts 20 seconds.
- **A new fixed wait.** A `waitForTimeout(` added to a test file (compared with the base) is a WARN row naming file:line, with
  the number of existing ones per app. Tests wait on conditions with deadlines; the existing ones are not touched.

## What the release repeats, and what it does not

Before its long test chain, `release.yml` and `release-tools.yml` ask GitHub (the job's own token, `scripts/find-green-preflight.mjs`)
for a **green full Preflight of the same files**: a run whose `Preflight verdict [full: …]` job succeeded and names this app,
on a commit whose git trees are identical to the released commit's for `apps/<app>`, `shared`, `repo`, `.github/actions` and
the release workflow of that app (the merge commit's second parent, the work branch's head, is the usual match; the
checkout keeps two commits so it can be compared).

- **Found:** only the short chain runs after the build (the updater tests, the start-up budget and the smoke tests), and the
  run's summary names the Preflight run that stood in. About 90 minutes less.
- **Not found** (no full run, a quick run, a failed verdict, other files, a changed chain, or any trouble reaching GitHub): the
  full chain runs, exactly as before. It is never weaker than that.

A release whose job GitHub cancelled before any step ran (no machine; on 25 Nov the Reader's macOS and iOS jobs) is re-run once
by itself: `rerun-unstarted.yml` starts when a release run has completed without success, and `scripts/rerun-unstarted.mjs`
asks for «re-run failed jobs» if a job concluded `cancelled` with no step and waited 10 minutes or more. It acts on the first
attempt only, so it cannot loop.

## «As GitHub» on your own computer

Two opt-in modes for a local test run, in `apps/<app>/tests/helpers/asci.cjs` (the same file in both apps). A test takes
them with one line, `require('./helpers/asci.cjs');`; without the variables the line does nothing. No existing test has the line yet
(tests make their pages straight from Playwright; there is no shared helper to hook into, so the file patches the launched
browser instead).

| Variable | What it does | The kind of failure it shows |
|---|---|---|
| `KR_SLOW=4` | The page's CPU runs 4 times slower (`Emulation.setCPUThrottlingRate`). | A timeout that holds on a fast computer and not on a busy two-core runner: `glossarytap.cjs` timed out at its line 207 on GitHub on 25 Nov (both languages, 82 s) and passed here. |
| `KR_WIDE=3` | A style at page start, `* { letter-spacing: .03em !important }` (3 hundredths of an em). | A label that only just fits: text cut off or wrapped once the letters are a little wider (see the «labels fit again» commits, e.g. 7099be1c and ea3cdf22). |

Use them one test at a time: `KR_SLOW=4 node tests/<name>.cjs`, `KR_WIDE=3 node tests/<name>.cjs`.

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

On one machine tests run one after another on purpose: several use the same fixed ports (for example 5483 in Tools, 5196, 5197 and
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

- `scripts/preflight.mjs`: the preflight; `scripts/preflight.config.json`: time limits, smoke sets, budget patterns, size limit, test parts;
  `scripts/preflight.timings.json`: seconds per test for the shard split; `scripts/preflight-verdict.mjs`: the merged table.
- `scripts/find-green-preflight.mjs`, `scripts/rerun-unstarted.mjs` (with their `.test.mjs`): what the release workflows ask GitHub.
- `scripts/release-prep.mjs`: a `##` heading directly followed by `###` sub-headings is not an empty section (`--finish` kept
  removing it); it prints the headings it keeps before writing, and refuses, exit 1, to drop a heading that has text or a
  sub-heading under it (`scripts/release-prep-headings.test.mjs`).
- `apps/<app>/tests/known-failures.json`, `not-in-ci.json`, `i18n-baseline.json`: what the preflight accepts.
- `.github/workflows/preflight.yml`: the workflow that runs the preflight and the compile checks on a work branch.
