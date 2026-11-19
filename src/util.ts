import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { integrity } from './domain.js';

export function utf8(buf: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); }
  catch { return integrity('Invalid UTF-8 input.'); }
}

/** Opens (creating with mode 0600 when absent) a SQLite database with conservative pragmas. */
export function database(path: string): DatabaseSync {
  // Create without following a planted symlink, then require a plain single-link file.
  const descriptor = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.nlink !== 1) integrity(`Refusing to open ${path}: not a regular single-link file.`);
  } finally { closeSync(descriptor); }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;');
  return db;
}

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu;
const UNSAFE_OR_BACKSLASH = /[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu;

/**
 * Terminal-safe, reversible text: a literal backslash is shown as \\, and controls,
 * bidi/format characters and unassigned code points as \u{hex}. Newlines are kept.
 */
export function display(text: string): string {
  return text.replace(UNSAFE_OR_BACKSLASH, character => character === '\n' ? '\n' : character === '\\' ? '\\\\' :
    '\\u{' + character.codePointAt(0)!.toString(16) + '}');
}

/**
 * Final terminal guard for assembled output: escapes controls and format characters but
 * leaves backslashes alone, so it is idempotent on text already passed through display().
 */
export function guard(text: string): string {
  return text.replace(UNSAFE, character => character === '\n' ? '\n' : '\\u{' + character.codePointAt(0)!.toString(16) + '}');
}

/** Single-line terminal-safe text. */
export function inline(text: string): string {
  return display(text).replace(/\n/g, '\\n');
}

/** JSON where every non-printable or format character is \u-escaped, so it is safe on a terminal. */
export function safeJson(value: unknown, indent?: number): string {
  // JSON.stringify already escapes newlines inside strings; a raw newline is layout only.
  return JSON.stringify(value, null, indent).replace(UNSAFE, character => character === '\n' ? '\n' :
    character.split('').map(unit => '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
}
