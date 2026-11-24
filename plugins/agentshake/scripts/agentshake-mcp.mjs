#!/usr/bin/env node
// Host binding for the Agentshake agent MCP server. It locates an installed Agentshake engine and
// the operator-chosen exchange directories, then runs `agentshake agent --inbox … --outbox … mcp`
// with a minimal environment. It never downloads, installs or reads an operator profile.
import { spawn } from 'node:child_process';
import { constants, accessSync, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_RANGE = { name: 'agentshake', min: [0, 3, 0], below: [0, 4, 0], text: '>=0.3.0 <0.4.0' };
const BINDING_KEYS = ['inbox', 'outbox', 'engine'];
const ENV_KEEP = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT'];
const posix = process.platform !== 'win32';

class SetupError extends Error {
  constructor(message, next, code = 2) { super(message); this.next = next; this.code = code; }
}
const fail = (message, next, code) => { throw new SetupError(message, next, code); };
const within = (parent, child) => { const r = relative(parent, child); return r === '' || (r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r)); };
const version = text => (/^(\d+)\.(\d+)\.(\d+)$/.exec(String(text)) ?? []).slice(1).map(Number);
const compare = (a, b) => a.reduce((d, v, i) => d || v - b[i], 0);

function nodeSupported(text = process.versions.node) {
  const [major, minor] = version(text);
  return (major === 24 && minor >= 11) || major === 26;
}

function home(env) { return env.HOME || homedir(); }

function bindingPath(env) {
  if (env.AGENTSHAKE_AGENT_CONFIG) {
    if (!isAbsolute(env.AGENTSHAKE_AGENT_CONFIG)) fail('AGENTSHAKE_AGENT_CONFIG must be an absolute path.', 'Set it to the absolute path of your agent binding file.');
    return { path: env.AGENTSHAKE_AGENT_CONFIG, explicit: true };
  }
  return { path: join(env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home(env), '.config'), 'agentshake', 'agent.json'), explicit: false };
}

function readBinding(env) {
  const { path, explicit } = bindingPath(env);
  if (!existsSync(path)) {
    if (explicit) fail(`Agent binding file not found: ${path}`, 'Create it as described in the plugin README, or unset AGENTSHAKE_AGENT_CONFIG.');
    return { path, value: {} };
  }
  const info = statSync(path);
  if (!info.isFile() || info.size > 4096) fail(`Agent binding file must be a regular file of at most 4 KiB: ${path}`, 'Recreate it as a small JSON file.');
  if (posix && (info.mode & 0o022 || info.uid !== process.getuid())) {
    fail(`Agent binding file must be owned by you and not writable by group or others: ${path}`, `Run: chmod 600 "${path}"`, 3);
  }
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { fail(`Agent binding file is not valid JSON: ${path}`, 'Fix the JSON: {"inbox": "/abs/inbox", "outbox": "/abs/outbox"}.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Agent binding file must contain a JSON object: ${path}`, 'Use {"inbox": "/abs/inbox", "outbox": "/abs/outbox"}.');
  for (const key of Object.keys(value)) {
    if (!BINDING_KEYS.includes(key)) fail(`Unknown field "${key}" in ${path}.`, `Allowed fields: ${BINDING_KEYS.join(', ')}.`);
    if (typeof value[key] !== 'string' || !isAbsolute(value[key])) fail(`Field "${key}" in ${path} must be an absolute path.`, 'Use absolute paths only.');
  }
  return { path, value };
}

function onPath(env, name) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return undefined;
}

function checkEngine(path) {
  let real;
  try { real = realpathSync(path); } catch { fail(`Agentshake engine not found at ${path}`, 'Check the path, or reinstall the engine package.'); }
  if (basename(real) !== 'cli.js' || basename(dirname(real)) !== 'dist') {
    fail(`${path} is not an Agentshake engine executable (expected <package>/dist/cli.js).`, 'Point to node_modules/.bin/agentshake of an installed agentshake package.');
  }
  const root = dirname(dirname(real));
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { fail(`No package.json next to ${real}.`, 'Reinstall the agentshake package.'); }
  const found = version(pkg.version);
  if (pkg.name !== ENGINE_RANGE.name || found.length !== 3 || compare(found, ENGINE_RANGE.min) < 0 || compare(found, ENGINE_RANGE.below) >= 0) {
    fail(`Unsupported engine ${pkg.name}@${pkg.version} at ${root}; this plugin needs agentshake ${ENGINE_RANGE.text}.`, 'Install a matching agentshake release tarball offline (see the plugin README).');
  }
  return { cli: real, root, version: pkg.version };
}

function resolveEngine(env, binding) {
  const explicit = env.AGENTSHAKE_BIN ? ['AGENTSHAKE_BIN', env.AGENTSHAKE_BIN] : binding.value.engine ? [binding.path, binding.value.engine] : undefined;
  if (explicit) {
    if (!isAbsolute(explicit[1])) fail(`The engine path from ${explicit[0]} must be absolute.`, 'Use the absolute path of node_modules/.bin/agentshake.');
    return { ...checkEngine(explicit[1]), source: explicit[0] };
  }
  const fromPath = onPath(env, 'agentshake');
  if (fromPath) return { ...checkEngine(fromPath), source: 'PATH' };
  const fallback = join(home(env), 'agentshake', 'node_modules', '.bin', 'agentshake');
  if (existsSync(fallback)) return { ...checkEngine(fallback), source: 'default prefix ~/agentshake' };
  return fail('Agentshake engine not found: no AGENTSHAKE_BIN, no "engine" in the binding file, no agentshake on PATH, nothing in ~/agentshake.',
    `Install it offline: npm install --offline --no-audit --no-fund --prefix ~/agentshake ./agentshake-0.3.0.tgz (or set "engine" in ${binding.path}).`);
}

function profiles(env) {
  return [env.AGENTSHAKE_HOME, join(home(env), '.agentshake')].filter(Boolean).map(path => resolve(path))
    .map(path => { try { return realpathSync(path); } catch { return path; } });
}

function exchangeDirectory(label, path, source, env) {
  if (!path) fail(`No agent ${label} configured.`, `Your operator writes the ${label} path into the binding file (see the plugin README), or sets AGENTSHAKE_${label.toUpperCase()}.`);
  if (!isAbsolute(path)) fail(`The ${label} path from ${source} must be absolute.`, 'Use the absolute directory printed by `agentshake exchange configure`.');
  let real;
  try { real = realpathSync(path); } catch { fail(`Agent ${label} directory not found: ${path}`, 'Ask your operator to run `agentshake exchange configure` and update the binding.'); }
  if (!statSync(real).isDirectory()) fail(`Agent ${label} is not a directory: ${path}`, 'Use the directory printed by `agentshake exchange configure`.');
  for (const profile of profiles(env)) {
    if (within(real, profile) || within(profile, real)) fail(`Refusing ${label} ${path}: it overlaps the operator profile ${profile}.`, 'Give the agent only the exchange directories, never the profile.', 3);
  }
  for (let dir = real; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'operator.sqlite'))) fail(`Refusing ${label} ${path}: ${dir} is an operator profile.`, 'Give the agent only the exchange directories, never the profile.', 3);
    if (dirname(dir) === dir) break;
  }
  return real;
}

