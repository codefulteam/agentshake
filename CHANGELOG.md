# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

## Unreleased (local candidate, not released)

Fixes from the 0.2.0 scenario evaluation. Protocol, ledger format and version are unchanged.

### Fixed

- A freshly approved work brief now settles a recorded accept whose local release was still
  pending, in either order of `brief` and `recover`, instead of leaving a held item that asks for an
  approval already given. Unrecorded operations are never superseded.
- The `channel join` and agent commands printed by `channel init` and `exchange configure` are
  shell-quoted, so they run as printed with spaces, apostrophes or non-ASCII characters in paths.
- `agentshake drafts` reads the mailbox like `inbox` and `show`: it removes stale negotiation
  briefs and marks each draft `stale`. `drafts --offline` lists without reading the mailbox; an
  unreadable mailbox is reported with that option as the next step. Previews still never remove briefs.
- Every CLI error now carries a `next` hint, as documented: role-specific for wrong-role actions,
  the command's help for invalid input, the publish-then-cite path for completing with your own
  reply, and a command-scoped fallback otherwise. With `--json`, command-line parser errors
  (unknown command or option, missing argument or value, disallowed choice) are reported once as
  the JSON error envelope with exit code 2 and a `next` naming the command's `--help`, instead of
  Commander's plain text.
- MCP: errors raised by Agentshake inside a tool are JSON `{ error, next, exitCode }`. Arguments that
  fail the advertised input schema keep the MCP SDK's standard plain-text validation result (no
  `next`); the tool descriptions and docs now say so, and the schema fields carry descriptions.
- Expiry hints depend on the role (the requester is told to send a new offer, the recipient to ask
  the requester for one) at every entry point: operator actions, `publish` of any draft kind
  including replies, `brief`, and recovery of an operation staged before the request expired.

## [0.2.0] — release candidate

