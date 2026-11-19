// Protocol 2 request state machine: offer, pre-accept context negotiation (ask, supply,
// confirm), accept bound to a confirmed context, then replies and completion.
// Pure functions over replayed state; no I/O.
import { createHash } from 'node:crypto';
import { access, conflict } from './errors.js';
import { HOUR, MAX_REQUESTS, MAX_SUPPLIES, type Answer, type Gap, type Genesis, type Intent, type Payload,
  type RequestKind, type Resolution } from './schema.js';

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

export type State = 'pending' | 'accepted' | 'declined' | 'canceled' | 'completed' | 'failed';
export type Status = State | 'expired';
export type Reply = { id: string; actor: string; body: string; at: number };
type Item = { topic: string; need: string };
export type Entry =
  | { kind: 'ask'; id: string; actor: string; at: number; context: number; items: Item[]; answered?: string }
  | { kind: 'supply'; id: string; actor: string; at: number; context: number; ask?: string; answers: Answer[]; note?: string;
      resolutions: Resolution[] }
  | { kind: 'confirm'; id: string; actor: string; at: number; context: number; understanding: string; gaps: Gap[] };
export type Context = { revision: number; digest: string };
export type Request = {
  id: string; sender: string; recipient: string; category: RequestKind;
  title: string; body: string; ttlHours: number; created: number; expires: number; updated: number;
  revision: number; state: State;
  /** Current context revision and digest; advanced by every supply. */
  context: Context;
  /** Pre-accept negotiation history in ledger order. */
  negotiation: Entry[];
  /** The open ask (at most one). */
  open?: string;
  /** Latest confirmation; current only when it was made on the current context. */
  confirmation?: string;
  supplies: number;
  accepted?: { confirmation: string; context: string };
  replies: Reply[]; result?: string;
};
export type Requests = Map<string, Request>;

const SCHEME = 'agentshake/v2/context';
export const offerContext = (request: string, offer: Extract<Payload, { kind: 'offer' }>): Context => ({
  revision: 1, digest: sha256(canonical({ scheme: SCHEME, request, revision: 1,
    offer: { to: offer.to, category: offer.category, title: offer.title, body: offer.body, ttlHours: offer.ttlHours } }))
});
export const supplyContext = (request: string, previous: Context, event: string,
    supply: Extract<Payload, { kind: 'supply' }>): Context => ({
  revision: previous.revision + 1, digest: sha256(canonical({ scheme: SCHEME, request, revision: previous.revision + 1,
    previous: previous.digest, supply: { event, ask: supply.ask ?? null, answers: supply.answers, note: supply.note ?? null,
      resolutions: supply.resolutions ?? [] } }))
});

export const live = (request: Request) => request.state === 'pending' || request.state === 'accepted';
export const stateAt = (request: Request, now: number): Status =>
  live(request) && now >= request.expires ? 'expired' : request.state;
export const openAsk = (request: Request) =>
  request.negotiation.find((entry): entry is Extract<Entry, { kind: 'ask' }> => entry.kind === 'ask' && entry.id === request.open);
export const currentConfirmation = (request: Request) => {
  const entry = request.negotiation.find((item): item is Extract<Entry, { kind: 'confirm' }> =>
    item.kind === 'confirm' && item.id === request.confirmation);
  return entry && entry.context === request.context.revision && request.open === undefined ? entry : undefined;
};
/** The supply that explicitly resolved an earlier negative answer, if any. */
export function resolvedBy(request: Request, ask: string, item: number): string | undefined {
  return request.negotiation.find(entry => entry.kind === 'supply' &&
    entry.resolutions.some(resolution => resolution.ask === ask && resolution.item === item))?.id;
}
/**
 * Current known limitations: asked items answered unavailable or withheld that no later supply
 * explicitly resolved, in ledger order. History keeps the original answers.
 */
