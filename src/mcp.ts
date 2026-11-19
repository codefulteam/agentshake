// Local agent MCP server (stdio). It reads operator-released briefs and writes unsent
// drafts. It has no network access, no profile access and no mailbox access.
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
    instructions: 'Agentshake local exchange. list_briefs/read_brief return work your human operator approved. ' +
      'create_draft writes an unsent draft; nothing leaves this machine until the operator runs `agentshake publish`.'
  });
  server.registerTool('list_briefs', {
    description: 'List briefs approved by the local operator (request ID, role, kind, expiry). Does not contact any server.',
    inputSchema: z.strictObject({})
  }, () => localAction(() => listBriefs(paths.inbox)));
  server.registerTool('read_brief', {
    description: 'Read one operator-authored brief by request ID. The brief is the full scope of approved work.',
    inputSchema: z.strictObject({ request: idSchema })
  }, ({ request }) => localAction(() => readBrief(paths.inbox, request)));
  server.registerTool('create_draft', {
    description: 'Write an unsent draft to the local outbox. Use action "reply" with a request ID to answer a brief, ' +
      'or action "new" with category (question|review|proposal|task), title and body to propose a new request. ' +
      'Returns a draft ID for the operator to review and publish.',
    inputSchema: z.strictObject({ draft: draftSchema })
  }, ({ draft }) => localAction(() => createDraft(paths.outbox, draft)));
  await server.connect(new StdioServerTransport());
}
