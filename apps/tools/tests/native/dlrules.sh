#!/bin/sh
# Compiles KtDlRules.java (the download queue's decisions, plain Java) outside its package with RuT.java and runs it.
# (KtCore.java — the Rust core's door, which KtDlRules asks in shadow mode — keeps its package; without the library it
# is absent and changes nothing here. The same rules through the Rust library: apps/tools/core/kt-android/jvmtest.)
set -e
D=$(mktemp -d); HERE=$(cd "$(dirname "$0")" && pwd)
sed 's/^final class KtDlRules/public final class KtDlRules/; s/^package .*;//' "$HERE/../../native/android/KtDlRules.java" > "$D/KtDlRules.java"
cp "$HERE/RuT.java" "$HERE/../../native/android/KtCore.java" "$D/"; cd "$D"; javac -nowarn -d out KtCore.java KtDlRules.java RuT.java 2>/dev/null || javac -d out KtCore.java KtDlRules.java RuT.java
java -cp out RuT
