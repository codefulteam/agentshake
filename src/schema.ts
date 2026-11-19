// Protocol 2 wire schemas and limits. Strict objects everywhere: unknown fields are rejected.
import * as z from 'zod';
import { AgentshakeError, type Reason } from './errors.js';

export const PROTOCOL = 2;
export const MAX_LEDGER = 256 * 1024;
export const MAX_BODY = 4096;
export const MAX_TITLE_CHARS = 120;
export const MAX_TITLE_BYTES = 480;
export const MAX_REQUESTS = 32;
export const MAX_EVENTS = 128;
export const MAX_PER_REQUEST = 32;
/** Context negotiation bounds, per request. */
export const MAX_ITEMS = 5;
export const MAX_NEED = 512;
export const MAX_UNDERSTANDING = 2048;
export const MAX_SUPPLY_TEXT = MAX_BODY;
export const MAX_SUPPLIES = 4;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const MIN_TTL_HOURS = 1;
export const MAX_TTL_HOURS = 14 * 24;
export const DEFAULT_TTL_HOURS = 7 * 24;
export const MAX_CLOCK_SKEW = 5 * 60_000;

export const idSchema = z.uuid({ version: 'v4' });
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const signatureSchema = z.string().regex(/^[\w-]{86}$/)
  .refine(value => Buffer.from(value, 'base64url').toString('base64url') === value);
// eslint-disable-next-line no-control-regex
const FORBIDDEN_BODY = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const wellFormed = (value: string) => Buffer.from(value).toString('utf8') === value;
/** Multi-line text: well-formed UTF-8, byte-capped, tab and newline are the only controls. */
export function textSchema(max: number, label: string) {
  return z.string().min(1, `${label} is empty.`)
    .refine(wellFormed, `${label} must be valid UTF-8.`)
    .refine(value => Buffer.byteLength(value) <= max, `${label} exceeds ${max} UTF-8 bytes.`)
    .refine(value => !FORBIDDEN_BODY.test(value), `${label} contains terminal control characters. Only tab and newline are allowed.`);
}
export const bodySchema = textSchema(MAX_BODY, 'Body');
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
export const genesisSchema = z.strictObject({
  version: z.literal(PROTOCOL), epoch: idSchema,
  channel: z.string().min(1).max(200), branch: z.string().min(1).max(250),
  roster: z.tuple([actorSchema, actorSchema]), signature: signatureSchema
});

export const requestKind = z.enum(['question', 'review', 'proposal', 'task']);
export type RequestKind = z.infer<typeof requestKind>;
export const outcomeSchema = z.enum(['completed', 'failed']);
export const answerStatus = z.enum(['supplied', 'unavailable', 'withheld']);
export type AnswerStatus = z.infer<typeof answerStatus>;
export const ttlSchema = z.int().min(MIN_TTL_HOURS).max(MAX_TTL_HOURS);

/** One missing context item the recipient asks for, and why it is needed. */
export const itemSchema = z.strictObject({
  topic: titleSchema, need: textSchema(MAX_NEED, 'Reason (need)')
});
export const itemsSchema = z.array(itemSchema).min(1, 'Ask for at least one item.').max(MAX_ITEMS, `Ask for at most ${MAX_ITEMS} items at once.`);
export const answerSchema = z.strictObject({
  item: z.int().min(1).max(MAX_ITEMS), status: answerStatus, body: textSchema(MAX_BODY, 'Answer').optional()
}).refine(value => value.status !== 'supplied' || value.body !== undefined, 'A supplied answer needs a body.');
export type Answer = z.infer<typeof answerSchema>;
export const answersSchema = z.array(answerSchema).max(MAX_ITEMS);
export const noteSchema = textSchema(MAX_BODY, 'Note');
/**
 * Explicit resolution of an earlier unavailable or withheld answer of the same request: the
 * requester supplies the recovered content in `body`. Nothing is ever inferred from prose.
 */
