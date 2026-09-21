import { beforeEach, describe, expect, it } from 'vitest';
import { AgentRepository, readAgentConfigSnapshot } from '../src/repositories/agent.repo.js';
import type { Agent, AgentVersion } from '@prisma/client';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * Agent versioning, tested against the real repository.
 *
 * The rule this file exists to defend: **a version row is written whenever the agent's
 * behaviour changes, and only then.** Both halves matter. Missing a version means a run
 * cannot say which configuration it used; minting one for a rename means the versions that
 * matter are buried under versions that do not.
 */

const at = new Date('2026-01-01T00:00:00.000Z');

let fake: FakeDb;
let agents: AgentRepository;

beforeEach(() => {
  fake = createFakeDb();
  fake.tenants.push(
    { id: 'tnt_a', name: 'Tenant A', createdAt: at, updatedAt: at },
    { id: 'tnt_b', name: 'Tenant B', createdAt: at, updatedAt: at },
  );
  agents = new AgentRepository(fake.client);
});

const config = {
  instructions: 'You are a test agent.',
  modelId: 'mdl_1',
  fallbackModelId: null,
  toolIds: ['tol_1'],
  mcpServerIds: [],
  connectorAccountIds: [],
  memoryEnabled: true,
  browserAccess: false,
  sandboxAccess: false,
  approvalPolicy: { mode: 'none' },
  executionLimits: { maxSteps: 25 },
};

async function seedAgent(overrides: Partial<Parameters<AgentRepository['create']>[0]> = {}) {
  return agents.create({
    tenantId: 'tnt_a',
    name: 'Researcher',
    description: null,
    status: 'draft',
    ...config,
    ...overrides,
  });
}

describe('creating an agent', () => {
  it('writes version 1 and points the agent at it', async () => {
    const { agent, version } = await seedAgent();

    expect(agent.version).toBe(1);
    expect(version).not.toBeNull();
    expect(version!.version).toBe(1);
    // The pointer is set in the same transaction as the row it points at, so it can never
    // name a version that was not written.
    expect(agent.activeVersionId).toBe(version!.id);
  });

  it('snapshots the behaviour-defining config, and only that', async () => {
    const { version } = await seedAgent();
    const snapshot = readAgentConfigSnapshot(version!.config);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.instructions).toBe(config.instructions);
    expect(snapshot!.toolIds).toEqual(['tol_1']);

    // The name is deliberately absent: renaming does not change what a run does, and
    // including it would make every rename mint a version.
    expect(version!.config).not.toHaveProperty('name');
    expect(version!.config).not.toHaveProperty('status');
    expect(version!.config).not.toHaveProperty('id');
  });
});

describe('updating an agent', () => {
  it('mints a new version when the configuration changes', async () => {
    const { agent } = await seedAgent();

    const result = await agents.applyUpdate('tnt_a', agent.id, {
      instructions: 'You are a *different* test agent.',
    });

    expect(result).not.toBeNull();
    expect(result!.version).not.toBeNull();
    expect(result!.version!.version).toBe(2);
    expect(result!.agent.version).toBe(2);
    expect(result!.agent.activeVersionId).toBe(result!.version!.id);

    const history = await agents.listVersions('tnt_a', agent.id);
    expect(history.map((row) => row.version)).toEqual([2, 1]);
  });

  it('does not mint a version for a rename', async () => {
    const { agent } = await seedAgent();

    const result = await agents.applyUpdate('tnt_a', agent.id, { name: 'Renamed' });

    expect(result).not.toBeNull();
    // The write happened…
    expect(result!.agent.name).toBe('Renamed');
    // …and the version did not move.
    expect(result!.version).toBeNull();
    expect(result!.agent.version).toBe(1);
  });

  it('leaves the previous version row untouched', async () => {
    const { agent, version: v1 } = await seedAgent();
    const before = readAgentConfigSnapshot(v1!.config);

    await agents.applyUpdate('tnt_a', agent.id, { instructions: 'Changed.' });

    // Re-read the original row. A snapshot that could be edited would not be a snapshot,
    // and "which config did this run use?" would have no answer.
    const reread = await agents.findVersionById('tnt_a', v1!.id);
    expect(readAgentConfigSnapshot(reread!.config)).toEqual(before);
    expect(readAgentConfigSnapshot(reread!.config)!.instructions).toBe(config.instructions);
  });

  it('builds the new snapshot from the whole row, not from the patch', async () => {
    const { agent } = await seedAgent();

    await agents.applyUpdate('tnt_a', agent.id, { instructions: 'Changed.' });

    const active = await agents.findActiveVersion('tnt_a', agent.id);
    const snapshot = readAgentConfigSnapshot(active!.config);

    // A patch that set one field must not produce a snapshot missing the other ten.
    expect(snapshot!.instructions).toBe('Changed.');
    expect(snapshot!.modelId).toBe('mdl_1');
    expect(snapshot!.toolIds).toEqual(['tol_1']);
    expect(snapshot!.memoryEnabled).toBe(true);
    expect(snapshot!.approvalPolicy).toEqual({ mode: 'none' });
  });

  it('returns null for an agent that is not this tenant’s', async () => {
    const { agent } = await seedAgent();

    const result = await agents.applyUpdate('tnt_b', agent.id, { instructions: 'Hijacked.' });

    expect(result).toBeNull();
    const reread = await agents.findById('tnt_a', agent.id);
    expect(reread!.instructions).toBe(config.instructions);
  });

  it('refuses a version number that is already taken', async () => {
    const { agent } = await seedAgent();

    // Simulate a writer that bypassed the compare-and-swap and left version 2 behind. The
    // `(agentId, version)` unique constraint is the backstop for exactly this, and without
    // it the history would silently contain two different version 2s.
    fake.tables['agentVersion']!.push({
      id: 'avr_squatter',
      agentId: agent.id,
      version: 2,
      config: { instructions: 'from another writer' },
      createdAt: at,
    });

    await expect(
      agents.applyUpdate('tnt_a', agent.id, { instructions: 'Changed.' }),
    ).rejects.toThrow(/Unique constraint failed/);
  });
});

