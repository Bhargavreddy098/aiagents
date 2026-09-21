import type { RequestHandler } from 'express';
import { type AuthResponse, type SetOwnerInput, type UpdateMeInput } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import type { UserService } from '../services/user.service.js';

export interface UserControllerDeps {
  users: UserService;
}

export interface UserController {
  me: RequestHandler;
  updateMe: RequestHandler;
  /** Claim or transfer the command owner (UI/UX v2 §5.6). */
  setOwner: RequestHandler;
}

export function createUserController(deps: UserControllerDeps): UserController {
  return {
    me: async (req, res, next) => {
      try {
        const user = await deps.users.getProfile(requireAuth(req));
        res.status(200).json({ user } satisfies AuthResponse);
      } catch (err) {
        next(err);
      }
    },

    updateMe: async (req, res, next) => {
      try {
        const user = await deps.users.updateProfile(requireAuth(req), req.body as UpdateMeInput);
        res.status(200).json({ user } satisfies AuthResponse);
      } catch (err) {
        next(err);
      }
    },

    /**
     * Claim or transfer command ownership (§5.6).
     *
     * `claimed` is in the response because the two outcomes are the same row write and completely
     * different events: a first claim in an unowned workspace, versus a privilege transferring
     * itself. A client that renders them identically ("Owner updated") would hide the one case an
     * operator might want to be told about.
     */
    setOwner: async (req, res, next) => {
      try {
        const result = await deps.users.setOwner(requireAuth(req), req.body as SetOwnerInput);
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },
  };
}
