// Validates the host plugin contract (plugins/agentshake and both repository catalogs) and, with
// --out <dir>, writes deterministic archives: a marketplace root .tgz for offline installation and a
// plugin .zip. Usage: node scripts/plugin-pack.mjs [--out <dir>] [--json]
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'plugins', 'agentshake');
const PLUGIN_FILES = ['.claude-plugin/plugin.json', '.mcp.json', 'LICENSE', 'NOTICE', 'README.md', 'mcp.json', 'plugin.json',
  'scripts/agentshake-mcp.mjs', 'skills/agentshake/SKILL.md', 'skills/agentshake/references/drafts.md',
  'skills/agentshake/references/setup.md'];
const CATALOGS = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];
const SHARED_FIELDS = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'];
const LAUNCHER = 'scripts/agentshake-mcp.mjs';
const FORBIDDEN = [/\/Users\//, /\/home\/[a-z]/, /hyojinmo/i, /\.local-work/, /BEGIN [A-Z ]*PRIVATE KEY/, /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_/, /\bsk-[A-Za-z0-9]{20,}/, /\bnpx\b/, /\bcurl\b|\bwget\b/];
const EPOCH = 315532800;

const errors = [];
const check = (ok, message) => { if (!ok) errors.push(message); return ok; };
const json = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) { errors.push(`${relative(root, path)}: ${error.message}`); return {}; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function walk(dir, base = dir) {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name), info = lstatSync(path);
    if (info.isSymbolicLink()) { errors.push(`symlink not allowed: ${relative(root, path)}`); return []; }
    return info.isDirectory() ? walk(path, base) : [relative(base, path).split(sep).join('/')];
  });
}

