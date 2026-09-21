import type { Logger } from '../../logger.js';

/**
 * The handoff between "a run row exists" and "something will execute it".
 *
 * A port rather than a direct pg-boss call, for the same reason the engine takes a
 * `PlannerGateway` rather than a provider client: the service layer's job is to decide
 * *that* a run should execute, and how that instruction reaches a worker is an
 * infrastructure detail that changes independently of it.
 *
 * ## What is verified, and what is not
 *
 * This machine has no Postgres, so `PgBossRunQueue` cannot be exercised end to end — it is
 * a thin wrapper whose correctness is the transport's. What **is** tested is everything up
 * to the boundary: that creating an immediate task produces exactly one run row and exactly
 * one enqueue of `run.execute` carrying that run's id, and that a duplicate delivery
 * produces none. That is the part that can be wrong in a way no one would notice; a
 * misconfigured connection string is loud.
 *
 * ## The queue name
 *
 * `run.execute` is the name the spec's queue registry fixes. It is written here as a
 * constant rather than at the call site because a typo in a queue name is not a type error
 * — the job is simply accepted into a queue nobody consumes, and the run sits `queued`
 * forever with nothing in the logs.
 */
export const RUN_EXECUTE_QUEUE = 'run.execute';

export interface RunQueueJob {
  runId: string;
  tenantId: string;
  kind: string;
}

export interface RunQueue {
  /**
   * Hand a run to the executor.
   *
   * Resolves once the handoff is durable, not once the run has finished. A rejection means
   * the run was **not** handed off, and the caller should surface that rather than
   * reporting success — a task that claims to have started and did not is worse than one
   * that failed to start.
   */
  enqueue(job: RunQueueJob): Promise<void>;
}

/**
 * The shape of the pg-boss client this adapter needs.
 *
 * Structural, and deliberately tiny: it names the one method used, so the adapter cannot
 * quietly start depending on more of pg-boss than it declares.
 */
export interface BossLike {
  send(
    name: string,
    data: object,
    options?: { singletonKey?: string; retryLimit?: number; expireInSeconds?: number },
  ): Promise<string | null>;
}

export class PgBossRunQueue implements RunQueue {
  constructor(
    private readonly boss: BossLike,
    private readonly logger: Logger,
  ) {}

  async enqueue(job: RunQueueJob): Promise<void> {
    const id = await this.boss.send(
      RUN_EXECUTE_QUEUE,
      job,
      {
        /**
         * One queued job per run.
         *
         * The engine's claim is already a compare-and-swap, so a duplicate job would be a
         * cheap no-op rather than a double execution — but it would still be a wasted
         * delivery, and under a retry storm it would be many. Keying on the run id makes
         * the queue itself refuse the duplicate.
         */
        singletonKey: job.runId,
        /**
         * Three attempts, then the run is left for the reaper.
         *
         * Bounded on purpose: a run that fails to *start* three times is a bug or a
         * misconfiguration, and retrying forever would turn a visible failure into an
         * invisible one. The stuck-run reaper (Phase 12) is what picks up the remainder.
         */
        retryLimit: 3,
        expireInSeconds: 900,
      },
    );

    // `send` returns null when the job was deduplicated by its singleton key. That is a
    // success — the run is queued exactly once, which is what was asked for.
    this.logger.debug(
      { runId: job.runId, jobId: id, deduplicated: id === null },
      'run handed to the executor',
    );
  }
}

/**
 * A queue that records what it was asked to do and runs nothing.
 *
 * For tests, and only for tests: it makes "was exactly one run enqueued?" an assertion
 * rather than a hope. It is deliberately not offered as a production fallback — a server
 * wired to this would accept task creation and never execute anything, which is the kind
 * of silent success this codebase is built to avoid.
 */
export class RecordingRunQueue implements RunQueue {
  readonly jobs: RunQueueJob[] = [];

  async enqueue(job: RunQueueJob): Promise<void> {
    this.jobs.push(job);
  }
}

/**
 * A queue that executes the run in this process, without waiting for it.
 *
 * This is what makes the Phase 6 API exercisable end to end before the pg-boss worker
 * exists (it arrives with the ops work in a later phase). It is not a stub: the run really
 * does execute, through the same engine and the same repositories, so a task created
 * through the API produces real steps, real tool calls and real receipts.
 *
 * Three properties it does **not** have, all of which matter in production and none of
 * which matter for exercising the API:
 *
 *  - **No durability.** A run handed to this and then lost to a process restart is lost.
 *    The queue's job is to survive that; this one cannot.
 *  - **No retry.** A `run.execute` that throws is logged and dropped, where pg-boss would
 *    retry it three times.
 *  - **No back-pressure.** Every enqueue starts immediately, so a burst of task creations
 *    becomes a burst of concurrent runs. The engine's own per-tenant concurrency check is
 *    what keeps that bounded, which is why it is safe here at all.
 *
 * The handoff resolves immediately, matching the queue's contract — the caller learns that
 * the run was *started*, never that it finished.
 */
export class InlineRunQueue implements RunQueue {
  constructor(
    private readonly deps: {
      execute: (job: RunQueueJob) => Promise<unknown>;
      logger: Logger;
    },
  ) {}

  async enqueue(job: RunQueueJob): Promise<void> {
    this.deps.logger.debug({ runId: job.runId }, 'run executing in-process');

    // Deliberately not awaited, and the rejection is handled rather than left floating: an
    // unhandled rejection would take the process down, and a run failing to start is a
    // logged incident rather than a crash.
    void this.deps.execute(job).catch((err: unknown) => {
      this.deps.logger.error(
        { runId: job.runId, err: err instanceof Error ? err.message : String(err) },
        'in-process run execution failed',
      );
    });
  }
}
