// Operator-facing views of a request: phase, whose turn it is, next steps and the escaped
// negotiation history. Pure functions; remote text is escaped by display()/inline().
import { currentConfirmation, gapsOf, MAX_SUPPLIES, openAsk, resolvedBy, stateAt, type Entry, type Payload, type Request } from './domain.js';
import { display, inline } from './util.js';

export type Phase = 'offered' | 'questions-open' | 'answered' | 'confirmed' | 'accepted' | 'closed';
export function phaseOf(request: Request, now: number): Phase {
  const status = stateAt(request, now);
  if (status === 'accepted') return 'accepted';
  if (status !== 'pending') return 'closed';
  if (request.open) return 'questions-open';
  if (currentConfirmation(request)) return 'confirmed';
  return request.supplies ? 'answered' : 'offered';
}
/** Whose move it is: the recipient for every pending phase except an open question round. */
export function waitingOn(request: Request, now: number, account: string): 'you' | 'peer' | null {
  const phase = phaseOf(request, now);
  if (phase === 'closed') return null;
  const actor = phase === 'questions-open' ? request.sender : request.recipient;
  return actor === account ? 'you' : 'peer';
}

export function summary(request: Request, now: number, account: string) {
  return { id: request.id, kind: request.category, state: stateAt(request, now), phase: phaseOf(request, now),
    waitingOn: waitingOn(request, now, account), sender: request.sender, recipient: request.recipient,
    revision: request.revision, context: request.context, replies: request.replies.length,
    created: new Date(request.created).toISOString(), expires: new Date(request.expires).toISOString(),
    updated: new Date(request.updated).toISOString() };
}

export function nextSteps(request: Request, now: number, account: string): string[] {
  const id = request.id;
  const status = stateAt(request, now);
  const mine = request.recipient === account;
  const next: string[] = [];
  if (status === 'pending') {
    const phase = phaseOf(request, now);
    if (mine) {
      if (phase === 'questions-open') next.push('Waiting for the requester to answer your questions.');
      else if (phase === 'confirmed') next.push(`agentshake accept ${id} --body-file <work-brief>   (accepts the confirmed context)`);
      else {
        next.push(`Optional: brief your agent to help clarify (no work authority): agentshake brief ${id} --body-file <file>`);
        if (request.supplies < MAX_SUPPLIES) next.push(`Ask for missing context: agentshake ask ${id} --topic <what> --need <why>   (or --items-file <json>)`);
        next.push(`State your understanding and known limitations: agentshake confirm ${id} --understanding-file <file>`);
      }
      next.push(`agentshake decline ${id}`);
    } else {
      if (phase === 'questions-open') {
        next.push(`Answer the open questions: agentshake supply ${id} --answers-file <json>   (each supplied, unavailable or withheld)`,
          `Optional: brief your agent to help draft answers: agentshake brief ${id} --body-file <file>`);
      } else {
        next.push('Waiting for the peer to ask, confirm or accept.');
        if (request.supplies < MAX_SUPPLIES) {
          next.push(`Add context (makes any confirmation stale): agentshake supply ${id} --note-file <file>`);
          if (gapsOf(request).length) next.push(`Recovered an unavailable or withheld item? Resolve it: agentshake supply ${id} --answers-file <json with "resolutions">`);
        }
      }
      next.push(`To withdraw: agentshake cancel ${id}`);
    }
  }
  if (status === 'accepted') {
    next.push(`Update your agent's brief: agentshake brief ${id} --body-file <file>`);
    if (mine) {
      const own = request.replies.filter(reply => reply.actor === account).at(-1);
      next.push(own ? `agentshake complete ${id} --reply ${own.id} --outcome completed`
        : 'Publish a reply from your agent (agentshake drafts), then complete.');
    } else next.push(`To withdraw: agentshake cancel ${id}`);
  }
  if (status === 'completed' || status === 'failed') next.push(`Hand the result to your agent: agentshake brief ${id} --body-file <file>`);
  if (status === 'expired') next.push('The request expired and is closed. Ask your agent to draft a new one if still needed.');
  return next;
}

export const indent = (text: string, prefix = '  │ ') => text.split('\n').map(line => prefix + line).join('\n');
const short = (value: string) => value.slice(0, 8);
const STATUS_TEXT = { supplied: 'supplied', unavailable: 'unavailable (not provided)', withheld: 'withheld (not shared)' } as const;

