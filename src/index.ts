// Library entry point for embedding and for alternative transports.
export * from './domain.js';
export { assertProfileProtocol, briefFor, Mailbox, type BriefPlan, type Context, type Operation, type Pairing,
  type Plan } from './mailbox.js';
export { Profile, createDraft, listBriefs, readBrief, type Brief, type Draft, type Paths } from './local.js';
export * from './negotiate.js';
export * from './transport/index.js';
export { VERSION } from './version.js';
