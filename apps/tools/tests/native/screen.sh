#!/bin/sh
# Compiles the screen translator's plain-Java parts (KtJson, KtTranslate) outside their package with TrT.java and
# runs them against a local server playing Google, DeepL and the AI services.
set -e
D=$(mktemp -d); HERE=$(cd "$(dirname "$0")" && pwd)
for f in KtJson KtTranslate KtLettering KtScreenMotion KtInpaint; do sed "s/^final class $f/public final class $f/; s/^package .*;//" "$HERE/../../native/android/$f.java" > "$D/$f.java"; done
cp "$HERE/TrT.java" "$HERE/MoT.java" "$HERE/InT.java" "$D/"; cd "$D"; javac -nowarn -d out KtJson.java KtTranslate.java KtLettering.java KtScreenMotion.java KtInpaint.java TrT.java MoT.java InT.java 2>/dev/null || javac -d out KtJson.java KtTranslate.java KtLettering.java KtScreenMotion.java KtInpaint.java TrT.java MoT.java InT.java
java -cp out TrT && java -cp out MoT && java -cp out InT && echo "screen translator: all passed"
