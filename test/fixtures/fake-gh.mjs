// A stand-in for `gh api graphql` used by test/github.test.mjs. It emulates only the
// four static documents Agentshake sends, with GitHub-like semantics for private
// repositories, collaborators, expectedHeadOid and Git blob object IDs, plus injected
// faults. It is a test double: passing tests against it does not prove live GitHub behavior.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const expected = ['api', 'graphql', '--hostname', 'github.com', '--input', '-'];
if (JSON.stringify(args) !== JSON.stringify(expected)) {
  process.stderr.write('fake-gh: unexpected argv ' + JSON.stringify(args) + '\n');
  process.exit(2);
}
const config = process.env.GH_CONFIG_DIR;
if (!config || !existsSync(join(config, 'viewer.json'))) {
  process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\n');
  process.exit(4);
}
const viewer = JSON.parse(readFileSync(join(config, 'viewer.json'), 'utf8'));
const statePath = readFileSync(join(config, 'state-path'), 'utf8').trim();
const body = JSON.parse(readFileSync(0, 'utf8'));
const operation = /^(query|mutation) (\w+)/.exec(body.query)?.[2];

const lock = statePath + '.lock';
for (let i = 0; ; i++) {
  try { mkdirSync(lock); break; } catch { if (i > 4000) process.exit(9); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); }
}
let state;
let exitCode = 0;
try {
  state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.log.push({ viewer: viewer.id, operation });
  // A fault applies to the first matching call after `skip` matching calls have passed.
  const matching = state.faults.filter(f => f.operation === operation && (!f.viewer || f.viewer === viewer.id));
  const fault = matching.find(f => !f.skip);
  for (const f of matching) if (f !== fault && f.skip) f.skip--;
  if (fault) state.faults.splice(state.faults.indexOf(fault), 1);
  exitCode = handle(fault);
  writeFileSync(statePath + '.tmp', JSON.stringify(state));
  renameSync(statePath + '.tmp', statePath);
} finally { rmdirSync(lock); }
process.exit(exitCode);

function out(value) { process.stdout.write(JSON.stringify(value)); }
function blobOid(text) {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
}
function graphError(type, message, data = null) {
  out({ data, errors: [{ type, message }] });
  process.stderr.write(`gh: ${message}\n`);
  return 1;
}
function head(repo) { return repo.commits.at(-1); }
function commit(repo, files) {
  const oid = randomBytes(20).toString('hex');
  repo.commits.push({ oid, files: { ...head(repo).files, ...files } });
  return oid;
}

function handle(fault) {
  if (fault?.kind === 'http401') { process.stderr.write('gh: Bad credentials (HTTP 401)\n'); return 1; }
  if (fault?.kind === 'rate') { process.stderr.write('gh: API rate limit exceeded (HTTP 403)\n'); return 1; }
  if (fault?.kind === 'graphRate') return graphError('RATE_LIMITED', 'API rate limit exceeded');
  if (fault?.kind === 'http502') { process.stderr.write('gh: HTTP 502\n'); return 1; }
  if (fault?.kind === 'oversize') { process.stdout.write('{"data":"' + 'x'.repeat(3 * 1024 * 1024) + '"}'); return 0; }
  if (fault?.kind === 'garbage') { process.stdout.write('<html>proxy error</html>'); return 0; }
  const me = { databaseId: viewer.id, login: viewer.login };
  if (operation === 'AgentshakeUser') {
    const id = state.users[body.variables.login.toLowerCase()];
    if (!id) return graphError('NOT_FOUND', "Could not resolve to a User with the login of '" + body.variables.login + "'.", { user: null });
    out({ data: { user: { databaseId: id, login: body.variables.login.toLowerCase() } } });
    return 0;
  }
  if (operation === 'AgentshakeMailbox') {
    const name = `${body.variables.owner}/${body.variables.repo}`.toLowerCase();
    const repo = state.repos[name];
    if (!repo || !repo.access.includes(viewer.id)) {
      return graphError('NOT_FOUND', `Could not resolve to a Repository with the name '${name}'.`, { viewer: me, repository: null });
    }
    out({ data: { viewer: me, repository: { id: repo.id, isPrivate: repo.private,
      defaultBranchRef: repo.commits.length ? { id: repo.branchId, name: repo.branch, target: { oid: head(repo).oid } } : null } } });
    return 0;
  }
  if (operation === 'AgentshakeLedger') {
    const repo = Object.values(state.repos).find(r => r.id === body.variables.id && r.access.includes(viewer.id));
    if (!repo) return graphError('NOT_FOUND', 'Could not resolve to a node', { viewer: me, node: null });
    const [oid, path] = body.variables.expr.split(':');
    const text = repo.commits.find(c => c.oid === oid)?.files[path];
    let object = null;
    if (text !== undefined) {
      object = { __typename: 'Blob', oid: blobOid(text), byteSize: Buffer.byteLength(text), isBinary: false, isTruncated: false, text };
      if (fault?.kind === 'truncated') object = { ...object, isTruncated: true, text: text.slice(0, 10) };
      if (fault?.kind === 'badoid') object = { ...object, text: text.replace('"events":[', '"events":[ ').slice(0, Buffer.byteLength(text)) };
    }
    out({ data: { viewer: me, node: { isPrivate: repo.private, object } } });
    return 0;
  }
  if (operation === 'AgentshakeAppend') {
    const input = body.variables.input;
    const repo = Object.values(state.repos).find(r => r.branchId === input.branch.id);
    if (!repo || !repo.access.includes(viewer.id)) return graphError('NOT_FOUND', 'Could not resolve to a node');
    if (!repo.writers.includes(viewer.id)) {
      return graphError('FORBIDDEN', `${viewer.login} does not have the correct permissions to execute \`CreateCommitOnBranch\``);
    }
    if (fault?.kind === 'advance') commit(repo, { 'README.md': 'unrelated change ' + randomBytes(4).toString('hex') });
    if (fault?.kind === 'fail502') { process.stderr.write('gh: HTTP 502\n'); return 1; }
    if (head(repo).oid !== input.expectedHeadOid) {
      return graphError('STALE_DATA', `Expected branch to point to "${input.expectedHeadOid}" but it did not`);
    }
    const additions = Object.fromEntries(input.fileChanges.additions.map(a => [a.path, Buffer.from(a.contents, 'base64').toString('utf8')]));
    state.commitsBy ??= {};
    const oid = commit(repo, additions);
    state.commitsBy[oid] = { viewer: viewer.id, headline: input.message.headline, paths: Object.keys(additions) };
    if (fault?.kind === 'commitThenFail') { process.stderr.write('gh: HTTP 502\n'); return 1; }
    out({ data: { createCommitOnBranch: { commit: { oid } } } });
    return 0;
  }
  process.stderr.write('fake-gh: unknown document\n');
  return 2;
}
