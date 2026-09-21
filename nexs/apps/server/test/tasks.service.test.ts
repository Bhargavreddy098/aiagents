import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, createTaskSchema } from '@nexs/shared';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';

/**
 * Tasks: the scheduling half of a unit of work.
 *
 * The behaviour worth the most attention here is **what a duplicate delivery does**. A
 * caller that retries sends the same `idempotencyKey`, and the correct answer is "you
 * already created this" — not a second task, and above all not a second **run**. Two runs
 * for one task means two sets of side effects against the outside world, which is the
 * failure this whole design exists to prevent. So the assertions below count runs *and*
 * queue handoffs, because either one going up is the bug.
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

async function runsFor(taskId: string): Promise<number> {
  return harness.runs.count(CONTROL_TENANT, { taskId });
}

/**
 * The minimum an immediate task needs to be runnable: a model, because it has no agent.
 *
 * Spread into each `create` call rather than hidden behind a helper, so every test stays
 * explicit about the request it is making — and so the tests that deliberately omit it are
 * visible as such.
 */
const RUNNABLE = { input: { context: { modelId: 'mdl_test' } } } as const;

describe('creating a task', () => {
  it('starts exactly one run and one queue handoff for an immediate task', async () => {
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Send the report',
      triggerType: 'immediate',
      ...RUNNABLE,
    });

    expect(task.status).toBe('running');
    expect(task.startedAt).not.toBeNull();

    expect(await runsFor(task.id)).toBe(1);
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]).toMatchObject({ tenantId: CONTROL_TENANT, kind: 'task' });

    // The run carries the task's provenance and is keyed to the task, so even a delivery
    // that somehow reached the run-creating path twice could not produce a second run.
    const run = await harness.runs.findById(CONTROL_TENANT, harness.enqueued[0]!.runId);
    expect(run!.taskId).toBe(task.id);
    expect(run!.idempotencyKey).toBe(`task:${task.id}`);
  });

  it('refuses an immediate task that could never resolve a model', async () => {
    // No agent to supply a model and no model in the input. The run would be created and
    // then fail on its first line, leaving the task `running` behind a `failed` run — so
    // the caller is told now, while they can still fix the request.
    const err = await apiErrorFrom(() =>
      harness.taskService.create(CONTROL_TENANT, {
        title: 'Doomed',
        triggerType: 'immediate',
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'agentId' });
    expect(harness.enqueued).toHaveLength(0);
  });

  it('accepts an immediate task whose agent supplies the model', async () => {
    const model = await harness.seedModel({ name: 'Model', externalModelId: 'model-1' });
    const agent = await harness.agentService.create(CONTROL_TENANT, {
      name: 'Runner',
      modelId: model.id,
    });

    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Delegated',
      triggerType: 'immediate',
      agentId: agent.id,
    });

    expect(task.status).toBe('running');
    expect(harness.enqueued).toHaveLength(1);
  });

  it('does not require a model for a task that starts no run yet', async () => {
    // A scheduled task does not run now, so its agent may legitimately be assigned before
    // it fires. Refusing here would block a perfectly ordinary workflow.
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Later',
      triggerType: 'scheduled',
      scheduledAt: new Date(Date.now() + 60_000),
    });

    expect(task.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(0);
  });

  it('starts a run for a manual task too', async () => {
    // `manual` is an immediate trigger: "manual" describes *who* initiated it, not that it
    // waits for something. Treating it as deferred would leave a task that never runs.
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Kick it off',
      triggerType: 'manual',
      ...RUNNABLE,
    });

    expect(await runsFor(task.id)).toBe(1);
    expect(harness.enqueued).toHaveLength(1);
  });

  it('does not start a run for a scheduled task', async () => {
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Later',
      triggerType: 'scheduled',
      scheduledAt: new Date(Date.now() + 60_000),
    });

    // Stored, not started: the scheduler that dispatches it is Phase 9.
    expect(task.status).toBe('queued');
    expect(await runsFor(task.id)).toBe(0);
    expect(harness.enqueued).toHaveLength(0);
  });

  it('starts no second run when the same delivery is retried', async () => {
    const input = {
      title: 'Send the report',
      triggerType: 'immediate' as const,
      idempotencyKey: 'delivery-1',
      ...RUNNABLE,
    };

    const first = await harness.taskService.create(CONTROL_TENANT, input);
    const second = await harness.taskService.create(CONTROL_TENANT, input);

    expect(second.id).toBe(first.id);
    // The whole point: a retry is not a new unit of work.
    expect(await runsFor(first.id)).toBe(1);
    expect(harness.enqueued).toHaveLength(1);
  });

  it('treats a different idempotency key as a different task', async () => {
    await harness.taskService.create(CONTROL_TENANT, {
      title: 'One',
      triggerType: 'immediate',
      idempotencyKey: 'a',
      ...RUNNABLE,
    });
    await harness.taskService.create(CONTROL_TENANT, {
      title: 'Two',
      triggerType: 'immediate',
      idempotencyKey: 'b',
      ...RUNNABLE,
    });

    expect(harness.enqueued).toHaveLength(2);
  });

  it('does not deduplicate two tasks that both omit an idempotency key', async () => {
    const first = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Same title',
      triggerType: 'immediate',
      ...RUNNABLE,
    });
    const second = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Same title',
      triggerType: 'immediate',
      ...RUNNABLE,
    });

    expect(second.id).not.toBe(first.id);
    expect(harness.enqueued).toHaveLength(2);
  });

  it('scopes the idempotency key to the tenant', async () => {
    await harness.taskService.create(CONTROL_TENANT, {
      title: 'Mine',
      triggerType: 'immediate',
      idempotencyKey: 'shared',
      ...RUNNABLE,
    });
    const theirs = await harness.taskService.create(OTHER_TENANT, {
      title: 'Theirs',
      triggerType: 'immediate',
      idempotencyKey: 'shared',
      ...RUNNABLE,
    });

    expect(theirs.title).toBe('Theirs');
    expect(harness.enqueued).toHaveLength(2);
  });
});

