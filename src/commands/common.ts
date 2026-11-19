// CLI edge: the output envelope shared by every command module, and request-ID parsing.
import { idSchema, parsed } from '../domain.js';
import { guard, safeJson } from '../util.js';

export type Output = { data: unknown; human?: string; next?: string | string[] };
export type Emit = (output: Output) => void;

/** With JSON mode, `next` is merged into object data; otherwise text is guarded for the terminal. */
export function emitter(json: () => boolean): Emit {
  return output => {
    const next = output.next === undefined ? [] : Array.isArray(output.next) ? output.next : [output.next];
    if (json()) {
      const data = output.data !== null && typeof output.data === 'object' && !Array.isArray(output.data)
        ? { ...output.data as object, ...(next.length ? { next } : {}) } : output.data;
      process.stdout.write(safeJson(data) + '\n');
      return;
    }
    const text = output.human ?? safeJson(output.data, 2);
    process.stdout.write(guard(text) + '\n');
    for (const line of next) process.stdout.write(guard('next: ' + line) + '\n');
  };
}

export const id = (value: string, label = 'ID') => parsed(idSchema, value, `${label} (expected a UUID)`);
