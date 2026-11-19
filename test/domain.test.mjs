import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import { append, apply as transition, canonical, capacity, decode, fingerprint, gapsOf, genesis, intentDigest, MAX_LEDGER, newKey, preflight,
  receiptMatches, sha256, signingBytes, stateAt } from '../dist/domain.js';

const time = 1_800_000_000_000;
const HOUR = 3_600_000;
const alice = newKey(), bob = newKey();
function fresh() {
  return decode(canonical(genesis('file:test', 'local', '1', alice, { account: '2', key: bob.publicKey })));
}
const offer = (body = 'Hello 🚀', extra = {}) =>
  ({ kind: 'offer', to: '2', category: 'question', title: 'Unicode café', body, ttlHours: 1, ...extra });
function event(state, actor, request, payload, timestamp = time) {
  return { version: 2, epoch: state.ledger.genesis.epoch, actor, event: randomUUID(), request,
    revision: state.requests.get(request)?.revision ?? 0, timestamp, payload };
}
function apply(state, ev, key, now = time) { return decode(canonical(append(state, ev, key, now))); }
/** Signs an event directly, bypassing append(), to model a malicious but pinned signer. */
function forge(state, intent, key) {
  const document = { ...intent, previous: state.chain.at(-1) };
  const signature = sign(null, signingBytes('event', document), key.privateKey).toString('base64url');
  return canonical({ genesis: state.ledger.genesis, events: [...state.ledger.events, { ...document, signature }] });
}
const ctx = (state, request) => state.requests.get(request).context.digest;
const items = (n = 2) => Array.from({ length: n }, (_, i) => ({ topic: `Item ${i + 1}`, need: `Reason ${i + 1}` }));
const ask = (state, request, n) => ({ kind: 'ask', context: ctx(state, request), items: items(n) });
const answers = (...statuses) => statuses.map((status, i) => ({ item: i + 1, status, ...(status === 'supplied' ? { body: `Answer ${i + 1}` } : {}) }));
const supply = (state, request, statuses, extra = {}) =>
  ({ kind: 'supply', context: ctx(state, request), ask: state.requests.get(request).open, answers: answers(...statuses), ...extra });
const note = (state, request, text = 'More context') => ({ kind: 'supply', context: ctx(state, request), answers: [], note: text });
const confirm = (state, request, understanding = 'I understand') =>
  ({ kind: 'confirm', context: ctx(state, request), understanding, gaps: gapsOf(state.requests.get(request)) });
const accept = (state, request) =>
  ({ kind: 'accept', context: ctx(state, request), confirmation: state.requests.get(request).confirmation });
/** Offer, then confirm and accept the initial context. */
function accepted(state, request, extra = {}) {
  state = apply(state, event(state, '1', request, offer('Body', extra)), alice);
  state = apply(state, event(state, '2', request, confirm(state, request)), bob);
  return apply(state, event(state, '2', request, accept(state, request)), bob);
}

