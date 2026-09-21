import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { PlanStep } from '@nexs/shared';
import { EmptyPlanError, PlanValidationError, Planner } from '../src/services/engine/planner.js';
import { createEngineHarness, TEST_TENANT, type EngineHarness } from './helpers/engine-harness.js';

const logger = pino({ level: 'silent' });

let harness: EngineHarness;
let planner: Planner;

beforeEach(async () => {
  harness = await createEngineHarness();
  planner = new Planner({ gateway: harness.gateway, tools: harness.tools, logger });
});

afterEach(async () => {
  await harness.cleanup();
});

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: 's1',
  description: 'do the thing',
  stepType: 'transform',
  config: {},
  ...overrides,
});

function request(overrides: Partial<Parameters<Planner['plan']>[0]> = {}) {
  return {
    tenantId: TEST_TENANT,
    runId: 'run_test',
    modelId: 'mdl_test',
    instructions: 'Be careful.',
    goal: null,
    task: 'Do the thing',
    input: {},
    allowedToolIds: [] as string[],
    maxSteps: 10,
    ...overrides,
  };
}

describe('Planner — tool resolution', () => {
  it('throws when the agent has no tools at all', async () => {
    await expect(planner.plan(request({ allowedToolIds: [] }))).rejects.toBeInstanceOf(EmptyPlanError);
  });

  it('throws when the allowlist names only tools that do not exist', async () => {
    await expect(planner.plan(request({ allowedToolIds: ['tool_ghost'] }))).rejects.toBeInstanceOf(
      EmptyPlanError,
    );
  });

  it('offers the allowlist intersected with what exists, and uses the row id as the tool name', async () => {
    const allowed = await harness.seedTool({ name: 'http_request', capabilities: ['http', 'read_only'] });
    await harness.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });

    harness.gateway.reply(JSON.stringify([step()]));
    await planner.plan(request({ allowedToolIds: [allowed.id] }));

    const definitions = harness.gateway.requests[0]!.tools ?? [];
    expect(definitions).toHaveLength(1);
    // The provider-facing name is the row id, and the human name leads the description —
    // one identifier from prompt through to the ToolCall row, with nothing to resolve.
    expect(definitions[0]!.name).toBe(allowed.id);
    expect(definitions[0]!.description).toContain('http_request');
  });

  it('does not offer a disabled tool, so the model cannot plan one', async () => {
    const disabled = await harness.seedTool({ name: 'http_request', status: 'disabled' });
    await expect(planner.plan(request({ allowedToolIds: [disabled.id] }))).rejects.toBeInstanceOf(
      EmptyPlanError,
    );
  });

  it('lists the valid tool ids in the prompt', async () => {
    const tool = await harness.seedTool({ name: 'http_request' });
    harness.gateway.reply(JSON.stringify([step()]));
    await planner.plan(request({ allowedToolIds: [tool.id] }));

    const system = harness.gateway.requests[0]!.messages[0]!.content;
    expect(system).toContain(tool.id);
    expect(system).toContain('http_request');
  });
});

