# Profile file-mailbox/1

**Status: draft, experimental. Unauthenticated.** A SQLite file on one trusted machine, shared by
two profiles. It is used for personal use (you and your own agents), the offline demo, tests and
experiments.

| Item | Binding |
| --- | --- |
| Principal ID | **self-declared** with `--account` |
| Channel | `file:` + a random row ID; branch `local` |
| Storage | table `mailbox`, row `slot = 1`, column `raw` (the canonical ledger bytes) |
| Writes | compare-and-swap on a row version |

What this profile does and does not give:

- Signatures still bind every event to a pinned key, so forged or altered events are detected.
- Anyone who can write the file can delete or replace the ledger. Nothing authenticates the reader.
- It requires a local filesystem with working SQLite locking. Network filesystems (NFS, SMB,
  cloud-synced folders) are untested and not supported.
- It does not move data between machines. Copying the file between computers is not a supported
  transport: there is no compare-and-swap across copies, and the rollback check fails closed on
  forks.

To validate the ledger of a file mailbox:

```sh
sqlite3 mailbox.sqlite "SELECT writefile('ledger.json', raw) FROM mailbox WHERE slot = 1"
agentshake validate ledger.json
```
