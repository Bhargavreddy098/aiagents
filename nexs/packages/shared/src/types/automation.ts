import type { TaskTriggerType } from './control.js';

/**
 * Schedules and events — the two ways work starts without a human clicking something.
 *
 * ## Why they share a file
 *
 * They are one feature with two triggers. A schedule answers "when should this run?" and an
 * event answers "what should make this run?", and both end in the same place: a `Task` or a
 * `Run` that the engine executes. Splitting them would mean two modules each describing half
 * of the same handoff.
 *
 * ## The one rule that shapes every type here
 *
 * A schedule never *is* the work. It points at a target (`task` or `workflow`) and firing it
 * starts that target. So nothing in this file carries a payload of its own — the target's
 * own configuration is the payload, and a schedule that could override it would be a second
 * place the same run is described.
 */

// ── schedules ─────────────────────────────────────────────────────────────────

export const SCHEDULE_KINDS = ['one_time', 'recurring', 'event'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/**
 * What firing a schedule starts.
 *
 * `task` and `workflow` only — not `agent`. The spec's Phase 11 table says "handler creates
 * Task/Run", and both of those are rows that already know how to produce a run
 * (`TaskService.create` and `WorkflowService.run`). An agent is not a runnable thing on its
 * own: it needs a task to carry the input, so `agent` is expressed by creating a task
 * pointed at the agent.
 */
export const SCHEDULE_TARGET_KINDS = ['task', 'workflow'] as const;
export type ScheduleTargetKind = (typeof SCHEDULE_TARGET_KINDS)[number];

export interface ScheduleSummary {
  id: string;
  name: string;
  kind: ScheduleKind;
  /** Set for `recurring`; null otherwise. */
  cron: string | null;
  timezone: string;
  /** Set for `one_time`; null otherwise. */
  runAt: string | null;
  targetKind: ScheduleTargetKind;
  targetId: string;
  enabled: boolean;
  lastFiredAt: string | null;
  /**
   * When this will next fire, stored rather than derived on read.
   *
   * The column exists so the list endpoint is one query. It is recomputed on every fire and
   * on every edit, so it is never a stale guess — but it *is* a stored value, which is why
   * `null` here means "nothing computed yet" and never "never".
   */
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleDetail extends ScheduleSummary {
  /** Set for an `event` schedule: the subscription that triggers it. */
  eventSubscriptionId: string | null;
  /** v2 §10 delivery target, or null for "deliver nowhere". */
  deliveryTarget: unknown;
}

export interface ScheduleListResult {
  schedules: ScheduleSummary[];
}

/**
 * What a fire did, returned to whoever triggered it.
 *
 * `skipped` is a first-class outcome rather than an error: a disabled schedule, or one whose
 * target has since been deleted, is a normal thing to encounter when a queue delivers a job
 * created before the change. Reporting it as a failure would make the queue retry a job that
 * can never succeed.
 */
export interface ScheduleFireResult {
  scheduleId: string;
  outcome: 'fired' | 'skipped';
  reason?: string;
  runId?: string;
  taskId?: string;
  /** The next fire, recomputed as part of firing. Null for a one-time schedule. */
  nextFireAt: string | null;
}

// ── events ────────────────────────────────────────────────────────────────────

/**
 * What an event may start.
 *
 * Wider than a schedule's targets, because an event is a *signal* rather than a timetable:
 * a webhook arriving may be the input to a task, the trigger of a workflow, or an
 * instruction to an agent. The spec's prose lists exactly these three.
 *
 * **`goal` is deliberately absent** even though the schema's own comment on
 * `EventSubscription.targetKind` mentions it. A goal is not runnable: `RunContext` requires
 * a model, and a goal carries none — so "trigger a goal" would have to mean "create a task
 * under this goal and run that", which is a task trigger with extra steps. Making it a
 * separate target kind would advertise a capability that resolves to the same machinery and
 * fails the same way when no model is available. Trigger the task that serves the goal.
 */
export const EVENT_TARGET_KINDS = ['task', 'workflow', 'agent'] as const;
export type EventTargetKind = (typeof EVENT_TARGET_KINDS)[number];

export interface EventSummary {
  id: string;
  type: string;
  source: string;
  subject: string | null;
  /**
   * The producer's own id for this occurrence, used for webhook replay protection.
   *
   * Null means "not deduplicated" — the unique index is on `(tenantId, source, externalId)`
   * and a NULL never collides, so an event sent without one is always stored. That is the
   * right default: refusing an event because its producer did not supply an id would drop
   * real signals.
   */
  externalId: string | null;
  payload: unknown;
  metadata: unknown;
  /**
   * When the event *happened*, per its producer — and the only timestamp on the row.
   *
   * There is deliberately no `createdAt` here: the `Event` model has no such column. The
   * distinction it would draw — when the producer says it happened versus when we stored it
   * — is not recorded anywhere, so offering a field for it would be a field that is always
   * the same value as `occurredAt` and invites a client to rely on a difference that does
   * not exist.
   */
  occurredAt: string;
  /** Null until the matcher has finished with it. */
  processedAt: string | null;
}

export interface EventListResult {
  events: EventSummary[];
}

/**
 * A standing instruction: "when an event like this arrives, start that".
 *
 * `hasSecret` rather than the secret itself. The value is an HMAC key for inbound webhook
 * verification and is never readable once written — a response that could return it would
 * turn any read of the subscription list into a way to forge a webhook.
 */
export interface EventSubscriptionSummary {
  id: string;
  topic: string;
  /** Partial match against the event's `source` and `subject`. */
  filter: { source?: string; subject?: string };
  targetKind: EventTargetKind;
  targetId: string;
  enabled: boolean;
  hasSecret: boolean;
  createdAt: string;
}

export interface EventSubscriptionListResult {
  subscriptions: EventSubscriptionSummary[];
}

/**
 * The result of ingesting one event.
 *
 * `deduplicated` is the important field. A webhook that is retried — which every webhook
 * producer does — must not trigger the subscribed workflow twice, so the ingest reports
 * whether this occurrence was new or a repeat rather than silently returning the same shape
 * for both.
 */
export interface EventIngestResult {
  event: EventSummary;
  deduplicated: boolean;
  /** Subscriptions whose topic and filter matched. */
  matchedSubscriptions: number;
  /** How many of those actually started something. */
  triggered: number;
  /** Per-target outcomes, so a partial failure is visible rather than counted as success. */
  failures: Array<{ subscriptionId: string; reason: string }>;
}

// ── the trigger decision ──────────────────────────────────────────────────────

/**
 * Which companion row a trigger type must name, as data rather than as branches.
 *
 * `requiresSchedule` and `requiresEventSubscription` in `control.ts` already answer the
 * boolean, and they stay the source of truth for it. This adds the *name* of the field, so
 * the validation error and the schema `refine` cannot disagree about which field is missing.
 */
export function companionFieldFor(
  trigger: TaskTriggerType,
): 'scheduleId' | 'eventSubscriptionId' | null {
  if (trigger === 'recurring') return 'scheduleId';
  if (trigger === 'event') return 'eventSubscriptionId';
  return null;
}
