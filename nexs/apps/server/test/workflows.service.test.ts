import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, createWorkflowSchema } from '@nexs/shared';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';

/**
 * Workflows: versioned step graphs, validated at write time, executed as a preset plan.
 *
 * Two behaviours carry the weight here.
 *
 * **Validation happens when the workflow is saved, not when it runs.** A workflow whose
 * third step names a deleted tool would otherwise be accepted today and fail weeks later at
 * 3am in a scheduled run, and the operator would have to read a run's structured error to
 * discover a mistake they made in the editor. So the tests below check that a bad step is
 * refused at `create` and `addVersion`.
 *
 * **The plan is frozen by value.** The schema has no `Run.workflowVersionId`, so the plan is
 * copied into the run's input at creation rather than re-derived from the workflow at
 * execution time. That gives the same guarantee `agentVersionId` gives for configuration —
 * editing the workflow cannot disturb a run already in flight — and the test for it is the
 * one that would fail if someone "simplified" the run path to look up the active version.
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

/** A tool step that calls `toolId`. */
function toolStep(name: string, toolId: string, dependsOn?: string[]) {
  return {
    name,
    stepType: 'tool' as const,
    toolId,
    config: { expression: '1 + 1' },
    ...(dependsOn === undefined ? {} : { dependsOn }),
  };
}

describe('creating a workflow', () => {
  it('stores version 1 with its steps and points activeVersionId at it', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });

    const workflow = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id)],
    });

    expect(workflow.status).toBe('draft');
    expect(workflow.versions).toHaveLength(1);
    expect(workflow.versions[0]!.version).toBe(1);
    expect(workflow.versions[0]!.steps).toHaveLength(1);
    expect(workflow.versions[0]!.steps[0]!.name).toBe('add');
    expect(workflow.activeVersionId).toBe(workflow.versions[0]!.id);
  });

  it('keeps the tool the author named, so the step is runnable', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });

    const workflow = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id)],
    });

    // `WorkflowStep` has no `toolId` column, so the id is folded into the stored config.
    // If that fold were dropped the step would look valid and execute as a no-op.
    const stored = workflow.versions[0]!.steps[0]!;
    expect(stored.config).toMatchObject({ toolId: tool.id });
  });

  it('publishes a new version on addVersion and leaves version 1 untouched', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });

    const created = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id)],
    });
    const v1 = created.versions[0]!;

    const updated = await harness.workflowService.addVersion(CONTROL_TENANT, created.id, {
      steps: [toolStep('add', tool.id), toolStep('add-again', tool.id, ['add'])],
    });

    expect(updated.versions).toHaveLength(2);
    expect(updated.activeVersionId).not.toBe(v1.id);

    const reRead = await harness.workflows.findVersionById(CONTROL_TENANT, v1.id);
    expect(reRead!.steps).toHaveLength(1);
  });
});

