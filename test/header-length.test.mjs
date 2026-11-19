// Genesis header lengths are code points: channel 1-200, branch 1-250, an unpaired surrogate counting
// as one. Records are signed here independently (own canonical JSON, fresh Node Ed25519 keys); nothing
// is imported from src/, dist/ or the fixture generator.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const bin = process.env.AGENTSHAKE_BIN || resolve('dist/cli.js');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const keys = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')];
const roster = keys.map(({ publicKey }, index) =>
  ({ account: String(index + 1), key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') }));
function ledger(header) {
  const document = { version: 2, epoch: '12345678-1234-4234-8234-000000000001', channel: 'test:length', branch: 'local', roster, ...header };
  const signature = sign(null, Buffer.from(`agentshake/v2/genesis\0${canonical(document)}`, 'utf8'), keys[0].privateKey).toString('base64url');
  return canonical({ genesis: { ...document, signature }, events: [] });
}
function schema() {
  const ajv = new Ajv2020({ strict: true });
  for (const file of readdirSync(resolve('spec/schemas'))) ajv.addSchema(JSON.parse(readFileSync(resolve('spec/schemas', file), 'utf8')));
  return ajv.getSchema('urn:uuid:5e1a8e47-e60e-4632-b1d0-80b6d5a2e130');
}

test('channel and branch limits count code points, at the exact maximum and one over', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentshake-header-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const syntax = schema();
  const astral = '\u{1F600}';
  const cases = [
    ['channel-200-astral', { channel: astral.repeat(200) }, true],
    ['channel-201-astral', { channel: astral.repeat(201) }, false, '/genesis/channel'],
    ['channel-199-astral-1-lone', { channel: astral.repeat(199) + '\ud800' }, true],
    ['channel-200-astral-1-lone', { channel: astral.repeat(200) + '\ud800' }, false, '/genesis/channel'],
    ['branch-250-astral', { branch: astral.repeat(250) }, true],
    ['branch-251-astral', { branch: astral.repeat(251) }, false, '/genesis/branch']
  ];
  for (const [name, header, valid, path] of cases) {
    const raw = ledger(header);
    const file = join(dir, `${name}.json`);
    writeFileSync(file, raw);
    const result = spawnSync(bin, ['--json', 'validate', file], { encoding: 'utf8', timeout: 60_000 });
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, valid ? 0 : 6, `${name}: ${result.stdout}${result.stderr}`);
    assert.equal(output.valid, valid, name);
    if (!valid) assert.deepEqual([output.code, output.path], ['schema.invalid', path], name);
    assert.equal(syntax(JSON.parse(raw)), valid, `${name}: JSON Schema agrees`);
  }
});
