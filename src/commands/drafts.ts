// Draft commands, registered twice with the same builders: under `agent draft` (agent side) and as the
// operator's `draft` alias, so a human and an agent write the same local-exchange/1 document.
import { Command, Option } from 'commander';
import { AgentshakeError, DEFAULT_TTL_HOURS, digestSchema, invalid, MAX_BODY, MAX_TTL_HOURS, MIN_TTL_HOURS, noteSchema, parsed,
  requestKind, understandingSchema } from '../domain.js';
import { createDraft, inputBody, inputJson, inputText, readBrief, type Brief, type Paths } from '../local.js';
import { answersFileSchema, askFileSchema } from '../negotiate.js';
import { id, type Emit } from './common.js';

/** Where drafts go and which inbox holds the briefs that default their binding. */
export type DraftSide = { paths: () => Paths };

/**
 * The brief the operator released for this request, if one can be used: absence, expiry and an
 * invalid brief are expected and mean "no binding"; other failures (for example permissions) propagate.
 */
function briefBinding(inbox: string, request: string): Brief | undefined {
  try { return readBrief(inbox, request); }
  catch (error) {
    if (error instanceof AgentshakeError) return undefined;
    throw error;
  }
}

export function registerDraftCommands(draft: Command, side: DraftSide, emit: Emit) {
  const outbox = () => side.paths().outbox;
  const contextFor = (request: string, given?: string) => {
    if (given) return parsed(digestSchema, given, 'context digest');
    const brief = briefBinding(side.paths().inbox, request);
    if (!brief || brief.stage !== 'negotiating') {
      return invalid('No negotiation brief for this request.', 'Pass --context <digest>, or ask your operator for a negotiation brief.');
    }
    return brief.context.digest;
  };
  const wrote = (result: { draft: string }) =>
    emit({ data: result, human: `Draft ${result.draft} written. Nothing was sent.`, next: `Operator: agentshake publish ${result.draft}` });

  draft.command('new').description('propose a new request (offer) to the peer')
    .addOption(new Option('--kind <kind>', 'request kind').choices(requestKind.options).makeOptionMandatory())
    .requiredOption('--title <text>', 'one-line title (max 120 characters)')
    .requiredOption('--body-file <path>', 'body file, or - for stdin (max 4096 bytes)')
    .option('--ttl-hours <hours>', `expiry, ${MIN_TTL_HOURS} to ${MAX_TTL_HOURS} hours`, String(DEFAULT_TTL_HOURS))
    .action(async (options: { kind: string; title: string; bodyFile: string; ttlHours: string }) => {
      const ttl = /^\d{1,4}$/.test(options.ttlHours) ? Number(options.ttlHours) : NaN;
      wrote(createDraft(outbox(), { action: 'new', category: options.kind, title: options.title,
        body: await inputBody(options.bodyFile), ttlHours: ttl }));
    });
  draft.command('reply <request>').description('post-accept reply: a result or a clarification that does not change scope')
    .requiredOption('--body-file <path>', 'body file, or - for stdin (max 4096 bytes)')
    .action(async (request: string, options: { bodyFile: string }) => {
      wrote(createDraft(outbox(), { action: 'reply', request: id(request, 'request ID'), body: await inputBody(options.bodyFile) }));
    });
  draft.command('ask <request>').description('recipient: ask for missing context (bound to the negotiation brief\'s context)')
    .option('--topic <text>', 'one missing item').option('--need <text>', 'why it is needed')
    .option('--items-file <path>', 'JSON list of {topic, need} (- for stdin)')
    .option('--context <digest>', 'context digest (default: from your negotiation brief)')
    .action(async (request: string, options: { topic?: string; need?: string; itemsFile?: string; context?: string }) => {
      const target = id(request, 'request ID');
      let items: unknown = [{ topic: options.topic, need: options.need }];
      if (options.itemsFile) {
        const value = parsed(askFileSchema, await inputJson(options.itemsFile), 'questions file');
        items = Array.isArray(value) ? value : value.items;
      } else if (!options.topic || !options.need) invalid('Give --topic and --need, or --items-file.');
      wrote(createDraft(outbox(), { action: 'ask', request: target, context: contextFor(target, options.context), items }));
    });
  draft.command('supply <request>').description('requester: answer the open questions, resolve earlier gaps, or add a note')
    .option('--answers-file <path>', 'JSON {"answers": [{item, status, body?}], "resolutions"?: [{ask, item, body}], "note"?} (- for stdin)')
    .option('--note-file <path>', 'a note when no question round is open (- for stdin)')
    .option('--ask <id>', 'question round answered (default: from your negotiation brief)')
    .option('--context <digest>', 'context for a note (default: from your negotiation brief)')
    .action(async (request: string, options: { answersFile?: string; noteFile?: string; ask?: string; context?: string }) => {
      const target = id(request, 'request ID');
      if (Boolean(options.answersFile) === Boolean(options.noteFile)) invalid('Give exactly one of --answers-file or --note-file.');
      if (options.answersFile) {
        const value = parsed(answersFileSchema, await inputJson(options.answersFile), 'answers file');
        if (!value.answers.length) {
          // Only resolutions (and a note): bound to the context, not to a question round.
          wrote(createDraft(outbox(), { action: 'supply', request: target, context: contextFor(target, options.context), ...value }));
          return;
        }
        const ask = options.ask ?? briefBinding(side.paths().inbox, target)?.open?.ask;
        if (!ask) invalid('No open question round is named in your brief.', 'Pass --ask <id>, or ask your operator for a negotiation brief.');
        wrote(createDraft(outbox(), { action: 'supply', request: target, ask, ...value }));
      } else {
        wrote(createDraft(outbox(), { action: 'supply', request: target, context: contextFor(target, options.context),
          note: await inputText(options.noteFile!, noteSchema, 'note', MAX_BODY) }));
      }
    });
  draft.command('confirm <request>').description('recipient: state its understanding and known limitations of the context')
    .requiredOption('--understanding-file <path>', 'understanding, max 2048 bytes (- for stdin)')
    .option('--context <digest>', 'context digest (default: from your negotiation brief)')
    .action(async (request: string, options: { understandingFile: string; context?: string }) => {
      const target = id(request, 'request ID');
      wrote(createDraft(outbox(), { action: 'confirm', request: target, context: contextFor(target, options.context),
        understanding: await inputText(options.understandingFile, understandingSchema, 'understanding', 2048) }));
    });
  return draft;
}
