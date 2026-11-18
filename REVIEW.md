# What a reviewer checks in this repository

Read from the base branch, never from the change under review. Each rule comes from a fault that reached a branch or a release. Run only the rules whose trigger matches the diff.

## Before calling a branch mergeable

- The app's whole suite has run on the current commit (`node scripts/preflight.mjs <app>`), not only the piece's own tests. A pass on an older commit means nothing.
- The branch contains the current work branch. A branch that is behind fails for old reasons and hides new ones.
- GitHub's full run (`[full]` in the commit message) has been read job by job. A cancelled or timed-out job is looked at, not waved through.
- A test that fails once and passes on a re-run is recorded with its name and the reason; it is not retried in a loop, skipped or given a sleep.

## Triggers

| When the diff… | Check |
|---|---|
| adds a file under `apps/*/desktop/*.cjs` | it is in that app's packaging list (`build.files`); `desktop-files.cjs` passes |
| adds a Java file under `native/android` | it is in the overlay list, in every `tests/native/*.sh` source list that compiles its callers, and the other app still compiles if it borrows the caller |
| changes a file one app builds from the other's source (archive engine, name table, shared crate) | both apps' Android and desktop compiles are green on GitHub |
| adds a test that reads source files or splits text on `\n` | it passes on a checkout with Windows line endings |
| adds or changes a bridge method (`preload.cjs`, `bridge.js`, a plugin) | every test's fake has the same arguments as the real one |
| removes a screen, sheet or setting | every test that waited for it is updated, and its strings are removed from all five language files |
| adds a user-visible string | it is in `en, ar, ja, ko, zh`; Arabic is Fusha; no source of novels is named anywhere |
| adds a setting | it appears only on the platform it concerns (phone or computer) |
| touches colours, sheets or buttons | no yellow, amber, gold or orange; no grey slabs; controls do not touch; buttons in one row share a width; a sticky footer never covers the last row |
| adds a listener, timer, observer or object URL | it is released on close; the leak check passes |
| adds code to the start path | the start size stays under its limit; new features load on first use |
| adds a local HTTP route or hands an address to another program | the route needs a signed or per-session address; no long-lived key appears on a command line; no `Access-Control-Allow-Origin: *` |
| follows redirects or forwards headers | credentials go only to the origin they came from; the user's DNS choice applies to every hop |
| deletes, truncates or moves a user's file | the file is identified by more than its name or size; a crash between any two steps is tested; nothing outside the destination can be reached |
| adds a test | it is in the release workflow's chain or listed with a reason in `not-in-ci.json` |
| adds a test that needs a program (ffmpeg, 7-Zip, aria2) | on GitHub the test fails when the program is missing; it never passes without running |

## How a rule gets here

A fault that a reviewer missed on a small diff, seen at least twice or costly once, and recognisable from the diff alone. Rules that no longer catch anything are removed.
