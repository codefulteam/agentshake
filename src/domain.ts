// Agentshake protocol domain: strict wire schemas, canonical signing, replay and
// transition rules. Nothing in this file performs I/O.
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import * as z from 'zod';

export const EXIT = { usage: 2, access: 3, conflict: 4, temporary: 5, integrity: 6 } as const;
export type Reason = keyof typeof EXIT;

export class AgentshakeError extends Error {
  readonly code: number;
  constructor(readonly reason: Reason, message: string, readonly next?: string) {
    super(message);
    this.code = EXIT[reason];
  }
}
const fail = (reason: Reason) => (message: string, next?: string): never => {
  throw new AgentshakeError(reason, message, next);
};
export const invalid = fail('usage');
export const access = fail('access');
export const conflict = fail('conflict');
export const temporary = fail('temporary');
export const integrity = fail('integrity');

export const PROTOCOL = 1;
export const MAX_LEDGER = 256 * 1024;
export const MAX_BODY = 4096;
export const MAX_TITLE_CHARS = 120;
export const MAX_TITLE_BYTES = 480;
export const MAX_REQUESTS = 32;
export const MAX_EVENTS = 128;
export const MAX_PER_REQUEST = 32;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const MIN_TTL_HOURS = 1;
export const MAX_TTL_HOURS = 14 * 24;
export const DEFAULT_TTL_HOURS = 7 * 24;
export const MAX_CLOCK_SKEW = 5 * 60_000;
// Reservation sizes. Text forbids C0/C1 controls other than tab and newline, so the
// canonical JSON encoding of a text field is at most twice its UTF-8 byte length.
const EVENT_OVERHEAD = 1024;
const REPLY_RESERVATION = 2 * MAX_BODY + EVENT_OVERHEAD;

export const idSchema = z.uuid({ version: 'v4' });
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const signatureSchema = z.string().regex(/^[\w-]{86}$/)
  .refine(value => Buffer.from(value, 'base64url').toString('base64url') === value);
// eslint-disable-next-line no-control-regex
const FORBIDDEN_BODY = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const wellFormed = (value: string) => Buffer.from(value).toString('utf8') === value;
export const bodySchema = z.string().min(1, 'Body is empty.')
  .refine(wellFormed, 'Body must be valid UTF-8.')
  .refine(value => Buffer.byteLength(value) <= MAX_BODY, `Body exceeds ${MAX_BODY} UTF-8 bytes.`)
  .refine(value => !FORBIDDEN_BODY.test(value), 'Body contains terminal control characters. Only tab and newline are allowed.');
export const titleSchema = z.string().min(1, 'Title is empty.')
  .refine(wellFormed, 'Title must be valid UTF-8.')
  .refine(value => Buffer.byteLength(value) <= MAX_TITLE_BYTES && [...value].length <= MAX_TITLE_CHARS,
    `Title exceeds ${MAX_TITLE_CHARS} characters.`)
  .refine(value => !FORBIDDEN_LINE.test(value), 'Title must be one line without control characters.');
export const publicKeySchema = z.string().regex(/^[\w-]{59}$/);
export const accountSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);
const time = z.int().nonnegative().max(8_640_000_000_000_000 - 15 * DAY);
const actorSchema = z.strictObject({ account: accountSchema, key: publicKeySchema });
export type Actor = z.infer<typeof actorSchema>;
const genesisSchema = z.strictObject({
  version: z.literal(PROTOCOL), epoch: idSchema,
  channel: z.string().min(1).max(200), branch: z.string().min(1).max(250),
  roster: z.tuple([actorSchema, actorSchema]), signature: signatureSchema
});