export const resolutionSchema = z.strictObject({
  ask: idSchema, item: z.int().min(1).max(MAX_ITEMS), body: textSchema(MAX_BODY, 'Resolution evidence')
});
export type Resolution = z.infer<typeof resolutionSchema>;
export const resolutionsSchema = z.array(resolutionSchema).max(MAX_ITEMS, `Resolve at most ${MAX_ITEMS} items at once.`);
export const understandingSchema = textSchema(MAX_UNDERSTANDING, 'Understanding');
/** A known limitation: an asked item the sender answered as unavailable or withheld. */
export const gapSchema = z.strictObject({ ask: idSchema, item: z.int().min(1).max(MAX_ITEMS),
  status: z.enum(['unavailable', 'withheld']) });
export type Gap = z.infer<typeof gapSchema>;
export const gapsSchema = z.array(gapSchema).max(MAX_ITEMS * MAX_SUPPLIES);
export const supplyTextBytes = (answers: readonly Answer[], note?: string, resolutions: readonly Resolution[] = []) =>
  answers.reduce((sum, answer) => sum + (answer.body === undefined ? 0 : Buffer.byteLength(answer.body)), 0) +
  (note === undefined ? 0 : Buffer.byteLength(note)) +
  resolutions.reduce((sum, resolution) => sum + Buffer.byteLength(resolution.body), 0);

export const payloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('offer'), to: accountSchema, category: requestKind,
    title: titleSchema, body: bodySchema, ttlHours: ttlSchema }),
  z.strictObject({ kind: z.literal('ask'), context: digestSchema, items: itemsSchema }),
  z.strictObject({ kind: z.literal('supply'), context: digestSchema, ask: idSchema.optional(),
    answers: answersSchema, note: noteSchema.optional(), resolutions: resolutionsSchema.optional() })
    .refine(value => supplyTextBytes(value.answers, value.note, value.resolutions) <= MAX_SUPPLY_TEXT,
      `Answers, resolutions and note together exceed ${MAX_SUPPLY_TEXT} UTF-8 bytes.`),
  z.strictObject({ kind: z.literal('confirm'), context: digestSchema, understanding: understandingSchema, gaps: gapsSchema }),
  z.strictObject({ kind: z.literal('accept'), context: digestSchema, confirmation: idSchema }),
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
export const eventSchema = intentSchema.extend({ previous: digestSchema, signature: signatureSchema });
export type Event = z.infer<typeof eventSchema>;
export const ledgerSchema = z.strictObject({ genesis: genesisSchema, events: z.array(eventSchema).max(MAX_EVENTS) });
export type Ledger = z.infer<typeof ledgerSchema>;
export type Genesis = Ledger['genesis'];

export type ParseResult<T> = { ok: true; data: T } | { ok: false; reason: Reason; message: string; path: string };

/** Result form of `parsed`. Only schema-authored messages are surfaced; input values are never echoed. */
export function parseResult<T>(schema: z.ZodType<T>, value: unknown, label: string, reason: Reason = 'usage'): ParseResult<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  const issue = result.error.issues[0];
  const detail = issue && issue.code === 'custom' ? ' ' + issue.message
    : issue && issue.code === 'too_big' && typeof issue.message === 'string' && (issue.message.startsWith('Ask') || issue.message.startsWith('Resolve')) ? ' ' + issue.message
    : issue && issue.code === 'too_small' && typeof issue.message === 'string' && issue.message.startsWith('Ask') ? ' ' + issue.message : '';
  const path = (issue?.path ?? []).map(part => '/' + String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('');
  return { ok: false, reason, message: `Invalid ${label}.${detail}`, path };
}

export function parsed<T>(schema: z.ZodType<T>, value: unknown, label: string, reason: Reason = 'usage'): T {
  const result = parseResult(schema, value, label, reason);
  if (result.ok) return result.data;
  throw new AgentshakeError(result.reason, result.message);
}
