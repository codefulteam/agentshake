#!/usr/bin/env bash
# Package smoke test: pack, install the tarball into a clean prefix, and run the
# end-to-end suites against the installed `agentshake` executable.
#   PACK_DIR=/some/dir bash scripts/smoke.sh   # keep the tarball there
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/agentshake-smoke-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
PACK_DIR=${PACK_DIR:-$WORK/pack}
mkdir -p "$PACK_DIR" "$WORK/prefix"
cd "$ROOT"
TARBALL=$(npm pack --silent --pack-destination "$PACK_DIR" | tail -n 1)
echo "packed $PACK_DIR/$TARBALL"
(cd "$WORK/prefix" && npm init -y >/dev/null && npm install --no-audit --no-fund --silent "$PACK_DIR/$TARBALL")
BIN="$WORK/prefix/node_modules/.bin/agentshake"
"$BIN" --version
"$BIN" --help >/dev/null
"$BIN" demo --json >/dev/null
AGENTSHAKE="$BIN" bash "$ROOT/scripts/demo.sh" >/dev/null
AGENTSHAKE_BIN="$BIN" node --test --test-concurrency=1 test/journey.test.mjs test/github.test.mjs
echo "smoke ok: $BIN"