export function validate() {
  errors.length = 0;
  const pkg = json(join(root, 'package.json'));
  const files = walk(pluginDir);
  check(same(files, [...PLUGIN_FILES].sort()), `plugin files differ from the contract: ${files.join(', ')}`);
  const claude = json(join(pluginDir, '.claude-plugin/plugin.json')), portable = json(join(pluginDir, 'plugin.json'));
  for (const field of SHARED_FIELDS) check(same(claude[field], portable[field]), `manifests disagree on ${field}`);
  check(claude.name === 'agentshake' && /^\d+\.\d+\.\d+$/.test(claude.version ?? ''), 'plugin name/version invalid');
  check(portable.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'portable manifest $schema missing');
  for (const manifest of [claude, portable]) check(!('hooks' in manifest) && !('mcpServers' in manifest) && !('skills' in manifest), 'manifests must use default component locations and no hooks');
  const bindings = [
    [json(join(pluginDir, '.mcp.json')), { command: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/${LAUNCHER}`] }],
    [json(join(pluginDir, 'mcp.json')), { type: 'stdio', command: 'node', args: [`\${PLUGIN_ROOT}/${LAUNCHER}`], cwd: '${PLUGIN_ROOT}' }]];
  for (const [file, expected] of bindings) {
    check(same(Object.keys(file.mcpServers ?? {}), ['agentshake']), 'each MCP binding declares exactly the agentshake server');
    check(same(file.mcpServers?.agentshake, expected), `MCP binding differs from the contract: ${JSON.stringify(file.mcpServers?.agentshake)}`);
  }
  const catalogs = CATALOGS.map(path => json(join(root, path)));
  for (const catalog of catalogs) {
    check(catalog.name === 'agentshake' && catalog.plugins?.length === 1 && catalog.plugins[0].name === claude.name, 'catalog must list exactly the agentshake plugin');
    const source = catalog.plugins?.[0]?.source;
    check((typeof source === 'string' ? source : source?.path) === './plugins/agentshake', 'catalog source must be ./plugins/agentshake');
  }
  check(catalogs[0].plugins?.[0]?.version === claude.version, 'Claude catalog version must match the plugin version');
  check(catalogs[1].plugins?.[0]?.source?.source === 'local', 'Codex catalog must use a local source');
  check(readFileSync(join(pluginDir, 'LICENSE')).equals(readFileSync(join(root, 'LICENSE'))), 'plugin LICENSE must equal the repository LICENSE');
  const skill = readFileSync(join(pluginDir, 'skills/agentshake/SKILL.md'), 'utf8');
  check(/^---\nname: agentshake\ndescription: .{40,1024}\n---\n/.test(skill), 'skill frontmatter must be name agentshake plus a description');
  for (const link of skill.matchAll(/\]\((references\/[^)]+)\)/g)) check(files.includes(`skills/agentshake/${link[1]}`), `broken skill link ${link[1]}`);
  const launcher = readFileSync(join(pluginDir, LAUNCHER), 'utf8');
  const range = /min: \[(\d+), (\d+), (\d+)\], below: \[(\d+), (\d+), (\d+)\]/.exec(launcher)?.slice(1).map(Number) ?? [];
  const current = pkg.version.split('.').map(Number);
  const cmp = (a, b) => a.reduce((d, v, i) => d || v - b[i], 0);
  check(range.length === 6 && cmp(current, range.slice(0, 3)) >= 0 && cmp(current, range.slice(3)) < 0, `launcher engine range must include package version ${pkg.version}`);
  check(launcher.includes(`agentshake-${pkg.version}.tgz`), 'launcher install hint must name the current engine tarball');
  check(!/from 'node:(https?|net|dgram|tls)'|fetch\(/.test(launcher), 'launcher must not use the network');
  for (const path of [...files.map(file => join(pluginDir, file)), ...CATALOGS.map(file => join(root, file))]) {
    const text = readFileSync(path, 'utf8');
    for (const pattern of FORBIDDEN) check(!pattern.test(text), `${relative(root, path)} matches forbidden pattern ${pattern}`);
  }
  return { ok: errors.length === 0, errors: [...errors], version: claude.version, files };
}

function entries(version) {
  const prefix = `agentshake-plugins-${version}/`;
  const plugin = PLUGIN_FILES.map(file => ({ name: file, data: readFileSync(join(pluginDir, file)), mode: file === LAUNCHER ? 0o755 : 0o644 }));
  const market = [...CATALOGS.map(file => ({ name: prefix + file, data: readFileSync(join(root, file)), mode: 0o644 })),
    ...plugin.map(entry => ({ ...entry, name: `${prefix}plugins/agentshake/${entry.name}` }))];
  return { plugin, market: market.sort((a, b) => a.name < b.name ? -1 : 1) };
}

function tar(files) {
  const blocks = [];
  for (const { name, data, mode } of files) {
    if (Buffer.byteLength(name) > 100) throw new Error(`tar path too long: ${name}`);
    const header = Buffer.alloc(512);
    const field = (offset, length, value) => header.write(value, offset, length, 'utf8');
    const octal = (offset, length, value) => field(offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
    field(0, 100, name); octal(100, 8, mode); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, data.length); octal(136, 12, EPOCH);
    field(148, 8, '        '); field(156, 1, '0'); field(257, 6, 'ustar\0'); field(263, 2, '00'); field(265, 32, 'root'); field(297, 32, 'root');
    octal(148, 7, header.reduce((sum, byte) => sum + byte, 0)); header[155] = 0x20;
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { level: 9 });
}

function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, mode } of files) {
    const packed = deflateRawSync(data, { level: 9 }), nameBytes = Buffer.from(name), crc = crc32(data);
    const common = header => { header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0, 10);
      header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(nameBytes.length, 26); };
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); common(local);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4);
    local.copy(central, 6, 4, 30); central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed); centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const sha256 = data => createHash('sha256').update(data).digest('hex');

export function pack(out) {
  const result = validate();
  if (!result.ok) return result;
  const { plugin, market } = entries(result.version);
  mkdirSync(out, { recursive: true });
  const archives = [[`agentshake-plugins-${result.version}.tgz`, tar(market)], [`agentshake-plugin-${result.version}.zip`, zip(plugin)]]
    .map(([name, data]) => { writeFileSync(join(out, name), data); return { name, bytes: data.length, sha256: sha256(data) }; });
  const contents = plugin.map(({ name, data, mode }) => ({ name, mode: mode.toString(8), sha256: sha256(data) }));
  return { ...result, archives, contents };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf('--out');
  const result = at >= 0 ? pack(resolve(args[at + 1] ?? '.')) : validate();
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (result.ok) console.log(`ok: agentshake plugin ${result.version}${result.archives ? '\n' + result.archives.map(a => `${a.sha256}  ${a.name}`).join('\n') : ''}`);
  else console.error(result.errors.map(error => `error: ${error}`).join('\n'));
  process.exitCode = result.ok ? 0 : 1;
}
