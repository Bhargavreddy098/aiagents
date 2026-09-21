import { describe, expect, it, beforeEach } from 'vitest';
import pino from 'pino';
import {
  APPROVAL_EXPIRE_QUEUE,
  PROVIDER_HEALTH_QUEUE,
  RECOVERY_SCAN_QUEUE,
  QueueService,
  type QueueClient,
  type QueueExecutor,
} from '../src/services/queue/queue.service.js';
import {
  InlineRunQueue,
  PgBossRunQueue,
  RecordingRunQueue,
  RUN_EXECUTE_QUEUE,
} from '../src/services/queue/run-queue.js';
import type { RunQueueJob } from '../src/services/queue/run-queue.js';
import { scheduleQueueName, type ScheduleJob } from '../src/services/queue/schedule-queue.js';

/**
 * The queue's lifecycle, over a recording fake of the pg-boss client.
 *
 * ## Why this is worth testing at all, given the transport is pg-boss's
 *
 * What is *not* verifiable here is pg-boss: it needs Postgres, and this machine has none.
 * What is verifiable — and what was actually broken — is everything around it:
 *
 *  - **Every queue this app sends to is declared before anything sends to it.** pg-boss
 *    refuses `send` to an undeclared queue. Missing a declaration is a run that is never
 *    enqueued, which surfaces as a task that silently does nothing.
 *  - **`start()` precedes any producer.** Migrations run in `start()`; a send before it
 *    is refused.
 *  - **A handler that throws must propagate**, or pg-boss cannot retry and a run that
 *    failed to start is lost with no signal.
 *  - **The expiry job is scheduled `startAfter` the approval's own deadline**, not at a
 *    fixed offset — that is the spec's `approval.expire` contract.
 *
 * Each of those is a real way for the feature to be silently absent, and none of them needs
 * a database to catch.
 */

/** Records every call, and lets a test observe ordering and failure propagation. */
class FakeQueueClient implements QueueClient {
  readonly calls: string[] = [];
  readonly declared: Array<{ name: string; options?: unknown }> = [];
  readonly sent: Array<{ name: string; data: object; options?: unknown }> = [];
  readonly schedules: Array<{ name: string; cron: string }> = [];
  readonly unscheduled: string[] = [];
  private readonly handlers = new Map<string, (jobs: Array<{ id: string; data: never }>) => Promise<void>>();
  stopAllCalled = 0;
  stopOptions: { graceful?: boolean } | undefined;

  /** Make the next `send` reject, to exercise the "queue hiccup" path. */
  failNextSend = false;

  /** Make the next `createQueue` reject, to exercise a *partial* start. */
  failNextCreateQueue = false;

  async start(): Promise<void> {
    this.calls.push('start');
  }

  async stop(options?: { graceful?: boolean }): Promise<void> {
    this.calls.push('stop');
    this.stopAllCalled += 1;
    this.stopOptions = options;
  }

  async createQueue(name: string, options?: { retryLimit?: number; expireInSeconds?: number }): Promise<void> {
    this.calls.push(`createQueue:${name}`);
    if (this.failNextCreateQueue) {
      this.failNextCreateQueue = false;
      throw new Error('permission denied for schema nexs_jobs');
    }
    this.declared.push({ name, ...(options === undefined ? {} : { options }) });
  }

  async work<T>(name: string, handler: (jobs: Array<{ id: string; data: T }>) => Promise<void>): Promise<string> {
    this.calls.push(`work:${name}`);
    this.handlers.set(name, handler as unknown as (jobs: Array<{ id: string; data: never }>) => Promise<void>);
    return `worker-${name}`;
  }

