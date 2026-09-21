import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanStep } from '@nexs/shared';
import {
  createEngineHarness,
  TEST_TENANT,
  type EngineHarness,
} from './helpers/engine-harness.js';

let harness: EngineHarness;

beforeEach(async () => {
  harness = await createEngineHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

const html = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init });

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: 's1',
  description: 'do the thing',
  stepType: 'transform',
  config: { operation: 'template', template: 'ok' },
  ...overrides,
});

/** Seed the http tool and script a plan that uses it. */
async function withHttpTool(plan: PlanStep[]) {
  const tool = await harness.seedTool({
    name: 'http_request',
    description: 'Make an HTTP request',
    capabilities: ['http', 'read_only'],
  });
  harness.gateway.reply(JSON.stringify(plan));
  return tool;
}

// ── the loop ──────────────────────────────────────────────────────────────────

describe('the engine loop', () => {
  it('plans, executes and completes a run', async () => {
    const tool = await withHttpTool([
      step({
        id: 'fetch',
        description: 'GET the page',
        stepType: 'tool',
        toolId: 'placeholder',
        config: { url: 'https://example.com/' },
      }),
    ]);
    // The plan named a placeholder id; re-script with the real one.
    harness.gateway.requests.length = 0;
    harness.gateway.reply(
      JSON.stringify([
        { id: 'fetch', description: 'GET the page', stepType: 'tool', toolId: tool.id, config: { url: 'https://example.com/' } },
      ]),
    );

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    harness.onHttp(() => html('<html><body>Example Domain</body></html>'));

    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('completed');
    expect(harness.httpCalls).toHaveLength(1);

    const stored = await harness.runs.findById(TEST_TENANT, run.id);
    expect(stored?.status).toBe('completed');
    expect(stored?.plan).toHaveLength(1);
    expect(stored?.completedAt).toBeInstanceOf(Date);
  });

  it('persists a real ToolCall and a real ExecutionReceipt', async () => {
    const tool = await harness.seedTool({ name: 'http_request', capabilities: ['http', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'fetch', description: 'GET', stepType: 'tool', toolId: tool.id, config: { url: 'https://example.com/' } },
      ]),
    );
    harness.onHttp(() => html('hello'));

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    await harness.run(run.id);

    const steps = await harness.steps.findByRunId(run.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('completed');

    const calls = await harness.toolCalls.findByStep(steps[0]!.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('executed');
    expect(calls[0]!.sideEffect).toBe(false);
    expect(calls[0]!.durationMs).toBeTypeOf('number');

    const receipt = await harness.receipts.findForStep(steps[0]!.id);
    expect(receipt).not.toBeNull();
    // The receipt cites the exact step attempt that produced it.
    expect(receipt?.idempotencyKey).toBe(`${run.id}:0:0`);
    expect(receipt?.effect).toMatchObject({ toolName: 'http_request', ok: true });
  });

  it('emits the lifecycle frames in order', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'calc', description: 'add', stepType: 'tool', toolId: tool.id, config: { expression: '1 + 1' } },
      ]),
    );

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    await harness.run(run.id);

    const names = harness.frames.map((frame) => frame.name);
    expect(names).toEqual([
      'run.plan_ready',
      'run.started',
      'step.started',
      'tool.started',
      'tool.completed',
      'step.completed',
      'run.completed',
    ]);
  });

  it('runs multiple steps in plan order and records each in the checkpoint', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'first', description: 'one', stepType: 'tool', toolId: tool.id, config: { expression: '1 + 1' } },
        { id: 'second', description: 'two', stepType: 'tool', toolId: tool.id, config: { expression: '2 + 2' } },
      ]),
    );

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('completed');
    const stored = await harness.runs.findById(TEST_TENANT, run.id);
    const checkpoint = stored?.checkpoint as { completedSteps: Record<string, unknown>; toolCallCount: number };
    expect(Object.keys(checkpoint.completedSteps)).toEqual(['first', 'second']);
    expect(checkpoint.toolCallCount).toBe(2);
  });

  it('stops the run when a verification step fails', async () => {
    const tool = await harness.seedTool({ name: 'http_request', capabilities: ['http', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'fetch', description: 'GET', stepType: 'tool', toolId: tool.id, config: { url: 'https://example.com/' } },
        {
          id: 'check',
          description: 'expect 200',
          stepType: 'verification',
          config: { type: 'http_response', config: { expectedStatus: 200 } },
          dependsOn: ['fetch'],
        },
      ]),
    );
    harness.onHttp(() => html('gone', { status: 500 }));

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error.code).toBe('STEP_FAILED');

    const stored = await harness.runs.findById(TEST_TENANT, run.id);
    expect(stored?.status).toBe('failed');
  });

  it('only completes a run whose goal criteria passed', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });

    // A run with no plan steps at all but a criterion that cannot pass: the criteria are
    // the last gate, and they are the only thing that may complete a goal.
    harness.gateway.reply(
      JSON.stringify([
        { id: 'calc', description: 'add', stepType: 'tool', toolId: tool.id, config: { expression: '1 + 1' } },
      ]),
    );

    const run = await harness.seedRun({
      context: {
        allowedToolIds: [tool.id],
        successCriteria: [
          { type: 'file_exists', config: { path: 'never-written.txt' }, description: 'a file exists' },
        ],
      },
    });

    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('failed');
    const stored = await harness.runs.findById(TEST_TENANT, run.id);
    expect(stored?.status).toBe('failed');

    const verifications = await harness.verifications.findByRunId(TEST_TENANT, run.id);
    expect(verifications).toHaveLength(1);
    expect(verifications[0]!.scope).toBe('goal_criteria');
    expect(verifications[0]!.passed).toBe(false);
  });

  it('completes a run whose goal criteria passed', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'calc', description: 'add', stepType: 'tool', toolId: tool.id, config: { expression: '1 + 1' } },
      ]),
    );

    const run = await harness.seedRun({
      context: {
        allowedToolIds: [tool.id],
        successCriteria: [
          { type: 'content', config: { source: 'output', contains: ['"result":2'] }, description: 'it added' },
        ],
      },
    });

    const outcome = await harness.run(run.id);
    expect(outcome.status).toBe('completed');
  });
});

