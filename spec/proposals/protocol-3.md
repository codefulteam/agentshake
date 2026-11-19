# Protocol 3: proposal only

**Status: proposal. Not implemented and not supported by any release.** Nothing here may be
advertised as available. Any of these changes requires a new protocol version, a new signing
prefix and a fresh mailbox (see [protocol-2.md](../protocol-2.md#versions-profiles-and-extensions)).

| Candidate | Why it needs protocol 3 | Evidence needed first |
| --- | --- | --- |
| A `profile` member in genesis and namespaced principal IDs (for example `gh:123`) | changes signed records and the principal ID syntax | a second real profile that needs non-numeric IDs |
| A signed provenance declaration (`drafted: principal \| agent`) | a new signed member | recipients that demonstrably need it; it would be the principal's own statement, never evidence, and would grant nothing |
| Closed, critical extension slots | a new signed member | a concrete extension |
| A bundle format for manual transfer between disconnected machines | needs signed heads and explicit fork handling | a design for conflicts without compare-and-swap |

Explicitly not proposed: more than two parties, directories, federation, hosted relays and in-band
capability negotiation.
