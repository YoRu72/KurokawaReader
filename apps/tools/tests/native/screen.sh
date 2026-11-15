#!/bin/sh
# Compiles the screen translator's plain-Java parts (KtJson, KtTranslate, KtLettering, KtScreenMotion, KtScreenTrack,
# KtInpaint, and stage M4's KtScreenRs — the Rust core absent here, so Java alone) outside their package with the tests and runs them: TrT against a local server playing Google, DeepL and
# the AI services; MoT the scroll finder; TkT the following of the screen and translating ahead; InT the inpainting.
set -e
D=$(mktemp -d); HERE=$(cd "$(dirname "$0")" && pwd)
for f in KtJson KtTranslate KtLettering KtScreenMotion KtScreenTrack KtInpaint KtScreenRs; do sed "s/^final class $f/public final class $f/; s/^package .*;//" "$HERE/../../native/android/$f.java" > "$D/$f.java"; done
cp "$HERE/TrT.java" "$HERE/MoT.java" "$HERE/TkT.java" "$HERE/InT.java" "$HERE/../../native/android/KtCore.java" "$D/"; cd "$D"; S="KtCore.java KtJson.java KtTranslate.java KtLettering.java KtScreenMotion.java KtScreenTrack.java KtInpaint.java KtScreenRs.java TrT.java MoT.java TkT.java InT.java"
javac -nowarn -d out $S 2>/dev/null || javac -d out $S
java -cp out TrT && java -cp out MoT && java -cp out TkT && java -cp out InT && echo "screen translator: all passed"