// ── the acceptance test ───────────────────────────────────────────────────────

describe('acceptance: GET example.com, verify status 200', () => {
  async function acceptancePlan() {
    const tool = await harness.seedTool({
      name: 'http_request',
      description: 'Make an HTTP request',
      capabilities: ['http', 'read_only'],
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' }, method: { type: 'string' } },
        required: ['url'],
      },
    });

    harness.gateway.reply(
      JSON.stringify([
        {
          id: 'fetch',
          description: 'Fetch example.com',
          stepType: 'tool',
          toolId: tool.id,
          config: { url: 'https://example.com/', method: 'GET' },
        },
        {
          id: 'verify-status',
          description: 'Verify the response status is 200',
          stepType: 'verification',
          config: { type: 'http_response', config: { expectedStatus: 200, bodyContains: ['Example Domain'] } },
          dependsOn: ['fetch'],
        },
      ]),
    );

    return tool;
  }

  it('produces real step states, a real tool call, a passing verification and a receipt', async () => {
    const tool = await acceptancePlan();
    harness.onHttp(() => html('<html><head><title>Example Domain</title></head><body>Example Domain</body></html>'));

    const run = await harness.seedRun({
      context: { allowedToolIds: [tool.id], instructions: 'Fetch and verify.' },
    });

    const outcome = await harness.run(run.id);

    // 1. the run completed
    expect(outcome.status).toBe('completed');

    // 2. the steps are real rows with real states
    const steps = await harness.steps.findByRunId(run.id);
    expect(steps.map((row) => row.status)).toEqual(['completed', 'completed']);
    expect(steps.map((row) => row.stepType)).toEqual(['tool', 'verification']);

    // 3. the tool call really happened, over the wire
    expect(harness.httpCalls).toHaveLength(1);
    expect(harness.httpCalls[0]!.url).toBe('https://example.com/');
    expect(harness.httpCalls[0]!.method).toBe('GET');

    const calls = await harness.toolCalls.findByStep(steps[0]!.id);
    expect(calls[0]!.status).toBe('executed');
    expect((calls[0]!.result as { content: string }).content).toContain('"status":200');

    // 4. the verification passed and kept its evidence
    const verifications = await harness.verifications.findByRunId(TEST_TENANT, run.id);
    expect(verifications).toHaveLength(1);
    expect(verifications[0]!.type).toBe('http_response');
    expect(verifications[0]!.passed).toBe(true);
    expect((verifications[0]!.evidence as { actualStatus: number }).actualStatus).toBe(200);

    // 5. the receipt was written before the step committed
    const receipt = await harness.receipts.findForStep(steps[0]!.id);
    expect(receipt).not.toBeNull();
    expect(receipt?.idempotencyKey).toBe(`${run.id}:0:0`);
  });

  it('fails the run when the status is not 200, with the observed status in evidence', async () => {
    const tool = await acceptancePlan();
    harness.onHttp(() => html('Service Unavailable', { status: 503 }));

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('failed');
    const verifications = await harness.verifications.findByRunId(TEST_TENANT, run.id);
    expect(verifications[0]!.passed).toBe(false);
    expect(verifications[0]!.evidence).toMatchObject({ expectedStatus: 200, actualStatus: 503 });
  });
});

