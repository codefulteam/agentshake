# Security

## Reporting a vulnerability

Please report vulnerabilities privately: use GitHub's "Report a vulnerability" (private
vulnerability reporting) on `codefulteam/agentshake`, or email **codefulteam@gmail.com** with
"agentshake security" in the subject. Do not open a public issue. We aim to acknowledge reports
within seven days. Agentshake is maintained on a best-effort basis; v0.1.0 is the only supported
version.

## What Agentshake is for

Two cooperating developers exchange requests and results between their coding agents, each
under their own GitHub account, with a human approving every outgoing message and every piece of
work handed to an agent.

## What it protects

- **Provenance and integrity of the mailbox.** Every event is Ed25519-signed by a pinned key and
  hash-chained to genesis. Forged, altered, replayed, out-of-role and wrong-audience events are
  rejected. A profile detects rollback or fork of any history it has already seen.
- **Exact approval.** The operator sees the destination, signer, request revision, action and exact
  text before signing, and for briefs the agent inbox and exchange configuration they will be
  released to. `--approve` works only with the digest of the exact action shown by `--preview`, and
  `--preview` never writes. A staged draft is never resent implicitly. Reconfiguring the exchange
  invalidates brief approvals that were not yet released. The digest is a review binding for a
  human operator, not a secret: software with the operator's access can compute it.
- **Trusted local paths.** The profile directory, its database and the exchange directories must be
  owned by the operator, with parents owned by the operator or root and not writable by others
  (sticky directories like `/tmp` are accepted). Symlinked profile databases are refused.
- **Separation of remote text from agents.** Remote titles, bodies and replies are shown only in
  the operator terminal, escaped (controls, bidi and format characters, and backslashes so the
  display is unambiguous). They are never written to the agent inbox. The agent receives only a brief
  the local operator wrote. `--json` operator output contains remote text (JSON-escaped); parsed
  operator output must stay out of agent context.
- **Bounded, fail-closed input.** Strict schemas with unknown-field rejection, size caps on every
  input and response, symlink, hard-link and non-regular-file refusal for drafts and briefs,
  UUID-only file names in fixed directories, no shell interpolation, curated `gh` environment,
  timeouts.
- **Durable, verifiable delivery.** Operations are journaled before contacting the transport and
  are only reported successful once the exact signed event is found in the verified chain.

## What it does not protect

- **Host isolation.** Agentshake does not sandbox anything. An agent running unrestricted as your
  user can read your profile and private key, use your `gh` credentials, publish without asking and
  edit the Agentshake installation. You must isolate the agent (separate OS account with
  `exchange configure --group`, a sandbox or a container) so it can only reach the exchange
  directories. Two setups are verified by `test/isolation/` scripts: a separate UID in a Linux
  container, and a macOS `sandbox-exec` profile under the same UID. Your own setup is not verified
  by us; check it as described in [docs/agents.md](docs/agents.md#isolation).
- **Confidentiality from GitHub or repository admins.** The ledger is plaintext JSON in a private
  repository. GitHub, repository admins and anyone with read access can read it, and Git history
  keeps it after revocation. It is not end-to-end encrypted and cannot delete anything.
- **Availability.** Anyone with write access (including your peer or an admin) can delete,
  rewrite or withhold the mailbox. Agentshake detects rewrites it has observed but cannot prevent
  them, and a fresh join has no earlier observation to compare against.
- **Truth of content.** A signature shows which key signed an event, not who wrote the prose or
  whether a claim about code is true. Treat replies and results as claims to verify.
- **Your brief.** If you paste instructions from a remote request into a brief, the agent will see
  them. That review is the operator's job and the tool cannot detect it.
- **Clocks.** Expiry assumes reasonably synchronized clocks; a malicious peer can choose its own
  timestamps within the protocol rules.
- **Stable credentials and visibility during a command.** The GitHub adapter reads the viewer and
  repository privacy, then writes in a separate `gh` call. The write is conditional on the branch
  head, but not on the viewer or on visibility. If you switch `gh` accounts or make the repository
  public while a command runs, that write can happen under the new account or into the now-public
  repository before the following receipt read detects it. Do not change either while Agentshake
  runs. The adapter does not enforce privacy atomically.
- **Broad GitHub tokens.** `gh auth login` usually yields a token with access to every repository
  of the account. Agentshake only issues fixed queries, but the token is broader than the mailbox.
- **The file transport** authenticates nobody and is for demos and tests only.

## Operator checklist

1. Verify the peer's key fingerprint over a channel you already trust.
2. Use a dedicated private mailbox repository with Actions, webhooks and integrations disabled.
3. Keep `~/.agentshake` (mode 0700) and your `gh` configuration out of the agent's reach.
4. Mount the inbox read-only for the agent; keep both exchange directories outside your profile.
5. Read `agentshake show` output critically and write briefs in your own words.
6. If `doctor` reports a rollback or fork (exit code 6), stop and compare with your peer.
