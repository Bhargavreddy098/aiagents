import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, nextCronFire } from '@nexs/shared';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';

/**
 * Schedules: creation, the transport registration, and firing.
 *
 * ## The acceptance criterion, and how far it can be proven here
 *
 * Phase 11's first acceptance criterion is *"recurring schedule fires while the API process
 * is down (worker only) → real run created"*. This machine has no Postgres, so pg-boss
 * itself cannot run and the literal claim — a cron firing in a process with no HTTP listener
 * — cannot be executed.
 *
 * What *is* proven here is every part of it that the application owns:
 *
 *  - the fire path creates a **real run row** and hands it to the queue (not a stub — the
 *    run is read back through the repository);
 *  - firing is **idempotent per occurrence**, so a redelivered job cannot double-fire, which
 *    is what makes a worker that restarts mid-fire safe;
 *  - the schedule's timing advances and a one-time schedule disables itself;
 *  - the registration is written on create and removed on disable/delete;
 *  - the consumer is registered against the schedule's own queue name, which is what the
 *    worker does at boot and on its sweep.
 *
 * The remaining step — pg-boss actually invoking that consumer on a cron — is the
 * transport's, and is asserted by the queue suite's registration tests rather than claimed
 * here.
 */

let harness: ControlHarness;

beforeEach(async () => {
  harness = await createControlHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

async function apiErrorFrom(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the call to throw an ApiError, but it resolved');
}

/** A task with an agent and a model, so a run created for it is resolvable. */
async function runnableTask(title = 'Nightly report') {
  const model = await harness.seedModel({ name: 'Model', externalModelId: 'model-1' });
  const agent = await harness.agentService.create(CONTROL_TENANT, {
    name: 'Reporter',
    instructions: 'Be brief.',
    modelId: model.id,
  });
  const task = await harness.taskService.create(CONTROL_TENANT, {
    title,
    triggerType: 'scheduled',
    scheduledAt: new Date(Date.now() + 86_400_000),
    agentId: agent.id,
  });
  return { task, agent, model };
}

async function recurringSchedule(taskId: string, cron = '*/10 * * * *') {
  return harness.scheduleService.create(CONTROL_TENANT, {
    name: 'Every ten minutes',
    kind: 'recurring',
    cron,
    targetKind: 'task',
    targetId: taskId,
  });
}

describe('schedules: creation', () => {
  it('stores the schedule and computes its next fire from the cron', async () => {
    const { task } = await runnableTask();
    const before = Date.now();
    const schedule = await recurringSchedule(task.id);

    expect(schedule.kind).toBe('recurring');
    expect(schedule.cron).toBe('*/10 * * * *');
    expect(schedule.timezone).toBe('UTC');
    expect(schedule.enabled).toBe(true);
    expect(schedule.nextFireAt).not.toBeNull();

    // The stored value is the evaluator's own answer, not a guess — so the list endpoint's
    // next-fire time and the cron the transport was given cannot disagree.
    const expected = nextCronFire('*/10 * * * *', new Date(before));
    expect(new Date(schedule.nextFireAt!).getTime()).toBe(expected!.getTime());
  });

  it('registers the schedule with the transport under its own queue name', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);

    expect(harness.scheduleQueue.upserts).toHaveLength(1);
    expect(harness.scheduleQueue.upserts[0]).toMatchObject({
      id: schedule.id,
      tenantId: CONTROL_TENANT,
      kind: 'recurring',
      cron: '*/10 * * * *',
      timezone: 'UTC',
    });
  });

  it('gives an event schedule no next fire, because it fires on a match', async () => {
    const { task } = await runnableTask();
    const subscription = await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'task',
      targetId: task.id,
    });

    const schedule = await harness.scheduleService.create(CONTROL_TENANT, {
      name: 'On build',
      kind: 'event',
      eventSubscriptionId: subscription.id,
      targetKind: 'task',
      targetId: task.id,
    });

    // `null` is the honest answer: there is no next time, and inventing one would make the
    // schedule look overdue.
    expect(schedule.nextFireAt).toBeNull();
  });

  it('refuses a target that does not exist', async () => {
    const err = await apiErrorFrom(() =>
      harness.scheduleService.create(CONTROL_TENANT, {
        name: 'Orphan',
        kind: 'recurring',
        cron: '*/5 * * * *',
        targetKind: 'task',
        targetId: 'tsk_missing',
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'targetId' });
  });

  it('refuses a non-UTC timezone rather than storing a time it cannot compute', async () => {
    const { task } = await runnableTask();
    const err = await apiErrorFrom(() =>
      harness.scheduleService.create(CONTROL_TENANT, {
        name: 'Tokyo',
        kind: 'recurring',
        cron: '0 9 * * *',
        timezone: 'Asia/Tokyo',
        targetKind: 'task',
        targetId: task.id,
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'timezone' });
  });
});