// ── crash recovery ────────────────────────────────────────────────────────────

describe('crash recovery: side effects fire exactly once', () => {
  /**
   * A real SIGKILL cannot be staged in-process — the fake database lives in the heap, so a
   * child process would start from an empty one. What *can* be done, and is what these
   * tests do, is construct the exact on-disk state each crash window leaves behind and
   * then hand that state to a fresh engine. The three windows are:
   *
   *   1. after the effect, before the receipt        → the effect is in doubt; never re-run
   *   2. after the receipt, before the step commits  → the effect is known; adopt it
   *   3. after the step commits                      → an ordinary replay; skip the step
   *
   * Window 3 is covered by the idempotency tests below; windows 1 and 2 are here.
   */

  async function seedRunWithOneToolStep(sideEffect: boolean) {
    const tool = await harness.seedTool({
      name: 'http_request',
      capabilities: sideEffect ? ['http', 'external_side_effect'] : ['http', 'read_only'],
    });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'send', description: 'Send it', stepType: 'tool', toolId: tool.id, config: { url: 'https://api.test/send', method: 'POST' } },
      ]),
    );
    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    return { tool, run };
  }

  it('window 2 — adopts a recorded effect instead of repeating the call', async () => {
    const { run } = await seedRunWithOneToolStep(true);
    harness.onHttp(() => html('{"accepted":true}'));

    // First execution: let it run, then rewind the step and the checkpoint to the state a
    // kill between the receipt write and the step commit would leave.
    await harness.run(run.id);

    const steps = await harness.steps.findByRunId(run.id);
    const stepRow = steps[0]!;
    const receipt = await harness.receipts.findForStep(stepRow.id);
    expect(receipt).not.toBeNull();

    // Rewind: the step never committed, and the checkpoint never advanced.
    harness.fake.tables['step']!.find((row) => row['id'] === stepRow.id)!['status'] = 'running';
    harness.fake.tables['run']!.find((row) => row['id'] === run.id)!['status'] = 'running';
    harness.fake.tables['run']!.find((row) => row['id'] === run.id)!['checkpoint'] = {
      nextIndex: 0,
      completedSteps: {},
      outputs: {},
      toolCallCount: 0,
      startedAt: new Date().toISOString(),
      planned: true,
    };

    const callsBefore = harness.httpCalls.length;

    // A fresh engine over the same database — the restart.
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('completed');
    // The whole point: the effect was not repeated.
    expect(harness.httpCalls.length).toBe(callsBefore);

    const after = await harness.steps.findByRunId(run.id);
    expect(after[0]!.status).toBe('completed');
    expect(after[0]!.output).toMatchObject({ toolName: 'http_request' });
  });

  it('window 1 — refuses to re-run a side-effecting call whose outcome is unknown', async () => {
    const { run } = await seedRunWithOneToolStep(true);
    harness.onHttp(() => html('{"accepted":true}'));

    await harness.run(run.id);
    const steps = await harness.steps.findByRunId(run.id);
    const stepRow = steps[0]!;

    // Rewind further: the receipt is gone too, so all that is left is a `requested` call
    // on a side-effecting tool. This is the genuinely ambiguous state.
    harness.fake.tables['executionReceipt']!.length = 0;
    harness.fake.tables['toolCall']!.find((row) => row['stepId'] === stepRow.id)!['status'] = 'requested';
    harness.fake.tables['step']!.find((row) => row['id'] === stepRow.id)!['status'] = 'running';
    harness.fake.tables['run']!.find((row) => row['id'] === run.id)!['status'] = 'running';
    harness.fake.tables['run']!.find((row) => row['id'] === run.id)!['checkpoint'] = {
      nextIndex: 0,
      completedSteps: {},
      outputs: {},
      toolCallCount: 0,
      startedAt: new Date().toISOString(),
      planned: true,
    };

    const callsBefore = harness.httpCalls.length;
    const outcome = await harness.run(run.id);

    // The engine stops rather than guesses. A failed run an operator can inspect is
    // strictly better than a second POST.
    expect(outcome.status).toBe('failed');
    expect(harness.httpCalls.length).toBe(callsBefore);
    if (outcome.status === 'failed') {
      expect(outcome.error.message).toMatch(/may or may not have been applied/);
    }
  });

  it('window 3 — a completed step is a no-op on replay', async () => {
    const { run } = await seedRunWithOneToolStep(true);
    harness.onHttp(() => html('{"accepted":true}'));

    await harness.run(run.id);
    const callsAfterFirst = harness.httpCalls.length;

    // Re-deliver the same run, as at-least-once delivery will.
    const outcome = await harness.run(run.id);

    // `not_claimed` rather than `cancelled`: the run is finished, not cancelled, and the
    // outcome describes the delivery. The assertion's point is the line below it — a terminal
    // run is not re-executed — and the status is what makes that legible.
    expect(outcome.status).toBe('not_claimed');
    expect(harness.httpCalls.length).toBe(callsAfterFirst);
  });

  it('never auto-retries a tool that declares a side effect', async () => {
    const tool = await harness.seedTool({
      name: 'http_request',
      capabilities: ['http', 'external_side_effect'],
    });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'send', description: 'Send', stepType: 'tool', toolId: tool.id, config: { url: 'https://api.test/send', method: 'POST' } },
      ]),
    );
    // The call itself fails — a refused connection, not a 500. This distinction matters:
    // `http_request` deliberately treats a non-2xx as a successful call, so only a
    // transport failure is a tool failure.
    harness.onHttp(() => {
      throw new Error('connect ECONNREFUSED');
    });

    const run = await harness.seedRun({
      context: { allowedToolIds: [tool.id], limits: { maxRetries: 3 } },
    });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error.message).toMatch(/not retried/);
      expect(outcome.error.details).toMatchObject({ attempt: 0 });
    }
    // Exactly one attempt reached the wire.
    expect(harness.httpCalls).toHaveLength(1);
    const steps = await harness.steps.findByRunId(run.id);
    expect(steps).toHaveLength(1);
  });

  it('does retry a read-only tool that failed', async () => {
    const tool = await harness.seedTool({ name: 'http_request', capabilities: ['http', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'get', description: 'Get', stepType: 'tool', toolId: tool.id, config: { url: 'https://api.test/thing' } },
      ]),
    );
    harness.onHttp(() => {
      throw new Error('connect ECONNREFUSED');
    });

    const run = await harness.seedRun({
      context: { allowedToolIds: [tool.id], limits: { maxRetries: 1 } },
    });
    const outcome = await harness.run(run.id);

    // Read-only tools are safe to repeat, so the retry happens and a second attempt row
    // exists alongside the first.
    expect(outcome.status).toBe('failed');
    expect(harness.httpCalls).toHaveLength(2);
    const steps = await harness.steps.findByRunId(run.id);
    expect(steps.map((row) => row.attempt)).toEqual([0, 1]);
    expect(steps.every((row) => row.status === 'failed')).toBe(true);
  });
});

