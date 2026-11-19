// Agentshake protocol 2 domain: canonical signing, genesis, replay, capacity and
// append rules. Schemas live in schema.ts, transitions in transitions.ts. No I/O here.
import { createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { AgentshakeError, invalid, access, type Reason } from './errors.js';
import { ledgerSchema, intentSchema, parsed, parseResult, publicKeySchema, PROTOCOL, MAX_LEDGER, MAX_BODY, MAX_EVENTS,
  MAX_PER_REQUEST, MAX_REQUESTS, MAX_CLOCK_SKEW, MAX_UNDERSTANDING, HOUR,
  type Actor, type Event, type Genesis, type Intent, type Ledger } from './schema.js';
import { applyChecked, canonical, currentConfirmation, expiredNext, live, sha256, stateAt, type Requests } from './transitions.js';

export * from './errors.js';
export * from './schema.js';
export { apply, applyChecked, canonical, currentConfirmation, gapsOf, live, offerContext, openAsk, resolvedBy, sha256, stateAt, supplyContext,
  type Context as RequestContext, type Entry, type Refusal, type Transition, type Reply, type Request, type Requests, type State, type Status } from './transitions.js';

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

/**
 * An Ed25519 SubjectPublicKeyInfo whose base64url encoding is exactly `value`, or undefined.
 * The catch is the boundary to Node's key parser, which reports malformed DER only by throwing.
 */
function ed25519Key(value: string) {
  if (!parseResult(publicKeySchema, value, 'Ed25519 public key').ok) return undefined;
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64url'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' && key.export({ type: 'spki', format: 'der' }).toString('base64url') === value
      ? key : undefined;
  } catch { return undefined; }
}
export function assertKey(value: string) {
  parsed(publicKeySchema, value, 'Ed25519 public key');
  return ed25519Key(value) ?? invalid('Invalid Ed25519 public key.', 'Copy the exact value printed by `agentshake key show`.');
}
const signedBy = (domain: 'genesis' | 'event', document: unknown, signature: string, key: ReturnType<typeof createPublicKey>) =>
  verify(null, signingBytes(domain, document), key, Buffer.from(signature, 'base64url'));

export function genesis(channel: string, branch: string, account: string, key: Key, peer: Actor, epoch = randomUUID()): Ledger {
  const document = { version: PROTOCOL as 2, epoch, channel, branch,
    roster: [{ account, key: key.publicKey }, peer] as Genesis['roster'] };
  const signature = sign(null, signingBytes('genesis', document), key.privateKey).toString('base64url');
  return { genesis: { ...document, signature }, events: [] };
}

/** Protocol 1 mailboxes are never read, rewritten or reinterpreted by this release. */
export const V1_MAILBOX = 'This mailbox holds a protocol 1 ledger (Agentshake 0.1). This release speaks protocol 2 only and did not read or change it.';
export const V1_MAILBOX_NEXT = 'Protocol 2 needs a fresh mailbox: a new --file, or on GitHub a v2 ledger ' +
  '(created by `channel init`, preferably in a new private repository). Finish protocol 1 requests with Agentshake 0.1.0.';

/** Validation stages in the order a ledger is checked; the first failing stage is reported. */
export type Stage = 'input' | 'version' | 'schema' | 'canonical' | 'genesis' | 'chain' | 'signature' | 'transition' | 'capacity';
export type FindingCode = 'input.size' | 'input.encoding' | 'input.json' | 'version.retired' | 'version.unsupported' | 'schema.invalid' |
  'canonical.mismatch' | 'genesis.roster' | 'genesis.signature' | 'chain.previous' | 'chain.epoch' | 'chain.duplicate-event' |
  'signature.actor' | 'signature.invalid' | 'transition.role' | 'transition.state' | 'capacity.request' | 'capacity.mailbox';
/**
 * Why a ledger or an intent is refused. `reason`, `message` and `next` are exactly what the throwing
 * adapters raise; `event` is the index of the offending event, `path` a JSON Pointer (never a value).
 */
export type Finding = { stage: Stage; code: FindingCode; reason: Reason; message: string; next?: string; event?: number; path?: string };
export type Inspection = { ok: true; replay: Replay } | { ok: false; finding: Finding };

const finding = (stage: Stage, code: FindingCode, reason: Reason, message: string, extra: Partial<Finding> = {}): Inspection =>
  ({ ok: false, finding: { stage, code, reason, message, ...extra } });
const CHAIN = 'Mailbox chain, epoch or event identity is invalid.';

