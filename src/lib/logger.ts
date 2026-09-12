import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { redactFields, redactMessage } from './log-redaction';

/**
 * Minimal structured logger. Intentionally dependency-free: the worker, the
 * seed script and the Next.js server all share it, and none of them need log
 * shipping for a local-only application.
 *
 * Two things beyond printing a line:
 *
 *  * **A correlation id** on every line, carried through whatever the request
 *    or job goes on to do. Without one, a failure in a service is a line with
 *    no way back to the request that caused it, and the usual substitute —
 *    logging identifiers by hand at each layer — is the thing everybody forgets
 *    under pressure.
 *  * **Redaction**, applied here rather than at call sites, because a rule that
 *    depends on every caller remembering it is not a rule. See
 *    `log-redaction.ts` for what is removed and why.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';
type Threshold = Level | 'silent';

const LEVEL_ORDER: Record<Threshold, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface LogContext {
  /** Ties every line produced by one request or one job together. */
  correlationId: string;
  /** What started it: `http`, `job`, `cli`. */
  source?: string;
  /** Route, job type, or script name. */
  operation?: string;
}

const contextStore = new AsyncLocalStorage<LogContext>();

export function newCorrelationId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Run `fn` with a correlation context that every log line inherits.
 *
 * Async-local storage rather than an explicit parameter, so a service three
 * layers down does not have to accept a logger it does not otherwise need.
 */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
  return contextStore.run(context, fn);
}

export function currentLogContext(): LogContext | undefined {
  return contextStore.getStore();
}

function activeLevel(): Threshold {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (raw in LEVEL_ORDER) return raw as Threshold;
  // Tests deliberately drive jobs into failure, so their expected error output
  // is suppressed by default and re-enabled with LOG_LEVEL=error.
  return process.env.NODE_ENV === 'test' ? 'silent' : 'info';
}

/** One JSON object per line when asked, otherwise the readable form. */
function structured(): boolean {
  return (process.env.LOG_FORMAT ?? '').toLowerCase() === 'json';
}

function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;

  const context = contextStore.getStore();
  const safeMessage = redactMessage(message);
  const safeFields = redactFields(fields);
  const time = new Date().toISOString();

  let line: string;
  if (structured()) {
    line = JSON.stringify({
      time,
      level,
      scope,
      message: safeMessage,
      ...(context?.correlationId ? { correlationId: context.correlationId } : {}),
      ...(context?.source ? { source: context.source } : {}),
      ...(context?.operation ? { operation: context.operation } : {}),
      ...(safeFields ?? {}),
    });
  } else {
    const correlation = context?.correlationId ? ` (${context.correlationId})` : '';
    const suffix =
      safeFields && Object.keys(safeFields).length > 0 ? ` ${JSON.stringify(safeFields)}` : '';
    line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}]${correlation} ${safeMessage}${suffix}`;
  }

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}

export const logger = createLogger('expertops');
