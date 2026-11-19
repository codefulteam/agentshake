#!/usr/bin/env bash
# Agentshake CLI walkthrough with two local profiles and the offline file transport.
# Every step is a real `agentshake` command. The operator approvals are SIMULATED: this
# script feeds each --preview digest straight to --approve. In real use you read the
# preview (or answer the terminal prompt) before approving. No GitHub account or network is used.
#
#   bash scripts/demo.sh            # uses `agentshake` from PATH
#   AGENTSHAKE="node dist/cli.js" bash scripts/demo.sh
set -euo pipefail

AS=${AGENTSHAKE:-agentshake}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/agentshake-walkthrough-XXXXXX")
trap 'rm -rf "$WORK"' EXIT
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s);console.log(process.argv[1].split(".").reduce((o,k)=>o[k],v))})' "$1"; }
say() { printf '\n\033[1m$ %s\033[0m\n' "$*"; }
alice() { $AS --json --profile "$WORK/alice" "$@"; }
bob() { $AS --json --profile "$WORK/bob" "$@"; }
alice_agent() { $AS --json agent --inbox "$WORK/alice-in" --outbox "$WORK/alice-out" "$@"; }
bob_agent() { $AS --json agent --inbox "$WORK/bob-in" --outbox "$WORK/bob-out" "$@"; }
# Operator approval without a terminal: preview, then approve that exact digest.
approve() { local who=$1; shift; local digest; digest=$($who "$@" --preview | field digest); $who "$@" --approve "$digest"; }

echo "Agentshake walkthrough (offline file transport; not GitHub). Workspace: $WORK"
say "agentshake key init   # alice and bob, each on their own machine"
A_KEY=$(alice key init | field publicKey)
B_KEY=$(bob key init | field publicKey)
echo "alice: $A_KEY"; echo "bob:   $B_KEY"

say "agentshake channel init --file mailbox.sqlite --account 1 --peer 2 --peer-key <bob>"
alice channel init --file "$WORK/mailbox.sqlite" --account 1 --peer 2 --peer-key "$B_KEY" >/dev/null
bob channel join --file "$WORK/mailbox.sqlite" --account 2 --peer 1 --peer-key "$A_KEY" >/dev/null
alice exchange configure --inbox "$WORK/alice-in" --outbox "$WORK/alice-out" >/dev/null
bob exchange configure --inbox "$WORK/bob-in" --outbox "$WORK/bob-out" >/dev/null
echo "paired and connected both agents"

say "agentshake agent ... draft new --kind review --title 'Review retry behavior' --body-file -"
DRAFT=$(printf 'Please review the retry loop in src/retry.ts.' | alice_agent draft new --kind review --title 'Review retry behavior' --body-file - | field draft)
echo "draft $DRAFT"

say "agentshake publish $DRAFT    # alice reviews and approves"
approve alice publish "$DRAFT" | field state
REQUEST=$DRAFT

say "agentshake inbox             # bob"
$AS --profile "$WORK/bob" inbox

say "agentshake accept $REQUEST --body-file brief.txt"
printf 'Review src/retry.ts. Read-only. Report findings as a reply.' > "$WORK/brief.txt"
approve bob accept "$REQUEST" --body-file "$WORK/brief.txt" | field briefReleased

say "agentshake agent ... briefs show $REQUEST   # bob's agent sees only bob's brief"
$AS agent --inbox "$WORK/bob-in" --outbox "$WORK/bob-out" briefs show "$REQUEST"

say "agentshake agent ... draft reply $REQUEST --body-file -   # bob's agent answers"
REPLY=$(printf 'Backoff is never reset after success.' | bob_agent draft reply "$REQUEST" --body-file - | field draft)
approve bob publish "$REPLY" >/dev/null

say "agentshake complete $REQUEST --reply $REPLY --outcome completed"
approve bob complete "$REQUEST" --reply "$REPLY" --outcome completed | field state

say "agentshake show $REQUEST     # alice"
$AS --profile "$WORK/alice" show "$REQUEST"
echo
echo "Walkthrough complete."
