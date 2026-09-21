import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@nexs/shared';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';

/**
 * Events: ingest, match, trigger, mark processed.
 *
 * ## The acceptance criterion, and how far it can be proven here
 *
 * Phase 11's second acceptance criterion is *"webhook event triggers subscribed workflow"*.
 * Unlike the first (a cron firing with no HTTP process), this one is almost entirely the
 * application's own behaviour: an event arrives, a subscription matches it, and a run comes
 * into existence. Nothing about it needs a live transport, so it is provable here — and the
 * tests below prove it against a **real run row read back through the repository**, not
 * against the id the service happened to return.
 *
 * What is *not* proven here is the part that belongs to the wire: that an HTTP request
 * reaches `ingest`, and that a signature is verified before it does. Routing and auth
 * ordering are covered by `control.http.test.ts`; the signature check is not built yet and
 * is not claimed.
 *
 * ## The rule every test in this file is really about
 *
 * **A duplicate delivery must not trigger anything twice.** Every webhook producer retries,
 * so a repeat is the normal case. Half the file is therefore the two directions of that
 * rule: the same `(source, externalId)` twice triggers once, and a *new* occurrence still
 * triggers — because a dedupe that is too aggressive turns a webhook into a one-shot.
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
function toolStep(name: string, toolId: string) {
  return {
    name,
    stepType: 'tool' as const,
    toolId,
    config: { expression: '1 + 1' },
  };
}

/**
 * An **active** workflow over one tool step — the target of the acceptance criterion.
 *
 * Active rather than draft because `WorkflowService.run` refuses a workflow that is not in a
 * runnable state, and a subscription firing at a draft would fail for a reason that has
 * nothing to do with events.
 */
async function activeWorkflow(tenantId = CONTROL_TENANT) {
  const tool = await harness.seedTool({ name: 'calculator', tenantId });
  const workflow = await harness.workflowService.create(tenantId, {
    name: 'Arithmetic',
    steps: [toolStep('add', tool.id)],
  });
  await harness.workflowService.setStatus(tenantId, workflow.id, 'active');
  return workflow;
}

/** A task with an agent and a model, so a run created for it is resolvable. */
async function runnableTask(tenantId = CONTROL_TENANT) {
  const model = await harness.seedModel({ tenantId, externalModelId: 'model-1' });
  const agent = await harness.agentService.create(tenantId, {
    name: 'Reporter',
    instructions: 'Be brief.',
    modelId: model.id,
  });
  const task = await harness.taskService.create(tenantId, {
    title: 'Report',
    triggerType: 'scheduled',
    scheduledAt: new Date(Date.now() + 86_400_000),
    agentId: agent.id,
  });
  return { task, agent, model };
}

/**
 * The payload an agent-less workflow needs to be startable at all.
 *
 * `WorkflowService.run` resolves the run's model from `input.context.modelId` when there is
 * no agent, and `OccurrenceStarter` passes an event's payload through as the workflow's
 * input. So for a workflow target the payload *is* the run's configuration, and an event
 * without a `context.modelId` cannot start one. That is a real property of the design, and
 * the tests below assert both halves of it: with the model it fires, without it the failure
 * is reported rather than swallowed.
 */
const WORKFLOW_PAYLOAD = { context: { modelId: 'mdl_event_test' } };

describe('events: ingest and store', () => {
  it('stores the event and marks it processed', async () => {
    const result = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      subject: 'repo/main',
      payload: { sha: 'abc123' },
    });

    expect(result.deduplicated).toBe(false);
    expect(result.event.type).toBe('build.finished');
    expect(result.event.source).toBe('ci');
    expect(result.event.subject).toBe('repo/main');
    expect(result.event.payload).toEqual({ sha: 'abc123' });

    // Processed, not left open: the matcher has finished, so nothing will pick it up again.
    expect(result.event.processedAt).not.toBeNull();
  });

  it('defaults an absent payload and metadata to empty objects', async () => {
    const result = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'ping',
      source: 'monitor',
    });

    // The stored shape is uniform without the service inventing a value the caller did not
    // send — `{}` is the empty object, not a placeholder standing in for something.
    expect(result.event.payload).toEqual({});
    expect(result.event.metadata).toEqual({});
    expect(result.event.subject).toBeNull();
    expect(result.event.externalId).toBeNull();
  });

  it('honours a producer-supplied occurredAt rather than the clock', async () => {
    const occurredAt = new Date('2026-01-02T03:04:05.000Z');
    const result = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'deploy.finished',
      source: 'cd',
      occurredAt,
    });

    // The producer knows when it happened; we only know when it arrived. Storing ours would
    // silently rewrite history on a delayed delivery.
    expect(new Date(result.event.occurredAt).getTime()).toBe(occurredAt.getTime());
  });

  it('emits event.received with the deduplicated flag', async () => {
    await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
    });

    const frame = harness.frames.find((f) => f.name === 'event.received');
    expect(frame).toBeDefined();
    expect(frame!.payload).toMatchObject({
      type: 'build.finished',
      source: 'ci',
      deduplicated: false,
    });
  });
});

