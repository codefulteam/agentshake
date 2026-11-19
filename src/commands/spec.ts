// Offline protocol tooling: validate a document, describe capabilities, run conformance. These commands
// open no profile, start no transport and read only the files they are given.
import { Command, Option } from 'commander';
import { readFilePrefix, readStdinPrefix } from '../local.js';
import { capabilities } from '../capabilities.js';
import { commandValidator, DEFAULT_MANIFEST, referenceValidator, runConformance } from '../conformance.js';
import { DOCUMENT_KINDS, documentLimit, validate, type DocumentKind, type Validation } from '../validate.js';
import type { Emit } from './common.js';

/** Invalid documents and failed conformance cases exit 6, like other integrity findings. */
const INVALID_EXIT = 6;

function human(result: Validation) {
  if (!result.valid) {
    return `invalid ${result.as}: ${result.stage} (${result.code})${result.event === undefined ? '' : ` at event ${result.event}`}` +
      `${result.path ? ` at ${result.path}` : ''}\n${result.message}`;
  }
  if (!result.summary) return `valid ${result.as} (schema only)`;
  return `valid protocol 2 ledger: ${result.summary.events} event(s), ${result.summary.requests.length} request(s).\n` +
    'A valid history is not permission to act, says nothing about the truth of its text, and does not check expiry against a clock.';
}

export function registerSpecCommands(program: Command, emit: Emit) {
  program.command('validate <file>').description('check a ledger, draft, brief or capabilities document offline (- for stdin)')
    .addOption(new Option('--as <kind>', 'document kind').choices([...DOCUMENT_KINDS]).default('ledger'))
    .addHelpText('after', `
Stages for a ledger: input, version, schema, canonical, genesis, chain, signature, transition, capacity.
Content defects (too large, not UTF-8, not JSON, wrong version, ...) are results with a stage and code.
Exit codes: 0 valid, 6 invalid, 2 usage or 3 access for filesystem problems (missing file, directory,
symlink, permissions), which are not results. No profile, network or gh is used.`)
    .action(async (file: string, options: { as: DocumentKind }) => {
      const limit = documentLimit(options.as);
      const bytes = file === '-' ? await readStdinPrefix(limit) : readFilePrefix(file, limit);
      const result = validate(bytes, options.as);
      if (!result.valid) process.exitCode = INVALID_EXIT;
      emit({ data: result, human: human(result) });
    });
  program.command('capabilities').description('print what this installation supports (offline; grants nothing)')
    .action(() => describeCapabilities(emit));
  program.command('conformance [validator...]')
    .description('run the shipped protocol 2 conformance cases against a validator (offline)')
    .option('--manifest <file>', 'conformance manifest', DEFAULT_MANIFEST)
    .addHelpText('after', `
Without a validator, the built-in one is tested. After --, give a validator command and its arguments
(run without a shell); {file} and {as} are replaced per case and it must print validation JSON:
  agentshake conformance -- agentshake validate {file} --as {as} --json
Exit codes: 0 all cases pass, 6 a case failed, 2 usage.`)
    .action(async (validator: string[], options: { manifest: string }) => {
      const [command, ...args] = validator;
      const report = await runConformance(command ? commandValidator(command, args) : referenceValidator,
        command ? 'command' : 'reference', options.manifest);
      if (report.failed.length) process.exitCode = INVALID_EXIT;
      emit({ data: report, human: `${report.passed}/${report.cases} conformance cases passed` +
        report.failed.map(entry => `\nFAIL ${entry.id}: ${entry.problem ?? 'differs'}`).join('') });
    });
}

export function describeCapabilities(emit: Emit) {
  const value = capabilities();
  emit({ data: value, human: [
    `agentshake ${value.software.version}: protocol ${value.protocols.map(entry => entry.version).join(', ')} supported`,
    `profiles: ${value.profiles.map(entry => `${entry.id} (${entry.authenticated ? 'authenticated' : 'unauthenticated'}, ${entry.scope})`).join('; ')}`,
    `operations: ${value.operations.join(', ')}`,
    `agent drafts: ${value.localExchange.draftActions.join(', ')}; every signed event needs operator approval`
  ].join('\n') });
}
