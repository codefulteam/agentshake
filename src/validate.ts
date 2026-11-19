// Offline document validation. Ledgers go through the single verifier (`inspect`); local documents
// through their own schemas. Expected invalid input is a result, never an exception.
import { currentConfirmation, gapsOf, inspect, MAX_LEDGER, parseResult, type Finding, type Gap, type Replay } from './domain.js';
import { briefSchema, draftSchema, FILE_CAP } from './local.js';
import { capabilitiesSchema } from './capabilities.js';
import type * as z from 'zod';

export const DOCUMENT_KINDS = ['ledger', 'draft', 'brief', 'capabilities'] as const;
export type DocumentKind = typeof DOCUMENT_KINDS[number];

/**
 * Replayed facts of a valid ledger, without any peer prose. Timestamps are not compared with a
 * clock, so a pending or accepted request may already be expired for a live reader.
 */
export type LedgerSummary = {
  protocol: 2; epoch: string; channel: string; branch: string; principals: [string, string]; events: number; head: string;
  liveness: 'not-evaluated';
  requests: {
    id: string; requester: string; recipient: string; category: string; state: string; revision: number;
    context: { revision: number; digest: string }; expires: number; open: string | null; confirmation: string | null;
    accepted: { confirmation: string; context: string } | null; gaps: Gap[];
    negotiation: { kind: string; id: string; actor: string; context: number }[];
    replies: { id: string; actor: string }[]; result: string | null;
  }[];
};

type Failure = Pick<Finding, 'stage' | 'code' | 'reason' | 'message' | 'next' | 'event' | 'path'>;
export type Validation =
  | { format: 'agentshake-validation/1'; as: DocumentKind; valid: true; summary?: LedgerSummary }
  | ({ format: 'agentshake-validation/1'; as: DocumentKind; valid: false } & Failure);

const FORMAT = 'agentshake-validation/1';
const LOCAL: Record<Exclude<DocumentKind, 'ledger'>, [z.ZodType, string]> =
  { draft: [draftSchema, 'draft'], brief: [briefSchema, 'brief'], capabilities: [capabilitiesSchema, 'capabilities'] };

export function summarize({ ledger, chain, requests }: Replay): LedgerSummary {
  const { genesis } = ledger;
  return {
    protocol: 2, epoch: genesis.epoch, channel: genesis.channel, branch: genesis.branch,
    principals: [genesis.roster[0].account, genesis.roster[1].account], events: ledger.events.length, head: chain.at(-1)!,
    liveness: 'not-evaluated',
    requests: [...requests.values()].map(request => ({
      id: request.id, requester: request.sender, recipient: request.recipient, category: request.category, state: request.state,
      revision: request.revision, context: request.context, expires: request.expires, open: request.open ?? null,
      confirmation: currentConfirmation(request)?.id ?? null, accepted: request.accepted ?? null, gaps: gapsOf(request),
      negotiation: request.negotiation.map(entry => ({ kind: entry.kind, id: entry.id, actor: entry.actor, context: entry.context })),
      replies: request.replies.map(reply => ({ id: reply.id, actor: reply.actor })), result: request.result ?? null
    }))
  };
}

function failure(as: DocumentKind, value: Failure): Validation {
  return { format: FORMAT, as, valid: false, ...value };
}

/** The byte limit of each document kind; larger input is reported as `input.size`. */
export const documentLimit = (as: DocumentKind) => as === 'ledger' || as === 'capabilities' ? MAX_LEDGER : FILE_CAP;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Validates a document given as text, or as raw bytes as read from a file (at most limit + 1 bytes
 * are needed). Every defect of the content is a result; this never throws for bad input.
 */
export function validate(input: string | Uint8Array, as: DocumentKind): Validation {
  if (typeof input === 'string') return validateText(input, as);
  const limit = documentLimit(as);
  if (input.length > limit) return failure(as, { stage: 'input', code: 'input.size', reason: as === 'ledger' ? 'integrity' : 'usage',
    message: as === 'ledger' ? 'Mailbox exceeds the ledger byte cap.' : `Input exceeds ${limit} bytes.` });
  let text: string;
  try { text = UTF8.decode(input); }
  catch { return failure(as, { stage: 'input', code: 'input.encoding', reason: as === 'ledger' ? 'integrity' : 'usage',
    message: 'Input is not valid UTF-8.' }); }
  return validateText(text, as);
}

function validateText(raw: string, as: DocumentKind): Validation {
  if (as === 'ledger') {
    const result = inspect(raw);
    if (result.ok) return { format: FORMAT, as, valid: true, summary: summarize(result.replay) };
    const { stage, code, reason, message, next, event, path } = result.finding;
    return failure(as, { stage, code, reason, message, ...(next === undefined ? {} : { next }),
      ...(event === undefined ? {} : { event }), ...(path === undefined ? {} : { path }) });
  }
  const limit = documentLimit(as);
  if (Buffer.byteLength(raw) > limit) return failure(as, { stage: 'input', code: 'input.size', reason: 'usage', message: `Input exceeds ${limit} bytes.` });
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return failure(as, { stage: 'input', code: 'input.json', reason: 'usage', message: 'Input is not valid JSON.' }); }
  const [schema, label] = LOCAL[as];
  const shape = parseResult(schema, value, label);
  return shape.ok ? { format: FORMAT, as, valid: true }
    : failure(as, { stage: 'schema', code: 'schema.invalid', reason: shape.reason, message: shape.message, path: shape.path });
}
