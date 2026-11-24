# Security

## Reporting a vulnerability

Please report vulnerabilities privately: use GitHub's "Report a vulnerability" (private
vulnerability reporting) on `codefulteam/agentshake`, or email **codefulteam@gmail.com** with
"agentshake security" in the subject. Do not open a public issue. We aim to acknowledge reports
within seven days. Agentshake is maintained on a best-effort basis. Supported: v0.2.x (protocol 2).
v0.1.0 (protocol 1) is immutable and supported only for finishing existing protocol 1 mailboxes;
it receives no protocol changes.

## What Agentshake is for

Two cooperating developers exchange requests and results between their coding agents, each
under their own GitHub account, with a human approving every outgoing message and every piece of
work handed to an agent. Before work is accepted, they negotiate the context: questions,
answers (supplied, unavailable or withheld) and a confirmed understanding.

## What it protects

- **Provenance and integrity of the mailbox.** Every event is Ed25519-signed by a pinned key and
  hash-chained to genesis. Forged, altered, replayed, out-of-role and wrong-audience events are
  rejected. A profile detects rollback or fork of any history it has already seen.
- **Bound context negotiation.** Only the recipient can ask, confirm and accept; only the
  requester can supply. Answers must cover exactly the open question round of the same request,
  and every negotiation event names the context digest it was written for, so skipped, duplicated,
  cross-request, replayed or stale answers and stale confirmations are rejected by every reader.
  Acceptance cites the current confirmation, and the confirmation lists the unavailable and
  withheld items that no later supply explicitly resolved (with recovered content, tied to the
  exact earlier round and item) as current known limitations. After acceptance the context is frozen; post-accept replies
  never widen the accepted scope. Rounds, sizes and closing capacity are bounded and reserved.
- **Exact approval.** The operator sees the destination, signer, request revision, action and exact
  text before signing, and for briefs the agent inbox and exchange configuration they will be
  released to. `--approve` works only with the digest of the exact action shown by `--preview`.
  `--preview` never signs, sends, stages or releases anything and refuses actions the mailbox would
  reject; it may advance the local rollback checkpoint (observed prefix) after verifying the mailbox,
  and opens or creates the profile database like every command. A staged-draft preview makes no
  network call and no profile write. A staged draft is never resent implicitly. Reconfiguring the exchange
  invalidates brief approvals that were not yet released. The digest is a review binding for a
  human operator, not a secret: software with the operator's access can compute it.
- **Trusted local paths.** The profile directory, its database and the exchange directories must be
  owned by the operator, with parents owned by the operator or root and not writable by others
  (sticky directories like `/tmp` are accepted). Symlinked profile databases are refused.
- **Separation of remote text from agents.** Remote titles, bodies and replies are shown only in
  the operator terminal, escaped (controls, bidi and format characters, and backslashes so the
  display is unambiguous). This includes the peer's questions, answers, notes and understanding.
  They are never written to the agent inbox. The agent receives only a brief the local operator
  wrote, plus binding metadata (context digest, round ID and item count, gap references). A
  negotiation brief is marked `authorizesWork: false`, is removed when its context goes stale, and
  is never refreshed with remote text automatically. `--json` operator output contains remote text (JSON-escaped); parsed
  operator output must stay out of agent context.
- **Bounded, fail-closed input.** Strict schemas with unknown-field rejection, size caps on every
  input and response, symlink, hard-link and non-regular-file refusal for drafts and briefs,
  UUID-only file names in fixed directories, no shell interpolation, curated `gh` environment,
  timeouts.
- **Durable, verifiable delivery.** Operations are journaled before contacting the transport and
  are only reported successful once the exact signed event is found in the verified chain.

## What it does not protect

- **Meaning of a valid ledger.** `agentshake validate` and `conformance` check that a history is
  well formed, signed by the pinned keys and consistent with the rules. A valid ledger is not
  permission to act, not evidence that its text is true, and not a statement that a request is still
  live (expiry is evaluated against your own clock when you act).
- **The file mailbox.** The `--file` profile authenticates nobody. Use it on one trusted machine
  only ([docs/local.md](docs/local.md)).
