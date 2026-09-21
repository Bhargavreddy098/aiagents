import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError, ERROR_CODES } from '@nexs/shared';
import type { Logger } from '../../logger.js';

/** Terminal 404 — anything that fell through the router. */
export const notFound: RequestHandler = (_req, res) => {
  res.status(ERROR_CODES.NOT_FOUND).json({
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  });
};

/**
 * One consistent error shape for every failure:
 *   { error: { code, message, details? } }
 * Unknown errors become a generic 500 — never leak a stack trace to a client.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(ERROR_CODES.VALIDATION_ERROR).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request failed validation',
          details: err.issues,
        },
      });
      return;
    }

    if (err instanceof ApiError) {
      res.status(err.http).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
      return;
    }

    logger.error(
      { err, correlationId: req.correlationId, path: req.path, method: req.method },
      'unhandled error',
    );

    res.status(ERROR_CODES.INTERNAL_ERROR).json({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  };
}
