import type { RequestHandler } from 'express';
import {
  listExecRulesSchema,
  type CheckExecInput,
  type DecideExecApprovalInput,
  type RequestExecApprovalInput,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { pathParam, parseQuery } from '../http/middleware/validate.js';
import type { ApprovalService } from '../services/approvals/approval.service.js';

/**
 * `/api/approvals/exec*` — the owner-only command gate (UI/UX v2 §4.4).
 *
 * A controller of its own rather than more methods on `ApprovalController`, because the two
 * answer **different questions**. That one decides step 3 of a plan; this one decides whether
 * an operator's command may run, and whether a *standing* permission is created as a result.
 * They share a table and a compare-and-swap, not a vocabulary. Keeping them in separate files
 * is what makes it structurally awkward to route `allow_always` at a tool approval by mistake.
 *
 * Every route here is owner-gated inside `ApprovalService`, not here. The check could live in
 * the controller, but then a second caller (the CLI, a channel button) would need to repeat it
 * — and one of them would forget. A controller authenticates; the service authorises.
 */
export interface ExecApprovalControllerDeps {
  approvals: ApprovalService;
}

export interface ExecApprovalController {
  request: RequestHandler;
  decide: RequestHandler;
  check: RequestHandler;
  listRules: RequestHandler;
  revokeRule: RequestHandler;
}

export function createExecApprovalController(
  deps: ExecApprovalControllerDeps,
): ExecApprovalController {
  return {
    /**
     * Raise an approval for a command that is about to run.
     *
     * 201 with the approval, because a request that is suspended awaiting a human is a created
     * resource — and the caller's next move (render the card, poll for the answer) needs its id.
     */
    request: async (req, res, next) => {
      try {
        const { tenantId, userId } = requireAuth(req);
        const approval = await deps.approvals.requestExec(
          tenantId,
          userId,
          req.body as RequestExecApprovalInput,
        );
        res.status(201).json({ approval });
      } catch (err) {
        next(err);
      }
    },

    /**
     * Answer it: allow once, allow always, or deny.
     *
     * The owner is the authenticated user, read from the session and never from the body —
     * identical to the tool-approval rule, and for a stronger reason here: this decision can
     * create a permission that outlives the request.
     */
    decide: async (req, res, next) => {
      try {
        const { tenantId, userId } = requireAuth(req);
        const result = await deps.approvals.decideExec(
          tenantId,
          pathParam(req, 'id'),
          userId,
          req.body as DecideExecApprovalInput,
        );
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    },

    /**
     * "Is this already permitted?" — asked *before* raising an approval.
     *
     * The cheap path, and the reason `allow_always` is worth having: the gateway consults this
     * instead of asking a human again. It is a read, so any authenticated member may call it;
     * what it returns is only ever a rule the owner already granted.
     */
    check: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json(await deps.approvals.checkExec(tenantId, req.body as CheckExecInput));
      } catch (err) {
        next(err);
      }
    },

    listRules: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const query = parseQuery(listExecRulesSchema, req);
        res.status(200).json({
          rules: await deps.approvals.listExecRules(tenantId, {
            ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
            ...(query.includeInactive === undefined
              ? {}
              : { includeInactive: query.includeInactive }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
          }),
        });
      } catch (err) {
        next(err);
      }
    },

    revokeRule: async (req, res, next) => {
      try {
        const { tenantId, userId } = requireAuth(req);
        res
          .status(200)
          .json({ rule: await deps.approvals.revokeExecRule(tenantId, pathParam(req, 'id'), userId) });
      } catch (err) {
        next(err);
      }
    },
  };
}