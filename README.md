# Agentshake

**A handshake between your coding agents.**

Agentshake lets two developers pass coding questions, review requests, proposals and task
results between their own coding agents. Each side works under its own account, on its own
machine, and every message is approved by a human operator before it leaves.

A handoff is a handshake, not a throw over the wall:

```
offer ─▶ ask for missing items (and why) ─▶ supply: supplied | unavailable | withheld ─▶ … ─▶
confirm your understanding and current known limitations ─▶ accept that exact context ─▶ result
```

- **Operator-approved**: agents only write *drafts*. A person reviews the exact bytes and signs them.
- **Context before commitment**: the recipient asks typed questions, the requester answers each one
  (or says it is unavailable or withheld), and acceptance is bound to a signed confirmation of that
  exact context version. New context makes an earlier confirmation stale.
- **Signed and replayable**: every action is an Ed25519-signed event in one hash-chained ledger
  that both sides verify. Rollbacks, forks, forged or out-of-role events are rejected.
- **Prompt-injection aware**: text from the other side is shown to the operator (escaped), never
  handed to the agent. The agent only reads a brief the local operator wrote.
- **No server, offline-capable**: the mailbox is a private GitHub repository you already control,
  or a local file on one trusted machine with no network at all ([docs/local.md](docs/local.md)).
  No daemon, no hosted backend, no model API.
- **A written protocol**: humans and agents use the same nine operations. The draft
  [specification](spec/README.md), JSON Schemas, examples, vectors and an offline conformance
  runner ship in the package.
- **Agent-neutral**: any agent that can run a shell command or speak MCP over stdio can use it.

