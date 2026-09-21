import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@nexs/shared';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';

/**
 * The agent lifecycle: the state machine, the activation preconditions, and what does and
 * does not mint a version.
 *
 * The versioning rule is the subtle one, and the tests below pin both halves of it. A
 * version is written whenever the *behaviour* changes — and only then. Renaming an agent
 * must not mint one: the run list is filtered by agent, and burying the versions that
 * changed what a run did under versions that only changed what it was called would make the
 * one question this table exists to answer — "which configuration did this run use?" —
 * harder to answer, not easier.
 *
 * The end-to-end proof that a run honours the pin lives in `engine.agent-pinning.test.ts`;
 * this file proves the bookkeeping that makes it possible.
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

/** An agent with a usable model, at version 1. */
async function agentWithModel(name = 'Reporter') {
  const model = await harness.seedModel({ name: 'Model', externalModelId: 'model-1' });
  const agent = await harness.agentService.create(CONTROL_TENANT, {
    name,
    instructions: 'Be brief.',
    modelId: model.id,
  });
  return { agent, model };
}

describe('creating an agent', () => {
  it('starts as a draft at version 1, with an active version pointer', async () => {
    const { agent } = await agentWithModel();

    expect(agent.status).toBe('draft');
    expect(agent.versions).toHaveLength(1);
    expect(agent.versions[0]!.version).toBe(1);
    expect(agent.activeVersionId).toBe(agent.versions[0]!.id);
  });

  it('applies the documented defaults rather than schema defaults', async () => {
    const agent = await harness.agentService.create(CONTROL_TENANT, { name: 'Bare' });

    // Applied at row creation, so "set this to X" and "said nothing" stay distinguishable
    // further down. `risk-based` rather than `none`: an unconfigured agent should ask
    // before doing something irreversible.
    expect(agent.approvalPolicy).toMatchObject({ mode: 'risk-based' });
    expect(agent.executionLimits).toMatchObject({ maxSteps: 50, maxToolCalls: 100 });
    expect(agent.memoryEnabled).toBe(true);
  });
});

describe('activation preconditions', () => {
  it('refuses to activate an agent with no model', async () => {
    const agent = await harness.agentService.create(CONTROL_TENANT, { name: 'No model' });

    const err = await apiErrorFrom(() =>
      harness.agentService.setStatus(CONTROL_TENANT, agent.id, 'active'),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'modelId' });
  });

  it('refuses to activate an agent whose model does not exist', async () => {
    const agent = await harness.agentService.create(CONTROL_TENANT, {
      name: 'Ghost model',
      modelId: 'mdl_missing',
    });

    const err = await apiErrorFrom(() =>
      harness.agentService.setStatus(CONTROL_TENANT, agent.id, 'active'),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ modelId: 'mdl_missing' });
  });

  it('refuses to activate an agent whose model is disabled', async () => {
    const model = await harness.seedModel({
      name: 'Off',
      externalModelId: 'off',
      enabled: false,
    });
    const agent = await harness.agentService.create(CONTROL_TENANT, {
      name: 'Disabled model',
      modelId: model.id,
    });

    const err = await apiErrorFrom(() =>
      harness.agentService.setStatus(CONTROL_TENANT, agent.id, 'active'),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toContain('disabled');
  });

  it('refuses to activate an agent whose model is not available', async () => {
    const model = await harness.seedModel({
      name: 'Degraded',
      externalModelId: 'degraded',
      status: 'unavailable',
    });
    const agent = await harness.agentService.create(CONTROL_TENANT, {
      name: 'Unavailable model',
      modelId: model.id,
    });

    const err = await apiErrorFrom(() =>
      harness.agentService.setStatus(CONTROL_TENANT, agent.id, 'active'),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ status: 'unavailable' });
  });

  it('activates an agent once its model is usable', async () => {
    const { agent } = await agentWithModel();

    const activated = await harness.agentService.setStatus(CONTROL_TENANT, agent.id, 'active');

    expect(activated.status).toBe('active');
  });

  it('reports the transition, not the missing model, when the target is illegal', async () => {
    // The order of checks is the order that produces the most useful message. A caller
    // asking to move a draft to `paused` should be told that, not told about a model they
    // were not trying to change.
    const agent = await harness.agentService.create(CONTROL_TENANT, { name: 'No model' });

    const err = await apiErrorFrom(() =>
      harness.agentService.setStatus(CONTROL_TENANT, agent.id, 'paused'),
    );

    expect(err.code).toBe('CONFLICT');
    expect(err.details).toMatchObject({ from: 'draft', to: 'paused' });
  });

  it('refuses a status that is already current', async () => {
    const { agent } = await agentWithModel();
    await harness.agentService.setStatus(CONTROL_TENANT, agent.id, 'active');

    const err = await apiErrorFrom(() =>
      harness.agentService.setStatus(CONTROL_TENANT, agent.id, 'active'),
    );

    expect(err.code).toBe('CONFLICT');
    expect(err.message).toContain('already active');
  });
});

