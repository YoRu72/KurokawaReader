#!/bin/sh
# Compiles KtDlRules.java (the download queue's decisions, plain Java) outside its package with RuT.java and runs it.
set -e
D=$(mktemp -d); HERE=$(cd "$(dirname "$0")" && pwd)
sed 's/^final class KtDlRules/public final class KtDlRules/; s/^package .*;//' "$HERE/../../native/android/KtDlRules.java" > "$D/KtDlRules.java"
cp "$HERE/RuT.java" "$D/"; cd "$D"; javac -nowarn -d out KtDlRules.java RuT.java 2>/dev/null || javac -d out KtDlRules.java RuT.java
java -cp out RuT
