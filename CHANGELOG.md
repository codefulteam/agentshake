# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [0.3.0] — local candidate, not released

Wire protocol 2 is unchanged: the same ledger bytes, signatures, mailboxes, GitHub path, limits
and golden vectors as 0.2.0. The package version is independent of the protocol number.

### Added

- `spec/`: a draft, experimental specification of protocol 2 (`protocol-2.md`), the GitHub and file
  profiles, the local exchange format with the reference security policy, adopter guidance, and a
  non-normative protocol 3 proposal. JSON Schemas (2020-12, syntax only, `urn:uuid` IDs, local
  references), signed valid and invalid examples, three full conversations (human-human,
  human-agent, agent-agent), vectors and a conformance manifest, all shipped in the package and
  generated deterministically by `scripts/spec-fixtures.mjs`.
- `agentshake validate <file> [--as ledger|draft|brief|capabilities]`: offline, staged validation
  (input, version, schema, canonical, genesis, chain, signature, transition, capacity) with stable
  codes. Exit 0 valid, 6 invalid, 2 usage. It opens no profile.
- `agentshake capabilities`, `agentshake agent capabilities` and the MCP tool `get_capabilities`:
  static description of the protocol, profiles, operations, draft actions, limits and schema IDs.
- `agentshake conformance [-- <validator> …]`: runs the shipped cases against the built-in
  validator or any command that prints validation JSON.
- `agentshake draft new|reply|ask|supply|confirm`: the operator writes the same draft document an
  agent writes, then publishes it as usual.
- Library exports: `inspect`, `decideIntent`, `applyChecked`, `validate`, `summarize`,
  `capabilities`, `runConformance`, `normalizeSummary`, and schema IDs.
- `docs/local.md`: offline installation and a personal workflow on one machine without GitHub,
  with the exact limits of the unauthenticated file profile.

### Review fixes (before release)

- Conformance compares normalized ledger states independently of member order: objects are
  traversed in member-name order before labels are assigned. A validator that prints sorted or
  reordered JSON now passes.
- `validate` reports every content defect as a validation result: oversized input
  (`input.size`, read stops after the limit), bytes that are not UTF-8 (`input.encoding`, a new
  code), and non-JSON (`input.json`). A deeply nested non-numeric version is reported as
  `version.unsupported` without serializing it; on Node 24 it previously crashed with a stack
  overflow. Filesystem problems stay errors (exit 2 or 3).
- Spec:
  - `channel` and `branch` lengths are code points (1–200, 1–250), as wire 2 has always
    validated them; an unpaired surrogate counts as one;
  - rule S2 (well-formed Unicode) is scoped to the text fields wire 2 has always checked;
    `channel` and `branch` keep their legacy acceptance;
  - the order of global and per-event validation stages is stated;
  - a missing version is a schema failure;
  - the normalization traversal order is defined.
- Docs:
  - brief freshness after cancellation (visible until the recipient's operator refreshes) versus
    expiry (refused and omitted locally from `expires`, even offline);
  - the file profile's personal single-machine scope in SECURITY;
  - the installed binary path, a sample task file, where the draft ID appears, and the optional
    `sqlite3` shell in the personal walkthrough;
  - the trusted `seal` hook and the exact mutation-free scope of `decideIntent` and
    `applyChecked`.

### Changed

- Runtime dependencies are bundled in the package tarball (`bundleDependencies`), so it installs
  with `npm install --offline` and needs no registry. Node.js remains a prerequisite.
- Ledger verification, intent checks and transitions return results internally
  (`inspect`, `decideIntent`, `applyChecked`). `decode`, `preflight`, `append` and `apply` keep
  their throwing behavior, messages and exit codes. An unexpected non-protocol error inside a
  transition is no longer reported as a ledger integrity failure; it propagates as an internal
  error.
- The CLI's output envelope and draft commands moved into `src/commands/`, shared by the agent and
  operator command trees.
- An agent draft that falls back to its brief binding now treats only Agentshake errors (missing,
  expired or invalid brief) as "no binding"; other failures, such as permission errors, are reported
  instead of being hidden.
- Protocol 1 refusal messages say "This release speaks protocol 2 only" instead of naming 0.2.

### Fixed

Fixes from the 0.2.0 scenario evaluation:

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
