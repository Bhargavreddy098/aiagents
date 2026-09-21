import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';
import { RecoveryService } from '../src/services/maintenance/recovery.service.js';
import type { RunQueue, RunQueueJob } from '../src/services/queue/run-queue.js';

/**
 * `recovery.scan` — finding runs whose worker died and handing them back.
 *
 * ## Why this is the missing half of a feature that looked finished
 *
 * The engine's crash-recovery *contract* has been built since Phase 5: `adoptPriorExecution`
 * adopts a recorded receipt's effect instead of re-running a step, fails a step whose
 * side-effecting call was recorded but never confirmed, and re-runs a read-only one. That is
 * what makes a redelivered job safe. But nothing ever *found* an orphaned run, so a process
 * that died mid-run left the row `running` forever and `RunRepository.listStale` had no
 * caller at all.
 *
 * ## The claim that matters most here
 *
 * A run parked for approval is **not** an orphan. Its heartbeat is legitimately stale because
 * nothing is working on it — a human is. Counting it would make this scan's count, which is
 * the only signal an operator has that recovery is doing anything, meaningless. The test for
 * that exclusion is the one that would fail if someone "simplified" the status set back to
 * `listStale`'s default.
 */

const logger = pino({ level: 'silent' });

/** The harness builds its service with a 15-minute window; this clears it comfortably. */
const STALE_MS = 30 * 60 * 1000;

let harness: ControlHarness;

