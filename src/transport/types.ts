/**
 * The transport contract. A transport moves opaque, already-signed ledger bytes and
 * reports who the authenticated reader is. It never interprets the ledger: signatures,
 * roles, state replay, clocks and retries stay in the domain and application layers.
 *
 * A conforming adapter must provide:
 *  - an immutable channel identity (`channel`) and branch/partition name (`branch`),
 *  - the authenticated account ID of the local operator (`account`),
 *  - a bounded, consistent read of the whole ledger at one opaque `revision`,
 *  - an atomic write that succeeds only if the revision is unchanged.
 */
export type Snapshot = {
  /** Adapter name, e.g. "github" or "file". */
  transport: string;
  /** Immutable channel identity pinned in the genesis record. */
  channel: string;
  branch: string;
  /** Opaque revision token for compare-and-swap. */
  revision: string;
  /** Authenticated account ID of the reader. */
  account: string;
  /** Optional human label for the account (display only, never authority). */
  accountLabel?: string;
  /** Ledger text, or null when the channel holds no ledger yet. */
  raw: string | null;
  /** Adapter-private data needed by write(), such as a branch node ID. */
  opaque?: Readonly<Record<string, string>>;
};

/**
 * committed: the adapter has positive confirmation that the write landed.
 * conflict:  the revision moved; nothing was written by this call.
 * denied:    the remote refused the write for permission or policy reasons.
 * unknown:   the outcome cannot be determined (timeout, lost response).
 * The application always re-reads and looks for the exact signed event; no result
 * other than a verified receipt is treated as success.
 */
export type WriteResult = 'committed' | 'conflict' | 'denied' | 'unknown';

export interface Transport {
  read(): Promise<Snapshot>;
  write(snapshot: Snapshot, raw: string): Promise<WriteResult>;
}