  async send(
    name: string,
    data: object,
    options?: { startAfter?: number | Date; singletonKey?: string },
  ): Promise<string | null> {
    this.calls.push(`send:${name}`);
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('connection terminated unexpectedly');
    }
    this.sent.push({ name, data, ...(options === undefined ? {} : { options }) });
    return 'job-1';
  }

  // `data` is part of the port's signature but this fake does not record it: nothing in
  // this suite asserts on the cron's payload, and recording an unused field would invite a
  // future reader to think something checks it.
  async schedule(name: string, cron: string, _data?: object): Promise<void> {
    this.calls.push(`schedule:${name}`);
    this.schedules.push({ name, cron });
  }

  async unschedule(name: string): Promise<void> {
    this.calls.push(`unschedule:${name}`);
    this.unscheduled.push(name);
    // Mirrors pg-boss: the cron entry is gone, so a later `schedule()` for this name is a
    // fresh registration rather than a replacement. Modelling it matters, because
    // `PgBossScheduleQueue.upsert` clears before it writes and would otherwise look
    // idempotent in a way the transport is not.
    const index = this.schedules.findIndex((entry) => entry.name === name);
    if (index >= 0) this.schedules.splice(index, 1);
  }

  /** Deliver a batch to a registered consumer, as the transport would. */
  async deliver<T>(name: string, jobs: Array<{ id: string; data: T }>): Promise<void> {
    const handler = this.handlers.get(name);
    if (handler === undefined) throw new Error(`no consumer registered for "${name}"`);
    await handler(jobs as unknown as Array<{ id: string; data: never }>);
  }

  hasConsumer(name: string): boolean {
    return this.handlers.has(name);
  }
}

const logger = pino({ level: 'silent' });

let boss: FakeQueueClient;

beforeEach(() => {
  boss = new FakeQueueClient();
});

function buildService(overrides: {
  consumeRuns?: boolean;
  onRun?: (job: RunQueueJob) => Promise<unknown>;
  onExpireApprovals?: () => Promise<unknown>;
  onFireSchedule?: (job: { scheduleId: string; tenantId: string }, jobId: string) => Promise<unknown>;
  onRecoverRuns?: () => Promise<unknown>;
  onCheckProviderHealth?: () => Promise<unknown>;
} = {}): QueueService {
  const queue = new QueueService({
    boss,
    logger,
    consumeRuns: overrides.consumeRuns ?? true,
  });
  // Bound exactly as `wireRuntime` binds it — after construction, before `start()`. A test
  // that skipped `bind` would exercise a queue whose consumers throw, which is a different
  // object from the one that ships.
  queue.bind(executorWith(overrides));
  return queue;
}

/**
 * A complete `QueueExecutor`, with only the callbacks a test cares about overridden.
 *
 * Every member is required on the port — deliberately, so a composition root cannot wire a
 * consumer that acknowledges jobs and does nothing — which means a test that overrides one
 * must still supply the rest. Defaulting them here keeps each test's intent visible instead
 * of burying it under four no-ops.
 */
function executorWith(overrides: {
  onRun?: (job: RunQueueJob) => Promise<unknown>;
  onExpireApprovals?: () => Promise<unknown>;
  onFireSchedule?: (job: { scheduleId: string; tenantId: string }, jobId: string) => Promise<unknown>;
  onRecoverRuns?: () => Promise<unknown>;
  onCheckProviderHealth?: () => Promise<unknown>;
} = {}): QueueExecutor {
  return {
    onRun: overrides.onRun ?? (() => Promise.resolve()),
    onExpireApprovals: overrides.onExpireApprovals ?? (() => Promise.resolve()),
    onFireSchedule: overrides.onFireSchedule ?? (() => Promise.resolve()),
    onRecoverRuns: overrides.onRecoverRuns ?? (() => Promise.resolve()),
    onCheckProviderHealth: overrides.onCheckProviderHealth ?? (() => Promise.resolve()),
  };
}

