#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join, resolve } from 'node:path';
import { ReadStream, WriteStream } from 'node:tty';
import { Command, CommanderError, Option } from 'commander';
import { AgentshakeError, bodySchema, conflict, temporary, DEFAULT_TTL_HOURS, fingerprint, idSchema, invalid, MAX_BODY,
  MAX_TTL_HOURS, MIN_TTL_HOURS, outcomeSchema, parsed, requestKind, stateAt, capacity, accountSchema,
  type Payload, type Request } from './domain.js';
import { approvalDigest, createDraft, defaultProfile, inputBody, listBriefs, loadDraft, Profile, readBrief,
  readFileBounded } from './local.js';
import { Mailbox, type Context, type Pairing, type Plan, type Settled } from './mailbox.js';
import { describeEndpoint, endpointSchema, GitHubTransport, type Endpoint } from './transport/index.js';
import { display, guard, inline, safeJson } from './util.js';
import { VERSION } from './version.js';

type Output = { data: unknown; human?: string; next?: string | string[] };
const program = new Command();
program.name('agentshake').version(VERSION, '-v, --version')
  .description('A handshake between your coding agents: operator-approved requests and results\n' +
    'between two developers, over a private GitHub repository (or a local file for the demo).')
  .addOption(new Option('--profile <dir>', 'operator profile directory').env('AGENTSHAKE_HOME')
    .default(undefined, '~/.agentshake'))
  .option('--json', 'machine-readable output on stdout')
  .showHelpAfterError('(run with --help for usage)')
  .showSuggestionAfterError()
  .exitOverride()
  .configureOutput({ writeErr: value => process.stderr.write(guard(value)), writeOut: value => process.stdout.write(value) })
  .addHelpText('after', `
Quick start (no GitHub account needed):
  agentshake demo                 run a complete two-person exchange offline

Exit codes: 0 ok, 2 usage/input, 3 auth/access, 4 state conflict, 5 temporary/uncertain, 6 integrity.
Docs: https://github.com/codefulteam/agentshake#readme`);

const json = () => Boolean(program.opts().json);
function emit(output: Output) {
  const next = output.next === undefined ? [] : Array.isArray(output.next) ? output.next : [output.next];
  if (json()) {
    const data = output.data !== null && typeof output.data === 'object' && !Array.isArray(output.data)
      ? { ...output.data as object, ...(next.length ? { next } : {}) } : output.data;
    process.stdout.write(safeJson(data) + '\n');
    return;
  }
  const text = output.human ?? safeJson(output.data, 2);
  process.stdout.write(guard(text) + '\n');
  for (const line of next) process.stdout.write(guard('next: ' + line) + '\n');
}

function profileRoot() { return program.opts().profile ?? defaultProfile(); }
function withProfile<A extends unknown[]>(action: (mailbox: Mailbox, ...args: A) => Promise<Output> | Output) {
  return async (...args: A) => {
    const profile = new Profile(profileRoot());
    try { emit(await action(new Mailbox(profile), ...args)); }
    finally { profile.close(); }
  };
}

// ---------- helpers ----------
const id = (value: string, label = 'ID') => parsed(idSchema, value, `${label} (expected a UUID)`);
const short = (value: string) => value.slice(0, 8);
function ago(ms: number, now: number) {
  const delta = ms - now;
  const abs = Math.abs(delta);
  const text = abs >= 86_400_000 ? `${Math.floor(abs / 86_400_000)}d ${Math.floor(abs % 86_400_000 / 3_600_000)}h`
    : abs >= 3_600_000 ? `${Math.floor(abs / 3_600_000)}h ${Math.floor(abs % 3_600_000 / 60_000)}m`
    : `${Math.max(1, Math.floor(abs / 60_000))}m`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}
function who(account: string, context: Context) {
  if (account === context.pairing.account) return 'you';
  return context.pairing.peerLabel ? `${context.pairing.peerLabel} (${account})` : `peer ${account}`;
}
function summary(request: Request, now: number) {
  return { id: request.id, kind: request.category, state: stateAt(request, now), sender: request.sender,
    recipient: request.recipient, revision: request.revision, replies: request.replies.length,
    created: new Date(request.created).toISOString(), expires: new Date(request.expires).toISOString(),
    updated: new Date(request.updated).toISOString() };
}

/** Opens the controlling terminal for confirmation, independent of stdin/stdout redirection. */
function terminal(): { input: ReadStream; output: WriteStream; close: () => void } | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const fd = openSync('/dev/tty', constants.O_RDWR | constants.O_NOCTTY);
    const input = new ReadStream(fd);
    const output = new WriteStream(fd);
    return { input, output, close: () => { input.destroy(); output.destroy(); } };
  } catch { return undefined; }
}