- **Host isolation.** Agentshake does not sandbox anything. An agent running unrestricted as your
  user can read your profile and private key, use your `gh` credentials, publish without asking and
  edit the Agentshake installation. You must isolate the agent (separate OS account with
  `exchange configure --group`, a sandbox or a container) so it can only reach the exchange
  directories. Two setups are verified by `test/isolation/` scripts: a separate UID in a Linux
  container, and a macOS `sandbox-exec` profile under the same UID. Your own setup is not verified
  by us; check it as described in [docs/agents.md](docs/agents.md#isolation).
- **Host plugin.** The Claude Code / Codex plugin (`plugins/agentshake`) starts the agent MCP server
  as a child of the agent host. Its launcher passes the engine only PATH, HOME, locale and temp
  variables. It refuses exchange directories that overlap a declared profile root
  (`AGENTSHAKE_HOME`, `~/.agentshake`) or sit at or below an `operator.sqlite`, and binding files
  that others can write. These checks run once on trusted paths; they are not a sandbox and they
  are not race-resistant. This keeps tokens and the profile out of the server process. It does not
  isolate the host itself: an unrestricted host can still read your profile. The binding file
  chooses which engine executable runs, so keep it `0600`.
- **Confidentiality from GitHub or repository admins.** The ledger is plaintext JSON in a private
  repository. GitHub, repository admins and anyone with read access can read it, and Git history
  keeps it after revocation. It is not end-to-end encrypted and cannot delete anything.
- **Availability.** Anyone with write access (including your peer or an admin) can delete,
  rewrite or withhold the mailbox. Agentshake detects rewrites it has observed but cannot prevent
  them, and a fresh join has no earlier observation to compare against.
- **Truth of content.** A signature shows which key signed an event, not who wrote the prose or
  whether a claim about code is true. Treat replies and results as claims to verify.
- **Your brief.** If you paste instructions from a remote request, question or answer into a brief,
  the agent will see them. That review is the operator's job and the tool cannot detect it.
- **Protocol 1 profiles** are refused by every profile command except `key`, `exchange show` and
  `pending`, before any GitHub lookup, journal or exchange read, transport contact or write.
- **Completeness of context.** A confirmation records what the recipient says it understood; it
  does not prove the context is correct or complete. `unavailable` and `withheld` answers are
  declared gaps, not evidence.
- **Stale negotiation briefs between reads.** A negotiation brief is removed the next time the
  operator lists or shows requests, or records an event. Until then an agent can still read it,
  but any draft it writes against the old context is refused at `publish`.
- **Accepted briefs after cancellation.** A brief records the operator's approval at the time it
  was released. If the requester later cancels, an offline agent still sees the old brief, with
  `authorizesWork: true`. It disappears only when the recipient's operator reads the mailbox
  again (`agentshake inbox`, `outbox`, `show` or `drafts`). Those reads remove the briefs of
  canceled, declined and expired requests. Any reply the agent drafts is refused at `publish`.
  Refresh before you hand work to an agent, and treat a brief as "approved when issued", not
  "still approved".
- **Expiry needs no refresh.** A brief carries its request's expiry. From that instant
  (`now >= expires`, by the local clock), the agent interface (shell and MCP) refuses to read it
  and omits it from the list, even offline. The file stays in the inbox until an operator read
  removes it.
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
- **The file transport** authenticates nobody. It is for one trusted machine: personal use (two
  local principals, you and your agents), the demo and tests ([docs/local.md](docs/local.md)).
  It is not a transport between users who do not trust each other, or between machines.

## Operator checklist

1. Verify the peer's key fingerprint over a channel you already trust.
2. Use a dedicated private mailbox repository with Actions, webhooks and integrations disabled.
3. Keep your profile (`~/.agentshake` or `AGENTSHAKE_HOME`, mode 0700) and your `gh`
   configuration out of the agent's reach.
4. Mount the inbox read-only for the agent; keep both exchange directories outside your profile.
5. Read `agentshake show` output critically and write briefs in your own words. Check the peer's
   questions and answers before you confirm or accept.
6. If `doctor` reports a rollback or fork (exit code 6), stop and compare with your peer.
