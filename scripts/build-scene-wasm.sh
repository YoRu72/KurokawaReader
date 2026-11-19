#!/usr/bin/env bash
# The scene engine (apps/tools/core/kt-scene) built for the page: wasm32-unknown-unknown, release, with a PINNED Rust
# toolchain, then put at apps/tools/public/scene/ktscene.wasm, where scripts/build.mjs copies it into dist (the
# Electron app:// handler serves .wasm as application/wasm; Tauri serves dist as it is). The binary is never committed
# (.gitignore): every workflow that builds Tools' web app for shipping runs this first (through the composite action
# .github/actions/scene-wasm), and .github/workflows/scene-wasm.yml builds it on its own for work branches and uploads
# it as the artifact «ktscene-wasm».
#   bash scripts/build-scene-wasm.sh              native tests, then the wasm
#   bash scripts/build-scene-wasm.sh --no-tests   the wasm only
# Fails when the wasm is over 150 KB, does not instantiate with no imports, does not speak ABI 2, or does not give the
# native golden hash (when node is there); prints its sha256 (and writes it to the job summary in CI).
set -euo pipefail

# (One place for the toolchain's version: bump it here, deliberately.)
KT_SCENE_RUST="${KT_SCENE_RUST:-1.99.0}"
LIMIT=$((150 * 1024))

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/apps/tools/core/kt-scene"
OUT="$ROOT/apps/tools/public/scene"
TESTS=1
[ "${1:-}" = "--no-tests" ] && TESTS=0

rustup toolchain install "$KT_SCENE_RUST" --profile minimal --target wasm32-unknown-unknown --no-self-update
if [ "$TESTS" = 1 ]; then
  cargo +"$KT_SCENE_RUST" test --offline --manifest-path "$CRATE/Cargo.toml"
fi
cargo +"$KT_SCENE_RUST" build --offline --release --target wasm32-unknown-unknown --manifest-path "$CRATE/Cargo.toml"

WASM="$CRATE/target/wasm32-unknown-unknown/release/ktscene.wasm"
SIZE=$(wc -c < "$WASM" | tr -d ' ')
echo "ktscene.wasm: $SIZE bytes (limit $LIMIT), rustc $KT_SCENE_RUST"
if [ "$SIZE" -gt "$LIMIT" ]; then
  echo "::error::ktscene.wasm is $SIZE bytes, over the 150 KB limit"
  exit 1
fi
# (The module checked as the page will use it: no imports, ABI 2, the layouts, and NATIVE == WASM — the golden hash of
#  core/kt-scene/golden.txt: Motes, seed 42, viewport 1312x832, 600 steps of 1000/60 ms, the same number the native
#  tests assert.)
if command -v node > /dev/null 2>&1; then
  node -e "
    const fs = require('fs'); const [wasm, scene, golden] = process.argv.slice(1);
    const ex = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(wasm)), {}).exports;
    const need = ['memory','kt_abi','kt_feature','kt_layout','kt_alloc','kt_free','scene_load','scene_viewport','scene_camera','scene_pointer','scene_click','scene_palette','scene_palette_get','scene_roles','scene_param','scene_param_get','scene_group','scene_step','scene_substeps','scene_cmds','scene_ncmd','scene_inst','scene_geom','scene_hint','scene_live','scene_state_hash','scene_free'];
    const miss = need.filter((k) => !(k in ex));
    if (miss.length || ex.kt_abi() !== 2 || ex.kt_layout(0) !== 16 || ex.kt_layout(1) !== 16) { console.error('ktscene.wasm: bad exports or layout', miss, ex.kt_abi && ex.kt_abi()); process.exit(1); }
    const bytes = fs.readFileSync(scene); const p = ex.kt_alloc(bytes.length); new Uint8Array(ex.memory.buffer, p, bytes.length).set(bytes);
    const h = ex.scene_load(p, bytes.length, 42); ex.kt_free(p, bytes.length);
    if (h <= 0) { console.error('ktscene.wasm: motes.json refused', h); process.exit(1); }
    ex.scene_viewport(h, 1312, 832); for (let i = 0; i < 600; i++) ex.scene_step(h, 1000 / 60);
    const got = ex.scene_state_hash(h) >>> 0; const want = parseInt(fs.readFileSync(golden, 'utf8'), 10);
    if (got !== want) { console.error('ktscene.wasm: the golden hash differs from the native one: wasm ' + got + ', native ' + want); process.exit(1); }
    console.log('ktscene.wasm: no imports, ABI 2, layouts 16/16, golden hash ' + got + ' = native');
  " "$WASM" "$ROOT/apps/tools/src/theme/scenes/motes.json" "$CRATE/golden.txt"
fi
# (Its fingerprint, for the record of each job that builds it.)
SHA=$( (sha256sum "$WASM" 2>/dev/null || shasum -a 256 "$WASM") | cut -d' ' -f1)
echo "ktscene.wasm sha256: $SHA"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "ktscene.wasm: $SIZE bytes, sha256 \`$SHA\`, rustc $KT_SCENE_RUST" >> "$GITHUB_STEP_SUMMARY"; fi
mkdir -p "$OUT"
cp "$WASM" "$OUT/ktscene.wasm"
echo "ktscene.wasm -> apps/tools/public/scene/ktscene.wasm"
