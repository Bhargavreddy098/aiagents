import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectSsePayload, type SseFrame } from '@nexs/shared';
import { createEngineHarness, type EngineHarness } from './helpers/engine-harness.js';

/**
 * Every frame the engine actually emits, put through the wire check.
 *
 * ## Why this file exists when `sse-frame.test.ts` already covers the validator
 *
 * Because the two cover different halves of the same guarantee, and the half covered here cannot
 * be reached from a unit test.
 *
 * The engine emits through `EngineEmitter`, and its own `emit` **catches everything and warns**:
 * *"a subscriber that throws must not fail a run. The stream is a view of the run, not part of
 * it."* That is the right production behaviour, and it has a consequence for testing — a frame
 * the engine builds out of a database row or a tool result could be rejected by the new validator
 * and the engine's own test suite would stay green, because the throw never leaves `emit`. The
 * defect would appear as a warning line in a production log and nowhere else.
 *
 * The hub path has the opposite property: `sse-hub.test.ts` and `stream.http.test.ts` drive the
 * real encoder, so a bad frame there fails loudly. This file supplies the missing half — it runs
 * the engine over real scenarios and encodes what came out.
 *
 * ## What is asserted, and what is not
 *
 * Asserted: every frame these runs produced passes `inspectSsePayload`, and the union of the runs
 * covers the lifecycle events named below — so the check cannot quietly become vacuous if a
 * scenario stops emitting.
 *
 * Not asserted: that the *set* of events is complete. Enumerating the engine's `this.emit(` call
 * sites at runtime is not possible, so a scenario that is never written here is a frame that is
 * never checked. The three below were chosen for the payload shapes that carry the most risk —
 * a plan built from the planner, an error object assembled inline from a caught exception, and an
 * approval's risk block — rather than for line coverage of the emit sites.
 */

let harness: EngineHarness;

beforeEach(async () => {
  harness = await createEngineHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

const html = (body: string, init: ResponseInit = {}): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init });

/**
 * Encode-check every frame, naming the one that failed.
 *
 * Deliberately no `JSON.stringify` in the assertion message: a payload the validator rejects is
 * exactly the kind that can also make `JSON.stringify` throw, and a message builder that throws
 * would replace the real failure with a confusing one.
 */
function expectAllWireSafe(frames: readonly SseFrame[]): void {
  for (const frame of frames) {
    expect(inspectSsePayload(frame.name, frame.payload), frame.name).toEqual([]);
  }
}

// ── the scenarios ─────────────────────────────────────────────────────────────

/** A plan that runs to completion: the happy path, and the frames that carry a plan and an output. */
async function successfulRun(h: EngineHarness): Promise<void> {
  const tool = await h.seedTool({ name: 'calculator', capabilities: ['calculation', 'read_only'] });
  h.gateway.reply(
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

  const run = await h.seedRun({ context: { allowedToolIds: [tool.id] } });
  expect((await h.run(run.id)).status).toBe('completed');
}

/**
 * A run that fails at a verification step.
 *
 * The payload worth checking here is `run.failed`'s: its error is assembled inline from a caught
 * exception rather than read from a row, so it is the frame most likely to carry a field that was
 * `undefined` at the moment it was built.
 */
async function failedRun(h: EngineHarness): Promise<void> {
  const tool = await h.seedTool({ name: 'http_request', capabilities: ['http', 'read_only'] });
  h.gateway.reply(
    JSON.stringify([
      {
        id: 'fetch',
        description: 'GET the page',
        stepType: 'tool',
        toolId: tool.id,
        config: { url: 'https://example.com/' },
      },
      {
        id: 'check',
        description: 'expect 200',
        stepType: 'verification',
        config: { type: 'http_response', config: { expectedStatus: 200 } },
        dependsOn: ['fetch'],
      },
    ]),
  );
  h.onHttp(() => html('gone', { status: 500 }));

  const run = await h.seedRun({ context: { allowedToolIds: [tool.id] } });
  expect((await h.run(run.id)).status).toBe('failed');
}

/**
 * A run that parks for approval.
 *
 * `approval.created` carries a nested risk block (`{ level, reasons }`) — the deepest declared
 * payload an emitter builds by hand.
 */
async function parkedRun(h: EngineHarness): Promise<void> {
  const tool = await h.seedTool({
    name: 'http_request',
    capabilities: ['http', 'external_side_effect'],
  });
  h.gateway.reply(
    JSON.stringify([
      {
        id: 'send',
        description: 'Send the message',
        stepType: 'tool',
        toolId: tool.id,
        config: { url: 'https://api.test/send', method: 'POST' },
      },
    ]),
  );

  const run = await h.seedRun({
    context: { allowedToolIds: [tool.id], approvalPolicy: { mode: 'all' } },
  });
  expect((await h.run(run.id)).status).toBe('waiting_approval');
}

// ── the checks ────────────────────────────────────────────────────────────────

describe('frames the engine emits survive the wire', () => {
  it('a completed run', async () => {
    await successfulRun(harness);

    expect(harness.frames.length).toBeGreaterThan(0);
    expectAllWireSafe(harness.frames);
  });

  it('a failed run', async () => {
    await failedRun(harness);

    expect(harness.frames.map((frame) => frame.name)).toContain('run.failed');
    expectAllWireSafe(harness.frames);
  });

  it('a run parked for approval', async () => {
    await parkedRun(harness);

    expect(harness.frames.map((frame) => frame.name)).toContain('approval.created');
    expectAllWireSafe(harness.frames);
  });

  it('covers the lifecycle, so the three checks above are not vacuous', async () => {
    // The guard against this file quietly becoming a no-op: if a scenario stops emitting — a
    // refactor, a renamed event — the per-scenario tests above would still pass on an empty or
    // narrowed set of frames, and the only thing that would notice is this assertion.
    await successfulRun(harness);
    await failedRun(harness);
    await parkedRun(harness);

    const names = new Set(harness.frames.map((frame) => frame.name));

    expect([...names].sort()).toEqual(
      expect.arrayContaining([
        'run.plan_ready',
        'run.started',
        'step.started',
        'tool.started',
        'tool.completed',
        'step.completed',
        'run.completed',
        'step.failed',
        'run.failed',
        'approval.created',
      ]),
    );

    expectAllWireSafe(harness.frames);
  });
});
