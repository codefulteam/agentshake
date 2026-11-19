// GitHub adapter wiring through the real CLI, against test/fixtures/fake-gh.mjs.
// Proves argv, static GraphQL documents, expected-head conflicts, error classification
// and recovery. It does not prove live GitHub behavior (see docs/transports.md).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const bin = process.env.AGENTSHAKE_BIN || resolve('dist/cli.js');
const fake = resolve('test/fixtures/fake-gh.mjs');
const LEDGER = 'agentshake-mailbox-v2.json';
const V1_LEDGER = 'agentshake-mailbox-v1.json';
const V1_TEXT = '{"genesis":{"version":1}}';

function world(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentshake-gh-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ghBin = join(root, 'gh-bin');
  mkdirSync(ghBin);
  writeFileSync(join(ghBin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(join(ghBin, 'gh'), 0o755);
  const nodeOnly = join(root, 'node-only');
  mkdirSync(nodeOnly);
  symlinkSync(process.execPath, join(nodeOnly, 'node'));
  const statePath = join(root, 'github-state.json');
  const save = state => writeFileSync(statePath, JSON.stringify(state));
  const load = () => JSON.parse(readFileSync(statePath, 'utf8'));
  save({ users: { alice: 101, bob: 202, carol: 303 }, faults: [], log: [], repos: {
    'alice/mailbox': { id: 'R_mailbox1', private: true, branchId: 'BR_main1', branch: 'main', access: [101, 202], writers: [101, 202],
      // A protocol 1 ledger from Agentshake 0.1 in the same repository must stay untouched.
      commits: [{ oid: 'a'.repeat(40), files: { 'README.md': 'private mailbox', [V1_LEDGER]: V1_TEXT } }] } } });
  const configs = {};
  for (const [name, id] of [['alice', 101], ['bob', 202], ['carol', 303]]) {
    const dir = join(root, 'gh-' + name);
    mkdirSync(dir);
    writeFileSync(join(dir, 'viewer.json'), JSON.stringify({ id, login: name }));
    writeFileSync(join(dir, 'state-path'), statePath);
    configs[name] = dir;
  }
  const env = (profile, gh, extra = {}) => ({ ...process.env, PATH: `${ghBin}:${process.env.PATH}`,
    GH_CONFIG_DIR: configs[gh], AGENTSHAKE_HOME: join(root, 'profile-' + profile), ...extra });
  function run(profile, args, { expected = 0, input, gh = profile, extra } = {}) {
    const result = spawnSync(bin, ['--json', ...args], { encoding: 'utf8', input, timeout: 30_000, env: env(profile, gh, extra) });
    assert.equal(result.status, expected, `${profile}: ${args.join(' ')}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.ok(!/gh:|Bad credentials|rate limit exceeded|Could not resolve/.test(result.stderr), 'raw gh diagnostics must not leak');
    return { value: result.stdout ? JSON.parse(result.stdout) : undefined, stderr: result.stderr };
  }
  function runAsync(profile, args) {
    return new Promise(done => {
      const child = spawn(bin, ['--json', ...args], { env: env(profile, profile) });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', code => done({ code, stdout, stderr }));
    });
  }
  const call = (...a) => run(...a).value;
  const agent = (who, args, options) => run(who, ['agent', '--inbox', join(root, who + '-in'), '--outbox', join(root, who + '-out'), ...args], options).value;
  const approve = (who, args, options = {}) => {
    const { digest } = call(who, [...args, '--preview'], options);
    return call(who, [...args, '--approve', digest], options);
  };
  const fault = (...faults) => { const s = load(); s.faults.push(...faults); save(s); };
  const ledger = () => {
    const repo = load().repos['alice/mailbox'];
    return JSON.parse(repo.commits.at(-1).files[LEDGER]);
  };
  return { root, run, runAsync, call, agent, approve, fault, load, save, ledger, nodeOnly, configs, env };
}

test('GitHub adapter: pairing, identity checks, full lifecycle, conflicts, faults and recovery', { timeout: 180_000 }, async t => {
  const w = world(t);
  const { call, run, agent, approve, fault, load, save, ledger } = w;
  const aliceKey = call('alice', ['key', 'init']).publicKey;
  const bobKey = call('bob', ['key', 'init']).publicKey;
  call('alice2', ['key', 'init']);

  // Pairing by login; init writes exactly one file with a generic headline.
  const init = call('alice', ['channel', 'init', '--repo', 'alice/mailbox', '--peer', 'bob', '--peer-key', bobKey]);
  assert.equal(init.peer, '202');
  assert.equal(init.peerLabel, 'bob');
  assert.equal(init.channel, 'github:R_mailbox1');
  assert.match(init.next[0], /channel join --repo alice\/mailbox --peer alice --peer-key/);
  const commits = Object.values(load().commitsBy);
  assert.deepEqual(commits.map(c => [c.headline, c.paths]), [['Update Agentshake mailbox', [LEDGER]]]);
  run('alice2', ['channel', 'init', '--repo', 'alice/mailbox', '--peer', 'bob', '--peer-key', bobKey], { gh: 'alice', expected: 4 });
  run('alice', ['channel', 'init', '--repo', 'alice/mailbox', '--peer', 'nobody-here', '--peer-key', bobKey], { expected: 2 });

  // Join fails closed on a wrong key, then succeeds with the verified key.
  run('bob', ['channel', 'join', '--repo', 'alice/mailbox', '--peer', 'alice', '--peer-key', bobKey], { expected: 2 });
  const wrongKey = call('carol', ['key', 'init']).publicKey;
  run('bob', ['channel', 'join', '--repo', 'alice/mailbox', '--peer', 'alice', '--peer-key', wrongKey], { expected: 3 });
  run('carol', ['channel', 'join', '--repo', 'alice/mailbox', '--peer', 'alice', '--peer-key', aliceKey], { expected: 3 });
  call('bob', ['channel', 'join', '--repo', 'alice/mailbox', '--peer', 'alice', '--peer-key', aliceKey]);
  assert.equal(call('bob', ['doctor']).accountLabel, 'bob');
  for (const who of ['alice', 'bob']) call(who, ['exchange', 'configure', '--inbox', join(w.root, who + '-in'), '--outbox', join(w.root, who + '-out')]);

  // Wrong active gh account and a public repository are refused.
  run('bob', ['doctor'], { gh: 'alice', expected: 3 });
  let s = load(); s.repos['alice/mailbox'].private = false; save(s);
  run('bob', ['inbox'], { expected: 3 });
  s = load(); s.repos['alice/mailbox'].private = true; save(s);

  // Lifecycle over the GitHub adapter, including the pre-accept handshake.
  const request = agent('alice', ['draft', 'new', '--kind', 'question', '--title', 'Flaky test?', '--body-file', '-'], { input: 'Why does retry.test fail?' }).draft;
  approve('alice', ['publish', request]);
  assert.equal(call('bob', ['inbox'])[0].id, request);
  approve('bob', ['ask', request, '--topic', 'Which CI job?', '--need', 'To reproduce the failure.']);
  approve('alice', ['supply', request, '--answers-file', '-'], { input: '{"answers":[{"item":1,"status":"unavailable","body":"Logs expired."}]}' });
  approve('bob', ['confirm', request, '--understanding-file', '-'], { input: 'Investigate retry.test locally; no CI logs.' });
  writeFileSync(join(w.root, 'brief.txt'), 'Investigate retry.test only.');
  assert.equal(approve('bob', ['accept', request, '--body-file', join(w.root, 'brief.txt')]).briefReleased, true);
  const answer = agent('bob', ['draft', 'reply', request, '--body-file', '-'], { input: 'Timer mock leaks between tests.' }).draft;
  approve('bob', ['publish', answer]);
  approve('bob', ['complete', request, '--reply', answer, '--outcome', 'completed']);
  assert.equal(call('alice', ['show', request]).state, 'completed');
  assert.equal(call('alice', ['show', request]).context.revision, 2);
  const head = load().repos['alice/mailbox'].commits.at(-1).files;
  assert.equal(head[V1_LEDGER], V1_TEXT, 'the protocol 1 ledger is never read or rewritten');
  assert.ok(Object.values(load().commitsBy).every(c => c.paths.length === 1 && c.paths[0] === LEDGER), 'every commit touches only the v2 ledger');

  // Expected-head conflict: an unrelated commit lands between read and write; the same intent is retried.
  const second = agent('alice', ['draft', 'new', '--kind', 'review', '--title', 'Second', '--body-file', '-'], { input: 'Body' }).draft;
  const before = load().log.filter(entry => entry.operation === 'AgentshakeAppend').length;
  fault({ operation: 'AgentshakeAppend', kind: 'advance' });
  approve('alice', ['publish', second]);
  assert.equal(load().log.filter(entry => entry.operation === 'AgentshakeAppend').length - before, 2);
  assert.ok(load().repos['alice/mailbox'].commits.at(-2).files['README.md'].startsWith('unrelated change'));
  assert.equal(ledger().events.filter(event => event.event === second).length, 1);

  // Loss after commit, then the receipt read fails: uncertain (5), recover finds exactly one event.
  const third = agent('alice', ['draft', 'new', '--kind', 'task', '--title', 'Third', '--body-file', '-'], { input: 'Body' }).draft;
  const preview = call('alice', ['publish', third, '--preview']);
  // Reads during publish: CLI context, settle, adapter re-read after the write, settle re-read.
  fault({ operation: 'AgentshakeAppend', kind: 'commitThenFail' },
    { operation: 'AgentshakeMailbox', kind: 'http502', viewer: 101, skip: 2 },
    { operation: 'AgentshakeMailbox', kind: 'http502', viewer: 101, skip: 2 });
  run('alice', ['publish', third, '--approve', preview.digest], { expected: 5 });
  assert.deepEqual(call('alice', ['pending']).map(row => row.operation), [third]);
  assert.equal(call('alice', ['recover', third]).recorded, true);
  assert.equal(ledger().events.filter(event => event.event === third).length, 1);
  assert.deepEqual(call('alice', ['pending']), []);
  assert.equal(call('alice', ['publish', third]).alreadyPublished, true, 'republishing a delivered draft returns the original receipt');

  // Loss before commit: uncertain, then recover writes once.
  const fourth = agent('alice', ['draft', 'new', '--kind', 'task', '--title', 'Fourth', '--body-file', '-'], { input: 'Body' }).draft;
  fault({ operation: 'AgentshakeAppend', kind: 'fail502' });
  const p4 = call('alice', ['publish', fourth, '--preview']);
  const lost = run('alice', ['publish', fourth, '--approve', p4.digest], { expected: 5 });
  assert.match(JSON.parse(lost.stderr).error.next, /recover/);
  call('alice', ['recover', fourth]);
  assert.equal(ledger().events.filter(event => event.event === fourth).length, 1);

  // Permission denied on write is an access error (3), recoverable after the fix.
  s = load(); s.repos['alice/mailbox'].writers = [101]; save(s);
  const declinePreview = call('bob', ['decline', second, '--preview']);
  const denied = run('bob', ['decline', second, '--approve', declinePreview.digest], { expected: 3 });
  const operation = /operation ([0-9a-f-]{36})/.exec(denied.stderr)[1];
  s = load(); s.repos['alice/mailbox'].writers = [101, 202]; save(s);
  assert.equal(call('bob', ['recover', operation]).state, 'declined');

  // A staged but unconfirmed draft is never resumed implicitly: preview is read-only and
  // ordinary publish points to recover. Proven with the fake's write log.
  const appends = () => load().log.filter(entry => entry.operation === 'AgentshakeAppend').length;
  s = load(); s.repos['alice/mailbox'].writers = [202]; save(s);
  const staged = agent('alice', ['draft', 'new', '--kind', 'task', '--title', 'Staged', '--body-file', '-'], { input: 'Body' }).draft;
  const stagedPreview = call('alice', ['publish', staged, '--preview']);
  run('alice', ['publish', staged, '--approve', stagedPreview.digest], { expected: 3 });
  s = load(); s.repos['alice/mailbox'].writers = [101, 202]; save(s);
  const writesBefore = appends();
  const again = call('alice', ['publish', staged, '--preview']);
  assert.equal(again.staged, true);
  assert.equal(again.delivered, false);
  assert.equal(again.digest, stagedPreview.digest);
  assert.match(again.next[0], new RegExp(`recover ${staged}`));
  const plain = run('alice', ['publish', staged], { expected: 5 });
  assert.match(JSON.parse(plain.stderr).error.next, new RegExp(`agentshake recover ${staged}`));
  run('alice', ['publish', staged, '--approve', stagedPreview.digest], { expected: 5 });
  run('alice', ['publish', staged, '--preview', '--approve', stagedPreview.digest], { expected: 2 });
  assert.equal(appends(), writesBefore, 'preview and plain publish of a staged draft made zero writes');
  const calls = load().log.length;
  const profileDb = join(w.root, 'profile-alice', 'operator.sqlite');
  const dbBefore = readFileSync(profileDb);
  call('alice', ['publish', staged, '--preview']);
  assert.equal(load().log.length, calls, 'a staged preview makes no GitHub call at all');
  assert.ok(readFileSync(profileDb).equals(dbBefore), 'and leaves the profile database byte-identical');
  assert.equal(call('alice', ['recover', staged]).remote, 'recorded');
  assert.equal(appends(), writesBefore + 1);
  assert.equal(call('alice', ['publish', staged]).alreadyPublished, true);
  assert.equal(call('alice', ['publish', staged, '--preview']).delivered, true);
  assert.equal(appends(), writesBefore + 1, 'a delivered draft is never sent again');

  // Concurrent writers on the same head both land, each exactly once.
  const [x, y] = [
    agent('alice', ['draft', 'new', '--kind', 'question', '--title', 'X', '--body-file', '-'], { input: 'x' }).draft,
    agent('bob', ['draft', 'new', '--kind', 'question', '--title', 'Y', '--body-file', '-'], { input: 'y' }).draft];
  const dx = call('alice', ['publish', x, '--preview']).digest, dy = call('bob', ['publish', y, '--preview']).digest;
  const results = await Promise.all([w.runAsync('alice', ['publish', x, '--approve', dx]), w.runAsync('bob', ['publish', y, '--approve', dy])]);
  assert.deepEqual(results.map(r => r.code), [0, 0], results.map(r => r.stderr).join('\n'));
  assert.equal(ledger().events.filter(event => event.event === x || event.event === y).length, 2);

  // Bounded failure classification for reads.
  const cases = [['rate', 5], ['graphRate', 5], ['http401', 3], ['oversize', 5], ['garbage', 5]];
  for (const [kind, code] of cases) {
    fault({ operation: 'AgentshakeMailbox', kind, viewer: 202 });
    run('bob', ['doctor'], { expected: code });
  }
  for (const kind of ['truncated', 'badoid']) {
    fault({ operation: 'AgentshakeLedger', kind, viewer: 202 });
    run('bob', ['doctor'], { expected: 6 });
  }
  run('bob', ['doctor'], { extra: { PATH: w.nodeOnly }, expected: 3 });
  run('bob', ['doctor'], { extra: { GH_CONFIG_DIR: join(w.root, 'empty') }, expected: 3 });

  // Rollback (history rewritten to an older head) and a replaced repository are integrity failures.
  assert.equal(call('bob', ['doctor']).events, ledger().events.length, 'bob observes the latest head first');
  s = load();
  const saved = structuredClone(s.repos['alice/mailbox']);
  s.repos['alice/mailbox'].commits.pop();
  save(s);
  const rollback = run('bob', ['doctor'], { expected: 6 });
  assert.match(JSON.parse(rollback.stderr).error.message, /rollback or fork/);
  s = load(); s.repos['alice/mailbox'] = { ...saved, id: 'R_other', branchId: 'BR_other' }; save(s);
  run('bob', ['doctor'], { expected: 6 });
  // Same repository, branch ref deleted and recreated under the same name: the pinned ref ID differs.
  s = load(); s.repos['alice/mailbox'] = { ...saved, branchId: 'BR_recreated' }; save(s);
  assert.match(JSON.parse(run('bob', ['doctor'], { expected: 6 }).stderr).error.message, /branch ref was replaced/);
  s = load(); s.repos['alice/mailbox'] = saved; save(s);
  assert.equal(call('bob', ['doctor']).ok, true);
});
