import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import * as z from 'zod';
import { access, AgentshakeError, integrity, invalid, MAX_LEDGER, parsed, temporary } from '../domain.js';
import { utf8 } from '../util.js';
import type { Snapshot, Transport, WriteResult } from './types.js';

export const repoNameSchema = z.string().max(140).regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]{1,100}$/i)
  .refine(repo => !['.', '..'].includes(repo.split('/')[1]!), 'Use owner/repo.');
export const loginSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})$/i);

/** The one fixed ledger path in the mailbox repository. */
export const LEDGER_PATH = 'agentshake-mailbox-v1.json';
const COMMIT_HEADLINE = 'Update Agentshake mailbox';
const TIMEOUT = 15_000;
const MAX_OUTPUT = 2 * 1024 * 1024;
// Forwarded so gh can find its own configuration, keychain, proxy and certificates.
const FORWARDED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS', 'GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];

const oid = z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);
const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ type: z.string().max(100).optional() }).loose()).max(100).optional()
}).loose();
const viewerSchema = z.object({ databaseId: z.int().positive(), login: loginSchema });
const identitySchema = z.object({
  viewer: viewerSchema,
  repository: z.object({
    id: z.string().min(1).max(140), isPrivate: z.boolean(),
    defaultBranchRef: z.object({ id: z.string().min(1).max(500), name: z.string().min(1).max(250),
      target: z.object({ oid }) }).nullable()
  }).nullable()
});
const blobSchema = z.object({
  viewer: viewerSchema,
  node: z.object({ isPrivate: z.literal(true), object: z.object({
    __typename: z.literal('Blob'), isTruncated: z.literal(false), isBinary: z.literal(false),
    byteSize: z.int().nonnegative().max(MAX_LEDGER), text: z.string(), oid
  }).nullable() }).nullable()
});
const userSchema = z.object({ user: z.object({ databaseId: z.int().positive(), login: loginSchema }).nullable() });
const mutationSchema = z.object({ createCommitOnBranch: z.object({ commit: z.object({ oid }) }) });

