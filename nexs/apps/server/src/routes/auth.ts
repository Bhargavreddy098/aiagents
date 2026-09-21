import { Router } from 'express';
import {
  loginSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  signupSchema,
} from '@nexs/shared';
import type { AuthController } from '../controllers/auth.controller.js';
import { createRateLimiter } from '../http/middleware/rate-limit.js';
import { validateBody } from '../http/middleware/validate.js';

export interface AuthRouterDeps {
  controller: AuthController;
  rateLimitPerMinute: number;
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const limiter = createRateLimiter(deps.rateLimitPerMinute);
  const { controller } = deps;

  router.post('/signup', limiter, validateBody(signupSchema), controller.signup);
  router.post('/login', limiter, validateBody(loginSchema), controller.login);

  // No body validation on these two: the refresh token arrives in an httpOnly cookie,
  // so there is no JSON payload to validate.
  router.post('/refresh', limiter, controller.refresh);
  router.post('/logout', controller.logout);

  router.post(
    '/password-reset/request',
    limiter,
    validateBody(passwordResetRequestSchema),
    controller.requestPasswordReset,
  );
  router.post(
    '/password-reset/confirm',
    limiter,
    validateBody(passwordResetConfirmSchema),
    controller.confirmPasswordReset,
  );

  return router;
}
