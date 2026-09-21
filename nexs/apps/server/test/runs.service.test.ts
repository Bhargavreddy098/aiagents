import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, listRunsSchema } from '@nexs/shared';
import type { RunStatus } from '@nexs/shared';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';

/**
 * Steering a run: cancel, pause, resume — and whether an operator can *see* it happen.
 *
 * The Phase 6 acceptance criterion is "cancel/pause/resume on a running run works and is
 * visible in SSE". Both halves are load-bearing, and the second is the one that is easy to
 * get wrong: a status change that is only in the database leaves the UI showing a run that
 * appears to still be working.
 *
 * ## Two facts, two frames
 *
 * `RunService` emits on the *request*; the engine emits when it *observes* the stop. Those
 * are different moments and both are real. A run cancelled while still `queued` is never
 * executed at all, so the engine never emits anything — if the service did not emit, the
 * operator's action would be completely invisible. That case has its own test below,
 * because it is exactly the case a "just let the engine emit" design fails.
 */

let harness: ControlHarness;

beforeEach(async () => {
  harness = await createControlHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

async function runIn(status: RunStatus): Promise<string> {
  const run = await harness.runs.create({ tenantId: CONTROL_TENANT, kind: 'task' });
  if (status !== 'queued') {
    await harness.runs.setStatus(CONTROL_TENANT, run.id, status);
  }
  return run.id;
}

async function apiErrorFrom(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the call to throw an ApiError, but it resolved');
}

/** The names of the frames emitted so far, in order. */
function frameNames(): string[] {
  return harness.frames.map((frame) => frame.name);
}

describe('cancel', () => {
  it('moves a running run to cancelled and emits run.cancelled', async () => {
    const runId = await runIn('running');

    const detail = await harness.runService.cancel(CONTROL_TENANT, runId);

    expect(detail.status).toBe('cancelled');
    expect(frameNames()).toContain('run.cancelled');
    expect(
      harness.frames.find((frame) => frame.name === 'run.cancelled')!.payload,
    ).toMatchObject({ runId });
  });

  it('emits for a run cancelled while still queued — which the engine never sees', async () => {
    // A queued run has no worker, so the engine's own "I observed the stop" frame can
    // never arrive. Without the service's frame the operator would see nothing at all.
    const runId = await runIn('queued');

    await harness.runService.cancel(CONTROL_TENANT, runId);

    expect(frameNames()).toEqual(['run.cancelled']);
  });

  it('refuses to cancel a run that already finished', async () => {
    const runId = await runIn('completed');

    const err = await apiErrorFrom(() => harness.runService.cancel(CONTROL_TENANT, runId));

    expect(err.code).toBe('CONFLICT');
    expect(err.details).toMatchObject({ status: 'completed' });
    expect(harness.frames).toHaveLength(0);
  });

  it('refuses to cancel a run that is already cancelled', async () => {
    const runId = await runIn('running');
    await harness.runService.cancel(CONTROL_TENANT, runId);

    const err = await apiErrorFrom(() => harness.runService.cancel(CONTROL_TENANT, runId));

    expect(err.code).toBe('CONFLICT');
  });
});

describe('pause and resume', () => {
  it('pauses a running run and emits run.paused', async () => {
    const runId = await runIn('running');

    const detail = await harness.runService.pause(CONTROL_TENANT, runId);

    expect(detail.status).toBe('paused');
    expect(frameNames()).toEqual(['run.paused']);
  });

  it('resumes a paused run, moves it back to running, and re-queues it', async () => {
    const runId = await runIn('running');
    await harness.runService.pause(CONTROL_TENANT, runId);
    expect(harness.enqueued).toHaveLength(0);

    const detail = await harness.runService.resume(CONTROL_TENANT, runId);

    expect(detail.status).toBe('running');
    expect(frameNames()).toEqual(['run.paused', 'run.resumed']);

    // A paused run has no worker — the loop that would have continued it already returned.
    // Without the re-queue the run would sit `running` forever with nothing executing it.
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]).toMatchObject({ runId, tenantId: CONTROL_TENANT, kind: 'task' });
  });

  it('refuses to pause a terminal run', async () => {
    const runId = await runIn('failed');

    const err = await apiErrorFrom(() => harness.runService.pause(CONTROL_TENANT, runId));

    expect(err.code).toBe('CONFLICT');
    expect(harness.frames).toHaveLength(0);
  });

  it('refuses to resume a run that was never paused', async () => {
    const runId = await runIn('running');

    const err = await apiErrorFrom(() => harness.runService.resume(CONTROL_TENANT, runId));

    expect(err.code).toBe('CONFLICT');
    expect(harness.enqueued).toHaveLength(0);
  });

  it('does not emit or re-queue when the run moved between the read and the write', async () => {
    const runId = await runIn('running');

    // Simulate the engine finishing the run in the window between the service's read and
    // its write. The write then matches no rows and the caller must be told what happened.
    const original = harness.runs.setStatus.bind(harness.runs);
    harness.runs.setStatus = async () => 0;

    const err = await apiErrorFrom(() => harness.runService.pause(CONTROL_TENANT, runId));
    expect(err.code).toBe('CONFLICT');
    expect(err.details).toMatchObject({ status: 'running' });
    expect(harness.frames).toHaveLength(0);

    harness.runs.setStatus = original;
  });
});