export const requestKind = z.enum(['question', 'review', 'proposal', 'task']);
export type RequestKind = z.infer<typeof requestKind>;
export const outcomeSchema = z.enum(['completed', 'failed']);
export const ttlSchema = z.int().min(MIN_TTL_HOURS).max(MAX_TTL_HOURS);
export const payloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('create'), to: accountSchema, category: requestKind,
    title: titleSchema, body: bodySchema, ttlHours: ttlSchema }),
  z.strictObject({ kind: z.literal('accept') }),
  z.strictObject({ kind: z.literal('decline') }),
  z.strictObject({ kind: z.literal('cancel') }),
  z.strictObject({ kind: z.literal('reply'), body: bodySchema }),
  z.strictObject({ kind: z.literal('complete'), reply: idSchema, outcome: outcomeSchema })
]);
export type Payload = z.infer<typeof payloadSchema>;
export const intentSchema = z.strictObject({
  version: z.literal(PROTOCOL), epoch: idSchema, actor: accountSchema, event: idSchema,
  request: idSchema, revision: z.int().min(0).max(MAX_PER_REQUEST),
  timestamp: time, payload: payloadSchema
});
export type Intent = z.infer<typeof intentSchema>;
const eventSchema = intentSchema.extend({ previous: digestSchema, signature: signatureSchema });
export type Event = z.infer<typeof eventSchema>;
const ledgerSchema = z.strictObject({ genesis: genesisSchema, events: z.array(eventSchema).max(MAX_EVENTS) });
export type Ledger = z.infer<typeof ledgerSchema>;
export type Genesis = Ledger['genesis'];
export type Key = { publicKey: string; privateKey: string };
export type State = 'pending' | 'accepted' | 'declined' | 'canceled' | 'completed' | 'failed';
export type Status = State | 'expired';
export type Reply = { id: string; actor: string; body: string; at: number };
export type Request = {
  id: string; sender: string; recipient: string; category: RequestKind;
  title: string; body: string; created: number; expires: number; updated: number;
  revision: number; state: State; replies: Reply[]; result?: string;
};
export type Replay = { ledger: Ledger; chain: string[]; requests: Map<string, Request>; receipts: Map<string, Event> };

export function parsed<T>(schema: z.ZodType<T>, value: unknown, label: string, reason: Reason = 'usage'): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  // Only schema-authored messages are surfaced; input values are never echoed.
  const issue = result.error.issues[0];
  const detail = issue && issue.code === 'custom' ? ' ' + issue.message : '';
  throw new AgentshakeError(reason, `Invalid ${label}.${detail}`);
}

/** Deterministic JSON: sorted keys, no whitespace, UTF-8. Only plain data is allowed. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.entries(value).filter(([, part]) => part !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, part]) => JSON.stringify(key) + ':' + canonical(part)).join(',') + '}';
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('Only safe integers are canonical.');
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Unserializable value');
  return encoded;
}
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const fingerprint = (key: string) => 'SHA256:' + sha256(Buffer.from(key, 'base64url')).slice(0, 32);
export const intentDigest = (value: Intent) => sha256(canonical(value));
const live = (request: Request) => request.state === 'pending' || request.state === 'accepted';
export const stateAt = (request: Request, now: number): Status =>
  live(request) && now >= request.expires ? 'expired' : request.state;

export function newKey(): Key {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
}

/** Domain-separated signing input: "agentshake/v1/<domain>\0<canonical JSON>". */
export function signingBytes(domain: 'genesis' | 'event', input: unknown) {
  return Buffer.from(`agentshake/v${PROTOCOL}/${domain}\0${canonical(input)}`, 'utf8');
}

export function assertKey(value: string) {
  parsed(publicKeySchema, value, 'Ed25519 public key');
  try {
    const der = Buffer.from(value, 'base64url');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' ||
        key.export({ type: 'spki', format: 'der' }).toString('base64url') !== value) throw new Error();
    return key;
  } catch { return invalid('Invalid Ed25519 public key.', 'Copy the exact value printed by `agentshake key show`.'); }
}
function assertSigned(domain: 'genesis' | 'event', document: unknown, signature: string, key: string) {
  if (!verify(null, signingBytes(domain, document), assertKey(key), Buffer.from(signature, 'base64url'))) {
    integrity('Signature verification failed.');
  }
}

export function genesis(channel: string, branch: string, account: string, key: Key, peer: Actor, epoch = randomUUID()): Ledger {
  const document = { version: PROTOCOL as 1, epoch, channel, branch,
    roster: [{ account, key: key.publicKey }, peer] as Genesis['roster'] };
  const signature = sign(null, signingBytes('genesis', document), key.privateKey).toString('base64url');
  return { genesis: { ...document, signature }, events: [] };
}

