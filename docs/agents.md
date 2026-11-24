# Connecting coding agents

Agentshake does not call any model and has no built-in integration with any agent product. It
offers two generic interfaces that any agent host can use:

1. **Shell**: the agent runs `agentshake agent …` commands.
2. **MCP over stdio**: the host launches `agentshake agent … mcp` and calls four tools.

Both interfaces see only two directories: the **inbox** (briefs your operator released, mount it
read-only) and the **outbox** (drafts the agent writes). They never contact the network, read the
operator profile or call `gh`. Publishing, accepting and completing are operator commands.

## What has been tested

| Integration | Status in v0.2 |
| --- | --- |
| Shell commands (`agentshake agent briefs …`, `draft …`) | Tested through the installed executable |
| MCP stdio server with the official MCP TypeScript SDK client 2.4.0 | Tested: initialize, list tools, all four tools (including ask, supply and confirm drafts), error results |
| Isolation: agent as a separate UID (`--group`) in a Linux container; agent under `sandbox-exec` on macOS | Tested by `test/isolation/` scripts (see [Isolation](#isolation)) |
| Claude Code CLI 2.1.330 and Codex CLI 0.171.0 through the [plugin](../plugins/agentshake/README.md) | Tested on macOS in fresh private host homes: offline install, skill discovery, MCP handshake; Codex tool calls through its app server. See the plugin README for exactly what each host was verified for |
| Any other agent host (Claude Desktop, ChatGPT desktop, Codex IDE extension, Grok, Kimi, DeepSeek-based agents, others) | **Not tested.** Expected to work wherever the host can run shell commands or launch a stdio MCP server, but unverified |

If you verify a host, please contribute the exact configuration and version (see
[CONTRIBUTING.md](../CONTRIBUTING.md)). We list a host as tested only with a reproducible record.

## Shell interface

Point the agent at the two directories with flags or environment variables:

```sh
export AGENTSHAKE_INBOX=/exchange/inbox AGENTSHAKE_OUTBOX=/exchange/outbox
agentshake agent briefs list                         # request ID, stage, role, kind, expiry
agentshake agent briefs show <request-id>            # the operator's brief and its context binding
agentshake agent draft new --kind review --title "Review retry behavior" --body-file - < request.md

# Before acceptance, with a negotiation brief (stage "negotiating"):
agentshake agent draft ask <request-id> --topic "Which branch?" --need "To review the right code"
agentshake agent draft supply <request-id> --answers-file answers.json     # requester, open round
agentshake agent draft confirm <request-id> --understanding-file understanding.md

# After acceptance, with a work brief (stage "accepted"):
agentshake agent draft reply <request-id> --body-file findings.md
```

### Briefs and stages

| Stage | Who releases it | What it means for the agent |
| --- | --- | --- |
| `negotiating` (`authorizesWork: false`) | operator, while the request is pending | **Not approved work.** Help the operator clarify: questions and an understanding (recipient), or answers (requester). |
| `accepted` (`authorizesWork: true`) | operator, at accept or later | The full scope of approved work. Report results with `draft reply`. |
| `finished` | operator, after completion | A local follow-up the operator wrote, for example acting on a result. |

A brief carries `context { revision, digest }`, for the requester the open question round
(`open { ask, items }`, for both roles; the recipient waits while it is open) and the current
unresolved limitations by reference (`gaps`). It never contains the
other side's text unless your operator typed it. `draft ask`, `draft supply` and `draft confirm`
take their binding (context digest or round ID) from the brief by default, so a draft always says
what it was written for. When the context changes, the operator side removes the stale negotiation
brief and `publish` refuses drafts bound to the old context; ask your operator for a new brief.
A work brief means approved *when it was issued*. The requester can cancel later, and you will not
see that until your operator reads the mailbox again, which removes the briefs of canceled,
declined and expired requests. Expiry is different: from the brief's `expires` time (local clock),
`briefs show`/`read_brief` refuse it and `briefs list`/`list_briefs` omit it, even without a refresh. Publishing a reply to a closed request is refused. `unavailable` and `withheld`
answers are gaps, never evidence: say what you could not check. As
the requester, if you actually recover a listed gap, draft a supply with
`resolutions: [{ ask, item, body }]` containing the recovered content; never claim a resolution
without the content.

`agentshake agent capabilities` prints the same document as `get_capabilities`. Your operator can
write the same drafts with `agentshake draft …`; they are the `local-exchange/1` documents in
[spec/local-exchange.md](../spec/local-exchange.md).

Add `--json` for machine-readable output. Kinds are `question`, `review`,
`proposal` and `task`. Bodies are at most 4096 bytes and may not contain terminal control
characters (tab and newline are fine). A draft is not sent until the operator runs
`agentshake publish <draft-id>`.

A short instruction you can give an agent:

> Use `agentshake agent briefs list` and `agentshake agent briefs show <id>` to read briefs.
> A brief with stage `negotiating` is not approved work: do not start the task. If you are the
> recipient, draft what is missing with `draft ask` (each item with why you need it) or, once
> enough is known, your understanding and its limitations with `draft confirm`. If you are the
> requester, draft answers with `draft supply` (supplied, unavailable or withheld). A brief with
> stage `accepted` is the complete scope of approved work; write your result with
> `draft reply <id> --body-file <file>`. Tell me each draft ID. You cannot send anything yourself.

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
| `list_briefs` | `{}` | `[{ request, role, category, stage, authorizesWork, expires, version, context, open?, gaps }]` |
| `read_brief` | `{ request }` | the same plus `body` |
| `create_draft` | `{ draft }`, one of the drafts below | `{ draft, action, request? }` |
| `get_capabilities` | `{}` | the `capabilities-1` document: protocol, operations, the draft actions you can propose, limits, schema IDs (static; grants nothing) |

| `draft.action` | Fields | Who |
| --- | --- | --- |
| `new` | `category`, `title`, `body`, `ttlHours?` | either (an offer) |
| `ask` | `request`, `context` (digest from the brief), `items: [{ topic, need }]` (1–5) | recipient, pending |
| `supply` | `request`, `ask` (round ID from the brief), `answers: [{ item, status, body? }]`, `note?`, `resolutions?` — or `request`, `context`, `note?`, `resolutions?: [{ ask, item, body }]` | requester, pending |
| `confirm` | `request`, `context`, `understanding` (≤ 2048 bytes) | recipient, pending |
| `reply` | `request`, `body` | either, accepted |

Errors come in two kinds. An error raised by Agentshake inside a tool (for example no approved
brief, or a missing outbox) is a tool result with `isError: true` whose text is JSON
`{ error, next, exitCode }`. Arguments that do not match the advertised input schema (a malformed
UUID, an unknown field, a wrong type) are rejected by the MCP SDK before Agentshake runs: that
result is also `isError: true`, but its text is the SDK's plain validation message naming the
field, with no `next`; correct the arguments against the tool's input schema and call again. The
server writes only MCP frames to stdout and never returns remote text: only operator briefs and
binding metadata.

## Host plugin

For Claude Code and Codex, [`plugins/agentshake`](../plugins/agentshake/README.md) bundles this MCP
server with a workflow skill, so you need no hand-written host configuration. The plugin runs
`scripts/agentshake-mcp.mjs`. It finds your installed engine and reads the exchange directories from
`AGENTSHAKE_INBOX`/`AGENTSHAKE_OUTBOX` or a binding file (`~/.config/agentshake/agent.json`), then
runs `agentshake agent --inbox … --outbox … mcp` with a minimal environment. The binding and the
profile are separate: the binding names the two exchange directories, never the profile. The
launcher refuses directories that overlap a declared profile root (`AGENTSHAKE_HOME`,
`~/.agentshake`) or that sit at or below an `operator.sqlite`. It cannot detect an undeclared
profile nested inside a chosen directory. These are setup checks, not isolation. The binding must
be owned by the account the host runs as. See the plugin README for same-account versus
separate-account setup.

## Per-host notes

Apart from the plugin hosts listed above, all of these are **untested**. They describe the generic
path, not native support.

- **Codex (OpenAI)** — use the plugin (CLI and desktop app; plugins are not available in the IDE
  extension or in ChatGPT web). Otherwise, if your Codex host can run shell commands, use the shell
  interface. If it supports stdio MCP servers, register the command and args above using Codex's
  own configuration format.
- **Claude (Anthropic)** — in Claude Code, use the plugin. In Claude Desktop or other Claude hosts,
  use the shell interface where shell access is available, or register the stdio MCP server in the
  host's MCP configuration.
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
agent reads a negotiation brief and drafts a question the operator publishes, reads the work brief
(including a replaced one), writes drafts the operator publishes, uses all three MCP tools, and
cannot read the operator profile or key, use the profile, or modify or add briefs.

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

It verifies a negotiation brief and a question draft, brief reads (including replaced briefs),
drafts the operator publishes, all three MCP tools, and denial of the profile, key, inbox writes,
network and `gh`. Apple marks `sandbox-exec`
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
