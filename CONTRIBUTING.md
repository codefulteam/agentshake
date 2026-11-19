# Contributing

Thanks for helping. Agentshake is small on purpose: its value is the mailbox and trust model, so
changes should keep the domain strict, the transports thin and the operator in control.

## Development

Requires Node.js 24 LTS or 26 LTS.

```sh
npm ci
npm run typecheck
npm test            # builds, then runs all suites with node:test
npm run smoke       # packs, installs the tarball in a temp prefix, runs the end-to-end suites against it
node dist/cli.js demo
```

Tests:

- `test/domain.test.mjs` — schemas, canonical encoding, golden vectors, transitions, negotiation
  rules and attacks, caps and reservations, protocol 1 refusal.
- `test/mailbox.test.mjs` — races (including negotiation), recovery, rollback/fork, locking, local
  file safety, negotiation briefs, non-destructive protocol 1 refusal.
- `test/journey.test.mjs` — the CLI and stdio MCP end to end (set `AGENTSHAKE_BIN` to test an
  installed executable).
- `test/github.test.mjs` — the GitHub adapter through the CLI against `test/fixtures/fake-gh.mjs`.

No test needs a GitHub account or network access.

Isolation checks (not part of `npm test`):

- `AGENTSHAKE=<installed bin> bash test/isolation/sandbox-exec.sh` — macOS, same UID under `sandbox-exec`.
- `NODE_LINUX=<linux node dir> PKG_PREFIX=<npm prefix with the installed tarball> bash test/isolation/run-container.sh`
  — two UIDs in a disposable, network-less `ubuntu:24.04` container (needs Docker and the image locally).

## Guidelines

- Keep protocol changes in `src/schema.ts`, `src/transitions.ts` and `src/domain.ts`, and document
  them in `docs/protocol.md`. Any change to signed bytes or transition rules requires a protocol
  version bump, a fresh mailbox and new golden vectors; never reinterpret older signatures.
- Transports implement only `src/transport/types.ts`; see `docs/transports.md`.
- Never print remote text or raw subprocess diagnostics without escaping; never interpolate data
  into shell commands; bound every input.
- Do not claim support you have not tested. Host integrations are listed as tested only with a
  reproducible record (host name and version, OS, configuration, transcript of the three MCP tools
  or shell commands).
- Add or update tests with every behavior change. Keep dependencies minimal and pinned.

## Pull requests

Describe the change, the risk, and how you tested it (the PR template has a checklist). By
contributing you agree that your contribution is licensed under the Apache License 2.0. Please
follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described
in [SECURITY.md](SECURITY.md).