describe('schedules: tenant isolation', () => {
  it('does not list another tenant’s schedules', async () => {
    const { task } = await runnableTask();
    await recurringSchedule(task.id);

    const mine = await harness.scheduleService.list(CONTROL_TENANT);
    const theirs = await harness.scheduleService.list(OTHER_TENANT);

    expect(mine.schedules).toHaveLength(1);
    expect(theirs.schedules).toHaveLength(0);
  });

  it('refuses to read another tenant’s schedule by id', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);

    const err = await apiErrorFrom(() => harness.scheduleService.get(OTHER_TENANT, schedule.id));
    expect(err.code).toBe('NOT_FOUND');
  });

  it('refuses to disable another tenant’s schedule', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);

    const err = await apiErrorFrom(() =>
      harness.scheduleService.setEnabled(OTHER_TENANT, schedule.id, false),
    );
    expect(err.code).toBe('NOT_FOUND');

    // And it is still enabled, which is the part that actually matters: a 404 that had
    // already written would be worse than no check at all.
    expect((await harness.scheduleService.get(CONTROL_TENANT, schedule.id)).enabled).toBe(true);
  });

  it('refuses to delete another tenant’s schedule', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);

    const err = await apiErrorFrom(() => harness.scheduleService.remove(OTHER_TENANT, schedule.id));
    expect(err.code).toBe('NOT_FOUND');
    expect((await harness.scheduleService.list(CONTROL_TENANT)).schedules).toHaveLength(1);
  });
});