async function confirm(preview: string, question: string): Promise<boolean | undefined> {
  const tty = terminal();
  if (!tty) return undefined;
  const prompt = createInterface({ input: tty.input, output: tty.output });
  try {
    tty.output.write(guard(preview) + '\n');
    return (await prompt.question(question)).trim().toLowerCase() === 'yes';
  } catch { return false; /* EOF or interrupt: not approved */ }
  finally { prompt.close(); tty.close(); }
}

type ApprovalOptions = { preview?: boolean; approve?: string };
function approvalOptions(command: Command) {
  return command
    .option('--preview', 'print the exact action and its approval digest, then stop')
    .option('--approve <digest>', 'approve non-interactively with the digest printed by --preview');
}

/**
 * Strict operator approval. Either an interactive "yes" on the controlling terminal, or
 * a --approve digest that matches exactly what --preview showed. Returns an Output to
 * print instead of executing, or undefined when approved.
 */
async function approve(material: unknown, options: ApprovalOptions, human: string, approveCommand: string)
    : Promise<Output | undefined> {
  const digest = approvalDigest(material);
  if (options.preview && options.approve) invalid('Use either --preview or --approve, not both.');
  const next = `${approveCommand} --approve ${digest}`;
  const text = `${human}\napproval digest: ${digest}`;
  if (options.preview) return { data: { approved: false, digest, action: material }, human: text, next };
  if (options.approve) {
    if (options.approve !== digest) {
      conflict('The approval digest does not match the current action.', 'Run the command with --preview and review again.');
    }
    return undefined;
  }
  const local = material !== null && typeof material === 'object' && 'localBrief' in material;
  const answer = await confirm(text, local ? 'Release this local brief to your agent? Type "yes": '
    : 'Sign and send exactly this? Type "yes" to approve: ');
  if (answer === undefined) {
    return invalid('Operator approval is required and no terminal is available.',
      'Run again with --preview, review the output, then pass --approve <digest>.');
  }
  if (!answer) return invalid('Not approved. Nothing was sent.');
  return undefined;
}

function indent(text: string) { return text.split('\n').map(line => '  │ ' + line).join('\n'); }

/** Opens $VISUAL/$EDITOR on a blank file inside the profile; returns the trimmed text. */
function editBrief(profile: Profile, request: string): string {
  const editor = (process.env.VISUAL || process.env.EDITOR || 'vi').trim();
  const argv = editor.split(/\s+/).filter(Boolean);
  const tty = terminal();
  if (!tty) invalid('No terminal is available for the brief editor.', 'Pass --body-file <path> (or - for stdin) with the brief text.');
  tty!.close();
  const directory = join(profile.root, 'edit');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const stale of readdirSync(directory)) { try { unlinkSync(join(directory, stale)); } catch { /* ignore */ } }
  const file = join(directory, `brief-${short(request)}-${randomUUID()}.md`);
  writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
  try {
    const result = spawnSync(argv[0]!, [...argv.slice(1), file], { stdio: 'inherit' });
    if (result.error || result.status !== 0) invalid('The editor exited without saving a brief. Nothing was changed.');
    const text = readFileBounded(file, MAX_BODY + 1).replace(/\s+$/, '');
    if (!text) invalid('The brief is empty. Nothing was changed.');
    return text;
  } finally { try { unlinkSync(file); } catch { /* ignore */ } }
}

async function briefText(mailbox: Mailbox, request: string, options: { bodyFile?: string; preview?: boolean; approve?: string }) {
  if (options.bodyFile) return inputBody(options.bodyFile);
  if (options.preview || options.approve) {
    return invalid('--preview and --approve need the same --body-file each time.', 'Write the brief to a file and pass --body-file.');
  }
  return parsed(bodySchema, editBrief(mailbox.profile, request), 'brief');
}

// ---------- key ----------
const key = program.command('key').description('manage this operator\'s Ed25519 signing key');
key.command('init').description('create the signing key (once per profile)').action(withProfile(mailbox => {
  const existed = mailbox.profile.get('key') !== undefined;
  const { publicKey } = mailbox.profile.key(true);
  return { data: { publicKey, fingerprint: fingerprint(publicKey), created: !existed },
    human: `${existed ? 'Key already exists' : 'Created signing key'}.\npublic key:  ${publicKey}\nfingerprint: ${fingerprint(publicKey)}`,
    next: 'Send the public key to your peer over a channel you already trust, and verify theirs by fingerprint.' };
}));
key.command('show').description('print the public key and fingerprint').action(withProfile(mailbox => {
  const { publicKey } = mailbox.profile.key();
  return { data: { publicKey, fingerprint: fingerprint(publicKey) },
    human: `public key:  ${publicKey}\nfingerprint: ${fingerprint(publicKey)}` };
}));

