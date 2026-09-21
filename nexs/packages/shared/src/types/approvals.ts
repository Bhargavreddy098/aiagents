/**
 * Approvals and notifications — the Decision Inbox contracts.
 *
 * Phase 7 is where a run stops being purely autonomous: a step that the approval policy
 * judges risky parks the run and waits for a human. These contracts describe what the
 * human is shown and what they may do, and they are here rather than in the server for
 * the same reason the rest of the control plane is: the boundary must reject a decision
 * the state machine forbids rather than let it reach the database.
 *
 * Two properties are structural rather than conventional:
 *
 *  1. **`APPROVAL_STATUSES` is a state machine, and a decision is terminal.** An approval
 *     moves `pending → approved | rejected | expired` and never leaves. There is no
 *     "un-reject", because a rejection is a decision the operator made and the run has
 *     already been told about it — reversing it would mean re-deciding a step the engine
 *     has since failed. Re-running is a new run, not an edit to this one.
 *  2. **Risk is a closed three-level vocabulary.** `RiskLevel` is the same union the
 *     engine's `assessRisk` produces, declared once so a payload validated at the SSE
 *     boundary and a row written by the engine cannot disagree about what `high` means.
 */

// ── approval state machine ────────────────────────────────────────────────────

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;

export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * The legal approval transitions.
 *
 * Every terminal state has an empty list: a decided approval is a record of what was
 * decided, and a record that can be edited is not a record. `expired` is reachable only
 * from `pending`, which is what makes "a decision beats the expiry clock" true by
 * construction — an approval that was answered cannot later be marked expired, even if
 * the expiry job was already queued when the decision landed.
 */
export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: [],
  rejected: [],
  expired: [],
};

export function isTerminalApprovalStatus(status: ApprovalStatus): boolean {
  return APPROVAL_TRANSITIONS[status].length === 0;
}

export function canTransitionApproval(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return APPROVAL_TRANSITIONS[from].includes(to);
}

/** The two answers an operator may give. `expired` is the clock's answer, not theirs. */
export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const;

export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

// ── risk ──────────────────────────────────────────────────────────────────────

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * What the engine computed about a pending action.
 *
 * `reasons` is a list rather than a sentence because the inbox renders one bullet per
 * reason, and the engine produces them independently — a tool that both writes files and
 * reaches the network has two things worth saying, and joining them into a sentence at
 * the point of assessment would make the UI unable to style them separately.
 */
export interface RiskInformation {
  level: RiskLevel;
  reasons: string[];
}

// ── wire shapes ───────────────────────────────────────────────────────────────

/**
 * A row in the Decision Inbox.
 *
 * `isExpired` is derived rather than stored: an approval whose `expiresAt` has passed but
 * whose expiry job has not yet run is, from the operator's point of view, already gone —
 * offering them an Approve button that will be rejected on click is worse than showing it
 * greyed out. The stored status stays authoritative for the engine; this flag only tells
 * the UI whether the decision is still actionable.
 */
export interface ApprovalSummary {
  id: string;
  status: ApprovalStatus;
  title: string;
  description: string | null;
  /** `pending` and past its `expiresAt`, as of the moment the response was built. */
  isExpired: boolean;
  risk: RiskInformation;
  requiredPermissions: string[];
  agentId: string | null;
  goalId: string | null;
  taskId: string | null;
  runId: string | null;
  stepId: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/**
 * One approval, fully expanded.
 *
 * `requestedAction` is the raw `Action.payload` — what exactly would happen, to what, and
 * why now. It is `unknown` rather than a typed shape on purpose: the payload's schema
 * belongs to whichever tool produced it, and typing it here would either narrow every
 * tool to a lowest common denominator or force this contract to import the tool registry.
 */
export interface ApprovalDetail extends ApprovalSummary {
  requestedAction: unknown;
  /** The `Action` row this approval gates, and its own status. */
  action: { id: string; kind: string; status: string; title: string };
  /** The run the approval belongs to, for the "open the run" affordance. */
  run: { id: string; kind: string; status: string } | null;
}

export interface ListApprovalsQuery {
  status?: ApprovalStatus;
  runId?: string;
  agentId?: string;
  /** Only approvals whose decision is still actionable. */
  actionableOnly?: boolean;
  limit?: number;
}

// ── notifications ─────────────────────────────────────────────────────────────

/**
 * What a notification is *about*.
 *
 * A closed list, because the unread badge and the UI's icon both key off it, and a free
 * string would mean a new notification silently rendering as the default case. The spec
 * names these eight; the notify tool's own `agent_message` is the ninth, added because an
 * agent escalating to a human is a genuine notification and the alternative was to file
 * it under a kind that means something else.
 */
export const NOTIFICATION_KINDS = [
  'approval_request',
  'task_completed',
  'task_failed',
  'goal_completed',
  'agent_failed',
  'connector_failed',
  'provider_failed',
  'schedule_result',
  'agent_message',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationSummary {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  linkRoute: string | null;
  readAt: string | null;
  isRead: boolean;
  createdAt: string;
}

/**
 * The list response, with the count carried alongside.
 *
 * The unread count is returned here rather than exposed as a separate endpoint because the
 * badge and the list are always rendered from the same fetch — two endpoints would let the
 * badge show three while the list shows two, which is precisely the kind of disagreement
 * an operator notices and cannot explain.
 */
export interface NotificationListResult {
  notifications: NotificationSummary[];
  unreadCount: number;
}
