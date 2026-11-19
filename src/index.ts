// Library entry point for embedding and for alternative transports.
export * from './domain.js';
export { assertProfileProtocol, briefFor, Mailbox, type BriefPlan, type Context, type Operation, type Pairing,
  type Plan } from './mailbox.js';
export { Profile, createDraft, listBriefs, readBrief, type Brief, type Draft, type Paths } from './local.js';
export * from './negotiate.js';
export * from './transport/index.js';
export { VERSION } from './version.js';
export { briefSchema, draftSchema } from './local.js';
export { capabilities, capabilitiesSchema, DRAFT_ACTIONS, OPERATIONS, SCHEMA_IDS, type Capabilities } from './capabilities.js';
export { DOCUMENT_KINDS, summarize, validate, type DocumentKind, type LedgerSummary, type Validation } from './validate.js';
export { commandValidator, compare, DEFAULT_MANIFEST, loadManifest, manifestSchema, normalizeSummary, referenceValidator, runConformance,
  SPEC_ROOT, type ConformanceReport, type Manifest, type Validator } from './conformance.js';
