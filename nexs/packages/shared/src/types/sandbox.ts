/**
 * The sandbox surface, as the UI sees it.
 *
 * ## The naming mismatch this file has to live with, stated once
 *
 * `SandboxExecution` was written for a **shell** sandbox: it has `command`, `args`, `stdout`,
 * `stderr` and `exitCode`. What this build actually runs is JavaScript inside a `worker_threads`
 * worker (gap #24 — `child_process` has no `resourceLimits`, so the resource boundary had to be a
 * worker). There is no command line.
 *
 * Rather than rename the columns — which needs a migration this build cannot run — the mapping is
 * explicit and documented here and in `SandboxService`:
 *
 *   - `command` holds the **JavaScript source** that ran.
 *   - `args` is always empty; the source receives its input through `input`, not argv.
 *   - `stdout` / `stderr` / `exitCode` mean what they say.
 *
 * A reader who finds a JS function body in a column called `command` should find this note next to
 * it rather than concluding the row is corrupt. The `session.provider` value (`worker-thread`) is
 * the machine-readable half of the same statement, and it is what a future Docker provider would
 * change.
 */

export const SANDBOX_SESSION_STATUSES = ['idle', 'running', 'terminated', 'error'] as const;
export type SandboxSessionStatus = (typeof SANDBOX_SESSION_STATUSES)[number];

export const SANDBOX_EXECUTION_STATUSES = ['running', 'completed', 'failed', 'timeout'] as const;
export type SandboxExecutionStatusName = (typeof SANDBOX_EXECUTION_STATUSES)[number];

export interface SandboxSessionSummary {
  id: string;
  runId: string | null;
  /** `worker-thread` today. The value that says which isolation mechanism produced this row. */
  provider: string;
  status: string;
  workdir: string;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxExecutionSummary {
  id: string;
  sessionId: string;
  /** The JavaScript source that ran. See the file header. */
  command: string;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
}

/**
 * The outcome of `POST /api/sandbox/:id/exec`.
 *
 * Both halves are returned: the persisted execution row and the run's own result. They differ in
 * one way that matters — `value` is the code's return value, which is not stored, because it is
 * structured-cloneable data that has no column and may not be JSON at all. A caller that needs it
 * gets it here or not at all.
 */
export interface SandboxExecOutcome {
  execution: SandboxExecutionSummary;
  value?: unknown;
  durationMs: number;
  terminatedReason?: string;
  outputTruncated: boolean;
}
