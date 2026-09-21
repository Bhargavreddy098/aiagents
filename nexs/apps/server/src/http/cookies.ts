import type { CookieOptions, Response } from 'express';
import { COOKIE_ACCESS, COOKIE_REFRESH, REFRESH_COOKIE_PATH } from '@nexs/shared';
import type { Config } from '../config.js';
import type { SessionTokens } from '../services/auth/auth.service.js';

/**
 * Both tokens live in httpOnly cookies rather than in JavaScript-readable storage.
 * A token that JS can read is a token that an XSS payload can exfiltrate; an httpOnly
 * cookie cannot be read at all.
 *
 * The cost is CSRF exposure, which `sameSite: 'lax'` covers for this app: the SPA and
 * the API are same-site, and `lax` blocks cookies on cross-site POST/PATCH/DELETE.
 * `secure` is on in production so the cookie never crosses plain HTTP.
 */
function baseOptions(config: Config): CookieOptions {
  return {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax',
  };
}

export function setAuthCookies(res: Response, config: Config, tokens: SessionTokens): void {
  res.cookie(COOKIE_ACCESS, tokens.accessToken, {
    ...baseOptions(config),
    path: '/',
    expires: tokens.accessTokenExpiresAt,
  });

  res.cookie(COOKIE_REFRESH, tokens.refreshToken, {
    ...baseOptions(config),
    // Scoped to the auth routes only. The refresh token is therefore absent from
    // ordinary API requests, so a leaked request log or proxy has nothing to harvest.
    path: REFRESH_COOKIE_PATH,
    expires: tokens.refreshTokenExpiresAt,
  });
}

export function clearAuthCookies(res: Response, config: Config): void {
  res.clearCookie(COOKIE_ACCESS, { ...baseOptions(config), path: '/' });
  res.clearCookie(COOKIE_REFRESH, { ...baseOptions(config), path: REFRESH_COOKIE_PATH });
}

/** `req.cookies` is untyped, so read the one value we need defensively. */
export function readRefreshCookie(cookies: unknown): string | null {
  if (typeof cookies !== 'object' || cookies === null) return null;
  const value = (cookies as Record<string, unknown>)[COOKIE_REFRESH];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