describe('companion rows a trigger must name', () => {
  it('refuses a recurring task, and says which field it is missing', async () => {
    const err = await apiErrorFrom(() =>
      harness.taskService.create(CONTROL_TENANT, {
        title: 'Every morning',
        triggerType: 'recurring',
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'scheduleId' });
  });

  it('refuses a recurring task that names a schedule which does not exist', async () => {
    // This is the Phase 11 change. Before the scheduler existed this was `FEATURE_DISABLED`
    // — "schedules arrive in a later phase". Now they exist, so the honest answer to a
    // dangling id is that the row is missing, and the field is named.
    const err = await apiErrorFrom(() =>
      harness.taskService.create(CONTROL_TENANT, {
        title: 'Every morning',
        triggerType: 'recurring',
        scheduleId: 'sch_missing',
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'scheduleId', scheduleId: 'sch_missing' });
    expect(harness.enqueued).toHaveLength(0);
  });

  it('refuses a recurring task whose schedule is not recurring', async () => {
    // A one-time schedule named as a task's recurring trigger is a real mistake, and it is
    // the kind that would otherwise surface as "my task ran once and never again".
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Template',
      // `scheduled` rather than `manual`: a manual task is an immediate trigger and so has
      // to resolve a model at creation, and this test is about the companion-row check, not
      // about model resolution. A scheduled task stores `queued` without starting a run.
      triggerType: 'scheduled',
      scheduledAt: new Date(Date.now() + 86_400_000),
    });
    const schedule = await harness.schedules.create({
      tenantId: CONTROL_TENANT,
      name: 'Once only',
      kind: 'one_time',
      cron: null,
      timezone: 'UTC',
      runAt: new Date(Date.now() + 3_600_000),
      eventSubscriptionId: null,
      targetKind: 'task',
      targetId: task.id,
      enabled: true,
      nextFireAt: new Date(Date.now() + 3_600_000),
    });

    const err = await apiErrorFrom(() =>
      harness.taskService.create(CONTROL_TENANT, {
        title: 'Every morning',
        triggerType: 'recurring',
        scheduleId: schedule.id,
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'scheduleId', kind: 'one_time' });
  });

  it('accepts a recurring task that names a real recurring schedule', async () => {
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Template',
      // `scheduled` rather than `manual`: a manual task is an immediate trigger and so has
      // to resolve a model at creation, and this test is about the companion-row check, not
      // about model resolution. A scheduled task stores `queued` without starting a run.
      triggerType: 'scheduled',
      scheduledAt: new Date(Date.now() + 86_400_000),
    });
    const schedule = await harness.schedules.create({
      tenantId: CONTROL_TENANT,
      name: 'Every ten minutes',
      kind: 'recurring',
      cron: '*/10 * * * *',
      timezone: 'UTC',
      runAt: null,
      eventSubscriptionId: null,
      targetKind: 'task',
      targetId: task.id,
      enabled: true,
      nextFireAt: new Date(Date.now() + 600_000),
    });

    const recurring = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Every morning',
      triggerType: 'recurring',
      scheduleId: schedule.id,
    });

    expect(recurring.scheduleId).toBe(schedule.id);
    expect(recurring.triggerType).toBe('recurring');
    // A recurring task does not start a run when it is created — it starts one when the
    // schedule fires. Creating it must therefore enqueue nothing.
    expect(harness.enqueued).toHaveLength(0);
  });

  it('refuses an event task, and says which field it is missing', async () => {
    const err = await apiErrorFrom(() =>
      harness.taskService.create(CONTROL_TENANT, {
        title: 'On webhook',
        triggerType: 'event',
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'eventSubscriptionId' });
  });

  it('refuses an event task that names a subscription which does not exist', async () => {
    const err = await apiErrorFrom(() =>
      harness.taskService.create(CONTROL_TENANT, {
        title: 'On webhook',
        triggerType: 'event',
        eventSubscriptionId: 'evs_missing',
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'eventSubscriptionId' });
  });

  it('rejects a scheduled task with no time at the schema boundary', async () => {
    // The schema and the service both refuse this, and that redundancy is deliberate: the
    // schema guards the HTTP boundary, the service guards every other caller.
    const parsed = createTaskSchema.safeParse({ title: 'Later', triggerType: 'scheduled' });

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]!.path).toEqual(['scheduledAt']);
  });
});