describe('queue: lifecycle', () => {
  it('connects before it declares, and declares before anything can send', async () => {
    const queue = buildService();
    await queue.start();

    // Order matters and is the whole point: `start()` runs pg-boss's schema migrations, and
    // `send` to an undeclared queue is refused. A declaration that happened after a producer
    // was live would drop the first runs after every boot.
    expect(boss.calls[0]).toBe('start');
    expect(boss.calls.indexOf(`createQueue:${RUN_EXECUTE_QUEUE}`)).toBeLessThan(
      boss.calls.findIndex((call) => call.startsWith('work:')),
    );
  });

  it('declares every queue it produces to, even when it does not consume them', async () => {
    // The API process is a producer for `approval.expire` even when a separate worker owns
    // the consumer. Declaring only what this process consumes would make the producer fail
    // on its first send after a fresh database.
    const queue = buildService({ consumeRuns: false });
    await queue.start();

    const declared = boss.declared.map((row) => row.name);
    expect(declared).toContain(RUN_EXECUTE_QUEUE);
    expect(declared).toContain(APPROVAL_EXPIRE_QUEUE);
    // But it registers no consumers, because it is not the worker.
    expect(boss.calls.some((call) => call.startsWith('work:'))).toBe(false);
  });

  it('registers consumers only when it is asked to consume', async () => {
    await buildService({ consumeRuns: true }).start();
    expect(boss.hasConsumer(RUN_EXECUTE_QUEUE)).toBe(true);
    expect(boss.hasConsumer(APPROVAL_EXPIRE_QUEUE)).toBe(true);
  });

  it('reports `connected` from start until stop, and is safe to stop twice', async () => {
    const queue = buildService();
    expect(queue.connected).toBe(false);

    await queue.start();
    expect(queue.connected).toBe(true);

    await queue.stop();
    expect(queue.connected).toBe(false);

    // A second SIGTERM must not throw — shutdown handlers are not idempotent by default,
    // and a throw during shutdown converts a clean exit into a forced one.
    await expect(queue.stop()).resolves.toBeUndefined();
    expect(boss.stopAllCalled).toBe(1);
  });

  it('stops without waiting for in-flight work', async () => {
    const queue = buildService();
    await queue.start();
    await queue.stop();

    // `graceful: false` is deliberate: a run interrupted mid-step is recovered from its
    // checkpoint by the next process, and waiting is what makes a SIGTERM miss its deadline
    // and force an exit.
    expect(boss.stopOptions).toEqual({ graceful: false });
  });

  it('never touches the transport before start()', async () => {
    buildService();
    expect(boss.calls).toEqual([]);
  });

  it('refuses to start a consumer with nothing bound to it', async () => {
    // A consumer that acknowledges jobs and executes nothing is the worst outcome: the
    // queue reports success, the run stays `queued`, and nothing in the logs says why.
    const unbound = new QueueService({ boss, logger, consumeRuns: true });
    await expect(unbound.start()).rejects.toThrow(/no executor bound/);
  });

  it('refuses a second bind', async () => {
    // Two executors would mean the second silently replaced the first — the composed wiring
    // would be half-ignored, which is exactly the kind of bug that survives review.
    const queue = buildService();
    expect(() => queue.bind(executorWith())).toThrow(/called twice/);
  });

  it('does not claim to be connected when a queue declaration fails mid-start', async () => {
    // `boss.start()` can succeed and `createQueue` then fail — a schema permission problem,
    // a migration lock, a dropped connection. The transport is up but nothing is declared,
    // so a `send` would still be refused. Reporting `up` here would make `/api/health` lie
    // about the one field it exists to report honestly.
    const queue = buildService();
    boss.failNextCreateQueue = true;

    await expect(queue.start()).rejects.toThrow(/permission denied/);

    expect(queue.connected).toBe(false);
    expect(boss.hasConsumer(RUN_EXECUTE_QUEUE)).toBe(false);
  });

  it('still closes the pool after a partial start', async () => {
    // The pool `boss.start()` opened is real even though the queue never became usable, and
    // a shutdown that skipped the close would leak it for the life of the process. This is
    // why `stop()` guards on the transport having opened, not on the queue being ready.
    const queue = buildService();
    boss.failNextCreateQueue = true;
    await expect(queue.start()).rejects.toThrow(/permission denied/);

    await queue.stop();

    expect(boss.stopAllCalled).toBe(1);
  });

  it('is a no-op to stop a queue that never opened', async () => {
    const queue = buildService();
    await queue.stop();
    expect(boss.stopAllCalled).toBe(0);
  });
});

