import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@nexs/shared';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';

/**
 * The goal-completion gate.
 *
 * The Phase 6 acceptance criterion is: **"goal cannot be marked completed without a passing
 * verification."** That single sentence hides four distinct ways a caller could try to get
 * around it, and each has its own test below:
 *
 *  - naming no verification at all;
 *  - naming one that does not exist (or belongs to another tenant);
 *  - naming one that exists but **failed**;
 *  - naming one that passed but was not a check *of this goal* — either because it is a
 *    `step`-scope check, or because it is attributed to a different goal.
 *
 * The distinction between the last two matters and is easy to get wrong. A `schema`
 * verification that passed proves something about a step's output. Accepting it as evidence
 * about a goal would write a `completedVerificationId` that names a check which never judged
 * the goal — worse than no gate, because the row would *look* verified.
 */

let harness: ControlHarness;

beforeEach(async () => {
  harness = await createControlHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/** A goal moved to `active`, which is the only status that may reach `completed`. */
async function activeGoal(title = 'Ship the report'): Promise<string> {
  const goal = await harness.goalService.create(CONTROL_TENANT, { title });
  await harness.goalService.setStatus(CONTROL_TENANT, goal.id, { status: 'active' });
  return goal.id;
}

/** Run a call and return the `ApiError` it threw, failing if it did not throw one. */
async function apiErrorFrom(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the call to throw an ApiError, but it resolved');
}

describe('the completion gate', () => {
  it('refuses to complete a goal with no verification named', async () => {
    const goalId = await activeGoal();

    const err = await apiErrorFrom(() =>
      harness.goalService.setStatus(CONTROL_TENANT, goalId, { status: 'completed' }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'completedVerificationId' });

    const goal = await harness.goalService.get(CONTROL_TENANT, goalId);
    expect(goal.status).toBe('active');
    expect(goal.completedVerificationId).toBeNull();
  });

  it('refuses to complete a goal against a verification that does not exist', async () => {
    const goalId = await activeGoal();

    const err = await apiErrorFrom(() =>
      harness.goalService.setStatus(CONTROL_TENANT, goalId, {
        status: 'completed',
        completedVerificationId: 'vrf_does_not_exist',
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect((await harness.goalService.get(CONTROL_TENANT, goalId)).status).toBe('active');
  });

  it('refuses to complete a goal against a verification that failed', async () => {
    const goalId = await activeGoal();
    const failedId = await harness.seedFailedVerification({ goalId });

    const err = await apiErrorFrom(() =>
      harness.goalService.setStatus(CONTROL_TENANT, goalId, {
        status: 'completed',
        completedVerificationId: failedId,
      }),
    );

    expect(err.code).toBe('CONFLICT');
    expect((await harness.goalService.get(CONTROL_TENANT, goalId)).status).toBe('active');
  });

  it('refuses a step-scope verification, even though it passed', async () => {
    const goalId = await activeGoal();

    // A passing check — but of a step's output, not of the goal.
    const stepCheck = await harness.verifications.create({
      tenantId: CONTROL_TENANT,
      type: 'schema',
      scope: 'step',
      config: { check: 'step' },
    });
    await harness.verifications.complete(CONTROL_TENANT, stepCheck.id, {
      passed: true,
      evidence: {},
    });

    const err = await apiErrorFrom(() =>
      harness.goalService.setStatus(CONTROL_TENANT, goalId, {
        status: 'completed',
        completedVerificationId: stepCheck.id,
      }),
    );

    expect(err.code).toBe('CONFLICT');
    expect(err.details).toMatchObject({ scope: 'step' });
  });

  it('refuses a passing verification that belongs to a different goal', async () => {
    const goalId = await activeGoal('Goal A');
    const otherGoalId = await activeGoal('Goal B');

    const otherGoalsEvidence = await harness.seedPassingVerification({ goalId: otherGoalId });

    const err = await apiErrorFrom(() =>
      harness.goalService.setStatus(CONTROL_TENANT, goalId, {
        status: 'completed',
        completedVerificationId: otherGoalsEvidence,
      }),
    );

    expect(err.code).toBe('CONFLICT');
    expect(err.details).toMatchObject({ verificationGoalId: otherGoalId });
  });

  it('refuses a passing verification belonging to another tenant', async () => {
    const goalId = await activeGoal();
    const foreign = await harness.seedPassingVerification({ tenantId: OTHER_TENANT });

    const err = await apiErrorFrom(() =>
      harness.goalService.setStatus(CONTROL_TENANT, goalId, {
        status: 'completed',
        completedVerificationId: foreign,
      }),
    );

    // Reported as "does not exist" rather than "not yours": distinguishing the two would
    // confirm the existence of another tenant's rows.
    expect(err.code).toBe('VALIDATION_ERROR');
    expect((await harness.goalService.get(CONTROL_TENANT, goalId)).status).toBe('active');
  });

  it('completes a goal against a passing goal_criteria verification, recording which one', async () => {
    const goalId = await activeGoal();
    const verificationId = await harness.seedPassingVerification({ goalId });

    const goal = await harness.goalService.setStatus(CONTROL_TENANT, goalId, {
      status: 'completed',
      completedVerificationId: verificationId,
    });

    expect(goal.status).toBe('completed');
    // The id written back is the one the service validated, not the one it was handed —
    // the two are the same here, and the assertion pins that they stay that way.
    expect(goal.completedVerificationId).toBe(verificationId);
    expect(goal.completedAt).not.toBeNull();

    // And it survives a re-read, so this is a row and not a response shape.
    const reloaded = await harness.goalService.get(CONTROL_TENANT, goalId);
    expect(reloaded.completedVerificationId).toBe(verificationId);
  });

  it('accepts an unattributed passing verification', async () => {
    const goalId = await activeGoal();

    // The engine sets `goalId` from the run, and a run with no goal produces an
    // unattributed verification. That is not evidence about some *other* goal, so refusing
    // it would block a legitimate case.
    const unattributed = await harness.seedPassingVerification({ goalId: null });

    const goal = await harness.goalService.setStatus(CONTROL_TENANT, goalId, {
      status: 'completed',
      completedVerificationId: unattributed,
    });

    expect(goal.status).toBe('completed');
  });
});

describe('the status machine', () => {
  it('refuses to complete a draft goal without passing through active', async () => {
    const goal = await harness.goalService.create(CONTROL_TENANT, { title: 'Draft goal' });

    const err = await apiErrorFrom(() =>
      harness.goalService.setStatus(CONTROL_TENANT, goal.id, { status: 'completed' }),
    );

    expect(err.code).toBe('CONFLICT');
    expect(err.details).toMatchObject({ from: 'draft', to: 'completed' });
  });

  it('refuses a transition out of a terminal status', async () => {
    const goalId = await activeGoal();
    const verificationId = await harness.seedPassingVerification({ goalId });
    await harness.goalService.setStatus(CONTROL_TENANT, goalId, {
      status: 'completed',
      completedVerificationId: verificationId,
    });

    const err = await apiErrorFrom(() =>
      harness.goalService.setStatus(CONTROL_TENANT, goalId, { status: 'active' }),
    );

    expect(err.code).toBe('CONFLICT');
    expect(err.details).toMatchObject({ from: 'completed' });
  });

  it('refuses to edit a completed goal', async () => {
    const goalId = await activeGoal();
    const verificationId = await harness.seedPassingVerification({ goalId });
    await harness.goalService.setStatus(CONTROL_TENANT, goalId, {
      status: 'completed',
      completedVerificationId: verificationId,
    });

    // A completed goal is evidence of something that happened. Editing its criteria
    // afterwards would change what it is claimed to have achieved.
    const err = await apiErrorFrom(() =>
      harness.goalService.update(CONTROL_TENANT, goalId, { title: 'Rewritten history' }),
    );

    expect(err.code).toBe('CONFLICT');
  });

  it('refuses a status that is already current', async () => {
    const goalId = await activeGoal();

    const err = await apiErrorFrom(() =>
      harness.goalService.setStatus(CONTROL_TENANT, goalId, { status: 'active' }),
    );

    expect(err.code).toBe('CONFLICT');
  });
});

describe('references and scoping', () => {
  it('refuses a goal that names an agent which does not exist', async () => {
    const err = await apiErrorFrom(() =>
      harness.goalService.create(CONTROL_TENANT, {
        title: 'Orphan goal',
        agentId: 'agt_missing',
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ agentId: 'agt_missing' });
  });

  it('does not expose another tenant’s goal', async () => {
    const goal = await harness.goalService.create(OTHER_TENANT, { title: 'Theirs' });

    const err = await apiErrorFrom(() => harness.goalService.get(CONTROL_TENANT, goal.id));

    expect(err.code).toBe('NOT_FOUND');
  });

  it('counts the goal’s tasks from a real query', async () => {
    const goalId = await activeGoal();

    expect((await harness.goalService.get(CONTROL_TENANT, goalId)).counts.tasks).toBe(0);

    await harness.taskService.create(CONTROL_TENANT, {
      title: 'Do the thing',
      goalId,
      triggerType: 'manual',
      // A `manual` task starts a run immediately, so it needs a resolvable model.
      input: { context: { modelId: 'mdl_test' } },
    });

    expect((await harness.goalService.get(CONTROL_TENANT, goalId)).counts.tasks).toBe(1);
  });
});