// ---------- channel ----------
const channel = program.command('channel').description('pair two accounts and keys on one mailbox');
for (const mode of ['init', 'join'] as const) {
  channel.command(mode)
    .description(mode === 'init' ? 'create the signed mailbox genesis (owner, once)' : 'verify and pin a mailbox the owner created')
    .option('--repo <owner/repo>', 'private, dedicated GitHub mailbox repository')
    .option('--file <path>', 'local SQLite mailbox file (offline demo transport, unauthenticated)')
    .option('--account <id>', 'with --file: your numeric account ID (self-declared)')
    .requiredOption('--peer <login-or-id>', 'peer GitHub login or numeric account ID')
    .requiredOption('--peer-key <key>', 'peer public key, verified out of band')
    .addHelpText('after', mode === 'init' ? `
Examples:
  agentshake channel init --repo alice/relay-mailbox --peer bob --peer-key <bob-public-key>
  agentshake channel init --file /tmp/demo.sqlite --account 1 --peer 2 --peer-key <key>` : `
Example:
  agentshake channel join --repo alice/relay-mailbox --peer alice --peer-key <alice-public-key>`)
    .action(withProfile(async (mailbox, options: { repo?: string; file?: string; account?: string; peer: string; peerKey: string }) => {
      if (Boolean(options.repo) === Boolean(options.file)) invalid('Choose exactly one of --repo or --file.');
      if (options.repo && options.account) invalid('--account is only for --file; GitHub identifies you through gh.');
      if (options.file && !options.account) invalid('--file needs --account <numeric id>.');
      const endpoint: Endpoint = parsed(endpointSchema, options.repo ? { type: 'github', repo: options.repo } :
        { type: 'file', path: resolve(options.file!), account: options.account }, 'mailbox endpoint');
      let peer = options.peer;
      let peerLabel: string | undefined;
      if (!accountSchema.safeParse(peer).success) {
        if (endpoint.type !== 'github') invalid('With --file, --peer must be a numeric account ID.');
        const user = await GitHubTransport.lookupUser(peer);
        peer = user.account;
        peerLabel = user.login;
      }
      const context = await mailbox.pair(endpoint, peer, options.peerKey, mode, peerLabel);
      const me = context.snapshot.accountLabel ?? context.snapshot.account;
      const target = endpoint.type === 'github' ? `--repo ${endpoint.repo}` : `--file ${endpoint.path}`;
      const { publicKey } = mailbox.profile.key();
      return {
        data: { paired: true, mode, transport: endpoint.type, account: context.snapshot.account,
          accountLabel: context.snapshot.accountLabel, peer, peerLabel, channel: context.snapshot.channel,
          branch: context.snapshot.branch, epoch: context.state.ledger.genesis.epoch },
        human: `Paired (${mode}) on ${describeEndpoint(endpoint)}.\n` +
          `you: ${me}   peer: ${peerLabel ?? peer}   epoch: ${context.state.ledger.genesis.epoch}`,
        next: mode === 'init'
          ? [`Peer runs: agentshake channel join ${target} --peer ${endpoint.type === 'github' ? me : context.snapshot.account} --peer-key ${publicKey}${endpoint.type === 'file' ? ` --account ${peer}` : ''}`,
            'Then connect your agent: agentshake exchange configure --inbox <dir> --outbox <dir>']
          : ['agentshake exchange configure --inbox <dir> --outbox <dir>', 'agentshake doctor']
      };
    }));
}

// ---------- doctor ----------
program.command('doctor').description('check key, pairing, transport identity, history and capacity')
  .action(withProfile(async mailbox => {
    const { snapshot, pairing, state } = await mailbox.read();
    const cap = capacity(state.requests, state.ledger);
    const exchange = mailbox.profile.get('exchange') ? mailbox.profile.exchange() : undefined;
    const unfinished = mailbox.profile.unfinished().length;
    const data = { ok: true, transport: pairing.endpoint.type, endpoint: describeEndpoint(pairing.endpoint),
      account: snapshot.account, accountLabel: snapshot.accountLabel, peer: pairing.peer, peerLabel: pairing.peerLabel,
      channel: snapshot.channel, branch: snapshot.branch, revision: snapshot.revision, epoch: state.ledger.genesis.epoch,
      events: state.ledger.events.length, requests: state.requests.size,
      capacity: { bytes: cap.bytes, reservedBytes: cap.reservedBytes, reservedEvents: cap.reservedEvents, ok: cap.ok },
      observedPrefix: mailbox.profile.observed(), exchange, unfinishedOperations: unfinished };
    const next: string[] = [];
    if (!exchange) next.push('Connect your agent: agentshake exchange configure --inbox <dir> --outbox <dir>');
    if (unfinished) next.push('Finish interrupted work: agentshake pending');
    if (!cap.ok) next.push('Mailbox is near capacity: settle live requests, then pair a new mailbox.');
    if (!next.length) next.push('agentshake inbox');
    return { data, next, human: [
      `ok        transport ${describeEndpoint(pairing.endpoint)}`,
      `ok        signed in as ${snapshot.accountLabel ?? snapshot.account} (${snapshot.account}); peer ${pairing.peerLabel ?? pairing.peer}`,
      `ok        channel ${snapshot.channel} branch ${snapshot.branch}`,
      `ok        history verified: ${state.ledger.events.length} events, ${state.requests.size} requests, epoch ${state.ledger.genesis.epoch}`,
      `${cap.ok ? 'ok      ' : 'warn    '}  capacity ${cap.bytes + cap.reservedBytes} of ${256 * 1024} bytes reserved, ${state.ledger.events.length + cap.reservedEvents} of 128 events`,
      `${exchange ? 'ok      ' : 'todo    '}  agent exchange ${exchange ? `inbox ${exchange.inbox}, outbox ${exchange.outbox}` : 'not configured'}`,
      `${unfinished ? 'todo    ' : 'ok      '}  unfinished operations: ${unfinished}`
    ].join('\n') };
  }));

