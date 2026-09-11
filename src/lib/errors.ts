/**
 * Domain error taxonomy.
 *
 * Business services throw these; the HTTP layer maps them to status codes in
 * exactly one place (`src/server/http/respond.ts`). Route handlers never
 * re-implement a rule in order to produce a nicer error.
 */
export type AppErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'CAPACITY_EXCEEDED'
  | 'RATE_LIMITED'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  CAPACITY_EXCEEDED: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError('BAD_REQUEST', message, details);
export const unauthenticated = (message = 'Authentication required') =>
  new AppError('UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have access to this action') =>
  new AppError('FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError('NOT_FOUND', message);
export const conflict = (message: string, details?: unknown) =>
  new AppError('CONFLICT', message, details);
export const invalidState = (message: string, details?: unknown) =>
  new AppError('INVALID_STATE', message, details);
export const capacityExceeded = (message: string, details?: unknown) =>
  new AppError('CAPACITY_EXCEEDED', message, details);

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Narrow a thrown value to a readable message without leaking stack traces. */
export function errorMessage(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
