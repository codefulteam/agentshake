# Local and offline use

Agentshake works without GitHub and without a network. You need Node.js (^24.11 or ^26) and the
package tarball. You do not need a model API key, a daemon or a second person. GitHub is an optional
binding for collaborating across machines ([transports.md](transports.md)).

## What works offline

| Task | Command | Needs a profile? |
| --- | --- | --- |
| Read the spec, schemas and examples | files under the package's `spec/` | no |
| Check a ledger, draft or brief | `agentshake validate <file> --as ledger\|draft\|brief` | no |
| See what this installation supports | `agentshake capabilities`, MCP `get_capabilities` | no |
| Run the conformance cases | `agentshake conformance` | no |
| Watch a full handshake | `agentshake demo` | creates temporary profiles |
| Work with your own agents on one machine | the file profile, below | yes |

## Install without network access

The package tarball bundles its runtime dependencies (`@modelcontextprotocol/server` with
`@modelcontextprotocol/core`, `commander` and `zod`), so installing it needs no registry:

```sh
npm install --offline --no-audit --no-fund --prefix ~/agentshake ./agentshake-0.3.0.tgz
~/agentshake/node_modules/.bin/agentshake capabilities
```

Get the tarball on a connected machine (or from your own artifact store) and copy it over. Node.js
itself is a prerequisite that you install separately.

The examples below call `agentshake` by name. After an install with `--prefix ~/agentshake`, either
put its bin directory on your `PATH` for this shell, or use the full path:

```sh
export PATH="$HOME/agentshake/node_modules/.bin:$PATH"
agentshake --version
```

## Your first personal workflow (one machine, you and your agents)

The protocol always has exactly two principals. On one machine you create **two local
principals**: two profiles with their own keys. For example, one for you as the requester and one
for the side that does the work. Their account numbers are local labels that you choose
(self-declared). They are not GitHub accounts, so you need no GitHub account and no second person.
Collaborating with another person uses the GitHub profile and two real accounts instead.

```sh
W=~/agentshake-work; mkdir -p "$W"
printf 'Add bounded jitter to the retry backoff in src/retry.ts.\n' > "$W/task.md"   # the request text
# 1. Two principals, two keys.
AGENTSHAKE_HOME=$W/me    agentshake key init
AGENTSHAKE_HOME=$W/agent agentshake key init
# 2. Pair them on a local file mailbox (copy each public key from the other's `key show`).
AGENTSHAKE_HOME=$W/me    agentshake channel init --file $W/mailbox.sqlite --account 1 --peer 2 --peer-key <key of agent profile>
AGENTSHAKE_HOME=$W/agent agentshake channel join --file $W/mailbox.sqlite --account 2 --peer 1 --peer-key <key of me profile>
# 3. Give each side an exchange directory for its coding agent.
AGENTSHAKE_HOME=$W/me    agentshake exchange configure --inbox $W/me-in    --outbox $W/me-out
AGENTSHAKE_HOME=$W/agent agentshake exchange configure --inbox $W/agent-in --outbox $W/agent-out
# 4. Write a request yourself (the same document an agent would draft) and send it.
#    `draft new` prints "Draft <draft-id> written"; `agentshake drafts` lists unsent drafts again.
AGENTSHAKE_HOME=$W/me agentshake draft new --kind task --title "Add retry jitter" --body-file "$W/task.md"
AGENTSHAKE_HOME=$W/me agentshake publish <draft-id>        # shows the exact action and asks "yes"
#    The request ID is the draft ID of the offer.
# 5. The other side reads it, asks, confirms and accepts as usual.
AGENTSHAKE_HOME=$W/agent agentshake inbox
AGENTSHAKE_HOME=$W/agent agentshake show <request>
```

From step 5 on, the commands are the normal handshake: `ask`, `supply`, `confirm`, `accept` and
`complete` (see the README). Connect a coding agent to either side with
`agentshake agent --inbox … --outbox …` or its MCP server ([agents.md](agents.md)). Every signed
step still asks you for approval.

`agentshake demo --dir <new-dir>` creates a similar workspace with two profiles, approves the first
steps automatically (it says so) and prints the next commands to try yourself.

To check what is in the mailbox (optional; needs the `sqlite3` command-line shell, whose built-in
`writefile()` function writes the stored bytes unchanged; Agentshake itself does not need it):

```sh
sqlite3 $W/mailbox.sqlite "SELECT writefile('ledger.json', raw) FROM mailbox WHERE slot = 1"
agentshake validate ledger.json
```

`writefile` prints the number of bytes it wrote. `validate` then reports whether the ledger is valid.

## Exact limits of the file profile

- **No authentication.** `--account` is self-declared. Anyone who can write the SQLite file can
  replace or delete the ledger. Signatures still detect forged or altered events.
- **One trusted machine.** Use it with one OS user and two profiles, or with several OS users who
  share a directory through group permissions they manage. It is not a secure cross-user
  transport.
- **Local filesystem only.** SQLite locking on network filesystems (NFS, SMB, cloud-synced
  folders) is untested here and not supported.
- **No synchronization between machines.** Disconnected machines stay disconnected: no transport
  moves data between them. Copying the SQLite file between computers by hand is not supported; it
  creates forks, which the rollback check refuses.

## Collaboration across machines

| Situation | Supported in 0.3.0 |
| --- | --- |
| Two people, each with internet access to GitHub | yes: the optional GitHub profile ([transports.md](transports.md)); live two-account use is not yet verified |
| Private LAN without GitHub | no supported transport yet |
| Fully disconnected machines | no; nothing synchronizes them |

Possible future transports (a self-hosted Git remote, shared storage with atomic updates and
authenticated OS identities, a signed bundle format for manual transfer) are roadmap ideas only. Each
must first meet the [transport contract](transports.md#contract). Manual transfer would need a
protocol change ([spec/proposals/protocol-3.md](../spec/proposals/protocol-3.md)).

A local `agentshake local init` command, which would create both profiles, the mailbox and the
exchange directories in one step, is deferred. The steps above use existing commands, show every
key you pin, and keep every security decision visible.
