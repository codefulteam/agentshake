// What this installation supports, built from the protocol constants. Local and static: it grants
// nothing and is never exchanged with a peer.
import * as z from 'zod';
import { DEFAULT_TTL_HOURS, MAX_BODY, MAX_EVENTS, MAX_ITEMS, MAX_LEDGER, MAX_NEED, MAX_PER_REQUEST, MAX_REQUESTS, MAX_SUPPLIES,
  MAX_TITLE_CHARS, MAX_TTL_HOURS, MAX_UNDERSTANDING, MIN_TTL_HOURS, PROTOCOL } from './schema.js';
import { briefStages } from './local.js';
import { VERSION } from './version.js';

/** Stable schema identifiers (RFC 9562 UUIDs in the urn:uuid namespace), one per published schema file. */
export const SCHEMA_IDS = {
  'protocol-2': 'urn:uuid:5e1a8e47-e60e-4632-b1d0-80b6d5a2e130',
  'local-exchange-1': 'urn:uuid:c06bbf19-d787-46f1-ba62-084ff35cd874',
  'capabilities-1': 'urn:uuid:84258535-c575-4913-8e1c-420a939a31d5',
  'validation-1': 'urn:uuid:3dfc5ad8-12f0-4c17-b018-40b9cfc69807',
  'conformance-1': 'urn:uuid:59168adc-f4af-4e5d-a97a-f29e8f8e6d1b'
} as const;

export const OPERATIONS = ['offer', 'ask', 'supply', 'confirm', 'accept', 'decline', 'cancel', 'reply', 'complete'] as const;
export const DRAFT_ACTIONS = ['new', 'reply', 'ask', 'supply', 'confirm'] as const;

const limitsSchema = z.strictObject({
  ledgerBytes: z.int(), requests: z.int(), events: z.int(), eventsPerRequest: z.int(), itemsPerRound: z.int(),
  suppliesPerRequest: z.int(), titleCharacters: z.int(), bodyBytes: z.int(), needBytes: z.int(), understandingBytes: z.int(),
  ttlHours: z.strictObject({ min: z.int(), max: z.int(), default: z.int() })
});
/** Output format; new fields may be added in later 0.x releases, so readers ignore unknown ones. */
export const capabilitiesSchema = z.object({
  format: z.literal('agentshake-capabilities/1'),
  software: z.object({ name: z.literal('agentshake'), version: z.string() }),
  protocols: z.array(z.object({ version: z.int(), status: z.literal('supported'), spec: z.string() })).min(1),
  proposals: z.array(z.object({ version: z.int(), status: z.literal('proposal-not-implemented'), spec: z.string() })),
  profiles: z.array(z.object({ id: z.string(), channelPrefix: z.string(), authenticated: z.boolean(),
    scope: z.enum(['remote-repository', 'single-trusted-machine']) })),
  operations: z.array(z.enum(OPERATIONS)),
  localExchange: z.object({ format: z.literal('local-exchange/1'), draftActions: z.array(z.enum(DRAFT_ACTIONS)),
    briefStages: z.array(z.enum(briefStages)), approval: z.literal('operator-approval-per-signed-event') }),
  limits: limitsSchema,
  schemas: z.array(z.object({ name: z.string(), id: z.string() }))
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export function capabilities(): Capabilities {
  return {
    format: 'agentshake-capabilities/1',
    software: { name: 'agentshake', version: VERSION },
    protocols: [{ version: PROTOCOL, status: 'supported', spec: 'spec/protocol-2.md' }],
    proposals: [{ version: 3, status: 'proposal-not-implemented', spec: 'spec/proposals/protocol-3.md' }],
    profiles: [
      { id: 'github-mailbox/1', channelPrefix: 'github:', authenticated: true, scope: 'remote-repository' },
      { id: 'file-mailbox/1', channelPrefix: 'file:', authenticated: false, scope: 'single-trusted-machine' }
    ],
    operations: [...OPERATIONS],
    localExchange: { format: 'local-exchange/1', draftActions: [...DRAFT_ACTIONS], briefStages: [...briefStages],
      approval: 'operator-approval-per-signed-event' },
    limits: {
      ledgerBytes: MAX_LEDGER, requests: MAX_REQUESTS, events: MAX_EVENTS, eventsPerRequest: MAX_PER_REQUEST,
      itemsPerRound: MAX_ITEMS, suppliesPerRequest: MAX_SUPPLIES, titleCharacters: MAX_TITLE_CHARS, bodyBytes: MAX_BODY,
      needBytes: MAX_NEED, understandingBytes: MAX_UNDERSTANDING,
      ttlHours: { min: MIN_TTL_HOURS, max: MAX_TTL_HOURS, default: DEFAULT_TTL_HOURS }
    },
    schemas: Object.entries(SCHEMA_IDS).map(([name, id]) => ({ name, id }))
  };
}
