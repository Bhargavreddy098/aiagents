import type { RequestHandler } from 'express';
import {
  listSkillsSchema,
  type CreateSkillInput,
  type CreateSkillVersionInput,
  type UpdateSkillInput,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { SkillService } from '../services/skills/skill.service.js';

/**
 * `/api/skills` — the tenant's library of reusable prompt templates.
 *
 * Thin by design, like every other controller here. The rule worth knowing before reading further
 * is that **a version is published, never edited**: `publishVersion` is the only route that changes
 * what a skill *says*, and it always creates a new version rather than rewriting one.
 */
export interface SkillControllerDeps {
  skills: SkillService;
}

export interface SkillController {
  list: RequestHandler;
  create: RequestHandler;
  get: RequestHandler;
  update: RequestHandler;
  remove: RequestHandler;
  listVersions: RequestHandler;
  publishVersion: RequestHandler;
}

export function createSkillController(deps: SkillControllerDeps): SkillController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({
          skills: await deps.skills.list(tenantId, parseQuery(listSkillsSchema, req)),
        });
      } catch (err) {
        next(err);
      }
    },

    create: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const skill = await deps.skills.create(tenantId, req.body as CreateSkillInput);
        res.status(201).json({ skill });
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ skill: await deps.skills.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    update: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const skill = await deps.skills.update(
          tenantId,
          pathParam(req, 'id'),
          req.body as UpdateSkillInput,
        );
        res.status(200).json({ skill });
      } catch (err) {
        next(err);
      }
    },

    remove: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.skills.remove(tenantId, pathParam(req, 'id'));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    listVersions: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({
          versions: await deps.skills.listVersions(tenantId, pathParam(req, 'id')),
        });
      } catch (err) {
        next(err);
      }
    },

    /**
     * 201, because a version is a new row rather than a mutation of the skill.
     *
     * The response carries the whole skill so the client can render the new `latestVersion` without
     * a follow-up read — and so there is no window in which a client holds a version the server's
     * own view does not yet agree with.
     */
    publishVersion: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const skill = await deps.skills.publishVersion(
          tenantId,
          pathParam(req, 'id'),
          req.body as CreateSkillVersionInput,
        );
        res.status(201).json({ skill });
      } catch (err) {
        next(err);
      }
    },
  };
}
