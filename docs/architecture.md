# Architecture

Agentshake is a small TypeScript ESM program with four layers. Only the transport layer knows
about GitHub; only the CLI knows about terminals.

```
 src/cli.ts        operator CLI + agent CLI (Commander), approvals, human/JSON output
 src/mcp.ts        stdio MCP server for agents (list_briefs, read_brief, create_draft)
 src/demo.ts       offline two-profile demo
      │
 src/mailbox.ts    application: pairing, staged operations, conditional append, retries,
      │            receipt verification, recovery, brief release
      ├── src/domain.ts     protocol: schemas, canonical JSON, signatures, replay, transitions, caps
      ├── src/local.ts      local state: profile DB, lock, exchange dirs, drafts, briefs, safe file IO
      └── src/transport/    adapters: types.ts (contract), github.ts, file.ts, memory.ts, index.ts
```

`src/domain.ts` performs no I/O. `src/transport/*` never interprets the ledger. Adding a transport
touches only `src/transport/` (see [transports.md](transports.md)).

## Trust boundaries

| Zone | Contents | Who may read / write |
| --- | --- | --- |
| Operator profile (`~/.agentshake`, mode 0700) | private key, pairing, operation journal, observed prefix | operator only |
| `gh` credentials | GitHub token | operator only (managed by `gh`) |
| Mailbox (private repository) | signed ledger | both participants, repository admins, GitHub |
| Agent inbox | operator-authored briefs | operator writes; agent reads (mount read-only) |
| Agent outbox | agent-authored drafts | agent writes; operator reads |

The agent interface (`agentshake agent …`, including `mcp`) takes only the inbox and outbox paths.
It opens no profile, makes no network request and runs no subprocess. The operator interface never
reads arbitrary paths from remote content or drafts: draft and brief file names are UUIDs chosen
or validated locally, inside directories stored in the profile.

## Data flow of one action

1. **Prepare.** The CLI reads and verifies the ledger, builds the payload and an intent with a new
   operation ID (for `publish`, the draft ID), and computes an approval digest over the destination
   channel, epoch, actor, request, expected revision, payload and, for a local brief, its text plus
   the destination: the agent inbox and the exchange configuration ID.
2. **Approve.** The operator confirms on the controlling terminal (`/dev/tty`), or passes
   `--approve <digest>` that must match the digest printed by `--preview`.
3. **Stage.** The operation (intent, approval digest, brief and its approved destination) is
   written to the profile journal in a SQLite transaction before any network contact. The same ID
   with a different approval is rejected. If the exchange was reconfigured after the review, the
   action is rejected before staging.
4. **Append.** Under an exclusive profile lock, the application re-reads, checks for an existing
   receipt, signs the intent against the current chain head, and calls `transport.write(snapshot,
   ledger)`, which succeeds only if the transport revision is unchanged.
5. **Verify.** It re-reads and looks for the event by ID and intent digest. Only a verified receipt
   is success, and it is recorded in the journal at once (`remote: recorded`). A `conflict` with no
   receipt retries the same intent (at most three writes in total). `unknown` or a failed re-read
   exits with code 5 and the `recover` command to run.
6. **Release (local).** For `accept`, the brief step is tracked separately in the journal:
   `released` (exclusive create, file and directory fsynced), `already-present`, `skipped-closed`
   (the request is no longer accepted), or `held-destination-changed` (the exchange was reconfigured
   after approval; nothing is written until the operator approves a brief for the new inbox with
   `agentshake brief`, after which the held step becomes `superseded`).

If the intent can no longer apply (the request changed, closed or expired), the staged operation is
discarded: since the observed prefix is pinned, no valid history can later contain it.

## Recovery

`agentshake recover <operation>` repeats steps 4–6 from the journal. It is idempotent: a recorded
operation returns its original receipt, and a local brief step that already settled is reported,
not repeated. It never releases to a destination other than the approved one. `publish <draft>` on
an already staged draft does not resume it: `--preview` shows the staged action without writing,
plain `publish` reports a delivered draft's stored receipt or tells you to run `recover`. `agentshake pending` lists unfinished operations, and
`doctor` reports how many exist. Recovery works after a process restart because the journal is
durable.

## Concurrency

- **Across machines**: compare-and-swap on the transport revision (GitHub: `expectedHeadOid`).
  Same-request races (accept/cancel, complete/cancel) have exactly one winner per revision;
  unrelated requests retry.
- **Within a profile**: one mutation at a time, including `exchange configure`, enforced by an
  exclusive SQLite transaction on `lock.sqlite`. That is an OS file lock, released by the kernel if
  the process dies, so there is no lock file to publish or take over. An in-process guard covers
  the same process. SQLite `BEGIN IMMEDIATE` guards journal and prefix updates.

## Local state layout

```
~/.agentshake/            (or --profile / AGENTSHAKE_HOME), mode 0700
  operator.sqlite         settings (key, pairing, provisional genesis, exchange paths),
                          operations (journal), observation (observed prefix); mode 0600
  lock.sqlite             holds the OS lock while a mutation runs
  edit/                   transient brief editor files
<inbox>/<request>.json    brief: request, role, category, body, expires, version
<outbox>/<draft>.json     draft: action new|reply, ...
```

## Output and errors

Human output escapes control, format (including bidi) and unassigned characters as `\u{hex}` and
literal backslashes as `\\`, so the display is reversible. JSON output
escapes the same characters as `\uXXXX`. Errors carry a reason (`usage`, `access`, `conflict`,
`temporary`, `integrity`), a fixed message authored by Agentshake and an optional `next` hint.
Raw `gh` diagnostics and remote text are never included in error messages.