describe('schedules: firing creates a real run', () => {
  it('creates a run row and hands it to the queue', async () => {
    const { task, agent } = await runnableTask();
    const schedule = await recurringSchedule(task.id);

    const result = await harness.scheduleService.fire({
      scheduleId: schedule.id,
      tenantId: CONTROL_TENANT,
      occurrenceId: 'job-1',
    });

    expect(result.outcome).toBe('fired');
    expect(result.runId).toBeDefined();

    // Read back through the repository rather than trusting the returned id: the claim is
    // that a *row* exists, and only a read proves that.
    const run = await harness.runs.findById(CONTROL_TENANT, result.runId!);
    expect(run).not.toBeNull();
    expect(run!.taskId).toBe(task.id);
    expect(run!.agentId).toBe(agent.id);
    expect(run!.kind).toBe('task');

    // And it was handed off, which is what makes it execute rather than sit queued.
    expect(harness.enqueued.map((job) => job.runId)).toContain(result.runId);
  });

  it('advances lastFiredAt and recomputes nextFireAt', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);

    await harness.scheduleService.fire({
      scheduleId: schedule.id,
      tenantId: CONTROL_TENANT,
      occurrenceId: 'job-1',
    });

    const after = await harness.scheduleService.get(CONTROL_TENANT, schedule.id);
    expect(after.lastFiredAt).not.toBeNull();
    expect(after.nextFireAt).not.toBeNull();
    // The next fire is strictly later than the one just recorded, so a consumer polling
    // `nextFireAt` cannot read the schedule as already due.
    expect(new Date(after.nextFireAt!).getTime()).toBeGreaterThan(
      new Date(after.lastFiredAt!).getTime(),
    );
  });

  it('does not create a second run when the same occurrence is redelivered', async () => {
    // The heart of the design. A queue retry, a worker that restarted mid-fire, a duplicate
    // producer — all deliver the same job id, and none of them may produce a second run.
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);

    const first = await harness.scheduleService.fire({
      scheduleId: schedule.id,
      tenantId: CONTROL_TENANT,
      occurrenceId: 'job-1',
    });
    const second = await harness.scheduleService.fire({
      scheduleId: schedule.id,
      tenantId: CONTROL_TENANT,
      occurrenceId: 'job-1',
    });

    expect(second.runId).toBe(first.runId);
    expect(await harness.runs.count(CONTROL_TENANT, { taskId: task.id })).toBe(1);
  });

  it('creates a new run for the next occurrence', async () => {
    // The counterpart to the test above: dedupe must not be so aggressive that a recurring
    // schedule fires exactly once, ever.
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);

    const first = await harness.scheduleService.fire({
      scheduleId: schedule.id,
      tenantId: CONTROL_TENANT,
      occurrenceId: 'job-1',
    });
    const second = await harness.scheduleService.fire({
      scheduleId: schedule.id,
      tenantId: CONTROL_TENANT,
      occurrenceId: 'job-2',
    });

    expect(second.runId).not.toBe(first.runId);
    expect(await harness.runs.count(CONTROL_TENANT, { taskId: task.id })).toBe(2);
  });

  it('emits schedule.fired carrying the run it started', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);

    const result = await harness.scheduleService.fire({
      scheduleId: schedule.id,
      tenantId: CONTROL_TENANT,
      occurrenceId: 'job-1',
    });

    const frame = harness.frames.find((f) => f.name === 'schedule.fired');
    expect(frame).toBeDefined();
    expect(frame!.payload).toMatchObject({ scheduleId: schedule.id, runId: result.runId });
  });

  it('skips a disabled schedule without creating a run', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);
    await harness.scheduleService.setEnabled(CONTROL_TENANT, schedule.id, false);

    const result = await harness.scheduleService.fire({
      scheduleId: schedule.id,
      tenantId: CONTROL_TENANT,
      occurrenceId: 'job-1',
    });

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toMatch(/disabled/);
    expect(await harness.runs.count(CONTROL_TENANT, { taskId: task.id })).toBe(0);
  });

  it('skips a schedule that no longer exists', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);
    await harness.scheduleService.remove(CONTROL_TENANT, schedule.id);

    const result = await harness.scheduleService.fire({
      scheduleId: schedule.id,
      tenantId: CONTROL_TENANT,
      occurrenceId: 'job-1',
    });

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toMatch(/no longer exists/);
  });

  it('skips, rather than throws, when the target has been deleted', async () => {
    // A permanent failure must not become a queue retry storm. The occurrence is skipped and
    // the reason is reported, and the schedule's clock still advances so it is not wedged.
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);
    // Removed through the client rather than through a service: there is no task-delete
    // API, so this is the state an out-of-band change leaves behind. That is exactly what
    // the skip branch defends against, and it is reachable in a way a dangling id is not —
    // `create` refuses a target that does not exist.
    await harness.db.task.delete({ where: { id: task.id } });

    const result = await harness.scheduleService.fire({
      scheduleId: schedule.id,
      tenantId: CONTROL_TENANT,
      occurrenceId: 'job-1',
    });

    expect(result.outcome).toBe('skipped');
    expect(result.reason).toMatch(/does not exist/);
    expect(result.nextFireAt).not.toBeNull();
  });
});

describe('schedules: one-time schedules', () => {
  it('disables itself after firing, so the boot reconcile cannot fire it twice', async () => {
    const { task } = await runnableTask();
    const schedule = await harness.scheduleService.create(CONTROL_TENANT, {
      name: 'Once',
      kind: 'one_time',
      runAt: new Date(Date.now() - 1_000),
      targetKind: 'task',
      targetId: task.id,
    });

    const result = await harness.scheduleService.fire({
      scheduleId: schedule.id,
      tenantId: CONTROL_TENANT,
      occurrenceId: 'job-1',
    });

    expect(result.outcome).toBe('fired');
    expect(result.nextFireAt).toBeNull();

    const after = await harness.scheduleService.get(CONTROL_TENANT, schedule.id);
    expect(after.enabled).toBe(false);
  });
});

