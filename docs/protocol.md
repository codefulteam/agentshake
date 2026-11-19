# Agentshake protocol, version 2

This document specifies the mailbox ledger that both participants read and append to. The
reference implementation is `src/schema.ts` (wire schemas and limits), `src/transitions.ts`
(state machine and context digest) and `src/domain.ts` (signing, replay, capacity). Transport
details are in [transports.md](transports.md).

Version 2 (Agentshake 0.2) adds **pre-accept context negotiation**: before accepting, the
recipient can ask for specific missing context, the requester answers each question as
supplied, unavailable or withheld, and the recipient confirms its understanding of the exact
context. Acceptance must cite that confirmation. Version 1 (Agentshake 0.1) is described under
[Versioning](#versioning); a version 2 reader never reads or rewrites a version 1 mailbox.

## Model

A **mailbox** is one ledger shared by exactly two participants (a fixed roster). It contains a
signed **genesis** record and an ordered list of signed **events**. Each event changes the state of
one **request**. Every reader replays the full ledger from genesis and derives the same state.

Authority comes only from signatures by pinned keys and from the transition rules below. A
transport (for example GitHub) provides storage, ordering and access control, but it is not
trusted to vouch for content.

A request goes through:

```
offer ──▶ pending ──(ask ⇄ supply)*──▶ confirm ──▶ accept ──▶ accepted ──(reply)*──▶ complete
             │                            ▲  │                   │
             │   supply (note) makes the ─┘  │                   └── cancel (requester)
             │   confirmation stale          └── a new supply needs a new confirm
             └── decline (recipient) / cancel (requester) / expiry, at any pending phase
```

## Encoding

- **Canonical JSON**: UTF-8, object keys sorted by UTF-16 code unit order, no insignificant
  whitespace, no `undefined`, integers only (safe-integer range), strings escaped by
  `JSON.stringify`. The stored ledger must equal the canonical encoding of its parsed value.
- **Strict schemas**: unknown fields are rejected everywhere. Unsupported `version` values are
  reported as such.
- **Identifiers**: request and event IDs are random UUID v4 strings generated locally. Account IDs
  are decimal strings of positive integers (GitHub numeric user IDs for the GitHub transport).
- **Keys**: Ed25519 public keys are base64url (no padding) SPKI DER, 59 characters. The
  fingerprint shown to users is `SHA256:` followed by the first 32 hex digits of SHA-256 over the
  SPKI DER bytes.
- **Signatures**: Ed25519 over the domain-separated input
  `"agentshake/v2/" + domain + "\0" + canonical(document)` where `domain` is `genesis` or `event`
  and `document` is the record without its `signature` field. Signatures are base64url (86 chars).
  A version 1 signature (domain prefix `agentshake/v1/`) never verifies as version 2.
- **Digests**: SHA-256 hex over canonical JSON.

## Ledger

```json
{ "genesis": { ... }, "events": [ ... ] }
```

### Genesis

| Field | Meaning |
| --- | --- |
| `version` | Protocol version, `2` |
| `epoch` | Random UUID identifying this mailbox instance |
| `channel` | Transport channel identity (for GitHub: `github:` + repository node ID) |
| `branch` | Branch or partition name (for GitHub: the default branch) |
| `roster` | Exactly two `{ account, key }` entries, distinct accounts and keys; the first is the creator |
| `signature` | Creator's signature over the other fields |

The genesis digest `chain[0]` is SHA-256 of the canonical genesis including its signature.
A joining participant verifies the genesis signature, its own entry and the peer's entry against
the key it verified out of band, and the channel identity reported by the transport.

### Event

| Field | Meaning |
| --- | --- |
| `version` | `2` |
| `epoch` | Must equal the genesis epoch |
| `actor` | Account ID of the signer; must be in the roster |
| `event` | UUID, unique within the ledger (replay protection) |
| `request` | UUID of the request this event belongs to |
| `revision` | Expected request revision before this event (0 for an offer) |
| `timestamp` | Sender clock, milliseconds since the Unix epoch |
| `payload` | One of the payloads below |
| `previous` | Digest of the previous record (genesis or event) |
| `signature` | Actor's signature over all other fields |

The **intent** of an event is the event without `previous` and `signature`. Its digest
identifies an operation across retries: a retry after an unrelated append re-signs the same intent
against a new `previous`. A receipt is confirmed only when an event with the same event ID and the
same intent digest is found in the verified chain.

### Payloads

"Recipient" is the `to` of the offer; "requester" is its signer.

| `kind` | Fields | Actor | Allowed when → effect |
| --- | --- | --- | --- |
| `offer` | `to`, `category` (`question`, `review`, `proposal`, `task`), `title`, `body`, `ttlHours` | either; `to` must be the other participant | new request, `pending`, revision 1, context revision 1 |
| `ask` | `context`, `items: [{ topic, need }]` (1–5) | recipient | pending, no open round, `context` = current digest, fewer than 4 supplies → opens a question round; clears the confirmation |
| `supply` | `context`, `ask?`, `answers: [{ item, status, body? }]`, `note?`, `resolutions?: [{ ask, item, body }]` (0–5) | requester | pending, `context` = current digest, fewer than 4 supplies. With `ask`: it is this request's open round and `answers` has items `1..n` exactly once, in order. Without `ask`: no open round, `answers` empty, a `note` or at least one resolution. Every resolution names a distinct, still unresolved unavailable or withheld answer of an earlier supply of this request → advances the context revision; closes the round; clears the confirmation |
| `confirm` | `context`, `understanding`, `gaps: [{ ask, item, status }]` | recipient | pending, no open round, `context` = current digest, not yet confirmed at this context revision, `gaps` = exactly the current known limitations (below) → becomes the current confirmation |
| `accept` | `context`, `confirmation` | recipient | pending, no open round, both fields equal the current digest and the current confirmation → `accepted`; negotiation closes |
| `decline` | – | recipient | pending (also with an open round) → `declined` |
| `cancel` | – | requester | pending or accepted → `canceled` |
| `reply` | `body` | either | accepted → adds a post-accept reply (result or clarification; never changes the context) |
| `complete` | `reply`, `outcome` (`completed` or `failed`) | recipient | accepted, `reply` is the recipient's own reply on this request → outcome |

`status` is `supplied` (the answer is in `body`, required), `unavailable` (the requester does not
have it) or `withheld` (the requester will not share it); `body` is an optional reason for the
latter two. Unavailable and withheld answers close the question without providing the content.
A **resolution** `{ ask, item, body }` is the requester's explicit statement that an earlier
unavailable or withheld item is now provided; `body` is the recovered content (body text rules).
Nothing is inferred from notes or later answers. The **current known limitations** of a request
are, in ledger order, every `{ ask, item, status }` whose answer was unavailable or withheld and
that no later supply resolved; a confirmation must list them exactly, so the signed understanding
always states what it still lacks. The original answers stay in the history unchanged.

Every non-offer event requires `revision` to equal the current request revision, and increments
it. Two events prepared on the same revision race; at most one can be appended. `declined`,
`canceled`, `completed` and `failed` are terminal and immutable. After `accept`, `ask`, `supply`
and `confirm` are rejected ("Context negotiation closed at acceptance"): to change scope the
requester cancels and sends a new offer. Before `accept`, `reply` is rejected.

### Context revision and digest

Each request has a **context** `{ revision, digest }`: revision 1 is the offer, every supply adds
one. The request revision (all events) and the context revision (context changes) are different
counters.

```
digest(1)   = SHA-256(canonical({ scheme: "agentshake/v2/context", request, revision: 1,
                                  offer: { to, category, title, body, ttlHours } }))
digest(n+1) = SHA-256(canonical({ scheme: "agentshake/v2/context", request, revision: n+1,
                                  previous: digest(n),
                                  supply: { event, ask (or null), answers, note (or null),
                                            resolutions (or []) } }))
```

The digest depends only on content and event IDs, so it is stable across write retries. `ask`,
`supply`, `confirm` and `accept` all carry the digest they were written for; any change of context
in between rejects them, even apart from the revision check.

### Text

| Field | Rule |
| --- | --- |
| `title`, `topic` | 1–120 Unicode scalar values, at most 480 UTF-8 bytes, one line, no C0/C1 controls or U+2028/U+2029 |
| `body`, `answer.body`, `note` | 1–4096 UTF-8 bytes; tab and newline allowed, other C0/C1 controls rejected |
| `need` | as body, at most 512 bytes |
| `understanding` | as body, at most 2048 bytes |
| `resolution.body` | as body |
| one supply | answer bodies, resolution bodies and note together at most 4096 bytes |

Text must be well-formed UTF-8 (no lone surrogates). Format characters such as bidi overrides are
allowed in the protocol and always escaped when displayed.

## Time and expiry

A request expires at `created + ttlHours × 1 hour`, with `ttlHours` from 1 to 336 (default 168).
During replay an event is rejected if its timestamp is at or after the request's expiry, or earlier
than the request's last update. When appending, a live client also rejects:

- actions on a request that is expired by the local clock,
- an offer whose prepared timestamp is already past its expiry,
- a timestamp more than five minutes ahead of the local clock.

**Expired** is a derived state: a `pending` or `accepted` request whose expiry has passed by the
reader's clock. It is closed for local action, including negotiation. The clock contract assumes
cooperating signers with reasonably synchronized clocks. A malicious pinned signer can choose its
own timestamps within these rules, and a reader that was offline may later learn of a timely
completion after it had shown the request as expired. Expiry never grants authority.

## Capacity

| Limit | Value |
| --- | --- |
| Ledger size | 256 KiB (canonical bytes) |
| Requests per mailbox | 32 |
| Events per mailbox | 128 |
| Events per request | 32 (including the offer) |
| Questions per round | 5 |
| Supplies (answered rounds plus notes) per request | 4, so at most 5 context revisions |
| Confirmations | one per context revision |

Before admitting an event, the writer checks that the resulting ledger still has room for every
live request to finish its agreed path and to close:

| Live request | Reserved event | Reserved bytes |
| --- | --- | --- |
| always | one terminal event | 1024 |
| pending | the accept | 1024 |
| pending with an open round | its supply | 2 × 4096 + 3072 |
| pending without a current confirmation | a confirm | 2 × 2048 + 3072 |
| pending or accepted without a recipient reply | one reply | 2 × 4096 + 1024 |

and that `request revision + reserved events ≤ 32`. Text escaping at most doubles the byte size.
Discretionary events (a question round, a note, more replies) must fit in the unreserved space,
so neither participant can consume the room another request, or the other side of the same
request, needs to answer, confirm, accept, reply and close. A note that would make a confirmation
stale re-reserves the confirmation, so it is refused when that room is missing. Replay applies the
same check after **every** event (every historical prefix, not only the final state) and treats a
violation as an integrity failure. Replay has no trustworthy clock, so
expired requests keep their reservation. A full mailbox is retired; pair a new one.

## Local rules that are not part of the ledger

- **Observed prefix**: each profile stores the length and digest of the longest chain it has
  verified. A later read whose chain does not contain that digest at that position is a rollback or
  fork and fails with exit code 6. A fresh join has no prior observation.
- **Briefs** are local files written by the operator and never appear in the ledger. A brief
  records its stage (`negotiating`, `accepted` or `finished`), the context revision and digest it
  was written for, the open round (both roles) and the current known limitations by
  reference. It never contains remote text unless the operator typed it.
- **Previews** never sign, append, stage or release. They run the same transition and capacity
  checks as an append on an unsigned copy, so no digest is offered for an action that cannot apply.
  A fresh preview verifies the mailbox and may advance the observed prefix.
- **Approval digests** (SHA-256 over the canonical action, including any local brief text, its
  destination inbox and exchange configuration ID, and the context it was written for) bind a
  `--preview` to a later `--approve`. They are not part of the protocol.

## Golden vectors

`test/domain.test.mjs` pins these values. Keys are derived from 32-byte Ed25519 seeds
`01 02 … 20` (Alice) and `21 22 … 40` (Bob).

| Item | Value |
| --- | --- |
| Alice public key | `MCowBQYDK2VwAyEAebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ` |
| Bob public key | `MCowBQYDK2VwAyEA5_FioQvsVZr-oZXk3OhLaVaNXSywlj60RsBoXisX8vA` |
| Alice fingerprint | `SHA256:646d6be49d9f0048f94f67749eca3515` |
| Genesis (`channel` `github:R_example`, `branch` `main`, accounts 101/202, epoch `00000000-0000-4000-8000-000000000001`) signature | `TaurBOlDL_-8QtWkI4WZCTpWs6dZwWkqkAwSfqaAgF3imWY--kb96yHgB7-TslMZQ5ChvgxDICkpqxaw_MibCA` |
| Genesis digest | `a1a832f24193d7bcf07c3d22bad7b741d8becb5a7071fdef30dfb4a69f29f5aa` |
| Offer intent digest (event = request = `…0002`, timestamp `1800000000000`, title `Café ☕ review`, body `Line 1\n\t«quoted» \\ "x" 🚀`, ttl 168) | `f52ab2bfd7b7c11ea29b510c0edaee12f4ef125f3dc22f0de342f90fe959f32c` |
| Offer event signature | `naG95GsvrFDcGuDB6PSPJsUP6kZyssGnfNyYOF1y4yDZ4VCUJGN7svzbAZoPnosHs2gEuLYN3wI9dQD00QX9Dg` |
| Ledger digest after the offer | `9c51e9d7cc5297312db8b9cd620f4f4d92e5bb379a97ac0b60197bf179474ebd` |
| Context digest (revision 1) of that offer | `b18f6adda6e827acce5763ee676894101bfc33b811eca359b3d4dc6a1d7a07bb` |

These vectors were produced by this implementation (Node.js `crypto` Ed25519). They are
regression vectors for compatible implementations, not an external test suite.

## Versioning

A protocol change uses a new version number and a **fresh mailbox**; there is no in-place
migration and no reinterpretation of older signatures.

| | Protocol 1 (Agentshake 0.1.x) | Protocol 2 (Agentshake 0.2.x) |
| --- | --- | --- |
| Genesis and event `version` | 1 | 2 |
| Signing prefix | `agentshake/v1/` | `agentshake/v2/` |
| Request start | `create` | `offer` |
| Acceptance | `accept` (no fields) | `accept` citing a confirmation and context digest |
| GitHub ledger path | `agentshake-mailbox-v1.json` | `agentshake-mailbox-v2.json` |
| Profile pairing record | no `protocol` field | `protocol: 2` |

What Agentshake 0.2 does with protocol 1 data:

- **A protocol 1 profile** (its pairing has no `protocol: 2`): every command that needs the pairing
  fails with exit code 2 before taking the profile lock, contacting the transport or writing
  anything. The message names both ways forward: keep using the immutable 0.1.0 release for that
  profile (`npm exec --yes --package=<v0.1.0 tarball URL> -- agentshake --profile <dir> …`), or
  start protocol 2 in a **new profile** (`AGENTSHAKE_HOME=<new-dir> agentshake key init`, verify
  the new fingerprints, pair a new mailbox). `key show`, `exchange show` and `pending` still work
  read-only; `pending` marks protocol 1 operations. The profile files stay byte-identical.
- **A protocol 1 mailbox** (a ledger whose genesis `version` is 1, for example an old `--file`):
  reading it fails with exit code 2 and the advice to start a fresh mailbox. It is never written.
- **GitHub**: protocol 2 reads and writes only `agentshake-mailbox-v2.json`. An existing
  `agentshake-mailbox-v1.json` in the same repository is never read or changed, and Agentshake 0.1
  keeps working on it, because each release touches only its own path. A new dedicated private
  repository for protocol 2 is recommended; reusing the old one is possible.
- **Agentshake 0.1 reading protocol 2 data** fails closed with its existing checks
  ("Unsupported mailbox protocol version 2", or an invalid pairing record).
- Unknown versions other than 1 keep exit code 6, "Unsupported mailbox protocol version".

Support limits: 0.2.x does not read, display, migrate or export protocol 1 history. Use 0.1.0 to
finish open protocol 1 requests; 0.1.x receives no protocol changes.
