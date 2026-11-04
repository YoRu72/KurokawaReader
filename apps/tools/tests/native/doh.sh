#!/bin/sh
# Compiles KrDoh and KrDohProxy (outside their package, with a stub org.json and a KtStream.readLine) and runs their
# checks: the DNS question and answer, the JSON form, base64url, the hello cut inside the name, the resolvers' order;
# the proxy's CONNECT tunnel (the hello split in two records that a server joins back) and a plain GET forwarded.
set -e
D=$(mktemp -d); HERE=$(cd "$(dirname "$0")" && pwd)
for f in KrDoh KrDohProxy; do sed "s/^final class $f/public final class $f/; s/^package .*;//" "$HERE/../../native/android/$f.java" > "$D/$f.java"; done
cp -r "$HERE/doh/." "$D/"; cd "$D"; javac -nowarn -d out org/json/*.java KrDoh.java KrDohProxy.java KtStream.java DT.java PT.java 2>/dev/null || javac -d out org/json/*.java KrDoh.java KrDohProxy.java KtStream.java DT.java PT.java
java -cp out DT && java -cp out PT && echo "doh: all passed"