function resolveSetup(env = process.env) {
  if (!nodeSupported()) fail(`Node.js ${process.versions.node} is not supported; Agentshake needs ^24.11.0 or ^26.0.0.`, 'Install Node.js 24 LTS or 26 LTS and make it the `node` on the host PATH.');
  const binding = readBinding(env);
  const pick = key => env[`AGENTSHAKE_${key.toUpperCase()}`] ? [env[`AGENTSHAKE_${key.toUpperCase()}`], `AGENTSHAKE_${key.toUpperCase()}`] : [binding.value[key], binding.path];
  const [inboxPath, inboxSource] = pick('inbox');
  const [outboxPath, outboxSource] = pick('outbox');
  const inbox = exchangeDirectory('inbox', inboxPath, inboxSource, env);
  const outbox = exchangeDirectory('outbox', outboxPath, outboxSource, env);
  if (within(inbox, outbox) || within(outbox, inbox)) fail('Inbox and outbox must be separate, non-nested directories.', 'Use the two directories printed by `agentshake exchange configure`.');
  const engine = resolveEngine(env, binding);
  return { node: process.versions.node, binding: binding.path, inbox, outbox, engine };
}

function childEnv(env = process.env) {
  return Object.fromEntries(ENV_KEEP.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}

function report(error, json) {
  const value = { ok: false, error: error.message, next: error.next, exitCode: error.code };
  process.stderr.write(json ? JSON.stringify(value) + '\n' : `agentshake plugin: ${error.message}\nnext: ${error.next}\n`);
  process.exitCode = error.code;
}

function main(args) {
  const check = args.includes('--check'), json = args.includes('--json');
  const unknown = args.filter(arg => arg !== '--check' && arg !== '--json');
  if (unknown.length || (json && !check)) return report(new SetupError(`Unknown arguments: ${args.join(' ')}`, 'Run with no arguments (MCP) or with --check [--json].'), json);
  let setup;
  try { setup = resolveSetup(); }
  catch (error) { if (error instanceof SetupError) return report(error, json); throw error; }
  if (check) {
    const value = { ok: true, ...setup };
    process.stdout.write(json ? JSON.stringify(value) + '\n' :
      `ok: engine agentshake ${setup.engine.version} (${setup.engine.source})\ninbox:  ${setup.inbox}\noutbox: ${setup.outbox}\nbinding file: ${setup.binding}\n`);
    return;
  }
  const child = spawn(process.execPath, [setup.engine.cli, 'agent', '--inbox', setup.inbox, '--outbox', setup.outbox, 'mcp'],
    { stdio: 'inherit', env: childEnv(), cwd: setup.engine.root });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { process.stderr.write(`agentshake plugin: could not start the engine: ${error.message}\n`); process.exitCode = 2; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