beforeEach(async () => {
  harness = await createControlHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/**
 * A run claimed by a worker that then died: `running`, with a heartbeat long past.
 *
 * Claimed rather than written straight to `running`, because that is the sequence a real
 * orphan goes through — `claim` is what sets the heartbeat, and a test that skipped it would
 * not prove the scan reads the column the claim writes.
 */
async function orphanedRun(tenantId = CONTROL_TENANT, status: 'running' | 'planning' = 'running') {
  const run = await harness.runs.create({ tenantId, kind: 'task' });
  const claimed = await harness.runs.claim(tenantId, run.id, ['queued'], status);
  if (claimed === null) throw new Error('could not claim the seeded run');

  await harness.db.run.update({
    where: { id: run.id },
    data: { lastHeartbeatAt: new Date(Date.now() - STALE_MS) },
  });
  return run;
}

/** A run whose worker is still alive: claimed just now, so its heartbeat is fresh. */
async function liveRun(tenantId = CONTROL_TENANT) {
  const run = await harness.runs.create({ tenantId, kind: 'task' });
  const claimed = await harness.runs.claim(tenantId, run.id, ['queued'], 'running');
  if (claimed === null) throw new Error('could not claim the seeded run');
  return run;
}

describe('recovery: finding orphaned runs', () => {
  it('re-enqueues a run whose worker died, and reports what it did', async () => {
    const run = await orphanedRun();

    const result = await harness.recoveryService.scan();

    expect(result.scanned).toBe(1);
    expect(result.reEnqueued).toBe(1);
    expect(result.failed).toBe(0);
    expect(harness.enqueued.map((job) => job.runId)).toEqual([run.id]);
  });

  it('carries the tenant and kind through, so the consumer can execute it', async () => {
    // A handoff without the tenant is a job the engine cannot resolve a context for — the
    // recovery would look like it worked and the run would fail on arrival.
    const run = await orphanedRun();

    await harness.recoveryService.scan();

    expect(harness.enqueued[0]).toMatchObject({
      runId: run.id,
      tenantId: CONTROL_TENANT,
      kind: 'task',
    });
  });

  it('leaves a run with a live heartbeat alone', async () => {
    // The race this scan must lose. Re-enqueueing a run that is genuinely executing is not
    // harmful — the engine's claim is a compare-and-swap — but it is wasted work, and doing
    // it would mean the scan cannot tell "dead" from "busy".
    await liveRun();

    const result = await harness.recoveryService.scan();

    expect(result.scanned).toBe(0);
    expect(harness.enqueued).toHaveLength(0);
  });

  it('does not recover a run parked for approval', async () => {
    // The documented exclusion, and the reason the status set is not `listStale`'s default.
    // A parked run's heartbeat is *supposed* to be old: it is waiting for a human, and
    // nothing is working on it. Re-enqueueing it would be discarded by the engine, so the
    // effect is harmless — but the count would say a run was recovered when none was.
    const run = await harness.runs.create({ tenantId: CONTROL_TENANT, kind: 'task' });
    await harness.runs.setStatus(CONTROL_TENANT, run.id, 'waiting_approval');

    const result = await harness.recoveryService.scan();

    expect(result.scanned).toBe(0);
    expect(harness.enqueued).toHaveLength(0);
  });

  it('does not recover a finished run', async () => {
    const run = await harness.runs.create({ tenantId: CONTROL_TENANT, kind: 'task' });
    await harness.runs.setStatus(CONTROL_TENANT, run.id, 'completed');

    expect((await harness.recoveryService.scan()).scanned).toBe(0);
  });

  it('does not recover a run that has not been claimed yet', async () => {
    // `queued` means "waiting for a worker", not "abandoned by one". Re-enqueueing it would
    // double-queue a run the queue already holds.
    await harness.runs.create({ tenantId: CONTROL_TENANT, kind: 'task' });

    expect((await harness.recoveryService.scan()).scanned).toBe(0);
  });

  it('recovers a run orphaned while planning, not only while running', async () => {
    // `planning` is the other status a dead worker leaves behind — the claim moves a run
    // there before any step runs, so a crash between the claim and the first step is
    // exactly this state.
    await orphanedRun(CONTROL_TENANT, 'planning');

    expect((await harness.recoveryService.scan()).reEnqueued).toBe(1);
  });

  it('spans tenants, because there is no request to derive one from', async () => {
    // The unscoped read. A scan that only saw one tenant would miss exactly the orphans it
    // exists to find, in every other workspace.
    const mine = await orphanedRun(CONTROL_TENANT);
    const theirs = await orphanedRun(OTHER_TENANT);

    const result = await harness.recoveryService.scan();

    expect(result.reEnqueued).toBe(2);
    expect(new Set(harness.enqueued.map((job) => job.runId))).toEqual(
      new Set([mine.id, theirs.id]),
    );
  });

  it('reports nothing rather than failing when there is nothing to do', async () => {
    // The common case: this runs at every boot and hourly thereafter. It must be silent and
    // cheap when a process died cleanly.
    expect(await harness.recoveryService.scan()).toEqual({ scanned: 0, reEnqueued: 0, failed: 0 });
  });

  it('finds the same run again on a later scan, because a failed handoff changes nothing', async () => {
    // Recovery is at-least-once by construction: the scan does not mark the run, so a run
    // whose enqueue failed is still `running` with a stale heartbeat and is picked up again.
    // That is the property that makes a transient queue outage survivable.
    const run = await orphanedRun();

    await harness.recoveryService.scan();
    await harness.recoveryService.scan();

    expect(harness.enqueued.filter((job) => job.runId === run.id)).toHaveLength(2);
  });
});

describe('recovery: a handoff that fails', () => {
  /** A queue that refuses the named run and accepts the rest. */
  class PickyQueue implements RunQueue {
    readonly accepted: string[] = [];
    constructor(private readonly refuse: string) {}
    enqueue(job: RunQueueJob): Promise<void> {
      if (job.runId === this.refuse) return Promise.reject(new Error('queue is unreachable'));
      this.accepted.push(job.runId);
      return Promise.resolve();
    }
  }

  it('counts the failure and still recovers the others', async () => {
    // One unreachable handoff must not abandon the rest of the sweep — the others are
    // recoverable *now*, and the failed one will be found again on the next pass.
    const first = await orphanedRun();
    const second = await orphanedRun();
    const queue = new PickyQueue(first.id);
    const service = new RecoveryService({
      runs: harness.runs,
      queue,
      logger,
      staleAfterMs: 900_000,
    });

    const result = await service.scan();

    expect(result.scanned).toBe(2);
    expect(result.reEnqueued).toBe(1);
    expect(result.failed).toBe(1);
    expect(queue.accepted).toEqual([second.id]);
  });
});
