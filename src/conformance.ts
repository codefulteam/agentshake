// Conformance runner: replays a manifest of example documents against a validator (the built-in one or
// an external command) and compares stage, code and the normalized ledger state. No network, no profile.
import { execFile } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import { canonical, invalid, MAX_LEDGER } from './domain.js';
import { jsonValue, readFileBounded, readFilePrefix } from './local.js';
import { DOCUMENT_KINDS, documentLimit, validate, type DocumentKind, type LedgerSummary } from './validate.js';

/** The spec directory shipped next to `dist/`. */
export const SPEC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'spec');
export const DEFAULT_MANIFEST = join(SPEC_ROOT, 'conformance-protocol-2.json');

const relativePath = z.string().min(1).max(200)
  .refine(value => !isAbsolute(value) && !value.split('/').includes('..') && !value.includes('\\'), 'Paths stay inside the spec directory.');
const caseSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9.-]{1,40}$/), input: relativePath, as: z.enum(DOCUMENT_KINDS),
  description: z.string().max(300),
  expect: z.strictObject({
    valid: z.boolean(), stage: z.string().optional(), code: z.string().optional(), state: relativePath.optional(),
    jsonSchema: z.enum(['pass', 'fail']).optional(), rule: z.string().optional()
  })
});
export const manifestSchema = z.strictObject({
  $schema: z.string().optional(), format: z.literal('agentshake-conformance/1'), protocol: z.literal(2),
  cases: z.array(caseSchema).min(1).max(500)
});
export type Manifest = z.infer<typeof manifestSchema>;
export type Case = Manifest['cases'][number];

/** What a validator under test must print: the subset of validation-1 that conformance compares. */
const observedSchema = z.object({
  valid: z.boolean(), stage: z.string().optional(), code: z.string().optional(),
  summary: z.looseObject({ principals: z.array(z.string()) }).optional()
});
export type Observed = z.infer<typeof observedSchema>;
export type Validator = (file: string, as: DocumentKind) => Promise<Observed | { error: string }>;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const VOLATILE = new Set(['epoch', 'channel', 'branch', 'head', 'expires']);

/**
 * Ledger state with run-specific values replaced by labels: principals by roster position, UUIDs and
 * digests by first appearance. Objects are traversed with member names in canonical (UTF-16) order and
 * arrays in order, so the result depends on the JSON value only, never on member insertion order.
 */
export function normalizeSummary(summary: Pick<LedgerSummary, 'principals'> | { principals: string[] }) {
  const principals = new Map(summary.principals.map((account, index) => [account, `principal-${index + 1}`]));
  const labels = new Map<string, string>();
  const label = (value: string, kind: string) => {
    if (!labels.has(value)) labels.set(value, `${kind}-${[...labels.values()].filter(item => item.startsWith(kind)).length + 1}`);
    return labels.get(value)!;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).filter(key => !VOLATILE.has(key)).sort()
        .map(key => [key, walk((value as Record<string, unknown>)[key])]));
    }
    if (typeof value !== 'string') return value;
    return principals.get(value) ?? (UUID.test(value) ? label(value, 'id') : DIGEST.test(value) ? label(value, 'digest') : value);
  };
  return walk(summary);
}

function readJson(path: string) { return jsonValue(readFileBounded(path, MAX_LEDGER + 1)); }

export function loadManifest(path = DEFAULT_MANIFEST): { manifest: Manifest; root: string } {
  const result = manifestSchema.safeParse(readJson(path));
  if (!result.success) return invalid('Invalid conformance manifest.', 'Use the manifest shipped in spec/, or one with the same format.');
  return { manifest: result.data, root: dirname(resolve(path)) };
}

export const referenceValidator: Validator = async (file, as) => validate(readFilePrefix(file, documentLimit(as)), as);

const COMMAND_TIMEOUT = 10_000;
const COMMAND_OUTPUT = 1024 * 1024;
/**
 * Runs `command args...` once per case, replacing `{file}` and `{as}` in args; no shell. The command must
 * print a validation-1 JSON document on stdout. Its exit code is not interpreted.
 */
export function commandValidator(command: string, args: readonly string[]): Validator {
  return (file, as) => new Promise(done => {
    execFile(command, args.map(arg => arg.replaceAll('{file}', file).replaceAll('{as}', as)),
      { timeout: COMMAND_TIMEOUT, maxBuffer: COMMAND_OUTPUT, killSignal: 'SIGKILL', windowsHide: true }, (error, stdout) => {
        if (error && (error.killed || error.code === 'ENOENT' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) {
          done({ error: error.killed ? 'The validator command timed out.' : error.code === 'ENOENT' ? 'The validator command was not found.'
            : 'The validator command printed too much output.' });
          return;
        }
        let value: unknown;
        try { value = JSON.parse(stdout); } catch { done({ error: 'The validator command did not print one JSON document.' }); return; }
        const parsedOutput = observedSchema.safeParse(value);
        done(parsedOutput.success ? parsedOutput.data : { error: 'The validator output lacks valid, stage or code.' });
      });
  });
}

export type CaseResult = { id: string; pass: boolean; expected: Case['expect']; observed?: { valid: boolean; stage?: string; code?: string };
  problem?: string };
export type ConformanceReport = { format: 'agentshake-conformance-report/1'; manifest: string; validator: string; cases: number; passed: number;
  failed: CaseResult[] };

export function compare(entry: Case, observed: Observed | { error: string }, root: string): CaseResult {
  const base = { id: entry.id, expected: entry.expect };
  if ('error' in observed) return { ...base, pass: false, problem: observed.error };
  const seen = { valid: observed.valid, ...(observed.stage ? { stage: observed.stage } : {}), ...(observed.code ? { code: observed.code } : {}) };
  const { expect } = entry;
  if (observed.valid !== expect.valid || (!expect.valid && (observed.stage !== expect.stage || observed.code !== expect.code))) {
    return { ...base, observed: seen, pass: false, problem: 'verdict differs' };
  }
  if (expect.state) {
    if (!observed.summary) return { ...base, observed: seen, pass: false, problem: 'no ledger summary' };
    const expected = canonical(readJson(join(root, expect.state)));
    if (canonical(normalizeSummary(observed.summary)) !== expected) {
      return { ...base, observed: seen, pass: false, problem: 'normalized state differs' };
    }
  }
  return { ...base, observed: seen, pass: true };
}

export async function runConformance(validator: Validator, label: string, path = DEFAULT_MANIFEST): Promise<ConformanceReport> {
  const { manifest, root } = loadManifest(path);
  const failed: CaseResult[] = [];
  for (const entry of manifest.cases) {
    const result = compare(entry, await validator(join(root, entry.input), entry.as), root);
    if (!result.pass) failed.push(result);
  }
  return { format: 'agentshake-conformance-report/1', manifest: resolve(path), validator: label, cases: manifest.cases.length,
    passed: manifest.cases.length - failed.length, failed };
}
