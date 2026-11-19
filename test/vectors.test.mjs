// T2: re-derives every published vector from the spec text alone. Deliberately imports nothing from
// src/ or dist/: canonical JSON, the signing input, digests and context digests are written here again.
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const spec = path => new URL(`../spec/${path}`, import.meta.url);
const vectors = JSON.parse(readFileSync(spec('vectors/protocol-2.json'), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    // Array.prototype.sort compares strings by UTF-16 code units, which is the spec's key order.
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('not a safe integer');
  return JSON.stringify(value);
}
function keyFromSeed(hex) {
  return createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(hex, 'hex')]),
    format: 'der', type: 'pkcs8' });
}

test('T2 keys: public keys and fingerprints follow from the seeds', () => {
  for (const key of Object.values(vectors.keys)) {
    const der = createPublicKey(keyFromSeed(key.seed)).export({ type: 'spki', format: 'der' });
    assert.equal(der.toString('base64url'), key.publicKey);
    assert.equal(`SHA256:${sha256(der).slice(0, 32)}`, key.fingerprint);
  }
});

test('T2 canonical JSON: outputs and rejections match an independent canonicalizer', () => {
  for (const entry of vectors.canonical) {
    const parse = () => canon(JSON.parse(entry.input));
    if (entry.error) assert.throws(parse, entry.name);
    else assert.equal(parse(), entry.output, entry.name);
  }
});

test('T2 signatures: signing input, deterministic Ed25519 signature and record digest', () => {
  const seeds = Object.fromEntries(Object.entries(vectors.keys).map(([name, key]) => [name, keyFromSeed(key.seed)]));
  for (const entry of vectors.signing) {
    const input = Buffer.from(`agentshake/v2/${entry.domain}\0${canon(entry.document)}`, 'utf8');
    assert.equal(sha256(input), entry.signingInputSha256, entry.name);
    assert.equal(sign(null, input, seeds[entry.signer]).toString('base64url'), entry.signature, entry.name);
    assert.equal(sha256(canon({ ...entry.document, signature: entry.signature })), entry.recordDigest, entry.name);
    const v1 = Buffer.from(`agentshake/v1/${entry.domain}\0${canon(entry.document)}`, 'utf8');
    assert.equal(verify(null, v1, createPublicKey(seeds[entry.signer]), Buffer.from(entry.signature, 'base64url')), false,
      'a protocol 2 signature never verifies under the protocol 1 prefix');
  }
});

test('T2 context digests follow the published formula', () => {
  const scheme = 'agentshake/v2/context';
  for (const entry of vectors.context) {
    const input = entry.offer ? { scheme, request: entry.request, revision: 1, offer: entry.offer }
      : { scheme, request: entry.request, revision: entry.revision, previous: entry.previous,
        supply: { event: entry.supply.event, ask: entry.supply.ask ?? null, answers: entry.supply.answers, note: entry.supply.note ?? null,
          resolutions: entry.supply.resolutions ?? [] } };
    assert.equal(sha256(canon(input)), entry.digest, entry.name);
  }
});

test('T2 ledger chain and byte compatibility with the 0.2 golden vectors', () => {
  const raw = readFileSync(spec('examples/protocol-2/valid/offer.json'), 'utf8');
  const ledger = JSON.parse(raw);
  assert.equal(canon(ledger), raw, 'the example is stored in canonical form');
  assert.equal(sha256(raw), vectors.ledger.digest);
  assert.deepEqual([sha256(canon(ledger.genesis)), ...ledger.events.map(event => sha256(canon(event)))], vectors.ledger.chain);
  // Values pinned by test/domain.test.mjs and docs/protocol.md since 0.2.0.
  assert.equal(ledger.genesis.signature, 'TaurBOlDL_-8QtWkI4WZCTpWs6dZwWkqkAwSfqaAgF3imWY--kb96yHgB7-TslMZQ5ChvgxDICkpqxaw_MibCA');
  assert.equal(vectors.ledger.chain[0], 'a1a832f24193d7bcf07c3d22bad7b741d8becb5a7071fdef30dfb4a69f29f5aa');
  const { previous: _previous, signature, ...intent } = ledger.events[0];
  assert.equal(sha256(canon(intent)), 'f52ab2bfd7b7c11ea29b510c0edaee12f4ef125f3dc22f0de342f90fe959f32c');
  assert.equal(signature, 'naG95GsvrFDcGuDB6PSPJsUP6kZyssGnfNyYOF1y4yDZ4VCUJGN7svzbAZoPnosHs2gEuLYN3wI9dQD00QX9Dg');
  assert.equal(vectors.ledger.digest, '9c51e9d7cc5297312db8b9cd620f4f4d92e5bb379a97ac0b60197bf179474ebd');
  assert.equal(vectors.context[0].digest, 'b18f6adda6e827acce5763ee676894101bfc33b811eca359b3d4dc6a1d7a07bb');
});
