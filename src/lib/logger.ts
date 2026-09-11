/**
 * Minimal structured logger. Intentionally dependency-free: the worker, the
 * seed script and the Next.js server all share it, and none of them need log
 * shipping for a local-only application.
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

function activeLevel(): Threshold {
  const raw = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (raw in LEVEL_ORDER) return raw as Threshold;
  // Tests deliberately drive jobs into failure, so their expected error output
  // is suppressed by default and re-enabled with LOG_LEVEL=error.
  return process.env.NODE_ENV === 'test' ? 'silent' : 'info';
}

function emit(level: Level, scope: string, message: string, fields?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[activeLevel()]) return;
  const time = new Date().toISOString();
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${suffix}`;
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
