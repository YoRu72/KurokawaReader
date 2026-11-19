#!/bin/sh
# org.json's jar for the native tests, fetched in one place: every script that needs it runs `J=$(sh jsonjar.sh)` and
# gets its path (kept in $KT_JARS, else ~/.cache/kt-test-jars; on GitHub that file is restored by actions/cache —
# .github/actions/json-jar). Maven Central answers 429 at times: up to six tries with a growing pause (5, 10, 20, 40,
# 60 s), into a temporary name, and only a file that is a zip and the expected size range is kept.
# (No SHA-256 is checked: the repository holds no verified checksum for this jar yet. Set KT_JSON_SHA256 to check one.)
set -e
V=20240303
LIB=${KT_JARS:-$HOME/.cache/kt-test-jars}; mkdir -p "$LIB"; J="$LIB/json-$V.jar"
URL="https://repo1.maven.org/maven2/org/json/json/$V/json-$V.jar"
good() { [ -s "$1" ] && [ "$(head -c 2 "$1")" = "PK" ] && [ "$(wc -c < "$1")" -gt 20000 ] && { [ -z "${KT_JSON_SHA256:-}" ] || [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$KT_JSON_SHA256" ]; }; }
if ! good "$J"; then
  rm -f "$J"; T="$J.part.$$"; n=0
  for wait in 5 10 20 40 60 0; do
    n=$((n + 1))
    if curl -sSfL --retry 0 -o "$T" "$URL" && good "$T"; then mv -f "$T" "$J"; break; fi
    rm -f "$T"; [ "$wait" -gt 0 ] || break
    echo "org.json jar: try $n failed, again in ${wait}s" >&2; sleep "$wait"
  done
  good "$J" || { echo "org.json jar: could not be fetched from Maven Central" >&2; exit 1; }
fi
echo "$J"
