import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import { append, canonical, capacity, decode, fingerprint, genesis, intentDigest, MAX_LEDGER, newKey,
  receiptMatches, sha256, signingBytes, stateAt } from '../dist/domain.js';

const time = 1_800_000_000_000;
const HOUR = 3_600_000;
const alice = newKey(), bob = newKey();
function fresh() {
  return decode(canonical(genesis('file:test', 'local', '1', alice, { account: '2', key: bob.publicKey })));
}
const create = (body = 'Hello 🚀', extra = {}) =>
  ({ kind: 'create', to: '2', category: 'question', title: 'Unicode café', body, ttlHours: 1, ...extra });
function event(state, actor, request, payload, timestamp = time) {
  return { version: 1, epoch: state.ledger.genesis.epoch, actor, event: randomUUID(), request,
    revision: state.requests.get(request)?.revision ?? 0, timestamp, payload };
}
function apply(state, ev, key, now = time) { return decode(canonical(append(state, ev, key, now))); }
/** Signs an event directly, bypassing append(), to model a malicious but pinned signer. */
function forge(state, intent, key) {
  const document = { ...intent, previous: state.chain.at(-1) };
  const signature = sign(null, signingBytes('event', document), key.privateKey).toString('base64url');
  return canonical({ genesis: state.ledger.genesis, events: [...state.ledger.events, { ...document, signature }] });
}

function seeded(start) {
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => start + i));
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  return { privateKey: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url') };
}

test('golden vectors: canonical bytes, Unicode, signatures and digests are stable', () => {
  assert.equal(canonical({ z: 2, a: ['é', { z: 1, a: '🚀' }], u: undefined }), '{"a":["é",{"a":"🚀","z":1}],"z":2}');
  assert.throws(() => canonical({ n: 1.5 }), /safe integers/);
  const a = seeded(1), b = seeded(33);
  assert.equal(a.publicKey, 'MCowBQYDK2VwAyEAebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ');
  assert.equal(b.publicKey, 'MCowBQYDK2VwAyEA5_FioQvsVZr-oZXk3OhLaVaNXSywlj60RsBoXisX8vA');
  assert.equal(fingerprint(a.publicKey), 'SHA256:646d6be49d9f0048f94f67749eca3515');
  const g = genesis('github:R_example', 'main', '101', a, { account: '202', key: b.publicKey }, '00000000-0000-4000-8000-000000000001');
  assert.equal(g.genesis.signature, 'R67nI_rqWRqt67tNFnGcb5YgStWmH6eXGe71GdbDGVnlbFnDsUK-BpCtO0WwaVV9h3wfHTMEKTHmUnMJfqCWAg');
  const state = decode(canonical(g));
  assert.equal(state.chain[0], 'a9eb2e9d7bf283dd9d0f06e849b4d1fa9328830e4e216c8f90850eecf58f4787');
  const intent = { version: 1, epoch: g.genesis.epoch, actor: '101', event: '00000000-0000-4000-8000-000000000002',
    request: '00000000-0000-4000-8000-000000000002', revision: 0, timestamp: time,
    payload: { kind: 'create', to: '202', category: 'review', title: 'Café ☕ review', body: 'Line 1\n\t«quoted» \\ "x" 🚀', ttlHours: 168 } };
  assert.equal(intentDigest(intent), 'b6173b74e09b96578d754dfb7330459d6716035b6bd2e0891559814fcfb7380f');
  const ledger = append(state, intent, a, time);
  assert.equal(ledger.events[0].signature, 'nOmT2QKwNDGDlFeW_mGxuHzLabM7nRGIphdHOzOHGqz8vgf_wf3OHvzgOUyYmuv3-9IXlscrE9PmmsNldQkPAw');
  assert.equal(sha256(canonical(ledger)), '16ee55614a4d207af9bc05b3d3a8762c01428d61dddd31312bec92d2efdce476');
  assert.ok(receiptMatches(ledger.events[0], intent));
  assert.ok(!receiptMatches(ledger.events[0], { ...intent, revision: 1 }));
});