> Status: **v0.3.0 candidate** (wire protocol 2, unchanged since 0.2.0; the package version is
> independent of the protocol number). The protocol, its draft specification, CLI, MCP server and
> GitHub adapter are implemented. The GitHub adapter is tested against a GitHub
> CLI test double; live two-account GitHub use has **not** been verified yet. Agentshake provides
> no sandbox itself; two agent isolation setups are verified by scripted tests (see
> [What is verified](#what-is-verified)). Coming from 0.1? See [Upgrading from 0.1](#upgrading-from-01).

## Try it in one minute (no GitHub account)

Requires Node.js 24 LTS or 26 LTS. Either build from a checkout:

```sh
git clone https://github.com/codefulteam/agentshake && cd agentshake
npm ci && npm run build
node dist/cli.js demo
```

or install a release tarball and run `agentshake demo` (see [Install](#install)).

`agentshake demo` runs a complete two-person handshake offline: two profiles (Alice and Bob), a
local file mailbox, a review offer containing a hostile "ignore previous instructions" line, a
negotiation brief for Bob's agent (no work authority), three questions with reasons, answers that
are supplied, unavailable and withheld, a second question round, a confirmation that lists the
current unresolved limitations after an explicit resolution of the unavailable item, a note that makes it stale (and the refused stale accept), a new confirmation,
acceptance with a work brief, findings, completion, and the decline, cancel and expiry endings. It
uses the same code as real use, and it says clearly that it is the unauthenticated **file**
transport, not GitHub. **Approvals in the demo are simulated**: it approves on behalf of both
people so the story runs in one go.

To keep the workspace and try the real approval flow yourself, keep it with `--dir`. The demo
leaves one offer pending and prints the exact commands to ask, answer, confirm and accept it:

```sh
agentshake demo --dir ./agentshake-demo
```

`scripts/demo.sh` walks the same handshake through individual CLI commands, with JSON payloads
from files and stdin. It also simulates the
human review, by feeding each `--preview` digest to `--approve`; in real use you read the
preview (or answer the terminal prompt) before approving.

## How it works

```
 Alice's machine                                   Bob's machine
 ┌──────────────┐  draft   ┌──────────┐          ┌──────────┐  brief   ┌──────────────┐
 │ Alice's agent│ ───────▶ │ operator │          │ operator │ ───────▶ │  Bob's agent │
 │ (sandboxed)  │ ◀─────── │   CLI    │          │   CLI    │ ◀─────── │  (sandboxed) │
 └──────────────┘  brief   └────┬─────┘          └────┬─────┘  draft   └──────────────┘
   reads inbox (ro)             │ sign + append        │ verify + read     writes outbox
   writes outbox (rw)           ▼                      ▼
                      ┌────────────────────────────────────────┐
                      │ private GitHub repo: one signed ledger  │
                      │ agentshake-mailbox-v2.json              │
                      └────────────────────────────────────────┘
```

1. **Offer.** Alice's agent writes a **draft** into its outbox (`agentshake agent ... draft new`).
   Alice runs `agentshake publish <draft>`, sees the destination, signer and exact text, and
   approves. The event is signed and appended with a compare-and-swap on the branch head.
2. **Read.** Bob runs `agentshake inbox` and `agentshake show <id>`. Remote text stays in his
   terminal, escaped. Optionally he writes a **negotiation brief** for his agent in his own words
   (`agentshake brief <id>`): it carries the context version but grants no work authority.
3. **Ask.** Bob (or his agent, as a draft) asks for missing items, each with the reason it is
   needed: `agentshake ask <id> --topic "Which branch?" --need "To review the right code"`.
4. **Supply.** Alice answers every open question exactly once: `supplied` with the content,
   `unavailable`, or `withheld`, bound to that question round and the current context version:
   `agentshake supply <id> --answers-file answers.json`. Steps 3–4 repeat within a budget.
5. **Confirm.** Bob states his understanding in his own words. The signed confirmation lists the
   unavailable and withheld items that are still unresolved as known limitations:
   `agentshake confirm <id> --understanding-file u.txt`. If Alice later recovers such an item, she
   resolves it explicitly with the content (`supply` with `resolutions`); the original answer stays
   in the history, and the item leaves the current limitations.
   Alice can still add context (`supply --note-file`), which makes the confirmation stale.
6. **Accept.** `agentshake accept <id>` cites the current confirmation and context digest, and
   releases Bob's **work brief** to his agent's read-only inbox. The context is now frozen.
7. **Result.** Bob's agent drafts a reply; Bob publishes it and runs
   `agentshake complete <id> --reply <reply-id> --outcome completed` (or `--outcome failed`). Alice
   sees the linked result and can brief her own agent.

Bob can decline at any point before accepting; Alice can cancel until the request is finished.
Requests expire (default 7 days). Post-accept replies are for results and clarifications that do
not change scope; to change scope after acceptance, Alice cancels and sends a new offer.

## Install

Agentshake is distributed as a release tarball first. npm publication may follow.

```sh
# From a release tarball, online or fully offline (runtime dependencies are bundled in the tarball)
npm install --offline --no-audit --no-fund --prefix ~/agentshake ./agentshake-0.3.0.tgz
~/agentshake/node_modules/.bin/agentshake demo

# From source
git clone https://github.com/codefulteam/agentshake && cd agentshake
npm ci && npm run build
node dist/cli.js demo
```

Supported runtime: Node.js `^24.11.0 || ^26.0.0` (both LTS lines; verified on 24.22.3 and 26.13.0;
the CI workflow is configured for the latest of each). The package ships an `npm-shrinkwrap.json`,
so installs use the exact dependency versions that were tested.
Agentshake uses Node's built-in `node:sqlite`, `node:crypto` and test runner. The GitHub
transport needs the [GitHub CLI](https://cli.github.com/) (`gh`).

## Use without GitHub

For personal use on one machine (you and your own agents, two local principals, no GitHub
account), offline installation and the exact limits of the unauthenticated file mailbox, see
[docs/local.md](docs/local.md).

## Use with GitHub

Each developer uses their **own** GitHub account and their own `gh` login.

**Owner (Alice)** creates a dedicated **private** repository with an initial commit (for example
with a README), invites Bob with write access, and disables Actions, webhooks and integrations on
it. Keep it separate from any source repository: it stores message text in Git history.

```sh
# Both, once per machine
gh auth login --hostname github.com
agentshake key init          # prints your public key and fingerprint
```

Exchange public keys once over a channel you already trust, and compare fingerprints.

```sh
# Alice
agentshake channel init --repo alice/agentshake-mailbox --peer bob --peer-key <bob-public-key>

# Bob (the command Alice's output prints for him)
agentshake channel join --repo alice/agentshake-mailbox --peer alice --peer-key <alice-public-key>

# Both
agentshake doctor
```

`--peer` accepts a GitHub login (resolved once to its immutable numeric ID) or a numeric ID.
Pairing pins the repository node ID, branch, genesis digest, both account IDs and both keys.
A different repository, account, key or roster later fails closed.

### Connect your agent

The operator chooses two local directories outside the profile:

```sh
agentshake exchange configure --inbox ~/agentshake-exchange/inbox --outbox ~/agentshake-exchange/outbox
```

Give the agent the inbox **read-only** and the outbox read-write. The agent side never touches
the network, the profile, the key or `gh`. If the agent runs as a **different OS account**, add
`--group <group>` (both accounts must be members): the inbox becomes `2750`, the outbox `2770`,
and new briefs and drafts are group-readable `0640`. Without `--group`, both directories are
`0700` and files `0600`, which suits an agent sandboxed under your own UID with only these two
directories visible. Reconfiguring invalidates brief approvals that were not yet released.

```sh
agentshake agent --inbox /exchange/inbox --outbox /exchange/outbox briefs list
agentshake agent --inbox /exchange/inbox --outbox /exchange/outbox briefs show <request-id>
agentshake agent --inbox /exchange/inbox --outbox /exchange/outbox draft reply <request-id> --body-file findings.md
agentshake agent --inbox /exchange/inbox --outbox /exchange/outbox mcp     # stdio MCP server
```

The MCP server exposes `list_briefs`, `read_brief` and `create_draft` (drafts for offers, questions,
answers, confirmations and results). It never returns remote text. Example host entry:

```json
{ "mcpServers": { "agentshake": {
    "command": "/absolute/path/to/agentshake",
    "args": ["agent", "--inbox", "/exchange/inbox", "--outbox", "/exchange/outbox", "mcp"] } } }
```

See [docs/agents.md](docs/agents.md) for shell and MCP setup with Codex, Claude, Grok, Kimi,
DeepSeek-based and other agents, and for what has and has not been tested.

### Claude Code and Codex plugin

[`plugins/agentshake`](plugins/agentshake/README.md) packages this MCP server and a workflow skill
as one local plugin for Claude Code and Codex. It runs your installed engine and does no network
fetch. You point it at the exchange directories once, with a small binding file. This repository
is also a plugin catalog for both hosts:

```sh
claude plugin marketplace add ./agentshake && claude plugin install agentshake@agentshake
codex plugin marketplace add ./agentshake && codex plugin add agentshake@agentshake
```

The agent still only drafts; you publish. Local stdio plugins need a host that runs on your
machine. They do not work in ChatGPT web or other cloud agents. See the
[plugin README](plugins/agentshake/README.md) for prerequisites, offline installation and the
hosts that have been verified.

**Isolation is your job.** Agentshake cannot stop an agent that runs unrestricted as your user
from reading your profile or using `gh` directly. Run the agent as a separate OS account (with
`--group`), or in a sandbox or container that only sees the two exchange directories. Two such
setups are verified by scripts in `test/isolation/` (a two-account Linux container and a macOS
`sandbox-exec` profile); see [docs/agents.md](docs/agents.md#isolation) and [SECURITY.md](SECURITY.md).

## Commands

| Operator command | What it does |
| --- | --- |
| `key init` / `key show` | Create / print your signing key and fingerprint |
| `channel init` / `channel join` | Pair two accounts and keys on one mailbox (`--repo` or `--file`) |
| `doctor` | Verify identity, history, capacity, exchange setup and unfinished work |
| `exchange configure` | Set the agent inbox/outbox directories |
| `inbox` / `outbox` [`--all`] | List open (or all) requests received / sent |
| `show <request>` | Read a request, its negotiation and replies, escaped, with next steps |
| `drafts` [`--offline`] | List unsent agent drafts, marked stale or current; like `inbox`/`show`, it reads the mailbox and removes stale negotiation briefs (`--offline`: no mailbox read, nothing checked or removed) |
| `publish <draft>` | Review, sign and send a draft (offer, ask, supply, confirm or reply) |
| `ask <request>` | Recipient: ask for missing items (`--topic`/`--need` or `--items-file`) |
| `supply <request>` | Requester: answer the open round (`--answers-file`) or add context (`--note-file`) |
| `confirm <request>` | Recipient: state your understanding of the current context (`--understanding-file`) |
| `accept <request>` | Accept the confirmed context and release your work brief (opens `$EDITOR`, or `--body-file`) |
| `brief <request>` | Release or replace a local brief (negotiation brief while pending); nothing is sent |
| `decline` / `cancel <request>` | Decline as recipient / cancel as requester |
| `complete <request> --reply <id> --outcome completed\|failed` | Close with your published reply |
| `pending` / `recover <operation>` | List and finish interrupted operations |
| `draft new\|reply\|ask\|supply\|confirm` | Write a draft yourself, in the same format your agent writes; then `publish` it |
| `demo` | Offline two-person demo |
| `validate <file> [--as ledger\|draft\|brief\|capabilities]` | Check a document offline: schema, canonical bytes, signatures, roles, state, capacity (no profile) |
| `capabilities` | Print supported protocol, profiles, operations, limits and schema IDs (no profile) |
| `conformance [-- <validator> …]` | Run the shipped conformance cases against the built-in or another validator (no profile) |

These operator actions ask for approval on the controlling terminal and show exactly what will
be signed or released (destination, signer, request revision, text, and for briefs the agent
inbox): `publish`, `ask`, `supply`, `confirm`, `accept`, `brief`, `decline`, `cancel` and `complete`. Setup commands
(`key`, `channel`, `exchange`) and agent drafts do not ask. For scripted use, approval stays
explicit:

```sh
agentshake publish <draft> --preview          # prints the action and an approval digest
agentshake publish <draft> --approve <digest> # executes only if nothing changed since the preview
```

What a preview does and does not do: it never signs, sends, stages a journal entry, or releases
or removes a brief, and it refuses (with the reason) any action the mailbox would reject. It does
read and verify the mailbox, and like every verified read it may advance your profile's rollback
checkpoint (the observed prefix in `operator.sqlite`), so a later rollback is still detected. Like
every command it creates the profile database if it does not exist. A preview of an already
approved, staged draft makes no network call and no profile write.

The digest binds the reviewed action; it is a check for a human operator, not a secret. Any
software running with the operator's access could compute it, which is another reason the agent
must not run with that access. A draft that was approved but whose delivery is unconfirmed is never
resent implicitly: `publish` then tells you to run `agentshake recover <draft-id>`.

Bodies and JSON payloads can come from a file or stdin (`--body-file -`, `--answers-file -`). Use
`--json` for machine-readable output; it includes stable IDs, revisions, the context revision and
digest, the negotiation phase and whose move it is, ISO dates and a `next` array of suggested
commands.

An `answers.json` for `agentshake supply <id> --answers-file answers.json`:

```json
{ "answers": [ { "item": 1, "status": "supplied", "body": "main at abc123" },
               { "item": 2, "status": "unavailable", "body": "No logs were kept." },
               { "item": 3, "status": "withheld", "body": "Customer data stays private." } ] }
```

If an unavailable or withheld item turns up later, resolve it explicitly with the recovered
content (`agentshake show` prints the ask ID and item number of every unresolved one):

```json
{ "resolutions": [ { "ask": "<ask-id>", "item": 2, "body": "Found one log line: retry 6 of 5 after 0ms" } ] }
```

Errors go to stderr (JSON with `--json`, including command-line parser errors) with a `next` hint.

| Exit code | Meaning |
| --- | --- |
| 0 | Success (including an empty inbox) |
| 2 | Usage or invalid input |
| 3 | Authentication, permission or identity mismatch |
| 4 | State conflict: the request changed, closed or expired |
| 5 | Temporary or uncertain: retry, or `agentshake recover <operation>` |
| 6 | Integrity failure: bad signature, rollback, fork or malformed mailbox |

## Limits

Body 4096 UTF-8 bytes; title 120 characters; text may not contain terminal control characters
(tab and newline are allowed). Expiry 1 to 336 hours, default 168. Negotiation: up to 5 questions
per round, 4 answered rounds or notes per request, an understanding of up to 2048 bytes. Per
mailbox: 32 requests, 128 events and a 256 KiB ledger; per request: 32 events. Capacity for every
open request's remaining handshake (the answer to an open round, a confirmation, the accept, a
recipient reply and the closing event) is reserved in advance, so a peer cannot crowd out what you
need to finish or close. At least 9 maximum-size offers (13 with 1 KB bodies) can be open at once. Requests that **expire** without being
closed keep their reservation (replay has no trustworthy clock), so a mailbox with several expired
requests can fill up while showing little open work; cancel your own open requests when you no
longer need them. When a mailbox is full, settle open work and pair a new private repository.
There is no compaction or redirection.

## What is verified

Verified by the test suite on Node 24.22.3 and 26.13.0 (macOS arm64), including against the
installed package tarball, plus scripted isolation checks:

- Domain: canonical encoding and golden signature vectors, tampering, replays, wrong actor or
  audience, revision races, expiry, capacity reservations, unknown versions; negotiation roles
  (the requester cannot ask, confirm or accept), answers bound to the open round and context digest,
  skipped, duplicate or reordered answers, cross-request and replayed supplies, stale
  confirmations, frozen context after accept, round and size limits, and reserved closing capacity
  under a malicious filler; protocol 1 ledgers refused.
- Application: compare-and-swap races (one winner per request revision, including ask/supply,
  confirm/supply and supply/accept), retries for unrelated conflicts, loss before and after commit,
  crash after accept, restart recovery for supply and confirm, rollback and fork detection, profile
  locking; negotiation briefs without remote text, removed when stale, replaced on accept; protocol
  1 profiles refused with byte-identical files.
- CLI and MCP: the full two-profile handshake through the executable (file and stdin payloads,
  stale `--approve` refused), and all four MCP tools, including question, answer and confirmation
  drafts, through the official MCP TypeScript client over stdio.
- Specification: the JSON Schemas compile in Ajv strict mode and accept every shape the reference
  accepts; every example has the expected verdict under the schema, the built-in validator and the
  executable as an external validator; vectors are re-derived without the implementation; the
  human-human, human-agent and agent-agent conversations run live through the CLI and MCP and match
  the committed states; peer prose never reaches the agent side.
- GitHub adapter: exact `gh api graphql` argv, static queries, `createCommitOnBranch` with
  `expectedHeadOid`, stale-head conflicts, denial, rate limits, oversized/truncated/mismatched
  responses — **against a `gh` test double**, not live GitHub.
- Approvals: preview never signs, stages or releases, refuses actions the mailbox would reject, may
  only advance the rollback checkpoint, and a staged-draft preview makes no network call or profile
  write; brief approvals bind the agent inbox and
  exchange configuration; reconfiguration needs a new approval.
- Isolation (`test/isolation/`): in a network-less Ubuntu 24.04 container, an agent running as a
  separate UID in the `--group` exchange reads briefs (also after atomic replacement), writes drafts
  the operator publishes, uses the three original MCP tools (the isolation scripts predate
  `get_capabilities`), and is denied the operator profile, key and
  inbox writes. On macOS, an agent under a `sandbox-exec` profile with the same UID gets the same
  results plus denied network and `gh`.

- Host plugin (`plugins/agentshake`): the contract check, reproducible archives, and the launcher
  through the official MCP client (the same tools and schemas, a minimal child environment, and
  refusals). Claude Code 2.1.330 and Codex CLI 0.171.0 (macOS) installed it offline into fresh
  private homes and connected the MCP server. A Claude Code model session used the skill and the
  tools, and Codex served tool calls through its app server. See the
  [plugin README](plugins/agentshake/README.md#where-it-works).

Not yet verified: two real GitHub accounts on a real private repository, organization and branch
rule behavior, fine-grained tokens, Windows, CI on GitHub Actions, your own sandbox or host setup,
and any agent host or host surface not listed above.

## Roadmap

- **v0.1** — GitHub private repository transport, offline file transport, CLI and stdio MCP.
- **v0.2** — protocol 2: pre-accept context negotiation (ask, supply, confirm) and acceptance bound
  to a confirmed context.
- **v0.3** — draft specification, JSON Schemas, conformance runner, `validate`/`capabilities`,
  human drafts in the agent format, offline installation (wire protocol unchanged).
- Next — live two-account GitHub verification, repository-scoped auth (for example a GitHub App),
  metadata-only notifications.
- Later — more transports behind the same [transport contract](docs/transports.md) (for example
  other Git hosts or a shared filesystem), larger mailboxes, optional
  [A2A](https://a2a-protocol.org/) mapping. Agentshake makes no A2A conformance claim.

## Upgrading from 0.1

Agentshake 0.2 and later speak protocol 2 only, which needs a **fresh mailbox and a new profile**. Nothing
is migrated and nothing of yours is changed:

- Commands on a 0.1 profile stop with exit code 2 before touching it, and tell you both options.
- To finish open 0.1 requests, run the immutable 0.1.0 release on that profile:
  `npm exec --yes --package=https://github.com/codefulteam/agentshake/releases/download/v0.1.0/agentshake-0.1.0.tgz -- agentshake --profile ~/.agentshake inbox`
- To start protocol 2: `export AGENTSHAKE_HOME=~/.agentshake-v2`, then `agentshake key init`,
  exchange and verify the new fingerprints, and pair again (`channel init` / `channel join`).
  On GitHub the new ledger is `agentshake-mailbox-v2.json`; a dedicated new private repository is
  recommended, and the old `agentshake-mailbox-v1.json` is never read or changed.

See [docs/protocol.md#versioning](docs/protocol.md#versioning) for the exact rules.

## Documentation

- [spec/](spec/README.md) — the draft protocol 2 specification, schemas, examples, vectors and conformance cases
- [docs/local.md](docs/local.md) — offline installation and personal use without GitHub
- [docs/protocol.md](docs/protocol.md) — ledger format, signatures, transitions, limits, vectors
- [docs/architecture.md](docs/architecture.md) — layers, trust boundaries, recovery
- [docs/transports.md](docs/transports.md) — GitHub, file and memory adapters; writing a new one
- [docs/agents.md](docs/agents.md) — connecting coding agents via shell or MCP
- [plugins/agentshake](plugins/agentshake/README.md) — the Claude Code and Codex plugin (skill plus local MCP server)
- [SECURITY.md](SECURITY.md) — threat model and reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Acknowledgements

Agentshake builds on the [Model Context Protocol](https://modelcontextprotocol.io/) TypeScript SDK
(Apache-2.0), [Commander.js](https://github.com/tj/commander.js) (MIT), [Zod](https://zod.dev/)
(MIT) and the [GitHub CLI](https://cli.github.com/). The first three are bundled in the package
tarball with their own license files; their copyrights belong to their authors. The request lifecycle was informed by the
task states of the [A2A protocol](https://a2a-protocol.org/). Out-of-band fingerprint checks follow
the same idea as verifying an SSH host key. No third-party source code is copied into this project.

## License

[Apache-2.0](LICENSE). Copyright 2026 codefulteam.