// ---------- exchange ----------
const exchange = program.command('exchange').description('local directories shared with your agent');
exchange.command('configure').description('set the agent inbox (briefs, mount read-only) and outbox (drafts)')
  .requiredOption('--inbox <dir>', 'directory where approved briefs are released')
  .requiredOption('--outbox <dir>', 'directory where your agent writes drafts')
  .option('--group <name-or-gid>', 'share with an agent running as another OS account in this group (inbox 2750, outbox 2770)')
  .addHelpText('after', `
Access modes:
  default   both directories 0700 and files 0600: for an agent sandbox running as your own
            OS user that can see only these two directories (for example a container or
            sandbox-exec profile with narrow mounts). See docs/agents.md.
  --group   for an agent running as a different OS account that is a member of the group.
Reconfiguring invalidates brief approvals that were not yet released.`)
  .action(withProfile((mailbox, options: { inbox: string; outbox: string; group?: string }) => {
    const paths = mailbox.configure({ inbox: options.inbox, outbox: options.outbox }, options.group);
    return { data: paths, human: `inbox:  ${paths.inbox}  (agent: read-only)\noutbox: ${paths.outbox}  (agent: read-write)\n` +
      `access: ${paths.access}${paths.gid !== undefined ? ` (group ${paths.gid})` : ''}   configuration ${paths.id}`,
      next: `Give your agent: agentshake agent --inbox ${paths.inbox} --outbox ${paths.outbox} briefs list` };
  }));
exchange.command('show').description('print the configured directories').action(withProfile(mailbox => {
  const paths = mailbox.profile.exchange();
  return { data: paths, human: `inbox:  ${paths.inbox}\noutbox: ${paths.outbox}` };
}));

// ---------- reading ----------
for (const direction of ['inbox', 'outbox'] as const) {
  program.command(direction).description(direction === 'inbox' ? 'list requests sent to you' : 'list requests you sent')
    .option('--all', 'include closed requests')
    .action(withProfile(async (mailbox, options: { all?: boolean }) => {
      const context = await mailbox.sync();
      const now = mailbox.clock();
      const list = [...context.state.requests.values()]
        .filter(request => (direction === 'inbox' ? request.recipient : request.sender) === context.pairing.account)
        .filter(request => options.all || ['pending', 'accepted'].includes(stateAt(request, now)))
        .sort((a, b) => b.updated - a.updated);
      const rows = list.map(request => summary(request, now));
      const human = rows.length === 0
        ? `${direction === 'inbox' ? 'Inbox' : 'Outbox'} is empty${options.all ? '' : ' (no open requests; --all shows closed ones)'}.`
        : rows.map(row => `${row.id}  ${row.state.padEnd(9)} ${row.kind.padEnd(8)} ${String(row.replies).padStart(2)} replies  ` +
            `${row.state === 'pending' || row.state === 'accepted' ? 'expires ' + ago(Date.parse(row.expires), now) : 'updated ' + ago(Date.parse(row.updated), now)}`).join('\n');
      const pending = rows.find(row => row.state === 'pending');
      const next = rows.length === 0
        ? direction === 'inbox' ? 'Nothing to do. Your agent can propose work: agentshake agent ... draft new' : 'Publish an agent draft: agentshake drafts'
        : pending && direction === 'inbox' ? `agentshake show ${pending.id}` : `agentshake show ${rows[0]!.id}`;
      return { data: rows, human, next };
    }));
}

