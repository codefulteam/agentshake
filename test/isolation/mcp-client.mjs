// Minimal MCP stdio client used by the isolation tests: exercises all three tools.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const [bin, inbox, outbox, request] = process.argv.slice(2);
const client = new Client({ name: 'agentshake-isolation-test', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: bin, args: ['agent', '--inbox', inbox, '--outbox', outbox, 'mcp'],
  env: { PATH: process.env.PATH, HOME: process.env.HOME } }));
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${result.content[0].text}`);
  return JSON.parse(result.content[0].text);
};
const list = await call('list_briefs', {});
if (!list.some(entry => entry.request === request)) throw new Error('brief not listed over MCP');
const brief = await call('read_brief', { request });
const draft = await call('create_draft', { draft: { action: 'reply', request, body: 'Reply written over MCP.' } });
await client.close();
console.log(JSON.stringify({ listed: list.length, body: brief.body, draft: draft.draft }));