describe('Planner — the correction retry', () => {
  it('accepts a valid first reply without retrying', async () => {
    const tool = await harness.seedTool({ name: 'http_request' });
    harness.gateway.reply(JSON.stringify([step({ id: 'a', stepType: 'tool', toolId: tool.id })]));

    const plan = await planner.plan(request({ allowedToolIds: [tool.id] }));

    expect(plan).toHaveLength(1);
    expect(harness.gateway.callCount).toBe(1);
  });

  it('retries once and accepts the corrected plan', async () => {
    const tool = await harness.seedTool({ name: 'http_request' });
    harness.gateway.reply(
      // First: a tool step with no toolId — a real mistake the ladder catches.
      JSON.stringify([step({ id: 'a', stepType: 'tool' })]),
      // Second: corrected.
      JSON.stringify([step({ id: 'a', stepType: 'tool', toolId: tool.id })]),
    );

    const plan = await planner.plan(request({ allowedToolIds: [tool.id] }));

    expect(plan[0]!.toolId).toBe(tool.id);
    expect(harness.gateway.callCount).toBe(2);
  });

  it('sends the model its own rejected reply back, so the retry is an edit not a fresh sample', async () => {
    const tool = await harness.seedTool({ name: 'http_request' });
    const bad = JSON.stringify([step({ id: 'a', stepType: 'tool' })]);
    harness.gateway.reply(bad, JSON.stringify([step({ id: 'a', stepType: 'tool', toolId: tool.id })]));

    await planner.plan(request({ allowedToolIds: [tool.id] }));

    const retryMessages = harness.gateway.requests[1]!.messages;
    const assistant = retryMessages.find((message: { role: string }) => message.role === 'assistant');
    expect(assistant?.content).toBe(bad);
    expect(retryMessages[retryMessages.length - 1]!.role).toBe('user');
  });

  it('carries the exact validation error into the retry message', async () => {
    const tool = await harness.seedTool({ name: 'http_request' });
    harness.gateway.reply(
      JSON.stringify([step({ id: 'a', stepType: 'tool' })]),
      JSON.stringify([step({ id: 'a', stepType: 'tool', toolId: tool.id })]),
    );

    await planner.plan(request({ allowedToolIds: [tool.id] }));

    const retry = harness.gateway.requests[1]!.messages.at(-1)!.content;
    expect(retry).toContain('missing_tool_id');
    expect(retry).toContain('"a"');
  });

  it('re-lists the valid tool ids when the failure was a bad tool reference', async () => {
    const tool = await harness.seedTool({ name: 'http_request' });
    harness.gateway.reply(
      JSON.stringify([step({ id: 'a', stepType: 'tool', toolId: 'tool_hallucinated' })]),
      JSON.stringify([step({ id: 'a', stepType: 'tool', toolId: tool.id })]),
    );

    await planner.plan(request({ allowedToolIds: [tool.id] }));

    const retry = harness.gateway.requests[1]!.messages.at(-1)!.content;
    expect(retry).toContain('unknown_tool');
    expect(retry).toContain(tool.id);
  });

  it('fails the run after exactly one correction, with the issues attached', async () => {
    const tool = await harness.seedTool({ name: 'http_request' });
    harness.gateway.reply(
      JSON.stringify([step({ id: 'a', stepType: 'tool' })]),
      JSON.stringify([step({ id: 'a', stepType: 'tool' })]),
    );

    const error = await planner
      .plan(request({ allowedToolIds: [tool.id] }))
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(PlanValidationError);
    const validationError = error as PlanValidationError;
    expect(validationError.attempts).toBe(2);
    expect(validationError.issues.map((issue) => issue.code)).toEqual(['missing_tool_id']);
    // Exactly two calls: a third attempt would be another paid request against a model
    // that has already been told precisely what is wrong.
    expect(harness.gateway.callCount).toBe(2);
  });

  it('rejects a plan that names a tool outside the allowlist', async () => {
    const allowed = await harness.seedTool({ name: 'http_request' });
    const other = await harness.seedTool({ name: 'calculator' });
    harness.gateway.reply(
      JSON.stringify([step({ id: 'a', stepType: 'tool', toolId: other.id })]),
      JSON.stringify([step({ id: 'a', stepType: 'tool', toolId: other.id })]),
    );

    const error = await planner
      .plan(request({ allowedToolIds: [allowed.id] }))
      .catch((cause: unknown) => cause);

    expect((error as PlanValidationError).issues[0]!.code).toBe('unknown_tool');
  });

  it('accepts a plan from a fenced reply without spending the retry', async () => {
    const tool = await harness.seedTool({ name: 'http_request' });
    harness.gateway.reply(
      `Here you go:\n\`\`\`json\n${JSON.stringify([step({ id: 'a', stepType: 'tool', toolId: tool.id })])}\n\`\`\``,
    );

    const plan = await planner.plan(request({ allowedToolIds: [tool.id] }));

    expect(plan).toHaveLength(1);
    expect(harness.gateway.callCount).toBe(1);
  });
});

describe('Planner — the gateway call', () => {
  it('asks for a deterministic, structured reply', async () => {
    const tool = await harness.seedTool({ name: 'http_request' });
    harness.gateway.reply(JSON.stringify([step()]));
    await planner.plan(request({ allowedToolIds: [tool.id] }));

    const call = harness.gateway.requests[0]!;
    // Temperature 0 so that a crash-resume which re-plans produces the same program the
    // operator approved, rather than a different one.
    expect(call.temperature).toBe(0);
    expect(call.responseFormat?.name).toBe('execution_plan');
    expect(call.runId).toBe('run_test');
  });

  it('states the step budget in the prompt', async () => {
    const tool = await harness.seedTool({ name: 'http_request' });
    harness.gateway.reply(JSON.stringify([step()]));
    await planner.plan(request({ allowedToolIds: [tool.id], maxSteps: 7 }));

    expect(harness.gateway.requests[0]!.messages[0]!.content).toContain('at most 7 steps');
  });

  it('includes the goal and the task in the user message', async () => {
    const tool = await harness.seedTool({ name: 'http_request' });
    harness.gateway.reply(JSON.stringify([step()]));
    await planner.plan(request({ allowedToolIds: [tool.id], goal: 'Reach the summit', task: 'Check the weather' }));

    const user = harness.gateway.requests[0]!.messages[1]!.content;
    expect(user).toContain('Reach the summit');
    expect(user).toContain('Check the weather');
  });
});