describe('queue: consuming run.execute', () => {
  it('executes a delivered run job', async () => {
    const seen: RunQueueJob[] = [];
    const queue = buildService({
      onRun: (job) => {
        seen.push(job);
        return Promise.resolve();
      },
    });
    await queue.start();

    await boss.deliver<RunQueueJob>(RUN_EXECUTE_QUEUE, [
      { id: 'job-1', data: { runId: 'run_1', tenantId: 'tnt_1', kind: 'task' } },
    ]);

    expect(seen).toEqual([{ runId: 'run_1', tenantId: 'tnt_1', kind: 'task' }]);
  });

  it('processes a whole batch rather than only the first job', async () => {
    // pg-boss hands over an array. Handling only `jobs[0]` would leave every other run in
    // the batch unexecuted until its retry — a bug that looks like slowness, not like loss.
    const seen: string[] = [];
    const queue = buildService({
      onRun: (job) => {
        seen.push(job.runId);
        return Promise.resolve();
      },
    });
    await queue.start();

    await boss.deliver<RunQueueJob>(RUN_EXECUTE_QUEUE, [
      { id: 'j1', data: { runId: 'run_a', tenantId: 'tnt_1', kind: 'task' } },
      { id: 'j2', data: { runId: 'run_b', tenantId: 'tnt_1', kind: 'task' } },
      { id: 'j3', data: { runId: 'run_c', tenantId: 'tnt_1', kind: 'task' } },
    ]);

    expect(seen).toEqual(['run_a', 'run_b', 'run_c']);
  });

  it('propagates a handler failure so the queue can retry', async () => {
    // Swallowing here is the dangerous choice: pg-boss retries a job whose handler throws,
    // so catching would convert "the run failed to start" into a silent, permanent loss.
    const queue = buildService({
      onRun: () => Promise.reject(new Error('engine exploded')),
    });
    await queue.start();

    await expect(
      boss.deliver<RunQueueJob>(RUN_EXECUTE_QUEUE, [
        { id: 'j1', data: { runId: 'run_x', tenantId: 'tnt_1', kind: 'task' } },
      ]),
    ).rejects.toThrow('engine exploded');
  });

  it('stops the batch at the first failure rather than running the rest', async () => {
    // The remaining jobs stay unacked and are redelivered, which is correct: executing them
    // here would be the queue pretending a failure did not happen.
    const attempted: string[] = [];
    const queue = buildService({
      onRun: (job) => {
        attempted.push(job.runId);
        return job.runId === 'run_bad' ? Promise.reject(new Error('bad')) : Promise.resolve();
      },
    });
    await queue.start();

    await expect(
      boss.deliver<RunQueueJob>(RUN_EXECUTE_QUEUE, [
        { id: 'j1', data: { runId: 'run_ok_1', tenantId: 'tnt_1', kind: 'task' } },
        { id: 'j2', data: { runId: 'run_bad', tenantId: 'tnt_1', kind: 'task' } },
        { id: 'j3', data: { runId: 'run_ok_2', tenantId: 'tnt_1', kind: 'task' } },
      ]),
    ).rejects.toThrow('bad');

    expect(attempted).toEqual(['run_ok_1', 'run_bad']);
  });
});

describe('queue: the approval expiry job', () => {
  it('schedules the sweep on the approval own deadline, not a fixed offset', async () => {
    const queue = buildService();
    await queue.start();

    const deadline = new Date('2026-09-19T12:00:00.000Z');
    await queue.scheduleApprovalExpiry('apr_1', deadline);

    expect(boss.sent).toHaveLength(1);
    expect(boss.sent[0]!.name).toBe(APPROVAL_EXPIRE_QUEUE);
    // `startAfter` is the spec's mechanism: the job fires when *this* approval is due.
    expect((boss.sent[0]!.options as { startAfter: Date }).startAfter).toEqual(deadline);
    // Singleton per approval, so a retried request or two workers collapse to one job.
    expect((boss.sent[0]!.options as { singletonKey: string }).singletonKey).toBe('apr_1');
  });

  it('does not send, and does not throw, when the queue was never started', async () => {
    // An approval created before the queue connected is still swept by the cron. Failing
    // here would roll back a request that has already been recorded — the worse outcome.
    const queue = buildService();
    await expect(queue.scheduleApprovalExpiry('apr_1', new Date())).resolves.toBeUndefined();
    expect(boss.sent).toHaveLength(0);
  });

  it('registers the three recurring sweeps as backstops', async () => {
    const queue = buildService();
    await queue.start();
    await queue.scheduleRecurringSweeps();

    // All three of the spec's cron entries. Asserted as a set rather than by length,
    // because "three crons were registered" is not the claim — "these three cadences were
    // registered" is, and a typo in a cron string would pass a length check.
    expect(boss.schedules).toEqual(
      expect.arrayContaining([
        { name: APPROVAL_EXPIRE_QUEUE, cron: '*/5 * * * *' },
        { name: PROVIDER_HEALTH_QUEUE, cron: '*/10 * * * *' },
        { name: RECOVERY_SCAN_QUEUE, cron: '0 * * * *' },
      ]),
    );
    expect(boss.schedules).toHaveLength(3);
  });

  it('runs the sweep when a sweep job is delivered', async () => {
    let sweeps = 0;
    const queue = buildService({
      onExpireApprovals: () => {
        sweeps += 1;
        return Promise.resolve();
      },
    });
    await queue.start();

    await boss.deliver(APPROVAL_EXPIRE_QUEUE, [{ id: 's1', data: { reason: 'cron' } }]);
    expect(sweeps).toBe(1);
  });
});