function seeded(start) {
  const seed = Buffer.from(Array.from({ length: 32 }, (_, i) => start + i));
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  return { privateKey: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64url') };
}

test('golden vectors (protocol 2): canonical bytes, Unicode, signatures, digests and the context digest are stable', () => {
  assert.equal(canonical({ z: 2, a: ['é', { z: 1, a: '🚀' }], u: undefined }), '{"a":["é",{"a":"🚀","z":1}],"z":2}');
  assert.throws(() => canonical({ n: 1.5 }), /safe integers/);
  const a = seeded(1), b = seeded(33);
  assert.equal(a.publicKey, 'MCowBQYDK2VwAyEAebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ');
  assert.equal(b.publicKey, 'MCowBQYDK2VwAyEA5_FioQvsVZr-oZXk3OhLaVaNXSywlj60RsBoXisX8vA');
  assert.equal(fingerprint(a.publicKey), 'SHA256:646d6be49d9f0048f94f67749eca3515');
  assert.equal(signingBytes('event', {}).toString(), 'agentshake/v2/event\0{}');
  const g = genesis('github:R_example', 'main', '101', a, { account: '202', key: b.publicKey }, '00000000-0000-4000-8000-000000000001');
  assert.equal(g.genesis.version, 2);
  assert.equal(g.genesis.signature, 'TaurBOlDL_-8QtWkI4WZCTpWs6dZwWkqkAwSfqaAgF3imWY--kb96yHgB7-TslMZQ5ChvgxDICkpqxaw_MibCA');
  const state = decode(canonical(g));
  assert.equal(state.chain[0], 'a1a832f24193d7bcf07c3d22bad7b741d8becb5a7071fdef30dfb4a69f29f5aa');
  const intent = { version: 2, epoch: g.genesis.epoch, actor: '101', event: '00000000-0000-4000-8000-000000000002',
    request: '00000000-0000-4000-8000-000000000002', revision: 0, timestamp: time,
    payload: { kind: 'offer', to: '202', category: 'review', title: 'Café ☕ review', body: 'Line 1\n\t«quoted» \\ "x" 🚀', ttlHours: 168 } };
  assert.equal(intentDigest(intent), 'f52ab2bfd7b7c11ea29b510c0edaee12f4ef125f3dc22f0de342f90fe959f32c');
  const ledger = append(state, intent, a, time);
  assert.equal(ledger.events[0].signature, 'naG95GsvrFDcGuDB6PSPJsUP6kZyssGnfNyYOF1y4yDZ4VCUJGN7svzbAZoPnosHs2gEuLYN3wI9dQD00QX9Dg');
  assert.equal(sha256(canonical(ledger)), '9c51e9d7cc5297312db8b9cd620f4f4d92e5bb379a97ac0b60197bf179474ebd');
  assert.equal(decode(canonical(ledger)).requests.get(intent.request).context.digest,
    'b18f6adda6e827acce5763ee676894101bfc33b811eca359b3d4dc6a1d7a07bb');
  assert.ok(receiptMatches(ledger.events[0], intent));
  assert.ok(!receiptMatches(ledger.events[0], { ...intent, revision: 1 }));
});

test('versions: a protocol 1 ledger fails with exit 2 and fresh-mailbox advice; v1 signatures are never reinterpreted', () => {
  const a = seeded(1), b = seeded(33);
  // A genesis signed exactly as Agentshake 0.1 does: version 1, domain agentshake/v1/genesis.
  const document = { version: 1, epoch: randomUUID(), channel: 'file:x', branch: 'local',
    roster: [{ account: '1', key: a.publicKey }, { account: '2', key: b.publicKey }] };
  const v1 = canonical({ genesis: { ...document, signature: sign(null,
    Buffer.from(`agentshake/v1/genesis\0${canonical(document)}`), a.privateKey).toString('base64url') }, events: [] });
  assert.throws(() => decode(v1), error => error.code === 2 && /protocol 1 ledger/.test(error.message) && /fresh mailbox/.test(error.next));
  // Relabeling a v1 genesis as version 2 does not verify: the signing domain differs.
  const relabeled = JSON.parse(v1);
  relabeled.genesis.version = 2;
  assert.throws(() => decode(canonical(relabeled)), error => error.code === 6 && /genesis signature/.test(error.message));
  const future = JSON.parse(canonical(fresh().ledger));
  future.genesis.version = 3;
  assert.throws(() => decode(canonical(future)), error => error.code === 6 && /Unsupported mailbox protocol version 3/.test(error.message));
});

test('tampering, unknown fields and non-canonical bytes are integrity failures', () => {
  const state = fresh();
  const next = apply(state, event(state, '1', randomUUID(), offer()), alice);
  const altered = structuredClone(next.ledger);
  altered.events[0].payload.body = 'Different';
  assert.throws(() => decode(canonical(altered)), error => error.code === 6 && /Signature/.test(error.message));
  const relinked = structuredClone(next.ledger);
  relinked.events[0].previous = '0'.repeat(64);
  assert.throws(() => decode(canonical(relinked)), /chain/);
  assert.throws(() => decode(canonical({ ...next.ledger, unknown: true })), /schema/);
  const extraField = structuredClone(next.ledger);
  extraField.events[0].payload.admin = true;
  assert.throws(() => decode(canonical(extraField)), /schema/);
  const oldKind = structuredClone(next.ledger);
  oldKind.events[0].payload.kind = 'create';
  assert.throws(() => decode(canonical(oldKind)), /schema/);
  assert.throws(() => decode(canonical(next.ledger) + '\n'), /canonical/);
  assert.throws(() => decode('{"genesis":'), /valid JSON/);
  assert.throws(() => decode(' '.repeat(MAX_LEDGER + 1)), /byte cap/);
  const genesisSwap = structuredClone(next.ledger);
  genesisSwap.genesis.roster[1].key = newKey().publicKey;
  assert.throws(() => decode(canonical(genesisSwap)), /genesis signature/);
});

test('roles: the sender cannot ask, confirm or accept; the recipient cannot supply; wrong audience and controls are refused', () => {
  let state = fresh();
  const request = randomUUID();
  assert.throws(() => decode(forge(state, event(state, '1', request, offer('evil \u001b[2J')), alice)), /schema/);
  assert.throws(() => decode(forge(state, event(state, '1', request, offer('x', { to: '3' })), alice)), /paired account/);
  assert.throws(() => decode(forge(state, event(state, '1', request, offer('x', { to: '1' })), alice)), /paired account/);
  assert.throws(() => decode(forge(state, event(state, '2', request, offer()), alice)), /Signature/);
  state = apply(state, event(state, '1', request, offer()), alice);
  // The sender cannot self-confirm or self-accept, nor ask; signatures are valid, the transition is not.
  assert.throws(() => decode(forge(state, event(state, '1', request, confirm(state, request)), alice)), /Only the recipient can confirm/);
  assert.throws(() => decode(forge(state, event(state, '1', request, ask(state, request)), alice)), /Only the recipient can ask/);
  assert.throws(() => decode(forge(state, event(state, '2', request, note(state, request)), bob)), /Only the requester can supply/);
  state = apply(state, event(state, '2', request, confirm(state, request)), bob);
  assert.throws(() => decode(forge(state, event(state, '1', request, accept(state, request)), alice)), /Only the recipient/);
  assert.throws(() => apply(state, event(state, '2', request, { kind: 'cancel' }), bob), /Only the requester/);
  assert.throws(() => apply(state, event(state, '1', request, { kind: 'decline' }), alice), /Only the recipient/);
  // Replies are post-accept only.
  assert.throws(() => apply(state, event(state, '1', request, { kind: 'reply', body: 'early' }), alice), /accepted request/);
  const forged = event(state, '2', request, accept(state, request));
  assert.throws(() => decode(forge(state, { ...forged, revision: 0 }, bob)), /changed/);
  assert.throws(() => decode(forge(state, { ...forged, timestamp: time + HOUR }, bob)), /expired/);
  assert.throws(() => decode(forge(state, { ...forged, timestamp: time - 1 }, bob)), /clock is behind/);
  assert.throws(() => decode(forge(state, { ...forged, epoch: randomUUID() }, bob)), /epoch/);
  const replayed = { ...state.ledger.events[0] };
  assert.throws(() => decode(canonical({ ...state.ledger, events: [...state.ledger.events, { ...replayed, previous: state.chain.at(-1) }] })),
    /Signature|event identity/);
});

test('negotiation: answers bind to the open round and the current context; supply invalidates confirmation; accept cites it', () => {
  let state = fresh();
  const request = randomUUID(), other = randomUUID();
  state = apply(state, event(state, '1', request, offer()), alice);
  state = apply(state, event(state, '1', other, offer()), alice);
  const first = ctx(state, request);
  assert.equal(state.requests.get(request).context.revision, 1);
  // Accept without a confirmation is impossible.
  assert.throws(() => decode(forge(state, event(state, '2', request,
    { kind: 'accept', context: first, confirmation: randomUUID() }), bob)), /needs a confirmation/);
  state = apply(state, event(state, '2', request, ask(state, request, 3)), bob);
  state = apply(state, event(state, '2', other, ask(state, other, 1)), bob);
  const round = state.requests.get(request).open;
  assert.throws(() => apply(state, event(state, '2', request, ask(state, request, 1)), bob), /already open/);
  assert.throws(() => apply(state, event(state, '2', request, confirm(state, request)), bob), /still open/);
  assert.throws(() => apply(state, event(state, '1', request, note(state, request)), alice), /Answer the open questions first/);
  // Cross-request forgery: answering this request with the other request's round.
  const foreign = { ...supply(state, request, ['supplied', 'supplied', 'supplied']), ask: state.requests.get(other).open };
  assert.throws(() => decode(forge(state, event(state, '1', request, foreign), alice)), /does not answer the open question round/);
  assert.throws(() => decode(forge(state, event(state, '1', request, { ...foreign, ask: randomUUID() }), alice)), /does not answer/);
  // Skipped, duplicated, reordered or extra answers.
  const base = supply(state, request, ['supplied', 'supplied', 'supplied']);
  for (const bad of [base.answers.slice(0, 2), [base.answers[0], base.answers[0], base.answers[2]],
    [base.answers[1], base.answers[0], base.answers[2]], [...base.answers, { item: 4, status: 'withheld' }]]) {
    assert.throws(() => decode(forge(state, event(state, '1', request, { ...base, answers: bad }), alice)), /exactly once/);
  }
  assert.throws(() => decode(forge(state, event(state, '1', request, { ...base, context: '0'.repeat(64) }), alice)), /context changed/);
  assert.throws(() => decode(forge(state, event(state, '1', request,
    { ...base, answers: [{ item: 1, status: 'supplied' }, ...base.answers.slice(1)] }), alice)), /schema/, 'supplied needs a body');
  const answer = event(state, '1', request, supply(state, request, ['supplied', 'unavailable', 'withheld']));
  state = apply(state, answer, alice);
  const r = state.requests.get(request);
  assert.equal(r.context.revision, 2);
  assert.notEqual(r.context.digest, first);
  assert.equal(r.open, undefined);
  assert.deepEqual(gapsOf(r), [{ ask: round, item: 2, status: 'unavailable' }, { ask: round, item: 3, status: 'withheld' }]);
  // Replay of the same supply content under a new event ID: the round is closed and the context moved.
  assert.throws(() => decode(forge(state, { ...answer, event: randomUUID(), revision: r.revision }, alice)), /context changed|does not answer/);
  // A confirmation must list the known limitations exactly.
  assert.throws(() => apply(state, event(state, '2', request, { ...confirm(state, request), gaps: [] }), bob), /known limitations/);
  assert.throws(() => apply(state, event(state, '2', request, { ...confirm(state, request), gaps: gapsOf(r).slice(1) }), bob), /known limitations/);
  state = apply(state, event(state, '2', request, confirm(state, request)), bob);
  const stale = accept(state, request);
  assert.throws(() => apply(state, event(state, '2', request, confirm(state, request)), bob), /already confirmed/);
  // A new supply makes the confirmation stale; citing it is refused even with a forged revision.
  state = apply(state, event(state, '1', request, note(state, request, 'Also check jitter')), alice);
  assert.equal(state.requests.get(request).context.revision, 3);
  assert.throws(() => decode(forge(state, event(state, '2', request, stale), bob)), /context changed/);
  assert.throws(() => decode(forge(state, event(state, '2', request, { ...stale, context: ctx(state, request) }), bob)),
    /needs a confirmation/);
  state = apply(state, event(state, '2', request, confirm(state, request, 'Now with jitter')), bob);
  assert.throws(() => apply(state, event(state, '2', request, { ...accept(state, request), confirmation: stale.confirmation }), bob),
    /current confirmation/);
  state = apply(state, event(state, '2', request, accept(state, request)), bob);
  const done = state.requests.get(request);
  assert.equal(done.state, 'accepted');
  assert.deepEqual(done.accepted, { confirmation: done.confirmation, context: done.context.digest });
  // After acceptance the context is frozen.
  for (const [actor, key, payload] of [['2', bob, { kind: 'ask', context: ctx(state, request), items: items(1) }],
    ['1', alice, note(state, request)], ['2', bob, { ...confirm(state, request), understanding: 'again' }]]) {
    assert.throws(() => decode(forge(state, event(state, actor, request, payload), key)), /closed at acceptance/);
  }
  const reply = event(state, '2', request, { kind: 'reply', body: 'Done' });
  state = apply(state, reply, bob);
  state = apply(state, event(state, '2', request, { kind: 'complete', reply: reply.event, outcome: 'completed' }), bob);
  assert.equal(state.requests.get(request).state, 'completed');
});

test('bounds: items per round, answered rounds, text sizes, TTL and the per-request cap', () => {
  let state = fresh();
  assert.throws(() => apply(state, event(state, '1', randomUUID(), offer('x'.repeat(4097))), alice), /Invalid/);
  assert.throws(() => apply(state, event(state, '1', randomUUID(), offer('x', { title: 'é'.repeat(121) })), alice), /Invalid/);
  assert.throws(() => apply(state, event(state, '1', randomUUID(), offer('x', { ttlHours: 337 })), alice), /Invalid/);
  const request = randomUUID();
  state = apply(state, event(state, '1', request, offer('x', { ttlHours: 24 })), alice);
  assert.throws(() => apply(state, event(state, '2', request, ask(state, request, 6)), bob), /at most 5/);
  assert.throws(() => apply(state, event(state, '2', request, { ...ask(state, request, 1), items: [{ topic: 't', need: 'n'.repeat(513) }] }), bob), /Invalid/);
  assert.throws(() => apply(state, event(state, '2', request, { ...confirm(state, request), understanding: 'u'.repeat(2049) }), bob), /Invalid/);
  for (let round = 0; round < 4; round++) {
    state = apply(state, event(state, '2', request, ask(state, request, 5)), bob);
    const big = answers('supplied', 'supplied', 'supplied', 'supplied', 'supplied').map(a => ({ ...a, body: 'b'.repeat(800) }));
    assert.throws(() => apply(state, event(state, '1', request, { ...supply(state, request, []), answers: big.map(a => ({ ...a, body: 'b'.repeat(900) })) }), alice),
      /together exceed/);
    state = apply(state, event(state, '1', request, { ...supply(state, request, []), answers: big }), alice);
  }
  assert.equal(state.requests.get(request).context.revision, 5);
  assert.throws(() => apply(state, event(state, '2', request, ask(state, request, 1)), bob), /budget/);
  assert.throws(() => apply(state, event(state, '1', request, note(state, request)), alice), /budget/);
  state = apply(state, event(state, '2', request, confirm(state, request)), bob);
  state = apply(state, event(state, '2', request, accept(state, request)), bob);
  // Replies fill the rest; the recipient's closing path stays reserved.
  for (let n = 0; ; n++) {
    try { state = apply(state, event(state, '1', request, { kind: 'reply', body: 'clarify' }), alice); }
    catch (error) { assert.match(error.message, /event cap/); break; }
  }
  const reply = event(state, '2', request, { kind: 'reply', body: 'Done' });
  state = apply(state, reply, bob);
  state = apply(state, event(state, '2', request, { kind: 'complete', reply: reply.event, outcome: 'failed' }), bob);
  assert.equal(state.requests.get(request).revision, 32);
});

test('capacity: a malicious filler cannot consume the reserved path to close or to finish an agreed handshake', () => {
  let state = fresh();
  // Bob's open question rounds reserve their answers; Alice's offers reserve confirm, accept, reply and close.
  const ids = [];
  for (;;) {
    const request = randomUUID();
    try { state = apply(state, event(state, '1', request, offer('"'.repeat(4096), { ttlHours: 24 })), alice); ids.push(request); }
    catch (error) { assert.match(error.message, /capacity/); assert.equal(error.code, 4); break; }
    try { state = apply(state, event(state, '2', request, ask(state, request, 5)), bob); }
    catch (error) { assert.match(error.message, /capacity/); break; }
  }
  assert.ok(ids.length >= 4, `admitted ${ids.length}`);
  const usage = capacity(state.requests, state.ledger);
  assert.ok(usage.bytes + usage.reservedBytes <= MAX_LEDGER);
  assert.ok(usage.events + usage.reservedEvents <= 128);
  // A peer filling the mailbox with discretionary events is refused before the reservation.
  const filler = ids.find(id => !state.requests.get(id).open);
  if (filler) assert.throws(() => apply(state, event(state, '2', filler, ask(state, filler, 5)), bob), /capacity/);
  // Every admitted request can still finish its whole agreed path with maximum-size text.
  for (const id of ids) {
    if (state.requests.get(id).open) {
      const big = answers('supplied').map(a => ({ ...a, body: '\\'.repeat(4096) }));
      const n = state.requests.get(id).negotiation.find(e => e.id === state.requests.get(id).open).items.length;
      const full = Array.from({ length: n }, (_, i) => i === 0 ? big[0] : { item: i + 1, status: 'withheld' });
      state = apply(state, event(state, '1', id, { ...supply(state, id, []), answers: full }), alice);
    }
    state = apply(state, event(state, '2', id, confirm(state, id, '\\'.repeat(2048))), bob);
    state = apply(state, event(state, '2', id, accept(state, id)), bob);
    const answer = event(state, '2', id, { kind: 'reply', body: '\\'.repeat(4096) });
    state = apply(state, answer, bob);
    state = apply(state, event(state, '2', id, { kind: 'complete', reply: answer.event, outcome: 'completed' }), bob);
  }
});

test('confirmation invalidation keeps reservations valid: an unsolicited note that cannot fit is refused, closing still works', () => {
  let state = fresh();
  const ids = [];
  for (;;) {
    const request = randomUUID();
    try { state = apply(state, event(state, '1', request, offer('"'.repeat(4096), { ttlHours: 24 })), alice); }
    catch { break; }
    ids.push(request);
    state = apply(state, event(state, '2', request, confirm(state, request)), bob);
  }
  // Each confirmed request needs no confirm reservation; a note would re-reserve it.
  let refused = 0;
  for (const id of ids) {
    try { state = apply(state, event(state, '1', id, note(state, id, '"'.repeat(4096))), alice); }
    catch (error) { assert.match(error.message, /capacity/); refused++; }
  }
  assert.ok(refused >= 1, 'at least one note was refused for capacity');
  for (const id of ids) {
    if (!state.requests.get(id).confirmation || state.requests.get(id).negotiation.at(-1).kind !== 'confirm') {
      state = apply(state, event(state, '2', id, confirm(state, id, '"'.repeat(2048))), bob);
    }
    state = apply(state, event(state, '2', id, accept(state, id)), bob);
    const answer = event(state, '2', id, { kind: 'reply', body: '"'.repeat(4096) });
    state = apply(state, answer, bob);
    state = apply(state, event(state, '2', id, { kind: 'complete', reply: answer.event, outcome: 'completed' }), bob);
  }
});

test('decline, cancel and expiry work at every negotiation phase', () => {
  let state = fresh();
  const asked = randomUUID(), confirmed = randomUUID(), expiring = randomUUID();
  for (const id of [asked, confirmed, expiring]) state = apply(state, event(state, '1', id, offer()), alice);
  state = apply(state, event(state, '2', asked, ask(state, asked, 1)), bob);
  state = apply(state, event(state, '2', asked, { kind: 'decline' }), bob);
  assert.equal(state.requests.get(asked).state, 'declined');
  assert.throws(() => apply(state, event(state, '1', asked, supply(state, asked, ['supplied'])), alice), /already declined/);
  state = apply(state, event(state, '2', confirmed, confirm(state, confirmed)), bob);
  state = apply(state, event(state, '1', confirmed, { kind: 'cancel' }), alice);
  assert.throws(() => apply(state, event(state, '2', confirmed, accept(state, confirmed)), bob), /already canceled/);
  state = apply(state, event(state, '2', expiring, ask(state, expiring, 1)), bob);
  assert.equal(stateAt(state.requests.get(expiring), time + HOUR), 'expired');
  assert.throws(() => apply(state, event(state, '1', expiring, supply(state, expiring, ['supplied'])), alice, time + HOUR), /expired/);
  assert.throws(() => decode(forge(state, event(state, '1', expiring, supply(state, expiring, ['supplied']), time + HOUR), alice)), /expired/);
  assert.throws(() => apply(state, { ...event(state, '2', expiring, { kind: 'decline' }), timestamp: time + 10 * 60_000 }, bob, time),
    /ahead of the local clock/);
});

test('resolutions: only explicit, signed resolution of an unresolved negative item of this request clears it from the gaps', () => {
  let state = fresh();
  const request = randomUUID(), other = randomUUID();
  state = apply(state, event(state, '1', request, offer('x', { ttlHours: 24 })), alice);
  state = apply(state, event(state, '1', other, offer('x', { ttlHours: 24 })), alice);
  state = apply(state, event(state, '2', request, ask(state, request, 3)), bob);
  const round = state.requests.get(request).open;
  state = apply(state, event(state, '1', request, supply(state, request, ['supplied', 'unavailable', 'withheld'])), alice);
  state = apply(state, event(state, '2', other, ask(state, other, 1)), bob);
  const foreignRound = state.requests.get(other).open;
  state = apply(state, event(state, '1', other, supply(state, other, ['unavailable'])), alice);
  state = apply(state, event(state, '2', request, confirm(state, request)), bob);
  const oldConfirmation = state.requests.get(request).confirmation;
  const resolve = (refs, extra = {}) => ({ kind: 'supply', context: ctx(state, request), answers: [],
    resolutions: refs.map(([askId, item, body = 'Recovered log line']) => ({ ask: askId, item, body })), ...extra });
  // Refused: supplied item, unknown item, foreign request's item, unknown round, duplicate ref, empty evidence.
  for (const [refs, pattern] of [[[[round, 1]], /unresolved/], [[[round, 4]], /unresolved/], [[[foreignRound, 1]], /unresolved/],
    [[[randomUUID(), 2]], /unresolved/], [[[round, 2], [round, 2]], /once per supply/]]) {
    assert.throws(() => decode(forge(state, event(state, '1', request, resolve(refs)), alice)), pattern);
  }
  assert.throws(() => decode(forge(state, event(state, '1', request, resolve([[round, 2, '']])), alice)), /schema/);
  assert.throws(() => decode(forge(state, event(state, '1', request, resolve([[round, 2, 'e'.repeat(4097)]])), alice)), /schema/);
  assert.throws(() => apply(state, event(state, '1', request, resolve([[round, 2, 'e'.repeat(3000)]], { note: 'n'.repeat(1200) })), alice),
    /together exceed/);
  assert.throws(() => decode(forge(state, event(state, '2', request, resolve([[round, 2]])), bob)), /Only the requester/);
  assert.throws(() => decode(forge(state, event(state, '1', request, { ...resolve([[round, 2]]), context: '0'.repeat(64) }), alice)), /context changed/);
  // Accepted: the unavailable item is resolved; the withheld one remains; history is intact.
  const resolution = event(state, '1', request, resolve([[round, 2]]));
  state = apply(state, resolution, alice);
  const r = state.requests.get(request);
  assert.deepEqual(gapsOf(r), [{ ask: round, item: 3, status: 'withheld' }]);
  assert.equal(r.negotiation.find(entry => entry.kind === 'supply' && entry.ask === round).answers[1].status, 'unavailable');
  assert.equal(r.confirmation, undefined, 'a resolution makes the old confirmation stale');
  assert.throws(() => apply(state, event(state, '2', request, { kind: 'accept', context: ctx(state, request), confirmation: oldConfirmation }), bob),
    /needs a confirmation/);
  // The confirmation must list exactly the remaining unresolved items, not the history.
  assert.throws(() => apply(state, event(state, '2', request, { ...confirm(state, request),
    gaps: [{ ask: round, item: 2, status: 'unavailable' }, { ask: round, item: 3, status: 'withheld' }] }), bob), /known limitations/);
  // A resolution cannot be claimed twice, nor replayed under a new event ID.
  assert.throws(() => apply(state, event(state, '1', request, resolve([[round, 2]])), alice), /unresolved/);
  assert.throws(() => decode(forge(state, { ...resolution, event: randomUUID(), revision: r.revision }, alice)), /context changed|unresolved/);
  // A resolution can ride on the answer to a new round, but never on that round's own new answers.
  state = apply(state, event(state, '2', request, ask(state, request, 1)), bob);
  const round2 = state.requests.get(request).open;
  assert.throws(() => decode(forge(state, event(state, '1', request,
    { ...supply(state, request, ['withheld']), resolutions: [{ ask: round2, item: 1, body: 'x' }] }), alice)), /unresolved/);
  state = apply(state, event(state, '1', request,
    { ...supply(state, request, ['supplied']), resolutions: [{ ask: round, item: 3, body: 'Settings: limit 5.' }] }), alice);
  assert.deepEqual(gapsOf(state.requests.get(request)), []);
  state = apply(state, event(state, '2', request, confirm(state, request)), bob);
  assert.deepEqual(state.requests.get(request).negotiation.at(-1).gaps, []);
  state = apply(state, event(state, '2', request, accept(state, request)), bob);
  assert.equal(state.requests.get(request).state, 'accepted');
  // The resolution budget is the supply budget.
  assert.equal(state.requests.get(request).supplies, 3);
});

test('replay holds every historical prefix to the writer reservation, not only the final snapshot', () => {
  let state = fresh();
  for (;;) {
    try { state = apply(state, event(state, '1', randomUUID(), offer('"'.repeat(4096), { ttlHours: 24 })), alice); }
    catch (error) { assert.match(error.message, /capacity/); break; }
  }
  // Find a validly signed offer that the writer would refuse (its reservation does not fit), followed
  // by a validly signed cancel that frees the reservation so the final snapshot alone looks fine.
  let found = false;
  for (let length = 1; length <= 4096 && !found; length += 64) {
    const request = randomUUID();
    const first = event(state, '1', request, offer('"'.repeat(length), { ttlHours: 24 }));
    assert.throws(() => preflight(state, first, time), /capacity/, 'the writer refuses this offer');
    const withOffer = JSON.parse(forge(state, first, alice));
    const requests = structuredClone(state.requests);
    transition(requests, first, state.ledger.genesis.roster);
    const chainHead = sha256(canonical(withOffer.events.at(-1)));
    const cancel = { ...event(state, '1', request, { kind: 'cancel' }), revision: 1 };
    const document = { ...cancel, previous: chainHead };
    const signature = sign(null, signingBytes('event', document), alice.privateKey).toString('base64url');
    const ledger = { genesis: withOffer.genesis, events: [...withOffer.events, { ...document, signature }] };
    transition(requests, cancel, state.ledger.genesis.roster);
    if (!capacity(requests, ledger).ok) continue;
    found = true;
    assert.throws(() => decode(canonical(ledger)), error => error.code === 6 && /capacity/.test(error.message));
  }
  assert.ok(found, 'constructed a history whose final snapshot fits but whose prefix violated the reservation');
});

test('expiry refusals from preflight and append name the next step for the acting role', () => {
  let state = fresh();
  const pending = randomUUID(), taken = randomUUID();
  state = apply(state, event(state, '1', pending, offer()), alice);
  state = accepted(state, taken);
  const deadline = time + HOUR;
  const expect = (fn, pattern) => assert.throws(fn, error => error.code === 4 && /expired/.test(error.message) && pattern.test(error.next));
  // At the exact deadline, through the wall-clock check used by preflight and append (and so by recovery).
  expect(() => preflight(state, event(state, '1', pending, note(state, pending)), deadline), /Send a new offer/);
  expect(() => preflight(state, event(state, '2', pending, ask(state, pending, 1)), deadline), /Ask the requester/);
  expect(() => preflight(state, event(state, '1', taken, { kind: 'reply', body: 'late' }), deadline), /Send a new offer/);
  expect(() => preflight(state, event(state, '2', taken, { kind: 'reply', body: 'late' }), deadline), /Ask the requester/);
  expect(() => append(state, event(state, '2', taken, { kind: 'reply', body: 'late' }), bob, deadline), /Ask the requester/);
  // A signer whose timestamp is past the deadline is refused by the transition with the same advice.
  expect(() => apply(state, event(state, '1', pending, note(state, pending), deadline), alice, deadline - 1000), /Send a new offer/);
  expect(() => apply(state, event(state, '2', pending, ask(state, pending, 1), deadline), bob, deadline - 1000), /Ask the requester/);
});

test('preflight makes the same decision as append without a key or signature, and changes nothing', () => {
  let state = fresh();
  const request = randomUUID();
  state = accepted(state, request);
  const snapshot = canonical(state.ledger);
  assert.throws(() => preflight(state, event(state, '2', request, { kind: 'decline' }), time), /no longer pending/);
  assert.throws(() => preflight(state, event(state, '1', request, note(state, request)), time), /closed at acceptance/);
  assert.throws(() => preflight(state, { ...event(state, '2', request, { kind: 'cancel' }) }, time), /Only the requester/);
  assert.doesNotThrow(() => preflight(state, event(state, '1', request, { kind: 'reply', body: 'ok' }), time));
  assert.equal(canonical(state.ledger), snapshot);
  let budget = fresh();
  const limited = randomUUID();
  budget = apply(budget, event(budget, '1', limited, offer('x', { ttlHours: 24 })), alice);
  for (let n = 0; n < 4; n++) budget = apply(budget, event(budget, '1', limited, note(budget, limited, `n${n}`)), alice);
  assert.throws(() => preflight(budget, event(budget, '2', limited, ask(budget, limited, 1)), time), /budget/);
});
