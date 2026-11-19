// Agentshake protocol 2 domain: canonical signing, genesis, replay, capacity and
// append rules. Schemas live in schema.ts, transitions in transitions.ts. No I/O here.
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { AgentshakeError, integrity, invalid, conflict, access, type Reason } from './errors.js';
import { ledgerSchema, intentSchema, parsed, publicKeySchema, PROTOCOL, MAX_LEDGER, MAX_BODY, MAX_EVENTS,
  MAX_PER_REQUEST, MAX_REQUESTS, MAX_CLOCK_SKEW, MAX_UNDERSTANDING, HOUR,
  type Actor, type Event, type Genesis, type Intent, type Ledger } from './schema.js';
import { apply, canonical, currentConfirmation, live, sha256, stateAt, type Requests } from './transitions.js';

export * from './errors.js';
export * from './schema.js';
export { apply, canonical, currentConfirmation, gapsOf, live, offerContext, openAsk, resolvedBy, sha256, stateAt, supplyContext,
  type Context as RequestContext, type Entry, type Reply, type Request, type Requests, type State, type Status } from './transitions.js';

export type Key = { publicKey: string; privateKey: string };
export type Replay = { ledger: Ledger; chain: string[]; requests: Requests; receipts: Map<string, Event> };

export const fingerprint = (key: string) => 'SHA256:' + sha256(Buffer.from(key, 'base64url')).slice(0, 32);
export const intentDigest = (value: Intent) => sha256(canonical(value));

// Reservation sizes. Text forbids C0/C1 controls other than tab and newline, so the
// canonical JSON encoding of a text field is at most twice its UTF-8 byte length.
const EVENT_OVERHEAD = 1024;
const REPLY_RESERVATION = 2 * MAX_BODY + EVENT_OVERHEAD;
const SUPPLY_RESERVATION = 2 * MAX_BODY + 3 * EVENT_OVERHEAD;
const CONFIRM_RESERVATION = 2 * MAX_UNDERSTANDING + 3 * EVENT_OVERHEAD;

export function newKey(): Key {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  };
}

/** Domain-separated signing input: "agentshake/v2/<domain>\0<canonical JSON>". */
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
  const document = { version: PROTOCOL as 2, epoch, channel, branch,
    roster: [{ account, key: key.publicKey }, peer] as Genesis['roster'] };
  const signature = sign(null, signingBytes('genesis', document), key.privateKey).toString('base64url');
  return { genesis: { ...document, signature }, events: [] };
}

/** Protocol 1 mailboxes are never read, rewritten or reinterpreted by this release. */
export const V1_MAILBOX = 'This mailbox holds a protocol 1 ledger (Agentshake 0.1). Agentshake 0.2 speaks protocol 2 only and did not read or change it.';
export const V1_MAILBOX_NEXT = 'Protocol 2 needs a fresh mailbox: a new --file, or on GitHub a v2 ledger ' +
  '(created by `channel init`, preferably in a new private repository). Finish protocol 1 requests with Agentshake 0.1.0.';

