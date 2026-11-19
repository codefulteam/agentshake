// Application layer: pairing, staged operations, conditional append with bounded retry,
// receipt verification, recovery and local brief release. Transport-agnostic.
import * as z from 'zod';
import { access, accountSchema, AgentshakeError, append, assertKey, bodySchema, canonical, conflict, DAY, decode,
  genesis, idSchema, integrity, intentSchema, invalid, parsed, publicKeySchema, receiptMatches,
  stateAt, temporary, type Intent, type Payload, type Replay, type Request } from './domain.js';
import { approvalDigest, type Destination, type LocalState, Profile, releaseBrief, removeBrief } from './local.js';
import { endpointSchema, openTransport, type Endpoint, type Snapshot, type Transport } from './transport/index.js';

const pairingSchema = z.strictObject({
  endpoint: endpointSchema, account: accountSchema, peer: accountSchema, key: publicKeySchema,
  mode: z.enum(['init', 'join']), peerLabel: z.string().max(80).optional(),
  /** Transport ref identity seen at pairing (GitHub: branch ref node ID), pinned when present. */
  ref: z.string().min(1).max(500).optional()
});
export type Pairing = z.infer<typeof pairingSchema>;
const destinationSchema = z.strictObject({ inbox: z.string().min(1).max(4096), config: idSchema });
const operationSchema = z.strictObject({
  intent: intentSchema, approval: z.string().regex(/^[a-f0-9]{64}$/), brief: bodySchema.optional(),
  /** The agent inbox and exchange configuration the operator approved the brief for. */
  destination: destinationSchema.optional()
}).refine(value => (value.brief === undefined) === (value.destination === undefined), 'A brief needs its approved destination.');
export type Settled = {
  operation: string; request: string; action: Payload['kind']; state: string; revision: number;
  recorded: true; remote: 'recorded'; localBrief: LocalState; briefReleased: boolean;
};
const sameDestination = (a: Destination | undefined, b: Destination) => a !== undefined && a.inbox === b.inbox && a.config === b.config;
export type Operation = z.infer<typeof operationSchema>;
export type Context = { state: Replay; snapshot: Snapshot; pairing: Pairing };
export type Plan = { material: Record<string, unknown>; operation: Operation };
/** Writes per operation: the first attempt plus at most two retries after unrelated conflicts. */
const MAX_WRITES = 3;

function assertPairing(pairing: Pairing, key: string, snapshot: Snapshot, state: Replay) {
  const { genesis: header } = state.ledger;
  if (header.channel !== snapshot.channel || header.branch !== snapshot.branch) {
    integrity('Mailbox channel identity or branch changed since pairing.');
  }
  if (pairing.ref && snapshot.opaque?.refId && snapshot.opaque.refId !== pairing.ref) {
    integrity('The mailbox branch ref was replaced since pairing.', 'Do not continue. Compare `agentshake doctor` with your peer.');
  }
  if (snapshot.account !== pairing.account) {
    access(`Authenticated account ${snapshot.account} is not the paired account ${pairing.account}.`,
      pairing.endpoint.type === 'github' ? 'Switch accounts with `gh auth switch`, or use the matching --profile.' : undefined);
  }
  if (!header.roster.some(actor => actor.account === pairing.account && actor.key === key) ||
      !header.roster.some(actor => actor.account === pairing.peer && actor.key === pairing.key)) {
    access('Mailbox roster does not match the pinned accounts and keys.',
      'Verify both public keys out of band. A new key or peer requires a new mailbox.');
  }
}

export class Mailbox {
  constructor(readonly profile: Profile, private adapter?: Transport, readonly clock: () => number = Date.now) {}

  private locked<T>(action: () => Promise<T>): Promise<T> {
    const release = this.profile.lock();
    return action().finally(release);
  }