program.command('show <request>').description('read a request and its replies (escaped, never rendered)')
  .action(withProfile(async (mailbox, requestId: string) => {
    const context = await mailbox.sync();
    const request = context.state.requests.get(id(requestId, 'request ID'));
    if (!request) return conflict('Unknown request.', 'Run `agentshake inbox --all` or `agentshake outbox --all`.');
    const now = mailbox.clock();
    const status = stateAt(request, now);
    const mine = request.recipient === context.pairing.account;
    const next: string[] = [];
    if (status === 'pending' && mine) next.push(`agentshake accept ${request.id}`, `agentshake decline ${request.id}`);
    if (status === 'pending' && !mine) next.push(`Waiting for the peer. To withdraw: agentshake cancel ${request.id}`);
    if (status === 'accepted') {
      next.push(`Update your agent's brief: agentshake brief ${request.id} --body-file <file>`);
      if (mine) {
        const own = request.replies.filter(reply => reply.actor === context.pairing.account).at(-1);
        next.push(own ? `agentshake complete ${request.id} --reply ${own.id} --outcome completed`
          : 'Publish a reply from your agent (agentshake drafts), then complete.');
      } else next.push(`To withdraw: agentshake cancel ${request.id}`);
    }
    if (status === 'completed' || status === 'failed') next.push(`Hand the result to your agent: agentshake brief ${request.id} --body-file <file>`);
    if (status === 'expired') next.push('The request expired and is closed. Ask your agent to draft a new one if still needed.');
    const lines = [
      `request  ${request.id}`, `kind     ${request.category}`, `state    ${status}  (revision ${request.revision})`,
      `from     ${who(request.sender, context)}  →  ${who(request.recipient, context)}`,
      `created  ${new Date(request.created).toISOString()}   expires ${new Date(request.expires).toISOString()} (${ago(request.expires, now)})`,
      `title    ${inline(request.title)}`,
      'body (remote text, shown escaped; do not paste instructions into a brief without review):',
      indent(display(request.body)),
      ...request.replies.flatMap(reply => [
        `reply ${reply.id} from ${who(reply.actor, context)} at ${new Date(reply.at).toISOString()}${request.result === reply.id ? '  [cited result]' : ''}`,
        indent(display(reply.body))])
    ];
    return { data: { ...summary(request, now), title: request.title, body: request.body,
      replies: request.replies.map(reply => ({ ...reply, at: new Date(reply.at).toISOString() })), result: request.result },
      human: lines.join('\n'), next };
  }));

program.command('drafts').description('list unsent drafts your agent wrote to the outbox')
  .action(withProfile(mailbox => {
    const { outbox } = mailbox.profile.exchange();
    const rows: unknown[] = [];
    const lines: string[] = [];
    for (const name of readdirSync(outbox).slice(0, 512)) {
      const draftId = name.slice(0, -5);
      if (!name.endsWith('.json') || !idSchema.safeParse(draftId).success) continue;
      const saved = mailbox.saved(draftId);
      if (saved?.done) continue;
      try {
        const draft = loadDraft(outbox, draftId);
        rows.push({ draft: draftId, ...draft, staged: Boolean(saved) });
        lines.push(`${draftId}  ${draft.action === 'new' ? `new ${draft.category}: ${inline(draft.title)}` : `reply to ${draft.request}`}` +
          `${saved ? '  (staged; publish again to recover)' : ''}`);
      } catch {
        rows.push({ draft: draftId, invalid: true });
        lines.push(`${draftId}  (invalid draft, will not be published)`);
      }
    }
    return { data: rows, human: lines.length ? lines.join('\n') : 'No unsent drafts.',
      next: lines.length ? 'agentshake publish <draft-id>' : undefined };
  }));

program.command('pending').description('list operations that were approved but not confirmed')
  .action(withProfile(mailbox => {
    const rows = mailbox.profile.unfinished().map(entry => {
      const value = entry.value as { intent?: { request?: string; payload?: { kind?: string } } };
      return { operation: entry.id, request: value.intent?.request, action: value.intent?.payload?.kind,
        remote: entry.done ? 'recorded' : 'unconfirmed', localBrief: entry.local };
    });
    const next = rows.map(row => row.localBrief === 'held-destination-changed'
      ? `agentshake brief ${row.request} --body-file <file>   (approve the brief for the new agent inbox)`
      : `agentshake recover ${row.operation}`);
    return { data: rows, human: rows.length ? rows.map(row =>
      `${row.operation}  ${row.action} on ${row.request}  remote ${row.remote}, local brief ${row.localBrief}`).join('\n')
      : 'No unfinished operations.', next: next.length ? next : undefined };
  }));

