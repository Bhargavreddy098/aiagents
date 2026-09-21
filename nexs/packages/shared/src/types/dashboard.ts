/**
 * The dashboard — one composed snapshot of a tenant's live state.
 *
 * ## The rule this file exists to make checkable
 *
 * The spec's wording is **"zero hard-coded numbers"**. That is not a style preference; it is
 * the difference between a dashboard and a mockup. Every field below is therefore a value
 * some query produced, and the service that fills it in is not permitted to substitute a
 * plausible constant for a missing read. Where the system genuinely has nothing to report,
 * the shape says so with an empty array or a `null` — never with a zero that looks like data.
 *
 * ## Why the limits are constants here and not magic numbers in the service
 *
 * `DASHBOARD_RECENT_RUNS = 10` is a **page size**, not an aggregate. The rule above is about
 * computed values being computed; it is not a ban on the shape of a query. Putting them in
 * the shared package means the number the API used to size a list and the number the UI uses
 * to label it ("last 7 days") cannot drift apart — and the failure window's size is
 * something the UI states in words, so it has to be readable from both sides.
 *
 * ## Why there is no query schema for this endpoint
 *
 * `GET /api/dashboard` takes no input. The limits are fixed by the spec rather than
 * caller-chosen, so a client cannot ask for a different window and then render a label that
 * disagrees with the data it received.
 */

/** How many recent runs the dashboard shows. The spec's own number. */
export const DASHBOARD_RECENT_RUNS = 10;
/** How many of the latest steps across those runs count as "recent activity". */
export const DASHBOARD_RECENT_ACTIVITY = 10;
/** How many schedules to show, soonest first. The spec's own number. */
export const DASHBOARD_UPCOMING_SCHEDULES = 5;
/** The failure window, in days. The spec's own number, and the one the UI names. */
export const DASHBOARD_FAILURE_WINDOW_DAYS = 7;
/** How many execution receipts to show. */
export const DASHBOARD_RECENT_RECEIPTS = 5;

/**
 * The counted tiles.
 *
 * Each is a `count` over a status column, so each has a single unambiguous meaning. They are
 * deliberately flat rather than nested: the dashboard renders them as independent tiles, and
 * a nested shape would imply a grouping the UI does not make.
 */
export interface DashboardCounts {
  /** Agents in the `active` state — the ones that can be run. */
  agentsActive: number;
  /** Every agent in the workspace, whatever its state. */
  agentsTotal: number;
  /** Goals in the `active` state. */
  goalsActive: number;
  /** Tasks whose own status is `running`. */
  tasksRunning: number;
  /**
   * Workflows in a runnable state (`active`).
   *
   * Not "workflows running" — a workflow is a stored program and does not itself run; its
   * runs do, and those are counted by `runsActive`. Naming this `workflowsActive` rather
   * than `workflowsRunning` is the honest label for what is actually being counted.
   */
  workflowsActive: number;
  /**
   * Runs holding a worker slot: `planning`, `running`, or `waiting_approval`.
   *
   * Deliberately the same set `isActiveRunStatus` defines, because this is that predicate
   * counted — the per-tenant concurrency accounting and this tile must agree, or the
   * dashboard would report headroom the scheduler does not believe exists. `paused` is
   * **not** included: a paused run has stopped on purpose and is not consuming a slot.
   */
  runsActive: number;
  /** Approvals still awaiting a decision and not yet past their deadline. */
  approvalsPending: number;
}

/** One run, as a row in the recent-runs list. */
export interface DashboardRunRef {
  id: string;
  kind: string;
  status: string;
  agentId: string | null;
  taskId: string | null;
  workflowId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /**
   * The failure message, for a run that failed.
   *
   * Carried on the row rather than fetched per run on click: the dashboard's whole purpose
   * is to answer "is anything wrong?" without a second request, and a red row with no reason
   * on it sends the operator looking anyway.
   */
  error: string | null;
}

/**
 * One step, as a line in the activity feed.
 *
 * Steps carry no `tenantId` — their ownership is the run they belong to, so the service
 * reads them for runs it has already resolved as this tenant's. See the service for why that
 * is the ownership proof rather than a relation filter.
 */
export interface DashboardActivity {
  runId: string;
  stepId: string;
  seq: number;
  type: string;
  name: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * One provider's last recorded health.
 *
 * The status is what `provider.health` last wrote — a *stored* reading, not a live probe.
 * That distinction matters on a dashboard: probing every provider on every page load would
 * make the page slow and the reading no more true, since the sweep already runs every ten
 * minutes.
 */
export interface DashboardProviderHealth {
  providerId: string;
  name: string;
  type: string;
  status: string;
  lastHealthCheck: string | null;
}

/**
 * A connected service.
 *
 * `kind` is a discriminated tag so more kinds can be added without a breaking change. Today
 * only `mcp` is produced, because MCP servers are the only external service this system
 * actually tracks — see the service for why connectors are absent rather than zero.
 */
export interface DashboardConnectedService {
  kind: 'mcp';
  id: string;
  name: string;
  status: string;
  /** How many tools the server contributed. A real count, not the count of enabled ones. */
  toolCount: number;
}

/** A schedule that is going to fire, soonest first. */
export interface DashboardUpcomingSchedule {
  id: string;
  name: string;
  kind: string;
  targetKind: string;
  targetId: string;
  cron: string | null;
  /**
   * Non-null by construction: the list is filtered to schedules that have a next fire and
   * ordered by it, so a row here always has a time. A schedule with no next fire is not
   * "upcoming" and is excluded rather than shown as a blank.
   */
  nextFireAt: string;
  lastFiredAt: string | null;
}

/**
 * Failures over a window.
 *
 * `days` and `since` travel with the count so the label the UI renders and the query that
 * produced the number come from the same place. A dashboard that says "7 days" over a count
 * computed for 24 hours is a lie that no test would catch unless the two are carried
 * together, which is why they are.
 */
export interface DashboardFailureWindow {
  days: number;
  since: string;
  count: number;
}

/**
 * Verifications, counted by outcome.
 *
 * `pending` is a real state rather than an implied remainder: a verification row is written
 * when the check is *scheduled* and completed when it has run, so "not yet decided" is a
 * thing that exists and an operator needs to see it.
 */
export interface DashboardVerificationSummary {
  total: number;
  pending: number;
  passed: number;
  failed: number;
}

/** One execution receipt — the record of what a tool call actually did. */
export interface DashboardReceipt {
  id: string;
  toolCallId: string;
  /**
   * Resolved through `ToolCall` → `Step`, or `null` when the chain is incomplete.
   *
   * Null is a real answer: a receipt whose tool call has been pruned is still a record of an
   * effect, and dropping the row would hide that an effect happened.
   */
  runId: string | null;
  toolName: string | null;
  /** What actually happened — the row written, the file saved. */
  effect: unknown;
  createdAt: string;
}

/** The whole snapshot. */
export interface DashboardSummary {
  /** When this snapshot was taken, so a client can say how stale it is. */
  generatedAt: string;
  counts: DashboardCounts;
  recentRuns: DashboardRunRef[];
  recentActivity: DashboardActivity[];
  providerHealth: DashboardProviderHealth[];
  connectedServices: DashboardConnectedService[];
  upcomingSchedules: DashboardUpcomingSchedule[];
  failures: DashboardFailureWindow;
  verifications: DashboardVerificationSummary;
  recentReceipts: DashboardReceipt[];
  /**
   * The connecting user's unread notification count.
   *
   * Per *user*, not per tenant: notifications are addressed to a person, and a workspace-wide
   * count would tell one member how much unread mail another member has.
   */
  unreadNotifications: number;
}
