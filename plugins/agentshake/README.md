# Agentshake plugin for Claude Code and Codex

This plugin connects a coding agent to [Agentshake](https://github.com/codefulteam/agentshake), an
operator-approved, signed handshake between two developers' agents. It adds:

- the **`agentshake` skill**, which teaches the agent the workflow. The agent reads the briefs its
  operator approved and drafts an offer, question, answer, confirmation or result.
- the **`agentshake` MCP server** (local stdio). It runs your installed Agentshake engine's existing
  agent interface: `list_briefs`, `read_brief`, `create_draft` and `get_capabilities`.

The agent only writes drafts. You, the operator, still review, sign and publish every message with
`agentshake publish`, and accept, complete or cancel with the operator CLI. The plugin adds no
hooks, starts no daemon, uses no network and never downloads anything.

## Where it works

| Host | Status |
| --- | --- |
| Claude Code CLI 2.1.330 (macOS) | Verified: offline install from a local catalog, MCP server connected. In a model session with the plugin `.zip`, the skill was invoked and drafts were written through the tools |
| Codex CLI 0.171.0 (macOS) | Verified: offline install into the Codex cache, skill discovered, MCP handshake, and tool calls through the Codex app server. A model session has not been run |
| ChatGPT desktop app, Codex IDE extension, Claude Desktop | Not verified |
| ChatGPT web, Codex cloud, claude.ai or any cloud agent | Not supported. The server is a local process on your machine. |

This is a community plugin. It is not listed in, or reviewed for, any official plugin directory.

## Prerequisites

1. **Node.js 24 LTS or 26 LTS** as `node` on the PATH your agent host sees.
2. **The Agentshake engine 0.3.x**, installed from its release tarball. This needs no registry or
   network, because the runtime dependencies are bundled:

   ```sh
   npm install --offline --no-audit --no-fund --prefix ~/agentshake ./agentshake-0.3.0.tgz
   export PATH="$HOME/agentshake/node_modules/.bin:$PATH"   # operator shell; add it to your shell profile
   agentshake --version
   ```

   The prefix does not put `agentshake` on your PATH by itself. Use the `export` line above in
   every operator shell, or call `~/agentshake/node_modules/.bin/agentshake` by its full path. All
   operator commands below, and the `agentshake publish <draft-id>` the agent prints, run in that
   shell. The plugin finds the engine on its own, through `AGENTSHAKE_BIN`, the `"engine"` field of
   the binding file, `agentshake` on the host's PATH, or
   `~/agentshake/node_modules/.bin/agentshake`, in that order. The plugin trusts the Node.js,
   engine and PATH you install. It checks the engine's layout, name and version (stable 0.3.x), but
   it does not verify where the engine came from.
3. **A profile and an exchange**, set up by you as the operator (see the main README, or
   `docs/local.md` for one machine without GitHub):

   ```sh
   agentshake key init
   agentshake channel init …            # or channel join
   agentshake exchange configure --inbox ~/agentshake-exchange/inbox --outbox ~/agentshake-exchange/outbox
   ```

## Tell the plugin where the exchange is

Write the two directories into the **binding file** `~/.config/agentshake/agent.json`, or into
`$XDG_CONFIG_HOME/agentshake/agent.json`, or into the file named by `AGENTSHAKE_AGENT_CONFIG`:

```sh
mkdir -p ~/.config/agentshake
cat > ~/.config/agentshake/agent.json <<EOF
{ "inbox": "$HOME/agentshake-exchange/inbox", "outbox": "$HOME/agentshake-exchange/outbox" }
EOF
chmod 600 ~/.config/agentshake/agent.json
```

The optional `"engine"` field takes the absolute path of `node_modules/.bin/agentshake`. Use it
when the host's PATH does not include the engine.

On POSIX, the binding file must be owned by the account the **agent host process** runs as, with
mode `600`. The launcher runs under that account and refuses a file owned by anyone else or
writable by group or others.

- **Same account (the default above).** You, the host and the agent share one OS account. The
  exchange is `0700`, and you own the binding. This is convenient, but it gives no credential
  isolation: the host can read your profile and key.
- **Separate account.** As the operator, configure the exchange with a group that both accounts
  belong to (`agentshake exchange configure … --group <group>`). Then, as the host account, create
  that account's own binding with the same two paths in its home and `chmod 600` it. The engine
  must be readable and executable by the host account, and its `"engine"` path must point at it.
  The operator profile stays private to your account. See `docs/agents.md`, Isolation.

Codex passes plugin servers only a minimal environment (PATH, HOME, locale, temp), so it needs the
binding file. Claude Code passes your shell environment, so `AGENTSHAKE_INBOX` and
`AGENTSHAKE_OUTBOX` also work there, and they take precedence over the file.

The binding holds paths only, never keys or tokens. The launcher refuses:

- a binding file that others can write;
- nested or identical inbox and outbox;
- directories that overlap a **declared** profile root (`AGENTSHAKE_HOME` if the host passes it,
  and `~/.agentshake`) in either direction;
- directories at or below a directory that contains `operator.sqlite`.

It cannot find a profile at a custom location nested **inside** a chosen directory when that
location is not declared to the launcher, so do not place profiles inside exchange directories.

These are setup checks on paths you trust, made once before the server starts. They are not a
sandbox, and they do not defend against someone swapping directories between the check and the
use. The launcher starts the engine with only PATH, HOME, locale and temp variables, so
`GH_TOKEN`, `AGENTSHAKE_HOME` and `NODE_OPTIONS` are dropped for the engine. Node options already
applied to the launcher by the host still apply to the launcher itself.

Check the setup at any time:

```sh
node <plugin root>/scripts/agentshake-mcp.mjs --check
```

## Install

From a clone or an extracted `agentshake-plugins-0.1.0.tgz`, both fully offline:

```sh
# Claude Code
claude plugin marketplace add ./agentshake-plugins-0.1.0      # or the repository checkout
claude plugin install agentshake@agentshake

# Codex
codex plugin marketplace add ./agentshake-plugins-0.1.0
codex plugin add agentshake@agentshake                         # or /plugins in the Codex TUI
```

From the GitHub repository catalog, once these files are on its default branch (not yet verified
against the hosted repository):

```sh
claude plugin marketplace add codefulteam/agentshake && claude plugin install agentshake@agentshake
codex plugin marketplace add codefulteam/agentshake && codex plugin add agentshake@agentshake
```

For a single Claude Code session without installing: `claude --plugin-dir ./plugins/agentshake`.

Start a new session after installing, so the host loads the skill and the server. Codex copies
the plugin into its cache (`~/.codex/plugins/cache/agentshake/agentshake/<version>/`) and runs that
copy. Claude Code runs a plugin from a local catalog in place, so keep the catalog directory where
you added it. After an update, reinstall the plugin, or run `claude plugin marketplace update`.
The engine is not inside the plugin, so updating the engine needs no plugin change while it stays
0.3.x.

When setup is incomplete, hosts only report that the server failed to connect. Run the `--check`
command above for the actual reason and the next step.

## Use

Ask in your own words, for example "check my Agentshake briefs and tell me the next step", or name
the skill: `/agentshake:agentshake` in Claude Code. Codex lists it as `agentshake:agentshake`
(mention it with `$`, or find it under `/skills`). The agent reads the
brief and writes the matching draft. It then gives you the draft ID and the command to review it:

```sh
agentshake publish <draft-id>
```

A brief in the `negotiating` stage is not approved work. The agent only helps clarify (`ask`,
`supply`, `confirm`). Only an `accepted` brief authorizes the work and a `reply`. Briefs expire,
and drafts written for an older context are refused at `publish`, so release a new brief when the
context changes.

## Security boundary

The plugin does not sandbox the agent or the host. If the agent runs unrestricted as your OS user
(the same-account default), it can read your profile and key or use `gh` directly, and so bypass
every approval. Run it as a separate OS
account or in a sandbox that only sees the exchange directories (main docs, `docs/agents.md`,
Isolation). Text from the other developer never reaches the agent through these tools.

## Uninstall

`claude plugin uninstall agentshake@agentshake` or `codex plugin remove agentshake@agentshake`.
Your profile, exchange directories and binding file are left untouched.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