export function decode(raw: string): Replay {
  if (Buffer.byteLength(raw) > MAX_LEDGER) integrity('Mailbox exceeds the ledger byte cap.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return integrity('Mailbox does not contain valid JSON.'); }
  const version = (value as { genesis?: { version?: unknown } } | null)?.genesis?.version;
  if (version !== undefined && version !== PROTOCOL) {
    integrity(`Unsupported mailbox protocol version ${JSON.stringify(version).slice(0, 12)}.`,
      'Upgrade Agentshake on both sides to the same release.');
  }
  const ledger = parsed(ledgerSchema, value, 'mailbox schema', 'integrity');
  if (canonical(ledger) !== raw) integrity('Mailbox is not canonical JSON.');
  return replay(ledger);
}

function replay(ledger: Ledger): Replay {
  const { signature, ...header } = ledger.genesis;
  const [first, second] = header.roster;
  if (first.account === second.account || first.key === second.key) integrity('Mailbox roster must contain two distinct identities.');
  try { assertKey(second.key); assertSigned('genesis', header, signature, first.key); }
  catch { return integrity('Invalid mailbox roster or genesis signature.'); }
  const chain = [sha256(canonical(ledger.genesis))];
  const requests: Replay['requests'] = new Map();
  const receipts: Replay['receipts'] = new Map();
  for (const event of ledger.events) {
    if (event.epoch !== header.epoch || event.previous !== chain.at(-1) || receipts.has(event.event)) {
      integrity('Mailbox chain, epoch or event identity is invalid.');
    }
    const member = header.roster.find(actor => actor.account === event.actor);
    if (!member) return integrity('Event actor is outside the mailbox roster.');
    const { signature: proof, ...document } = event;
    assertSigned('event', document, proof, member.key);
    try { apply(requests, event, header.roster); }
    catch (error) { return integrity(`Invalid signed transition. ${(error as Error).message}`); }
    receipts.set(event.event, event);
    chain.push(sha256(canonical(event)));
  }
  assertCapacity(requests, ledger, 'integrity');
  return { ledger, chain, requests, receipts };
}

function apply(requests: Replay['requests'], event: Intent, roster: Genesis['roster']) {
  const request = requests.get(event.request);
  const payload = event.payload;
  if (payload.kind === 'create') {
    if (request || event.revision !== 0) conflict('Request already exists.');
    if (event.actor === payload.to || !roster.some(actor => actor.account === payload.to)) {
      access('The request must target the paired account.');
    }
    if (requests.size >= MAX_REQUESTS) conflict('Mailbox request cap reached.');
    requests.set(event.request, {
      id: event.request, sender: event.actor, recipient: payload.to, category: payload.category,
      title: payload.title, body: payload.body, created: event.timestamp,
      expires: event.timestamp + payload.ttlHours * HOUR, updated: event.timestamp,
      revision: 1, state: 'pending', replies: []
    });
    return;
  }
  if (!request) return conflict('Unknown request.', 'Run `agentshake inbox` or `agentshake outbox`.');
  if (event.actor !== request.sender && event.actor !== request.recipient) access('Wrong request participant.');
  if (request.revision !== event.revision) {
    conflict('The request changed since this action was prepared.', `Run \`agentshake show ${request.id}\` and decide again.`);
  }
  if (!live(request)) conflict(`The request is already ${request.state}.`);
  if (event.timestamp >= request.expires) conflict('The request has expired.');
  if (event.timestamp < request.updated) conflict('The sender clock is behind the request history.');
  switch (payload.kind) {
    case 'accept':
    case 'decline':
      if (event.actor !== request.recipient) access('Only the recipient can accept or decline.');
      if (request.state !== 'pending') conflict('The request is no longer pending.');
      request.state = payload.kind === 'accept' ? 'accepted' : 'declined';
      break;
    case 'reply':
      if (request.state !== 'accepted') conflict('Replies need an accepted request.');
      request.replies.push({ id: event.event, actor: event.actor, body: payload.body, at: event.timestamp });
      break;
    case 'complete':
      if (event.actor !== request.recipient) access('Only the recipient can complete.');
      if (request.state !== 'accepted' ||
          !request.replies.some(reply => reply.id === payload.reply && reply.actor === event.actor)) {
        conflict('Complete must cite your own reply already published on this accepted request.');
      }
      request.state = payload.outcome;
      request.result = payload.reply;
      break;
    case 'cancel':
      if (event.actor !== request.sender) access('Only the requester can cancel.');
      request.state = 'canceled';
  }
  request.updated = event.timestamp;
  request.revision++;
}

/**
 * Every live request keeps room for its remaining accept, one recipient reply (if none
 * exists yet) and one terminal event. Expiry is not applied here because replay has no
 * trustworthy clock, so expired requests keep their reservation until the mailbox is retired.
 */
export function capacity(requests: Replay['requests'], ledger: Ledger) {
  let reservedEvents = 0;
  let reservedBytes = 0;
  let perRequest = true;
  for (const request of requests.values()) {
    let slots = 0;
    if (live(request)) {
      slots = 1;
      reservedBytes += EVENT_OVERHEAD;
      if (request.state === 'pending') { slots++; reservedBytes += EVENT_OVERHEAD; }
      if (!request.replies.some(reply => reply.actor === request.recipient)) {
        slots++;
        reservedBytes += REPLY_RESERVATION;
      }
    }
    if (request.revision + slots > MAX_PER_REQUEST) perRequest = false;
    reservedEvents += slots;
  }
  const bytes = Buffer.byteLength(canonical(ledger));
  return { perRequest, requests: requests.size, events: ledger.events.length, reservedEvents, bytes, reservedBytes,
    ok: perRequest && requests.size <= MAX_REQUESTS && ledger.events.length + reservedEvents <= MAX_EVENTS &&
      bytes + reservedBytes <= MAX_LEDGER };
}

function assertCapacity(requests: Replay['requests'], ledger: Ledger, reason: Reason) {
  const result = capacity(requests, ledger);
  if (!result.perRequest) throw new AgentshakeError(reason, 'Request event cap reached.',
    'Complete or cancel the request; start a new request for further discussion.');
  if (!result.ok) {
    throw new AgentshakeError(reason, 'Mailbox capacity reached.',
      'Settle or cancel live requests. When full, create a new private mailbox and pair again.');
  }
}

export function append(state: Replay, input: Intent, key: Key, now: number): Ledger {
  const intent = parsed(intentSchema, input, 'operation');
  if (intent.epoch !== state.ledger.genesis.epoch) conflict('Operation belongs to a different mailbox epoch.');
  if (state.receipts.has(intent.event)) conflict('Operation is already recorded.');
  if (intent.timestamp > now + MAX_CLOCK_SKEW) {
    conflict('Operation timestamp is ahead of the local clock.');
  }
  const request = state.requests.get(intent.request);
  if (request && stateAt(request, now) === 'expired') {
    conflict('The request has expired and is closed for new actions.');
  }
  if (intent.payload.kind === 'create' && now >= intent.timestamp + intent.payload.ttlHours * HOUR) {
    conflict('This prepared request expired before it was sent.', 'Create a new draft.');
  }
  const member = state.ledger.genesis.roster.find(actor => actor.account === intent.actor);
  if (member?.key !== key.publicKey) access('Signing key does not match the actor.');
  const document = { ...intent, previous: state.chain.at(-1)! };
  const signature = sign(null, signingBytes('event', document), key.privateKey).toString('base64url');
  const ledger = { genesis: state.ledger.genesis, events: [...state.ledger.events, { ...document, signature }] };
  const requests = structuredClone(state.requests);
  apply(requests, intent, ledger.genesis.roster);
  assertCapacity(requests, ledger, 'conflict');
  return ledger;
}

export function receiptMatches(event: Event, intent: Intent): boolean {
  const { previous: _previous, signature: _signature, ...actual } = event;
  return intentDigest(actual) === intentDigest(intent);
}