// ── idempotency and concurrency ───────────────────────────────────────────────

describe('idempotency', () => {
  it('returns the existing run for a repeated idempotency key', async () => {
    const first = await harness.seedRun({ idempotencyKey: 'key-1' });
    const second = await harness.seedRun({ idempotencyKey: 'key-1' });
    expect(second.id).toBe(first.id);
  });

  it('lets exactly one of two concurrent claims win', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'calc', description: 'add', stepType: 'tool', toolId: tool.id, config: { expression: '1 + 1' } },
      ]),
      JSON.stringify([
        { id: 'calc', description: 'add', stepType: 'tool', toolId: tool.id, config: { expression: '1 + 1' } },
      ]),
    );

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });

    const [a, b] = await Promise.all([harness.run(run.id), harness.run(run.id)]);
    const statuses = [a.status, b.status].sort();

    // One worker does the work; the other finds the run already taken.
    expect(statuses).toContain('completed');
    const notClaimed = [a, b].filter((outcome) => outcome.status === 'not_claimed' || outcome.status === 'cancelled');
    expect(notClaimed.length + statuses.filter((status) => status === 'completed').length).toBeGreaterThanOrEqual(2);

    const steps = await harness.steps.findByRunId(run.id);
    expect(steps).toHaveLength(1);
  });

  it('defers a run when the tenant is already at its concurrency limit', async () => {
    await harness.cleanup();
    harness = await createEngineHarness({ tenantConcurrency: 1 });
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    const plan = JSON.stringify([
      { id: 'calc', description: 'add', stepType: 'tool', toolId: tool.id, config: { expression: '1 + 1' } },
    ]);

    // Hold the first run open so the second one meets a full tenant.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.onHttp(() => html('ok'));

    const first = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    const second = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });

    // Make the first run occupy a slot by marking it active without running it.
    await harness.runs.setStatus(TEST_TENANT, first.id, 'running');

    harness.gateway.reply(plan);
    const outcome = await harness.run(second.id);
    release();

    expect(outcome.status).toBe('deferred');
    if (outcome.status === 'deferred') expect(outcome.reason).toMatch(/concurrency|active runs/);
    void held;
  });
});