test('tampering, unknown fields, versions and non-canonical bytes are integrity failures', () => {
  const state = fresh();
  const next = apply(state, event(state, '1', randomUUID(), create()), alice);
  const altered = structuredClone(next.ledger);
  altered.events[0].payload.body = 'Different';
  assert.throws(() => decode(canonical(altered)), error => error.code === 6 && /Signature/.test(error.message));
  const resigned = structuredClone(next.ledger);
  resigned.events[0].signature = resigned.events[0].signature.replace(/^./, c => c === 'A' ? 'B' : 'A');
  assert.throws(() => decode(canonical(resigned)), error => error.code === 6);
  const relinked = structuredClone(next.ledger);
  relinked.events[0].previous = '0'.repeat(64);
  assert.throws(() => decode(canonical(relinked)), /chain/);
  assert.throws(() => decode(canonical({ ...next.ledger, unknown: true })), /schema/);
  const extraField = structuredClone(next.ledger);
  extraField.events[0].payload.admin = true;
  assert.throws(() => decode(canonical(extraField)), /schema/);
  assert.throws(() => decode(canonical(next.ledger) + '\n'), /canonical/);
  assert.throws(() => decode('{"genesis":'), /valid JSON/);
  assert.throws(() => decode(' '.repeat(MAX_LEDGER + 1)), /byte cap/);
  const future = structuredClone(next.ledger);
  future.genesis.version = 2;
  assert.throws(() => decode(canonical(future)), /Unsupported mailbox protocol version 2/);
  const genesisSwap = structuredClone(next.ledger);
  genesisSwap.genesis.roster[1].key = newKey().publicKey;
  assert.throws(() => decode(canonical(genesisSwap)), /genesis signature/);
});

test('a pinned peer cannot sign terminal controls, replays, wrong audience or out-of-role transitions', () => {
  let state = fresh();
  const request = randomUUID();
  assert.throws(() => decode(forge(state, event(state, '1', request, create('evil \u001b[2J')), alice)), /schema/);
  assert.throws(() => decode(forge(state, event(state, '1', request, create('x', { title: 'two\nlines' })), alice)), /schema/);
  assert.throws(() => decode(forge(state, event(state, '1', request, create('x', { to: '3' })), alice)), /paired account/);
  assert.throws(() => decode(forge(state, event(state, '1', request, create('x', { to: '1' })), alice)), /paired account/);
  assert.throws(() => decode(forge(state, event(state, '2', request, create()), alice)), /Signature/);
  state = apply(state, event(state, '1', request, create()), alice);
  const accept = event(state, '2', request, { kind: 'accept' });
  // Replay of an already recorded event ID.
  const replayed = { ...state.ledger.events[0] };
  const withReplay = canonical({ ...state.ledger, events: [...state.ledger.events, { ...replayed, previous: state.chain.at(-1) }] });
  assert.throws(() => decode(withReplay), /Signature|event identity/);
  assert.throws(() => decode(forge(state, { ...accept, actor: '1' }, alice)), /recipient/);
  assert.throws(() => decode(forge(state, { ...accept, revision: 0 }, bob)), /changed/);
  assert.throws(() => decode(forge(state, { ...accept, timestamp: time + HOUR }, bob)), /expired/);
  assert.throws(() => decode(forge(state, { ...accept, timestamp: time - 1 }, bob)), /clock is behind/);
  assert.throws(() => decode(forge(state, { ...accept, epoch: randomUUID() }, bob)), /epoch/);
});

