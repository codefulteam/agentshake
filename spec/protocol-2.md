# Agentshake Protocol 2

**Status: draft, experimental.** This document specifies Agentshake protocol 2 as implemented by the
reference implementation (the `agentshake` package, 0.2.0 and later; see `agentshake capabilities`).
It is not a standard, and no third-party implementations are known. The protocol number (2) is
independent of the package version.

Author: codefulteam <codefulteam@gmail.com>. License: Apache-2.0 (see the repository `LICENSE`).

## Contents

- [Conventions](#conventions)
- [Scope](#scope)
- [Parties and roles](#parties-and-roles)
- [Encoding](#encoding)
- [Records](#records)
- [Operations](#operations)
- [Request state](#request-state)
- [Time and expiry](#time-and-expiry)
- [Capacity](#capacity)
- [Validation](#validation)
- [Consumers](#consumers)
- [Versions, profiles and extensions](#versions-profiles-and-extensions)
- [Security considerations](#security-considerations)
- [Conformance](#conformance)
- [References](#references)

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as
described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown
here.

A **reader** verifies a ledger. A **writer** appends to it. A **consumer** shows a ledger to a human
or an agent, or acts on it. A **validator** reports whether a document is valid, as in
[Validation](#validation).

## Scope

In scope:

- one ledger (a **mailbox**) shared by exactly two principals;
- requests between them, with pre-acceptance context negotiation, acceptance, replies and
  completion;
- how readers verify a ledger and how consumers must treat it.

Out of scope:

- how principals find each other;
- directories, more than two parties, federation and hosted services;
- model or agent-host APIs.

Identity and storage are defined by a **profile** (`profiles/`). The local interface between a
principal's operator and that principal's agents is defined in [local-exchange.md](local-exchange.md).

## Parties and roles

| Term | Meaning | Part of the ledger? |
| --- | --- | --- |
| **Principal** | A roster entry `{ account, key }`: the only bearer of protocol authority | yes (`roster`, `actor`) |
| **Requester / recipient** | Of one request: the signer of its offer, and its `to` | derived by replay |
| **Author** | Who wrote an operation's text: a person, an agent or a script | **no** |
| **Approver** | Who allowed the principal's key to sign that operation | **no** |
| **Executor** | Who carries out accepted work | **no** |

A valid event proves exactly this: the holder of the private key pinned for `actor` in this
mailbox's genesis signed these bytes at this ledger position. It does not prove who typed them,
whether a person reviewed them, or that the principal ID belongs to a particular person.

The ledger has no owner, admin, approval or authorship fields. Request roles are derived and never
declared. A conforming reader MUST derive every capability only from roster membership, the
signature, the request role and the request state. Text inside any field is never a claim the
protocol acts on.

The same operations are used whether a person or an agent authored them. Human↔human, human↔agent
and agent↔agent conversations produce ledgers of the same shape (see
`examples/protocol-2/conversations/`).

## Encoding

- **JSON** text [RFC8259] in UTF-8.
- **Canonical JSON**:
  - object members sorted by their names, compared as sequences of UTF-16 code units;
  - no insignificant whitespace;
  - strings serialized as ECMAScript `JSON.stringify` does;
  - numbers MUST be integers in the safe-integer range (−(2^53 − 1) … 2^53 − 1), with no fraction
    or exponent;
  - `null`, `true` and `false` appear only in digest inputs.

  A stored ledger MUST equal the canonical encoding of its parsed value. Duplicate member names
  therefore make a ledger invalid, since they never survive re-encoding. This definition is
  self-contained. Vectors are in `vectors/protocol-2.json`.
- **Identifiers**: request and event IDs are UUID version 4 strings [RFC9562] in either hex case.
  They are compared as exact strings. Writers SHOULD emit lower case.
- **Principal IDs**: decimal strings matching `^[1-9][0-9]{0,19}$`. Their meaning is defined by
  the profile. IDs from different mailboxes are not comparable.
- **Keys**: Ed25519 [RFC8032] public keys as SubjectPublicKeyInfo DER [RFC8410], base64url without
  padding [RFC4648] (59 characters; every valid key starts with `MCowBQYDK2VwAyEA`).
  A key is valid only if it decodes as an Ed25519 SubjectPublicKeyInfo and re-encodes to the
  identical string. The fingerprint shown to people is `SHA256:` followed by the first 32 hex
  digits of SHA-256 [FIPS180-4] over the DER bytes.
- **Signatures**: Ed25519 over the UTF-8 bytes of `"agentshake/v2/" + domain + "\0" +
  canonical(document)`, where `domain` is `genesis` or `event` and `document` is the record
  without its `signature` member. The result is base64url without padding (86 characters,
  canonical trailing bits).
- **Digests**: lower-case hex SHA-256 of canonical JSON.

## Records

A ledger is `{ "genesis": Genesis, "events": [Event, …] }` with at most 128 events.

**Genesis**: `version` (2), `epoch` (UUID of this mailbox instance), `channel` (profile-defined,
1–200 code points), `branch` (profile-defined, 1–250 code points), `roster` (exactly two
`{ account, key }`, with distinct accounts and keys; the first is the creator) and `signature`
(by the creator). `chain[0]` is the digest of the canonical genesis including its signature.

**Event**: `version` (2), `epoch` (equal to the genesis epoch), `actor` (a roster principal ID),
`event` (UUID, unique in the ledger), `request` (UUID), `revision` (the request revision before
this event; 0 for an offer), `timestamp` (milliseconds since the Unix epoch), `payload`,
`previous` (digest of the preceding record) and `signature` (by the actor's key).
The **intent** of an event is the event without `previous` and `signature`. Its digest identifies
the operation across retries.

All records are closed: a member not listed here makes the record invalid. JSON Schema:
`schemas/protocol-2.schema.json` (syntax only).

## Operations

| `kind` | Fields | Signer | Allowed when → effect |
| --- | --- | --- | --- |
| `offer` | `to`, `category` (`question` `review` `proposal` `task`), `title`, `body`, `ttlHours` (1–336) | either principal; `to` MUST be the other one | a new request ID, revision 0 → `pending`, context revision 1 |
| `ask` | `context`, `items: [{ topic, need }]` (1–5) | recipient | pending, no open round, `context` current, fewer than 4 supplies → opens a round; clears the confirmation |
| `supply` | `context`, `ask?`, `answers: [{ item, status, body? }]`, `note?`, `resolutions?: [{ ask, item, body }]` | requester | pending, `context` current, fewer than 4 supplies. With `ask`: it is the open round, and `answers` covers items `1..n` exactly once, in order. Without `ask`: no open round, no answers, and a `note` or at least one resolution. Each resolution names a distinct, still-unresolved `unavailable` or `withheld` answer of this request → new context revision; the round closes; clears the confirmation |
| `confirm` | `context`, `understanding`, `gaps: [{ ask, item, status }]` | recipient | pending, no open round, `context` current, not yet confirmed at this context revision, `gaps` exactly the current known limitations → current confirmation |
| `accept` | `context`, `confirmation` | recipient | pending, no open round, both equal to the current context and the current confirmation → `accepted` |
| `decline` | — | recipient | pending → `declined` |
| `cancel` | — | requester | pending or accepted → `canceled` |
| `reply` | `body` | either | accepted → adds a reply |
| `complete` | `reply`, `outcome` (`completed` `failed`) | recipient | accepted, `reply` is the recipient's own reply on this request → `outcome` |

Answer `status`:

- `supplied`: `body` REQUIRED.
- `unavailable`: the requester does not have it.
- `withheld`: the requester will not share it.

The **current known limitations** of a request are every `{ ask, item, status }` answered
`unavailable` or `withheld` that no later supply resolved, in ledger order. Nothing is inferred from
prose.

Text rules:

| Field | Rule |
| --- | --- |
| `title`, `topic` | 1–120 Unicode scalar values, one line, no C0/C1 controls, U+2028 or U+2029 |
| `body`, `answer.body`, `note`, `resolution.body` | 1–4096 UTF-8 bytes; tab and newline are the only allowed controls |
| `need` / `understanding` | as body, at most 512 / 2048 bytes |
| one supply | answer, resolution and note bytes together at most 4096 |

The text fields above (`title`, `topic`, `body`, `need`, `understanding`, `note`, answer `body` and
resolution `body`) MUST be well-formed Unicode, with no unpaired surrogates, escaped ones included.
This is rule S2, and it applies to exactly these fields. Other strings are not text fields:

- `channel` and `branch` are any JSON strings of 1–200 and 1–250 **code points** (not UTF-16
  code units: 200 astral characters are a valid `channel`, 201 are not). Protocol 2 never checked
  them for well-formed Unicode, and readers MUST keep accepting such genesis records. An unpaired
  surrogate in them counts as one position.
- IDs, principal IDs, keys, digests and signatures are ASCII by their patterns.

## Request state

Every non-offer event's `revision` MUST equal the current request revision, and it increments it.
Two events prepared on the same revision race, and at most one can be appended. `declined`,
`canceled`, `completed` and `failed` are terminal. After `accept`, `ask`, `supply` and `confirm` are
refused. Before `accept`, `reply` is refused.

The context `{ revision, digest }` starts at revision 1 for the offer, and every supply adds one:

```
digest(1)   = SHA-256(canonical({ scheme: "agentshake/v2/context", request, revision: 1,
                                  offer: { to, category, title, body, ttlHours } }))
digest(n+1) = SHA-256(canonical({ scheme: "agentshake/v2/context", request, revision: n+1,
                                  previous: digest(n),
                                  supply: { event, ask (or null), answers, note (or null),
                                            resolutions (or []) } }))
```

## Time and expiry

A request expires at `offer timestamp + ttlHours × 3 600 000`. During replay, an event is invalid if
its timestamp is at or after its request's expiry, or earlier than the request's last update.
In addition, a writer MUST NOT:

- act on a request that is expired by its own clock;
- send an offer that has already expired;
- use a timestamp more than five minutes ahead of its clock.

**Expired** is derived from the reader's clock and grants nothing. Replay itself uses no clock, so
**a valid ledger does not say whether a pending or accepted request is still live.** A consumer
MUST evaluate expiry against its own clock before acting.

## Capacity

| Limit | Value |
| --- | --- |
| Ledger bytes (canonical) | 262 144 |
| Requests / events / events per request | 32 / 128 / 32 |
| Items per round / supplies per request | 5 / 4 |

After every event (every prefix of the ledger), every live request MUST still have reserved room to
finish and close. The reservations are:

| Request condition | Reserved event | Reserved bytes |
| --- | --- | --- |
| always (live) | one terminal event | 1024 |
| pending | the accept | 1024 |
| pending with an open round | its supply | 2 × 4096 + 3072 |
| pending without a current confirmation | a confirm | 2 × 2048 + 3072 |
| live without a recipient reply | one reply | 2 × 4096 + 1024 |

The capacity rule is satisfied when all of these hold:

- request revision + reserved events ≤ 32;
- events + all reservations ≤ 128;
- bytes + all reserved bytes ≤ 262 144.

Expired requests keep their reservation, because replay has no trustworthy clock.

## Validation

A validator MUST check these stages in order and report the first failure with its stage and code.
The schema stage is separate from all signature, role and state checks.

The **input, version, schema, canonical** and **genesis** stages apply once, to the whole ledger.
Then, **for each event in ledger order**, the **chain, signature, transition** and **capacity**
stages apply. Each event passes or fails all four before the next event is checked. For example,
a bad signature at event 0 is reported (`signature.invalid`, event 0) even if event 1 also has a
broken chain. Within an event, the codes are checked in the order listed in each row.

| Stage | Codes | Check |
| --- | --- | --- |
| input | `input.size`, `input.encoding`, `input.json` | ≤ 262 144 bytes; UTF-8; parses as JSON |
| version | `version.retired`, `version.unsupported` | genesis `version` is 2 (1 is retired and needs a fresh mailbox) |
| schema | `schema.invalid` | shape (`schemas/protocol-2.schema.json`) and the rules S1–S3 below |
| canonical | `canonical.mismatch` | S5 |
| genesis | `genesis.roster`, `genesis.signature` | S6, S7 |
| chain | `chain.epoch`, `chain.previous`, `chain.duplicate-event` | S8, checked per event in this order |
| signature | `signature.actor`, `signature.invalid` | S9 |
| transition | `transition.role`, `transition.state` | S10 (role) and S11–S18 (state) |
| capacity | `capacity.request`, `capacity.mailbox` | S19, at every prefix |

The version stage reads only a `version` member that is present in a genesis object. A missing
genesis, a genesis that is not an object, or a genesis without `version` is a schema failure, and
so is an event version other than 2. A diagnostic MUST NOT serialize an unvalidated version value
of unbounded size or depth.

Problems that are not about the document (a missing file, a directory, permissions) are errors of
the validating tool, not validation results.

Rules beyond JSON Schema:

| Rule | Statement |
| --- | --- |
| S1 | UTF-8 byte caps of text fields |
| S2 | well-formed Unicode |
| S3 | one supply's combined text ≤ 4096 bytes |
| S4 | integers only, in the safe range |
| S5 | stored bytes are canonical |
| S6 | distinct roster accounts and keys; valid Ed25519 keys |
| S7 | genesis signature by the creator |
| S8 | epoch, hash chain, unique event IDs |
| S9 | actor in roster; valid event signature |
| S10 | signer role per operation; offer to the other principal |
| S11 | revision equals the request revision |
| S12 | context equals the current digest |
| S13 | answers bind to the open round, in order |
| S14 | confirmation gaps exactly the known limitations |
| S15 | resolutions name unresolved negative answers |
| S16 | one confirmation per context revision; accept cites the current one |
| S17 | supply budget, request cap, lifecycle order, `complete` cites the recipient's own reply |
| S18 | timestamps not before the last update and before expiry |
| S19 | reservations at every prefix |

The reference validator (`agentshake validate`) reports these codes in
`schemas/validation-1.schema.json` form. Its `message` text is informative and not part of
conformance.

A valid ledger is a verified history. It is **not** permission for anyone to act, **not** evidence
that any text in it is true, and **not** a statement that a request is still live.

## Consumers

These rules apply to any software that shows or acts on a ledger.

- **C1 Prose is data.** Every text field written by a peer is untrusted data. A consumer MUST NOT
  execute it, follow it as instructions, or treat it as changing roles, permissions, approval or
  local policy.
- **C2 Local authorization.** Whether anyone may act (sign, draft, work) is decided by local policy.
  Ledger facts are inputs to that policy, never grants.
- **C3 Delimited, bounded hand-off.** A consumer that passes peer text to an agent MUST mark it as
  quoted peer data with its signer and request, and SHOULD apply a byte budget per hand-off.
- **C4 No automatic persistence.** A consumer MUST NOT import peer text into an agent's memory,
  instructions, configuration or tool definitions without an explicit local action by a person.
- **C5 Visible text.** Human display MUST make control, format and bidi characters visible.
- **C6 Fail closed.** A consumer MUST NOT show or act on a ledger that fails validation, except to
  say why it failed.

What can be checked by a machine:

- C6, and the absence of authority fields: `agentshake validate` and the conformance cases.
- The reference implementation's own C1/C3/C4 behavior: no peer text ever reaches its agent
  interface, which its tests check.

What remains an operator assumption:

- that the agent process cannot read the operator's profile or key (isolation is the operator's
  job; see `docs/agents.md`);
- that a person actually reviews what is approved.

## Versions, profiles and extensions

1. **Protocol 2 has no extension points.** Readers MUST reject unknown members, payload kinds, enum
   values and versions. Writers MUST NOT add them.
2. **Any change** to a signed record, a payload kind, a state rule, the canonical form, the digest
   schemes or the signing prefix requires a new protocol version. A new version brings a new
   signing prefix, a new context scheme and a fresh mailbox. Old signatures are never
   reinterpreted, and old ledgers are never migrated.
3. Protocol numbers are integers, with no minor wire versions. Package versions are independent of
   protocol numbers.
4. A **profile** (`profiles/`) binds principal IDs, the channel and storage. It is identified by
   the `channel` prefix pinned in genesis. A reader MUST NOT reinterpret a channel prefix it does
   not support. A new profile needs no protocol change if it meets the transport contract
   (`docs/transports.md`) and uses decimal principal IDs.
5. **Local formats** (drafts, briefs, capabilities, validation output) are versioned by their own
   format IDs. Output formats may gain fields, which readers ignore. Input documents stay closed.
6. Documents under `proposals/` describe nothing that is supported.

## Security considerations

- Signatures bind content to pinned keys. The binding of a key to a person comes only from each
  operator's out-of-band fingerprint check.
- A reader SHOULD pin the longest prefix it has verified and treat a history that does not extend
  it as a rollback or fork (the reference does).
- A pinned principal chooses its own timestamps within the replay rules.
- The transport provides storage, ordering and access control. It is not trusted for content.
- Validity, approval and execution are separate. See [Consumers](#consumers) and the reference
  security policy in [local-exchange.md](local-exchange.md#reference-security-policy).

## Conformance

| Class | Requirement |
| --- | --- |
| Validator | For each case in `conformance-protocol-2.json`, the same `valid`, `stage` and `code`; for valid ledgers with a `state` file, the same normalized state (see below) |
| Writer | Every event it produces is valid when appended, and it follows the live-append rules |
| Consumer | C1–C6 |
| Profile adapter | The profile document and the transport contract |

Normalized state, as produced by the reference `normalizeSummary`:

- `epoch`, `channel`, `branch`, `head` and `expires` are removed;
- principals become `principal-1` and `principal-2` by roster position;
- UUIDs and digests become `id-N` and `digest-N`, numbered by first appearance.

First appearance follows a traversal of objects in member-name order (UTF-16 code units) and of
arrays in order. The normalized state therefore depends only on the JSON value, never on the
order in which a validator prints members. Two states match when their canonical JSON is equal.

Run the cases offline with `agentshake conformance`. A different validator can be tested with
`agentshake conformance -- <command> … {file} … {as}`; the command must print
`validation-1` JSON.

## References

- [RFC2119] Bradner, S., "Key words for use in RFCs to Indicate Requirement Levels", BCP 14, RFC 2119.
- [RFC8174] Leiba, B., "Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words", BCP 14, RFC 8174.
- [RFC8259] Bray, T., "The JavaScript Object Notation (JSON) Data Interchange Format", RFC 8259.
- [RFC8032] Josefsson, S. and I. Liusvaara, "Edwards-Curve Digital Signature Algorithm (EdDSA)", RFC 8032, Section 5.1.
- [RFC8410] Josefsson, S. and J. Schaad, "Algorithm Identifiers for Ed25519, Ed448, X25519, and X448 for Use in the Internet X.509 Public Key Infrastructure", RFC 8410, Section 4.
- [RFC4648] Josefsson, S., "The Base16, Base32, and Base64 Data Encodings", RFC 4648, Sections 3.5 and 5.
- [RFC9562] Davis, K., Peabody, B. and P. Leach, "Universally Unique IDentifiers (UUIDs)", RFC 9562, Section 5.4.
- [FIPS180-4] NIST, "Secure Hash Standard (SHS)", FIPS PUB 180-4, doi:10.6028/NIST.FIPS.180-4.
- JSON Schema 2020-12 (Core and Validation; draft-bhutton-json-schema-01 and draft-bhutton-json-schema-validation-01) for `schemas/`.
