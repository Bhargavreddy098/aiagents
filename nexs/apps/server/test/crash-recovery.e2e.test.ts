import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanStep } from '@nexs/shared';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';
import { planJson, TEST_MODEL } from './helpers/engine-harness.js';

/**
 * Crash recovery, end to end: the sweep and the worker, joined.
 *
 * ## The gap this file closes
 *
 * Crash recovery has two halves, and each already had its own suite:
 *
 *   - `engine.execution.test.ts` proves the *contract*: a step that already committed is
 *     replayed from its row, an interrupted side-effecting call is never repeated, a
 *     read-only one is re-run.
 *   - `recovery.service.test.ts` proves the *sweep*: `listStale` finds runs whose heartbeat
 *     stopped, parked and queued runs are excluded, and each orphan is handed back.
 *
 * Neither ever crossed the boundary between them. The sweep's output is a `RunQueueJob`; the
 * engine's input is `(tenantId, runId)`. Nothing asserted that the job the sweep produces is
 * *sufficient* to resume the run it names. A job carrying the wrong tenant, or a run the
 * engine declines to claim, would leave both suites green and the run `running` forever —
 * the same class of gap as the chat router whose paths were all double-prefixed while 1469
 * tests passed.
 *
 * So every test here takes the job from `harness.enqueued` and passes its fields to the
 * engine. Reconstructing the job from the test's own knowledge of the run would assert that
 * the engine can execute a run, which is not in doubt, instead of that the sweep hands over
 * something executable, which is.
 *
 * ## How a crash is staged
 *
 * A real SIGKILL cannot be staged in-process: the database is in the heap, so a child
 * process would start from an empty one. What is staged instead is the on-disk state each
 * crash window leaves — and the state is *derived from a real execution* rather than written
 * by hand. The run is executed; the only thing held back is the second step. A checkpoint
 * written by this file would be a second opinion about the engine's checkpoint format, and
 * would agree with the engine right up until the format changed.
 *
 * Two windows are covered, because the engine treats them differently:
 *
 *   1. the worker died after the first step committed → its row says `completed`
 *   2. the worker died while the second step was in flight → its row says `running` and its
 *      tool call is `requested`, with no receipt
 */

const STALE_MS = 30 * 60 * 1000;

/** The vendor stub's reply. The body is never read by these tests — only the URL matters. */
const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

let harness: ControlHarness;

