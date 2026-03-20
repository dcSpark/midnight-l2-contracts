import { inspect } from 'node:util';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Walk `Error.cause` and Effect-style `{ _tag, message, cause }` links so CLI users
 * see the real Compact assert (e.g. `failed assert: BAD_SIG_0`) instead of only the
 * scoped-transaction wrapper message.
 */
export function formatErrorChain(err: unknown, maxDepth = 16): string {
  const lines: string[] = [];
  let cur: unknown = err;
  for (let d = 0; d < maxDepth && cur != null; d += 1) {
    if (cur instanceof Error) {
      const extra =
        '_tag' in cur && typeof (cur as { _tag: unknown })._tag === 'string'
          ? ` [${(cur as { _tag: string })._tag}]`
          : '';
      lines.push(`${d}: ${cur.name}${extra}: ${cur.message}`);
      cur = cur.cause;
      continue;
    }
    if (isRecord(cur) && typeof cur._tag === 'string') {
      const msg = typeof cur.message === 'string' ? cur.message : '';
      lines.push(`${d}: ${cur._tag}${msg ? `: ${msg}` : ''}`);
      cur = cur.cause;
      continue;
    }
    lines.push(`${d}: ${inspect(cur, { depth: 6, breakLength: 120 })}`);
    break;
  }
  return lines.join('\n');
}