describe('reading runs', () => {
  it('returns a page and a total drawn from the same filters', async () => {
    const first = await harness.runs.create({ tenantId: CONTROL_TENANT, kind: 'task' });
    const second = await harness.runs.create({ tenantId: CONTROL_TENANT, kind: 'task' });
    await harness.runs.create({ tenantId: CONTROL_TENANT, kind: 'task' });

    await harness.runs.setStatus(CONTROL_TENANT, first.id, 'completed');
    await harness.runs.setStatus(CONTROL_TENANT, second.id, 'completed');

    const page = await harness.runService.list(CONTROL_TENANT, { status: 'completed', limit: 1 });

    expect(page.runs).toHaveLength(1);
    // The total is the number of *matching* runs, not the number returned — which is the
    // whole reason `list` and `count` share one `where` builder.
    expect(page.total).toBe(2);
  });

  it('refuses a filter that is not in the contract instead of silently ignoring it', async () => {
    // The spec fixes the run filters as "status, agent, goal, task, workflow, date", and
    // the schema is `.strict()`. That matters more than it looks: a filter that is accepted
    // and dropped makes a client believe it is looking at a subset when it is looking at
    // everything — and `kind` is the tempting one to assume, since `Run.kind` exists and
    // the repository supports it.
    const parsed = listRunsSchema.safeParse({ kind: 'workflow' });

    expect(parsed.success).toBe(false);
    expect(listRunsSchema.safeParse({ workflowId: 'wf_1' }).success).toBe(true);
  });

  it('does not count another tenant’s runs', async () => {
    await harness.runs.create({ tenantId: OTHER_TENANT, kind: 'task' });
    await harness.runs.create({ tenantId: CONTROL_TENANT, kind: 'task' });

    const page = await harness.runService.list(CONTROL_TENANT, {});

    expect(page.total).toBe(1);
  });

  it('composes the detail from real rows after a run has executed', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });
    const run = await harness.runs.create({
      tenantId: CONTROL_TENANT,
      kind: 'task',
      input: {
        context: {
          modelId: 'mdl_test',
          instructions: 'Do the arithmetic.',
          allowedToolIds: [tool.id],
        },
      },
    });

    harness.gateway.reply(
      JSON.stringify([
        {
          id: 'calc',
          description: 'add',
          stepType: 'tool',
          toolId: tool.id,
          config: { expression: '1 + 1' },
        },
      ]),
    );
    const outcome = await harness.engine.executeRun(CONTROL_TENANT, run.id);
    expect(outcome.status).toBe('completed');

    const detail = await harness.runService.get(CONTROL_TENANT, run.id);

    expect(detail.steps.length).toBeGreaterThan(0);
    expect(detail.toolCalls.length).toBeGreaterThan(0);
    expect(detail.receipts.length).toBeGreaterThan(0);
    // The tool's *name* is joined in, because `ToolCall` has no name column of its own and
    // a UI showing a bare id would be showing the operator nothing useful.
    expect(detail.toolCalls[0]!.toolName).toBe('calculator');
    expect(detail.plan).not.toBeNull();
  });

  it('does not expose another tenant’s run', async () => {
    const run = await harness.runs.create({ tenantId: OTHER_TENANT, kind: 'task' });

    const err = await apiErrorFrom(() => harness.runService.get(CONTROL_TENANT, run.id));

    expect(err.code).toBe('NOT_FOUND');
  });

  it('reports a 404 rather than an empty detail for a run that does not exist', async () => {
    const err = await apiErrorFrom(() => harness.runService.get(CONTROL_TENANT, 'run_missing'));
    expect(err.code).toBe('NOT_FOUND');
  });
});
