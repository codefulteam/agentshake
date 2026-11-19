# Agentshake protocol, version 1

This document specifies the mailbox ledger that both participants read and append to. The
reference implementation is `src/domain.ts`. Transport details are in [transports.md](transports.md).

## Model

A **mailbox** is one ledger shared by exactly two participants (a fixed roster). It contains a
signed **genesis** record and an ordered list of signed **events**. Each event changes the state of
one **request**. Every reader replays the full ledger from genesis and derives the same state.

Authority comes only from signatures by pinned keys and from the transition rules below. A
transport (for example GitHub) provides storage, ordering and access control, but it is not
trusted to vouch for content.

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
  `"agentshake/v1/" + domain + "\0" + canonical(document)` where `domain` is `genesis` or `event`
  and `document` is the record without its `signature` field. Signatures are base64url (86 chars).
- **Digests**: SHA-256 hex over canonical JSON.

## Ledger

```json
{ "genesis": { ... }, "events": [ ... ] }
```

### Genesis

| Field | Meaning |
| --- | --- |
| `version` | Protocol version, `1` |
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
| `version` | `1` |
| `epoch` | Must equal the genesis epoch |
| `actor` | Account ID of the signer; must be in the roster |
| `event` | UUID, unique within the ledger (replay protection) |
| `request` | UUID of the request this event belongs to |
| `revision` | Expected request revision before this event (0 for create) |
| `timestamp` | Sender clock, milliseconds since the Unix epoch |
| `payload` | One of the payloads below |
| `previous` | Digest of the previous record (genesis or event) |
| `signature` | Actor's signature over all other fields |

The **intent** of an event is the event without `previous` and `signature`. Its digest
identifies an operation across retries: a retry after an unrelated append re-signs the same intent
against a new `previous`. A receipt is confirmed only when an event with the same event ID and the
same intent digest is found in the verified chain.

### Payloads

| `kind` | Fields | Actor | Transition |
| --- | --- | --- | --- |
| `create` | `to`, `category` (`question`, `review`, `proposal`, `task`), `title`, `body`, `ttlHours` | either; `to` must be the other participant | new request, `pending`, revision 1 |
| `accept` | – | recipient | `pending` → `accepted` |
| `decline` | – | recipient | `pending` → `declined` |
| `reply` | `body` | either | adds a reply to an `accepted` request |
| `complete` | `reply`, `outcome` (`completed` or `failed`) | recipient | `accepted` → outcome; `reply` must be the recipient's own reply on this request |
| `cancel` | – | requester | `pending` or `accepted` → `canceled` |

Every non-create event requires `revision` to equal the current request revision, and increments it.
Two events prepared on the same revision race; at most one can be appended. `declined`,
`canceled`, `completed` and `failed` are terminal and immutable.

### Text

`title`: 1–120 Unicode scalar values, at most 480 UTF-8 bytes, a single line without C0/C1
control characters or U+2028/U+2029. `body`: 1–4096 UTF-8 bytes; tab and newline allowed, other
C0/C1 controls rejected. Text must be well-formed UTF-8 (no lone surrogates). Format characters
such as bidi overrides are allowed in the protocol and always escaped when displayed.

## Time and expiry

A request expires at `created + ttlHours × 1 hour`, with `ttlHours` from 1 to 336 (default 168).
During replay an event is rejected if its timestamp is at or after the request's expiry, or earlier
than the request's last update. When appending, a live client also rejects:

- actions on a request that is expired by the local clock,
- a create whose prepared timestamp is already past its expiry,
- a timestamp more than five minutes ahead of the local clock.

**Expired** is a derived state: a `pending` or `accepted` request whose expiry has passed by the
reader's clock. It is closed for local action. The clock contract assumes cooperating signers with
reasonably synchronized clocks. A malicious pinned signer can choose its own timestamps within these
rules, and a reader that was offline may later learn of a timely completion after it had shown the
request as expired. Expiry never grants authority.

## Capacity

| Limit | Value |
| --- | --- |
| Ledger size | 256 KiB (canonical bytes) |
| Requests per mailbox | 32 |
| Events per mailbox | 128 |
| Events per request | 32 (including create) |

Before admitting an event, the writer checks that the resulting ledger still has room for every
live request's remaining events: an accept if pending, one recipient reply if none exists yet, and a
terminal event. Reserved bytes are 1024 per accept or terminal event and `2 × 4096 + 1024` per
reply (text escaping at most doubles the byte size). Replay applies the same check and treats a
violation as an integrity failure. Replay has no trustworthy clock, so expired requests keep
their reservation. A full mailbox is retired; pair a new one.

## Local rules that are not part of the ledger

- **Observed prefix**: each profile stores the length and digest of the longest chain it has
  verified. A later read whose chain does not contain that digest at that position is a rollback or
  fork and fails with exit code 6. A fresh join has no prior observation.
- **Briefs** are local files written by the operator and never appear in the ledger.
- **Approval digests** (SHA-256 over the canonical action, including any local brief text and its
  destination inbox and exchange configuration ID) bind a
  `--preview` to a later `--approve`. They are not part of the protocol.

## Golden vectors

`test/domain.test.mjs` pins these values. Keys are derived from 32-byte Ed25519 seeds
`01 02 … 20` (Alice) and `21 22 … 40` (Bob).

| Item | Value |
| --- | --- |
| Alice public key | `MCowBQYDK2VwAyEAebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ` |
| Bob public key | `MCowBQYDK2VwAyEA5_FioQvsVZr-oZXk3OhLaVaNXSywlj60RsBoXisX8vA` |
| Alice fingerprint | `SHA256:646d6be49d9f0048f94f67749eca3515` |
| Genesis (`channel` `github:R_example`, `branch` `main`, accounts 101/202, epoch `00000000-0000-4000-8000-000000000001`) signature | `R67nI_rqWRqt67tNFnGcb5YgStWmH6eXGe71GdbDGVnlbFnDsUK-BpCtO0WwaVV9h3wfHTMEKTHmUnMJfqCWAg` |
| Genesis digest | `a9eb2e9d7bf283dd9d0f06e849b4d1fa9328830e4e216c8f90850eecf58f4787` |
| Create intent digest (event = request = `…0002`, timestamp `1800000000000`, title `Café ☕ review`, body `Line 1\n\t«quoted» \\ "x" 🚀`, ttl 168) | `b6173b74e09b96578d754dfb7330459d6716035b6bd2e0891559814fcfb7380f` |
| Create event signature | `nOmT2QKwNDGDlFeW_mGxuHzLabM7nRGIphdHOzOHGqz8vgf_wf3OHvzgOUyYmuv3-9IXlscrE9PmmsNldQkPAw` |
| Ledger digest after the create | `16ee55614a4d207af9bc05b3d3a8762c01428d61dddd31312bec92d2efdce476` |

These vectors were produced by this implementation (Node.js `crypto` Ed25519). They are
regression vectors for compatible implementations, not an external test suite.

## Versioning

A reader that finds a `version` other than 1 reports "Unsupported mailbox protocol version" and
stops. A future version that changes the transport contract or any rule above will use a new
version number and a new mailbox; there is no in-place migration.
