import type { RequestHandler } from 'express';
import { listApprovalsSchema, type DecideApprovalInput } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { ApprovalService } from '../services/approvals/approval.service.js';

/** `/api/approvals` — the Decision Inbox. Thin: authenticate, delegate, serialise. */
export interface ApprovalControllerDeps {
  approvals: ApprovalService;
}

export interface ApprovalController {
  list: RequestHandler;
  get: RequestHandler;
  decide: RequestHandler;
}

export function createApprovalController(deps: ApprovalControllerDeps): ApprovalController {
  return {
    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const query = parseQuery(listApprovalsSchema, req);

        const approvals = await deps.approvals.list(tenantId, {
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.runId === undefined ? {} : { runId: query.runId }),
          ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
          ...(query.actionableOnly === undefined ? {} : { actionableOnly: query.actionableOnly }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        });

        res.status(200).json({
          approvals,
          // The badge. Computed after the list, from the same clock the rows were mapped
          // against, so the count and the rows cannot disagree about whether something
          // lapsed a moment ago.
          pendingCount: await deps.approvals.countPending(tenantId),
        });
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        res.status(200).json({ approval: await deps.approvals.get(tenantId, pathParam(req, 'id')) });
      } catch (err) {
        next(err);
      }
    },

    /**
     * Approve or reject.
     *
     * The decider is the authenticated user, never the request body — see
     * `decideApprovalSchema`. `runOutcome` is returned alongside the approval because the
     * caller's next question is always "did the run move?", and making them refetch the run
     * to find out would be a second round trip for something the server already knows.
     */
    decide: async (req, res, next) => {
      try {
        const { tenantId, userId } = requireAuth(req);
        const result = await deps.approvals.decide(
          tenantId,
          pathParam(req, 'id'),
          userId,
          req.body as DecideApprovalInput,
        );
        res.status(200).json({ approval: result.approval, runOutcome: result.runOutcome });
      } catch (err) {
        next(err);
      }
    },
  };
}
