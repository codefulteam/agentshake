// Local state: the operator profile (key, pairing, journal, observed prefix), the
// operator-chosen exchange directories, drafts written by the agent, and briefs
// written by the operator. Nothing here touches the network.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, chownSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, opendirSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import * as z from 'zod';
import { AgentshakeError, answersSchema, bodySchema, canonical, DEFAULT_TTL_HOURS, digestSchema, gapSchema, idSchema,
  integrity, invalid, itemsSchema, MAX_BODY, MAX_ITEMS, MAX_SUPPLY_TEXT, newKey, noteSchema, parsed, publicKeySchema,
  requestKind, resolutionsSchema, supplyTextBytes, temporary, titleSchema, ttlSchema, understandingSchema } from './domain.js';
import { database, utf8 } from './util.js';

const exchangeSchema = z.strictObject({
  inbox: z.string().refine(isAbsolute), outbox: z.string().refine(isAbsolute),
  /** Changes on every `exchange configure`; binds approvals to one configuration. */
  id: idSchema,
  access: z.enum(['private', 'group']),
  gid: z.int().nonnegative().optional()
});
export type Exchange = z.infer<typeof exchangeSchema>;
export type Paths = { inbox: string; outbox: string };
export type Destination = { inbox: string; config: string };
export const draftSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('new'), category: requestKind, title: titleSchema,
    body: bodySchema, ttlHours: ttlSchema.default(DEFAULT_TTL_HOURS) }),
  z.strictObject({ action: z.literal('reply'), request: idSchema, body: bodySchema }),
  /** Recipient: ask for missing context, bound to the context digest from the operator's brief. */
  z.strictObject({ action: z.literal('ask'), request: idSchema, context: digestSchema, items: itemsSchema }),
  /**
   * Requester: answer the open question round named in the brief (`ask`), or, bound to a context,
   * add a note and/or resolve earlier unavailable or withheld items with recovered content.
   */
  z.strictObject({ action: z.literal('supply'), request: idSchema, ask: idSchema.optional(), context: digestSchema.optional(),
    answers: answersSchema.default([]), note: noteSchema.optional(), resolutions: resolutionsSchema.optional() })
    .refine(value => (value.ask === undefined) !== (value.context === undefined), 'A supply names either the ask it answers or the context it adds to.')
    .refine(value => value.ask !== undefined ? value.answers.length > 0
      : value.answers.length === 0 && (value.note !== undefined || Boolean(value.resolutions?.length)),
      'Answers need an ask; without an ask, give a note or resolutions and a context.')
    .refine(value => supplyTextBytes(value.answers, value.note, value.resolutions) <= MAX_SUPPLY_TEXT,
      `Answers, resolutions and note together exceed ${MAX_SUPPLY_TEXT} UTF-8 bytes.`),
  /** Recipient: state its understanding of the exact context named in the brief. */
  z.strictObject({ action: z.literal('confirm'), request: idSchema, context: digestSchema, understanding: understandingSchema })
]);
export type Draft = z.infer<typeof draftSchema>;
export const briefStages = ['negotiating', 'accepted', 'finished'] as const;
export const briefSchema = z.strictObject({
  request: idSchema, role: z.enum(['recipient', 'sender']), category: requestKind,
  /** negotiating: pre-accept, help the operator clarify only. accepted/finished: approved local work. */
  stage: z.enum(briefStages), authorizesWork: z.boolean(),
  body: bodySchema, expires: z.int().nonnegative(), version: z.int().nonnegative(),
  /** Binding metadata only, never remote prose: the context this brief was written for. */
  context: z.strictObject({ revision: z.int().min(1), digest: digestSchema }),
  /** While a question round is open: its ID and item count (the requester answers it; the recipient waits). */
  open: z.strictObject({ ask: idSchema, items: z.int().min(1).max(MAX_ITEMS) }).optional(),
  /** Known limitations of the context (asked items answered unavailable or withheld), by reference. */
  gaps: z.array(gapSchema).max(64)
}).refine(value => value.authorizesWork === (value.stage !== 'negotiating'), 'A negotiation brief never authorizes work.');
export type Brief = z.infer<typeof briefSchema>;
/** Outcome of the local brief step of an operation, recorded separately from the remote receipt. */
export const localStates = ['none', 'pending', 'released', 'already-present', 'skipped-closed', 'held-destination-changed',
  'superseded'] as const;