export function decode(raw: string): Replay {
  if (Buffer.byteLength(raw) > MAX_LEDGER) integrity('Mailbox exceeds the ledger byte cap.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return integrity('Mailbox does not contain valid JSON.'); }
  const version = (value as { genesis?: { version?: unknown } } | null)?.genesis?.version;
  if (version === 1) invalid(V1_MAILBOX, V1_MAILBOX_NEXT);
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
  const head = canonical(ledger.genesis);
  const chain = [sha256(head)];
  const requests: Requests = new Map();
  const receipts: Replay['receipts'] = new Map();
  // Canonical size of the prefix {"events":[e1,...,en],"genesis":G}, kept incrementally.
  let bytes = Buffer.byteLength('{"events":[],"genesis":' + head + '}');
  for (const [index, event] of ledger.events.entries()) {
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
    const encoded = canonical(event);
    chain.push(sha256(encoded));
    bytes += Buffer.byteLength(encoded) + (index ? 1 : 0);
    // Writers check the reservation before every append; replay holds every prefix to the same rule.
    assertCapacity(requests, { genesis: ledger.genesis, events: ledger.events.slice(0, index + 1) }, 'integrity', bytes);
  }
  assertCapacity(requests, ledger, 'integrity');
  return { ledger, chain, requests, receipts };
}

/**
 * Every live request keeps room to close (one terminal event) and to finish its agreed path:
 * if pending, the answer to an open question round, a confirmation of the current context, the
 * accept, and (pending or accepted) one recipient reply. Expiry is not applied here because
 * replay has no trustworthy clock, so expired requests keep their reservation.
 */
export function capacity(requests: Requests, ledger: Ledger, size?: number) {
  let reservedEvents = 0;
  let reservedBytes = 0;
  let perRequest = true;
  for (const request of requests.values()) {
    let slots = 0;
    const reserve = (bytes: number) => { slots++; reservedBytes += bytes; };
    if (live(request)) {
      reserve(EVENT_OVERHEAD);
      if (request.state === 'pending') {
        reserve(EVENT_OVERHEAD);
        if (request.open) reserve(SUPPLY_RESERVATION);
        if (!currentConfirmation(request)) reserve(CONFIRM_RESERVATION);
      }
      if (!request.replies.some(reply => reply.actor === request.recipient)) reserve(REPLY_RESERVATION);
    }
    if (request.revision + slots > MAX_PER_REQUEST) perRequest = false;
    reservedEvents += slots;
  }
  const bytes = size ?? Buffer.byteLength(canonical(ledger));
  return { perRequest, requests: requests.size, events: ledger.events.length, reservedEvents, bytes, reservedBytes,
    ok: perRequest && requests.size <= MAX_REQUESTS && ledger.events.length + reservedEvents <= MAX_EVENTS &&
      bytes + reservedBytes <= MAX_LEDGER };
}

function assertCapacity(requests: Requests, ledger: Ledger, reason: Reason, size?: number) {
  const result = capacity(requests, ledger, size);
  if (!result.perRequest) throw new AgentshakeError(reason, 'Request event cap reached.',
    'Confirm, accept or close the request; start a new request for further discussion.');
  if (!result.ok) {
    throw new AgentshakeError(reason, 'Mailbox capacity reached.',
      'Settle or cancel live requests. When full, create a new private mailbox and pair again.');
  }
}

/**
 * Every check append() makes, without a key and without signing: the exact transition and the
 * capacity reservation, on a copy, with a placeholder signature of the real length. Used before
 * showing an approval so that a digest is never offered for an action that cannot apply.
 */
export function preflight(state: Replay, input: Intent, now: number) {
  checkIntent(state, input, now, (document) => ({ ...document, signature: 'A'.repeat(86) }));
}

function checkIntent(state: Replay, input: Intent, now: number, seal: (document: Intent & { previous: string }) => Event) {
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
  if (intent.payload.kind === 'offer' && now >= intent.timestamp + intent.payload.ttlHours * HOUR) {
    conflict('This prepared request expired before it was sent.', 'Create a new draft.');
  }
  if (!state.ledger.genesis.roster.some(actor => actor.account === intent.actor)) access('The actor is not in the mailbox roster.');
  const ledger = { genesis: state.ledger.genesis, events: [...state.ledger.events, seal({ ...intent, previous: state.chain.at(-1)! })] };
  const requests = structuredClone(state.requests);
  apply(requests, intent, ledger.genesis.roster);
  assertCapacity(requests, ledger, 'conflict');
  return ledger;
}

export function append(state: Replay, input: Intent, key: Key, now: number): Ledger {
  const member = state.ledger.genesis.roster.find(actor => actor.account === input.actor);
  if (member && member.key !== key.publicKey) access('Signing key does not match the actor.');
  return checkIntent(state, input, now, document =>
    ({ ...document, signature: sign(null, signingBytes('event', document), key.privateKey).toString('base64url') }));
}

export function receiptMatches(event: Event, intent: Intent): boolean {
  const { previous: _previous, signature: _signature, ...actual } = event;
  return intentDigest(actual) === intentDigest(intent);
}
