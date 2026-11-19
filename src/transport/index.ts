import { isAbsolute } from 'node:path';
import * as z from 'zod';
import { accountSchema } from '../domain.js';
import { FileTransport } from './file.js';
import { GitHubTransport, repoNameSchema } from './github.js';
import type { Transport } from './types.js';

export type { Snapshot, Transport, WriteResult } from './types.js';
export { FileTransport } from './file.js';
export { GitHubTransport, LEDGER_PATH } from './github.js';
export { MemoryChannel, MemoryTransport } from './memory.js';

/**
 * Persisted endpoint descriptions. Adding an adapter means adding a schema member and a
 * factory case here; the domain and application layers do not change.
 */
export const endpointSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('github'), repo: repoNameSchema }),
  z.strictObject({ type: z.literal('file'), path: z.string().max(4096).refine(isAbsolute), account: accountSchema })
]);
export type Endpoint = z.infer<typeof endpointSchema>;

export function openTransport(endpoint: Endpoint): Transport {
  switch (endpoint.type) {
    case 'file': return new FileTransport(endpoint.path, endpoint.account);
    case 'github': return new GitHubTransport(endpoint.repo);
  }
}

export function describeEndpoint(endpoint: Endpoint): string {
  return endpoint.type === 'github' ? `GitHub private repository ${endpoint.repo}`
    : `local file mailbox ${endpoint.path} (offline demo transport, unauthenticated)`;
}