describe('versioning', () => {
  it('mints a version when the configuration changes', async () => {
    const { agent } = await agentWithModel();

    const updated = await harness.agentService.update(CONTROL_TENANT, agent.id, {
      instructions: 'Be extremely verbose.',
    });

    expect(updated.versions).toHaveLength(2);
    expect(updated.versions[0]!.version).toBe(2);
    expect(updated.activeVersionId).not.toBe(agent.activeVersionId);
  });

  it('does not mint a version for a rename', async () => {
    const { agent } = await agentWithModel();

    const renamed = await harness.agentService.update(CONTROL_TENANT, agent.id, {
      name: 'Chief Reporter',
    });

    expect(renamed.name).toBe('Chief Reporter');
    // One version, still pointing at the same row: a rename is not a behaviour change.
    expect(renamed.versions).toHaveLength(1);
    expect(renamed.activeVersionId).toBe(agent.activeVersionId);
  });

  it('does not mint a version for an update that changes nothing', async () => {
    const { agent, model } = await agentWithModel();

    const same = await harness.agentService.update(CONTROL_TENANT, agent.id, {
      instructions: 'Be brief.',
      modelId: model.id,
    });

    expect(same.versions).toHaveLength(1);
  });

  it('leaves the earlier version readable after a change', async () => {
    const { agent } = await agentWithModel();
    const v1Id = agent.activeVersionId!;

    await harness.agentService.update(CONTROL_TENANT, agent.id, {
      instructions: 'Something else entirely.',
    });

    // The version is immutable, which is what makes a pin a guarantee rather than a hope.
    const v1 = await harness.agents.findVersionById(CONTROL_TENANT, v1Id);
    expect(v1!.config).toMatchObject({ instructions: 'Be brief.' });
  });

  it('turns a concurrent-update race into a retryable conflict, not a 500', async () => {
    const { agent } = await agentWithModel();

    // The repository raises this when the compare-and-swap on `version` matches no rows —
    // which is what happens when someone else's update landed first. The loser must get a
    // 409 they can retry, rather than the `P2002` a blind `version + 1` would produce.
    const { AgentVersionConflict } = await import('../src/repositories/agent.repo.js');
    const original = harness.agents.applyUpdate.bind(harness.agents);
    harness.agents.applyUpdate = async () => {
      throw new AgentVersionConflict(agent.id, 1);
    };

    const err = await apiErrorFrom(() =>
      harness.agentService.update(CONTROL_TENANT, agent.id, { instructions: 'Racy' }),
    );

    expect(err.code).toBe('CONFLICT');
    expect(err.details).toMatchObject({ expectedVersion: 1 });

    harness.agents.applyUpdate = original;
  });
});

describe('archiving', () => {
  it('archives an agent and stamps the time', async () => {
    const { agent } = await agentWithModel();

    const archived = await harness.agentService.archive(CONTROL_TENANT, agent.id);

    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();
  });

  it('refuses to edit an archived agent', async () => {
    const { agent } = await agentWithModel();
    await harness.agentService.archive(CONTROL_TENANT, agent.id);

    // The version history is what an audit reads, so adding versions to a retired agent is
    // noise at best.
    const err = await apiErrorFrom(() =>
      harness.agentService.update(CONTROL_TENANT, agent.id, { instructions: 'Nope' }),
    );

    expect(err.code).toBe('CONFLICT');
  });

  it('refuses to leave an archived agent', async () => {
    const { agent } = await agentWithModel();
    await harness.agentService.archive(CONTROL_TENANT, agent.id);

    const err = await apiErrorFrom(() =>
      harness.agentService.setStatus(CONTROL_TENANT, agent.id, 'active'),
    );

    expect(err.code).toBe('CONFLICT');
  });
});