  pair(endpoint: Endpoint, peer: string, peerKey: string, mode: 'init' | 'join', peerLabel?: string) {
    return this.locked(async () => {
      const key = this.profile.key();
      assertKey(peerKey);
      parsed(accountSchema, peer, 'peer account ID');
      const adapter = this.adapter ?? openTransport(endpoint);
      let snapshot = await adapter.read();
      if (snapshot.account === peer) invalid('The peer account is your own account. Pair two distinct accounts.');
      if (key.publicKey === peerKey) invalid('The peer key is your own key. Use the key printed on the other machine.');
      if (!snapshot.raw && mode === 'join') {
        conflict('The mailbox has not been initialized yet.', 'Ask the owner to run `agentshake channel init` first.');
      }
      const value: Pairing = { endpoint, account: snapshot.account, peer, key: peerKey, mode,
        ...(peerLabel ? { peerLabel } : {}), ...(snapshot.opaque?.refId ? { ref: snapshot.opaque.refId } : {}) };
      const provisional = this.profile.get('genesis');
      if (mode === 'init' && provisional === undefined && snapshot.raw) {
        conflict('This mailbox is already initialized.', 'Use `agentshake channel join` with the owner\'s public key.');
      }
      if (mode === 'join' && snapshot.raw) assertPairing(value, key.publicKey, snapshot, decode(snapshot.raw));
      const pairing = parsed(pairingSchema, this.profile.once('pairing', value), 'pairing', 'integrity');
      if (canonical({ ...value, peerLabel: undefined }) !== canonical({ ...pairing, peerLabel: undefined })) {
        conflict('This profile is already paired with a different mailbox or peer.',
          'Use a separate profile: `agentshake --profile <dir> ...` or AGENTSHAKE_HOME.');
      }
      if (mode === 'init') {
        const raw = provisional === undefined ? canonical(
          genesis(snapshot.channel, snapshot.branch, snapshot.account, key, { account: peer, key: peerKey })
        ) : String(provisional);
        const initial = String(this.profile.once('genesis', raw));
        const seed = decode(initial);
        assertPairing(pairing, key.publicKey, snapshot, seed);
        if (!snapshot.raw) {
          this.profile.bind(seed.chain);
          const written = await adapter.write(snapshot, initial);
          if (written === 'denied') {
            access('The transport refused the initial write.', 'Check write permission on the mailbox, then rerun the same command.');
          }
          snapshot = await adapter.read();
        }
        if (!snapshot.raw) return temporary('Initialization is unconfirmed.', 'Rerun the same `channel init` command.');
        if (decode(snapshot.raw).chain[0] !== seed.chain[0]) integrity('A different initialization already exists in this mailbox.');
      }
      return this.read(snapshot);
    });
  }

  pairing(): Pairing {
    const value = this.profile.get('pairing');
    if (!value) return invalid('This profile is not paired.', 'Run `agentshake channel init` (owner) or `channel join` (peer).');
    return parsed(pairingSchema, value, 'pairing', 'integrity');
  }

  private transport(pairing: Pairing) { return this.adapter ?? openTransport(pairing.endpoint); }

  async read(existing?: Snapshot): Promise<Context> {
    const key = this.profile.key();
    const pairing = this.pairing();
    const snapshot = existing ?? await this.transport(pairing).read();
    if (snapshot.raw === null) {
      return conflict('The mailbox ledger is missing.',
        pairing.mode === 'init' ? 'Rerun the same `channel init` command.' : 'Ask the owner to rerun `channel init`.');
    }
    const state = decode(snapshot.raw);
    assertPairing(pairing, key.publicKey, snapshot, state);
    this.profile.bind(state.chain);
    return { state, snapshot, pairing };
  }

  /** Reads and removes local briefs for requests that are canceled, declined or expired. */
  async sync(): Promise<Context & { pruned: string[] }> {
    const context = await this.read();
    const pruned: string[] = [];
    if (this.profile.get('exchange') !== undefined) {
      const { inbox } = this.profile.exchange();
      for (const request of context.state.requests.values()) {
        const status = stateAt(request, this.clock());
        if ((status === 'canceled' || status === 'declined' || status === 'expired') && removeBrief(inbox, request.id)) {
          pruned.push(request.id);
        }
      }
    }
    return { ...context, pruned };
  }

