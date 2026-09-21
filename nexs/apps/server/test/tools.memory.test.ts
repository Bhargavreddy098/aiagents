import { afterEach, describe, expect, it } from 'vitest';
import type { CreateMemoryInput, MemoryMatch, MemorySearchResult, MemorySummary, SearchMemoryQuery } from '@nexs/shared';
import { createEngineHarness, TEST_TENANT, type EngineHarness } from './helpers/engine-harness.js';
import type { MemoryPort, NativeToolContext } from '../src/services/tools/native-tools.js';

/**
 * The `memory_store` / `memory_search` native tools.
 *
 * These are driven through the registry the engine actually uses, with a recorded stand-in for the
 * memory service — because what is under test here is the *tool*: what it does with the model's
 * arguments, what it refuses, and above all where it gets the agent from. The store itself is
 * `MemoryService`'s business and is tested against the real repository in `memory.service.test.ts`.
 *
 * The stand-in is a `MemoryPort`, not a hand-written `{ create, search }`: it is a `Pick` of the
 * service, so a rename on either side breaks this file at compile time rather than at runtime.
 */

interface RecordingMemory {
  port: MemoryPort;
  created: Array<{ tenantId: string; input: CreateMemoryInput }>;
  searches: Array<{ tenantId: string; query: SearchMemoryQuery }>;
  /** What the next `search` returns. */
  matches: MemoryMatch[];
  mode: MemorySearchResult['mode'];
}

function summary(input: CreateMemoryInput): MemorySummary {
  return {
    id: 'mem-1',
    agentId: input.agentId ?? null,
    goalId: input.goalId ?? null,
    taskId: input.taskId ?? null,
    scope: input.scope ?? 'tenant',
    content: input.content,
    hasEmbedding: false,
    metadata: input.metadata ?? {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function recordingMemory(): RecordingMemory {
  const created: RecordingMemory['created'] = [];
  const searches: RecordingMemory['searches'] = [];
  const recorder: RecordingMemory = {
    created,
    searches,
    matches: [],
    mode: 'keyword',
    port: {
      create: async (tenantId, input) => {
        created.push({ tenantId, input });
        return summary(input);
      },
      search: async (tenantId, query) => {
        searches.push({ tenantId, query });
        return { memories: recorder.matches, mode: recorder.mode };
      },
    },
  };
  return recorder;
}

/** A run context. `agentId` is explicit at every call site: it is the whole subject here. */
function ctx(agentId: string | null): NativeToolContext {
  return { tenantId: TEST_TENANT, runId: null, stepId: null, agentId };
}

let harness: EngineHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

describe('registration is conditional on a store existing', () => {
  it('offers neither tool when no memory service is wired', async () => {
    harness = await createEngineHarness();
    const names = harness.nativeTools.list().map((tool) => tool.name);

    // The rule the whole file header of `native-tools.ts` is about: a model offered a tool that
    // can only fail will use it, and the failure looks like the agent's fault.
    expect(names).not.toContain('memory_store');
    expect(names).not.toContain('memory_search');
    expect(harness.nativeTools.has('memory_search')).toBe(false);
  });

  it('offers both tools together when a store is wired', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });
    const names = harness.nativeTools.list().map((tool) => tool.name);

    expect(names).toContain('memory_store');
    expect(names).toContain('memory_search');
  });
});

describe('memory_store', () => {
  it('attributes the memory to the agent the run belongs to', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });

    const result = await harness.nativeTools.execute(
      'memory_store',
      { scope: 'agent', content: 'prefers terse answers' },
      ctx('agent-7'),
    );

    expect(result).toEqual({ memoryId: 'mem-1' });
    expect(memory.created).toHaveLength(1);
    expect(memory.created[0]!.tenantId).toBe(TEST_TENANT);
    expect(memory.created[0]!.input).toMatchObject({
      content: 'prefers terse answers',
      scope: 'agent',
      agentId: 'agent-7',
    });
  });

  it('writes a workspace memory when the run has no agent', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });

    await harness.nativeTools.execute(
      'memory_store',
      { scope: 'tenant', content: 'the office wifi is called "pineapple"' },
      ctx(null),
    );

    // `null`, not a missing key: an ad-hoc run's memory belongs to the workspace, and that has to
    // be a decision rather than an omission.
    expect(memory.created[0]!.input.agentId).toBeNull();
  });

  it('refuses a scope the vocabulary does not contain', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });

    await expect(
      harness.nativeTools.execute(
        'memory_store',
        { scope: 'permanent', content: 'x' },
        ctx('agent-7'),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // Refused before the store was touched.
    expect(memory.created).toHaveLength(0);
  });

  it('refuses metadata that is not an object', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });

    // An array is `typeof 'object'`, which is exactly why this is checked rather than trusted.
    await expect(
      harness.nativeTools.execute(
        'memory_store',
        { scope: 'agent', content: 'x', metadata: ['not', 'a', 'map'] },
        ctx('agent-7'),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('is classified as a side effect, so the approval policy can see it', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });

    // The spec's own classification (§3.6). The row outlives the run, so a crash-resume must not
    // silently write it twice.
    expect(harness.nativeTools.capabilitiesFor('memory_store', {})).toEqual([
      'memory',
      'external_side_effect',
    ]);
    expect(harness.nativeTools.capabilitiesFor('memory_search', {})).toEqual(['memory']);
  });
});