describe('duplicating', () => {
  it('creates a new row at version 1, not a new version of the original', async () => {
    const { agent, model } = await agentWithModel();
    await harness.agentService.update(CONTROL_TENANT, agent.id, { instructions: 'Edited.' });

    const copy = await harness.agentService.duplicate(CONTROL_TENANT, agent.id);

    expect(copy.id).not.toBe(agent.id);
    expect(copy.versions).toHaveLength(1);
    expect(copy.versions[0]!.version).toBe(1);
    // The config comes across...
    expect(copy.instructions).toBe('Edited.');
    expect(copy.modelId).toBe(model.id);
    // ...but not the lifecycle: duplicating a live agent must not silently create a second
    // live agent.
    expect(copy.status).toBe('draft');
    expect(copy.counts.runs).toBe(0);
  });

  it('suffixes the name by default and accepts one when given', async () => {
    const { agent } = await agentWithModel('Reporter');

    expect((await harness.agentService.duplicate(CONTROL_TENANT, agent.id)).name).toBe(
      'Reporter (copy)',
    );
    expect(
      (await harness.agentService.duplicate(CONTROL_TENANT, agent.id, 'Understudy')).name,
    ).toBe('Understudy');
  });

  it('gives the copy its own version numbering', async () => {
    const { agent } = await agentWithModel();
    const copy = await harness.agentService.duplicate(CONTROL_TENANT, agent.id);

    const edited = await harness.agentService.update(CONTROL_TENANT, copy.id, {
      instructions: 'Copy-specific.',
    });

    // The original is untouched and the copy is at 2 — the two histories are independent.
    expect(edited.versions).toHaveLength(2);
    expect((await harness.agentService.get(CONTROL_TENANT, agent.id)).versions).toHaveLength(1);
  });
});

describe('reading agents', () => {
  it('counts what the agent owns, from real queries', async () => {
    const { agent } = await agentWithModel();

    const goal = await harness.goalService.create(CONTROL_TENANT, {
      title: 'A goal',
      agentId: agent.id,
    });
    await harness.taskService.create(CONTROL_TENANT, {
      title: 'A task',
      triggerType: 'immediate',
      agentId: agent.id,
      goalId: goal.id,
    });

    const detail = await harness.agentService.get(CONTROL_TENANT, agent.id);

    expect(detail.counts.goals).toBe(1);
    expect(detail.counts.tasks).toBe(1);
    // The immediate task started a run, and that run names the agent.
    expect(detail.counts.runs).toBe(1);
  });

  it('filters by status, treating "all" as no filter', async () => {
    const { agent } = await agentWithModel('Active one');
    await harness.agentService.setStatus(CONTROL_TENANT, agent.id, 'active');
    await agentWithModel('Draft one');

    expect(await harness.agentService.list(CONTROL_TENANT, { status: 'active' })).toHaveLength(1);
    expect(await harness.agentService.list(CONTROL_TENANT, { status: 'all' })).toHaveLength(2);
  });

  it('does not expose another tenant’s agent', async () => {
    const foreign = await harness.agentService.create(OTHER_TENANT, { name: 'Theirs' });

    const err = await apiErrorFrom(() => harness.agentService.get(CONTROL_TENANT, foreign.id));
    expect(err.code).toBe('NOT_FOUND');
  });

  it('does not let another tenant edit an agent', async () => {
    const mine = await harness.agentService.create(CONTROL_TENANT, { name: 'Mine' });

    const err = await apiErrorFrom(() =>
      harness.agentService.update(OTHER_TENANT, mine.id, { instructions: 'Hijacked' }),
    );

    expect(err.code).toBe('NOT_FOUND');
    expect((await harness.agentService.get(CONTROL_TENANT, mine.id)).instructions).toBe('');
  });

  it('does not let another tenant read an agent’s version by id', async () => {
    const { agent } = await agentWithModel();

    // A version id is not a capability: the read re-checks the owning agent's tenant.
    expect(await harness.agents.findVersionById(OTHER_TENANT, agent.activeVersionId!)).toBeNull();
  });
});
