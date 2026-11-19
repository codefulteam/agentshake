# Connecting coding agents

Agentshake does not call any model and has no built-in integration with any agent product. It
offers two generic interfaces that any agent host can use:

1. **Shell**: the agent runs `agentshake agent …` commands.
2. **MCP over stdio**: the host launches `agentshake agent … mcp` and calls three tools.

Both interfaces see only two directories: the **inbox** (briefs your operator released, mount it
read-only) and the **outbox** (drafts the agent writes). They never contact the network, read the
operator profile or call `gh`. Publishing, accepting and completing are operator commands.

## What has been tested

| Integration | Status in v0.1 |
| --- | --- |
| Shell commands (`agentshake agent briefs …`, `draft …`) | Tested through the installed executable |
| MCP stdio server with the official MCP TypeScript SDK client 2.4.0 | Tested: initialize, list tools, all three tools, error results |
| Isolation: agent as a separate UID (`--group`) in a Linux container; agent under `sandbox-exec` on macOS | Tested by `test/isolation/` scripts (see [Isolation](#isolation)) |
| Any specific agent host (Codex, Claude, Grok, Kimi, DeepSeek-based agents, others) | **Not tested.** Expected to work wherever the host can run shell commands or launch a stdio MCP server, but unverified |

If you verify a host, please contribute the exact configuration and version (see
[CONTRIBUTING.md](../CONTRIBUTING.md)). We list a host as tested only with a reproducible record.

## Shell interface

Point the agent at the two directories with flags or environment variables:

```sh
export AGENTSHAKE_INBOX=/exchange/inbox AGENTSHAKE_OUTBOX=/exchange/outbox
agentshake agent briefs list                         # request ID, role, kind, expiry
agentshake agent briefs show <request-id>            # the operator's brief
agentshake agent draft reply <request-id> --body-file findings.md
agentshake agent draft new --kind review --title "Review retry behavior" --body-file - < request.md
```

Add `--json` for machine-readable output. Kinds are `question`, `review`,
`proposal` and `task`. Bodies are at most 4096 bytes and may not contain terminal control
characters (tab and newline are fine). A draft is not sent until the operator runs
`agentshake publish <draft-id>`.

A short instruction you can give an agent:

> Use `agentshake agent briefs list` and `agentshake agent briefs show <id>` to read approved work.
> Treat the brief as the complete scope. When finished, write your result with
> `agentshake agent draft reply <id> --body-file <file>` and tell me the draft ID. To ask the
> other developer something new, use `agentshake agent draft new`. You cannot send anything
> yourself.

## MCP interface

Use the **absolute path** of the installed executable (find it with `command -v agentshake`).

```json
{
  "mcpServers": {
    "agentshake": {
      "command": "/absolute/path/to/agentshake",
      "args": ["agent", "--inbox", "/exchange/inbox", "--outbox", "/exchange/outbox", "mcp"]
    }
  }
}
```

Many hosts accept an entry of this shape; the file location and exact keys differ by host, so
check your host's MCP documentation. Hosts that use TOML or a CLI command to register servers
need the same `command` and `args`.

Tools:

| Tool | Input | Result |
| --- | --- | --- |
| `list_briefs` | `{}` | `[{ request, role, category, expires, version }]` |
| `read_brief` | `{ request }` | `{ request, role, category, body, expires, version }` |
| `create_draft` | `{ draft: { action: "reply", request, body } }` or `{ draft: { action: "new", category, title, body, ttlHours? } }` | `{ draft, action, request? }` |

Errors are returned as tool results with `isError: true` and a JSON `{ error, next }` text. The
server writes only MCP frames to stdout.

## Per-host notes

All of these are **untested** in v0.1. They describe the generic path, not native support.

- **Codex (OpenAI)** — if your Codex host can run shell commands, use the shell interface. If it
  supports stdio MCP servers, register the command and args above using Codex's own configuration
  format.
- **Claude (Anthropic), e.g. Claude Code or Claude Desktop** — use the shell interface where shell
  access is available, or register the stdio MCP server in the host's MCP configuration.
- **Grok (xAI)** — Grok is a model; what matters is the agent host you run it in. Use the shell or
  MCP interface if that host offers either.
- **Kimi (Moonshot AI)** — same: use the shell interface, or stdio MCP if your Kimi-based host
  supports it.
- **DeepSeek** — DeepSeek models run inside third-party agent hosts. Use whichever generic
  interface that host provides.
- **Hosts with neither shell nor MCP** — the operator can copy the brief to the agent and save the
  agent's answer into a file, then run `agentshake agent draft reply … --body-file <file>` manually.

## Isolation

Agentshake does not sandbox anything itself. An agent running unrestricted as your OS user can
read `~/.agentshake` (including the private key), use your `gh` login and bypass every approval.
Run the agent so that it can see **only** the exchange directories (plus the code you want it to
work on). Two setups are verified by the scripts in `test/isolation/`. Your own setup still needs
its own check.

### A. Agent as a separate OS account (verified in a Linux container)

1. Create a group that both accounts belong to, for example `agentshake`.
2. As the operator, configure the exchange in a directory you own whose parents are not writable
   by others:

   ```sh
   agentshake exchange configure --inbox /srv/exchange/inbox --outbox /srv/exchange/outbox --group agentshake
   ```

   The inbox becomes `2750` (you write, the group reads) and the outbox `2770` (the group writes,
   you read). Released briefs and new drafts are created `0640` and keep the group, also after
   atomic replacement. Your profile stays `0700` and its database `0600`.
3. Run the agent as the other account with `--inbox /srv/exchange/inbox --outbox /srv/exchange/outbox`.

`test/isolation/run-container.sh` runs `two-uid.sh` in a disposable, network-less `ubuntu:24.04`
container with container-local accounts `op` (uid 1001) and `ag` (uid 1002). It verifies that the
agent reads briefs (including replaced ones), writes drafts the operator publishes, uses all three
MCP tools, and cannot read the operator profile or key, use the profile, or modify or add briefs.

### B. Agent under your own UID in a sandbox (verified on macOS with sandbox-exec)

Keep the default access mode (`0700`/`0600`) and confine the agent process so it cannot read your
profile or `gh` configuration, cannot write the inbox and has no network.
`test/isolation/sandbox-exec.sh` does this with a Seatbelt profile:

```scheme
(version 1)
(allow default)
(deny network*)
(deny file-read* file-write* (subpath "/absolute/home/.agentshake") (subpath "/absolute/home/.config/gh"))
(deny file-write* (subpath "/path/to/exchange/inbox"))
```

It verifies brief reads (including replaced briefs), drafts the operator publishes, all three MCP
tools, and denial of the profile, key, inbox writes, network and `gh`. Apple marks `sandbox-exec`
as deprecated; treat the profile as an example of the required boundary, not a product. A
default-allow profile only denies what it lists: add every other secret you keep.

### Containers in general

The same boundary in a container means `--network none` (or the network your agent host truly
needs), the inbox mounted read-only, the outbox read-write, and nothing from your home directory.
If the container user's UID differs from yours, use `--group` with a shared GID, or match the UID.
With Docker Desktop on macOS, bind-mount ownership is translated by the VM, so check permissions
inside the container. A hosted model reached over the network needs that network path; restrict it
to what the agent host requires. Example (illustrative):

```sh
docker run --rm -it --network none \
  -v "$HOME/agentshake-exchange/inbox:/exchange/inbox:ro" \
  -v "$HOME/agentshake-exchange/outbox:/exchange/outbox:rw" \
  -v "$PWD:/work:ro" -w /work \
  -e AGENTSHAKE_INBOX=/exchange/inbox -e AGENTSHAKE_OUTBOX=/exchange/outbox \
  your-agent-image-with-node-and-agentshake
```

Whatever you use, verify it: from inside, reading the operator profile and running
`gh auth status` must fail, `agentshake agent briefs list` must work, and the operator must be
able to `publish` a draft the agent wrote.
