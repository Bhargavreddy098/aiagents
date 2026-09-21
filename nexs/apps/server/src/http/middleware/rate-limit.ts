import rateLimit from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import { ERROR_CODES } from '@nexs/shared';

/**
 * A fixed-window limiter that speaks the API's error envelope.
 *
 * On `/api/auth/login` this is what stops the endpoint from being an offline
 * password-guessing oracle: the argon2 cost slows each attempt, but nothing else
 * stops the attempts themselves.
 *
 * Keyed by IP by default. `/api/chat*` overrides that with `keyGenerator` because
 * the spec's limit there is **per user, not per IP**: everyone behind one office
 * NAT would otherwise share a 30/min budget, and one person pasting into a chat
 * would lock out their colleagues. The IP limiter is still the outer layer — see
 * `createApp` — so an unauthenticated flood is still caught.
 */
export function createRateLimiter(
  limitPerMinute: number,
  options: {
    /**
     * What the window is keyed on. Defaults to the client IP.
     *
     * A key generator that returns the same string for every request would make the
     * limiter global, which is why the user fallback below is deliberately the IP
     * rather than a constant: an unauthenticated request to a user-keyed route is
     * still one request from somewhere, and must still be counted.
     */
    keyGenerator?: (req: Request) => string;
  } = {},
): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(options.keyGenerator === undefined
      ? {}
      : { keyGenerator: (req) => options.keyGenerator?.(req as Request) ?? req.ip ?? 'unknown' }),
    // Respond with the API's own error envelope, not the library's plain-text body.
    handler: (_req, res) => {
      res.status(ERROR_CODES.RATE_LIMITED).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many attempts. Please try again shortly.',
        },
      });
    },
  });
}

/**
 * Per-user key for the chat limiter.
 *
 * Falls back to the IP for a request that has not been authenticated yet — `authRequired`
 * runs first on every chat route, so in practice this always sees a user, but a limiter that
 * silently keys unauthenticated traffic together would be a bypass waiting to happen.
 */
export function userKey(req: Request): string {
  return req.auth?.userId ?? req.ip ?? 'unknown';
}
