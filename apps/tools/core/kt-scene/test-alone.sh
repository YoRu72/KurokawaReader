#!/bin/sh
# Every module of kt-scene checked alone with rustc (no cargo, no crates): the leaf modules as they are, the ones that
# use their siblings with --cfg 'kt_alone="<module>"' (which brings the siblings in by path); then the whole crate.
# Run from anywhere: sh apps/tools/core/kt-scene/test-alone.sh
set -e
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/kt-scene-alone.$$"
mkdir -p "$OUT"
trap 'rm -rf "$OUT"' EXIT
run() { # name file [cfg]
  if [ -n "$3" ]; then rustc --edition 2021 --test -A dead_code --cfg "kt_alone=\"$3\"" "$2" -o "$OUT/$1"; else rustc --edition 2021 --test -A dead_code "$2" -o "$OUT/$1"; fi
  "$OUT/$1" -q
}
run math src/math.rs
run scenefile src/scenefile.rs
run graph src/graph.rs
run drawlist src/drawlist.rs
run particles src/particles.rs particles
run forces src/forces.rs forces
run scene src/scene.rs scene
run abi src/abi.rs abi
run lib src/lib.rs
echo "kt-scene: every module passed alone"