// ── limits ────────────────────────────────────────────────────────────────────

describe('limits', () => {
  it('rejects a plan that exceeds the step budget and records a structured error', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'a', description: 'a', stepType: 'tool', toolId: tool.id, config: { expression: '1' } },
        { id: 'b', description: 'b', stepType: 'tool', toolId: tool.id, config: { expression: '2' } },
      ]),
      JSON.stringify([
        { id: 'a', description: 'a', stepType: 'tool', toolId: tool.id, config: { expression: '1' } },
        { id: 'b', description: 'b', stepType: 'tool', toolId: tool.id, config: { expression: '2' } },
      ]),
    );

    const run = await harness.seedRun({
      context: { allowedToolIds: [tool.id], limits: { maxSteps: 1 } },
    });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error.code).toBe('PLAN_INVALID');
      expect(outcome.error.issues?.map((issue) => issue.code)).toEqual(['too_many_steps']);
    }
    // An unvalidated plan is never executed.
    expect(harness.httpCalls).toHaveLength(0);
    const steps = await harness.steps.findByRunId(run.id);
    expect(steps).toHaveLength(0);
  });

  it('reports an agent with no tools as PLAN_FAILED, not as an internal fault', async () => {
    // No tool is seeded and `allowedToolIds` is empty, so the planner refuses before it
    // asks the model anything. That is a configuration the operator can fix, and reporting
    // it as `INTERNAL` would read as a bug in the engine and send them to the wrong place.
    const run = await harness.seedRun({ context: { allowedToolIds: [] } });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error.code).toBe('PLAN_FAILED');
      // The message has to name the fix; "nothing to plan" alone leaves the operator
      // hunting for which of the agent's settings is empty.
      expect(outcome.error.message).toMatch(/at least one enabled tool|preset plan/);
    }
    // No model call was spent discovering a fact the engine already knew.
    expect(harness.gateway.requests).toHaveLength(0);
  });

  it('stops a run that exceeds its tool-call budget', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'a', description: 'a', stepType: 'tool', toolId: tool.id, config: { expression: '1' } },
        { id: 'b', description: 'b', stepType: 'tool', toolId: tool.id, config: { expression: '2' } },
      ]),
    );

    const run = await harness.seedRun({
      context: { allowedToolIds: [tool.id], limits: { maxToolCalls: 1 } },
    });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error.message).toMatch(/limit of 1 tool calls/);
  });

  it('times a run out when it exceeds its duration budget', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'a', description: 'a', stepType: 'tool', toolId: tool.id, config: { expression: '1' } },
        { id: 'b', description: 'b', stepType: 'tool', toolId: tool.id, config: { expression: '2' } },
      ]),
    );

    // A zero-ish budget: the deadline is already past by the time the first boundary is
    // checked, which is the same code path as a genuinely slow run.
    const run = await harness.seedRun({
      context: { allowedToolIds: [tool.id], limits: { maxDurationMs: 0 } },
    });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('timeout');
    const stored = await harness.runs.findById(TEST_TENANT, run.id);
    expect(stored?.status).toBe('timeout');
  });
});

