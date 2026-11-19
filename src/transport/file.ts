import { randomUUID } from 'node:crypto';
import { integrity, MAX_LEDGER } from '../domain.js';
import { database, utf8 } from '../util.js';
import type { Snapshot, Transport, WriteResult } from './types.js';

/**
 * Local SQLite mailbox for the offline demo and for tests. Both profiles open the same
 * file. The account ID is self-declared by each profile: this transport authenticates
 * nobody and is not a substitute for GitHub. Signatures still bind every event to a key.
 */
export class FileTransport implements Transport {
  constructor(private path: string, private account: string) {}
  private open() {
    const db = database(this.path);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS mailbox (slot INTEGER PRIMARY KEY, id TEXT NOT NULL, rev INTEGER NOT NULL, raw BLOB)');
      db.prepare('INSERT OR IGNORE INTO mailbox VALUES (1, ?, 0, NULL)').run(randomUUID());
      return db;
    } catch (error) { db.close(); throw error; }
  }
  async read(): Promise<Snapshot> {
    const db = this.open();
    try {
      const row = db.prepare(
        'SELECT id, rev, length(raw) AS size, CASE WHEN length(raw) <= ? THEN raw END AS raw FROM mailbox WHERE slot = 1'
      ).get(MAX_LEDGER)!;
      if (typeof row.size === 'number' && row.size > MAX_LEDGER) integrity('Mailbox exceeds the ledger byte cap.');
      const raw = row.raw instanceof Uint8Array ? utf8(row.raw) : null;
      return { transport: 'file', channel: 'file:' + String(row.id), branch: 'local', revision: String(row.rev),
        account: this.account, raw };
    } finally { db.close(); }
  }
  async write(snapshot: Snapshot, raw: string): Promise<WriteResult> {
    const db = this.open();
    try {
      const result = db.prepare('UPDATE mailbox SET raw = ?, rev = rev + 1 WHERE slot = 1 AND id = ? AND rev = ?')
        .run(Buffer.from(raw), snapshot.channel.slice(5), Number(snapshot.revision));
      return result.changes === 1 ? 'committed' : 'conflict';
    } finally { db.close(); }
  }
}