describe('events: a webhook triggers a subscribed workflow', () => {
  it('creates a real run row for the workflow and hands it to the queue', async () => {
    // The acceptance criterion. "Triggers" means a run exists — so the assertion reads the
    // row back through the repository rather than trusting the id that came back.
    const workflow = await activeWorkflow();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: workflow.id,
    });

    const result = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      payload: WORKFLOW_PAYLOAD,
    });

    expect(result.matchedSubscriptions).toBe(1);
    expect(result.triggered).toBe(1);
    expect(result.failures).toEqual([]);

    const runs = await harness.runs.list(CONTROL_TENANT, { workflowId: workflow.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe('workflow');

    // And it was handed off, which is what makes it execute rather than sit queued.
    expect(harness.enqueued.map((job) => job.runId)).toContain(runs[0]!.id);
    expect(harness.enqueued[0]!.kind).toBe('workflow');
  });

  it('passes the event payload through as the run input', async () => {
    const workflow = await activeWorkflow();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: workflow.id,
    });

    await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      payload: { ...WORKFLOW_PAYLOAD, sha: 'deadbeef' },
    });

    const runs = await harness.runs.list(CONTROL_TENANT, { workflowId: workflow.id });
    const input = runs[0]!.input as Record<string, unknown>;

    // The webhook body is the run's data. A trigger that dropped it would start a workflow
    // with no idea what it was reacting to.
    expect(input['sha']).toBe('deadbeef');
    // And the plan is still the workflow's own, injected by `WorkflowService.run` — the
    // payload cannot widen it.
    expect(input['context']).toMatchObject({ modelId: 'mdl_event_test' });
    expect((input['context'] as Record<string, unknown>)['presetPlan']).toBeDefined();
  });

  it('emits event.processed once the matcher has run', async () => {
    const workflow = await activeWorkflow();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: workflow.id,
    });

    await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      payload: WORKFLOW_PAYLOAD,
    });

    const frame = harness.frames.find((f) => f.name === 'event.processed');
    expect(frame).toBeDefined();
    expect(frame!.payload).toMatchObject({ matchedSubscriptions: 1, triggered: 1 });
  });
});

describe('events: replay protection', () => {
  it('does not trigger a second run when the same delivery arrives twice', async () => {
    // The heart of the design, and the reason `externalId` exists. Every webhook producer
    // retries; a retry must be absorbed, not acted on.
    const workflow = await activeWorkflow();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: workflow.id,
    });

    const first = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      externalId: 'delivery-1',
      payload: WORKFLOW_PAYLOAD,
    });
    const second = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      externalId: 'delivery-1',
      payload: WORKFLOW_PAYLOAD,
    });

    expect(first.deduplicated).toBe(false);
    expect(first.triggered).toBe(1);

    expect(second.deduplicated).toBe(true);
    // Reporting the original outcome here would be a lie: *this* delivery caused nothing.
    expect(second.triggered).toBe(0);
    expect(second.matchedSubscriptions).toBe(0);
    // And it is the same event row, not a second one.
    expect(second.event.id).toBe(first.event.id);

    expect(await harness.runs.count(CONTROL_TENANT, { workflowId: workflow.id })).toBe(1);
  });

  it('still triggers for a different externalId', async () => {
    // The counterpart. A dedupe keyed on anything broader than the delivery id — the
    // schedule, the topic, the source — would turn a webhook into a one-shot.
    const workflow = await activeWorkflow();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: workflow.id,
    });

    await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      externalId: 'delivery-1',
      payload: WORKFLOW_PAYLOAD,
    });
    const second = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      externalId: 'delivery-2',
      payload: WORKFLOW_PAYLOAD,
    });

    expect(second.deduplicated).toBe(false);
    expect(second.triggered).toBe(1);
    expect(await harness.runs.count(CONTROL_TENANT, { workflowId: workflow.id })).toBe(2);
  });

  it('stores an event with no externalId every time, because a NULL never collides', async () => {
    // Refusing an event whose producer did not supply an id would drop real signals, so the
    // unique index is on `(tenantId, source, externalId)` and a NULL never matches. Two
    // id-less events are two events.
    const first = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'ping',
      source: 'monitor',
    });
    const second = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'ping',
      source: 'monitor',
    });

    expect(second.deduplicated).toBe(false);
    expect(second.event.id).not.toBe(first.event.id);
  });

  it('does not let one tenant’s delivery id block another tenant’s', async () => {
    // The index is `(tenantId, source, externalId)`, so two workspaces whose CI both call
    // their delivery "1" must both be stored. A tenant-blind index would silently drop one.
    const mine = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      externalId: '1',
    });
    const theirs = await harness.eventService.ingest(OTHER_TENANT, {
      type: 'build.finished',
      source: 'ci',
      externalId: '1',
    });

    expect(theirs.deduplicated).toBe(false);
    expect(theirs.event.id).not.toBe(mine.event.id);
  });
});

