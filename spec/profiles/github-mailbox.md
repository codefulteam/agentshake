# Profile github-mailbox/1

**Status: draft, experimental.** This is the reference binding for collaboration through a private
GitHub repository. It is implemented and tested against a GitHub CLI test double. **Live use with
two real GitHub accounts has not been verified.** This profile is optional. See
[file-mailbox.md](file-mailbox.md) and `docs/local.md` for use without GitHub.

| Item | Binding |
| --- | --- |
| Principal ID | GitHub numeric user ID (`databaseId`) |
| Channel | `github:` + repository node ID; branch = the default branch name |
| Storage | `agentshake-mailbox-v2.json` on the default branch of a private repository |
| Reader authentication | the `gh` viewer; the reference client refuses to act if the viewer is not its own roster account |
| Peer binding | the peer's login is resolved to an ID once, at pairing |
| Writes | `createCommitOnBranch` conditional on the head commit |

What each fact rests on:

| Statement | Basis |
| --- | --- |
| This event was signed by the key pinned for account N | Ed25519 and the genesis (core protocol) |
| Account N holds that key | **Not proven.** It rests on each operator verifying fingerprints out of band |
| The reader is GitHub user N | `gh` at read time |
| No rollback happened | only relative to this profile's pinned observed prefix |
| The repository is private with two writers | checked at read time; not atomic with the write |

Operational details: `docs/transports.md`.
