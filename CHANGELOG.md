# Changelog

All notable changes are documented here. This project follows [Semantic Versioning](https://semver.org/).

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