describe('events: matching', () => {
  it('matches on topic, and only on topic', async () => {
    const workflow = await activeWorkflow();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: workflow.id,
    });

    const result = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'deploy.finished',
      source: 'cd',
      payload: WORKFLOW_PAYLOAD,
    });

    expect(result.matchedSubscriptions).toBe(0);
    expect(result.triggered).toBe(0);
    expect(await harness.runs.count(CONTROL_TENANT, { workflowId: workflow.id })).toBe(0);
  });

  it('applies a source filter', async () => {
    const workflow = await activeWorkflow();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      filter: { source: 'ci' },
      targetKind: 'workflow',
      targetId: workflow.id,
    });

    const wrong = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'someone-else',
      payload: WORKFLOW_PAYLOAD,
    });
    expect(wrong.triggered).toBe(0);

    const right = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      payload: WORKFLOW_PAYLOAD,
    });
    expect(right.triggered).toBe(1);
  });

  it('applies a subject filter', async () => {
    const workflow = await activeWorkflow();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      filter: { subject: 'repo/main' },
      targetKind: 'workflow',
      targetId: workflow.id,
    });

    const otherBranch = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      subject: 'repo/feature',
      payload: WORKFLOW_PAYLOAD,
    });
    expect(otherBranch.triggered).toBe(0);

    const main = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      subject: 'repo/main',
      payload: WORKFLOW_PAYLOAD,
    });
    expect(main.triggered).toBe(1);
  });

  it('does not match a disabled subscription', async () => {
    const workflow = await activeWorkflow();
    const subscription = await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: workflow.id,
    });
    await harness.eventService.updateSubscription(CONTROL_TENANT, subscription.id, {
      enabled: false,
    });

    const result = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      payload: WORKFLOW_PAYLOAD,
    });

    expect(result.matchedSubscriptions).toBe(0);
    expect(await harness.runs.count(CONTROL_TENANT, { workflowId: workflow.id })).toBe(0);
  });

  it('fires every matching subscription, not just the first', async () => {
    const first = await activeWorkflow();
    const second = await activeWorkflow();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: first.id,
    });
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: second.id,
    });

    const result = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      payload: WORKFLOW_PAYLOAD,
    });

    expect(result.matchedSubscriptions).toBe(2);
    expect(result.triggered).toBe(2);
    expect(await harness.runs.count(CONTROL_TENANT, { workflowId: first.id })).toBe(1);
    expect(await harness.runs.count(CONTROL_TENANT, { workflowId: second.id })).toBe(1);
  });
});

describe('events: partial failure is reported, not swallowed', () => {
  it('triggers the working target and names the broken one', async () => {
    // One subscription pointing at a deleted workflow must not stop the other from firing,
    // and a single `triggered: 2` for three subscriptions would hide the one that failed.
    const good = await activeWorkflow();
    const doomed = await activeWorkflow();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: good.id,
    });
    const broken = await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: doomed.id,
    });
    // Removed through the client rather than through a service: there is no
    // workflow-delete API, so this is the state an out-of-band change leaves behind —
    // which is what the collected-failure path exists to report rather than swallow.
    await harness.db.workflow.delete({ where: { id: doomed.id } });

    const result = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      payload: WORKFLOW_PAYLOAD,
    });

    expect(result.matchedSubscriptions).toBe(2);
    expect(result.triggered).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.subscriptionId).toBe(broken.id);

    // The working one still fired, which is the point of collecting rather than aborting.
    expect(await harness.runs.count(CONTROL_TENANT, { workflowId: good.id })).toBe(1);
  });

  it('reports an agent-less workflow that cannot resolve a model, and still processes the event', async () => {
    // A workflow target needs a model, and an agent-less one can only get it from the
    // payload. This is a real misconfiguration a producer can create, so it must surface as
    // a named failure rather than as an event that looks processed with nothing behind it.
    const workflow = await activeWorkflow();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: workflow.id,
    });

    const result = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      // No `context.modelId`.
      payload: { sha: 'deadbeef' },
    });

    expect(result.triggered).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.reason).toMatch(/modelId/);
    // The event is marked processed anyway: it will not become startable by being retried,
    // and leaving it unprocessed would make every later sweep pick it up forever.
    expect(result.event.processedAt).not.toBeNull();
  });
});