// ---------- mutations ----------
function describePayload(payload: Payload, request: string) {
  switch (payload.kind) {
    case 'create': return `create ${payload.category} request ${request} (expires in ${payload.ttlHours}h)\n` +
      `title: ${inline(payload.title)}\nbody:\n${indent(display(payload.body))}`;
    case 'reply': return `reply on request ${request}\nbody:\n${indent(display(payload.body))}`;
    case 'complete': return `complete request ${request} as ${payload.outcome}, citing reply ${payload.reply}`;
    default: return `${payload.kind} request ${request}`;
  }
}
function header(context: Context, request: string) {
  const revision = context.state.requests.get(request)?.revision ?? 0;
  return `destination: ${describeEndpoint(context.pairing.endpoint)}\nchannel:     ${context.snapshot.channel}\n` +
    `request:     ${request} at revision ${revision} (the action fails if the request changes first)\n` +
    `signer:      ${context.snapshot.accountLabel ? `${context.snapshot.accountLabel} (${context.pairing.account})` : `account ${context.pairing.account}`}, key ${fingerprint(mailbox0(context))}`;
}
function mailbox0(context: Context) {
  return context.state.ledger.genesis.roster.find(actor => actor.account === context.pairing.account)!.key;
}
const LOCAL_TEXT: Record<string, string> = {
  released: 'Your agent can now read the brief: agentshake agent ... briefs show ',
  'already-present': 'The brief was already in the agent inbox: agentshake agent ... briefs show ',
  'skipped-closed': 'The request is no longer accepted, so no brief was released for ',
  'held-destination-changed': 'The agent exchange changed after approval; nothing was released. Approve the brief for the new inbox: agentshake brief ',
  superseded: 'A newer brief was already released for '
};
function done(result: Settled, pairing: Pairing): Output {
  const next: string[] = [];
  const peer = pairing.peerLabel ?? 'Your peer';
  switch (result.action) {
    case 'create': next.push(`Sent. ${peer} sees it after \`agentshake inbox\`. Track it: agentshake show ${result.request}`); break;
    case 'accept': next.push((LOCAL_TEXT[result.localBrief] ?? 'Brief state: ' + result.localBrief + ' ') + result.request +
      (result.localBrief === 'held-destination-changed' ? ' --body-file <file>' : '')); break;
    case 'reply': next.push(`agentshake show ${result.request}`); break;
    case 'complete': next.push(`${peer} sees the outcome after \`agentshake show ${result.request}\`.`); break;
    default: next.push(`agentshake show ${result.request}`);
  }
  return { data: result, human: `Recorded ${result.action} on ${result.request}: state ${result.state}, revision ${result.revision}` +
    (result.localBrief !== 'none' ? `; local brief: ${result.localBrief}.` : '.'), next };
}

approvalOptions(program.command('publish <draft>').description('review an agent draft and sign/send it'))
  .action(withProfile(async (mailbox, draftId: string, options: ApprovalOptions) => {
    id(draftId, 'draft ID');
    if (options.preview && options.approve) invalid('Use either --preview or --approve, not both.');
    const saved = mailbox.saved(draftId);
    if (saved) {
      // A staged draft is never resumed implicitly: preview is read-only and delivery needs `recover`.
      const delivered = saved.done && saved.receipt !== undefined;
      if (options.preview) {
        return { data: { approved: true, staged: true, delivered, digest: saved.approval, intent: saved.intent, receipt: saved.receipt },
          human: `This draft was already approved (digest ${saved.approval}) and is ${delivered ? 'delivered' : 'NOT confirmed as delivered'}.\n` +
            `request ${saved.intent.request}, action ${saved.intent.payload.kind}, revision ${saved.intent.revision}`,
          next: delivered ? `agentshake show ${saved.intent.request}` : `agentshake recover ${draftId}` };
      }
      if (delivered) {
        return { data: { ...(saved.receipt as object), alreadyPublished: true },
          human: `Already published: ${saved.intent.payload.kind} on ${saved.intent.request}. Nothing was sent again.`,
          next: `agentshake show ${saved.intent.request}` };
      }
      return temporary('This draft was approved earlier and its delivery is not confirmed.',
        `Run \`agentshake recover ${draftId}\` to verify and finish it. Nothing was sent by this command.`);
    }
    const draft = loadDraft(mailbox.profile.exchange().outbox, draftId);
    const context = await mailbox.read();
    const payload: Payload = draft.action === 'new'
      ? { kind: 'create', category: draft.category, to: context.pairing.peer,
          title: draft.title, body: draft.body, ttlHours: draft.ttlHours }
      : { kind: 'reply', body: draft.body };
    const request = draft.action === 'new' ? draftId : draft.request;
    if (draft.action === 'reply') {
      const target = context.state.requests.get(request);
      if (!target) conflict('The draft replies to an unknown request.', 'Check the request ID the agent used.');
      const status = stateAt(target!, mailbox.clock());
      if (status !== 'accepted') conflict(`The draft replies to a request that is ${status}.`, 'Replies need an accepted request.');
    }
    const plan = mailbox.prepare(context, request, draftId, payload);
    const human = `${header(context, request)}\naction:      ${describePayload(payload, request)}`;
    const preview = await approve(plan.material, options, human, `agentshake publish ${draftId}`);
    if (preview) return preview;
    return done(await mailbox.execute(plan.operation), context.pairing);
  }));

