import { Router, type RequestHandler } from 'express';
import {
  checkExecSchema,
  decideApprovalSchema,
  decideExecApprovalSchema,
  requestExecApprovalSchema,
} from '@nexs/shared';
import type { ApprovalController } from '../controllers/approval.controller.js';
import type { ExecApprovalController } from '../controllers/exec-approval.controller.js';
import { validateBody } from '../http/middleware/validate.js';

export interface ApprovalsRouterDeps {
  controller: ApprovalController;
  /**
   * The exec half (§4.4). A separate controller because it answers a different question about a
   * different resource — see `exec-approval.controller.ts`.
   */
  exec: ExecApprovalController;
  authRequired: RequestHandler;
}

export function createApprovalsRouter(deps: ApprovalsRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  router.use(deps.authRequired);

  // ── exec approvals (UI/UX v2 §4.4) ─────────────────────────────────────────
  //
  // Registered **before** the `:id` routes deliberately. `POST /exec` and `GET /:id` are not the
  // same method, so nothing collides today — but `/exec/rules/:id/revoke` sharing a prefix with
  // `/:id/decide-exec` is exactly the shape that becomes an accidental capture the moment someone
  // adds a route, and ordering is a cheaper guarantee than a comment asking people to be careful.
  router.post('/exec', validateBody(requestExecApprovalSchema), deps.exec.request);
  router.post('/exec/check', validateBody(checkExecSchema), deps.exec.check);
  router.get('/exec/rules', deps.exec.listRules);
  router.post('/exec/rules/:id/revoke', deps.exec.revokeRule);

  // The list query is parsed inside the controller with `parseQuery`, matching the agents,
  // runs and stream routers — Express 5 made `req.query` a getter, so the `validateBody`
  // replacement trick does not apply to it.
  router.get('/', controller.list);
  router.get('/:id', controller.get);

  /**
   * A decision is a `POST` to a sub-resource rather than a `PATCH` on the approval.
   *
   * Two reasons, and the second is the real one. A `PATCH /:id` would be a general edit to
   * a row, and an approval has exactly one editable property — its answer. Naming the
   * operation makes it impossible to send `{ status: 'approved', decidedBy: 'someone-else' }`
   * and have a well-meaning handler apply both. And it keeps the compare-and-swap on
   * `status: 'pending'` meaningful: the endpoint decides, it does not assign.
   */
  router.post('/:id/decide', validateBody(decideApprovalSchema), controller.decide);

  /**
   * The exec answer is a **different sub-resource** from the decision above, not a second body
   * shape on the same one. `allow_once` / `allow_always` / `deny` are not variants of
   * approve/reject: `allow_always` creates a standing permission that outlives the request. A
   * shared endpoint would have to accept both schemas and decide which one it received, and the
   * failure mode of getting that wrong is a permanent grant.
   */
  router.post('/:id/decide-exec', validateBody(decideExecApprovalSchema), deps.exec.decide);

  return router;
}
