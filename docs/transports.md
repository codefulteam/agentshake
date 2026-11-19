# Transports

A transport stores the ledger bytes and tells Agentshake who is reading. Everything else —
signatures, roles, replay, clocks, retries — lives in the shared domain and application code, so a
new transport does not change the protocol.

## Contract

```ts
interface Transport {
  read(): Promise<Snapshot>;                       // bounded, consistent read at one revision
  write(snapshot: Snapshot, raw: string): Promise<'committed' | 'conflict' | 'denied' | 'unknown'>;
}
type Snapshot = {
  transport: string;      // adapter name
  channel: string;        // immutable channel identity, pinned in genesis
  branch: string;         // partition name, pinned in genesis
  revision: string;       // opaque compare-and-swap token
  account: string;        // authenticated account ID of the reader
  accountLabel?: string;  // display only
  raw: string | null;     // ledger text, or null if absent
  opaque?: Record<string, string>; // adapter-private data for write()
};
```

A conforming adapter must provide:

1. **Authenticated identity**: `account` is established by the transport, not by the caller.
2. **Immutable channel identity**: renaming or recreating the backing store changes `channel`.
3. **Bounded, consistent reads**: `raw` and `revision` come from the same state; reads larger than
   256 KiB fail.
4. **Atomic conditional writes**: `write` replaces the ledger only if `revision` is unchanged.
5. **Honest results**: report `committed` only on positive confirmation; `conflict` only when the
   revision moved and this call wrote nothing; `denied` for permission or policy refusals;
   otherwise `unknown`. The application verifies receipts regardless.

An adapter that cannot meet these must advertise a different contract under a new protocol version.
Endpoints are described by `endpointSchema` in `src/transport/index.ts`; add a schema member and a
factory case there.

## GitHub (`--repo owner/repo`)

The production transport for v0.1.

- **Auth**: delegated to the GitHub CLI. Agentshake runs `gh api graphql --hostname github.com
  --input -` with `execFile` (no shell), a curated environment (`HOME`, `PATH`, `GH_CONFIG_DIR`,
  `GH_TOKEN`/`GITHUB_TOKEN` if set, proxy and certificate variables, locale and keyring variables),
  a 15 s timeout and a 2 MiB output cap. The request body is JSON on stdin; queries are static and
  all data travels as GraphQL variables.
- **Read**: query 1 returns `viewer { databaseId login }` and the repository `id`, `isPrivate` and
  default branch ref (`id`, `name`, `target.oid`). Query 2 reads the blob
  `<headOid>:agentshake-mailbox-v1.json` from that exact commit and rejects binary, truncated or
  oversized blobs. The blob text is checked against its Git object ID (SHA-1 or SHA-256), and the
  viewer must be the same in both queries.
- **Identity**: `channel` is `github:` + the repository node ID, `branch` is the default branch
  name, `account` is the viewer's numeric ID. The repository must be private.
- **Write**: `createCommitOnBranch` with the branch node ID, `expectedHeadOid` = the read
  revision, a fixed headline `Update Agentshake mailbox` and one file addition. GraphQL errors are
  inspected even on HTTP 200. `FORBIDDEN`/`NOT_FOUND`/`UNAUTHORIZED` → `denied`; otherwise a fresh
  read distinguishes `conflict` (head moved) from `unknown`.
- **Errors**: missing `gh` or no login → exit 3; rate limit (HTTP 429, "rate limit" diagnostics or
  GraphQL `RATE_LIMITED`) → exit 5; malformed or oversized responses → exit 5 or 6. Raw `gh`
  output is never printed.
- **Login lookup**: `channel init/join --peer <login>` resolves the login once with a static
  `user(login:)` query and stores the numeric ID.

### Mailbox repository checklist

- Dedicated, **private**, with an initial commit, separate from source code.
- Only the two participants have access; give the peer write access.
- Disable Actions, webhooks, deploy keys and integrations. Use no secrets or runners.
- If your plan allows, protect the default branch against force-push and deletion (both
  participants still need to push).
- Remember: Git history keeps every approved message. Revoking access does not delete copies.

### Operational assumptions

- Pairing pins the repository node ID, the default branch name and, from v0.1, the branch ref
  node ID. A repository or branch recreated under the same name fails closed.
- The read and the write are separate `gh` calls. The write is conditional on the branch head, not
  on the authenticated viewer or the repository's visibility. Keep the `gh` account and the
  repository's privacy unchanged while Agentshake runs. A change is detected by the next read, after
  the write. The adapter does not enforce privacy atomically.
- Expiry is checked against the local clock when acting. Replay stays deterministic and applies no
  receive-time skew policy, so a pinned peer controls its own (valid) timestamps.

### Credentials

`gh auth login` typically grants a broad OAuth token (for example `repo` scope) that can reach
every repository the account can. Agentshake only uses it for the fixed queries above, but the
token itself is not scoped to the mailbox. Fine-grained personal access tokens with access only
to the mailbox repository should work through `GH_TOKEN`, but this is **untested**; collaborator
repositories have documented fine-grained token limitations.

### What is and is not verified

`test/github.test.mjs` runs the real CLI against `test/fixtures/fake-gh.mjs`, a `gh` stand-in
that checks the exact argv and documents and emulates private repositories, collaborators,
`expectedHeadOid`, Git blob IDs and injected faults. It verifies the wiring, conflict handling,
classification and recovery. It does **not** prove live GitHub behavior: the actual
`createCommitOnBranch` semantics for collaborators, branch rules, organization policies, real
error payloads and rate limits still need verification with two real accounts on a disposable
private repository.

## File (`--file <path> --account <id>`)

A local SQLite file shared by two profiles on one machine, for the offline demo, tests and
experiments. Writes are compare-and-swap on a row version. **The account ID is self-declared:**
this transport authenticates nobody. Signatures still bind each event to a pinned key, but anyone
who can write the file can replace or delete it. Do not use it across users or machines as a
substitute for GitHub.

## Memory

`MemoryTransport` over a shared `MemoryChannel`, used by tests for deterministic races and faults.
It is exported for embedding; it does not persist anything.

## Writing a new adapter

1. Implement `Transport` in `src/transport/<name>.ts`, meeting the contract above.
2. Add an endpoint schema member and a factory case in `src/transport/index.ts`, and CLI flags in
   `channel init/join`.
3. Run the application test suite with your adapter (see `test/mailbox.test.mjs`, which already
   runs the race tests against both memory and file transports).
4. Document authentication, channel identity, bounds, and exactly what you verified.

Candidate future transports include other Git hosts with conditional ref updates and
shared filesystems with atomic rename semantics. None are implemented in v0.1.
