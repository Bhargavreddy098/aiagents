import type { Request, RequestHandler } from 'express';
import type { z, ZodTypeAny } from 'zod';
import { ApiError } from '@nexs/shared';

/**
 * Validates the request body and REPLACES it with the parsed result.
 *
 * Replacing rather than merging matters: the schemas strip unknown keys, so a client
 * cannot smuggle extra fields past validation to be picked up by a spread later.
 * Transformations apply too — `signupSchema` lowercases the email, and the handler
 * downstream sees the normalised value, not the raw one.
 *
 * Phase 2 only needs body validation. Query and params validation arrive with the
 * list endpoints that actually take them.
 */
export function validateBody<T extends ZodTypeAny>(schema: T): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new ApiError('VALIDATION_ERROR', 'Request failed validation', result.error.issues));
      return;
    }
    req.body = result.data;
    next();
  };
}

/**
 * Parse a request's query string, turning a zod failure into an `ApiError`.
 *
 * A function rather than a middleware, and that is deliberate. Express 5 made `req.query` a
 * getter with no setter, so the `validateBody` trick of replacing the property does not
 * work for the query — a middleware would have to smuggle the parsed value out through
 * `res.locals` or a symbol, which is more machinery than the problem deserves.
 *
 * Calling this at the top of a handler also puts the parse where the result is used, so
 * there is no question about whether it ran.
 */
export function parseQuery<T extends ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw new ApiError('VALIDATION_ERROR', 'Query failed validation', result.error.issues);
  }
  return result.data as z.infer<T>;
}

/**
 * Read a path parameter as a single non-empty string.
 *
 * Express 5 types `req.params[key]` as `string | string[]`, because a route may declare a
 * repeating segment (`/files/:segments*`). None of our routes do, so the array branch is
 * unreachable in practice — but the compiler cannot know that, and every `req.params['id']!`
 * would otherwise fail to satisfy a `string` parameter.
 *
 * Narrowing here rather than casting at the call site buys two things. First, it is one
 * place instead of sixteen. Second — and this is the real reason — a missing parameter
 * becomes a `NOT_FOUND` instead of `undefined`. `undefined` would flow into a repository
 * as `where: { id: undefined }`, and Prisma drops `undefined` filters rather than
 * rejecting them, so the query would silently widen to "the first row of any tenant"
 * instead of failing. That is the kind of bug that never shows up in a test with one
 * tenant in the database.
 */
export function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value === 'string' && value.length > 0) return value;
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0].length > 0) {
    return value[0];
  }
  throw new ApiError('NOT_FOUND', `Missing path parameter: ${name}`);
}
