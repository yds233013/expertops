import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AppError, isAppError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/**
 * The single place domain errors become HTTP responses.
 *
 * Route handlers call a service and let this function translate whatever comes
 * back, so an error message is written once, in the service that owns the rule.
 */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function errorResponse(error: unknown): NextResponse<ApiErrorBody> {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'Request body failed validation.',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  if (isAppError(error)) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.status },
    );
  }

  logger.error('unhandled error in route handler', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack?.split('\n').slice(0, 4).join(' | ') : undefined,
  });

  return NextResponse.json(
    { error: { code: 'INTERNAL', message: 'Something went wrong handling this request.' } },
    { status: 500 },
  );
}

export function ok<T>(data: T, status = 200): NextResponse<T> {
  return NextResponse.json(data, { status });
}

export function created<T>(data: T): NextResponse<T> {
  return NextResponse.json(data, { status: 201 });
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

/** Wrap a handler so every thrown AppError lands on the right status code. */
export function route<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError('BAD_REQUEST', 'Request body must be valid JSON.');
  }
  return schema.parse(body);
}