// ── pause, resume, cancel ─────────────────────────────────────────────────────

describe('pause, resume and cancel', () => {
  it('stops at a step boundary when the run is cancelled', async () => {
    const tool = await harness.seedTool({ name: 'http_request', capabilities: ['http', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'a', description: 'first', stepType: 'tool', toolId: tool.id, config: { url: 'https://api.test/1' } },
        { id: 'b', description: 'second', stepType: 'tool', toolId: tool.id, config: { url: 'https://api.test/2' } },
      ]),
    );

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });

    // Cancel from inside the first step's HTTP call, which is exactly what an operator
    // hitting "Cancel" while the run is working looks like.
    harness.onHttp(() => {
      void harness.runs.setStatus(TEST_TENANT, run.id, 'cancelled');
      return html('ok');
    });

    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('cancelled');
    expect(harness.httpCalls).toHaveLength(1);
    const steps = await harness.steps.findByRunId(run.id);
    expect(steps).toHaveLength(1);
  });

  it('parks at a step boundary when the run is paused', async () => {
    const tool = await harness.seedTool({ name: 'http_request', capabilities: ['http', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'a', description: 'first', stepType: 'tool', toolId: tool.id, config: { url: 'https://api.test/1' } },
        { id: 'b', description: 'second', stepType: 'tool', toolId: tool.id, config: { url: 'https://api.test/2' } },
      ]),
    );

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    harness.onHttp(() => {
      void harness.runs.setStatus(TEST_TENANT, run.id, 'paused');
      return html('ok');
    });

    const outcome = await harness.run(run.id);
    expect(outcome.status).toBe('paused');
    expect(harness.httpCalls).toHaveLength(1);
  });

  it('does not execute a run that is already parked', async () => {
    const run = await harness.seedRun({ status: 'waiting_approval' });
    const outcome = await harness.run(run.id);
    expect(outcome.status).toBe('paused');
  });
});

// ── approvals ─────────────────────────────────────────────────────────────────