// Static documents: variables carry all data, nothing is interpolated.
export const QUERY_IDENTITY = `query AgentshakeMailbox($owner: String!, $repo: String!) {
  viewer { databaseId login }
  repository(owner: $owner, name: $repo) { id isPrivate defaultBranchRef { id name target { oid } } }
}`;
export const QUERY_LEDGER = `query AgentshakeLedger($id: ID!, $expr: String!) {
  viewer { databaseId login }
  node(id: $id) { ... on Repository { isPrivate
    object(expression: $expr) { __typename ... on Blob { oid byteSize isBinary isTruncated text } } } }
}`;
export const QUERY_USER = `query AgentshakeUser($login: String!) { user(login: $login) { databaseId login } }`;
export const MUTATION_APPEND = `mutation AgentshakeAppend($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

type GhResult = { stdout: string; exitCode: number; status?: number; rateLimited: boolean };

/** Runs `gh api graphql` with argv (no shell), a curated environment, a timeout and bounded output. */
function gh(body: unknown): Promise<GhResult> {
  const env: NodeJS.ProcessEnv = { GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' };
  for (const name of FORWARDED_ENV) if (process.env[name]) env[name] = process.env[name];
  return new Promise((resolve, reject) => {
    const child = execFile('gh', ['api', 'graphql', '--hostname', 'github.com', '--input', '-'], {
      cwd: homedir(), env, encoding: 'buffer', timeout: TIMEOUT, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
      if (failure?.code === 'ENOENT') {
        return reject(new AgentshakeError('access', 'GitHub CLI (gh) was not found on PATH.',
          'Install gh from https://cli.github.com and run `gh auth login`.'));
      }
      if (failure?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new AgentshakeError('temporary', 'GitHub response exceeded the size cap.'));
      if (failure?.killed || failure?.signal) return reject(new AgentshakeError('temporary', 'GitHub request timed out.', 'Check connectivity and retry.'));
      // Raw gh diagnostics are never surfaced: they may contain hostnames, tokens or remote text.
      const diagnostic = stderr.subarray(0, 4096).toString('latin1');
      const status = /HTTP (\d{3})/.exec(diagnostic)?.[1];
      let text: string;
      try { text = utf8(stdout); } catch (decodeError) { return reject(decodeError); }
      resolve({ stdout: text, exitCode: typeof failure?.code === 'number' ? failure.code : failure ? 1 : 0,
        status: status ? Number(status) : undefined, rateLimited: /rate limit/i.test(diagnostic) });
    });
    child.stdin?.on('error', () => { /* The exit callback owns the result. */ });
    child.stdin?.end(JSON.stringify(body));
  });
}

type Classified = { data: unknown } | { failure: 'auth' | 'denied' | 'rate' | 'unavailable' };
function classify(result: GhResult): Classified {
  if (result.status === 401 || result.exitCode === 4) return { failure: 'auth' };
  if (result.status === 429 || result.rateLimited) return { failure: 'rate' };
  let value: unknown;
  try { value = result.stdout ? JSON.parse(result.stdout) : undefined; } catch { value = undefined; }
  const envelope = envelopeSchema.safeParse(value);
  if (envelope.success && envelope.data.errors?.length) {
    const types = envelope.data.errors.map(error => error.type);
    if (types.includes('RATE_LIMITED')) return { failure: 'rate' };
    if (types.some(type => type === 'FORBIDDEN' || type === 'NOT_FOUND' || type === 'UNAUTHORIZED')) return { failure: 'denied' };
    return { failure: 'unavailable' };
  }
  if (result.status === 403 || result.status === 404) return { failure: 'denied' };
  if (result.exitCode !== 0 || !envelope.success || envelope.data.data === undefined) return { failure: 'unavailable' };
  return { data: envelope.data.data };
}

function raise(failure: Exclude<Classified, { data: unknown }>['failure'], what: string): never {
  switch (failure) {
    case 'auth': return access('GitHub CLI is not authenticated.', 'Run `gh auth login --hostname github.com`.');
    case 'rate': return temporary('GitHub rate limit reached.', 'Wait a few minutes, then retry the same command.');
    case 'denied': return access(`GitHub denied ${what}.`,
      'Check that `gh auth status` shows the paired account and that it has access to the private mailbox.');
    default: return temporary(`GitHub could not complete ${what}.`, 'Check connectivity and retry the same command.');
  }
}

async function query(body: unknown, what: string): Promise<unknown> {
  const result = classify(await gh(body));
  if ('failure' in result) raise(result.failure, what);
  return (result as { data: unknown }).data;
}

/** Verifies that `text` is exactly the Git blob named by `oid` (SHA-1 or SHA-256 object format). */
export function blobMatches(text: string, objectId: string, byteSize: number) {
  const bytes = Buffer.from(text, 'utf8');
  const digest = createHash(objectId.length === 40 ? 'sha1' : 'sha256')
    .update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
  return bytes.length === byteSize && digest === objectId;
}

/**
 * GitHub adapter: reads the head OID and the ledger blob from that exact commit, then
 * appends with createCommitOnBranch(expectedHeadOid). Authentication belongs to gh.
 */
export class GitHubTransport implements Transport {
  constructor(private repo: string) { parsed(repoNameSchema, repo, 'GitHub repository (owner/repo)'); }

  /** Resolves a GitHub login to its immutable numeric account ID. */
  static async lookupUser(login: string): Promise<{ account: string; login: string }> {
    parsed(loginSchema, login, 'GitHub login');
    const result = classify(await gh({ query: QUERY_USER, variables: { login } }));
    // GitHub answers an unknown login with a NOT_FOUND error.
    if ('failure' in result && result.failure === 'denied') return invalid(`GitHub user ${login} was not found.`);
    if ('failure' in result) return raise(result.failure, 'the user lookup');
    const data = parsed(userSchema, result.data, 'GitHub user response', 'integrity');
    if (!data.user) return invalid(`GitHub user ${login} was not found.`);
    return { account: String(data.user.databaseId), login: data.user.login };
  }

  async read(): Promise<Snapshot> {
    const [owner, repo] = this.repo.split('/');
    const identity = parsed(identitySchema,
      await query({ query: QUERY_IDENTITY, variables: { owner, repo } }, 'the mailbox lookup'),
      'GitHub mailbox identity', 'integrity');
    const { viewer, repository } = identity;
    if (!repository) return access('The mailbox repository is not visible to this GitHub account.');
    if (!repository.isPrivate) access('The mailbox repository must be private.', 'Use a dedicated private repository.');
    if (!repository.defaultBranchRef) {
      return access('The mailbox repository has no commits.', 'Create it with an initial commit (for example a README).');
    }
    const { id: refId, name: branch, target: { oid: revision } } = repository.defaultBranchRef;
    const blob = parsed(blobSchema, await query({
      query: QUERY_LEDGER, variables: { id: repository.id, expr: `${revision}:${LEDGER_PATH}` }
    }, 'the ledger read'), 'GitHub ledger blob (missing, binary, truncated or oversized)', 'integrity');
    if (blob.viewer.databaseId !== viewer.databaseId) access('The GitHub account changed during the mailbox read.');
    if (!blob.node) return access('The mailbox repository became unavailable during the read.');
    let raw: string | null = null;
    if (blob.node.object) {
      const { oid: objectId, byteSize, text } = blob.node.object;
      if (!blobMatches(text, objectId, byteSize)) integrity('GitHub ledger blob does not match its object ID.');
      raw = text;
    }
    return { transport: 'github', account: String(viewer.databaseId), accountLabel: viewer.login,
      channel: 'github:' + repository.id, branch, revision, raw, opaque: { refId } };
  }

  async write(snapshot: Snapshot, raw: string): Promise<WriteResult> {
    const refId = snapshot.opaque?.refId;
    if (!refId) return integrity('GitHub branch identity is missing.');
    const input = {
      branch: { id: refId }, expectedHeadOid: snapshot.revision,
      message: { headline: COMMIT_HEADLINE },
      fileChanges: { additions: [{ path: LEDGER_PATH, contents: Buffer.from(raw, 'utf8').toString('base64') }] }
    };
    let result: GhResult;
    try { result = await gh({ query: MUTATION_APPEND, variables: { input } }); }
    catch { return 'unknown'; }
    const outcome = classify(result);
    if ('data' in outcome) return mutationSchema.safeParse(outcome.data).success ? 'committed' : 'unknown';
    if (outcome.failure === 'denied' || outcome.failure === 'auth') return 'denied';
    // A fresh read tells a moved head (conflict) from an unchanged or unreadable one
    // without matching GitHub error text. The caller still verifies the exact receipt.
    try {
      const fresh = await this.read();
      return fresh.revision !== snapshot.revision ? 'conflict' : 'unknown';
    } catch { return 'unknown'; }
  }
}