export type LocalState = typeof localStates[number];
const FILE_CAP = 32 * 1024;
const MAX_SCAN = 512;
const MAX_JOURNAL = 512;
const heldLocks = new Set<string>();
const uid = () => (typeof process.getuid === 'function' ? process.getuid() : -1);
const posix = process.platform !== 'win32';

export function jsonValue(text: string): unknown {
  try { return JSON.parse(text); } catch { return integrity('Invalid local JSON file.'); }
}

function checkedDirectory(path: string, create = false) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  let info;
  try { info = lstatSync(path); }
  catch { return invalid(`Directory not found: ${path}`, 'Check the path or run `agentshake exchange configure`.'); }
  if (!info.isDirectory() || info.isSymbolicLink()) invalid('Exchange and profile roots must be real directories, not symlinks.');
  return realpathSync(path);
}

/**
 * Operator-side path trust: every ancestor of `path` must be owned by root or the current
 * user and must not be writable by group or others unless it has the sticky bit (like /tmp).
 * This prevents another account from swapping a parent directory between check and use.
 */
export function assertTrustedAncestors(path: string) {
  if (!posix) return;
  let current = dirname(path);
  for (;;) {
    let info;
    try { info = statSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Not created yet: it will be checked once it exists.
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
      continue;
    }
    if ((info.uid !== 0 && info.uid !== uid()) || ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)) {
      invalid(`Untrusted parent directory: ${current}`,
        'Use a location whose parent directories are owned by you or root and not writable by others.');
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function assertOwned(path: string, label: string, forbidden: number) {
  if (!posix) return;
  const info = lstatSync(path);
  if (info.uid !== uid()) invalid(`${label} must be owned by the operator account: ${path}`);
  if ((info.mode & forbidden) !== 0) {
    invalid(`${label} has unsafe permissions: ${path}`, `Run: chmod ${(info.mode & 0o7777 & ~forbidden).toString(8)} ${path}`);
  }
}

function within(parent: string, child: string) {
  const part = relative(parent, child);
  return part === '' || (part !== '..' && !part.startsWith('../') && !isAbsolute(part));
}

export const defaultProfile = () => process.env.AGENTSHAKE_HOME || join(homedir(), '.agentshake');

/** Group lookup without spawning: numeric GID, or a name from /etc/group. */
export function resolveGroup(group: string): number {
  if (/^\d{1,10}$/.test(group)) return Number(group);
  if (!/^[a-z_][a-z0-9_.-]{0,63}$/i.test(group)) return invalid('Invalid group name.');
  let table = '';
  try { table = readFileSync('/etc/group', 'utf8'); } catch { /* not available */ }
  for (const line of table.split('\n')) {
    const [name, , gid] = line.split(':');
    if (name === group && gid && /^\d+$/.test(gid)) return Number(gid);
  }
  return invalid(`Group ${group} was not found in /etc/group.`, 'Pass the numeric group ID instead: --group <gid>.');
}

export class Profile {
  readonly root: string;
  private db;
  constructor(root = defaultProfile()) {
    const requested = resolve(root);
    assertTrustedAncestors(requested);
    this.root = checkedDirectory(requested, true);
    assertTrustedAncestors(this.root);
    assertOwned(this.root, 'The profile directory', 0o077);
    const file = join(this.root, 'operator.sqlite');
    this.db = database(file);
    try { assertOwned(file, 'The profile database', 0o077); }
    catch (error) { this.db.close(); throw error; }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, value TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL DEFAULT 0, receipt TEXT, local TEXT NOT NULL DEFAULT 'none');
      CREATE TABLE IF NOT EXISTS observation (slot INTEGER PRIMARY KEY, count INTEGER NOT NULL, digest TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  get(name: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(name);
    return row ? jsonValue(String(row.value)) : undefined;
  }
  set(name: string, value: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(name, canonical(value));
  }
  once(name: string, value: unknown) {
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run(name, canonical(value));
    return this.get(name);
  }
  key(create = false) {
    let value = this.get('key');
    if (!value && create) value = this.once('key', newKey());
    if (!value) return invalid('This profile has no key yet.', 'Run `agentshake key init`.');
    return parsed(z.strictObject({ publicKey: publicKeySchema, privateKey: z.string().max(400) }), value, 'operator key', 'integrity');
  }
  /** Pins the longest observed signed prefix and rejects any history that does not extend it. */
  bind(chain: string[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const seen = this.db.prepare('SELECT count, digest FROM observation WHERE slot = 1').get();
      if (seen && chain[Number(seen.count)] !== seen.digest) {
        integrity('Mailbox rollback or fork detected: the remote history no longer contains what this profile saw.',
          'Do not continue. Compare `agentshake doctor` on both sides and treat the mailbox as compromised.');
      }
      if (!seen || chain.length - 1 > Number(seen.count)) {
        this.db.prepare('INSERT OR REPLACE INTO observation VALUES (1, ?, ?)').run(chain.length - 1, chain.at(-1)!);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  observed() {
    const row = this.db.prepare('SELECT count, digest FROM observation WHERE slot = 1').get();
    return row ? { events: Number(row.count), digest: String(row.digest) } : undefined;
  }
  /** Stages an operation before any network contact. Returns the first staged value for this ID. */
  stage(id: string, value: unknown, local: LocalState): unknown {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.operation(id);
      if (!existing) {
        const row = this.db.prepare('SELECT count(*) AS count FROM operations WHERE done = 0').get()!;
        if (Number(row.count) >= MAX_JOURNAL) invalid('Too many unfinished operations.', 'Run `agentshake pending` and recover them.');
        this.db.prepare('INSERT INTO operations (id, value, created, local) VALUES (?, ?, ?, ?)')
          .run(id, canonical(value), Date.now(), local);
      }
      this.db.exec('COMMIT');
      return existing?.value ?? value;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  operation(id: string): { value: unknown; done: boolean; receipt?: unknown; local: LocalState } | undefined {
    const row = this.db.prepare('SELECT value, done, receipt, local FROM operations WHERE id = ?').get(id);
    if (!row) return undefined;
    const local = String(row.local) as LocalState;
    return { value: jsonValue(String(row.value)), done: row.done === 1,
      receipt: row.receipt === null ? undefined : jsonValue(String(row.receipt)),
      local: localStates.includes(local) ? local : 'pending' };
  }
  /** Operations whose remote receipt or local brief step is not settled. */
  unfinished(): { id: string; value: unknown; done: boolean; local: LocalState }[] {
    return this.db.prepare(`SELECT id, value, done, local FROM operations
        WHERE done = 0 OR local IN ('pending', 'held-destination-changed') ORDER BY created LIMIT 64`).all()
      .map(row => ({ id: String(row.id), value: jsonValue(String(row.value)), done: row.done === 1,
        local: String(row.local) as LocalState }));
  }
  /** Records the verified remote receipt. The local step is tracked separately. */
  recorded(id: string, receipt: unknown) {
    this.db.prepare('UPDATE operations SET done = 1, receipt = ? WHERE id = ?').run(canonical(receipt), id);
  }
  setLocal(id: string, local: LocalState) { this.db.prepare('UPDATE operations SET local = ? WHERE id = ?').run(local, id); }
  /** Drops a staged operation that was rejected before any write could have landed. */
  discard(id: string) { this.db.prepare('DELETE FROM operations WHERE id = ? AND done = 0').run(id); }

  /**
   * One mutation at a time per profile. The lock is an exclusive SQLite transaction on
   * lock.sqlite, i.e. an OS file lock that the kernel releases if the process dies; there is
   * no PID file to publish or take over.
   */
  lock(): () => void {
    if (heldLocks.has(this.root)) temporary('Another agentshake command is changing this profile.', 'Wait for it to finish, then retry.');
    const file = join(this.root, 'lock.sqlite');
    const db = database(file);
    try {
      db.exec('PRAGMA busy_timeout=0');
      db.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      db.close();
      if (/locked|busy/i.test(String((error as Error).message))) {
        temporary('Another agentshake command is changing this profile.', 'Wait for it to finish, then retry.');
      }
      throw error;
    }
    heldLocks.add(this.root);
    return () => {
      heldLocks.delete(this.root);
      try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ }
      db.close();
    };
  }

  /** Must be called while holding lock(). A new configuration identity invalidates pending brief approvals. */
  configure(paths: Paths, group?: string) {
    const requested = [resolve(paths.inbox), resolve(paths.outbox)] as const;
    for (const path of requested) {
      if (within(path, this.root) || within(this.root, path)) invalid('Exchange paths must stay outside the operator profile.');
      assertTrustedAncestors(path);
    }
    const inbox = checkedDirectory(requested[0], true), outbox = checkedDirectory(requested[1], true);
    if (within(inbox, outbox) || within(outbox, inbox)) invalid('Inbox and outbox must be separate directories.');
    for (const path of [inbox, outbox]) {
      if (within(path, this.root) || within(this.root, path)) invalid('Exchange paths must stay outside the operator profile.');
      assertTrustedAncestors(path);
      if (posix && lstatSync(path).uid !== uid()) invalid(`Exchange directories must be owned by the operator account: ${path}`);
    }
    let gid: number | undefined;
    if (group !== undefined) {
      gid = resolveGroup(group);
      for (const path of [inbox, outbox]) chownSync(path, -1, gid);
      // Inbox: operator writes, group reads. Outbox: group (agent) writes, operator reads.
      // setgid keeps the group on files created inside (Linux; BSD/macOS always inherit).
      chmodSync(inbox, 0o2750);
      chmodSync(outbox, 0o2770);
    } else {
      chmodSync(inbox, 0o700);
      chmodSync(outbox, 0o700);
    }
    const previous = this.get('exchange');
    const value: Exchange = { inbox, outbox, id: randomUUID(), access: group === undefined ? 'private' : 'group',
      ...(gid !== undefined ? { gid } : {}) };
    this.set('exchange', value);
    const old = previous ? exchangeSchema.safeParse(previous) : undefined;
    return { ...value, replaced: Boolean(old?.success && (old.data.inbox !== inbox || old.data.outbox !== outbox)) };
  }
  exchange(): Exchange {
    const value = this.get('exchange');
    if (!value) {
      return invalid('Local agent directories are not configured.',
        'Run `agentshake exchange configure --inbox <dir> --outbox <dir>`.');
    }
    const result = exchangeSchema.safeParse(value);
    if (!result.success) return invalid('The exchange configuration is from an older version.', 'Run `agentshake exchange configure` again.');
    return result.data;
  }
  destination(): Destination {
    const { inbox, id } = this.exchange();
    return { inbox, config: id };
  }
}

function slot(id: string) { return parsed(idSchema, id, 'ID (expected a UUID)') + '.json'; }

/** Reads one regular, single-link file without following symlinks, with a byte cap. */
export function readFileBounded(path: string, limit: number): string {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') return invalid('Symlinked input is refused.');
    if (code === 'ENOENT') return invalid(`File not found: ${path}`);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) invalid('Input must be a regular file.');
    if (stat.nlink !== 1) invalid('Hard-linked input is refused.');
    if (stat.size > limit) invalid(`Input exceeds ${limit} bytes.`);
    const data = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > limit) invalid(`Input exceeds ${limit} bytes.`);
    return utf8(data.subarray(0, length));
  } finally { closeSync(fd); }
}

export async function readStdinBounded(limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += (chunk as Buffer).length;
    if (length > limit) { process.stdin.destroy(); invalid(`Input exceeds ${limit} bytes.`); }
    chunks.push(chunk as Buffer);
  }
  return utf8(Buffer.concat(chunks));
}

/** Body text from a file path or "-" for stdin. A single trailing newline is removed. */
export async function inputBody(path: string): Promise<string> {
  const text = path === '-' ? await readStdinBounded(MAX_BODY + 1) : readFileBounded(path, MAX_BODY + 1);
  return parsed(bodySchema, text.replace(/\r?\n$/, ''), 'body');
}

/** Text from a file path or "-" for stdin, validated by `schema`. A single trailing newline is removed. */
export async function inputText(path: string, schema: z.ZodType<string>, label: string, max: number): Promise<string> {
  const text = path === '-' ? await readStdinBounded(max + 1) : readFileBounded(path, max + 1);
  return parsed(schema, text.replace(/\r?\n$/, ''), label);
}

/** A bounded JSON document from a file path or "-" for stdin. */
export async function inputJson(path: string): Promise<unknown> {
  const text = path === '-' ? await readStdinBounded(FILE_CAP) : readFileBounded(path, FILE_CAP);
  try { return JSON.parse(text); } catch { return invalid('The input file is not valid JSON.'); }
}

function syncDirectory(directory: string) {
  if (!posix) return;
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Atomic write into a fixed directory: exclusive temp file, fsync, rename, then fsync of
 * the directory. Files are group-readable only when the
 * directory itself grants group access (the shared-group exchange mode).
 */
function writeAtomic(directory: string, name: string, value: unknown): boolean {
  const root = checkedDirectory(directory);
  const mode = posix && (statSync(root).mode & 0o070) !== 0 ? 0o640 : 0o600;
  const temp = join(root, '.tmp-' + randomUUID());
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  let created = false;
  try {
    try { if (posix) fchmodSync(fd, mode); writeFileSync(fd, canonical(value)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, join(root, name));
    created = true;
  } finally {
    try { unlinkSync(temp); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  syncDirectory(root);
  return created;
}

export function createDraft(outbox: string, value: unknown) {
  const draft = parsed(draftSchema, value, 'draft');
  const id = randomUUID();
  writeAtomic(outbox, slot(id), draft);
  return { draft: id, action: draft.action, ...(draft.action !== 'new' ? { request: draft.request } : {}) };
}

export function loadDraft(outbox: string, id: string): Draft {
  const text = readFileBounded(join(checkedDirectory(outbox), slot(id)), FILE_CAP);
  return parsed(draftSchema, jsonValue(text), 'draft');
}

/** Writes (atomically replaces) the brief file for its request. */
export function releaseBrief(inbox: string, brief: Brief) {
  const entry = parsed(briefSchema, brief, 'local brief');
  return writeAtomic(inbox, slot(entry.request), entry);
}

/** Operator-side look at a released brief, ignoring expiry. Undefined when absent or unreadable. */
export function inspectBrief(inbox: string, id: string): Brief | undefined {
  try {
    const brief = briefSchema.safeParse(jsonValue(readFileBounded(join(checkedDirectory(inbox), slot(id)), FILE_CAP)));
    return brief.success && brief.data.request === id ? brief.data : undefined;
  } catch { return undefined; }
}

export function removeBrief(inbox: string, request: string) {
  const root = checkedDirectory(inbox);
  try { unlinkSync(join(root, slot(request))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  syncDirectory(root);
  return true;
}

export function readBrief(inbox: string, id: string, now = Date.now()): Brief {
  const path = join(checkedDirectory(inbox), slot(id));
  let text: string;
  try { text = readFileBounded(path, FILE_CAP); }
  catch (error) {
    if (error instanceof AgentshakeError && error.message.startsWith('File not found')) {
      return invalid('No approved brief for this request.', 'Ask your operator to accept the request or release a brief.');
    }
    throw error;
  }
  const brief = parsed(briefSchema, jsonValue(text), 'brief', 'integrity');
  if (brief.request !== id) integrity('Brief ID does not match its file name.');
  if (now >= brief.expires) invalid('This brief has expired.', 'Ask your operator for a new brief.');
  return brief;
}

export function listBriefs(inbox: string, now = Date.now()) {
  const result: Omit<Brief, 'body'>[] = [];
  const directory = opendirSync(checkedDirectory(inbox));
  try {
    for (let count = 0; count < MAX_SCAN; count++) {
      const entry = directory.readSync();
      if (!entry) return result.sort((a, b) => a.expires - b.expires);
      const id = entry.name.slice(0, -5);
      if (!entry.isFile() || !entry.name.endsWith('.json') || !idSchema.safeParse(id).success) continue;
      try {
        const { body: _body, ...meta } = readBrief(inbox, id, now);
        result.push(meta);
      } catch { /* Unreadable or expired entries give the agent no context. */ }
    }
    return invalid('Inbox scan limit reached.');
  } finally { directory.closeSync(); }
}

export const approvalDigest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