function entryLines(request: Request, entry: Entry, who: (account: string) => string): string[] {
  const at = new Date(entry.at).toISOString();
  switch (entry.kind) {
    case 'ask': return [`ask ${entry.id} by ${who(entry.actor)} on context ${entry.context} at ${at}` +
      `${entry.answered ? `  [answered by ${short(entry.answered)}]` : request.open === entry.id ? '  [open]' : ''}`,
      ...entry.items.flatMap((item, index) => [`  ${index + 1}. ${inline(item.topic)}`, indent(display(item.need), '     why: ')])];
    case 'supply': return [`supply ${entry.id} by ${who(entry.actor)} → context ${entry.context} at ${at}` +
      (entry.ask ? `, answering ask ${short(entry.ask)}` : ', unsolicited'),
      ...entry.answers.flatMap(answer => {
        const resolution = answer.status !== 'supplied' && entry.ask ? resolvedBy(request, entry.ask, answer.item) : undefined;
        return [`  ${answer.item}. ${STATUS_TEXT[answer.status]}${resolution ? `  [resolved later by supply ${short(resolution)}]` : ''}`,
          ...(answer.body !== undefined ? [indent(display(answer.body), '     │ ')] : [])];
      }),
      ...entry.resolutions.flatMap(resolution => [`  resolves ask ${short(resolution.ask)} item ${resolution.item} (earlier unavailable or withheld):`,
        indent(display(resolution.body), '     │ ')]),
      ...(entry.note !== undefined ? ['  note:', indent(display(entry.note), '     │ ')] : [])];
    case 'confirm': {
      const current = currentConfirmation(request)?.id === entry.id;
      const accepted = request.accepted?.confirmation === entry.id;
      return [`confirm ${entry.id} by ${who(entry.actor)} on context ${entry.context} at ${at}  ` +
        `[${accepted ? 'accepted' : current ? 'current' : 'stale: the context or questions changed after it'}]`,
        '  understanding:', indent(display(entry.understanding), '     │ '),
        entry.gaps.length ? `  unresolved limitations at that context: ${entry.gaps.map(gap => `ask ${short(gap.ask)} item ${gap.item} ${gap.status}`).join('; ')}`
          : '  unresolved limitations at that context: none'];
    }
  }
}

export function negotiationLines(request: Request, who: (account: string) => string): string[] {
  if (!request.negotiation.length) return ['negotiation: none yet'];
  const gaps = gapsOf(request);
  return ['negotiation (remote text shown escaped; unavailable and withheld items are gaps, not evidence):',
    ...request.negotiation.flatMap(entry => entryLines(request, entry, who).map(line => '  ' + line)),
    `  current unresolved limitations: ${gaps.length ? gaps.map(gap => `ask ${short(gap.ask)} item ${gap.item} ${gap.status}`).join('; ') : 'none'}`,
    ...(request.accepted ? [`  accepted on context ${request.context.revision} citing confirmation ${request.accepted.confirmation}`] : [])];
}

/** Preview text for an action; questions being answered are shown next to the answers. */
export function describePayload(payload: Payload, request: string, record?: Request): string {
  switch (payload.kind) {
    case 'offer': return `offer ${payload.category} request ${request} (expires in ${payload.ttlHours}h)\n` +
      `title: ${inline(payload.title)}\nbody:\n${indent(display(payload.body))}`;
    case 'reply': return `reply on request ${request} (post-accept result discussion)\nbody:\n${indent(display(payload.body))}`;
    case 'complete': return `complete request ${request} as ${payload.outcome}, citing reply ${payload.reply}`;
    case 'ask': return `ask for missing context on request ${request} (context ${record?.context.revision}, digest ${short(payload.context)})\n` +
      payload.items.map((item, index) => `  ${index + 1}. ${inline(item.topic)}\n${indent(display(item.need), '     why: ')}`).join('\n');
    case 'supply': {
      const ask = record ? openAsk(record) : undefined;
      const lines = [`supply context on request ${request}: context ${record?.context.revision} → ${(record?.context.revision ?? 0) + 1}` +
        (payload.ask ? `, answering ask ${payload.ask}` : ', unsolicited (makes any confirmation stale)')];
      for (const answer of payload.answers) {
        const item = ask?.items[answer.item - 1];
        lines.push(`  ${answer.item}. question (peer text): ${item ? inline(item.topic) : '?'}`, `     answer: ${STATUS_TEXT[answer.status]}`);
        if (answer.body !== undefined) lines.push(indent(display(answer.body), '     │ '));
      }
      for (const resolution of payload.resolutions ?? []) {
        lines.push(`  resolves ask ${resolution.ask} item ${resolution.item} (earlier unavailable or withheld) with:`,
          indent(display(resolution.body), '     │ '));
      }
      if (payload.note !== undefined) lines.push('  note:', indent(display(payload.note), '     │ '));
      return lines.join('\n');
    }
    case 'confirm': return `confirm your understanding of request ${request} at context ${record?.context.revision} (digest ${short(payload.context)})\n` +
      `understanding:\n${indent(display(payload.understanding))}\n` +
      (payload.gaps.length ? `current unresolved limitations you confirm (not provided, not evidence):\n${payload.gaps.map(gap =>
        `  ask ${gap.ask} item ${gap.item}: ${gap.status}`).join('\n')}` : 'current unresolved limitations: none (every asked item was supplied or resolved)');
    case 'accept': return `accept request ${request} at context ${record?.context.revision} (digest ${short(payload.context)}), ` +
      `citing your confirmation ${payload.confirmation}`;
    default: return `${payload.kind} request ${request}`;
  }
}
