/** Auth-related shared contracts (no runtime deps beyond zod). */

export interface AccessTokenClaims {
  /** userId */
  sub: string;
  tenantId: string;
  typ: 'access';
  /**
   * The user's `tokenVersion` at signing time. Changing a password bumps it, which
   * invalidates every access token minted before the change without needing a
   * server-side session table.
   */
  tv: number;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  tenantId: string;
  tenantName: string;
}

/**
 * The authenticated principal the auth middleware attaches to a request.
 *
 * It lives here rather than in the HTTP layer so services can depend on it without
 * importing upwards into Express — the direction of that dependency would otherwise
 * be inverted.
 */
export interface AuthContext {
  userId: string;
  tenantId: string;
  tokenVersion: number;
}

export interface AuthResponse {
  user: AuthUser;
}

/** Access JWT cookie — sent on every request. */
export const COOKIE_ACCESS = 'nexs_at';
/** Refresh token cookie — deliberately scoped to the auth routes only. */
export const COOKIE_REFRESH = 'nexs_rt';
export const REFRESH_COOKIE_PATH = '/api/auth';

/** OWASP-recommended argon2id parameters ("cost 19" = 19 MiB memory). */
export const ARGON2_PARAMS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
