/**
 * Wire shapes for runs and everything hanging off one.
 *
 * The rule the run detail view exists to serve is the project's first honesty rule: **every
 * number on screen traces to a database row.** So this shape has no computed fields, no
 * percentages and no "progress" — every value here is a column, or an array of rows. A
 * progress bar is a rendering decision the client makes from `steps`, not a number the
 * server invents.
 *
 * Every field below is named after the column it comes from. Where a view needs a value the
 * row does not carry — a tool call's human name, which lives on the related `Tool` — the
 * field is present only because the query joins it, and the mapper is where that join is
 * made explicit.
 */

export interface RunSummary {
  id: string;
  kind: string;
  status: string;
  agentId: string | null;
  /** The exact configuration version this run pinned — gap #15. */
  agentVersionId: string | null;
  goalId: string | null;
  taskId: string | null;
  workflowId: string | null;
  correlationId: string;
  idempotencyKey: string | null;
  lastHeartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
  error: RunErrorView | null;
}

/**
 * The structured error, or the raw string when the column did not hold one.
 *
 * `parseRunError` returns `null` for a column that is not JSON, and the raw text is
 * preserved rather than dropped: an error that cannot be parsed is still the only
 * explanation of a failed run, and replacing it with "unknown error" would throw away the
 * one piece of evidence there is.
 */
export interface RunErrorView {
  code: string;
  message: string;
  stepId?: string;
  issues?: unknown;
  details?: unknown;
  /** Present when the column held something that is not a structured error. */
  raw?: string;
}

export interface RunStepView {
  id: string;
  seq: number;
  position: number;
  attempt: number;
  retryCount: number;
  name: string;
  description: string | null;
  stepType: string;
  status: string;
  toolId: string | null;
  modelId: string | null;
  output: unknown;
  error: unknown;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunToolCallView {
  id: string;
  stepId: string | null;
  toolId: string;
  /**
   * The tool's name, joined from the `Tool` row.
   *
   * A tool call is unreadable without it — `tol_9f3a` tells an operator nothing — and
   * `null` here means the tool row has been deleted, which is itself worth showing rather
   * than hiding behind an empty string.
   */
  toolName: string | null;
  status: string;
  args: unknown;
  result: unknown;
  error: string | null;
  sideEffect: boolean;
  durationMs: number | null;
  createdAt: string;
}

export interface RunReceiptView {
  id: string;
  toolCallId: string;
  idempotencyKey: string;
  /** The effect as it was observed — what a crash-resume adopts rather than repeating. */
  effect: unknown;
  evidence: unknown;
  createdAt: string;
}

export interface RunVerificationView {
  id: string;
  stepId: string | null;
  goalId: string | null;
  type: string;
  scope: string;
  status: string;
  passed: boolean | null;
  config: unknown;
  evidence: unknown;
  createdAt: string;
  completedAt: string | null;
}

export interface RunModelUsageView {
  id: string;
  modelId: string;
  providerId: string;
  stepId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number | null;
  /** The provider's own estimate, snapshotted at call time from the model's metadata. */
  costEstimate: number;
  cached: boolean;
  createdAt: string;
}

/**
 * A run and everything it produced.
 *
 * The plan is included because it is the structured, visible plan the spec requires — never
 * the model's raw reasoning. `checkpoint` is deliberately **not** included: it is the
 * engine's own replay state, it exists to be rewritten on every step boundary, and exposing
 * it would invite a client to depend on a shape that is an implementation detail of crash
 * recovery.
 */
export interface RunDetail extends RunSummary {
  plan: unknown;
  input: unknown;
  output: unknown;
  steps: RunStepView[];
  toolCalls: RunToolCallView[];
  receipts: RunReceiptView[];
  verifications: RunVerificationView[];
  modelUsage: RunModelUsageView[];
}

export interface RunListResponse {
  runs: RunSummary[];
  /** The total matching the same filters, so a page knows what it is a page of. */
  total: number;
}
