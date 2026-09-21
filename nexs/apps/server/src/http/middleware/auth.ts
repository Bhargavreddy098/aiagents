import type { Request, RequestHandler } from 'express';
import { ApiError, COOKIE_ACCESS, type AuthContext } from '@nexs/shared';
import type { UserRepo } from '../../repositories/ports.js';
import type { TokenService } from '../../services/auth/token.service.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set only on routes behind `createAuthRequired`. */
      auth?: AuthContext;
    }
  }
}

export interface AuthMiddlewareDeps {
  users: UserRepo;
  tokens: TokenService;
}

/**
 * Prefer the httpOnly cookie; fall back to `Authorization: Bearer` so scripts, tests
 * and future non-browser clients can authenticate without a cookie jar.
 */
function readAccessToken(req: Request): string | null {
  const fromCookie: unknown = req.cookies?.[COOKIE_ACCESS];
  if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie;

  const header = req.header('authorization');
  if (header !== undefined && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token.length > 0) return token;
  }

  return null;
}

/**
 * Authentication only — it establishes *who* is calling, never *what they may do*.
 * Authorisation belongs to the per-resource checks that come with Phase 3+.
 */
export function createAuthRequired(deps: AuthMiddlewareDeps): RequestHandler {
  return async (req, _res, next) => {
    try {
      const raw = readAccessToken(req);
      if (raw === null) throw new ApiError('UNAUTHORIZED', 'Authentication required');

      const claims = await deps.tokens.verifyAccessToken(raw);
      if (claims === null) throw new ApiError('UNAUTHORIZED', 'Invalid or expired access token');

      // The tenant comes from the signed token, but the account is still re-read from
      // the database through the tenant-scoped lookup: a deleted user, or one whose
      // tokenVersion moved on, must stop working before the JWT expires.
      const user = await deps.users.findById(claims.tenantId, claims.sub);
      if (user === null) throw new ApiError('UNAUTHORIZED', 'Account is no longer active');
      if (user.tokenVersion !== claims.tv) {
        throw new ApiError('UNAUTHORIZED', 'Session is no longer valid');
      }

      req.auth = { userId: user.id, tenantId: user.tenantId, tokenVersion: user.tokenVersion };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Read the principal inside a handler. Throwing here means a route was mounted
 * without `createAuthRequired` — a wiring bug, not a client error, but it must still
 * fail closed rather than run with an undefined tenant.
 */
export function requireAuth(req: Request): AuthContext {
  if (req.auth === undefined) {
    throw new ApiError('UNAUTHORIZED', 'Authentication required');
  }
  return req.auth;
}