describe('events: target kinds', () => {
  it('starts a task run and nests the payload under `trigger`', async () => {
    const { task } = await runnableTask();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'task',
      targetId: task.id,
    });

    const result = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      payload: { sha: 'deadbeef' },
    });

    expect(result.triggered).toBe(1);

    const runs = await harness.runs.list(CONTROL_TENANT, { taskId: task.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe('task');

    // Nested, not merged. A shallow merge would let a webhook body overwrite
    // `context.modelId` and break the very run it was meant to start.
    const input = runs[0]!.input as Record<string, unknown>;
    expect(input['trigger']).toEqual({ sha: 'deadbeef' });
  });

  it('does not let a webhook body overwrite the task’s own configuration', async () => {
    const { task } = await runnableTask();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'task',
      targetId: task.id,
    });

    await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      // A hostile or merely careless producer naming a model.
      payload: { context: { modelId: 'mdl_attacker' } },
    });

    const runs = await harness.runs.list(CONTROL_TENANT, { taskId: task.id });
    const input = runs[0]!.input as Record<string, unknown>;
    const context = input['context'] as Record<string, unknown> | undefined;

    // Whatever the task stored stays; the payload is quarantined under `trigger`.
    expect(context?.['modelId']).not.toBe('mdl_attacker');
  });

  it('starts an agent run with no task or workflow behind it', async () => {
    const model = await harness.seedModel({ externalModelId: 'model-1' });
    const agent = await harness.agentService.create(CONTROL_TENANT, {
      name: 'Watcher',
      instructions: 'Watch.',
      modelId: model.id,
    });
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'agent',
      targetId: agent.id,
    });

    const result = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      payload: { sha: 'deadbeef' },
    });

    expect(result.triggered).toBe(1);

    const runs = await harness.runs.list(CONTROL_TENANT, { agentId: agent.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.kind).toBe('event');
    expect(runs[0]!.taskId).toBeNull();
    expect(runs[0]!.workflowId).toBeNull();
  });
});