describe('approvals', () => {
  async function parkableRun() {
    const tool = await harness.seedTool({
      name: 'http_request',
      capabilities: ['http', 'external_side_effect'],
    });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'send', description: 'Send the message', stepType: 'tool', toolId: tool.id, config: { url: 'https://api.test/send', method: 'POST' } },
      ]),
    );
    harness.onHttp(() => html('{"sent":true}'));
    const run = await harness.seedRun({
      context: { allowedToolIds: [tool.id], approvalPolicy: { mode: 'all' } },
    });
    return { tool, run };
  }

  it('parks the run at waiting_approval without calling the tool', async () => {
    const { run } = await parkableRun();

    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('waiting_approval');
    // The call was not made: a step that is going to wait for approval has not happened
    // yet, and recording it as in-flight would make a later resume see a phantom effect.
    expect(harness.httpCalls).toHaveLength(0);

    const stored = await harness.runs.findById(TEST_TENANT, run.id);
    expect(stored?.status).toBe('waiting_approval');

    const steps = await harness.steps.findByRunId(run.id);
    expect(steps[0]!.status).toBe('waiting_approval');

    expect(harness.frames.map((frame) => frame.name)).toContain('approval.created');
  });

  it('hands back a plan-step id that a later decision can actually be recorded under', async () => {
    const { run } = await parkableRun();
    const parked = await harness.run(run.id);
    expect(parked.status).toBe('waiting_approval');
    if (parked.status !== 'waiting_approval') return;

    // The plan's own id (`send`), not the database row's. `resumeRun` records the decision
    // under this key and `resolveApproval` looks it up by it, so the two must agree — when
    // they do not, the resumed step parks again forever and the run never advances.
    expect(parked.stepId).toBe('send');
    expect(parked.approvalId).toBe('step:send');

    const steps = await harness.steps.findByRunId(run.id);
    // The two identifiers are genuinely different here, which is what makes the assertion
    // above meaningful rather than a coincidence.
    expect(steps[0]!.id).not.toBe(parked.stepId);
  });

  it('resumes the same run id on approval and calls the tool exactly once', async () => {
    const { run } = await parkableRun();
    const parked = await harness.run(run.id);
    expect(parked.status).toBe('waiting_approval');

    const stepId = (parked as { stepId: string }).stepId;
    const outcome = await harness.engine.resumeRun(TEST_TENANT, run.id, {
      stepId,
      approvalId: `step:${stepId}`,
      decision: 'approved',
    });

    expect(outcome.status).toBe('completed');
    // The same run, not a new one.
    expect(outcome.runId).toBe(run.id);
    expect(harness.httpCalls).toHaveLength(1);

    const steps = await harness.steps.findByRunId(run.id);
    expect(steps[0]!.status).toBe('completed');
    // A resumed step does not create a second attempt row.
    expect(steps).toHaveLength(1);
  });

  it('fails the run when the approval is rejected', async () => {
    const { run } = await parkableRun();
    const parked = await harness.run(run.id);
    const stepId = (parked as { stepId: string }).stepId;

    const outcome = await harness.engine.resumeRun(TEST_TENANT, run.id, {
      stepId,
      approvalId: `step:${stepId}`,
      decision: 'rejected',
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error.code).toBe('APPROVAL_REJECTED');
    // A decision, not a transient fault — the tool is never called.
    expect(harness.httpCalls).toHaveLength(0);
  });

  it('parks an explicit approval step and resumes it', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'ask', description: 'Ask a human first', stepType: 'approval', config: {} },
        { id: 'calc', description: 'add', stepType: 'tool', toolId: tool.id, config: { expression: '1 + 1' }, dependsOn: ['ask'] },
      ]),
    );

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    const parked = await harness.run(run.id);

    expect(parked.status).toBe('waiting_approval');
    const stepId = (parked as { stepId: string }).stepId;

    const outcome = await harness.engine.resumeRun(TEST_TENANT, run.id, {
      stepId,
      approvalId: `step:${stepId}`,
      decision: 'approved',
    });

    expect(outcome.status).toBe('completed');
    const steps = await harness.steps.findByRunId(run.id);
    expect(steps.map((row) => row.status)).toEqual(['completed', 'completed']);
  });

  it('does not park a tool whose capabilities do not match a risk-based rule', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'calc', description: 'add', stepType: 'tool', toolId: tool.id, config: { expression: '1 + 1' } },
      ]),
    );

    const run = await harness.seedRun({
      context: {
        allowedToolIds: [tool.id],
        approvalPolicy: { mode: 'risk-based', rules: [{ match: { minRisk: 'high' } }] },
      },
    });

    const outcome = await harness.run(run.id);
    expect(outcome.status).toBe('completed');
  });

  it('parks a tool that matches a risk-based rule', async () => {
    const tool = await harness.seedTool({
      name: 'http_request',
      capabilities: ['http', 'external_side_effect'],
    });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'send', description: 'Send', stepType: 'tool', toolId: tool.id, config: { url: 'https://api.test/', method: 'POST' } },
      ]),
    );

    const run = await harness.seedRun({
      context: {
        allowedToolIds: [tool.id],
        approvalPolicy: { mode: 'risk-based', rules: [{ match: { minRisk: 'high' } }] },
      },
    });

    const outcome = await harness.run(run.id);
    expect(outcome.status).toBe('waiting_approval');
    expect(harness.httpCalls).toHaveLength(0);
  });
});

// ── branching ─────────────────────────────────────────────────────────────────

