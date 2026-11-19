// Builds negotiation payloads from operator input or agent drafts and checks that what was
// written still matches the request: the open question round and the current context digest.
// Pure functions over the replayed request; the domain re-checks everything on append.
import * as z from 'zod';
import { answersSchema, conflict, currentConfirmation, gapsOf, invalid, itemsSchema, MAX_SUPPLIES, noteSchema, openAsk, parsed,
  resolutionsSchema, understandingSchema, type Answer, type Payload, type Request, type Resolution } from './domain.js';
import type { Draft } from './local.js';

const reBrief = (request: Request) =>
  `Release a fresh brief for the current context (agentshake brief ${request.id} --body-file <file>) and let your agent draft again.`;

function pending(request: Request, what: string) {
  if (request.state === 'accepted') {
    conflict('Context negotiation closed at acceptance.', 'Use replies for result discussion. To change scope, the requester cancels and sends a new offer.');
  }
  if (request.state !== 'pending') conflict(`${what} needs a pending request; this one is ${request.state}.`);
}

export function askPayload(request: Request, items: unknown, context = request.context.digest): Payload {
  pending(request, 'Asking');
  if (context !== request.context.digest) conflict('The context changed since this question was written.', reBrief(request));
  if (request.open) conflict('A question round is already open.', 'Wait for the requester to answer it.');
  if (request.supplies >= MAX_SUPPLIES) {
    conflict('The clarification budget for this request is used up.', `Confirm the current context (agentshake confirm ${request.id}) or decline.`);
  }
  return { kind: 'ask', context, items: parsed(itemsSchema, items, 'questions') };
}

export function supplyPayload(request: Request,
    input: { ask?: string; context?: string; answers?: unknown; note?: string; resolutions?: unknown }): Payload {
  pending(request, 'Supplying context');
  if (request.supplies >= MAX_SUPPLIES) conflict('The clarification budget for this request is used up.', 'The recipient can confirm or decline.');
  const answers: Answer[] = parsed(answersSchema, input.answers ?? [], 'answers');
  const note = input.note === undefined ? undefined : parsed(noteSchema, input.note, 'note');
  const resolutions: Resolution[] = parsed(resolutionsSchema, input.resolutions ?? [], 'resolutions');
  const gaps = gapsOf(request);
  for (const resolution of resolutions) {
    if (!gaps.some(gap => gap.ask === resolution.ask && gap.item === resolution.item)) {
      conflict(`Ask ${resolution.ask} item ${resolution.item} is not an unresolved unavailable or withheld item of this request.`,
        `Run \`agentshake show ${request.id}\` to see the current known limitations.`);
    }
  }
  const extra = { ...(note !== undefined ? { note } : {}), ...(resolutions.length ? { resolutions } : {}) };
  const open = openAsk(request);
  if (answers.length) {
    if (!open) conflict('There is no open question round to answer.', `Add context without answers: agentshake supply ${request.id} --note-file <file>`);
    if (input.ask !== undefined && input.ask !== open!.id) conflict('These answers were written for a different question round.', reBrief(request));
    if (answers.length !== open!.items.length || answers.some((answer, index) => answer.item !== index + 1)) {
      invalid(`Answer every open question exactly once, in order: items 1 to ${open!.items.length}.`);
    }
    return { kind: 'supply', context: request.context.digest, ask: open!.id, answers, ...extra };
  }
  if (open) conflict('Answer the open questions first.', `Run \`agentshake show ${request.id}\` and answer with --answers-file.`);
  if (input.ask !== undefined) conflict('This question round is no longer open.', reBrief(request));
  if (note === undefined && !resolutions.length) invalid('Supply answers or resolutions (--answers-file) or a note (--note-file).');
  const context = input.context ?? request.context.digest;
  if (context !== request.context.digest) conflict('The context changed since this was written.', reBrief(request));
  return { kind: 'supply', context, answers: [], ...extra };
}

export function confirmPayload(request: Request, understanding: unknown, context = request.context.digest): Payload {
  pending(request, 'Confirming');
  if (context !== request.context.digest) conflict('The context changed since this understanding was written.', reBrief(request));
  if (request.open) conflict('A question round is still open.', 'Wait for the answers, then confirm.');
  if (request.negotiation.some(entry => entry.kind === 'confirm' && entry.context === request.context.revision)) {
    conflict('You already confirmed this context revision.', `Accept or decline: agentshake show ${request.id}`);
  }
  return { kind: 'confirm', context, understanding: parsed(understandingSchema, understanding, 'understanding'), gaps: gapsOf(request) };
}

export function acceptPayload(request: Request): Payload {
  if (request.state !== 'pending') conflict(`The request is ${request.state}, not pending.`);
  const confirmation = currentConfirmation(request);
  if (!confirmation) {
    conflict(request.open ? 'A question round is still open; accept needs answers and a confirmation.'
      : 'Accept needs your confirmation of the current context first.',
    request.open ? 'Wait for the answers, then confirm.' : `agentshake confirm ${request.id} --understanding-file <file>`);
  }
  return { kind: 'accept', context: request.context.digest, confirmation: confirmation!.id };
}

/** Converts an agent draft for an existing request into its payload, rejecting stale bindings. */
export function draftPayload(request: Request, draft: Exclude<Draft, { action: 'new' }>): Payload {
  switch (draft.action) {
    case 'reply': return { kind: 'reply', body: draft.body };
    case 'ask': return askPayload(request, draft.items, draft.context);
    case 'supply': return supplyPayload(request, draft);
    case 'confirm': return confirmPayload(request, draft.understanding, draft.context);
  }
}

/** Operator file formats. */
export const askFileSchema = z.union([itemsSchema, z.strictObject({ items: itemsSchema })]);
export const answersFileSchema = z.strictObject({ answers: answersSchema.default([]), note: noteSchema.optional(),
  resolutions: resolutionsSchema.optional() });
