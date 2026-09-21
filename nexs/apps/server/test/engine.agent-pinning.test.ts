import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';

/**
 * Gap #15, end to end: **a run executes the configuration it pinned.**
 *
 * The Phase 6 acceptance criterion in `docs/03-BUILD-PLAN.md` is:
 *
 *   > "update an active agent → new version snapshot written; a run started before the
 *   >  update executes the old config"
 *
 * The first half is proved in `agents.repo.test.ts` at the repository level. This file
 * proves the second half where it actually matters — through the **engine**, by running a
 * plan and observing which model and which instructions the run really used.
 *
 * ## How "the old config" is observed rather than asserted
 *
 * The scripted gateway records every `chat` request it receives, and the planner sends
 * `request.modelId` and `request.instructions` on every call. So "which configuration did
 * this run use?" is answered by reading `gateway.requests[0]`, not by inspecting the
 * `Run` row and trusting that the engine honoured it. A test that asserted only on
 * `run.agentVersionId` would pass even if the resolver ignored the pin entirely — which is
 * the exact bug this gap is about.
 *
 * The pair of runs is what makes the test decisive. Run A is created before the edit and
 * pinned to version 1; run B is created after it and pinned by the engine to version 2.
 * Both execute against the same agent row. If the resolver were reading the live `Agent`,
 * both would use version 2's configuration and run A's assertions would fail.
 */

const INSTRUCTIONS_V1 = 'REPORT-FORMAT-V1';
const INSTRUCTIONS_V2 = 'REPORT-FORMAT-V2';

let harness: ControlHarness;

