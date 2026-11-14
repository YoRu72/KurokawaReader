# Switch-over notes — the hybrid torrent engine's librqbit (stage P4, «far seeks»)

The release patch (`release-tools-yml.patch`, its own notes in `release-tools-yml.NOTES.md`) builds the plain app:
the committed `src-tauri/Cargo.toml` never names librqbit, so a release built from it streams torrents with aria2 alone
(a far seek waits for the in-order fetch). CI (`tauri-check.yml`) builds **with** librqbit on every system and, on
Linux, also without it, self-testing both. A librqbit regression must never block a release, so when the release is
to ship librqbit, its build step turns it on and **falls back to the plain build** if the build with it fails.

## Lines for the `rust-desktop` job's build step (not applied; the release workflow is not edited)

Replace the patch's `if [ -n "${{ matrix.target }}" ]; then npx … build …; fi` line in its «Build» step (working
directory `apps/tools/desktop-tauri`, after the `icon` line) with:

```bash
node rqbit-feature.cjs on
build() { if [ -n "${{ matrix.target }}" ]; then npx --yes @tauri-apps/cli@^2 build --bundles ${{ matrix.bundles }} --target ${{ matrix.target }}; else npx --yes @tauri-apps/cli@^2 build --bundles ${{ matrix.bundles }}; fi; }
if build; then
  echo "librqbit: in this build (far seeks fetch the sought place first)"
else
  echo "::warning::the build with librqbit failed — the plain build is released (aria2 streams; far seeks wait)"
  node rqbit-feature.cjs off
  build
  echo "_${{ runner.os }}: built without librqbit this time (its build failed); far seeks in a torrent wait for the download._" >> "$GITHUB_STEP_SUMMARY"
fi
```

The fallback build is the same command as today's, so the release can only lose librqbit, never the app. The release
notes' «seeking far ahead» line (`apps/tools/docs/notes/NEXT-rust.md`) follows what was built: with librqbit it stays
under «The same app inside»; without it, the draft's bracketed line goes back under «What is different».

## Before turning it on in the release

- A green `tauri-check.yml` run with the rows «hybrid: far seek …», «hybrid: librqbit fails at the add …», «hybrid: one
  owner …», «hybrid: librqbit fails mid-stream …» passed on Linux (required there) and reported on Windows and macOS;
  then make them required on Windows too (`selftest.js`, `runHybrid`'s `linux` flag).
- The reported row «hybrid: each engine continues the other's pieces» read: if aria2's count after the hand-back does not
  reach librqbit's, aria2's check-integrity is not keeping librqbit's pieces and a torrent watched then left is fetched
  again in part — decide before shipping.
- The sizes CI prints («librqbit — what it adds», Linux; the «Sizes» table of each system against the plain run
  43586049375: NSIS 5.98 MB, setup 9.48 MB, deb 11.38 MB, AppImage 85.45 MB, DMG 4.90 MB, universal DMG 9.41 MB).