Protocol 2: pre-accept context negotiation. Needs a fresh mailbox and a new profile; protocol 1
data is never read, migrated or changed (see docs/protocol.md#versioning).

### Added

- Protocol 2 events `offer`, `ask` (1–5 typed items, each with why it is needed), `supply` (each
  open question answered exactly once as `supplied`, `unavailable` or `withheld`, bound to that
  round and the current context digest; or a note when no round is open), `confirm` (the
  recipient's understanding, listing the still unresolved unavailable and withheld items as known limitations) and an
  `accept` that cites the current confirmation and context digest.
- Explicit gap resolution: a `supply` may carry `resolutions: [{ ask, item, body }]` naming an
  earlier unresolved unavailable or withheld item of the same request, with the recovered content.
  Confirmations list only the current unresolved items; history is kept.
- Context revision and deterministic context digest per request; a supply makes the previous
  confirmation stale; negotiation closes at acceptance.
- Bounds: 5 questions per round, 4 supplies per request, one confirmation per context revision,
  2048-byte understanding; capacity reservations for the open answer, the confirmation, accept,
  reply and close.
- Operator commands `ask`, `supply`, `confirm`; `publish` handles ask, supply and confirm drafts;
  JSON payloads from files or stdin; `inbox`/`outbox`/`show` report the phase and whose move it is.
- Negotiation briefs: `brief` on a pending request releases operator text with stage
  `negotiating`, `authorizesWork: false` and binding metadata (context, open round, gaps), never
  remote text. Stale negotiation briefs are removed; accept replaces them with the work brief.
- Agent drafts `ask`, `supply`, `confirm` over the shell interface and MCP `create_draft`; bindings
  default to the agent's brief and are checked at `publish`.
- Offline demo and `scripts/demo.sh` run the full handshake with repeated clarification, an
  unavailable and a withheld answer, a refused stale acceptance and completion.

### Changed

- Signing domain `agentshake/v2/`; genesis and event `version` 2; `create` is now `offer`.
- GitHub ledger path `agentshake-mailbox-v2.json`; the v1 path is never read or written.
- Profiles record `protocol: 2` in the pairing. A protocol 1 profile or ledger fails with exit code
  2 before any lock, transport contact or write, with steps for 0.1.0 and for a new profile.
- `--preview` runs the same transition and capacity checks as append on an unsigned copy, so
  wrong-role, wrong-phase, budget and capacity errors are reported before a digest is offered. The
  preview contract is explicit: never signs, sends, stages or releases; a fresh verified read may
  advance the local rollback checkpoint.
- Replay checks the capacity reservation at every historical prefix.
- Every profile command except `key`, `exchange show` and `pending` refuses a protocol 1 profile
  before any GitHub lookup, journal, exchange or outbox read.
- Source split: `errors.ts`, `schema.ts`, `transitions.ts`, `negotiate.ts`, `view.ts`.

### Known limitations

- Same as 0.1.0 (no live GitHub verification, no sandboxing, no specific agent host tested,
  Windows untested), plus: no backward reading of protocol 1 history, no key import into a new
  profile, and no post-accept re-negotiation (cancel and send a new offer).

## [0.1.0] — release candidate

First release.

### Added

- Protocol v1: signed, hash-chained two-party ledger with strict schemas, canonical JSON,
  Ed25519 domain-separated signatures, replay protection, capacity reservations and expiry.
- Request lifecycle: create, accept, decline, reply (clarifications and results), complete
  (completed/failed, citing the recipient's reply), cancel, derived expiry.
- Operator CLI: key, channel init/join, doctor, exchange configure, inbox/outbox, show, drafts,
  publish, accept, brief, decline, cancel, complete, pending, recover, demo. Interactive approval
  on the terminal, or `--preview` / `--approve <digest>`; `$EDITOR` or `--body-file`/stdin briefs;
  `--json` output with `next` hints; stable exit codes.
- Agent interface: `agentshake agent` shell commands and a stdio MCP server with
  `list_briefs`, `read_brief` and `create_draft`.
- Transports: GitHub private repository via `gh api graphql` and `createCommitOnBranch` with
  `expectedHeadOid`; local SQLite file transport for the offline demo; in-memory transport.
- Durable operation journal with idempotent recovery, observed-prefix rollback/fork detection and
  a per-profile mutation lock.
- Offline `agentshake demo` and `scripts/demo.sh` walkthrough.

### Changed after the first independent review

- `publish --preview` on a staged draft is read-only; a staged, unconfirmed draft is never resent
  implicitly (`publish` points to `recover`). `--preview` with `--approve` is rejected first.
- Brief approvals bind the agent inbox and an exchange configuration ID; `exchange configure` is
  serialized with mutations and invalidates unreleased brief approvals. The journal records the
  remote receipt and the local brief step (`released`, `already-present`, `skipped-closed`,
  `held-destination-changed`, `superseded`) separately; `recover` never redirects a brief.
- `exchange configure --group` for an agent running as another OS account (inbox 2750, outbox
  2770, group-readable 0640 files). Isolation checks in `test/isolation/` (two-UID Linux container,
  macOS `sandbox-exec`).
- The profile lock is an OS lock (exclusive SQLite transaction) instead of a PID file. Trusted-path
  checks for the profile, its database and exchange directories. Directory fsync after brief and
  draft writes. Pinned branch ref ID for GitHub mailboxes.
- Reversible operator display (backslashes escaped); previews show the request revision and the
  brief destination. `recover` no longer needs a second read to report success.
- Dependencies pinned for consumers with `npm-shrinkwrap.json`; zod 4.6.7.
- Docs: verified vs unverified isolation, simulated demo approvals, explicit list of approving
  commands, `--outcome` in examples, expired-request capacity retention, GitHub operational
  assumptions.

### Known limitations

- Live two-account GitHub use, branch rules, organization policies and fine-grained tokens are not
  yet verified; the GitHub adapter is tested against a `gh` test double.
- No sandboxing is provided; agent isolation is the operator's responsibility. Only the two
  scripted setups in `test/isolation/` are verified.
- No specific agent host is tested; only the official MCP TypeScript client over stdio.
- Windows is untested.
