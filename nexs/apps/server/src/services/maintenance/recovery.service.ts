import type { RunStatus } from '@nexs/shared';
import type { RunRepository } from '../../repositories/run.repo.js';
import type { RunQueue } from '../queue/run-queue.js';
import type { Logger } from '../../logger.js';

/**
 * `recovery.scan` — find runs whose worker died and hand them back to the queue.
 *
 * ## What was missing
 *
 * The engine's crash-recovery *contract* has been built since Phase 5: `adoptPriorExecution`
 * adopts a recorded receipt's effect instead of re-running a step, fails a step whose
 * side-effecting call was recorded but never confirmed, and re-runs a read-only one. That is
 * what makes a redelivered job safe. What was never built is the thing that *finds* an
 * orphaned run and redelivers it — so a process that died mid-run left the row `running`
 * forever, and `RunRepository.listStale` existed with no caller at all.
 *
 * ## Why the status set is narrower than `listStale`'s default
 *
 * `listStale` defaults to every active status, which includes `waiting_approval`. That is
 * the wrong set here. A run parked for approval is **waiting for a human**, not orphaned —
 * its heartbeat is legitimately stale because nothing is working on it. Re-enqueueing it
 * would be a redelivery the engine immediately discards (it returns `paused` for a parked
 * run), so the effect would be harmless — but the *count* would be wrong, and this scan's
 * count is the only signal an operator has that crash recovery is doing anything. Counting
 * every parked run as recovered would make the number meaningless.
 *
 * ## Why re-enqueueing is safe — and where it is not
 *
 * The engine claims a run with a compare-and-swap on its status, and `planning` and
 * `running` are both claimable from. That is what makes this scan possible at all: an
 * orphan's row says `running`, so a claim from `running` has to succeed.
 *
 * It follows that the claim does **not** protect against a live worker. The CAS compares
 * status, so a delivery for a run that is genuinely being executed elsewhere is claimed by
 * the second worker too, and both execute the plan. The safety here rests on the heartbeat
 * being a reliable liveness signal: this scan only hands back a run whose heartbeat is older
 * than `staleAfterMs`, so a false positive requires a worker that is alive but has not
 * written a heartbeat within the window. `ExecutionEngine` writes one at every step
 * boundary, which bounds the window by the longest single step rather than by the run — but
 * a step that outlives `staleAfterMs` is exactly the false positive.
 *
 * So the honest claim is: **this makes an orphan recoverable, and it narrows — it does not
 * eliminate — the window in which a slow-but-alive worker is duplicated.** Closing it means
 * making the reclaim conditional on the heartbeat this scan justified it with, which
 * `RunRepository.claim` does not currently accept.
 */

export interface RecoveryServiceDeps {
  runs: RunRepository;
  queue: RunQueue;
  logger: Logger;
  /** A run whose heartbeat is older than this is presumed orphaned. */
  staleAfterMs: number;
  now?: () => number;
}

export interface RecoveryScanResult {
  /** Runs found with a stale heartbeat. */
  scanned: number;
  /** Runs handed back to the queue. */
  reEnqueued: number;
  /** Runs that could not be handed off; they will be retried by the next scan. */
  failed: number;
}

/**
 * The statuses a dead worker can leave behind.
 *
 * `queued` is absent because a queued run has no worker to lose — it is waiting for one.
 * `paused` and `waiting_approval` are absent because they are parked on purpose. `failed`
 * and the other terminal states are absent because they are finished.
 */
const ORPHANABLE_STATUSES: readonly RunStatus[] = ['planning', 'running'];

export class RecoveryService {
  constructor(private readonly deps: RecoveryServiceDeps) {}

  async scan(): Promise<RecoveryScanResult> {
    const now = this.deps.now?.() ?? Date.now();
    const cutoff = new Date(now - this.deps.staleAfterMs);

    const stale = await this.deps.runs.listStale(cutoff, ORPHANABLE_STATUSES);
    if (stale.length === 0) {
      this.deps.logger.debug({ cutoff: cutoff.toISOString() }, 'recovery scan found nothing to recover');
      return { scanned: 0, reEnqueued: 0, failed: 0 };
    }

    let reEnqueued = 0;
    let failed = 0;

    for (const run of stale) {
      try {
        await this.deps.queue.enqueue({ runId: run.id, tenantId: run.tenantId, kind: run.kind });
        reEnqueued += 1;
        this.deps.logger.info(
          {
            runId: run.id,
            tenantId: run.tenantId,
            status: run.status,
            lastHeartbeatAt: run.lastHeartbeatAt?.toISOString() ?? null,
          },
          'orphaned run handed back to the queue',
        );
      } catch (err) {
        // Not fatal to the scan: one run that cannot be re-enqueued must not stop the
        // others, and the next scan will find it again because its heartbeat is still stale.
        failed += 1;
        this.deps.logger.error(
          { runId: run.id, err: err instanceof Error ? err.message : String(err) },
          'could not re-enqueue an orphaned run; the next scan will retry it',
        );
      }
    }

    this.deps.logger.info(
      { scanned: stale.length, reEnqueued, failed },
      'recovery scan complete',
    );

    return { scanned: stale.length, reEnqueued, failed };
  }
}
