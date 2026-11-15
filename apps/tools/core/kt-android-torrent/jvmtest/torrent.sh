#!/bin/sh
# Stage M3 from a plain JVM (no emulator): KtTorrentCore / KtTorrentRs against a build of libkt_torrent.so and
# KtTorDirector against libkt_android.so (TorrentT.java), then with no torrent library at all; and KtTorrentRsEngine
# compiled against a stand-in of KtEngine.Task (it needs org.json: KT_JSON_JAR, else that step is skipped).
# Usage: sh torrent.sh <libkt_torrent.so> [<libkt_android.so> [fake|real]]  (fake: the stand-in of test-host.sh;
# real: a librqbit build — CI)
set -e
T=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); [ -f "$T" ] || { echo "no library at $1"; exit 1; }
K=""; [ -n "$2" ] && K=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
HERE=$(cd "$(dirname "$0")" && pwd); A="$HERE/../../../native/android"; D=$(mktemp -d)
trap 'rm -rf "$D"' EXIT
# (In the app's package, as in the APK: the native symbols are Java_app_kurokawa_tools_…, and the test reaches the
# package-private classes.)
for f in KtCore KtTorrentCore KtTorrentRs KtTorDirector; do cp "$A/$f.java" "$D/"; done
cp "$HERE/TorrentT.java" "$D/"; cd "$D"
S="KtCore.java KtTorrentCore.java KtTorrentRs.java KtTorDirector.java TorrentT.java"
javac -encoding UTF-8 -nowarn -d out $S
java -Dkt.torrent.lib="$T" ${K:+-Dkt.core.lib="$K"} -cp out app.kurokawa.tools.TorrentT "${3:-fake}"
java -Dkt.torrent.lib="$D/no-such.so" -Dkt.core.lib="$D/no-such.so" -cp out app.kurokawa.tools.TorrentT absent
if [ -n "${KT_JSON_JAR:-}" ] && [ -f "$KT_JSON_JAR" ]; then
  mkdir -p stub && cp "$A/KtTorrentRsEngine.java" stub/
  # (Only the Task fields KtTorrentRsEngine uses, with KtEngine's own declarations.)
  printf 'package app.kurokawa.tools; final class KtEngine { static final class Task { String id, kind, name, dir, state, error, infoHash; org.json.JSONObject source = new org.json.JSONObject(), meta; long done, total, downSpeed, upSpeed, doneAt; int peers, seeds; boolean paused; int[] priorities; } }\n' > stub/KtEngine.java
  javac -encoding UTF-8 -nowarn -cp "$KT_JSON_JAR:out" -d out2 stub/KtEngine.java stub/KtTorrentRsEngine.java && echo "KtTorrentRsEngine compiles against KtEngine.Task's fields"
fi
