// Regressions for the 0.2.0 scenario-evaluation findings, through the executable (set
// AGENTSHAKE_BIN to test an installed package): copy-paste-safe hints (F1), stale negotiation
// briefs pruned by `drafts` (F2), a `next` hint on every error (F3), role-aware expiry hints (F4).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const bin = process.env.AGENTSHAKE_BIN || resolve('dist/cli.js');

function harness(t) {
  // A root with a space, an apostrophe and non-ASCII characters, as real home directories can have.
  const base = mkdtempSync(join(tmpdir(), 'agentshake-fixes-'));
  const root = join(base, "it's a dïr 작업");
  mkdirSync(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', AGENTSHAKE_HOME: '', EDITOR: '', VISUAL: '' };
  function run(args, { input, expected = 0, clock, json = true } = {}) {
    const result = spawnSync(bin, [...(json ? ['--json'] : []), ...args], { encoding: 'utf8', input, timeout: 20_000,
      env: clock ? { ...env, NODE_OPTIONS: '--import=' + pathToFileURL(clock).href } : env });
    assert.equal(result.status, expected, `${args.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    return { value: json && result.stdout ? JSON.parse(result.stdout) : undefined, error: json && result.status !== 0 && result.stderr ? JSON.parse(result.stderr.trim().split('\n').at(-1)).error : undefined, ...result };
  }
  const profile = user => join(root, user + ' profile');
  const paths = user => ({ inbox: join(root, user + ' ex', 'in'), outbox: join(root, user + ' ex', 'out') });
  const call = (user, args, options) => run(['--profile', profile(user), ...args], options);
  const agent = (user, args, options) => run(['agent', '--inbox', paths(user).inbox, '--outbox', paths(user).outbox, ...args], options);
  const allow = (user, args, options) => {
    const preview = call(user, [...args, '--preview'], options).value;
    return call(user, [...args, '--approve', preview.digest], options).value;
  };
  const mailbox = join(root, "mail box it's ü.sqlite");
  /** Pairs Alice (1) and Bob (2); Bob joins by running Alice's printed hint verbatim through sh. */
  function pair() {
    const a = call('alice', ['key', 'init']).value.publicKey;
    const b = call('bob', ['key', 'init']).value.publicKey;
    const init = call('alice', ['channel', 'init', '--file', mailbox, '--account', '1', '--peer', '2', '--peer-key', b]).value;
    return { ...init, join: () => call('bob', ['channel', 'join', '--file', mailbox, '--account', '2', '--peer', '1', '--peer-key', a]) };
  }
  const offer = (user, kind, title, ttl) => agent(user,
    ['draft', 'new', '--kind', kind, '--title', title, '--body-file', '-', ...(ttl ? ['--ttl-hours', ttl] : [])], { input: 'Body text' }).value.draft;
  return { root, run, call, agent, allow, paths, profile, mailbox, pair, offer, env };
}

/** Runs a printed `agentshake …` hint verbatim through /bin/sh, with the executable substituted. */
function sh(h, hint, home) {
  const command = hint.slice(hint.indexOf('agentshake ') + 'agentshake '.length);
  return spawnSync('/bin/sh', ['-c', `"$AGENTSHAKE_TEST_BIN" --json ${command}`], { encoding: 'utf8', timeout: 20_000,
    env: { ...h.env, AGENTSHAKE_TEST_BIN: bin, AGENTSHAKE_HOME: home ?? '' } });
}

function configure(h) {
  for (const user of ['alice', 'bob']) h.call(user, ['exchange', 'configure', '--inbox', h.paths(user).inbox, '--outbox', h.paths(user).outbox]);
}

test('F1: printed join and agent hints run verbatim with spaces, apostrophes and non-ASCII paths', { timeout: 60_000 }, t => {
  const h = harness(t);
  const init = h.pair();
  const hint = init.next.find(line => line.includes('channel join'));
  assert.match(hint, /--file '/, 'the mailbox path is quoted');
  const joined = sh(h, hint, h.profile('bob'));
  assert.equal(joined.status, 0, joined.stderr);
  assert.equal(JSON.parse(joined.stdout).paired, true);
  const configured = h.call('alice', ['exchange', 'configure', '--inbox', h.paths('alice').inbox, '--outbox', h.paths('alice').outbox]).value;
  const agentHint = [configured.next].flat()[0];
  const listed = sh(h, agentHint);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout), []);
  assert.equal(h.call('bob', ['doctor']).value.ok, true);
});

test('F2: `drafts` prunes stale negotiation briefs and labels stale drafts; --offline and previews do not', { timeout: 60_000 }, t => {
  const h = harness(t);
  const init = h.pair();
  init.join();
  configure(h);
  const request = h.offer('alice', 'review', 'Review');
  h.allow('alice', ['publish', request]);
  h.allow('bob', ['brief', request, '--body-file', '-'], { input: 'Clarify what is missing. No work.' });
  const brief = join(h.paths('bob').inbox, request + '.json');
  const draft = h.agent('bob', ['draft', 'ask', request, '--topic', 'Which branch?', '--need', 'scope']).value.draft;
  assert.equal(h.call('bob', ['drafts']).value[0].stale, false, 'current before the context changes');
  h.allow('alice', ['supply', request, '--note-file', '-'], { input: 'More context.' });
  // A preview never removes a brief, and refuses the stale draft.
  h.call('bob', ['publish', draft, '--preview'], { expected: 4 });
  assert.ok(existsSync(brief), 'preview left the brief');
  const offline = h.call('bob', ['drafts', '--offline']).value;
  assert.equal(offline[0].stale, null);
  assert.ok(existsSync(brief), '--offline does not read the mailbox or prune');
  assert.match(h.call('bob', ['drafts', '--offline'], { json: false }).stdout, /offline: drafts were not checked/);
  const online = h.call('bob', ['drafts']);
  assert.equal(online.value[0].stale, true);
  assert.ok(!existsSync(brief), 'drafts pruned the stale negotiation brief');
  const human = h.call('bob', ['drafts'], { json: false }).stdout;
  assert.match(human, /stale: written for an older context/);
  assert.match(human, /next: For a stale draft/);
  // Unreadable mailbox: an actionable error that names --offline; --offline still lists.
  renameSync(h.mailbox, h.mailbox + '.away');
  const failed = h.call('bob', ['drafts'], { expected: 4 });
  assert.match(failed.error.next, /agentshake drafts --offline/);
  assert.equal(h.call('bob', ['drafts', '--offline']).value.length, 1);
  renameSync(h.mailbox + '.away', h.mailbox);
});

test('F3: every CLI error has a next hint; wrong role, bad input and own-reply completion are specific', { timeout: 90_000 }, async t => {
  const h = harness(t);
  const init = h.pair();
  init.join();
  configure(h);
  const request = h.offer('alice', 'task', 'Task');
  h.allow('alice', ['publish', request]);
  const marker = 'PAYLOAD-MARKER-Ω';
  const cases = [
    ['alice', ['ask', request, '--topic', 't', '--need', 'n', '--preview'], 3, /requester.*agentshake supply/],
    ['alice', ['accept', request, '--body-file', '-', '--preview'], 3, /requester/, 'b'],
    ['alice', ['decline', request, '--preview'], 3, /agentshake cancel/],
    ['bob', ['cancel', request, '--preview'], 3, /recipient.*agentshake decline/],
    ['bob', ['supply', request, '--note-file', '-', '--preview'], 3, /recipient.*agentshake ask/, 'n'],
    ['alice', ['supply', request, '--answers-file', '-', '--preview'], 2, /agentshake supply --help/, `{"answers": [ ${marker}`],
    ['alice', ['supply', request, '--answers-file', join(h.root, 'missing ü.json'), '--preview'], 2, /standard input/],
    ['bob', ['ask', request, '--items-file', '-', '--preview'], 2, /agentshake ask --help/, JSON.stringify(Array.from({ length: 6 }, () => ({ topic: marker, need: 'n' })))],
  ];
  for (const [user, args, code, pattern, input] of cases) {
    const { error } = h.call(user, args, { expected: code, input });
    assert.ok(error.next, `${args[0]} has a next hint`);
    assert.match(error.next, pattern, args.join(' '));
    assert.ok(!error.next.includes(marker), 'user payload is never echoed into a hint');
  }
  // Agent-side errors use the agent command's help.
  const agentError = h.agent('bob', ['draft', 'ask', request, '--context', '0'.repeat(64), '--items-file', '-'], { input: 'not json', expected: 2 }).error;
  assert.match(agentError.next, /agentshake agent draft ask --help/);
  // Human output always prints a next line.
  assert.match(h.call('alice', ['ask', request, '--topic', 't', '--need', 'n', '--preview'], { json: false, expected: 3 }).stderr, /\nnext: /);
  // Own-reply completion.
  h.allow('bob', ['confirm', request, '--understanding-file', '-'], { input: 'u' });
  h.allow('bob', ['accept', request, '--body-file', '-'], { input: 'Do it.' });
  const peerReply = h.agent('alice', ['draft', 'reply', request, '--body-file', '-'], { input: 'Clarification.' }).value.draft;
  h.allow('alice', ['publish', peerReply]);
  const own = h.call('bob', ['complete', request, '--reply', peerReply, '--outcome', 'completed', '--preview'], { expected: 4 }).error;
  assert.match(own.next, /draft reply .*agentshake publish <draft-id>/);
  assert.match(h.call('alice', ['complete', request, '--reply', peerReply, '--outcome', 'completed', '--preview'], { expected: 3 }).error.next, /recipient completes it/);
  // MCP tool errors keep {error, next, exitCode} and always carry next.
  const client = new Client({ name: 'fixes-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [bin, 'agent', '--inbox', h.paths('bob').inbox, '--outbox', h.paths('bob').outbox, 'mcp'], stderr: 'pipe' }));
  try {
    // Bob has no brief for this request yet in this inbox state: an Agentshake error, not a schema error.
    const bad = await client.callTool({ name: 'read_brief', arguments: { request: '00000000-0000-4000-8000-000000000000' } });
    assert.equal(bad.isError, true);
    const value = JSON.parse(bad.content[0].text);
    assert.ok(value.error && value.next && Number.isInteger(value.exitCode), bad.content[0].text);
  } finally { await client.close(); }
  // A local failure (the outbox is missing) also carries a next hint.
  const missing = new Client({ name: 'fixes-test', version: '0.0.0' });
  await missing.connect(new StdioClientTransport({ command: process.execPath,
    args: [bin, 'agent', '--inbox', h.paths('bob').inbox, '--outbox', join(h.root, 'no such outbox'), 'mcp'], stderr: 'pipe' }));
  try {
    const failed = await missing.callTool({ name: 'create_draft', arguments: { draft: { action: 'new', category: 'question', title: 'T', body: 'B' } } });
    assert.equal(failed.isError, true);
    assert.ok(JSON.parse(failed.content[0].text).next, failed.content[0].text);
  } finally { await missing.close(); }
});

test('F4: expiry hints depend on the role; expired drafts stay refused', { timeout: 60_000 }, t => {
  const h = harness(t);
  const init = h.pair();
  init.join();
  configure(h);
  // Alice's clock is two hours behind while she publishes, so the 1h request is expired now.
  const clock = join(h.root, 'past.mjs');
  writeFileSync(clock, 'const now = Date.now.bind(Date); Date.now = () => now() - 7200000;\n');
  const request = h.offer('alice', 'question', 'Will expire', '1');
  h.allow('alice', ['publish', request], { clock });
  const requester = h.call('alice', ['cancel', request, '--preview'], { expected: 4 }).error;
  assert.match(requester.next, /Send a new offer/);
  assert.doesNotMatch(requester.next, /Ask the requester/);
  const recipient = h.call('bob', ['ask', request, '--topic', 't', '--need', 'n', '--preview'], { expected: 4 }).error;
  assert.match(recipient.next, /Ask the requester to send a new one/);
  const inert = h.agent('alice', ['draft', 'supply', request, '--context', '0'.repeat(64), '--note-file', '-'], { input: 'late note' }).value.draft;
  const refused = h.call('alice', ['publish', inert, '--preview'], { expected: 4 }).error;
  assert.match(refused.message, /expired/);
  assert.match(refused.next, /Send a new offer/);
  assert.equal(h.call('alice', ['doctor']).value.events, 1, 'nothing was appended');
});
