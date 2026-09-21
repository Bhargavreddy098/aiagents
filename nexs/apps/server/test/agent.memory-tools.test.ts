import { afterEach, describe, expect, it } from 'vitest';
import { BUILTIN_SOURCE } from '../src/services/tools/builtin-tools.service.js';
import { createControlHarness, type ControlHarness } from './helpers/control-harness.js';
import { TEST_TENANT } from './helpers/engine-harness.js';

/**
 * "Agents with `memoryEnabled` get `memory_search` / `memory_store` tools automatically."
 *
 * The spec sentence is one clause long and hides a three-part chain: the agent's allowlist has to
 * name the tools, the tools have to have rows for the planner to offer, and the rows have to have
 * handlers for the invoker to run. This file asserts the first link — the other two are
 * `builtin-tools.service.test.ts` and `tools.memory.test.ts`.
 *
 * The gate is the agent's `toolIds`, which is what `RunContext.allowedToolIds` is built from, so
 * asserting on the stored allowlist is asserting on what a run will actually be offered.
 */

let harness: ControlHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

/** The ids of this tenant's built-in tools with the given names. */
async function builtinIds(h: ControlHarness, names: string[]): Promise<string[]> {
  const rows = await h.tools.list(TEST_TENANT);
  return rows
    .filter((row) => row.source === BUILTIN_SOURCE)
    .filter((row) => names.includes(row.name))
    .map((row) => row.id);
}

describe('creating an agent grants the memory tools from the flag alone', () => {
  it('grants both tools when memoryEnabled is true', async () => {
    harness = await createControlHarness();

    const agent = await harness.agentService.create(TEST_TENANT, {
      name: 'rememberer',
      memoryEnabled: true,
    });

    const memoryIds = await builtinIds(harness, ['memory_store', 'memory_search']);
    expect(memoryIds).toHaveLength(2);
    expect(new Set(agent.toolIds)).toEqual(new Set(memoryIds));
  });

  it('grants both tools when the flag is omitted, because the default is on', async () => {
    harness = await createControlHarness();

    const agent = await harness.agentService.create(TEST_TENANT, { name: 'default' });

    expect(agent.memoryEnabled).toBe(true);
    expect(agent.toolIds).toHaveLength(2);
  });

  it('grants neither when memoryEnabled is false', async () => {
    harness = await createControlHarness();

    const agent = await harness.agentService.create(TEST_TENANT, {
      name: 'forgetful',
      memoryEnabled: false,
    });

    expect(agent.toolIds).toEqual([]);
  });

  it('keeps the tools the caller named and adds the memory tools to them', async () => {
    harness = await createControlHarness();
    const calculator = await harness.seedTool({ name: 'calculator', type: 'native' });

    const agent = await harness.agentService.create(TEST_TENANT, {
      name: 'assembled',
      toolIds: [calculator.id],
      memoryEnabled: true,
    });

    const memoryIds = await builtinIds(harness, ['memory_store', 'memory_search']);
    expect(new Set(agent.toolIds)).toEqual(new Set([calculator.id, ...memoryIds]));
  });
});

describe('editing an agent moves the tools with the flag', () => {
  it('withdraws the memory tools when memoryEnabled is switched off', async () => {
    harness = await createControlHarness();
    const agent = await harness.agentService.create(TEST_TENANT, {
      name: 'toggle',
      memoryEnabled: true,
    });
    expect(agent.toolIds).toHaveLength(2);

    const updated = await harness.agentService.update(TEST_TENANT, agent.id, {
      memoryEnabled: false,
    });

    // A capability switch that left the tools in place would be one an operator could flip with
    // nothing happening — which is worse than no switch at all.
    expect(updated.toolIds).toEqual([]);
  });

  it('grants them again when memoryEnabled is switched back on', async () => {
    harness = await createControlHarness();
    const agent = await harness.agentService.create(TEST_TENANT, {
      name: 'toggle-back',
      memoryEnabled: false,
    });

    const updated = await harness.agentService.update(TEST_TENANT, agent.id, {
      memoryEnabled: true,
    });

    expect(updated.toolIds).toHaveLength(2);
    expect(new Set(updated.toolIds)).toEqual(
      new Set(await builtinIds(harness, ['memory_store', 'memory_search'])),
    );
  });

  it('leaves the allowlist alone when the edit says nothing about memory', async () => {
    harness = await createControlHarness();
    const agent = await harness.agentService.create(TEST_TENANT, {
      name: 'untouched',
      memoryEnabled: true,
    });

    const updated = await harness.agentService.update(TEST_TENANT, agent.id, {
      description: 'a new description',
    });

    expect(new Set(updated.toolIds)).toEqual(new Set(agent.toolIds));
    expect(updated.toolIds).toHaveLength(2);
  });
});
