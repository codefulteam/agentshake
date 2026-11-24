# Setup and troubleshooting

Read this when the agentshake tools are missing, fail to start or report a setup error. Setup is
your operator's job. Explain the steps; do not run profile commands such as `key`, `channel` or
`exchange` yourself.

## What the plugin runs

The plugin's MCP entry runs `node <plugin root>/scripts/agentshake-mcp.mjs`. The plugin root is two
directories above this skill's directory. That launcher:

1. Finds an already installed Agentshake engine (`agentshake` 0.3.x). It looks at `AGENTSHAKE_BIN`,
   then `"engine"` in the binding file, then `agentshake` on `PATH`, then
   `~/agentshake/node_modules/.bin/agentshake`. It never downloads or installs anything.
2. Reads the exchange directories from `AGENTSHAKE_INBOX`/`AGENTSHAKE_OUTBOX`, or from the binding
   file `~/.config/agentshake/agent.json` (`$XDG_CONFIG_HOME/agentshake/agent.json`, or the path in
   `AGENTSHAKE_AGENT_CONFIG`):

   ```json
   { "inbox": "/abs/path/exchange/inbox", "outbox": "/abs/path/exchange/outbox" }
   ```

   The file must be owned by the OS account the host runs as and not writable by group or others
   (`chmod 600`).
3. Refuses nested inbox/outbox, directories that overlap a declared profile root
   (`AGENTSHAKE_HOME`, `~/.agentshake`), and directories at or below an `operator.sqlite`. It
   cannot see an undeclared profile nested inside a chosen directory. These are setup checks, not a
   sandbox. It passes the engine only PATH, HOME, locale and temp variables, so no tokens,
   `AGENTSHAKE_HOME` or `NODE_OPTIONS`.

Codex does not forward your shell environment to plugin servers, so use the binding file there.
Claude Code forwards it, so either the environment variables or the file works.

## Diagnose

Run `node "<plugin root>/scripts/agentshake-mcp.mjs" --check` (add `--json` for machine output).
It prints the engine version, the resolved directories and the binding file, or one error with a
`next` step. Exit codes: 2 means setup is missing or invalid; 3 means a refused path (profile
overlap, unsafe binding file).

## Operator setup, once

1. Install Node.js 24 LTS or 26 LTS so that `node` is on the host's PATH.
2. Install the engine from the release tarball, offline, and put it on the operator shell's PATH:
   `npm install --offline --no-audit --no-fund --prefix ~/agentshake ./agentshake-0.3.0.tgz`, then
   `export PATH="$HOME/agentshake/node_modules/.bin:$PATH"`. The full path
   `~/agentshake/node_modules/.bin/agentshake` also works. Every operator command, including the
   `agentshake publish <draft-id>` you tell them, runs in that shell.
3. Create a profile and pairing (`agentshake key init`, `channel init|join`), then run
   `agentshake exchange configure --inbox <dir> --outbox <dir>`. If the host runs as a separate OS
   account, add `--group <group>` so that both accounts can use the exchange.
4. Write those two directories into the binding file of the account the host runs as, and
   `chmod 600` it. Restart the host session.
5. Release a brief: `agentshake brief <request> --body-file <file>`.

The plugin does not sandbox the agent or the host. In the same-account default, the agent could
read the profile and key directly. Isolation (a separate OS account or a sandbox that sees only the
exchange directories) is described in the Agentshake docs (`docs/agents.md`, Isolation).