describe('queue: the InlineRunQueue fallback', () => {
  it('executes in-process without awaiting, and reports the handoff immediately', async () => {
    const started: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const queue = new InlineRunQueue({
      execute: async (job) => {
        started.push(job.runId);
        await gate;
      },
      logger,
    });

    // Resolves while the run is still executing — the contract is "the run was *started*",
    // never "the run finished".
    await queue.enqueue({ runId: 'run_1', tenantId: 'tnt_1', kind: 'task' });
    expect(started).toEqual(['run_1']);

    release?.();
  });

  it('survives an execution failure instead of crashing the process', async () => {
    // An unhandled rejection takes the process down; a run failing to start is a logged
    // incident. This is the difference between one lost run and an outage.
    const queue = new InlineRunQueue({
      execute: () => Promise.reject(new Error('boom')),
      logger,
    });

    await expect(
      queue.enqueue({ runId: 'run_1', tenantId: 'tnt_1', kind: 'task' }),
    ).resolves.toBeUndefined();

    // Let the floating rejection settle before the test ends.
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('queue: the RecordingRunQueue used by tests', () => {
  it('records every job, so "exactly one enqueue" is an assertion', async () => {
    const queue = new RecordingRunQueue();
    await queue.enqueue({ runId: 'run_1', tenantId: 'tnt_1', kind: 'task' });
    await queue.enqueue({ runId: 'run_2', tenantId: 'tnt_1', kind: 'task' });
    expect(queue.jobs.map((job) => job.runId)).toEqual(['run_1', 'run_2']);
  });
});

describe('queue: the pg-boss producer adapter', () => {
  it('sends the job to the run.execute queue with a per-run singleton key', async () => {
    const sent: Array<{ name: string; data: object; options?: unknown }> = [];
    const queue = new PgBossRunQueue(
      {
        send: (name, data, options) => {
          sent.push({ name, data, ...(options === undefined ? {} : { options }) });
          return Promise.resolve('job-1');
        },
      },
      logger,
    );

    await queue.enqueue({ runId: 'run_9', tenantId: 'tnt_1', kind: 'task' });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe(RUN_EXECUTE_QUEUE);
    expect(sent[0]!.data).toEqual({ runId: 'run_9', tenantId: 'tnt_1', kind: 'task' });
    // The singleton key is what makes the queue itself refuse a duplicate delivery.
    expect((sent[0]!.options as { singletonKey: string }).singletonKey).toBe('run_9');
  });

  it('treats a deduplicated send (null id) as success', async () => {
    // pg-boss returns null when the singleton key collapsed the job. The run IS queued —
    // reporting failure here would make a caller retry a handoff that already happened.
    const queue = new PgBossRunQueue({ send: () => Promise.resolve(null) }, logger);
    await expect(
      queue.enqueue({ runId: 'run_9', tenantId: 'tnt_1', kind: 'task' }),
    ).resolves.toBeUndefined();
  });
});

describe('queue: the per-schedule consumers', () => {
  /** One enabled schedule, as `ScheduleService.listForConsumer` returns it. */
  function registration(id: string, tenantId = 'tnt_1') {
    return { id, tenantId, kind: 'recurring', cron: '*/10 * * * *', runAt: null, timezone: 'UTC' };
  }

  it('registers a consumer on the schedule’s own queue name', async () => {
    // The consequence of the spec's per-schedule queue design: pg-boss registers crons by
    // queue name, so each schedule is its own queue and each needs its own `work()`.
    const queue = buildService();
    await queue.start();

    const added = await queue.ensureScheduleConsumers([registration('sch_1')]);

    expect(added).toBe(1);
    expect(boss.hasConsumer(scheduleQueueName('sch_1'))).toBe(true);
    expect(boss.declared.map((row) => row.name)).toContain(scheduleQueueName('sch_1'));
  });

  it('is idempotent, so a reconcile on a timer does not accumulate consumers', async () => {
    // Without the in-process guard every sweep would call `work()` again and this process
    // would end up with N consumers racing for the same jobs.
    const queue = buildService();
    await queue.start();

    await queue.ensureScheduleConsumers([registration('sch_1')]);
    const second = await queue.ensureScheduleConsumers([registration('sch_1')]);
    const third = await queue.ensureScheduleConsumers([registration('sch_1'), registration('sch_2')]);

    expect(second).toBe(0);
    expect(third).toBe(1);
    expect(boss.calls.filter((call) => call === `work:${scheduleQueueName('sch_1')}`)).toHaveLength(1);
  });

  it('registers nothing when this process is not the worker', async () => {
    // The API process declares the queues it produces to, but a consumer it does not run is
    // work it must not claim — otherwise the API competes with the worker for every fire.
    const queue = buildService({ consumeRuns: false });
    await queue.start();

    expect(await queue.ensureScheduleConsumers([registration('sch_1')])).toBe(0);
    expect(boss.hasConsumer(scheduleQueueName('sch_1'))).toBe(false);
  });

  it('registers nothing before start(), because the transport is not open', async () => {
    const queue = buildService();
    expect(await queue.ensureScheduleConsumers([registration('sch_1')])).toBe(0);
    expect(boss.calls).toEqual([]);
  });

  it('fires the schedule with the job id as the occurrence identity', async () => {
    // The job id is what makes a redelivery collapse into the run it already created, so it
    // must reach the executor rather than being dropped at the consumer boundary.
    const seen: Array<{ scheduleId: string; jobId: string }> = [];
    const queue = buildService({
      onFireSchedule: (job, jobId) => {
        seen.push({ scheduleId: job.scheduleId, jobId });
        return Promise.resolve();
      },
    });
    await queue.start();
    await queue.ensureScheduleConsumers([registration('sch_1')]);

    await boss.deliver<ScheduleJob>(scheduleQueueName('sch_1'), [
      { id: 'job-abc', data: { scheduleId: 'sch_1', tenantId: 'tnt_1' } },
    ]);

    expect(seen).toEqual([{ scheduleId: 'sch_1', jobId: 'job-abc' }]);
  });

  it('propagates a fire failure so the occurrence is retried', async () => {
    const queue = buildService({
      onFireSchedule: () => Promise.reject(new Error('database is down')),
    });
    await queue.start();
    await queue.ensureScheduleConsumers([registration('sch_1')]);

    await expect(
      boss.deliver<ScheduleJob>(scheduleQueueName('sch_1'), [
        { id: 'job-abc', data: { scheduleId: 'sch_1', tenantId: 'tnt_1' } },
      ]),
    ).rejects.toThrow('database is down');
  });

  it('enqueues one recovery scan, and skips it when the queue never opened', async () => {
    const queue = buildService();
    await queue.start();
    await queue.enqueueRecoveryScan('boot');

    expect(boss.sent).toHaveLength(1);
    expect(boss.sent[0]!.name).toBe(RECOVERY_SCAN_QUEUE);
    expect(boss.sent[0]!.data).toEqual({ reason: 'boot' });

    // An unconnected queue has no producer; the cron will catch up. Throwing here would
    // abort a boot that is otherwise fine.
    const cold = buildService();
    await expect(cold.enqueueRecoveryScan('boot')).resolves.toBeUndefined();
  });

  it('runs the recovery and provider-health consumers when their jobs are delivered', async () => {
    let recoveries = 0;
    let sweeps = 0;
    const queue = buildService({
      onRecoverRuns: () => {
        recoveries += 1;
        return Promise.resolve();
      },
      onCheckProviderHealth: () => {
        sweeps += 1;
        return Promise.resolve();
      },
    });
    await queue.start();

    await boss.deliver(RECOVERY_SCAN_QUEUE, [{ id: 'r1', data: { reason: 'cron' } }]);
    await boss.deliver(PROVIDER_HEALTH_QUEUE, [{ id: 'h1', data: { reason: 'cron' } }]);

    expect(recoveries).toBe(1);
    expect(sweeps).toBe(1);
  });
});