describe('step validation at write time', () => {
  it('refuses a tool step that names a tool which does not exist', async () => {
    const err = await apiErrorFrom(() =>
      harness.workflowService.create(CONTROL_TENANT, {
        name: 'Broken',
        steps: [toolStep('add', 'tol_missing')],
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ toolId: 'tol_missing' });
  });

  it('refuses a tool step that names a disabled tool', async () => {
    const tool = await harness.seedTool({ name: 'calculator', status: 'disabled' });

    const err = await apiErrorFrom(() =>
      harness.workflowService.create(CONTROL_TENANT, {
        name: 'Broken',
        steps: [toolStep('add', tool.id)],
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ toolId: tool.id, status: 'disabled' });
  });

  it('refuses a tool step that names another tenant’s tool', async () => {
    const foreign = await harness.seedTool({ name: 'calculator', tenantId: OTHER_TENANT });

    const err = await apiErrorFrom(() =>
      harness.workflowService.create(CONTROL_TENANT, {
        name: 'Broken',
        steps: [toolStep('add', foreign.id)],
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('refuses duplicate step names', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });

    const err = await apiErrorFrom(() =>
      harness.workflowService.create(CONTROL_TENANT, {
        name: 'Ambiguous',
        steps: [toolStep('add', tool.id), toolStep('add', tool.id)],
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ issues: [{ index: 1, name: 'add' }] });
  });

  it('refuses a dependency on a step that is not in the list', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });

    const err = await apiErrorFrom(() =>
      harness.workflowService.create(CONTROL_TENANT, {
        name: 'Dangling',
        steps: [toolStep('add', tool.id, ['nope'])],
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a cyclic dependency', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });

    const err = await apiErrorFrom(() =>
      harness.workflowService.create(CONTROL_TENANT, {
        name: 'Cyclic',
        steps: [
          toolStep('a', tool.id, ['b']),
          toolStep('b', tool.id, ['a']),
        ],
      }),
    );

    // Caught by the engine's own ladder, run over the translated plan — the same code that
    // judges a model-generated plan. A workflow that passes here is one the engine accepts.
    expect(err.code).toBe('VALIDATION_ERROR');
  });

  it('refuses a tool step with no toolId at the schema boundary', async () => {
    const parsed = createWorkflowSchema.safeParse({
      name: 'No tool',
      steps: [{ name: 'add', stepType: 'tool', config: {} }],
    });

    expect(parsed.success).toBe(true);
    // The schema allows it — `toolId` is optional because most step types do not need one.
    // The *service* is what refuses it, which is the check below.
    const err = await apiErrorFrom(() =>
      harness.workflowService.create(CONTROL_TENANT, {
        name: 'No tool',
        steps: [{ name: 'add', stepType: 'tool', config: {} }],
      }),
    );
    expect(err.code).toBe('VALIDATION_ERROR');
  });
});

describe('activating and running', () => {
  it('refuses to run a draft workflow', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });
    const workflow = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id)],
    });

    const err = await apiErrorFrom(() => harness.workflowService.run(CONTROL_TENANT, workflow.id));

    expect(err.code).toBe('CONFLICT');
    expect(harness.enqueued).toHaveLength(0);
  });

  it('refuses an agent-less run that names no model, rather than creating a run that cannot start', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });
    const workflow = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id)],
    });
    await harness.workflowService.setStatus(CONTROL_TENANT, workflow.id, 'active');

    // `Workflow` has no model column and `RunContext.modelId` is required, so an agent-less
    // run has to be told. Refusing here means the caller gets a message about their request
    // instead of a run that fails moments later with a message about the engine.
    const err = await apiErrorFrom(() => harness.workflowService.run(CONTROL_TENANT, workflow.id));

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'input.context.modelId' });
    expect(harness.enqueued).toHaveLength(0);
  });

  it('gives the run the workflow’s own tools as its allowlist', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });
    const workflow = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id), toolStep('add-again', tool.id, ['add'])],
    });
    await harness.workflowService.setStatus(CONTROL_TENANT, workflow.id, 'active');

    const { runId } = await harness.workflowService.run(CONTROL_TENANT, workflow.id, {
      input: { context: { modelId: 'mdl_test' } },
    });

    const run = await harness.runs.findById(CONTROL_TENANT, runId);
    const context = (run!.input as { context?: { allowedToolIds?: string[] } }).context;

    // Distinct, not one entry per step: the allowlist is a set of permissions, not a list
    // of calls. Without this the plan is validated against an empty allowlist and every
    // tool step is refused — the run is created and then fails on its own plan.
    expect(context?.allowedToolIds).toEqual([tool.id]);
  });

  it('keeps a caller-supplied model alongside the workflow’s plan', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });
    const workflow = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id)],
    });
    await harness.workflowService.setStatus(CONTROL_TENANT, workflow.id, 'active');

    const { runId } = await harness.workflowService.run(CONTROL_TENANT, workflow.id, {
      input: { context: { modelId: 'mdl_caller' } },
    });

    const run = await harness.runs.findById(CONTROL_TENANT, runId);
    const context = (run!.input as { context?: { modelId?: string; presetPlan?: unknown[] } })
      .context;

    // Merged, not replaced. Replacing the block dropped the caller's model, which is the
    // only way an agent-less run can name one.
    expect(context?.modelId).toBe('mdl_caller');
    expect(context?.presetPlan).toHaveLength(1);
  });

  it('will not let a caller widen the allowlist beyond the workflow’s own steps', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });
    const other = await harness.seedTool({ name: 'notify' });
    const workflow = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id)],
    });
    await harness.workflowService.setStatus(CONTROL_TENANT, workflow.id, 'active');

    const { runId } = await harness.workflowService.run(CONTROL_TENANT, workflow.id, {
      input: { context: { modelId: 'mdl_test', allowedToolIds: [tool.id, other.id] } },
    });

    const run = await harness.runs.findById(CONTROL_TENANT, runId);
    const context = (run!.input as { context?: { allowedToolIds?: string[] } }).context;

    expect(context?.allowedToolIds).toEqual([tool.id]);
  });

  it('creates one workflow run carrying the plan as a preset, and enqueues it once', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });
    const workflow = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id)],
    });
    await harness.workflowService.setStatus(CONTROL_TENANT, workflow.id, 'active');

    const { runId } = await harness.workflowService.run(CONTROL_TENANT, workflow.id, {
      input: { context: { modelId: 'mdl_test' } },
    });

    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]).toMatchObject({ runId, kind: 'workflow' });

    const run = await harness.runs.findById(CONTROL_TENANT, runId);
    expect(run!.kind).toBe('workflow');
    expect(run!.workflowId).toBe(workflow.id);

    // The plan travels with the run. `context.presetPlan` is the key the resolver reads.
    const preset = (run!.input as { context?: { presetPlan?: unknown[] } }).context?.presetPlan;
    expect(Array.isArray(preset)).toBe(true);
    expect(preset).toHaveLength(1);
  });

  it('executes the preset plan without asking the model to invent one', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });
    const workflow = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id)],
    });
    await harness.workflowService.setStatus(CONTROL_TENANT, workflow.id, 'active');

    const { runId } = await harness.workflowService.run(CONTROL_TENANT, workflow.id, {
      input: { context: { modelId: 'mdl_test' } },
    });
    const outcome = await harness.engine.executeRun(CONTROL_TENANT, runId);

    expect(outcome.status).toBe('completed');
    // A workflow is a program a human wrote; the model must not be consulted to plan it.
    expect(harness.gateway.callCount).toBe(0);

    const steps = await harness.steps.listByRunIdOrdered(runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('completed');
  });

  it('freezes the plan by value, so editing the workflow cannot change a run in flight', async () => {
    const tool = await harness.seedTool({ name: 'calculator' });
    const workflow = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id)],
    });
    await harness.workflowService.setStatus(CONTROL_TENANT, workflow.id, 'active');

    const { runId } = await harness.workflowService.run(CONTROL_TENANT, workflow.id, {
      input: { context: { modelId: 'mdl_test' } },
    });

    // Publish a new version with a second step, before the run has executed.
    await harness.workflowService.addVersion(CONTROL_TENANT, workflow.id, {
      steps: [toolStep('add', tool.id), toolStep('double', tool.id, ['add'])],
    });

    const run = await harness.runs.findById(CONTROL_TENANT, runId);
    const preset = (run!.input as { context?: { presetPlan?: unknown[] } }).context?.presetPlan;
    // One step, not two: the run carries the version that was active when it was created.
    expect(preset).toHaveLength(1);

    const outcome = await harness.engine.executeRun(CONTROL_TENANT, runId);
    expect(outcome.status).toBe('completed');
    expect(await harness.steps.listByRunIdOrdered(runId)).toHaveLength(1);
  });

  it('refuses to activate a workflow with no version', async () => {
    // Unreachable through the API — `create` always writes version 1 — but the guard is
    // what stops a hand-edited row from becoming a run that fails asking for its plan.
    const tool = await harness.seedTool({ name: 'calculator' });
    const workflow = await harness.workflowService.create(CONTROL_TENANT, {
      name: 'Arithmetic',
      steps: [toolStep('add', tool.id)],
    });
    await harness.db.workflow.update({
      where: { id: workflow.id },
      data: { activeVersionId: null },
    });

    const err = await apiErrorFrom(() =>
      harness.workflowService.setStatus(CONTROL_TENANT, workflow.id, 'active'),
    );

    expect(err.code).toBe('CONFLICT');
  });
});

describe('scoping', () => {
  it('does not expose another tenant’s workflow', async () => {
    const tool = await harness.seedTool({ name: 'calculator', tenantId: OTHER_TENANT });
    const foreign = await harness.workflowService.create(OTHER_TENANT, {
      name: 'Theirs',
      steps: [toolStep('add', tool.id)],
    });

    const err = await apiErrorFrom(() => harness.workflowService.get(CONTROL_TENANT, foreign.id));
    expect(err.code).toBe('NOT_FOUND');
  });

  it('refuses to run another tenant’s workflow', async () => {
    const tool = await harness.seedTool({ name: 'calculator', tenantId: OTHER_TENANT });
    const foreign = await harness.workflowService.create(OTHER_TENANT, {
      name: 'Theirs',
      steps: [toolStep('add', tool.id)],
    });

    const err = await apiErrorFrom(() => harness.workflowService.run(CONTROL_TENANT, foreign.id));
    expect(err.code).toBe('NOT_FOUND');
    expect(harness.enqueued).toHaveLength(0);
  });
});