describe('tenant isolation on version rows', () => {
  it('refuses to read a version through another tenant', async () => {
    const { agent, version } = await seedAgent();

    // `AgentVersion` has no `tenantId` column — the documented exception, scoped by
    // `agentId` instead. This is the assertion that the exception is still safe: holding a
    // version id must not be a capability.
    expect(await agents.findVersionById('tnt_a', version!.id)).not.toBeNull();
    expect(await agents.findVersionById('tnt_b', version!.id)).toBeNull();
    expect(await agents.findVersionById('tnt_a', 'avr_does_not_exist')).toBeNull();

    expect(await agents.listVersions('tnt_b', agent.id)).toEqual([]);
    expect(await agents.findActiveVersion('tnt_b', agent.id)).toBeNull();
  });
});

describe('duplicating an agent', () => {
  it('produces a new agent at version 1, not a new version of the old one', async () => {
    const { agent } = await seedAgent({ status: 'active' });
    await agents.applyUpdate('tnt_a', agent.id, { instructions: 'Version two.' });

    const copy = await agents.duplicate('tnt_a', agent.id, 'Researcher (copy)');

    expect(copy).not.toBeNull();
    expect(copy!.agent.id).not.toBe(agent.id);
    expect(copy!.agent.version).toBe(1);
    expect(copy!.version!.version).toBe(1);
    // It inherits the *current* config…
    expect(readAgentConfigSnapshot(copy!.version!.config)!.instructions).toBe('Version two.');
    // …but starts as a draft. Carrying the source's `active` over would mean duplicating a
    // live agent silently creates a second live agent.
    expect(copy!.agent.status).toBe('draft');
    // And it has its own history, not the source's.
    expect(await agents.listVersions('tnt_a', copy!.agent.id)).toHaveLength(1);
  });

  it('returns null for an agent that is not this tenant’s', async () => {
    const { agent } = await seedAgent();
    expect(await agents.duplicate('tnt_b', agent.id, 'Stolen')).toBeNull();
  });
});

describe('status changes', () => {
  it('stamps archivedAt when archiving, and only when archiving', async () => {
    const { agent } = await seedAgent();

    const archived = await agents.setStatus('tnt_a', agent.id, 'archived', {
      archivedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(archived!.status).toBe('archived');
    expect(archived!.archivedAt).toEqual(new Date('2026-02-01T00:00:00.000Z'));
  });

  it('does not touch archivedAt when the caller omits it', async () => {
    const { agent } = await seedAgent();
    await agents.setStatus('tnt_a', agent.id, 'archived', { archivedAt: new Date() });

    const reactivated = await agents.setStatus('tnt_a', agent.id, 'active');
    // Archiving is terminal in the state machine, so this transition is one the *service*
    // must refuse — the repository only writes what it is told. What it must not do is
    // quietly clear the archive timestamp as a side effect of a status write.
    expect(reactivated!.archivedAt).not.toBeNull();
  });

  it('returns null for an agent that is not this tenant’s', async () => {
    const { agent } = await seedAgent();
    expect(await agents.setStatus('tnt_b', agent.id, 'disabled')).toBeNull();
  });
});

describe('listing', () => {
  it('excludes archived agents when asked, and keeps them when not', async () => {
    const live = await seedAgent({ name: 'Live' });
    const dead = await seedAgent({ name: 'Dead' });
    await agents.setStatus('tnt_a', dead.agent.id, 'archived', { archivedAt: new Date() });

    const withoutArchived = await agents.list('tnt_a', { excludeArchived: true });
    expect(withoutArchived.map((row) => row.id)).toEqual([live.agent.id]);

    const everything = await agents.list('tnt_a');
    expect(everything).toHaveLength(2);
  });

  it('never returns another tenant’s agents', async () => {
    await seedAgent();
    expect(await agents.list('tnt_b')).toEqual([]);
    expect(await agents.count('tnt_b')).toBe(0);
    expect(await agents.count('tnt_a')).toBe(1);
  });
});

describe('the composed detail view', () => {
  it('returns the agent with its version history, newest first', async () => {
    const { agent } = await seedAgent();
    await agents.applyUpdate('tnt_a', agent.id, { instructions: 'two' });
    await agents.applyUpdate('tnt_a', agent.id, { instructions: 'three' });

    const composed = await agents.findByIdWithVersions('tnt_a', agent.id);

    expect(composed).not.toBeNull();
    expect(composed!.versions.map((row: AgentVersion) => row.version)).toEqual([3, 2, 1]);
    expect((composed as Agent).id).toBe(agent.id);
  });
});