describe('condition branches', () => {
  it('skips steps that depend on a condition which evaluated false', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        {
          id: 'gate',
          description: 'only if the input says go',
          stepType: 'condition',
          config: { operator: 'eq', left: 'input.go', right: 'go' },
        },
        {
          id: 'then',
          description: 'the taken branch',
          stepType: 'tool',
          toolId: tool.id,
          config: { expression: '1 + 1' },
          dependsOn: ['gate'],
        },
      ]),
    );

    const run = await harness.seedRun({
      input: { go: 'stop' },
      context: { allowedToolIds: [tool.id] },
    });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('completed');
    const steps = await harness.steps.findByRunId(run.id);
    expect(steps.map((row) => row.status)).toEqual(['completed', 'skipped']);
    expect(steps[1]!.error).toMatch(/evaluated false/);
  });

  it('takes the branch when the condition is true', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        {
          id: 'gate',
          description: 'only if the input says go',
          stepType: 'condition',
          config: { operator: 'eq', left: 'input.go', right: 'go' },
        },
        {
          id: 'then',
          description: 'the taken branch',
          stepType: 'tool',
          toolId: tool.id,
          config: { expression: '1 + 1' },
          dependsOn: ['gate'],
        },
      ]),
    );

    const run = await harness.seedRun({
      input: { go: 'go' },
      context: { allowedToolIds: [tool.id] },
    });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('completed');
    const steps = await harness.steps.findByRunId(run.id);
    expect(steps.map((row) => row.status)).toEqual(['completed', 'completed']);
  });

  it('resolves `input.*` against the run input, not a step-local one', async () => {
    // A tool is seeded even though the plan does not use one: the planner refuses to plan
    // at all when the agent has no tools, so every test in this file that wants a plan has
    // to give it one. That refusal is itself covered in the planner suite.
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        {
          id: 'gate',
          description: 'only if the input says go',
          stepType: 'condition',
          config: { operator: 'eq', left: 'input.go', right: 'go' },
        },
      ]),
    );

    const run = await harness.seedRun({ input: { go: 'go' }, context: { allowedToolIds: [tool.id] } });
    await harness.run(run.id);

    const steps = await harness.steps.findByRunId(run.id);
    const output = steps[0]!.output as Record<string, unknown>;
    // The operand is asserted, not just the verdict. A scope that cannot see the run input
    // resolves `left` to `undefined`, and `undefined === 'go'` is *also* false — so the
    // "condition is false" tests pass either way. Only the true case can tell them apart,
    // and only the recorded operand proves which of the two happened.
    expect(output['left']).toBe('go');
    expect(output['result']).toBe(true);
  });

  it('propagates a skip to the dependents of a skipped step', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'gate', description: 'gate', stepType: 'condition', config: { operator: 'eq', left: 'input.go', right: 'go' } },
        { id: 'mid', description: 'mid', stepType: 'tool', toolId: tool.id, config: { expression: '1' }, dependsOn: ['gate'] },
        { id: 'last', description: 'last', stepType: 'tool', toolId: tool.id, config: { expression: '2' }, dependsOn: ['mid'] },
      ]),
    );

    const run = await harness.seedRun({ input: { go: 'no' }, context: { allowedToolIds: [tool.id] } });
    await harness.run(run.id);

    const steps = await harness.steps.findByRunId(run.id);
    expect(steps.map((row) => row.status)).toEqual(['completed', 'skipped', 'skipped']);
  });
});

// ── transform steps ───────────────────────────────────────────────────────────

describe('transform steps', () => {
  it('templates values out of earlier outputs', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        { id: 'calc', description: 'add', stepType: 'tool', toolId: tool.id, config: { expression: '2 + 3' } },
        {
          id: 'format',
          description: 'format the answer',
          stepType: 'transform',
          config: { operation: 'template', template: 'The answer is {{calc.result.result}}' },
          dependsOn: ['calc'],
        },
      ]),
    );

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(JSON.stringify(outcome.output)).toContain('The answer is 5');
    }
  });

  it('picks a value out of the run input, and keeps the operand under its own name', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([
        {
          id: 'pick',
          description: 'pick the name',
          stepType: 'transform',
          config: { operation: 'pick', path: 'input.name' },
        },
        {
          id: 'operand',
          description: 'pick out of the step own operand',
          stepType: 'transform',
          config: { operation: 'pick', path: 'stepInput.deep', input: { deep: 'operand-value' } },
          dependsOn: ['pick'],
        },
      ]),
    );

    const run = await harness.seedRun({ input: { name: 'Ada' }, context: { allowedToolIds: [tool.id] } });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('completed');
    const steps = await harness.steps.findByRunId(run.id);
    // `input` is the run's payload; a step's own `config.input` is reachable as `stepInput`
    // so the two cannot shadow each other — the same expression must not mean one thing in
    // a condition and another in a transform.
    expect(steps[0]!.output).toEqual({ value: 'Ada' });
    expect(steps[1]!.output).toEqual({ value: 'operand-value' });
  });

  it('fails a transform with an unknown operation rather than silently passing through', async () => {
    const tool = await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
    harness.gateway.reply(
      JSON.stringify([{ id: 't', description: 'x', stepType: 'transform', config: { operation: 'alchemy' } }]),
    );

    const run = await harness.seedRun({ context: { allowedToolIds: [tool.id] } });
    const outcome = await harness.run(run.id);

    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.error.message).toMatch(/Unsupported transform operation/);
  });
});
