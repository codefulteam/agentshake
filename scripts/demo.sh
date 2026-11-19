#!/usr/bin/env bash
# Agentshake CLI walkthrough of the full handshake with two local profiles and the offline
# file transport. Every step is a real `agentshake` command. The operator approvals are
# SIMULATED: this script feeds each --preview digest straight to --approve. In real use you
# read the preview (or answer the terminal prompt) before approving. No GitHub account or
# network is used.
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

echo "Agentshake handshake walkthrough (offline file transport; not GitHub). Workspace: $WORK"
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

say "agentshake agent ... draft new --kind review --title 'Review retry behavior' --body-file -   # offer"
REQUEST=$(printf 'Please review the retry loop in src/retry.ts.' | alice_agent draft new --kind review --title 'Review retry behavior' --body-file - | field draft)
approve alice publish "$REQUEST" | field state

say "agentshake inbox             # bob"
$AS --profile "$WORK/bob" inbox

say "agentshake brief $REQUEST --body-file -   # bob: negotiation brief, no work authority"
printf 'Alice wants a retry review. List what we are missing before I accept. Do not start.' > "$WORK/nb.txt"
approve bob brief "$REQUEST" --body-file "$WORK/nb.txt" | field stage

say "agentshake agent ... draft ask $REQUEST --items-file -   # bob's agent asks, bound to the brief's context"
cat > "$WORK/q.json" <<'JSON'
[{"topic": "Which branch and commit?", "need": "To review the code Alice means."},
 {"topic": "Production failure logs", "need": "To see how retries fail in practice."}]
JSON
ASK=$(bob_agent draft ask "$REQUEST" --items-file "$WORK/q.json" | field draft)
approve bob publish "$ASK" | field action

say "agentshake show $REQUEST     # alice sees the questions (escaped)"
$AS --profile "$WORK/alice" show "$REQUEST"

say "agentshake supply $REQUEST --answers-file -   # alice: one supplied, one unavailable"
printf '{"answers":[{"item":1,"status":"supplied","body":"main at the current head"},{"item":2,"status":"unavailable","body":"No logs were kept."}]}' > "$WORK/a.json"
approve alice supply "$REQUEST" --answers-file "$WORK/a.json" | field revision

say "agentshake ask $REQUEST --topic ... --need ...   # bob asks once more"
approve bob ask "$REQUEST" --topic 'Expected retry limit' --need 'To judge whether 5 attempts is a bug.' >/dev/null
printf '{"answers":[{"item":1,"status":"withheld","body":"Customer configuration is confidential."}]}' > "$WORK/a2.json"
approve alice supply "$REQUEST" --answers-file "$WORK/a2.json" >/dev/null
echo "second round answered (withheld)"

say "agentshake supply $REQUEST --answers-file -   # alice found a log line: resolve the earlier 'unavailable' item"
printf '{"resolutions":[{"ask":"%s","item":2,"body":"CI log: retry 6 of 5 after 0ms"}]}' "$ASK" > "$WORK/r.json"
approve alice supply "$REQUEST" --answers-file "$WORK/r.json" >/dev/null
$AS --profile "$WORK/bob" show "$REQUEST" | grep -E 'resolved later|current unresolved'

say "agentshake confirm $REQUEST --understanding-file -   # bob states understanding and limitations"
printf 'Review src/retry.ts on main, read-only, using the recovered CI log line. The retry limit was not shared.' > "$WORK/u.txt"
approve bob confirm "$REQUEST" --understanding-file "$WORK/u.txt" | field action

say "agentshake accept $REQUEST --body-file brief.txt   # cites the current confirmation"
printf 'Review src/retry.ts on main. Read-only. Report findings as a reply.' > "$WORK/brief.txt"
approve bob accept "$REQUEST" --body-file "$WORK/brief.txt" | field briefReleased

say "agentshake agent ... briefs show $REQUEST   # bob's agent sees only bob's work brief"
$AS agent --inbox "$WORK/bob-in" --outbox "$WORK/bob-out" briefs show "$REQUEST"

say "agentshake agent ... draft reply $REQUEST --body-file -   # bob's agent reports the result"
REPLY=$(printf 'Backoff is never reset after success.' | bob_agent draft reply "$REQUEST" --body-file - | field draft)
approve bob publish "$REPLY" >/dev/null

say "agentshake complete $REQUEST --reply $REPLY --outcome completed"
approve bob complete "$REQUEST" --reply "$REPLY" --outcome completed | field state

say "agentshake show $REQUEST     # alice"
$AS --profile "$WORK/alice" show "$REQUEST"
echo
echo "Walkthrough complete."
