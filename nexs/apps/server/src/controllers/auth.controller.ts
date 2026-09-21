import type { RequestHandler } from 'express';
import {
  ApiError,
  type AuthResponse,
  type LoginInput,
  type PasswordResetConfirmInput,
  type PasswordResetRequestInput,
  type SignupInput,
} from '@nexs/shared';
import type { Config } from '../config.js';
import { clearAuthCookies, readRefreshCookie, setAuthCookies } from '../http/cookies.js';
import type { Logger } from '../logger.js';
import type { AuthService } from '../services/auth/auth.service.js';
import type { PasswordResetService } from '../services/auth/password-reset.service.js';

export interface AuthControllerDeps {
  auth: AuthService;
  passwordReset: PasswordResetService;
  config: Config;
  logger: Logger;
}

export interface AuthController {
  signup: RequestHandler;
  login: RequestHandler;
  refresh: RequestHandler;
  logout: RequestHandler;
  requestPasswordReset: RequestHandler;
  confirmPasswordReset: RequestHandler;
}

/**
 * Controllers stay thin on purpose: parse nothing (the schema middleware already did),
 * decide nothing (the service owns the rules), and translate the outcome into HTTP.
 * The token pair never appears in a response body — it only travels in cookies.
 */
export function createAuthController(deps: AuthControllerDeps): AuthController {
  const { config, logger } = deps;

  return {
    signup: async (req, res, next) => {
      try {
        const result = await deps.auth.signup(req.body as SignupInput);
        setAuthCookies(res, config, result.tokens);
        res.status(201).json({ user: result.user } satisfies AuthResponse);
      } catch (err) {
        next(err);
      }
    },

    login: async (req, res, next) => {
      try {
        const result = await deps.auth.login(req.body as LoginInput);
        setAuthCookies(res, config, result.tokens);
        res.status(200).json({ user: result.user } satisfies AuthResponse);
      } catch (err) {
        next(err);
      }
    },

    refresh: async (req, res, next) => {
      try {
        const raw = readRefreshCookie(req.cookies);
        if (raw === null) throw new ApiError('UNAUTHORIZED', 'Refresh token is missing');

        const result = await deps.auth.refresh(raw).catch((err: unknown) => {
          // The presented token is unusable (expired, revoked, or evidence of theft).
          // Drop the stale cookies so the browser stops sending them.
          clearAuthCookies(res, config);
          throw err;
        });

        setAuthCookies(res, config, result.tokens);
        res.status(200).json({ user: result.user } satisfies AuthResponse);
      } catch (err) {
        next(err);
      }
    },

    logout: async (req, res, next) => {
      try {
        const raw = readRefreshCookie(req.cookies);
        if (raw !== null) await deps.auth.logout(raw);
        clearAuthCookies(res, config);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    requestPasswordReset: async (req, res, next) => {
      try {
        const input = req.body as PasswordResetRequestInput;
        const { token } = await deps.passwordReset.request(input);

        // Always 202, whether or not the email exists — a different status would tell
        // the caller which addresses are registered.
        const body: { ok: true; token?: string } = { ok: true };

        if (token !== null) {
          logger.info('password reset token issued');
          if (config.NODE_ENV !== 'production') {
            // No mail provider is wired up yet. Outside production the token is echoed
            // so the flow is completable locally; in production it is emailed only and
            // must never appear in a response body.
            body.token = token;
          }
        }

        res.status(202).json(body);
      } catch (err) {
        next(err);
      }
    },

    confirmPasswordReset: async (req, res, next) => {
      try {
        await deps.passwordReset.confirm(req.body as PasswordResetConfirmInput);
        // The reset revoked every refresh token for the user, so this browser's
        // cookies are dead too. Clearing them avoids a confusing 401 on the next call.
        clearAuthCookies(res, config);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  };
}
