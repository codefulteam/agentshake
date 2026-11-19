// Guidance regressions through the executable (set AGENTSHAKE_BIN to test an installed package):
// command-line parser errors under --json, the MCP error contract through the official client,
// and role-aware expiry advice at every entry point (publish of any draft, brief, recovery).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const bin = process.env.AGENTSHAKE_BIN || resolve('dist/cli.js');
const HOUR = 3_600_000;
const REQUESTER = /Send a new offer/;
const RECIPIENT = /Ask the requester to send a new one/;

function harness(t) {
  const base = mkdtempSync(join(tmpdir(), 'agentshake-guidance-'));
  const root = join(base, "it's a dïr 작업");
  mkdirSync(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', AGENTSHAKE_HOME: join(root, 'unused home'), EDITOR: '', VISUAL: '' };
  /** A fixed wall clock for the CLI process (Date.now only), as a file URL safe for NODE_OPTIONS. */
  const clocks = new Map();
  const at = ms => {
    if (!clocks.has(ms)) {
      const file = join(root, `clock-${ms}.mjs`);
      writeFileSync(file, `Date.now = () => ${ms};\n`);
      clocks.set(ms, pathToFileURL(file).href);
    }
    return clocks.get(ms);
  };
  // Test-only fault: the file transport's compare-and-swap UPDATE fails, so an approved operation stays staged.
  const faultFile = join(root, 'drop-write.mjs');
  writeFileSync(faultFile, "import { DatabaseSync } from 'node:sqlite';\nconst prepare = DatabaseSync.prototype.prepare;\n" +
    "DatabaseSync.prototype.prepare = function (sql) { if (/^UPDATE mailbox SET raw/.test(sql)) throw new Error('injected write fault'); return prepare.call(this, sql); };\n");
  const fault = pathToFileURL(faultFile).href;
  function run(args, { input, expected = 0, now, json = true, dropWrite = false } = {}) {
    const imports = [...(now === undefined ? [] : [at(now)]), ...(dropWrite ? [fault] : [])].map(url => '--import=' + url).join(' ');
    const result = spawnSync(bin, [...(json ? ['--json'] : []), ...args], { encoding: 'utf8', input, timeout: 60_000,
      env: imports ? { ...env, NODE_OPTIONS: imports } : env });
    assert.equal(result.status, expected, `${args.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    return { value: json && result.status === 0 && result.stdout ? JSON.parse(result.stdout) : undefined,
      error: json && result.status !== 0 ? JSON.parse(result.stderr.trim().split('\n').at(-1)).error : undefined, ...result };
  }
  const profile = user => join(root, user + ' profile');
  const paths = user => ({ inbox: join(root, user + ' ex', 'in'), outbox: join(root, user + ' ex', 'out') });
  const call = (user, args, options) => run(['--profile', profile(user), ...args], options);
  const agent = (user, args, options) => run(['agent', '--inbox', paths(user).inbox, '--outbox', paths(user).outbox, ...args], options);
  const allow = (user, args, options = {}) => {
    const preview = call(user, [...args, '--preview'], options).value;
    return call(user, [...args, '--approve', preview.digest], options).value;
  };
  const mailbox = join(root, 'mail box.sqlite');
  function pair() {
    const a = call('alice', ['key', 'init']).value.publicKey;
    const b = call('bob', ['key', 'init']).value.publicKey;
    call('alice', ['channel', 'init', '--file', mailbox, '--account', '1', '--peer', '2', '--peer-key', b]);
    call('bob', ['channel', 'join', '--file', mailbox, '--account', '2', '--peer', '1', '--peer-key', a]);
    for (const user of ['alice', 'bob']) call(user, ['exchange', 'configure', '--inbox', paths(user).inbox, '--outbox', paths(user).outbox]);
  }
  return { root, run, call, agent, allow, paths, mailbox, pair, env };
}

test('F3: command-line parser errors under --json use the JSON error envelope with a command-scoped next', { timeout: 60_000 }, t => {
  const h = harness(t);
  const id = '00000000-0000-4000-8000-000000000000';
  const cases = [
    [['ask'], 'A required argument is missing.', /agentshake ask --help/],
    [['frobnicate'], 'Unknown command.', /See the available commands: agentshake --help/],
    [['inbox', '--bogus'], 'Unknown option.', /agentshake inbox --help/],
    [['complete', id, '--reply', id, '--outcome', 'maybe'], 'An option or argument value is not allowed.', /agentshake complete --help/],
    [['agent', 'draft', 'new', '--kind', 'task'], 'A required option is missing.', /agentshake agent draft new --help/],
    [['agent', '--inbox', 'x y', '--outbox', 'z', 'draft', 'new', '--kind', 'rootkit'], 'An option or argument value is not allowed.', /agentshake agent draft new --help/],
    [['--profile'], 'An option is missing its value.', /agentshake --help/],
    [['ask', 'x$(id)', 'extra', 'args'], 'Too many arguments.', /agentshake ask --help/],
    [[], 'No command given.', /agentshake --help/],
  ];
  for (const [args, message, next] of cases) {
    const result = h.run(args, { expected: 2 });
    assert.equal(result.stdout, '', args.join(' '));
    const lines = result.stderr.trim().split('\n');
    assert.equal(lines.length, 1, `exactly one JSON line, no raw parser text: ${result.stderr}`);
    const { error } = JSON.parse(lines[0]);
    assert.deepEqual([error.reason, error.exitCode, error.message], ['usage', 2, message], args.join(' '));
    assert.match(error.next, next, args.join(' '));
    assert.ok(!error.next.includes('$(id)') && !error.next.includes('rootkit'), 'arguments never reach next');
    assert.ok(error.detail === undefined || (typeof error.detail === 'string' && error.detail.length <= 300));
  }
  // Without --json the parser text is unchanged; help and version still succeed with --json.
  assert.match(h.run(['ask'], { json: false, expected: 2 }).stderr, /missing required argument 'request'[\s\S]*run with --help/);
  for (const [args, pattern] of [[['--help'], /Usage: agentshake/], [['ask', '--help'], /Usage: agentshake ask/],
    [['--version'], /^0\.3\.0/], [['help', 'ask'], /Usage: agentshake ask/]]) {
    const ok = h.run(['--json', ...args], { json: false });
    assert.match(ok.stdout, pattern, args.join(' '));
    assert.equal(ok.stderr, '');
  }
});

test('F3 (MCP): application errors carry next; schema rejections keep the SDK result and the schema guides', { timeout: 60_000 }, async t => {
  const h = harness(t);
  mkdirSync(h.paths('bob').inbox, { recursive: true, mode: 0o700 });
  mkdirSync(h.paths('bob').outbox, { recursive: true, mode: 0o700 });
  const client = new Client({ name: 'guidance-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [bin, 'agent', '--inbox', h.paths('bob').inbox, '--outbox', h.paths('bob').outbox, 'mcp'], stderr: 'pipe' }));
  try {
    const { tools } = await client.listTools();
    const read = tools.find(tool => tool.name === 'read_brief');
    assert.match(read.inputSchema.properties.request.description, /UUID.*list_briefs/);
    assert.equal(read.inputSchema.additionalProperties, false, 'the advertised schema is not weakened');
    for (const tool of ['read_brief', 'create_draft']) {
      assert.match(tools.find(entry => entry.name === tool).description, /rejected before the tool runs/);
    }
    const rejected = [
      ['read_brief', { request: 'not-a-uuid' }, /request/],
      ['read_brief', { request: '00000000-0000-4000-8000-000000000000', extra: 1 }, /extra|Unrecognized/i],
      ['create_draft', { draft: 5 }, /draft/],
      ['create_draft', { draft: { action: 'reply', request: 'nope', body: 'b' } }, /request/],
    ];
    for (const [name, args, field] of rejected) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
      const text = result.content[0].text;
      assert.match(text, /^Input validation error: Invalid arguments for tool /, 'standard SDK validation result');
      assert.match(text, field);
    }
    const app = await client.callTool({ name: 'read_brief', arguments: { request: '00000000-0000-4000-8000-000000000000' } });
    assert.equal(app.isError, true);
    const value = JSON.parse(app.content[0].text);
    assert.deepEqual(Object.keys(value).sort(), ['error', 'exitCode', 'next']);
    assert.ok(value.next);
  } finally { await client.close(); }
});

test('F4: role-aware expiry at every entry point; nothing is appended or released after expiry', { timeout: 120_000 }, t => {
  const h = harness(t);
  const T0 = Date.UTC(2031, 0, 1);
  h.pair();
  const offer = (title, now) => {
    const draft = h.agent('alice', ['draft', 'new', '--kind', 'task', '--title', title, '--ttl-hours', '1', '--body-file', '-'], { input: 'Scope' }).value.draft;
    h.allow('alice', ['publish', draft], { now });
    return draft;
  };
  // R1 accepted before expiry; both sides hold reply drafts.
  const r1 = offer('Accepted', T0);
  h.allow('bob', ['confirm', r1, '--understanding-file', '-'], { input: 'u', now: T0 + 1000 });
  h.allow('bob', ['accept', r1, '--body-file', '-'], { input: 'Work brief before expiry', now: T0 + 2000 });
  const aliceReply = h.agent('alice', ['draft', 'reply', r1, '--body-file', '-'], { input: 'Requester clarification' }).value.draft;
  const bobReply = h.agent('bob', ['draft', 'reply', r1, '--body-file', '-'], { input: 'Recipient result' }).value.draft;
  // R2 and R3: an ask and a note approved before expiry whose writes are dropped, so they stay staged.
  const r2 = offer('Ask staged', T0 + 3000);
  const r3 = offer('Note staged', T0 + 4000);
  const askPreview = h.call('bob', ['ask', r2, '--topic', 't', '--need', 'n', '--preview'], { now: T0 + 5000 }).value;
  const askRun = h.call('bob', ['ask', r2, '--topic', 't', '--need', 'n', '--approve', askPreview.digest], { now: T0 + 5000, expected: 5, dropWrite: true });
  const askOp = askRun.stderr.match(/operation ([0-9a-f-]{36})/)[1];
  const notePreview = h.call('alice', ['supply', r3, '--note-file', '-', '--preview'], { input: 'note', now: T0 + 6000 }).value;
  const noteRun = h.call('alice', ['supply', r3, '--note-file', '-', '--approve', notePreview.digest], { input: 'note', now: T0 + 6000, expected: 5, dropWrite: true });
  const noteOp = noteRun.stderr.match(/operation ([0-9a-f-]{36})/)[1];
  assert.equal(h.call('bob', ['pending'], { now: T0 + 7000 }).value.length, 1);
  const events = h.call('alice', ['doctor'], { now: T0 + 7000 }).value.events;
  assert.equal(events, 5, 'three offers, confirm and accept; no staged write landed');
  const bobBrief = join(h.paths('bob').inbox, r1 + '.json');

  // One millisecond before R1's deadline a reply can still be previewed; at the exact deadline it cannot.
  const deadline = T0 + HOUR;
  h.call('bob', ['publish', bobReply, '--preview'], { now: deadline - 1 });
  const cases = [
    ['bob', ['publish', bobReply, '--preview'], RECIPIENT],
    ['alice', ['publish', aliceReply, '--preview'], REQUESTER],
    ['bob', ['brief', r1, '--body-file', '-', '--preview'], RECIPIENT, 'late brief'],
    ['alice', ['brief', r1, '--body-file', '-', '--preview'], REQUESTER, 'late brief'],
  ];
  for (const [user, args, next, input] of cases) {
    const { error } = h.call(user, args, { expected: 4, now: deadline, input });
    assert.match(error.message, /expired/, args.join(' '));
    assert.match(error.next, next, `${user} ${args.join(' ')}`);
  }
  // Recovery of the staged ask (recipient) and note (requester) after their deadlines.
  const late = T0 + 4000 + HOUR;
  const recoveredAsk = h.call('bob', ['recover', askOp], { expected: 4, now: late }).error;
  assert.match(recoveredAsk.message, /expired/);
  assert.match(recoveredAsk.next, RECIPIENT);
  const recoveredNote = h.call('alice', ['recover', noteOp], { expected: 4, now: late }).error;
  assert.match(recoveredNote.message, /expired/);
  assert.match(recoveredNote.next, REQUESTER);
  // Nothing was accepted: no event, no pending staged operation, no brief text released.
  assert.equal(h.call('alice', ['doctor'], { now: late }).value.events, events);
  assert.deepEqual(h.call('bob', ['pending'], { now: late }).value, []);
  assert.deepEqual(h.call('alice', ['pending'], { now: late }).value, []);
  for (const user of ['alice', 'bob']) {
    for (const name of existsSync(h.paths(user).inbox) ? readdirSync(h.paths(user).inbox) : []) {
      assert.doesNotMatch(readFileSync(join(h.paths(user).inbox, name), 'utf8'), /late brief/);
    }
  }
  assert.ok(!existsSync(bobBrief) || !/late brief/.test(readFileSync(bobBrief, 'utf8')));
});
