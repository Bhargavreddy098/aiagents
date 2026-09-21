import type { Action, Approval, Notification } from '@prisma/client';
import type {
  ApprovalDetail,
  ApprovalStatus,
  ApprovalSummary,
  NotificationKind,
  NotificationSummary,
} from '@nexs/shared';
import { readRisk } from '../repositories/approval.repo.js';

/**
 * The single place an approval or notification row becomes a wire shape.
 *
 * Same rule as the other mappers, and it earns its keep here for a third reason beyond
 * leak prevention and narrower shapes: `isExpired` and `isRead` are **derived** fields,
 * and deriving them in one place is what keeps two endpoints from disagreeing. The inbox
 * list and the approval detail both ask "can this still be acted on?", and if each computed
 * it from `new Date()` at its own call site they could — across a second boundary — answer
 * differently for the same row.
 *
 * Both are computed against an injected `now` rather than `Date.now()`, so the mapping is a
 * pure function of its inputs and a test asserting "this row is expired" does not have to
 * race the clock.
 */

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

/**
 * Whether a pending approval's clock has run out.
 *
 * A row with no `expiresAt` never expires. That is the honest reading of a null in this
 * column: `Approval.expiresAt` is nullable because a policy may not set an expiry, and
 * treating null as "expired" would hide every such approval from the inbox.
 */
function isExpired(approval: Approval, now: Date): boolean {
  if (approval.status !== 'pending') return false;
  if (approval.expiresAt === null) return false;
  return approval.expiresAt.getTime() <= now.getTime();
}

export function toApprovalSummary(approval: Approval, now: Date = new Date()): ApprovalSummary {
  return {
    id: approval.id,
    status: approval.status as ApprovalStatus,
    title: approval.title,
    description: approval.description,
    isExpired: isExpired(approval, now),
    risk: readRisk(approval.riskInformation),
    requiredPermissions: [...approval.requiredPermissions],
    agentId: approval.agentId,
    goalId: approval.goalId,
    taskId: approval.taskId,
    runId: approval.runId,
    stepId: approval.stepId,
    decidedBy: approval.decidedBy,
    decidedAt: iso(approval.decidedAt),
    expiresAt: iso(approval.expiresAt),
    createdAt: iso(approval.createdAt) ?? approval.createdAt.toISOString(),
  };
}

export function toApprovalDetail(
  approval: Approval,
  action: Action,
  run: { id: string; kind: string; status: string } | null,
  now: Date = new Date(),
): ApprovalDetail {
  return {
    ...toApprovalSummary(approval, now),
    requestedAction: approval.requestedAction,
    action: { id: action.id, kind: action.kind, status: action.status, title: action.title },
    run,
  };
}

export function toNotificationSummary(notification: Notification): NotificationSummary {
  return {
    id: notification.id,
    kind: notification.kind as NotificationKind,
    title: notification.title,
    body: notification.body,
    linkRoute: notification.linkRoute,
    readAt: iso(notification.readAt),
    // Both columns are consulted: `readAt` is the truth, and `isRead` is what the UI reads.
    // Deriving the flag here rather than shipping the timestamp alone keeps the client from
    // having to know that "read" is spelled as a non-null timestamp.
    isRead: notification.readAt !== null,
    createdAt: notification.createdAt.toISOString(),
  };
}
