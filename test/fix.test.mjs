// Regressions for the 0.3.0 review: order-independent conformance (F1), structured results for bounded
// document failures versus filesystem errors (F2), and the decideIntent mutation-free scope.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as A from '../dist/index.js';

const bin = process.env.AGENTSHAKE_BIN || resolve('dist/cli.js');
const SPEC = resolve('spec');
const run = (args, options = {}) => spawnSync(bin, args, { encoding: 'utf8', timeout: 120_000, ...options });
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agentshake-fix-'));
  t.after(() => { try { chmodSync(join(dir, 'locked.json'), 0o600); } catch { /* absent */ } rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('F1 external conformance passes whatever member order the validator prints', t => {
  const dir = scratch(t);
  for (const [name, order] of [['sorted', 'keys.sort()'], ['reversed', 'keys.sort().reverse()']]) {
    const wrapper = join(dir, `${name}.mjs`);
    writeFileSync(wrapper, `import { spawnSync } from 'node:child_process';
const [cli, file, kind] = process.argv.slice(2);
const result = spawnSync(process.execPath, [cli, 'validate', file, '--as', kind, '--json'], { encoding: 'utf8' });
const reorder = (_, x) => { if (!x || typeof x !== 'object' || Array.isArray(x)) return x; const keys = Object.keys(x); return Object.fromEntries(${order}.map(k => [k, x[k]])); };
process.stdout.write(JSON.stringify(JSON.parse(result.stdout), reorder));
`);
    const result = run(['--json', 'conformance', '--', process.execPath, wrapper, bin, '{file}', '{as}']);
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 0, `${name}: ${JSON.stringify(report.failed)}`);
    assert.equal(report.passed, report.cases);
  }
  const raw = readFileSync(join(SPEC, 'examples/protocol-2/conversations/agent-agent/ledger.json'), 'utf8');
  const summary = A.summarize(A.decode(raw));
  const permute = value => Array.isArray(value) ? value.map(permute) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, permute(value[key])])) : value;
  assert.deepEqual(A.normalizeSummary(permute(summary)), A.normalizeSummary(summary));
});

test('F2 bounded document failures are validation results with stage and code, on file and stdin', t => {
  const dir = scratch(t);
  const deep = n => '{"events":[],"genesis":{"version":' + '['.repeat(n) + '0' + ']'.repeat(n) + '}}';
  const cases = [
    ['deep-15000.json', deep(15_000), 'ledger', 'version.unsupported'],
    ['deep-120000.json', deep(120_000), 'ledger', 'version.unsupported'],
    ['bad-utf8.json', Buffer.from([0x7b, 0xff, 0x7d]), 'ledger', 'input.encoding'],
    ['bad-utf8-draft.json', Buffer.from([0xc3, 0x28]), 'draft', 'input.encoding'],
    ['huge.json', Buffer.alloc(4 * 262_144 + 1, 0x20), 'ledger', 'input.size'],
    ['huge-draft.json', Buffer.alloc(32 * 1024 + 1, 0x20), 'draft', 'input.size'],
    ['not-json.json', '{"genesis":', 'brief', 'input.json']
  ];
  for (const [name, content, as, code] of cases) {
    const file = join(dir, name);
    writeFileSync(file, content);
    for (const result of [run(['--json', 'validate', file, '--as', as]), run(['--json', 'validate', '-', '--as', as], { input: content })]) {
      assert.equal(result.status, 6, `${name}: ${result.stderr}`);
      assert.equal(result.stderr, '', name);
      const value = JSON.parse(result.stdout);
      assert.equal(value.valid, false);
      assert.equal(value.code, code, name);
      assert.equal(value.stage, code.split('.')[0], name);
      assert.ok(result.stdout.length < 1000, `${name}: the diagnostic stays bounded`);
    }
    assert.equal(A.validate(readFileSync(file), as).code, code, `${name}: library`);
  }
  assert.equal(A.inspect(deep(120_000)).finding.message, 'Unsupported mailbox protocol version (an array).');
  assert.equal(A.inspect('{"events":[],"genesis":{"version":3}}').finding.message, 'Unsupported mailbox protocol version 3.');
});

test('F2 filesystem problems stay errors, not validation results', t => {
  const dir = scratch(t);
  const missing = run(['--json', 'validate', join(dir, 'absent.json')]);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, '');
  assert.match(JSON.parse(missing.stderr).error.message, /File not found/);
  mkdirSync(join(dir, 'folder.json'));
  assert.equal(run(['--json', 'validate', join(dir, 'folder.json')]).status, 2);
  if (process.getuid?.() !== 0) {
    writeFileSync(join(dir, 'locked.json'), '{}');
    chmodSync(join(dir, 'locked.json'), 0);
    const locked = run(['--json', 'validate', join(dir, 'locked.json')]);
    assert.equal(locked.status, 3);
    assert.equal(locked.stdout, '');
  }
});

test('decideIntent never mutates the given replay, whether it refuses or accepts; the seal is a trusted hook', () => {
  const raw = readFileSync(join(SPEC, 'examples/protocol-2/valid/confirm-with-gaps.json'), 'utf8');
  const state = A.decode(raw);
  const snapshot = structuredClone(state);
  const request = [...state.requests.values()][0];
  const base = { version: 2, epoch: state.ledger.genesis.epoch, request: request.id, revision: request.revision,
    timestamp: request.updated + 1 };
  const seal = document => ({ ...document, signature: 'A'.repeat(86) });
  const refused = { ...base, actor: request.sender, event: '00000000-0000-4000-8000-0000000000f1',
    payload: { kind: 'accept', context: request.context.digest, confirmation: request.confirmation } };
  assert.equal(A.decideIntent(state, refused, base.timestamp, seal).ok, false);
  const accepted = { ...refused, actor: request.recipient, event: '00000000-0000-4000-8000-0000000000f2' };
  assert.equal(A.decideIntent(state, accepted, base.timestamp, seal).ok, true);
  assert.deepEqual(state, snapshot);
  const failure = new Error('seal failed');
  assert.throws(() => A.decideIntent(state, accepted, base.timestamp, () => { throw failure; }), error => error === failure);
  assert.deepEqual(state, snapshot);
});
