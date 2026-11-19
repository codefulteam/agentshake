# Agentshake specification

**Status: draft, experimental.** This directory is the public, machine-readable description of the
Agentshake protocol. Agentshake is a shared way for two principals (people, each with their own
coding agents) to offer requests, clarify missing context, confirm an understanding, accept, and
return results. Each side keeps its own keys, sandbox and approval.

It is shipped inside the npm package and can be used offline. It is not a standard, and no
third-party implementations are known.

| Document | Normative? | Content |
| --- | --- | --- |
| [protocol-2.md](protocol-2.md) | yes | Core protocol 2: roles, records, operations, state, validation stages, consumer rules, versioning |
| [profiles/github-mailbox.md](profiles/github-mailbox.md) | yes, for that profile | Optional GitHub binding |
| [profiles/file-mailbox.md](profiles/file-mailbox.md) | yes, for that profile | Unauthenticated single-machine binding |
| [local-exchange.md](local-exchange.md) | for `local-exchange/1` documents | Drafts, briefs, discovery; the reference security policy (policy, not protocol) |
| [adopters.md](adopters.md) | no | Short guidance for people, agents and tool authors |
| [proposals/protocol-3.md](proposals/protocol-3.md) | no | Ideas that are **not** implemented |

Machine-readable files:

| Path | Content |
| --- | --- |
| `schemas/*.schema.json` | JSON Schema 2020-12 (syntax only). IDs are `urn:uuid:` values listed by `agentshake capabilities`; all references resolve locally |
| `examples/protocol-2/valid`, `invalid` | Signed ledgers, one rule per invalid file |
| `examples/protocol-2/conversations/` | Full human-human, human-agent and agent-agent conversations: ledger, transcript, local documents, normalized state |
| `examples/local-exchange-1/` | Valid and invalid drafts and briefs |
| `vectors/protocol-2.json` | Keys, canonical JSON, signing, chain and context-digest vectors |
| `conformance-protocol-2.json` | The conformance manifest: input, kind and expected verdict for every example |

## Checking an implementation

Everything below works offline, with no profile and no GitHub:

```sh
agentshake validate examples/protocol-2/valid/reply.json     # exit 0; JSON with --json
agentshake conformance                                     # the built-in validator against all cases
agentshake conformance -- ./my-validator {file} {as}       # your validator; it must print validation-1 JSON
```

- **Shape** (JSON Schema) is separate from **validity** (canonical bytes, signatures, roles,
  state, capacity).
- **Validity** is separate from **permission**: a valid history authorizes nobody.
- **Permission** is separate from **liveness**: validation never checks expiry against a clock.

The JSON Schema verdicts in the manifest (`jsonSchema`) are checked by the source repository's
test suite (`test/spec.test.mjs`, with the dev dependency Ajv). The shipped `agentshake conformance`
command compares validator verdicts and states. It needs no schema library.

The fixtures are generated deterministically by `scripts/spec-fixtures.mjs` in the source
repository, and `--check` verifies them.
