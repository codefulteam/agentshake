#!/usr/bin/env bash
# macOS same-UID isolation check with sandbox-exec (Seatbelt). The agent process runs as
# the operator's own UID but under a profile that denies the network, the operator
# profile, the gh configuration and writes to the inbox. Exits non-zero on any failure.
#   AGENTSHAKE=/path/to/agentshake bash test/isolation/sandbox-exec.sh
# Note: Apple marks sandbox-exec as deprecated; this is a verification harness and an
# example, not a supported sandbox product.
set -euo pipefail
AS=${AGENTSHAKE:-agentshake}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/agentshake-seatbelt-XXXXXX"); W=$(cd "$W" && pwd -P)
trap 'rm -rf "$W"' EXIT
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(process.argv[1].split(".").reduce((o,k)=>o[k],v))})' "$1"; }
op() { "$AS" --json --profile "$W/$1" "${@:2}"; }
approve() { local who=$1; shift; local d; d=$(op "$who" "$@" --preview | j digest); op "$who" "$@" --approve "$d"; }
GH_DIR=${GH_CONFIG_DIR:-$HOME/.config/gh}
cat > "$W/agent.sb" <<SB
(version 1)
(allow default)
(deny network*)
(deny file-read* file-write* (subpath "$W/alice") (subpath "$W/bob") (subpath "$GH_DIR"))
(deny file-write* (subpath "$W/bob-x/inbox"))
SB
sandboxed() { sandbox-exec -f "$W/agent.sb" "$@"; }

A=$(op alice key init | j publicKey); B=$(op bob key init | j publicKey)
op alice channel init --file "$W/mailbox.sqlite" --account 1 --peer 2 --peer-key "$B" >/dev/null
op bob channel join --file "$W/mailbox.sqlite" --account 2 --peer 1 --peer-key "$A" >/dev/null
op alice exchange configure --inbox "$W/alice-x/inbox" --outbox "$W/alice-x/outbox" >/dev/null
op bob exchange configure --inbox "$W/bob-x/inbox" --outbox "$W/bob-x/outbox" >/dev/null
REQ=$(echo "Please review" | "$AS" --json agent --inbox "$W/alice-x/inbox" --outbox "$W/alice-x/outbox" draft new --kind review --title Review --body-file - | j draft)
approve alice publish "$REQ" >/dev/null
AG=(agent --inbox "$W/bob-x/inbox" --outbox "$W/bob-x/outbox")
# Pre-accept handshake: the sandboxed agent drafts a question from a negotiation brief.
printf 'Help me list what is missing. Do not start.' > "$W/nb.txt"
approve bob brief "$REQ" --body-file "$W/nb.txt" >/dev/null
[ "$(sandboxed "$AS" --json "${AG[@]}" briefs show "$REQ" | j stage)" = negotiating ] || fail "sandboxed agent cannot read the negotiation brief"
Q=$(sandboxed "$AS" --json "${AG[@]}" draft ask "$REQ" --topic "Which branch?" --need "To review the right code." | j draft)
approve bob publish "$Q" >/dev/null
printf '{"answers":[{"item":1,"status":"supplied","body":"main"}]}' > "$W/a.json"
approve alice supply "$REQ" --answers-file "$W/a.json" >/dev/null
printf 'Review on main, read-only.' > "$W/u.txt"
approve bob confirm "$REQ" --understanding-file "$W/u.txt" >/dev/null
pass "sandboxed agent drafted a question from a negotiation brief; handshake confirmed"
printf 'Review only.' > "$W/brief.txt"
approve bob accept "$REQ" --body-file "$W/brief.txt" >/dev/null

[ "$(sandboxed "$AS" --json "${AG[@]}" briefs show "$REQ" | j body)" = "Review only." ] || fail "sandboxed agent cannot read brief"
pass "sandboxed agent reads the brief"
sandboxed cat "$W/bob/operator.sqlite" >/dev/null 2>&1 && fail "sandbox read the operator database"
sandboxed "$AS" --profile "$W/bob" inbox >/dev/null 2>&1 && fail "sandbox used the operator profile"
pass "operator profile and key are denied inside the sandbox"
sandboxed sh -c "echo x > '$W/bob-x/inbox/$REQ.json'" 2>/dev/null && fail "sandbox modified a brief"
pass "inbox is read-only inside the sandbox"
sandboxed node -e "fetch('https://example.com').then(()=>process.exit(0),()=>process.exit(3))" && fail "sandbox reached the network"
pass "network is denied inside the sandbox"
if command -v gh >/dev/null; then
  sandboxed gh auth status >/dev/null 2>&1 && fail "sandbox could use gh credentials"
  pass "gh credentials are unusable inside the sandbox"
fi
D1=$(echo "Findings." | sandboxed "$AS" --json "${AG[@]}" draft reply "$REQ" --body-file - | j draft)
approve bob publish "$D1" >/dev/null
pass "operator published a draft written inside the sandbox"
printf 'Review only, round two.' > "$W/brief2.txt"
approve bob brief "$REQ" --body-file "$W/brief2.txt" >/dev/null
[ "$(sandboxed "$AS" --json "${AG[@]}" briefs show "$REQ" | j body)" = "Review only, round two." ] || fail "replaced brief unreadable"
pass "replaced brief (atomic rename) is readable inside the sandbox"
if [ -d "$ROOT/node_modules/@modelcontextprotocol/client" ]; then
  OUT=$(sandboxed node "$HERE/mcp-client.mjs" "$(command -v "$AS" || echo "$AS")" "$W/bob-x/inbox" "$W/bob-x/outbox" "$REQ")
  approve bob publish "$(echo "$OUT" | j draft)" >/dev/null
  pass "MCP list/read/create_draft inside the sandbox"
fi
echo "ALL PASS"