test('roles, revisions, expiry, linked completion and terminal immutability', () => {
  let state = fresh();
  const request = randomUUID();
  state = apply(state, event(state, '1', request, create()), alice);
  const accept = event(state, '2', request, { kind: 'accept' });
  assert.throws(() => apply(state, accept, alice), /Signing key/);
  assert.throws(() => apply(state, event(state, '2', request, { kind: 'cancel' }), bob), /Only the requester/);
  assert.throws(() => apply(state, event(state, '1', request, { kind: 'reply', body: 'early' }), alice), /accepted/);
  assert.equal(stateAt(state.requests.get(request), time + HOUR), 'expired');
  assert.throws(() => apply(state, accept, bob, time + HOUR), /expired/);
  assert.throws(() => apply(state, { ...accept, timestamp: time + 10 * 60_000 }, bob, time), /ahead of the local clock/);
  state = apply(state, accept, bob);
  assert.throws(() => apply(state, event(state, '2', request, { kind: 'accept' }), bob), /no longer pending/);
  const aliceReply = event(state, '1', request, { kind: 'reply', body: 'Clarified' });
  state = apply(state, aliceReply, alice);
  assert.throws(() => apply(state, event(state, '2', request, { kind: 'complete', reply: aliceReply.event, outcome: 'completed' }), bob),
    /your own reply/);
  const reply = event(state, '2', request, { kind: 'reply', body: 'Done' });
  state = apply(state, reply, bob);
  assert.throws(() => apply(state, event(state, '1', request, { kind: 'complete', reply: reply.event, outcome: 'completed' }), alice),
    /Only the recipient/);
  state = apply(state, event(state, '2', request, { kind: 'complete', reply: reply.event, outcome: 'completed' }), bob);
  assert.equal(state.requests.get(request).result, reply.event);
  for (const payload of [{ kind: 'cancel' }, { kind: 'reply', body: 'late' }]) {
    assert.throws(() => apply(state, event(state, '1', request, payload), alice), /already completed/);
  }
  const stale = create('old', { ttlHours: 1 });
  assert.throws(() => apply(state, event(state, '1', randomUUID(), stale, time - 2 * HOUR), alice), /expired before it was sent/);
});

test('bounds: title, body, TTL, per-request and mailbox capacity with reservations', () => {
  let state = fresh();
  assert.throws(() => apply(state, event(state, '1', randomUUID(), create('x'.repeat(4097))), alice), /Invalid/);
  assert.throws(() => apply(state, event(state, '1', randomUUID(), create('x', { title: 'é'.repeat(121) })), alice), /Invalid/);
  assert.throws(() => apply(state, event(state, '1', randomUUID(), create('x', { ttlHours: 337 })), alice), /Invalid/);
  assert.throws(() => apply(state, event(state, '1', randomUUID(), create('x', { ttlHours: 0 })), alice), /Invalid/);
  assert.doesNotThrow(() => apply(state, event(state, '1', randomUUID(), create('é'.repeat(2048))), alice));
  const request = randomUUID();
  state = apply(state, event(state, '1', request, create()), alice);
  state = apply(state, event(state, '2', request, { kind: 'accept' }), bob);
  for (let n = 0; n < 28; n++) state = apply(state, event(state, '1', request, { kind: 'reply', body: 'clarify' }), alice);
  assert.throws(() => apply(state, event(state, '1', request, { kind: 'reply', body: 'more' }), alice), /event cap/);
  const reply = event(state, '2', request, { kind: 'reply', body: 'Done' });
  state = apply(state, reply, bob);
  state = apply(state, event(state, '2', request, { kind: 'complete', reply: reply.event, outcome: 'failed' }), bob);
  assert.equal(state.requests.get(request).revision, 32);

  // Byte reservation: open requests with large bodies fill the ledger before the 32 request cap.
  let full = fresh();
  let admitted = 0;
  for (;;) {
    try { full = apply(full, event(full, '1', randomUUID(), create('"'.repeat(4096), { ttlHours: 24 })), alice); admitted++; }
    catch (error) { assert.match(error.message, /capacity/); assert.equal(error.code, 4); break; }
  }
  const usage = capacity(full.requests, full.ledger);
  assert.ok(admitted >= 8 && admitted < 32, `admitted ${admitted}`);
  assert.ok(usage.bytes + usage.reservedBytes <= MAX_LEDGER);
  // Every admitted request can still be accepted, answered and closed.
  for (const id of [...full.requests.keys()]) {
    full = apply(full, event(full, '2', id, { kind: 'accept' }), bob);
    const answer = event(full, '2', id, { kind: 'reply', body: '\\'.repeat(4096) });
    full = apply(full, answer, bob);
    full = apply(full, event(full, '2', id, { kind: 'complete', reply: answer.event, outcome: 'completed' }), bob);
  }
});
