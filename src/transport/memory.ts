import { randomUUID } from 'node:crypto';
import type { Snapshot, Transport, WriteResult } from './types.js';

/** Shared in-memory channel, for tests and embedding. Not persistent. */
export class MemoryChannel {
  readonly id = 'memory:' + randomUUID();
  revision = 0;
  raw: string | null = null;
}

export class MemoryTransport implements Transport {
  constructor(private channel: MemoryChannel, private account: string) {}
  async read(): Promise<Snapshot> {
    return { transport: 'memory', channel: this.channel.id, branch: 'memory', revision: String(this.channel.revision),
      account: this.account, raw: this.channel.raw };
  }
  async write(snapshot: Snapshot, raw: string): Promise<WriteResult> {
    if (snapshot.channel !== this.channel.id || snapshot.revision !== String(this.channel.revision)) return 'conflict';
    this.channel.raw = raw;
    this.channel.revision++;
    return 'committed';
  }
}