beforeEach(async () => {
  harness = await createControlHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/** A one-step plan that calls `toolId`, as the model would emit it. */
function planCallingTool(toolId: string): string {
  return JSON.stringify([
    {
      id: 'call',
      description: 'Call the tool',
      stepType: 'tool',
      toolId,
      config: { expression: '1 + 1' },
    },
  ]);
}

describe('gap #15 — a run reads the version it pinned', () => {
  it('executes the pinned configuration after the agent has been edited', async () => {
    const modelV1 = await harness.seedModel({ name: 'Model V1', externalModelId: 'model-v1' });
    const modelV2 = await harness.seedModel({ name: 'Model V2', externalModelId: 'model-v2' });
    const tool = await harness.seedTool({ name: 'calculator' });

    // ── the agent, at version 1 ───────────────────────────────────────────────
    const created = await harness.agentService.create(CONTROL_TENANT, {
      name: 'Reporter',
      instructions: INSTRUCTIONS_V1,
      modelId: modelV1.id,
      toolIds: [tool.id],
    });
    await harness.agentService.setStatus(CONTROL_TENANT, created.id, 'active');

    const v1 = await harness.agents.findActiveVersion(CONTROL_TENANT, created.id);
    expect(v1?.version).toBe(1);

    // ── a run started BEFORE the edit, pinned to version 1 ────────────────────
    const runA = await harness.runs.create({
      tenantId: CONTROL_TENANT,
      kind: 'task',
      agentId: created.id,
      agentVersionId: v1!.id,
    });

    // ── the edit: a different model and different instructions ────────────────
    const afterUpdate = await harness.agentService.update(CONTROL_TENANT, created.id, {
      instructions: INSTRUCTIONS_V2,
      modelId: modelV2.id,
    });
    expect(afterUpdate.instructions).toBe(INSTRUCTIONS_V2);

    const v2 = await harness.agents.findActiveVersion(CONTROL_TENANT, created.id);
    expect(v2?.version).toBe(2);
    expect(v2!.id).not.toBe(v1!.id);

    // The version 1 row is immutable — the edit published a new row rather than
    // overwriting the one run A is about to execute against.
    const v1Reread = await harness.agents.findVersionById(CONTROL_TENANT, v1!.id);
    expect(v1Reread!.config).toMatchObject({
      instructions: INSTRUCTIONS_V1,
      modelId: modelV1.id,
    });

    // ── a run started AFTER the edit, unpinned ────────────────────────────────
    const runB = await harness.runs.create({
      tenantId: CONTROL_TENANT,
      kind: 'task',
      agentId: created.id,
    });
    expect(runB.agentVersionId).toBeNull();

    // ── execute both ──────────────────────────────────────────────────────────
    harness.gateway.reply(planCallingTool(tool.id), planCallingTool(tool.id));

    const outcomeA = await harness.engine.executeRun(CONTROL_TENANT, runA.id);
    const outcomeB = await harness.engine.executeRun(CONTROL_TENANT, runB.id);

    expect(outcomeA.status).toBe('completed');
    expect(outcomeB.status).toBe('completed');

    const [requestA, requestB] = harness.gateway.requests;
    expect(requestA).toBeDefined();
    expect(requestB).toBeDefined();

    // Run A used version 1's model and version 1's instructions...
    expect(requestA!.modelId).toBe(modelV1.id);
    expect(systemPromptOf(requestA!)).toContain(INSTRUCTIONS_V1);
    expect(systemPromptOf(requestA!)).not.toContain(INSTRUCTIONS_V2);

    // ...and run B used version 2's, from the same agent row.
    expect(requestB!.modelId).toBe(modelV2.id);
    expect(systemPromptOf(requestB!)).toContain(INSTRUCTIONS_V2);
    expect(systemPromptOf(requestB!)).not.toContain(INSTRUCTIONS_V1);
  });

  it('pins an unpinned run to the agent’s active version and says so in SSE', async () => {
    const model = await harness.seedModel({ name: 'Model', externalModelId: 'model-1' });
    const tool = await harness.seedTool({ name: 'calculator' });

    const created = await harness.agentService.create(CONTROL_TENANT, {
      name: 'Reporter',
      instructions: INSTRUCTIONS_V1,
      modelId: model.id,
      toolIds: [tool.id],
    });
    await harness.agentService.setStatus(CONTROL_TENANT, created.id, 'active');
    const active = await harness.agents.findActiveVersion(CONTROL_TENANT, created.id);

    const run = await harness.runs.create({
      tenantId: CONTROL_TENANT,
      kind: 'task',
      agentId: created.id,
    });
    expect(run.agentVersionId).toBeNull();

    harness.gateway.reply(planCallingTool(tool.id));
    const outcome = await harness.engine.executeRun(CONTROL_TENANT, run.id);
    expect(outcome.status).toBe('completed');

    // The pin was written to the row, not merely used in memory.
    const reloaded = await harness.runs.findById(CONTROL_TENANT, run.id);
    expect(reloaded!.agentVersionId).toBe(active!.id);

    // And the operator can see it happened.
    const pinFrame = harness.frames.find((frame) => frame.name === 'run.version_pinned');
    expect(pinFrame).toBeDefined();
    expect(pinFrame!.payload).toMatchObject({
      runId: run.id,
      agentId: created.id,
      agentVersionId: active!.id,
    });
  });

  it('does not re-pin a run that already holds a version', async () => {
    const modelV1 = await harness.seedModel({ name: 'Model V1', externalModelId: 'model-v1' });
    const modelV2 = await harness.seedModel({ name: 'Model V2', externalModelId: 'model-v2' });
    const tool = await harness.seedTool({ name: 'calculator' });

    const created = await harness.agentService.create(CONTROL_TENANT, {
      name: 'Reporter',
      instructions: INSTRUCTIONS_V1,
      modelId: modelV1.id,
      toolIds: [tool.id],
    });
    await harness.agentService.setStatus(CONTROL_TENANT, created.id, 'active');
    const v1 = await harness.agents.findActiveVersion(CONTROL_TENANT, created.id);

    const run = await harness.runs.create({
      tenantId: CONTROL_TENANT,
      kind: 'task',
      agentId: created.id,
      agentVersionId: v1!.id,
    });

    // The agent moves on before the run executes. A re-pin would silently upgrade the run.
    await harness.agentService.update(CONTROL_TENANT, created.id, {
      instructions: INSTRUCTIONS_V2,
      modelId: modelV2.id,
    });

    harness.gateway.reply(planCallingTool(tool.id));
    await harness.engine.executeRun(CONTROL_TENANT, run.id);

    const reloaded = await harness.runs.findById(CONTROL_TENANT, run.id);
    expect(reloaded!.agentVersionId).toBe(v1!.id);
    expect(harness.frames.some((frame) => frame.name === 'run.version_pinned')).toBe(false);
  });

  it('fails the run rather than falling back to the live agent when the pin is unreadable', async () => {
    const model = await harness.seedModel({ name: 'Model', externalModelId: 'model-1' });
    const tool = await harness.seedTool({ name: 'calculator' });

    // An agent belonging to a *different* tenant. A run in this tenant pinned to its
    // version must not be able to read it — and must not substitute the live agent for it.
    const foreign = await harness.agentService.create(OTHER_TENANT, {
      name: 'Foreign',
      instructions: INSTRUCTIONS_V2,
      modelId: model.id,
      toolIds: [tool.id],
    });
    const foreignVersion = await harness.agents.findActiveVersion(OTHER_TENANT, foreign.id);
    expect(foreignVersion).not.toBeNull();

    const local = await harness.agentService.create(CONTROL_TENANT, {
      name: 'Local',
      instructions: INSTRUCTIONS_V1,
      modelId: model.id,
      toolIds: [tool.id],
    });
    await harness.agentService.setStatus(CONTROL_TENANT, local.id, 'active');

    const run = await harness.runs.create({
      tenantId: CONTROL_TENANT,
      kind: 'task',
      agentId: local.id,
      agentVersionId: foreignVersion!.id,
    });

    harness.gateway.reply(planCallingTool(tool.id));
    const outcome = await harness.engine.executeRun(CONTROL_TENANT, run.id);

    expect(outcome.status).toBe('failed');
    // The live local agent's instructions must not have been used as a substitute.
    expect(harness.gateway.requests).toHaveLength(0);
  });
});

/** The system message the planner sent, which carries the run's instructions. */
function systemPromptOf(request: { messages: Array<{ role: string; content: string }> }): string {
  const system = request.messages.find((message) => message.role === 'system');
  return system?.content ?? '';
}
