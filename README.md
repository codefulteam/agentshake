# Agentshake

**A handshake between your coding agents.**

Agentshake lets two developers pass coding questions, review requests, proposals and task
results between their own coding agents. Each side works under its own account, on its own
machine, and every message is approved by a human operator before it leaves.

- **Operator-approved**: agents only write *drafts*. A person reviews the exact bytes and signs them.
- **Signed and replayable**: every action is an Ed25519-signed event in one hash-chained ledger
  that both sides verify. Rollbacks, forks, forged or out-of-role events are rejected.
- **Prompt-injection aware**: text from the other side is shown to the operator (escaped), never
  handed to the agent. The agent only reads a brief the local operator wrote.
- **No server**: the mailbox is a private GitHub repository you already control. No daemon, no
  hosted backend, no model API.
- **Agent-neutral**: any agent that can run a shell command or speak MCP over stdio can use it.

> Status: **v0.1.0 release candidate.** The protocol, CLI, MCP server and GitHub adapter are
> implemented. The GitHub adapter is tested against a GitHub CLI test double; live two-account
> GitHub use has **not** been verified yet. Agentshake provides no sandbox itself; two agent
> isolation setups are verified by scripted tests (see [What is verified](#what-is-verified)).

## Try it in one minute (no GitHub account)

Requires Node.js 24 LTS or 26 LTS. Either build from a checkout:

```sh
git clone https://github.com/codefulteam/agentshake && cd agentshake
npm ci && npm run build
node dist/cli.js demo
```

or, once the v0.1.0 release is published, install its tarball and run `agentshake demo`
(see [Install](#install)).

`agentshake demo` runs a complete two-person exchange offline: two profiles (Alice and Bob),
a local file mailbox, a review request containing a hostile "ignore previous instructions"
line, acceptance with a locally written brief, a clarification round trip, findings, completion,
and the decline, cancel and expiry endings. It uses the same code as real use, and it says
clearly that it is the unauthenticated **file** transport, not GitHub. **Approvals in the demo
are simulated**: it approves on behalf of both people so the story runs in one go.

To keep the workspace and try the real approval flow yourself, keep it with `--dir`. The demo
leaves one accepted task open and prints the exact commands for a reply round trip on it:

```sh
agentshake demo --dir ./agentshake-demo
```

`scripts/demo.sh` walks the journey through individual CLI commands. It also simulates the
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
                      │ agentshake-mailbox-v1.json              │
                      └────────────────────────────────────────┘
```

1. Alice's agent writes a **draft** into its outbox: `agentshake agent ... draft new`.
2. Alice runs `agentshake publish <draft>`, sees the destination, signer and exact text, and
   approves. The event is signed and appended with a compare-and-swap on the branch head.
3. Bob runs `agentshake inbox` and `agentshake show <id>`. Remote text stays in his terminal.
4. Bob runs `agentshake accept <id>` and writes a **brief** in his own words. Only that brief is
   released to his agent's read-only inbox.
5. Bob's agent drafts a reply; Bob publishes it and runs
   `agentshake complete <id> --reply <reply-id> --outcome completed` (or `--outcome failed`).
6. Alice sees the linked result with `agentshake show <id>` and can brief her own agent.

Either side can ask for clarification with further replies. Bob can decline before accepting.
Alice can cancel until the request is finished. Requests expire (default 7 days).

## Install

Agentshake is distributed as a release tarball first. npm publication may follow.

```sh
# From a GitHub release (after v0.1.0 is published)
npm install -g https://github.com/codefulteam/agentshake/releases/download/v0.1.0/agentshake-0.1.0.tgz

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

The MCP server exposes `list_briefs`, `read_brief` and `create_draft`. Example host entry:

```json
{ "mcpServers": { "agentshake": {
    "command": "/absolute/path/to/agentshake",
    "args": ["agent", "--inbox", "/exchange/inbox", "--outbox", "/exchange/outbox", "mcp"] } } }
```

See [docs/agents.md](docs/agents.md) for shell and MCP setup with Codex, Claude, Grok, Kimi,
DeepSeek-based and other agents, and for what has and has not been tested.

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
| `show <request>` | Read a request and replies, escaped, with next steps |
| `drafts` | List unsent agent drafts |
| `publish <draft>` | Review, sign and send a draft (new request or reply) |
| `accept <request>` | Accept and release your brief (opens `$EDITOR`, or `--body-file`) |
| `brief <request>` | Release or replace a local brief; nothing is sent |
| `decline` / `cancel <request>` | Decline as recipient / cancel as requester |
| `complete <request> --reply <id> --outcome completed\|failed` | Close with your published reply |
| `pending` / `recover <operation>` | List and finish interrupted operations |
| `demo` | Offline two-person demo |

These operator actions ask for approval on the controlling terminal and show exactly what will
be signed or released (destination, signer, request revision, text, and for briefs the agent
inbox): `publish`, `accept`, `brief`, `decline`, `cancel` and `complete`. Setup commands
(`key`, `channel`, `exchange`) and agent drafts do not ask. For scripted use, approval stays
explicit:

```sh
agentshake publish <draft> --preview          # prints the action and an approval digest; changes nothing
agentshake publish <draft> --approve <digest> # executes only if nothing changed since the preview
```

The digest binds the reviewed action; it is a check for a human operator, not a secret. Any
software running with the operator's access could compute it, which is another reason the agent
must not run with that access. A draft that was approved but whose delivery is unconfirmed is never
resent implicitly: `publish` then tells you to run `agentshake recover <draft-id>`.

Bodies can come from a file or stdin (`--body-file -`). Use `--json` for machine-readable output;
it includes stable IDs, revisions, ISO dates and a `next` array of suggested commands. Errors go to
stderr (JSON with `--json`) with a `next` hint.

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
(tab and newline are allowed). Expiry 1 to 336 hours, default 168. Per mailbox: 32 requests,
128 events and a 256 KiB ledger; per request: 32 events. Capacity for every open request's
accept, recipient reply and closing event is reserved in advance, so at least 13 maximum-size
requests (about 20 with 1 KB bodies) can be open at once. Requests that **expire** without being
closed keep their reservation (replay has no trustworthy clock), so a mailbox with several expired
requests can fill up while showing little open work; cancel your own open requests when you no
longer need them. When a mailbox is full, settle open work and pair a new private repository.
There is no compaction or redirection.

## What is verified

Verified by the test suite on Node 24.22.3 and 26.13.0 (macOS arm64), including against the
installed package tarball, plus scripted isolation checks:

- Domain: canonical encoding and golden signature vectors, tampering, replays, wrong actor or
  audience, revision races, expiry, capacity reservations, unknown versions.
- Application: compare-and-swap races (one winner per request revision), retries for unrelated
  conflicts, loss before and after commit, crash after accept, restart recovery, rollback and fork
  detection, profile locking.
- CLI and MCP: the full two-profile lifecycle through the executable, and all three MCP tools
  through the official MCP TypeScript client over stdio.
- GitHub adapter: exact `gh api graphql` argv, static queries, `createCommitOnBranch` with
  `expectedHeadOid`, stale-head conflicts, denial, rate limits, oversized/truncated/mismatched
  responses — **against a `gh` test double**, not live GitHub.
- Approvals: preview of a staged draft makes zero writes; brief approvals bind the agent inbox and
  exchange configuration; reconfiguration needs a new approval.
- Isolation (`test/isolation/`): in a network-less Ubuntu 24.04 container, an agent running as a
  separate UID in the `--group` exchange reads briefs (also after atomic replacement), writes drafts
  the operator publishes, uses all three MCP tools, and is denied the operator profile, key and
  inbox writes. On macOS, an agent under a `sandbox-exec` profile with the same UID gets the same
  results plus denied network and `gh`.

Not yet verified: two real GitHub accounts on a real private repository, organization and branch
rule behavior, fine-grained tokens, Windows, CI on GitHub Actions, your own sandbox or host setup,
and any agent host other than the reference MCP client.

## Roadmap

- **v0.1** — GitHub private repository transport, offline file transport, CLI and stdio MCP.
- Next — live two-account GitHub verification, repository-scoped auth (for example a GitHub App),
  metadata-only notifications.
- Later — more transports behind the same [transport contract](docs/transports.md) (for example
  other Git hosts or a shared filesystem), larger mailboxes, optional
  [A2A](https://a2a-protocol.org/) mapping. Agentshake v0.1 makes no A2A conformance claim.

## Documentation

- [docs/protocol.md](docs/protocol.md) — ledger format, signatures, transitions, limits, vectors
- [docs/architecture.md](docs/architecture.md) — layers, trust boundaries, recovery
- [docs/transports.md](docs/transports.md) — GitHub, file and memory adapters; writing a new one
- [docs/agents.md](docs/agents.md) — connecting coding agents via shell or MCP
- [SECURITY.md](SECURITY.md) — threat model and reporting
- [CONTRIBUTING.md](CONTRIBUTING.md) · [CHANGELOG.md](CHANGELOG.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Acknowledgements

Agentshake builds on the [Model Context Protocol](https://modelcontextprotocol.io/) TypeScript SDK
(Apache-2.0), [Commander.js](https://github.com/tj/commander.js) (MIT), [Zod](https://zod.dev/)
(MIT) and the [GitHub CLI](https://cli.github.com/). The request lifecycle was informed by the
task states of the [A2A protocol](https://a2a-protocol.org/). Out-of-band fingerprint checks follow
the same idea as verifying an SSH host key. No third-party source code is copied into this project.

## License

[Apache-2.0](LICENSE). Copyright 2026 codefulteam.
