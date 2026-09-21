import { z } from 'zod';
import { APPROVAL_DECISIONS, APPROVAL_STATUSES, NOTIFICATION_KINDS } from '../types/approvals.js';

/**
 * Approval and notification input schemas.
 *
 * The same two conventions the control-plane schemas follow, for the same reasons:
 *
 *  1. **Every schema is `.strict()`.** A decision body naming a key that does not exist is
 *     a typo, and silently dropping it means the operator believes they recorded something
 *     they did not — on an endpoint whose entire purpose is to record a decision.
 *  2. **Nothing is `.default()`-ed.** A default applied here is a value the caller never
 *     sent being written to a row, and an approval decision must be exactly what was sent.
 *
 * There is one deliberate absence worth stating: **there is no schema for creating an
 * approval.** An approval is not a resource a client posts; it is raised by the engine when
 * a run parks, and the only way to cause one is to start a run whose policy demands it.
 * An endpoint that fabricated an approval row would let a caller manufacture the evidence
 * the acceptance criterion depends on.
 */

const id = z.string().trim().min(1);

// ── approvals ─────────────────────────────────────────────────────────────────

/**
 * An operator's answer to a pending approval.
 *
 * `decidedBy` is **not** in the body. The decider is the authenticated user, read from the
 * session — accepting it from the request would let one user record another's decision,
 * and `decidedBy` is exactly the field an audit reads to answer "who let this happen?".
 */
export const decideApprovalSchema = z
  .object({
    decision: z.enum(APPROVAL_DECISIONS),
    /** Free-text rationale. Stored on the approval and shown in the run's history. */
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

export const listApprovalsSchema = z
  .object({
    status: z.enum(APPROVAL_STATUSES).optional(),
    runId: id.optional(),
    agentId: id.optional(),
    /** Query-string friendly: `true`/`false` arrive as strings. */
    actionableOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

// ── notifications ─────────────────────────────────────────────────────────────

export const listNotificationsSchema = z
  .object({
    /** Defaults to unread-only at the service, which is what the bell shows. */
    unreadOnly: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => value === 'true'),
    kind: z.enum(NOTIFICATION_KINDS).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

// ── inferred input types ──────────────────────────────────────────────────────

export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;
export type ListApprovalsInput = z.infer<typeof listApprovalsSchema>;
export type ListNotificationsInput = z.infer<typeof listNotificationsSchema>;
