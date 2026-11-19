// Spec artifacts against the reference implementation: JSON Schema verdicts and their agreement with
// the reference schema stage (T1), conformance through the executable (T3), fixture stability (T7),
// packaging and links (T9), capabilities parity (T10) and the single verifier behind decode (T11).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import * as A from '../dist/index.js';

const bin = process.env.AGENTSHAKE_BIN || resolve('dist/cli.js');
const SPEC = resolve('spec');
const manifest = JSON.parse(readFileSync(join(SPEC, 'conformance-protocol-2.json'), 'utf8'));
const read = path => readFileSync(join(SPEC, path), 'utf8');
const run = (args, options = {}) => spawnSync(bin, args, { encoding: 'utf8', timeout: 60_000, ...options });

function schemas() {
  const ajv = new Ajv2020({ strict: true });
  for (const file of readdirSync(join(SPEC, 'schemas'))) ajv.addSchema(JSON.parse(read(`schemas/${file}`)));
  const local = A.SCHEMA_IDS['local-exchange-1'];
  const compiled = {
    ledger: ajv.getSchema(A.SCHEMA_IDS['protocol-2']), draft: ajv.getSchema(`${local}#/$defs/draft`),
    brief: ajv.getSchema(`${local}#/$defs/brief`), capabilities: ajv.getSchema(A.SCHEMA_IDS['capabilities-1']),
    validation: ajv.getSchema(A.SCHEMA_IDS['validation-1']), conformance: ajv.getSchema(A.SCHEMA_IDS['conformance-1'])
  };
  return { ajv, compiled };
}
const json = text => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } };
const zodFor = { ledger: A.ledgerSchema, draft: A.draftSchema, brief: A.briefSchema };

test('T1 every schema compiles in Ajv strict mode and the manifest conforms to its own schema', () => {
  const { ajv, compiled } = schemas();
  for (const id of Object.values(A.SCHEMA_IDS)) assert.ok(ajv.getSchema(id), id);
  for (const [name, validate] of Object.entries(compiled)) assert.equal(typeof validate, 'function', name);
  assert.ok(compiled.conformance(manifest), JSON.stringify(compiled.conformance.errors));
  for (const [file, id] of [['protocol-2', 'protocol-2'], ['local-exchange-1', 'local-exchange-1'], ['capabilities-1', 'capabilities-1'],
    ['validation-1', 'validation-1'], ['conformance-1', 'conformance-1']]) {
    assert.equal(JSON.parse(read(`schemas/${file}.schema.json`)).$id, A.SCHEMA_IDS[id], 'schema IDs are the stable committed urn:uuid values');
  }
});

test('T1 JSON Schema verdicts match the manifest, never reject what the reference schema stage accepts, and differ only by S1-S3', () => {
  const { compiled } = schemas();
  for (const entry of manifest.cases) {
    const parsed = json(read(entry.input));
    const ajvOk = parsed.ok && compiled[entry.as](parsed.value);
    assert.equal(ajvOk ? 'pass' : 'fail', entry.expect.jsonSchema, entry.id);
    const zodOk = parsed.ok && zodFor[entry.as].safeParse(parsed.value).success;
    if (zodOk) assert.ok(ajvOk, `${entry.id}: JSON Schema must accept what the reference schema stage accepts`);
    if (ajvOk && !zodOk) assert.match(entry.expect.rule ?? '', /^S[123]$/, `${entry.id}: only byte and Unicode rules are beyond JSON Schema`);
  }
});

test('T1 signature and key patterns accept exactly what the wire 2 schema accepts', () => {
  const { ajv } = schemas();
  const signature = ajv.getSchema(`${A.SCHEMA_IDS['protocol-2']}#/$defs/signature`);
  const key = ajv.getSchema(`${A.SCHEMA_IDS['protocol-2']}#/$defs/publicKey`);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+/=. ';
  const body = 'naG95GsvrFDcGuDB6PSPJsUP6kZyssGnfNyYOF1y4yDZ4VCUJGN7svzbAZoPnosHs2gEuLYN3wI9dQD00QX9D';
  for (const last of alphabet) {
    for (const candidate of [body + last, body.slice(1) + last, body + 'g' + last]) {
      assert.equal(signature(candidate), A.signatureSchema.safeParse(candidate).success, JSON.stringify(candidate));
    }
    const keyCandidate = 'MCowBQYDK2VwAyEAebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60Elm' + last;
    assert.equal(key(keyCandidate), A.publicKeySchema.safeParse(keyCandidate).success, JSON.stringify(keyCandidate));
  }
});

test('T3 the shipped conformance cases pass in-process and through the executable as an external validator', async () => {
  for (const args of [['conformance'], ['conformance', '--', bin, 'validate', '{file}', '--as', '{as}', '--json']]) {
    const result = run(['--json', ...args]);
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 0, JSON.stringify(report.failed));
    assert.equal(report.passed, manifest.cases.length);
  }
  const { compiled } = schemas();
  for (const entry of manifest.cases.filter((_, index) => index % 7 === 0)) {
    const result = run(['--json', 'validate', join(SPEC, entry.input), '--as', entry.as]);
    assert.equal(result.status, entry.expect.valid ? 0 : 6, entry.id);
    assert.ok(compiled.validation(JSON.parse(result.stdout)), `${entry.id}: ${JSON.stringify(compiled.validation.errors)}`);
  }
  const liar = await A.runConformance(async () => ({ valid: true }), 'always-valid');
  assert.ok(liar.failed.length > 0 && liar.failed.every(entry => entry.problem), 'a validator that accepts everything fails conformance');
});