  /**
   * Builds the intent and the approval material. With a brief, the material and the staged
   * operation also bind the current agent inbox and exchange configuration identity.
   */
  prepare(context: Context, request: string, event: string, payload: Payload, brief?: string): Plan {
    parsed(idSchema, request, 'request ID');
    parsed(idSchema, event, 'operation ID');
    const expected = context.state.requests.get(request)?.revision ?? 0;
    const destination = brief !== undefined ? this.profile.destination() : undefined;
    const material = { channel: context.snapshot.channel, epoch: context.state.ledger.genesis.epoch,
      actor: context.pairing.account, request, revision: expected, payload,
      ...(brief !== undefined ? { brief, destination } : {}) };
    const intent: Intent = { version: 1, epoch: material.epoch, actor: material.actor,
      event, request, revision: expected, timestamp: this.clock(), payload };
    return { material, operation: { intent, approval: approvalDigest(material),
      ...(brief !== undefined ? { brief, destination } : {}) } };
  }

  execute(operation: Operation) {
    return this.locked(async () => {
      parsed(operationSchema, operation, 'operation');
      if (operation.brief !== undefined && !sameDestination(operation.destination, this.profile.destination())) {
        conflict('The agent exchange was reconfigured after this brief was reviewed.', 'Run the command again and review the new destination.');
      }
      const existing = parsed(operationSchema,
        this.profile.stage(operation.intent.event, operation, operation.brief !== undefined ? 'pending' : 'none'), 'operation', 'integrity');
      if (existing.approval !== operation.approval) {
        conflict('This operation ID was already approved with different content.',
          `Run \`agentshake recover ${operation.intent.event}\` to finish the original.`);
      }
      return this.settle(existing.intent.event);
    });
  }

  recover(id: string) {
    parsed(idSchema, id, 'operation ID');
    return this.locked(() => this.settle(id));
  }

  private async settle(id: string): Promise<Settled> {
    const saved = this.profile.operation(id);
    if (!saved) return invalid('Operation not found in this profile.', 'Run `agentshake pending` to list unfinished operations.');
    const { intent, brief, destination } = parsed(operationSchema, saved.value, 'operation', 'integrity');
    const adapter = this.transport(this.pairing());
    let context = await this.read();
    for (let writes = 0; ; writes++) {
      const receipt = context.state.receipts.get(id);
      if (receipt) {
        if (!receiptMatches(receipt, intent)) integrity('This operation ID is bound to a different event in the mailbox.');
        const request = context.state.requests.get(intent.request)!;
        const status = stateAt(request, this.clock());
        const summary = { operation: id, request: request.id, action: intent.payload.kind, state: status,
          revision: receipt.revision + 1, recorded: true as const, remote: 'recorded' as const };
        // Remote receipt first: it is durable even if the local step below fails.
        if (!saved.done) this.profile.recorded(id, summary);
        let local = this.profile.operation(id)!.local;
        if (brief !== undefined && (local === 'pending' || local === 'held-destination-changed')) {
          local = this.releaseApproved(id, request, context.pairing.account, brief, destination!, receipt.revision + 1, status);
        }
        return { ...summary, localBrief: local, briefReleased: local === 'released' };
      }
      if (saved.done) integrity('A recorded operation is missing from the mailbox history.');
      if (writes >= MAX_WRITES) break;
      let ledger;
      try { ledger = append(context.state, intent, this.profile.key(), this.clock()); }
      catch (error) {
        // Nothing for this intent can land on a history that already moved past it, and
        // the observed prefix is pinned, so the staged intent is safe to drop.
        if (error instanceof AgentshakeError && (error.reason === 'conflict' || error.reason === 'access')) {
          this.profile.discard(id);
        }
        throw error;
      }
      let result: Awaited<ReturnType<Transport['write']>>;
      try { result = await adapter.write(context.snapshot, canonical(ledger)); }
      catch { result = 'unknown'; }
      try { context = await this.read(); }
      catch (error) {
        if (error instanceof AgentshakeError && error.reason === 'integrity') throw error;
        return temporary('The write may or may not have landed; the receipt could not be read.',
          `Run \`agentshake recover ${id}\` when the connection is back.`);
      }
      if (context.state.receipts.has(id)) continue;
      if (result === 'denied') {
        return access('The mailbox refused the write.',
          `Check write permission and branch rules, then run \`agentshake recover ${id}\`.`);
      }
      if (result !== 'conflict') {
        return temporary('Delivery is uncertain: no receipt is visible yet.', `Run \`agentshake recover ${id}\`.`);
      }
    }
    return temporary('The mailbox kept changing during the write.', `Run \`agentshake recover ${id}\`.`);
  }

