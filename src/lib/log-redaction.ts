/**
 * What must never reach a log line.
 *
 * Three categories, each from a real mistake this project has already made or
 * come close to:
 *
 *  * **Credentials and secrets.** A password or `AUTH_SECRET` in a log is a
 *    credential that outlives the request and gets copied into bug reports.
 *  * **Access tokens and the URLs that carry them.** A magic link is a
 *    bearer credential. An earlier version of this build put one in the request
 *    path, where the server wrote it to its own access log; that is fixed at
 *    the source, and this is the second line of defence.
 *  * **Message bodies.** The simulated outbox holds what was written *to* a
 *    person. Logging it turns an operational log into a copy of their
 *    correspondence.
 *
 * Redaction is by field name, and by pattern for anything that looks like a
 * magic link wherever it appears.
 */
const SECRET_FIELD = /(password|secret|token|authorization|cookie|credential|apikey|api_key)/i;

/**
 * Fields whose *content* is somebody's message rather than an operational fact.
 *
 * `message` is deliberately absent. It is the field name every error carries,
 * and redacting it turned "Cannot read properties of undefined (reading
 * 'findFirst')" into "[redacted] (57 chars)" in a log an operator was reading
 * to diagnose a broken login. The specific carriers of participant-facing text
 * are listed instead.
 */
const BODY_FIELD =
  /^(body|bodyText|bodyHtml|content|note|reply|answers|privateNotes|declineReason|revisionRequest)$/i;

/** A magic link, wherever it turns up inside a string. */
const MAGIC_LINK = /(https?:\/\/[^\s"']*\/(?:apply|portal)\/enter)(#\S*|\/\S*)?/gi;

export const REDACTED = '[redacted]';

function redactString(value: string): string {
  return value.replace(MAGIC_LINK, (_match, prefix: string) => `${prefix}#${REDACTED}`);
}

/**
 * Copy a field map with anything sensitive replaced.
 *
 * Keys are kept so a log line still says *that* a token was involved, which is
 * usually the operationally useful part, without saying which one.
 */
export function redactFields(
  fields: Record<string, unknown> | undefined,
  depth = 0,
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  if (depth > 4) return { truncated: true };

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_FIELD.test(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (BODY_FIELD.test(key)) {
      // The length is an operational fact; the text is not ours to log.
      out[key] = typeof value === 'string' ? `${REDACTED} (${value.length} chars)` : REDACTED;
      continue;
    }
    if (typeof value === 'string') {
      out[key] = redactString(value);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactFields(value as Record<string, unknown>, depth + 1);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.map((entry) => (typeof entry === 'string' ? redactString(entry) : entry));
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Applied to the message itself, which is written by us but can interpolate. */
export function redactMessage(message: string): string {
  return redactString(message);
}