beforeEach(async () => {
  harness = await createControlHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/**
 * The two steps, as the planner would emit them.
 *
 * Both name the same tool. That is not a shortcut: for a **native** tool the invoker derives
 * capabilities from the arguments rather than reading the row (`ToolInvoker.capabilitiesFor`),
 * so the POST is side-effecting and the GET is read-only *because of its method*. One tool row
 * that behaves both ways is the honest fixture for a plan that does both — and it means the
 * policy under test comes from the engine's own derivation rather than from a declaration this
 * file could get wrong.
 */
function stepsFor(toolId: string): { send: PlanStep; fetch: PlanStep } {
  return {
    send: {
      id: 'send',
      description: 'Send the payload',
      stepType: 'tool',
      toolId,
      config: { url: 'https://api.test/send', method: 'POST' },
    },
    fetch: {
      id: 'fetch',
      description: 'Fetch the receipt',
      stepType: 'tool',
      toolId,
      config: { url: 'https://api.test/receipt', method: 'GET' },
    },
  };
}

/** The paths the native `http_request` handler actually reached, in order. */
function pathsReached(): string[] {
  return harness.httpCalls.map((call) => new URL(call.url).pathname);
}

interface CrashFixture {
  runId: string;
  step: PlanStep;
}

/**
 * A run that got through its first step and then lost its worker.
 *
 * The first pass plans and executes **one** step, and is allowed to complete. Letting it
 * finish is what produces a genuine post-step checkpoint — the engine's own `recordCompletion`
 * output rather than a copy of it — and a genuine `completed` step row with a receipt behind
 * it. The second step is then added to the stored plan, which is the state the run was always
 * going to be in: a plan is written once, before the first step runs, and the checkpoint
 * accumulates as steps commit. Nothing about this is fabricated except the heartbeat, which is
 * the crash.
 */
async function crashedRun(options: { secondStepInFlight?: boolean } = {}): Promise<CrashFixture> {
  const tool = await harness.seedTool({ name: 'http_request', capabilities: ['http', 'read_only'] });
  const { send, fetch } = stepsFor(tool.id);

  harness.gateway.reply(planJson([send]));
  harness.onHttp(() => json({ accepted: true }));

  const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
  const first = await harness.run(run.id);
  if (first.status !== 'completed') {
    throw new Error(`fixture: the first pass did not complete (${first.status})`);
  }

  const stored = await harness.runs.findById(CONTROL_TENANT, run.id);
  const checkpoint = stored?.checkpoint as { completedSteps?: Record<string, unknown> } | null;
  if (checkpoint?.completedSteps?.[send.id] === undefined) {
    // Fail loudly rather than proceeding on a checkpoint that does not say what the rest of
    // the test assumes. A fixture that silently drops a cross-reference produces a state that
    // looks like a crash and is not.
    throw new Error('fixture: the first step left no completion in the checkpoint');
  }

  // The plan the run was built against, now with its second step.
  await harness.runs.savePlan(CONTROL_TENANT, run.id, [send, fetch]);

  // The crash: the row is still `running`, but nothing is working on it. `durationMs` and
  // `completedAt` belong to the completion that the crash undid, and leaving them set would
  // describe a finished run with a stale heartbeat.
  await harness.db.run.update({
    where: { id: run.id },
    data: {
      status: 'running',
      completedAt: null,
      durationMs: null,
      lastHeartbeatAt: new Date(Date.now() - STALE_MS),
    },
  });

  if (options.secondStepInFlight === true) {
    // Window 2: the worker died mid-call. The engine's own ordering leaves exactly this —
    // `steps.ensure`, `markRunning`, then a `requested` tool call written *before* the call —
    // and the receipt, which is written after it, is the one row that never arrived.
    const step = await harness.steps.ensure({
      runId: run.id,
      seq: 1,
      position: 1,
      name: fetch.id,
      description: fetch.description,
      stepType: fetch.stepType,
      toolId: tool.id,
      input: fetch.config,
    });
    await harness.steps.markRunning(run.id, step.id);
    await harness.toolCalls.record({
      tenantId: CONTROL_TENANT,
      runId: run.id,
      stepId: step.id,
      toolId: tool.id,
      args: fetch.config,
      sideEffect: false,
    });
  }

  return { runId: run.id, step: fetch };
}

describe('crash recovery: the sweep and the worker, joined', () => {
  it('resumes a run the sweep recovered without repeating the step that already committed', async () => {
    const { runId } = await crashedRun();

    const scan = await harness.recoveryService.scan();
    expect(scan).toEqual({ scanned: 1, reEnqueued: 1, failed: 0 });
    expect(harness.enqueued).toHaveLength(1);

    // The job as the sweep produced it — not as this test would have written it.
    const job = harness.enqueued[0]!;
    const outcome = await harness.engine.executeRun(job.tenantId, job.runId);

    expect(outcome.status).toBe('completed');

    // The whole point, in one assertion. The POST is the effect that already happened; the
    // GET is the step that had not run. A resume that re-executed the first step would reach
    // `/send` twice, and one that skipped the second would never reach `/receipt` at all.
    expect(pathsReached()).toEqual(['/send', '/receipt']);

    // Read back through the repository rather than trusting the outcome: the outcome is what
    // the engine says it did, and the row is what it did.
    const stored = await harness.runs.findById(CONTROL_TENANT, runId);
    expect(stored?.status).toBe('completed');
    expect(stored?.completedAt).not.toBeNull();

    const steps = await harness.steps.findByRunId(runId);
    expect(steps.map((step) => [step.seq, step.status])).toEqual([
      [0, 'completed'],
      [1, 'completed'],
    ]);
  });

  it('does not re-plan a resumed run', async () => {
    // A resumed run executes the plan it was built against. Re-planning would be worse than
    // wasteful: the first step has already happened, so a second plan is a plan whose step 0
    // is already in the past — and the model that produced it never saw the first result.
    const { runId } = await crashedRun();
    expect(harness.gateway.callCount).toBe(1);

    await harness.recoveryService.scan();
    const job = harness.enqueued[0]!;
    await harness.engine.executeRun(job.tenantId, job.runId);

    expect(harness.gateway.callCount).toBe(1);
    const stored = await harness.runs.findById(CONTROL_TENANT, runId);
    expect(stored?.plan).toHaveLength(2);
  });

  it('re-runs the step that was in flight when the worker died', async () => {
    // Window 2. The engine's answer differs from window 1 on purpose: a step whose call was
    // requested and never recorded has an *unknown* outcome. Repeating it is safe only because
    // the tool is read-only, and the engine establishes that from the tool rather than from the
    // absence of evidence.
    const { runId, step } = await crashedRun({ secondStepInFlight: true });

    await harness.recoveryService.scan();
    const job = harness.enqueued[0]!;
    const outcome = await harness.engine.executeRun(job.tenantId, job.runId);

    expect(outcome.status).toBe('completed');
    // One call each. The interrupted attempt never reached the wire — a crash during the call
    // leaves the `requested` row and no request — so the re-run is the *only* GET. What
    // distinguishes this window from the one above is not the count but what is left behind:
    // see the tool-call assertion below.
    expect(pathsReached()).toEqual(['/send', '/receipt']);

    const stored = await harness.runs.findById(CONTROL_TENANT, runId);
    expect(stored?.status).toBe('completed');

    // Two tool-call rows for the one step, and both are honest: the abandoned `requested` row
    // is the record of a call whose outcome was never written down, and the `executed` row is
    // the attempt that replaced it. Collapsing them would erase the ambiguity that made the
    // engine re-run the step in the first place.
    const rows = await harness.steps.findByRunId(runId);
    const second = rows.find((row) => row.name === step.id);
    expect(second?.status).toBe('completed');
    const calls = await harness.toolCalls.findByStep(second!.id);
    expect(calls.map((call) => call.status).sort()).toEqual(['executed', 'requested']);
  });

  it('carries the tenant the run belongs to, so the consumer can execute it', async () => {
    // A handoff without the tenant, or with the wrong one, is a job the consumer cannot act
    // on. This is the property that makes the job *sufficient*: the sweep reads across tenants
    // (there is no request to derive one from), so the tenant has to travel in the job.
    //
    // The run is built by hand rather than through `seedRun` because it belongs to another
    // tenant and `seedRun` is fixed to this harness's own. Two details are load-bearing:
    //
    //   - it carries a context, because a run with no agent reads its configuration from
    //     `Run.input` — and a run that names no model is one the engine fails rather than
    //     guesses at.
    //   - the context carries a **preset plan**, because a run granted no tools and given no
    //     plan is refused with `EmptyPlanError`: "the agent had nothing to plan with" is a
    //     configuration to fix, not a run that succeeded at doing nothing. A `transform` step
    //     needs no tool, so this is a run the consumer can actually finish.
    const other = await harness.runs.create({
      tenantId: OTHER_TENANT,
      kind: 'task',
      input: {
        context: {
          modelId: TEST_MODEL,
          instructions: 'Other tenant.',
          presetPlan: [
            {
              id: 'noop',
              description: 'Reshape nothing',
              stepType: 'transform',
              config: { operation: 'template', template: 'ok' },
            },
          ],
        },
      },
    });
    const claimed = await harness.runs.claim(OTHER_TENANT, other.id, ['queued'], 'running');
    if (claimed === null) throw new Error('fixture: could not claim the other tenant’s run');
    await harness.db.run.update({
      where: { id: other.id },
      data: { lastHeartbeatAt: new Date(Date.now() - STALE_MS) },
    });

    const scan = await harness.recoveryService.scan();
    expect(scan.reEnqueued).toBe(1);

    const job = harness.enqueued[0]!;
    expect(job.tenantId).toBe(OTHER_TENANT);

    // And the consumer can act on it: the run executes its preset plan and completes. A job
    // carrying `CONTROL_TENANT` here would have thrown instead — which is asserted below
    // rather than assumed.
    const outcome = await harness.engine.executeRun(job.tenantId, job.runId);
    expect(outcome.status).toBe('completed');
    expect((await harness.runs.findById(OTHER_TENANT, other.id))?.status).toBe('completed');

    await expect(harness.engine.executeRun(CONTROL_TENANT, job.runId)).rejects.toThrow(
      /does not exist/,
    );
  });

  it('does nothing when the same job is delivered twice', async () => {
    // At-least-once delivery: the sweep does not mark the run it hands back, so a redelivery is
    // a normal event rather than a fault. A finished run is not claimable, and the outcome says
    // so rather than reporting a cancellation it did not perform.
    const { runId } = await crashedRun();

    await harness.recoveryService.scan();
    const job = harness.enqueued[0]!;
    await harness.engine.executeRun(job.tenantId, job.runId);
    const reached = pathsReached();

    const second = await harness.engine.executeRun(job.tenantId, job.runId);

    expect(second.status).toBe('not_claimed');
    expect(pathsReached()).toEqual(reached);
    expect((await harness.runs.findById(CONTROL_TENANT, runId))?.status).toBe('completed');
    expect(await harness.steps.findByRunId(runId)).toHaveLength(2);
  });
});