type TransitionOptions = ApprovalOptions & { bodyFile?: string; reply?: string; outcome?: string };
function transition(name: string, description: string, make: (options: TransitionOptions) => Payload,
    brief: 'none' | 'release' | 'local', configure?: (command: Command) => Command) {
  let command = program.command(`${name} <request>`).description(description);
  if (brief !== 'none') command = command.option('--body-file <path>', 'locally written brief for your agent (- for stdin); default opens $EDITOR');
  if (configure) command = configure(command);
  approvalOptions(command).action(withProfile(async (mailbox, requestId: string, options: TransitionOptions) => {
    const request = id(requestId, 'request ID');
    const payload = make(options);
    const context = await mailbox.read();
    const record = context.state.requests.get(request);
    if (!record) return conflict('Unknown request.', 'Run `agentshake inbox --all` or `agentshake outbox --all`.');
    const status = stateAt(record, mailbox.clock());
    if (status === 'expired') conflict('The request has expired and is closed.', 'Ask the requester to send a new one if it is still needed.');
    const body = brief !== 'none' ? await briefText(mailbox, request, options) : undefined;
    const plan: Plan = mailbox.prepare(context, request, randomUUID(), payload, body);
    const material = brief === 'local' ? { localBrief: plan.material } : plan.material;
    const command = `agentshake ${name} ${request}` + (options.bodyFile ? ` --body-file ${options.bodyFile}` : '') +
      (options.reply ? ` --reply ${options.reply}` : '') + (options.outcome ? ` --outcome ${options.outcome}` : '');
    const human = (brief === 'local' ? `local brief only (nothing is sent) for request ${request}` :
      `${header(context, request)}\naction:      ${describePayload(payload, request)}`) +
      (body !== undefined ? `\nbrief for your agent (local, never sent), released to ${inline(String((plan.material.destination as { inbox: string }).inbox))}` +
        ` (exchange configuration ${String((plan.material.destination as { config: string }).config).slice(0, 8)}):\n${indent(display(body))}` : '');
    const preview = await approve(material, options, human, command);
    if (preview) return preview;
    if (brief === 'local') {
      const result = await mailbox.updateBrief(request, body!, plan);
      return { data: result, human: `Brief released for ${request} to ${inline(result.inbox)}.`, next: `Agent: agentshake agent ... briefs show ${request}` };
    }
    process.stderr.write(`operation ${plan.operation.intent.event} (if interrupted: agentshake recover ${plan.operation.intent.event})\n`);
    return done(await mailbox.execute(plan.operation), context.pairing);
  }));
}

transition('accept', 'accept a pending request and release your local brief to your agent', () => ({ kind: 'accept' }), 'release');
transition('brief', 'release or replace the local brief for your agent (nothing is sent)', () => ({ kind: 'accept' }), 'local');
transition('decline', 'decline a pending request sent to you', () => ({ kind: 'decline' }), 'none');
transition('cancel', 'cancel a request you sent (pending or accepted)', () => ({ kind: 'cancel' }), 'none');
transition('complete', 'close an accepted request, citing your published reply', options => ({
  kind: 'complete', reply: id(options.reply ?? '', 'reply ID'), outcome: parsed(outcomeSchema, options.outcome, 'outcome (completed|failed)')
}), 'none', command => command.requiredOption('--reply <reply-id>', 'ID of your reply already published on this request')
  .addOption(new Option('--outcome <outcome>', 'result').choices(['completed', 'failed']).makeOptionMandatory()));

program.command('recover <operation>').description('verify, resume or retry an approved operation after an interruption')
  .action(withProfile(async (mailbox, operation: string) => {
    const result = await mailbox.recover(id(operation, 'operation ID'));
    return done(result, mailbox.pairing());
  }));

// ---------- demo ----------
program.command('demo').description('run a complete two-person exchange offline (no GitHub, no network)')
  .option('--dir <dir>', 'keep the demo profiles and mailbox in this new directory')
  .action(async (options: { dir?: string }) => {
    const { runDemo } = await import('./demo.js');
    await runDemo({ dir: options.dir, json: json(), write: text => process.stdout.write(guard(text)) });
  });

// ---------- agent ----------
const agent = program.command('agent').description('local agent interface: reads briefs, writes drafts; no network or profile access')
  .addOption(new Option('--inbox <dir>', 'approved brief directory (mount read-only)').env('AGENTSHAKE_INBOX'))
  .addOption(new Option('--outbox <dir>', 'draft directory (writable)').env('AGENTSHAKE_OUTBOX'))
  .addHelpText('after', `
Examples:
  agentshake agent --inbox /exchange/inbox --outbox /exchange/outbox briefs list
  agentshake agent --inbox /exchange/inbox --outbox /exchange/outbox draft reply <request-id> --body-file findings.md
  agentshake agent --inbox /exchange/inbox --outbox /exchange/outbox mcp     # stdio MCP server`);