test('T11 decode() throws exactly what inspect() reports, for every manifest ledger', () => {
  // Byte-level cases (input.encoding) are defined on file bytes, not on decoded text.
  for (const entry of manifest.cases.filter(item => item.as === 'ledger' && item.expect.code !== 'input.encoding')) {
    const raw = read(entry.input);
    const inspection = A.inspect(raw);
    assert.equal(inspection.ok, entry.expect.valid, entry.id);
    if (inspection.ok) { assert.doesNotThrow(() => A.decode(raw)); continue; }
    assert.throws(() => A.decode(raw), error => error instanceof A.AgentshakeError && error.reason === inspection.finding.reason &&
      error.message === inspection.finding.message && error.next === inspection.finding.next, entry.id);
    assert.equal(inspection.finding.code, entry.expect.code, entry.id);
  }
});

test('T7 committed fixtures equal the generator output', () => {
  const result = spawnSync(process.execPath, ['scripts/spec-fixtures.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('T9 the package ships spec/, every schema and fixture, no local records, and every relative link resolves', () => {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
  const files = new Set(pack.files.map(file => file.path));
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  for (const path of walk(SPEC)) assert.ok(files.has(path.slice(resolve('.').length + 1)), path);
  for (const path of files) assert.doesNotMatch(path, /\.local-work|\.sqlite$|operator|\.pem$|github-auth/, path);
  const slug = heading => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  const anchors = file => new Set(readFileSync(file, 'utf8').split('\n').filter(line => /^#{1,6} /.test(line))
    .map(line => slug(line.replace(/^#+ /, ''))));
  const documents = [...walk(SPEC).filter(path => path.endsWith('.md')), ...walk(resolve('docs')), resolve('README.md')];
  for (const file of documents) {
    for (const [, target] of readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      const [path, anchor] = target.split('#');
      const destination = path ? resolve(dirname(file), path) : file;
      assert.ok(existsSync(destination), `${file}: ${target}`);
      if (anchor && destination.endsWith('.md')) assert.ok(anchors(destination).has(anchor), `${file}: ${target}`);
    }
  }
});

test('T10 capabilities: CLI, agent CLI and MCP agree, validate against the schema and mirror the constants, offline', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'agentshake-noprofile-'));
  try {
    // No profile, no gh, no network: a HOME and profile path that do not exist and a PATH without gh.
    const env = { PATH: dirname(process.execPath), HOME: join(empty, 'missing-home'), AGENTSHAKE_HOME: join(empty, 'missing-profile') };
    const cli = JSON.parse(run(['--json', 'capabilities'], { env }).stdout);
    const agent = JSON.parse(run(['--json', 'agent', 'capabilities'], { env }).stdout);
    const offline = run(['--json', 'validate', join(SPEC, 'examples/protocol-2/valid/reply.json')], { env });
    assert.equal(offline.status, 0);
    assert.deepEqual(readdirSync(empty), [], 'capabilities and validate create no profile or home directory');
    const client = new Client({ name: 'spec-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [bin, 'agent', '--inbox', empty, '--outbox', empty, 'mcp'], stderr: 'pipe' }));
    let mcp;
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(tool => tool.name).sort(), ['create_draft', 'get_capabilities', 'list_briefs', 'read_brief']);
      const result = await client.callTool({ name: 'get_capabilities', arguments: {} });
      assert.notEqual(result.isError, true);
      mcp = JSON.parse(result.content[0].text);
    } finally { await client.close(); }
    assert.deepEqual(agent, cli);
    assert.deepEqual(mcp, cli);
    const { compiled } = schemas();
    assert.ok(compiled.capabilities(cli), JSON.stringify(compiled.capabilities.errors));
    assert.deepEqual(cli, A.capabilities());
    assert.equal(cli.software.version, A.VERSION);
    assert.deepEqual(cli.protocols.map(entry => entry.version), [A.PROTOCOL]);
    assert.deepEqual(cli.limits, { ledgerBytes: A.MAX_LEDGER, requests: A.MAX_REQUESTS, events: A.MAX_EVENTS, eventsPerRequest: A.MAX_PER_REQUEST,
      itemsPerRound: A.MAX_ITEMS, suppliesPerRequest: A.MAX_SUPPLIES, titleCharacters: A.MAX_TITLE_CHARS, bodyBytes: A.MAX_BODY,
      needBytes: A.MAX_NEED, understandingBytes: A.MAX_UNDERSTANDING,
      ttlHours: { min: A.MIN_TTL_HOURS, max: A.MAX_TTL_HOURS, default: A.DEFAULT_TTL_HOURS } });
    assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).version, A.VERSION);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