describe('events: subscriptions', () => {
  it('refuses a target that does not exist', async () => {
    // Checked at creation for the same reason a schedule's target is: the alternative is a
    // subscription that matches, starts nothing and reports nothing — indistinguishable
    // from a topic that simply never occurs.
    const err = await apiErrorFrom(() =>
      harness.eventService.createSubscription(CONTROL_TENANT, {
        topic: 'build.finished',
        targetKind: 'workflow',
        targetId: 'wfl_missing',
      }),
    );

    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.details).toMatchObject({ field: 'targetId' });
  });

  it('never returns the secret, only whether one is set', async () => {
    const { task } = await runnableTask();
    const withSecret = await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'task',
      targetId: task.id,
      secret: 'super-secret-hmac-key',
    });
    const without = await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'task',
      targetId: task.id,
    });

    expect(withSecret.hasSecret).toBe(true);
    expect(without.hasSecret).toBe(false);
    // An HMAC key that can be read back is one that can be used to forge the webhooks it
    // exists to authenticate, so it must not appear anywhere in the returned shape.
    expect(JSON.stringify(withSecret)).not.toContain('super-secret-hmac-key');
  });

  it('lists, filters and updates subscriptions', async () => {
    const { task } = await runnableTask();
    const subscription = await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      filter: { source: 'ci' },
      targetKind: 'task',
      targetId: task.id,
    });

    const all = await harness.eventService.listSubscriptions(CONTROL_TENANT);
    expect(all.subscriptions).toHaveLength(1);
    expect(all.subscriptions[0]!.filter).toEqual({ source: 'ci' });

    const byTopic = await harness.eventService.listSubscriptions(CONTROL_TENANT, {
      topic: 'deploy.finished',
    });
    expect(byTopic.subscriptions).toHaveLength(0);

    const updated = await harness.eventService.updateSubscription(
      CONTROL_TENANT,
      subscription.id,
      { topic: 'deploy.finished' },
    );
    expect(updated.topic).toBe('deploy.finished');
  });

  it('deletes a subscription, and refuses to delete one that is not there', async () => {
    const { task } = await runnableTask();
    const subscription = await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'task',
      targetId: task.id,
    });

    await harness.eventService.deleteSubscription(CONTROL_TENANT, subscription.id);
    expect((await harness.eventService.listSubscriptions(CONTROL_TENANT)).subscriptions).toHaveLength(
      0,
    );

    const err = await apiErrorFrom(() =>
      harness.eventService.deleteSubscription(CONTROL_TENANT, subscription.id),
    );
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('events: tenant isolation', () => {
  it('does not let another tenant’s subscription fire', async () => {
    const workflow = await activeWorkflow(CONTROL_TENANT);
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'workflow',
      targetId: workflow.id,
    });

    // Same topic, same source, different workspace: the other tenant must see nothing.
    const result = await harness.eventService.ingest(OTHER_TENANT, {
      type: 'build.finished',
      source: 'ci',
      payload: WORKFLOW_PAYLOAD,
    });

    expect(result.matchedSubscriptions).toBe(0);
    expect(await harness.runs.count(CONTROL_TENANT, { workflowId: workflow.id })).toBe(0);
  });

  it('does not list another tenant’s events', async () => {
    await harness.eventService.ingest(CONTROL_TENANT, { type: 'ping', source: 'monitor' });

    expect((await harness.eventService.list(CONTROL_TENANT)).events).toHaveLength(1);
    expect((await harness.eventService.list(OTHER_TENANT)).events).toHaveLength(0);
  });

  it('refuses to read another tenant’s event by id', async () => {
    const { event } = await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'ping',
      source: 'monitor',
    });

    const err = await apiErrorFrom(() => harness.eventService.get(OTHER_TENANT, event.id));
    expect(err.code).toBe('NOT_FOUND');
  });

  it('does not list another tenant’s subscriptions', async () => {
    const { task } = await runnableTask();
    await harness.eventService.createSubscription(CONTROL_TENANT, {
      topic: 'build.finished',
      targetKind: 'task',
      targetId: task.id,
    });

    expect((await harness.eventService.listSubscriptions(OTHER_TENANT)).subscriptions).toHaveLength(
      0,
    );
  });
});

describe('events: listing', () => {
  it('filters by type, source and processed state', async () => {
    await harness.eventService.ingest(CONTROL_TENANT, {
      type: 'build.finished',
      source: 'ci',
      subject: 'repo/main',
    });
    await harness.eventService.ingest(CONTROL_TENANT, { type: 'ping', source: 'monitor' });

    expect((await harness.eventService.list(CONTROL_TENANT)).events).toHaveLength(2);
    expect(
      (await harness.eventService.list(CONTROL_TENANT, { type: 'ping' })).events,
    ).toHaveLength(1);
    expect(
      (await harness.eventService.list(CONTROL_TENANT, { source: 'ci' })).events,
    ).toHaveLength(1);
    expect(
      (await harness.eventService.list(CONTROL_TENANT, { subject: 'repo/main' })).events,
    ).toHaveLength(1);
    // Everything ingest touches is processed by the time it returns.
    expect(
      (await harness.eventService.list(CONTROL_TENANT, { processed: true })).events,
    ).toHaveLength(2);
    expect(
      (await harness.eventService.list(CONTROL_TENANT, { processed: false })).events,
    ).toHaveLength(0);
  });

  it('refuses to read an event that does not exist', async () => {
    const err = await apiErrorFrom(() => harness.eventService.get(CONTROL_TENANT, 'evt_missing'));
    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('events: the occurrence key is a second line of defence', () => {
  it('collapses two starts of the same occurrence into one run', async () => {
    // `ingest` returns before this is ever reached, because the event row already exists.
    // But if one ingest somehow reached the same subscription twice, the run repository's
    // unique index on `(tenantId, idempotencyKey)` is what stops the second run — so it is
    // tested directly rather than left to the early return to imply.
    const workflow = await activeWorkflow();

    const first = await harness.occurrenceStarter.start({
      tenantId: CONTROL_TENANT,
      target: { kind: 'workflow', id: workflow.id },
      occurrenceKey: 'event:evt_1:sub_1',
      payload: WORKFLOW_PAYLOAD,
    });
    const second = await harness.occurrenceStarter.start({
      tenantId: CONTROL_TENANT,
      target: { kind: 'workflow', id: workflow.id },
      occurrenceKey: 'event:evt_1:sub_1',
      payload: WORKFLOW_PAYLOAD,
    });

    expect(second.runId).toBe(first.runId);
    expect(await harness.runs.count(CONTROL_TENANT, { workflowId: workflow.id })).toBe(1);
  });
});