describe('references', () => {
  it('refuses a task that names an agent which does not exist', async () => {
    const err = await apiErrorFrom(() =>
      harness.taskService.create(CONTROL_TENANT, {
        title: 'Orphan',
        triggerType: 'immediate',
        agentId: 'agt_missing',
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ agentId: 'agt_missing' });
    expect(harness.enqueued).toHaveLength(0);
  });

  it('refuses a task that names another tenant’s goal', async () => {
    const foreign = await harness.goalService.create(OTHER_TENANT, { title: 'Theirs' });

    const err = await apiErrorFrom(() =>
      harness.taskService.create(CONTROL_TENANT, {
        title: 'Cross-tenant',
        triggerType: 'immediate',
        goalId: foreign.id,
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('derives the run kind from the task’s provenance', async () => {
    const goal = await harness.goalService.create(CONTROL_TENANT, { title: 'A goal' });
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Goal work',
      triggerType: 'immediate',
      goalId: goal.id,
      ...RUNNABLE,
    });

    const run = await harness.runs.findById(CONTROL_TENANT, harness.enqueued[0]!.runId);
    expect(run!.goalId).toBe(goal.id);
    expect(run!.kind).toBe('task');
    expect(await runsFor(task.id)).toBe(1);
  });
});

describe('cancelling a task', () => {
  it('cancels a running task', async () => {
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Long job',
      triggerType: 'immediate',
      ...RUNNABLE,
    });

    const cancelled = await harness.taskService.cancel(CONTROL_TENANT, task.id);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.completedAt).not.toBeNull();
  });

  it('cancels a queued task that has not started', async () => {
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Later',
      triggerType: 'scheduled',
      scheduledAt: new Date(Date.now() + 60_000),
    });

    expect((await harness.taskService.cancel(CONTROL_TENANT, task.id)).status).toBe('cancelled');
  });

  it('refuses to cancel a task that already finished', async () => {
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Done',
      triggerType: 'immediate',
      ...RUNNABLE,
    });
    await harness.tasks.setStatus(CONTROL_TENANT, task.id, 'completed');

    const err = await apiErrorFrom(() => harness.taskService.cancel(CONTROL_TENANT, task.id));

    expect(err.code).toBe('CONFLICT');
  });

  it('does not cancel the run the task started', async () => {
    // A task and its run have separate lifecycles. Cancelling the task stops it being
    // scheduled again; a caller who wants the run stopped cancels the run.
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'Long job',
      triggerType: 'immediate',
      ...RUNNABLE,
    });

    await harness.taskService.cancel(CONTROL_TENANT, task.id);

    const run = await harness.runs.findById(CONTROL_TENANT, harness.enqueued[0]!.runId);
    expect(run!.status).not.toBe('cancelled');
  });
});

describe('reading tasks', () => {
  it('lists the task’s runs', async () => {
    const task = await harness.taskService.create(CONTROL_TENANT, {
      title: 'One',
      triggerType: 'immediate',
      ...RUNNABLE,
    });

    const detail = await harness.taskService.get(CONTROL_TENANT, task.id);

    expect(detail.runIds).toHaveLength(1);
    // The id points at a run that is really there, not at a row that was rolled back.
    expect(await harness.runs.findById(CONTROL_TENANT, detail.runIds[0]!)).not.toBeNull();
  });

  it('does not expose another tenant’s task', async () => {
    const foreign = await harness.taskService.create(OTHER_TENANT, {
      title: 'Theirs',
      triggerType: 'manual',
      ...RUNNABLE,
    });

    const err = await apiErrorFrom(() => harness.taskService.get(CONTROL_TENANT, foreign.id));
    expect(err.code).toBe('NOT_FOUND');
  });
});