/**
 * A short rendering of an unvalidated version value. Scalars are truncated; structures are named by
 * type only, so nothing of unbounded depth or size is serialized.
 */
function describeVersion(version: unknown): string {
  if (typeof version === 'number' || typeof version === 'boolean' || version === null) return String(version).slice(0, 12);
  if (typeof version === 'string') return JSON.stringify(version.slice(0, 10)).slice(0, 12);
  return Array.isArray(version) ? '(an array)' : '(an object)';
}

/** Throws the finding the way the existing API always has. */
export function orThrow(result: Inspection): Replay {
  if (result.ok) return result.replay;
  throw new AgentshakeError(result.finding.reason, result.finding.message, result.finding.next);
}

export function decode(raw: string): Replay {
  return orThrow(inspect(raw));
}

/** The single ledger verifier: size, version, schema, canonical bytes, genesis, then every event in order. */
export function inspect(raw: string): Inspection {
  if (Buffer.byteLength(raw) > MAX_LEDGER) return finding('input', 'input.size', 'integrity', 'Mailbox exceeds the ledger byte cap.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return finding('input', 'input.json', 'integrity', 'Mailbox does not contain valid JSON.'); }
  const version = (value as { genesis?: { version?: unknown } } | null)?.genesis?.version;
  if (version === 1) return finding('version', 'version.retired', 'usage', V1_MAILBOX, { next: V1_MAILBOX_NEXT });
  if (version !== undefined && version !== PROTOCOL) {
    return finding('version', 'version.unsupported', 'integrity', `Unsupported mailbox protocol version ${describeVersion(version)}.`,
      { next: 'Upgrade Agentshake on both sides to the same release.' });
  }
  const shape = parseResult(ledgerSchema, value, 'mailbox schema', 'integrity');
  if (!shape.ok) return finding('schema', 'schema.invalid', 'integrity', shape.message, { path: shape.path });
  if (canonical(shape.data) !== raw) return finding('canonical', 'canonical.mismatch', 'integrity', 'Mailbox is not canonical JSON.');
  return replay(shape.data);
}

function replay(ledger: Ledger): Inspection {
  const { signature, ...header } = ledger.genesis;
  const [first, second] = header.roster;
  if (first.account === second.account || first.key === second.key) {
    return finding('genesis', 'genesis.roster', 'integrity', 'Mailbox roster must contain two distinct identities.');
  }
  const creator = ed25519Key(first.key);
  const peer = ed25519Key(second.key);
  if (!creator || !peer) return finding('genesis', 'genesis.roster', 'integrity', 'Invalid mailbox roster or genesis signature.');
  if (!signedBy('genesis', header, signature, creator)) {
    return finding('genesis', 'genesis.signature', 'integrity', 'Invalid mailbox roster or genesis signature.');
  }
  const keys = new Map([[first.account, creator], [second.account, peer]]);
  const head = canonical(ledger.genesis);
  const chain = [sha256(head)];
  const requests: Requests = new Map();
  const receipts: Replay['receipts'] = new Map();
  // Canonical size of the prefix {"events":[e1,...,en],"genesis":G}, kept incrementally.
  let bytes = Buffer.byteLength('{"events":[],"genesis":' + head + '}');
  for (const [index, event] of ledger.events.entries()) {
    const at = { event: index };
    if (event.epoch !== header.epoch) return finding('chain', 'chain.epoch', 'integrity', CHAIN, at);
    if (event.previous !== chain.at(-1)) return finding('chain', 'chain.previous', 'integrity', CHAIN, at);
    if (receipts.has(event.event)) return finding('chain', 'chain.duplicate-event', 'integrity', CHAIN, at);
    const key = keys.get(event.actor);
    if (!key) return finding('signature', 'signature.actor', 'integrity', 'Event actor is outside the mailbox roster.', at);
    const { signature: proof, ...document } = event;
    if (!signedBy('event', document, proof, key)) return finding('signature', 'signature.invalid', 'integrity', 'Signature verification failed.', at);
    const step = applyChecked(requests, event, header.roster);
    if (!step.ok) {
      return finding('transition', step.refusal.reason === 'access' ? 'transition.role' : 'transition.state', 'integrity',
        `Invalid signed transition. ${step.refusal.message}`, at);
    }
    receipts.set(event.event, event);
    const encoded = canonical(event);
    chain.push(sha256(encoded));
    bytes += Buffer.byteLength(encoded) + (index ? 1 : 0);
    // Writers check the reservation before every append; replay holds every prefix to the same rule.
    const full = capacityRefusal(requests, { genesis: ledger.genesis, events: ledger.events.slice(0, index + 1) }, bytes);
    if (full) return finding('capacity', full.code, 'integrity', full.message, { ...at, next: full.next });
  }
  return { ok: true, replay: { ledger, chain, requests, receipts } };
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

function capacityRefusal(requests: Requests, ledger: Ledger, size?: number):
    { code: 'capacity.request' | 'capacity.mailbox'; message: string; next: string } | undefined {
  const result = capacity(requests, ledger, size);
  if (!result.perRequest) {
    return { code: 'capacity.request', message: 'Request event cap reached.',
      next: 'Confirm, accept or close the request; start a new request for further discussion.' };
  }
  if (!result.ok) {
    return { code: 'capacity.mailbox', message: 'Mailbox capacity reached.',
      next: 'Settle or cancel live requests. When full, create a new private mailbox and pair again.' };
  }
  return undefined;
}

export type IntentDecision = { ok: true; ledger: Ledger } | { ok: false; reason: Reason; message: string; next?: string };
const refuse = (reason: Reason, message: string, next?: string): IntentDecision =>
  ({ ok: false, reason, message, ...(next === undefined ? {} : { next }) });

/**
 * Whether `input` can be appended now: the exact transition and the capacity reservation, applied
 * to a copy. `seal` supplies the signature (a real one, or a placeholder of the real length).
 * It is a trusted hook: it runs before the transition check, because capacity is measured on the
 * real encoded event, and its exceptions propagate unchanged. `state` is never mutated: the
 * transition runs on a clone of `state.requests`, and the candidate ledger is a new object.
 */
export function decideIntent(state: Replay, input: Intent, now: number,
    seal: (document: Intent & { previous: string }) => Event): IntentDecision {
  const shape = parseResult(intentSchema, input, 'operation');
  if (!shape.ok) return refuse(shape.reason, shape.message);
  const intent = shape.data;
  if (intent.epoch !== state.ledger.genesis.epoch) return refuse('conflict', 'Operation belongs to a different mailbox epoch.');
  if (state.receipts.has(intent.event)) return refuse('conflict', 'Operation is already recorded.');
  if (intent.timestamp > now + MAX_CLOCK_SKEW) return refuse('conflict', 'Operation timestamp is ahead of the local clock.');
  const request = state.requests.get(intent.request);
  if (request && stateAt(request, now) === 'expired') {
    return refuse('conflict', 'The request has expired and is closed for new actions.', expiredNext(intent.actor === request.sender));
  }
  if (intent.payload.kind === 'offer' && now >= intent.timestamp + intent.payload.ttlHours * HOUR) {
    return refuse('conflict', 'This prepared request expired before it was sent.', 'Create a new draft.');
  }
  if (!state.ledger.genesis.roster.some(actor => actor.account === intent.actor)) return refuse('access', 'The actor is not in the mailbox roster.');
  const ledger = { genesis: state.ledger.genesis, events: [...state.ledger.events, seal({ ...intent, previous: state.chain.at(-1)! })] };
  const requests = structuredClone(state.requests);
  const step = applyChecked(requests, intent, ledger.genesis.roster);
  if (!step.ok) return refuse(step.refusal.reason, step.refusal.message, step.refusal.next);
  const full = capacityRefusal(requests, ledger);
  if (full) return refuse('conflict', full.message, full.next);
  return { ok: true, ledger };
}

function decided(decision: IntentDecision): Ledger {
  if (decision.ok) return decision.ledger;
  throw new AgentshakeError(decision.reason, decision.message, decision.next);
}

/**
 * Every check append() makes, without a key and without signing, on a copy with a placeholder
 * signature of the real length. Used before showing an approval so that a digest is never offered
 * for an action that cannot apply.
 */
export function preflight(state: Replay, input: Intent, now: number) {
  decided(decideIntent(state, input, now, document => ({ ...document, signature: 'A'.repeat(86) })));
}

export function append(state: Replay, input: Intent, key: Key, now: number): Ledger {
  const member = state.ledger.genesis.roster.find(actor => actor.account === input.actor);
  if (member && member.key !== key.publicKey) access('Signing key does not match the actor.');
  return decided(decideIntent(state, input, now, document =>
    ({ ...document, signature: sign(null, signingBytes('event', document), key.privateKey).toString('base64url') })));
}

export function receiptMatches(event: Event, intent: Intent): boolean {
  const { previous: _previous, signature: _signature, ...actual } = event;
  return intentDigest(actual) === intentDigest(intent);
}
