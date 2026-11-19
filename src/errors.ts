// Errors and exit codes. Messages are fixed strings authored by Agentshake; remote or
// user input values are never echoed into them.
export const EXIT = { usage: 2, access: 3, conflict: 4, temporary: 5, integrity: 6 } as const;
export type Reason = keyof typeof EXIT;

export class AgentshakeError extends Error {
  readonly code: number;
  constructor(readonly reason: Reason, message: string, readonly next?: string) {
    super(message);
    this.code = EXIT[reason];
  }
}
const fail = (reason: Reason) => (message: string, next?: string): never => {
  throw new AgentshakeError(reason, message, next);
};
export const invalid = fail('usage');
export const access = fail('access');
export const conflict = fail('conflict');
export const temporary = fail('temporary');
export const integrity = fail('integrity');

/** Where the immutable v0.1.0 release lives, for finishing protocol 1 mailboxes. */
export const V1_RELEASE = 'https://github.com/codefulteam/agentshake/releases/download/v0.1.0/agentshake-0.1.0.tgz';
export const V1_PROFILE_NEXT = `This profile is unchanged. To finish its protocol 1 work, run Agentshake 0.1.0 on it: ` +
  `npm exec --yes --package=${V1_RELEASE} -- agentshake --profile <this-dir> inbox. ` +
  'To use protocol 2, start a new profile and a new mailbox: AGENTSHAKE_HOME=<new-dir> agentshake key init ' +
  '(see docs/protocol.md#versioning).';
