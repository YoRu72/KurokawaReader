#!/usr/bin/env bash
# The scene engine (apps/tools/core/kt-scene) built for the page: wasm32-unknown-unknown, release, with a PINNED Rust
# toolchain, then put at apps/tools/public/scene/ktscene.wasm, where scripts/build.mjs copies it into dist (the
# Electron app:// handler serves .wasm as application/wasm; Tauri serves dist as it is). The binary is never committed
# (.gitignore): every workflow that builds Tools' web app for shipping runs this first (through the composite action
# .github/actions/scene-wasm), and .github/workflows/scene-wasm.yml builds it on its own for work branches and uploads
# it as the artifact «ktscene-wasm».
#   bash scripts/build-scene-wasm.sh              native tests, then the wasm
#   bash scripts/build-scene-wasm.sh --no-tests   the wasm only
# Fails when the wasm is over 150 KB, or does not instantiate with no imports and answer ABI 1 (when node is there).
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
if command -v node > /dev/null 2>&1; then
  node -e "
    const b = require('fs').readFileSync(process.argv[1]);
    const ex = new WebAssembly.Instance(new WebAssembly.Module(b), {}).exports;
    const need = ['memory','kt_abi','kt_alloc','kt_free','scene_load','scene_viewport','scene_palette','scene_roles','scene_param','scene_step','scene_substeps','scene_inst','scene_stride','scene_hint','scene_live','scene_state_hash','scene_free'];
    const miss = need.filter((k) => !(k in ex));
    if (miss.length || ex.kt_abi() !== 1 || ex.scene_stride() !== 8) { console.error('ktscene.wasm: bad exports', miss, ex.kt_abi && ex.kt_abi()); process.exit(1); }
    console.log('ktscene.wasm: instantiates with no imports, ABI 1, stride 8');
  " "$WASM"
fi
mkdir -p "$OUT"
cp "$WASM" "$OUT/ktscene.wasm"
echo "ktscene.wasm -> apps/tools/public/scene/ktscene.wasm"
