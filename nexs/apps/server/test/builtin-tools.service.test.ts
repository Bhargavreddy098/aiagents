import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { MemoryPort } from '../src/services/tools/native-tools.js';
import { BUILTIN_SOURCE, BuiltinToolService } from '../src/services/tools/builtin-tools.service.js';
import { createEngineHarness, TEST_TENANT, type EngineHarness } from './helpers/engine-harness.js';

/**
 * The rows behind the registry.
 *
 * The bug this file exists to catch is a quiet one: a tool with a handler and no row works
 * perfectly and no agent can ever call it, because the planner builds its list from the rows. Both
 * halves look finished on their own, so nothing fails — the agent simply never uses the tool.
 */

const logger = pino({ level: 'silent' });

/** The smallest thing that satisfies `MemoryPort`, so the memory tools get registered. */
const memoryPort: MemoryPort = {
  create: async (tenantId, input) => ({
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
  }),
  search: async () => ({ memories: [], mode: 'keyword' }),
};

let harness: EngineHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

function serviceFor(h: EngineHarness): BuiltinToolService {
  return new BuiltinToolService({ tools: h.tools, native: h.nativeTools, logger });
}

describe('BuiltinToolService.ensure', () => {
  it('creates exactly one row per tool the registry exposes', async () => {
    harness = await createEngineHarness();
    const service = serviceFor(harness);

    const rows = await service.ensure(TEST_TENANT);
    const builtins = rows.filter((row) => row.source === BUILTIN_SOURCE);

    // Derived from the registry, so the two cannot disagree about which tools exist.
    expect(builtins.map((row) => row.name).sort()).toEqual(
      harness.nativeTools.list().map((tool) => tool.name).sort(),
    );
    expect(builtins.every((row) => row.type === 'native')).toBe(true);
    expect(builtins.every((row) => row.provider === 'native')).toBe(true);
    expect(builtins.every((row) => row.status === 'enabled')).toBe(true);
  });

  it('is idempotent — a second call writes nothing', async () => {
    harness = await createEngineHarness();
    const service = serviceFor(harness);

    await service.ensure(TEST_TENANT);
    const afterFirst = await harness.tools.list(TEST_TENANT);

    const second = await service.ensure(TEST_TENANT);

    expect(second).toHaveLength(afterFirst.length);
  });

  it('does not switch a tool back on that an operator turned off', async () => {
    harness = await createEngineHarness();
    const service = serviceFor(harness);
    await service.ensure(TEST_TENANT);

    const calculator = await harness.tools.findBySourceAndName(
      TEST_TENANT,
      BUILTIN_SOURCE,
      'calculator',
    );
    expect(calculator).not.toBeNull();
    await harness.tools.setStatus(TEST_TENANT, calculator!.id, 'disabled');

    await service.ensure(TEST_TENANT);

    // `upsert` would rewrite `status: 'enabled'` here. A setting that silently reverts is worse
    // than one that is missing, because the operator has already stopped looking.
    const after = await harness.tools.findBySourceAndName(TEST_TENANT, BUILTIN_SOURCE, 'calculator');
    expect(after!.status).toBe('disabled');
  });

  it('keeps rows per tenant', async () => {
    harness = await createEngineHarness();
    const service = serviceFor(harness);

    await service.ensure(TEST_TENANT);

    expect(await harness.tools.list('another-tenant')).toEqual([]);
  });

  it('omits the memory tools when no store is wired', async () => {
    harness = await createEngineHarness();
    const names = (await serviceFor(harness).ensure(TEST_TENANT)).map((row) => row.name);

    // No handler, so no row. The alternative is a row the model can call and nothing can run.
    expect(names).not.toContain('memory_store');
    expect(names).not.toContain('memory_search');
  });

  it('includes the memory tools when a store is wired', async () => {
    harness = await createEngineHarness({ memory: memoryPort });
    const names = (await serviceFor(harness).ensure(TEST_TENANT)).map((row) => row.name);

    expect(names).toContain('memory_store');
    expect(names).toContain('memory_search');
  });
});

describe('BuiltinToolService.idsFor', () => {
  it('returns the ids of the tools it was asked for', async () => {
    harness = await createEngineHarness();
    const service = serviceFor(harness);

    const ids = await service.idsFor(TEST_TENANT, ['calculator', 'date_time']);
    const rows = await harness.tools.list(TEST_TENANT);
    const expected = rows
      .filter((row) => row.source === BUILTIN_SOURCE)
      .filter((row) => ['calculator', 'date_time'].includes(row.name))
      .map((row) => row.id);

    expect(ids.sort()).toEqual(expected.sort());
    expect(ids).toHaveLength(2);
  });

  it('answers with an empty array for a tool this deployment does not have', async () => {
    harness = await createEngineHarness();
    const service = serviceFor(harness);

    // Not an error: `memory_search` genuinely does not exist without a store, and "none of the
    // tools you named exist" is the honest answer to the question that was asked.
    await expect(service.idsFor(TEST_TENANT, ['memory_store', 'web_search'])).resolves.toEqual([]);
  });

  it('creates the rows on the way, so a caller never has to ensure first', async () => {
    harness = await createEngineHarness({ memory: memoryPort });

    const ids = await serviceFor(harness).idsFor(TEST_TENANT, ['memory_store']);

    expect(ids).toHaveLength(1);
    const row = await harness.tools.findById(TEST_TENANT, ids[0]!);
    expect(row?.name).toBe('memory_store');
  });
});
