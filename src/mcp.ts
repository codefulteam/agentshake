// Local agent MCP server (stdio). It reads operator-released briefs and writes unsent
// drafts. It has no network access, no profile access and no mailbox access, so it never
// returns remote text: only what the local operator wrote, plus binding metadata.
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod';
import { AgentshakeError, idSchema } from './domain.js';
import { createDraft, draftSchema, listBriefs, readBrief, type Paths } from './local.js';
import { VERSION } from './version.js';

function response(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError };
}

function localAction(action: () => unknown) {
  try { return response(action()); }
  catch (error) {
    // Agentshake messages are fixed strings authored here; other errors are summarized.
    if (error instanceof AgentshakeError) return response({ error: error.message, next: error.next, exitCode: error.code }, true);
    return response({ error: 'Local exchange operation failed. Check the ID, input and mounted paths.' }, true);
  }
}

export async function serve(paths: Paths) {
  const server = new McpServer({ name: 'agentshake-local', version: VERSION }, {
    instructions: 'Agentshake local exchange. list_briefs/read_brief return briefs your human operator wrote. ' +
      'A brief with stage "negotiating" (authorizesWork: false) is NOT approved work: do not start the task; help your ' +
      'operator clarify. As recipient, draft "ask" (missing items and why) or "confirm" (your understanding and known ' +
      'limitations) for the brief\'s context digest. As requester, draft "supply" answers for the brief\'s open question ' +
      'round (status supplied, unavailable or withheld; unavailable and withheld are not evidence) and resolve a listed gap ' +
      'only with the actual recovered content. Only a brief with ' +
      'stage "accepted" is approved work; reply drafts are for its results. Nothing leaves this machine until the operator ' +
      'runs `agentshake publish`.'
  });
  server.registerTool('list_briefs', {
    description: 'List briefs approved by the local operator (request ID, role, kind, stage, context, expiry). Does not contact any server.',
    inputSchema: z.strictObject({})
  }, () => localAction(() => listBriefs(paths.inbox)));
  server.registerTool('read_brief', {
    description: 'Read one operator-authored brief by request ID. stage "negotiating" means clarify only; "accepted" is the full scope of approved work.',
    inputSchema: z.strictObject({ request: idSchema })
  }, ({ request }) => localAction(() => readBrief(paths.inbox, request)));
  server.registerTool('create_draft', {
    description: 'Write an unsent draft to the local outbox. Actions: "new" (category, title, body, ttlHours?) proposes a request; ' +
      '"ask" (request, context, items: [{topic, need}]) and "confirm" (request, context, understanding) are recipient negotiation ' +
      'drafts bound to the context digest from the brief; "supply" (request, ask, answers: [{item, status, body?}], note?) answers ' +
      'the brief\'s open round, or (request, context, note?, resolutions?) adds context; resolutions [{ask, item, body}] resolve ' +
      'earlier unavailable or withheld items listed in the brief\'s gaps with the recovered content; "reply" (request, body) is a post-accept result. ' +
      'Returns a draft ID for the operator to review and publish.',
    inputSchema: z.strictObject({ draft: draftSchema })
  }, ({ draft }) => localAction(() => createDraft(paths.outbox, draft)));
  await server.connect(new StdioServerTransport());
}
