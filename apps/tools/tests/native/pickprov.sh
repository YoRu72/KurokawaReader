#!/bin/sh
# The documents provider's plain logic (KtPickLogic: the roots and their titles, «Recent»'s bounded walk, the first-run
# default) compiled outside its package and run with PickT.java. The provider itself is Android's: GitHub's Android
# build is its compile.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
sed 's/^package app.kurokawa.tools;//; s/^final class KtPickLogic/public final class KtPickLogic/; s/^    static /    public static /; s/^    private KtPickLogic/    public KtPickLogic/' "$HERE/../../native/android/KtPickLogic.java" > "$D/KtPickLogic.java"
sed -i "s/public static final class Root { final File dir; final int kind; Root(/public static final class Root { public final File dir; public final int kind; public Root(/" "$D/KtPickLogic.java"
cp "$HERE/PickT.java" "$D/"
javac -encoding UTF-8 -nowarn -d "$D/out" "$D/KtPickLogic.java" "$D/PickT.java"
java -Dfile.encoding=UTF-8 -cp "$D/out" PickT
