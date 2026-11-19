# Local exchange 1: drafts, briefs and the reference security policy

**Status: draft, experimental.** This is the local binding between one principal's operator and
that principal's agents, as implemented by the reference CLI and MCP server. It is not part of the
ledger. Implementations that claim the `local-exchange/1` format MUST accept and reject the
documents in `examples/local-exchange-1/` the same way as `schemas/local-exchange-1.schema.json`
does, together with rule S3 of [protocol-2.md](protocol-2.md#validation). Everything under
[Reference security policy](#reference-security-policy) is the reference implementation's policy,
not a protocol requirement.

## One operation set, two ways to write it

| Operation | Operator command | Draft `action` (agent shell, MCP `create_draft`, or operator `agentshake draft`) |
| --- | --- | --- |
| offer | `agentshake draft new …`, then `publish` | `new` |
| ask | `agentshake ask <request>` | `ask` |
| supply | `agentshake supply <request>` | `supply` |
| confirm | `agentshake confirm <request>` | `confirm` |
| accept | `agentshake accept <request>` | — |
| decline | `agentshake decline <request>` | — |
| cancel | `agentshake cancel <request>` | — |
| reply | `agentshake draft reply …`, then `publish` | `reply` |
| complete | `agentshake complete <request>` | — |

A person writing a draft with `agentshake draft …` produces the same document an agent produces with
`agentshake agent … draft …` or MCP `create_draft`. `publish` treats them the same way. The draft
action `new` maps to the wire operation `offer`.

## Documents

- **Draft**: an unsent proposal in the outbox (`<outbox>/<draft-id>.json`). It has exactly the
  fields of one action. It carries no authority: it has no signer, no approval and no role fields,
  and any such field makes it invalid. `ask` and `confirm` drafts name the context digest they were
  written for. A `supply` draft names either the open round (`ask`) or a context, never both.
- **Brief**: written by the operator's tool into the inbox (`<inbox>/<request>.json`); it is never
  written by an agent. Stage `negotiating` means `authorizesWork: false`: clarify only. Stages
  `accepted` and `finished` authorize the work that the operator's own `body` describes. A brief
  carries binding metadata (context, open round, gaps by reference). In the reference
  implementation it never contains peer text that the operator did not type.

## Discovery

`agentshake capabilities --json`, `agentshake agent capabilities --json` and the MCP tool
`get_capabilities` print the same `capabilities-1` document:

- the supported protocol versions;
- the profiles, with whether each one authenticates and its scope;
- the operations and the draft actions;
- the limits and the schema IDs.

It is static local information. It grants nothing and is never sent to a peer.

## Reference security policy

The reference implementation enforces the following. Other implementations MAY choose differently,
but they MUST NOT describe a different policy as this one.

1. Every signed event requires a local approval step bound to a digest of the exact action: an
   interactive "yes" on the controlling terminal, or `--preview` followed by `--approve <digest>`.
   A peer cannot tell whether a person performed this step.
2. Agents can only propose `new`, `reply`, `ask`, `supply` and `confirm`. Accept, decline, cancel
   and complete are operator commands, with no draft form.
3. The agent interface (shell and MCP) can reach only the inbox and the outbox: it has no profile,
   no key and no network.
4. Peer text is shown to the operator with escaping and never reaches the agent.
5. Isolating the agent process is the operator's responsibility. Two setups are verified by
   scripts; see `docs/agents.md`.