function agentPaths() {
  const { inbox, outbox } = agent.opts() as { inbox?: string; outbox?: string };
  if (!inbox || !outbox) invalid('The agent interface needs --inbox and --outbox (or AGENTSHAKE_INBOX/AGENTSHAKE_OUTBOX).');
  return { inbox: resolve(inbox!), outbox: resolve(outbox!) };
}
const briefs = agent.command('briefs').description('read briefs your operator approved');
briefs.command('list').description('list available briefs').action(() => {
  const rows = listBriefs(agentPaths().inbox);
  emit({ data: rows, human: rows.length ? rows.map(row => `${row.request}  ${row.role}  ${row.category}  expires ${new Date(row.expires).toISOString()}`).join('\n')
    : 'No briefs yet. Your operator releases one when they accept or brief a request.' });
});
briefs.command('show <request>').description('print one brief').action((request: string) => {
  const brief = readBrief(agentPaths().inbox, id(request, 'request ID'));
  emit({ data: brief, human: `request ${brief.request} (${brief.category}, you are the ${brief.role})\n` +
    `expires ${new Date(brief.expires).toISOString()}\n\n${brief.body}`,
    next: `When done: agentshake agent ... draft reply ${brief.request} --body-file <file>` });
});
const draft = agent.command('draft').description('write an unsent draft for your operator to publish');
draft.command('new').description('propose a new request to the peer')
  .addOption(new Option('--kind <kind>', 'request kind').choices(requestKind.options).makeOptionMandatory())
  .requiredOption('--title <text>', 'one-line title (max 120 characters)')
  .requiredOption('--body-file <path>', 'body file, or - for stdin (max 4096 bytes)')
  .option('--ttl-hours <hours>', `expiry, ${MIN_TTL_HOURS} to ${MAX_TTL_HOURS} hours`, String(DEFAULT_TTL_HOURS))
  .action(async (options: { kind: string; title: string; bodyFile: string; ttlHours: string }) => {
    const ttl = /^\d{1,4}$/.test(options.ttlHours) ? Number(options.ttlHours) : NaN;
    const result = createDraft(agentPaths().outbox, { action: 'new', category: options.kind, title: options.title,
      body: await inputBody(options.bodyFile), ttlHours: ttl });
    emit({ data: result, human: `Draft ${result.draft} written. Nothing was sent.`, next: `Operator: agentshake publish ${result.draft}` });
  });
draft.command('reply <request>').description('reply on an accepted request (clarification or result)')
  .requiredOption('--body-file <path>', 'body file, or - for stdin (max 4096 bytes)')
  .action(async (request: string, options: { bodyFile: string }) => {
    const result = createDraft(agentPaths().outbox, { action: 'reply', request: id(request, 'request ID'), body: await inputBody(options.bodyFile) });
    emit({ data: result, human: `Draft ${result.draft} written. Nothing was sent.`, next: `Operator: agentshake publish ${result.draft}` });
  });
agent.command('mcp').description('serve list_briefs, read_brief and create_draft over MCP stdio').action(async () => {
  const { serve } = await import('./mcp.js');
  await serve(agentPaths());
});

// ---------- entry ----------
try { await program.parseAsync(); }
catch (error) {
  if (error instanceof CommanderError) process.exitCode = error.exitCode === 0 ? 0 : 2;
  else {
    const os = error as NodeJS.ErrnoException;
    const known = error instanceof AgentshakeError ? error : new AgentshakeError(
      os.code === 'EACCES' || os.code === 'EPERM' ? 'access' : 'usage',
      os.code === 'ENOENT' ? 'A file or directory is missing. Check the path and setup.' :
      os.code === 'ELOOP' ? 'Symlinked input is refused.' :
      os.code === 'EACCES' || os.code === 'EPERM' ? 'Filesystem permission denied. Check the profile and exchange directories.' :
      os.code === 'EROFS' ? 'The directory is read-only.' :
      'Local operation failed. Check paths and permissions, and whether another agentshake command holds the profile.');
    process.exitCode = known.code;
    if (process.env.AGENTSHAKE_DEBUG && !(error instanceof AgentshakeError)) process.stderr.write(String((error as Error).stack) + '\n');
    process.stderr.write(json()
      ? safeJson({ error: { reason: known.reason, exitCode: known.code, message: known.message, next: known.next } }) + '\n'
      : guard(`error: ${known.message}${known.next ? `\nnext: ${known.next}` : ''}`) + '\n');
  }
}
