#!/usr/bin/env bash
# Runs INSIDE a disposable Linux container as root. Creates two container-local accounts:
# `op` (operator, uid 1001) and `ag` (agent, uid 1002), both in group `agentshake-x`.
# Verifies the --group exchange mode end to end and that the agent cannot read the
# operator profile or key, or tamper with released briefs. Exits non-zero on any failure.
set -euo pipefail
export PATH=/opt/node/bin:$PATH
AS=/opt/pkg/node_modules/.bin/agentshake
pass() { echo "PASS $*"; }
fail() { echo "FAIL $*"; exit 1; }
groupadd -g 1500 agentshake-x
useradd -m -u 1001 -G agentshake-x op
useradd -m -u 1002 -G agentshake-x ag
chmod 0750 /home/op
as_op() { setpriv --reuid=1001 --regid=1001 --init-groups env HOME=/home/op PATH="$PATH" "$@"; }
as_ag() { setpriv --reuid=1002 --regid=1002 --init-groups env HOME=/home/ag PATH="$PATH" "$@"; }
j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(process.argv[1].split(".").reduce((o,k)=>o[k],v))})' "$1"; }
approve() { local who=$1; shift; local d; d=$(as_op "$AS" --json --profile "/home/op/$who" "$@" --preview | j digest); as_op "$AS" --json --profile "/home/op/$who" "$@" --approve "$d"; }
mkdir -p /srv/exchange && chown op:op /srv/exchange && chmod 0755 /srv/exchange

A=$(as_op "$AS" --json --profile /home/op/alice key init | j publicKey)
B=$(as_op "$AS" --json --profile /home/op/bob key init | j publicKey)
as_op "$AS" --json --profile /home/op/alice channel init --file /home/op/mailbox.sqlite --account 1 --peer 2 --peer-key "$B" >/dev/null
as_op "$AS" --json --profile /home/op/bob channel join --file /home/op/mailbox.sqlite --account 2 --peer 1 --peer-key "$A" >/dev/null
as_op "$AS" --json --profile /home/op/alice exchange configure --inbox /home/op/alice-x/in --outbox /home/op/alice-x/out >/dev/null
as_op "$AS" --json --profile /home/op/bob exchange configure --inbox /srv/exchange/inbox --outbox /srv/exchange/outbox --group agentshake-x >/dev/null
stat -c '%a %U:%G %n' /srv/exchange/inbox /srv/exchange/outbox
pass "operator configured group exchange"

REQ=$(echo "Please review retry.ts" | as_op "$AS" --json agent --inbox /home/op/alice-x/in --outbox /home/op/alice-x/out draft new --kind review --title "Review" --body-file - | j draft)
approve alice publish "$REQ" >/dev/null
# Pre-accept handshake: a negotiation brief for the agent account, its question draft, answer, confirmation.
printf 'Alice wants a review. Help me list what is missing. Do not start.' > /tmp/nb.txt && chmod 644 /tmp/nb.txt
approve bob brief "$REQ" --body-file /tmp/nb.txt >/dev/null
[ "$(as_ag "$AS" --json agent --inbox /srv/exchange/inbox --outbox /srv/exchange/outbox briefs show "$REQ" | j stage)" = negotiating ] || fail "agent cannot read the negotiation brief"
Q=$(as_ag "$AS" --json agent --inbox /srv/exchange/inbox --outbox /srv/exchange/outbox draft ask "$REQ" --topic "Which branch?" --need "To review the right code." | j draft)
approve bob publish "$Q" >/dev/null
printf '{"answers":[{"item":1,"status":"supplied","body":"main"}]}' > /tmp/a.json && chmod 644 /tmp/a.json
approve alice supply "$REQ" --answers-file /tmp/a.json >/dev/null
printf 'Review retry.ts on main, read-only.' > /tmp/u.txt && chmod 644 /tmp/u.txt
approve bob confirm "$REQ" --understanding-file /tmp/u.txt >/dev/null
pass "agent (uid 1002) drafted a question from a negotiation brief; operator asked, peer answered, operator confirmed"
printf 'Review retry.ts only. Report findings.' > /tmp/brief.txt && chmod 644 /tmp/brief.txt
approve bob accept "$REQ" --body-file /tmp/brief.txt >/dev/null
stat -c '%a %U:%G %n' /srv/exchange/inbox/*.json

# Agent account: reads the released brief through the group, cannot read operator state.
[ "$(as_ag "$AS" --json agent --inbox /srv/exchange/inbox --outbox /srv/exchange/outbox briefs show "$REQ" | j body)" = "Review retry.ts only. Report findings." ] || fail "agent cannot read brief"
pass "agent (uid 1002) reads the brief released by the operator (uid 1001)"
as_ag cat /home/op/bob/operator.sqlite >/dev/null 2>&1 && fail "agent read the operator database"
as_ag ls /home/op/bob >/dev/null 2>&1 && fail "agent listed the operator profile"
as_ag "$AS" --profile /home/op/bob inbox >/dev/null 2>&1 && fail "agent used the operator profile"
pass "agent is denied the operator profile and key"
as_ag sh -c "echo tamper > /srv/exchange/inbox/$REQ.json" 2>/dev/null && fail "agent modified a brief"
as_ag touch /srv/exchange/inbox/new.json 2>/dev/null && fail "agent created a file in the inbox"
pass "agent cannot modify or add briefs"

# Agent writes a draft (shell); operator reads it through the group and publishes it.
D1=$(echo "Clarify: is jitter in scope?" | as_ag "$AS" --json agent --inbox /srv/exchange/inbox --outbox /srv/exchange/outbox draft reply "$REQ" --body-file - | j draft)
stat -c '%a %U:%G %n' "/srv/exchange/outbox/$D1.json"
approve bob publish "$D1" >/dev/null
pass "operator published a draft written by the agent account"

# Brief replacement is an atomic rename: the new file must still be group-readable.
printf 'Review retry.ts including jitter.' > /tmp/brief2.txt && chmod 644 /tmp/brief2.txt
approve bob brief "$REQ" --body-file /tmp/brief2.txt >/dev/null
[ "$(as_ag "$AS" --json agent --inbox /srv/exchange/inbox --outbox /srv/exchange/outbox briefs show "$REQ" | j body)" = "Review retry.ts including jitter." ] || fail "agent cannot read the replaced brief"
pass "replaced brief (atomic rename) remains readable by the agent"

# MCP over stdio as the agent account: all three tools.
OUT=$(as_ag node /opt/client/mcp-client.mjs "$AS" /srv/exchange/inbox /srv/exchange/outbox "$REQ")
D2=$(echo "$OUT" | j draft)
[ "$(echo "$OUT" | j body)" = "Review retry.ts including jitter." ] || fail "MCP read_brief"
approve bob publish "$D2" >/dev/null
approve bob complete "$REQ" --reply "$D2" --outcome completed >/dev/null
[ "$(as_op "$AS" --json --profile /home/op/alice show "$REQ" | j state)" = completed ] || fail "final state"
pass "MCP list/read/create_draft as the agent account; operator published and completed"
echo "ALL PASS"