export function gapsOf(request: Request): Gap[] {
  const gaps: Gap[] = [];
  for (const entry of request.negotiation) {
    if (entry.kind !== 'supply' || !entry.ask) continue;
    for (const answer of entry.answers) {
      if (answer.status !== 'supplied' && !resolvedBy(request, entry.ask, answer.item)) {
        gaps.push({ ask: entry.ask, item: answer.item, status: answer.status });
      }
    }
  }
  return gaps;
}
const sameGaps = (a: readonly Gap[], b: readonly Gap[]) => canonical(a) === canonical(b);
const CLOSED = 'Context negotiation closed at acceptance.';
/** Role-aware guidance for an expired request: only the requester can send a new offer. */
export const expiredNext = (requester: boolean) => requester
  ? 'Send a new offer if it is still needed: your agent drafts it with `agentshake agent ... draft new`, then `agentshake publish <draft-id>`.'
  : 'Ask the requester to send a new one if it is still needed.';
/** How to complete with a reply of your own. */
export const ownReplyNext = (request: string) =>
  `Publish your own reply first (your agent drafts it with \`agentshake agent ... draft reply ${request}\`, then \`agentshake publish <draft-id>\`), ` +
  `then cite its ID from \`agentshake show ${request}\`.`;
const CLOSED_NEXT = 'Use replies for result discussion. To change scope, the requester cancels and sends a new offer.';