describe('memory_search', () => {
  it('searches as the run\'s agent and widens to the workspace pool', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });

    await harness.nativeTools.execute('memory_search', { query: 'wifi' }, ctx('agent-7'));

    expect(memory.searches[0]!.tenantId).toBe(TEST_TENANT);
    // Without `includeWorkspace` a memory written from the Memory page would be invisible to every
    // agent it was written for, which is the opposite of what a shared pool is.
    expect(memory.searches[0]!.query).toMatchObject({
      q: 'wifi',
      agentId: 'agent-7',
      includeWorkspace: true,
    });
  });

  it('lets an explicit agentId override the run\'s own agent', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });

    await harness.nativeTools.execute(
      'memory_search',
      { query: 'wifi', agentId: 'agent-9' },
      ctx('agent-7'),
    );

    expect(memory.searches[0]!.query.agentId).toBe('agent-9');
  });

  it('reports the score and the mode that answered', async () => {
    const memory = recordingMemory();
    memory.mode = 'semantic';
    memory.matches = [
      {
        id: 'm1',
        agentId: null,
        goalId: null,
        taskId: null,
        scope: 'tenant',
        content: 'the office wifi is called "pineapple"',
        hasEmbedding: true,
        metadata: { source: 'operator' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        score: 0.91,
      },
    ];
    harness = await createEngineHarness({ memory: memory.port });

    const result = await harness.nativeTools.execute(
      'memory_search',
      { query: 'wifi' },
      ctx('agent-7'),
    );

    expect(result).toEqual({
      results: [
        { id: 'm1', content: 'the office wifi is called "pineapple"', score: 0.91, metadata: { source: 'operator' } },
      ],
      // Present so a `null` score is explained rather than mysterious.
      mode: 'semantic',
    });
  });

  it('passes a null score through rather than inventing one', async () => {
    const memory = recordingMemory();
    memory.mode = 'keyword';
    memory.matches = [
      {
        id: 'm1',
        agentId: null,
        goalId: null,
        taskId: null,
        scope: 'tenant',
        content: 'a keyword hit',
        hasEmbedding: false,
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        score: null,
      },
    ];
    harness = await createEngineHarness({ memory: memory.port });

    const result = (await harness.nativeTools.execute(
      'memory_search',
      { query: 'keyword' },
      ctx('agent-7'),
    )) as { results: Array<{ score: number | null }>; mode: string };

    expect(result.mode).toBe('keyword');
    expect(result.results[0]!.score).toBeNull();
  });

  it('clamps a limit the model asked for', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });

    await harness.nativeTools.execute('memory_search', { query: 'x', limit: 5_000 }, ctx('agent-7'));
    await harness.nativeTools.execute('memory_search', { query: 'x', limit: 0 }, ctx('agent-7'));

    // A recall feeds a prompt; an unbounded one would spend the run's whole context budget.
    expect(memory.searches[0]!.query.limit).toBe(50);
    expect(memory.searches[1]!.query.limit).toBe(1);
  });

  it('refuses a scope the vocabulary does not contain', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });

    await expect(
      harness.nativeTools.execute('memory_search', { query: 'x', scope: 'yesterday' }, ctx('agent-7')),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(memory.searches).toHaveLength(0);
  });
});

describe('the engine threads the run\'s agent into the tool context', () => {
  it('stores under the agent named on the invocation, not under the tenant', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });
    const tool = await harness.seedTool({ name: 'memory_store', type: 'native' });

    const outcome = await harness.invoker.invoke({
      tenantId: TEST_TENANT,
      agentId: 'agent-42',
      toolId: tool.id,
      args: { scope: 'agent', content: 'remember this' },
    });

    expect(outcome.ok).toBe(true);
    // The whole chain — request → native context → tool — is what this asserts. A regression in
    // `ToolInvoker.runNative` would drop the agent and make every memory workspace-wide, silently.
    expect(memory.created[0]!.input.agentId).toBe('agent-42');
  });

  it('reports a null agent for an invocation that names none', async () => {
    const memory = recordingMemory();
    harness = await createEngineHarness({ memory: memory.port });
    const tool = await harness.seedTool({ name: 'memory_store', type: 'native' });

    await harness.invoker.invoke({
      tenantId: TEST_TENANT,
      toolId: tool.id,
      args: { scope: 'tenant', content: 'no agent here' },
    });

    expect(memory.created[0]!.input.agentId).toBeNull();
  });
});