describe('schedules: enable, disable and delete', () => {
  it('removes the registration when disabled and restores it when enabled', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);
    expect(harness.scheduleQueue.upserts).toHaveLength(1);

    await harness.scheduleService.setEnabled(CONTROL_TENANT, schedule.id, false);
    expect(harness.scheduleQueue.removals).toEqual([schedule.id]);

    await harness.scheduleService.setEnabled(CONTROL_TENANT, schedule.id, true);
    expect(harness.scheduleQueue.upserts).toHaveLength(2);
  });

  it('recomputes the next fire when re-enabled, rather than restoring a stale one', async () => {
    // A schedule disabled for a week would otherwise come back with a next-fire time in the
    // past and fire immediately, which is not what "enable" means.
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);
    await harness.scheduleService.setEnabled(CONTROL_TENANT, schedule.id, false);

    // Push the stored next fire into the past, as a long disable would.
    await harness.schedules.setNextFireAt(
      CONTROL_TENANT,
      schedule.id,
      new Date(Date.now() - 86_400_000),
    );

    const reenabled = await harness.scheduleService.setEnabled(CONTROL_TENANT, schedule.id, true);
    expect(new Date(reenabled.nextFireAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it('removes the registration when deleted', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);

    await harness.scheduleService.remove(CONTROL_TENANT, schedule.id);

    expect(harness.scheduleQueue.removals).toEqual([schedule.id]);
    expect((await harness.scheduleService.list(CONTROL_TENANT)).schedules).toHaveLength(0);
  });

  it('does not register a schedule created disabled', async () => {
    const { task } = await runnableTask();
    await harness.scheduleService.create(CONTROL_TENANT, {
      name: 'Off',
      kind: 'recurring',
      cron: '*/5 * * * *',
      targetKind: 'task',
      targetId: task.id,
      enabled: false,
    });

    expect(harness.scheduleQueue.upserts).toHaveLength(0);
  });
});

describe('schedules: editing', () => {
  it('recomputes the next fire when the cron changes', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id, '*/10 * * * *');

    const updated = await harness.scheduleService.update(CONTROL_TENANT, schedule.id, {
      cron: '0 3 * * *',
    });

    expect(updated.cron).toBe('0 3 * * *');
    const expected = nextCronFire('0 3 * * *', new Date());
    expect(Math.abs(new Date(updated.nextFireAt!).getTime() - expected!.getTime())).toBeLessThan(2_000);
  });

  it('re-registers the transport after an edit', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id, '*/10 * * * *');

    await harness.scheduleService.update(CONTROL_TENANT, schedule.id, { cron: '0 3 * * *' });

    expect(harness.scheduleQueue.upserts).toHaveLength(2);
    expect(harness.scheduleQueue.upserts[1]).toMatchObject({ cron: '0 3 * * *' });
  });

  it('refuses to edit another tenant’s schedule', async () => {
    const { task } = await runnableTask();
    const schedule = await recurringSchedule(task.id);

    const err = await apiErrorFrom(() =>
      harness.scheduleService.update(OTHER_TENANT, schedule.id, { name: 'Hijacked' }),
    );
    expect(err.code).toBe('NOT_FOUND');
    expect((await harness.scheduleService.get(CONTROL_TENANT, schedule.id)).name).toBe(
      'Every ten minutes',
    );
  });
});

describe('schedules: the consumer list', () => {
  it('lists only enabled schedules, with the facts a registration needs', async () => {
    const { task } = await runnableTask();
    const on = await recurringSchedule(task.id);
    const off = await harness.scheduleService.create(CONTROL_TENANT, {
      name: 'Off',
      kind: 'recurring',
      cron: '0 4 * * *',
      targetKind: 'task',
      targetId: task.id,
      enabled: false,
    });

    const registrations = await harness.scheduleService.listForConsumer();

    expect(registrations.map((r) => r.id)).toEqual([on.id]);
    expect(registrations[0]).toMatchObject({ tenantId: CONTROL_TENANT, cron: '*/10 * * * *' });
    expect(registrations.map((r) => r.id)).not.toContain(off.id);
  });

  it('spans tenants, because the worker reconciles for all of them', async () => {
    const { task } = await runnableTask();
    await recurringSchedule(task.id);

    const otherModel = await harness.seedModel({ name: 'M2', externalModelId: 'model-2' });
    const otherAgent = await harness.agentService.create(OTHER_TENANT, {
      name: 'Theirs',
      modelId: otherModel.id,
    });
    const otherTask = await harness.taskService.create(OTHER_TENANT, {
      title: 'Theirs',
      triggerType: 'scheduled',
      scheduledAt: new Date(Date.now() + 86_400_000),
      agentId: otherAgent.id,
    });
    await harness.scheduleService.create(OTHER_TENANT, {
      name: 'Theirs',
      kind: 'recurring',
      cron: '0 5 * * *',
      targetKind: 'task',
      targetId: otherTask.id,
    });

    const registrations = await harness.scheduleService.listForConsumer();
    expect(registrations).toHaveLength(2);
    expect(new Set(registrations.map((r) => r.tenantId))).toEqual(
      new Set([CONTROL_TENANT, OTHER_TENANT]),
    );
  });
});