export function apply(requests: Requests, event: Intent, roster: Genesis['roster']) {
  const request = requests.get(event.request);
  const payload = event.payload;
  if (payload.kind === 'offer') {
    if (request || event.revision !== 0) conflict('Request already exists.');
    if (event.actor === payload.to || !roster.some(actor => actor.account === payload.to)) {
      access('The request must target the paired account.');
    }
    if (requests.size >= MAX_REQUESTS) conflict('Mailbox request cap reached.');
    requests.set(event.request, {
      id: event.request, sender: event.actor, recipient: payload.to, category: payload.category,
      title: payload.title, body: payload.body, ttlHours: payload.ttlHours, created: event.timestamp,
      expires: event.timestamp + payload.ttlHours * HOUR, updated: event.timestamp,
      revision: 1, state: 'pending', context: offerContext(event.request, payload), negotiation: [], supplies: 0, replies: []
    });
    return;
  }
  if (!request) return conflict('Unknown request.', 'Run `agentshake inbox` or `agentshake outbox`.');
  if (event.actor !== request.sender && event.actor !== request.recipient) access('Wrong request participant.');
  if (request.revision !== event.revision) {
    conflict('The request changed since this action was prepared.', `Run \`agentshake show ${request.id}\` and decide again.`);
  }
  if (!live(request)) conflict(`The request is already ${request.state}.`, `Run \`agentshake show ${request.id}\`.`);
  if (event.timestamp >= request.expires) conflict('The request has expired.', expiredNext(event.actor === request.sender));
  if (event.timestamp < request.updated) conflict('The sender clock is behind the request history.');
  const recipient = event.actor === request.recipient;
  const at = event.timestamp;
  const needsPending = (what: string) => {
    if (request.state === 'accepted') conflict(CLOSED, CLOSED_NEXT);
    if (request.state !== 'pending') conflict(`${what} needs a pending request.`);
  };
  const currentContext = (digest: string) => {
    if (digest !== request.context.digest) {
      conflict('The context changed since this action was prepared.', `Run \`agentshake show ${request.id}\` and review the new context.`);
    }
  };
  switch (payload.kind) {
    case 'ask':
      if (!recipient) access('Only the recipient can ask for missing context.');
      needsPending('Asking');
      currentContext(payload.context);
      if (request.open) conflict('A question round is already open.', 'Wait for the requester to answer it.');
      if (request.supplies >= MAX_SUPPLIES) {
        conflict('The clarification budget for this request is used up.', 'Confirm your understanding of the current context, or decline.');
      }
      request.negotiation.push({ kind: 'ask', id: event.event, actor: event.actor, at, context: request.context.revision,
        items: payload.items });
      request.open = event.event;
      request.confirmation = undefined;
      break;
    case 'supply': {
      if (recipient) access('Only the requester can supply context.');
      needsPending('Supplying context');
      currentContext(payload.context);
      if (request.supplies >= MAX_SUPPLIES) conflict('The clarification budget for this request is used up.');
      const resolutions = payload.resolutions ?? [];
      if (payload.ask === undefined) {
        if (request.open) conflict('Answer the open questions first.', `Run \`agentshake show ${request.id}\`.`);
        if (payload.answers.length || (payload.note === undefined && !resolutions.length)) {
          conflict('A supply without a question round carries a note or resolutions only.');
        }
      } else {
        const ask = openAsk(request);
        if (!ask || ask.id !== payload.ask) {
          conflict('The supply does not answer the open question round of this request.', `Run \`agentshake show ${request.id}\`.`);
        }
        if (payload.answers.length !== ask!.items.length || payload.answers.some((answer, index) => answer.item !== index + 1)) {
          conflict('Answer every open question exactly once, in order.');
        }
      }
      // Resolutions must name distinct, still unresolved negative answers of this request.
      const open = gapsOf(request);
      const seen = new Set<string>();
      for (const resolution of resolutions) {
        const ref = `${resolution.ask}:${resolution.item}`;
        if (seen.has(ref)) conflict('Each unavailable or withheld item can be resolved once per supply.');
        seen.add(ref);
        if (!open.some(gap => gap.ask === resolution.ask && gap.item === resolution.item)) {
          conflict('A resolution must name an unresolved unavailable or withheld item of this request.', `Run \`agentshake show ${request.id}\`.`);
        }
      }
      if (payload.ask !== undefined) {
        openAsk(request)!.answered = event.event;
        request.open = undefined;
      }
      request.context = supplyContext(request.id, request.context, event.event, payload);
      request.supplies++;
      request.negotiation.push({ kind: 'supply', id: event.event, actor: event.actor, at, context: request.context.revision,
        ...(payload.ask ? { ask: payload.ask } : {}), answers: payload.answers, ...(payload.note !== undefined ? { note: payload.note } : {}),
        resolutions });
      request.confirmation = undefined;
      break;
    }
    case 'confirm':
      if (!recipient) access('Only the recipient can confirm its own understanding.');
      needsPending('Confirming');
      currentContext(payload.context);
      if (request.open) conflict('A question round is still open.', 'Wait for the answers, then confirm.');
      if (request.negotiation.some(entry => entry.kind === 'confirm' && entry.context === request.context.revision)) {
        conflict('This context revision is already confirmed.', `Accept or decline: agentshake show ${request.id}`);
      }
      if (!sameGaps(payload.gaps, gapsOf(request))) {
        conflict('The confirmation must list exactly the unavailable and withheld items as known limitations.');
      }
      request.negotiation.push({ kind: 'confirm', id: event.event, actor: event.actor, at, context: request.context.revision,
        understanding: payload.understanding, gaps: payload.gaps });
      request.confirmation = event.event;
      break;
    case 'accept': {
      if (!recipient) access('Only the recipient can accept or decline.');
      if (request.state !== 'pending') conflict('The request is no longer pending.');
      currentContext(payload.context);
      const confirmation = currentConfirmation(request);
      if (!confirmation) {
        conflict('Accept needs a confirmation of the current context.', `Run \`agentshake confirm ${request.id} --understanding-file <file>\`.`);
      }
      if (confirmation!.id !== payload.confirmation) conflict('Accept must cite the current confirmation.');
      request.state = 'accepted';
      request.accepted = { confirmation: payload.confirmation, context: payload.context };
      break;
    }
    case 'decline':
      if (!recipient) access('Only the recipient can accept or decline.');
      if (request.state !== 'pending') conflict('The request is no longer pending.');
      request.state = 'declined';
      break;
    case 'reply':
      if (request.state !== 'accepted') {
        conflict('Replies need an accepted request.', 'Before acceptance, use ask, supply and confirm.');
      }
      request.replies.push({ id: event.event, actor: event.actor, body: payload.body, at });
      break;
    case 'complete':
      if (!recipient) access('Only the recipient can complete.');
      if (request.state !== 'accepted' ||
          !request.replies.some(reply => reply.id === payload.reply && reply.actor === event.actor)) {
        conflict('Complete must cite your own reply already published on this accepted request.', ownReplyNext(request.id));
      }
      request.state = payload.outcome;
      request.result = payload.reply;
      break;
    case 'cancel':
      if (recipient) access('Only the requester can cancel.');
      request.state = 'canceled';
  }
  request.updated = event.timestamp;
  request.revision++;
}