  /** Releases or replaces the local brief for an accepted or finished request (operator-authored). */
  updateBrief(id: string, body: string, plan: Plan) {
    return this.locked(async () => {
      if (!sameDestination(plan.material.destination as Destination | undefined, this.profile.destination())) {
        conflict('The agent exchange was reconfigured after this brief was reviewed.', 'Run the command again and review the new destination.');
      }
      const context = await this.read();
      const request = context.state.requests.get(id);
      if (!request) return conflict('Unknown request.', 'Run `agentshake inbox` or `agentshake outbox`.');
      if (request.revision !== plan.material.revision) {
        return conflict('The request changed since the preview.', `Run \`agentshake show ${id}\` and review again.`);
      }
      const status = stateAt(request, this.clock());
      if (status === 'expired' || status === 'canceled' || status === 'declined') {
        conflict(`The request is ${status} and closed for local work.`);
      }
      if (status === 'pending') {
        conflict('The request is still pending.', request.recipient === context.pairing.account
          ? `Accept it first: \`agentshake accept ${id}\`.` : 'Wait for the peer to accept it.');
      }
      const expires = status === 'accepted' ? request.expires : this.clock() + 7 * DAY;
      releaseBrief(this.profile.exchange().inbox, briefFor(request, context.pairing.account, body, request.revision, expires));
      // A fresh local approval supersedes any brief release held for a previous destination.
      for (const entry of this.profile.unfinished()) {
        const value = operationSchema.safeParse(entry.value);
        if (entry.done && entry.local === 'held-destination-changed' && value.success && value.data.intent.request === id) {
          this.profile.setLocal(entry.id, 'superseded');
        }
      }
      return { request: id, state: status, briefReleased: true, inbox: this.profile.exchange().inbox };
    });
  }

  /** Local brief step, after the remote receipt is recorded. Never writes to a destination other than the approved one. */
  private releaseApproved(id: string, request: Request, account: string, brief: string, destination: Destination,
      version: number, status: string): LocalState {
    let local: LocalState;
    if (status !== 'accepted') local = 'skipped-closed';
    else if (!sameDestination(destination, this.profile.destination())) local = 'held-destination-changed';
    else local = releaseBrief(destination.inbox, briefFor(request, account, brief, version), true) ? 'released' : 'already-present';
    this.profile.setLocal(id, local);
    return local;
  }

  saved(id: string) {
    const entry = this.profile.operation(id);
    return entry && { ...parsed(operationSchema, entry.value, 'operation', 'integrity'), done: entry.done,
      receipt: entry.receipt, local: entry.local };
  }

  /** Serializes exchange reconfiguration with mutations; invalidates pending brief approvals. */
  configure(paths: { inbox: string; outbox: string }, group?: string) {
    const release = this.profile.lock();
    try { return this.profile.configure(paths, group); } finally { release(); }
  }
}

function briefFor(request: Request, account: string, body: string, version: number, expires = request.expires) {
  return { request: request.id, role: request.recipient === account ? 'recipient' as const : 'sender' as const,
    category: request.category, body, expires, version };
}
