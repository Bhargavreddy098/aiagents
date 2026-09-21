import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';
import { AgentRepository } from '../src/repositories/agent.repo.js';
import { MemoryRepository } from '../src/repositories/memory.repo.js';
import { ModelRepository } from '../src/repositories/model.repo.js';
import { MemoryService, type MemoryGateway } from '../src/services/memory/memory.service.js';

/**
 * `MemoryService`, driven through the real repositories against the in-memory fake.
 *
 * ## What the fake can and cannot prove here
 *
 * `Memory.embedding` is `Unsupported("vector(1536)")`, so every read or write of it is raw SQL,
 * and **the fake does not emulate raw SQL** — `$queryRaw` returns whatever the test's `rawQuery`
 * hook returns. That is not a gap to paper over; it is the reason the hooks below exist and the
 * reason this file is explicit about which layer each assertion is really testing:
 *
 *  - the **scoping, defaulting, degrade-instead-of-fail and grouping** rules are the service's and
 *    are tested for real, through the real repository and the real fake;
 *  - the **SQL itself** — the cosine operator, the `::text[]` cast, `ORDER BY _distance` — is not
 *    exercised at all here and cannot be. Only Postgres can. Saying so is the point: a green run
 *    of this file is not evidence the query is correct.
 */

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const DIMENSION = 1536;

const logger = pino({ level: 'silent' });

/** A deterministic vector of the right width. The values are irrelevant; the length is not. */
function vector(seed: number, length = DIMENSION): number[] {
  return Array.from({ length }, (_, index) => Math.sin(seed + index));
}

interface Harness {
  db: FakeDb;
  service: MemoryService;
  memories: MemoryRepository;
  /** Calls the service made to the gateway, so a test can assert *whether* it embedded. */
  embedCalls: Array<{ tenantId: string; modelId: string }>;
  /** Set what the next `embed` call does. `Error` makes it reject. */
  setEmbed(next: number[][] | Error): void;
  /** Ids the raw-SQL embedding probe reports as carrying a vector. */
  embedded: Set<string>;
  /** Rows the raw-SQL distance search returns, nearest first. */
  semantic: Array<{ id: string; distance: number }>;
  /** Rows the next raw write claims to have affected. `0` models "the row was not there". */
  writeResult: { value: number };
  /** Create an embedding model for a tenant, so `findEmbeddingModel` can find one. */
  seedEmbeddingModel(tenantId: string, options?: { dimension?: number; enabled?: boolean }): Promise<string>;
  seedAgent(tenantId: string, name?: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const embedCalls: Harness['embedCalls'] = [];
  const embedded = new Set<string>();
  const semantic: Array<{ id: string; distance: number }> = [];
  let next: number[][] | Error = [vector(0)];
  const writeResult = { value: 1 };

  // `const`, even though the raw-query hook below reads `db`: the hook only runs when a query is
  // made, which is long after this line has finished, so the binding is initialised by then.
  const db = createFakeDb({
    rawQuery: (sql) => {
      // The distance search. The fake has no query planner, so the test names the rows and their
      // distances and the assertions are about what the service does with them.
      //
      // The scope predicate has to be modelled, because the repository emits a different literal
      // query per scope and *that* is what recall's two groups depend on. The three shapes it
      // emits are matched on below; a fourth would fall through to "everything", which would make
      // a grouping assertion fail loudly rather than pass wrongly.
      if (sql.includes('<=>')) {
        const table = db.tables['memory'] ?? [];
        const workspaceOnly = sql.includes('"agentId" IS NULL');
        const ownOnly = !workspaceOnly && sql.includes('"agentId" = ');

        const rows: Array<Record<string, unknown>> = [];
        for (const { id, distance } of semantic) {
          const row = table.find((candidate) => candidate['id'] === id);
          if (row === undefined) continue;
          if (workspaceOnly && row['agentId'] !== null) continue;
          if (ownOnly && row['agentId'] === null) continue;
          rows.push({ ...row, _distance: distance });
        }
        return rows;
      }
      // The embedding probe, which only ever asks for ids.
      if (sql.includes('id = ANY')) {
        return [...embedded].map((id) => ({ id }));
      }
      return [];
    },
    // `1`, not the default `0`: the service treats "matched no rows" as a failed write, and the
    // default would make every embedding look like it failed.
    executeRaw: () => writeResult.value,
  });

  const memories = new MemoryRepository(db.client);
  const agents = new AgentRepository(db.client);
  const models = new ModelRepository(db.client);

  const gateway: MemoryGateway = {
    embed: async (request) => {
      embedCalls.push({ tenantId: request.tenantId, modelId: request.modelId });
      if (next instanceof Error) throw next;
      return {
        vectors: next,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        modelId: request.modelId,
        providerId: 'provider-1',
        costEstimate: 0,
      };
    },
  };

  const service = new MemoryService({ memories, agents, models, gateway, logger });

  return {
    db,
    service,
    memories,
    embedCalls,
    embedded,
    semantic,
    writeResult,
    setEmbed: (value) => {
      next = value;
    },
    seedEmbeddingModel: async (tenantId, options = {}) => {
      const provider = await db.client.modelProvider.create({
        data: { tenantId, name: 'test', slug: 'test', type: 'openai', status: 'healthy' },
      });
      const model = await db.client.model.create({
        data: {
          tenantId,
          providerId: provider.id,
          name: 'embed-small',
          externalModelId: 'text-embedding-3-small',
          type: 'embedding',
          enabled: options.enabled ?? true,
          metadata: { embeddingDimension: options.dimension ?? DIMENSION },
        },
      });
      return model.id;
    },
    seedAgent: async (tenantId, name = 'agent') => {
      const agent = await db.client.agent.create({ data: { tenantId, name } });
      return agent.id;
    },
    cleanup: async () => {
      await db.client.$disconnect();
    },
  };
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('MemoryService — storing never fails because of an embedding', () => {
  it('stores the memory with no vector when the tenant has no embedding model', async () => {
    const summary = await harness.service.create(TENANT, { content: 'the sky is blue' });

    expect(summary.hasEmbedding).toBe(false);
    expect(summary.content).toBe('the sky is blue');
    expect(summary.metadata).toMatchObject({
      embeddingModel: null,
      embeddingSkipped: 'no embedding model configured',
    });
    // The gateway is the thing that costs money; it must not have been called.
    expect(harness.embedCalls).toEqual([]);
  });

  it('stores the vector and records the model when the dimensions match', async () => {
    const modelId = await harness.seedEmbeddingModel(TENANT);

    const summary = await harness.service.create(TENANT, { content: 'a durable fact' });

    expect(summary.hasEmbedding).toBe(true);
    expect(summary.metadata).toMatchObject({ embeddingModel: modelId });
    expect(harness.embedCalls).toEqual([{ tenantId: TENANT, modelId }]);
  });

  it('keeps the memory and names the mismatch when the model returns the wrong width', async () => {
    // 768 is a real embedding width — it is just not *this* column's.
    await harness.seedEmbeddingModel(TENANT, { dimension: 768 });
    harness.setEmbed([vector(1, 768)]);

    const summary = await harness.service.create(TENANT, { content: 'wrong width' });

    expect(summary.hasEmbedding).toBe(false);
    expect(summary.metadata).toMatchObject({
      embeddingSkipped: `dimension mismatch: model returned 768, column requires ${DIMENSION}`,
    });
  });

  it('keeps the memory when the provider call fails', async () => {
    await harness.seedEmbeddingModel(TENANT);
    harness.setEmbed(new Error('provider is having a bad afternoon'));

    const summary = await harness.service.create(TENANT, { content: 'survives an outage' });

    expect(summary.hasEmbedding).toBe(false);
    expect(summary.metadata).toMatchObject({ embeddingSkipped: 'the embedding call failed' });
    // The row exists. Losing it would be the one outcome with no recovery path.
    const stored = await harness.memories.findById(TENANT, summary.id);
    expect(stored).not.toBeNull();
  });

  it('ignores a disabled embedding model rather than quietly using it', async () => {
    await harness.seedEmbeddingModel(TENANT, { enabled: false });

    const summary = await harness.service.create(TENANT, { content: 'no model, then' });

    expect(summary.hasEmbedding).toBe(false);
    expect(harness.embedCalls).toEqual([]);
  });

  it('reports hasEmbedding false when the vector write matches no row', async () => {
    await harness.seedEmbeddingModel(TENANT);
    // `UPDATE … WHERE id = ?` affecting zero rows means the row is not there to update.
    harness.writeResult.value = 0;

    const summary = await harness.service.create(TENANT, { content: 'the row is gone' });

    expect(summary.hasEmbedding).toBe(false);
    expect(summary.metadata).toMatchObject({ embeddingModel: expect.any(String) });
  });
});

describe('MemoryService — scope defaults follow what the memory is about', () => {
  it('scopes by the most specific subject the caller named', async () => {
    const agentId = await harness.seedAgent(TENANT);

    const bare = await harness.service.create(TENANT, { content: 'workspace-wide' });
    const agent = await harness.service.create(TENANT, { content: 'agent note', agentId });
    const goal = await harness.service.create(TENANT, { content: 'goal note', goalId: 'g1' });
    const task = await harness.service.create(TENANT, { content: 'task note', taskId: 't1' });

    expect(bare.scope).toBe('tenant');
    expect(agent.scope).toBe('agent');
    expect(goal.scope).toBe('goal');
    // `task` wins over the goal it may belong to: it is the narrower subject.
    expect(task.scope).toBe('task');
  });

  it('refuses to attach a memory to an agent in another tenant', async () => {
    const foreignAgent = await harness.seedAgent(OTHER_TENANT);

    await expect(
      harness.service.create(TENANT, { content: 'borrowed', agentId: foreignAgent }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('MemoryService — tenant isolation is the acceptance criterion', () => {
  it('hides one tenant\'s memories from another on get and on list', async () => {
    const mine = await harness.service.create(TENANT, { content: 'mine' });
    await harness.service.create(OTHER_TENANT, { content: 'theirs' });

    await expect(harness.service.get(OTHER_TENANT, mine.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const listed = await harness.service.list(OTHER_TENANT, {});
    expect(listed.total).toBe(1);
    expect(listed.memories.map((memory) => memory.content)).toEqual(['theirs']);
  });

  it('refuses to delete another tenant\'s memory', async () => {
    const mine = await harness.service.create(TENANT, { content: 'mine' });

    await expect(harness.service.remove(OTHER_TENANT, mine.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Still there.
    expect((await harness.service.list(TENANT, {})).total).toBe(1);
  });
});

describe('MemoryService — list filters', () => {
  it('rejects an agentId and a workspace flag together rather than picking one', async () => {
    await expect(
      harness.service.list(TENANT, { agentId: 'a1', workspace: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('selects the shared pool for `workspace: true`', async () => {
    const agentId = await harness.seedAgent(TENANT);
    await harness.service.create(TENANT, { content: 'shared' });
    await harness.service.create(TENANT, { content: 'private', agentId });

    const workspace = await harness.service.list(TENANT, { workspace: true });
    expect(workspace.memories.map((memory) => memory.content)).toEqual(['shared']);

    // No filter at all is the whole tenant — what the Memory page needs.
    expect((await harness.service.list(TENANT, {})).total).toBe(2);
  });

  it('reports the embedding flag for a listed page', async () => {
    const first = await harness.service.create(TENANT, { content: 'one' });
    await harness.service.create(TENANT, { content: 'two' });
    harness.embedded.add(first.id);

    const listed = await harness.service.list(TENANT, {});
    const byId = new Map(listed.memories.map((memory) => [memory.id, memory.hasEmbedding]));

    expect(byId.get(first.id)).toBe(true);
    expect([...byId.values()].filter(Boolean)).toHaveLength(1);
  });
});

describe('MemoryService — search reports the mode that actually answered', () => {
  it('falls back to keyword search with a null score when there is no embedding model', async () => {
    await harness.service.create(TENANT, { content: 'the deploy key rotates on friday' });
    await harness.service.create(TENANT, { content: 'unrelated' });

    const result = await harness.service.search(TENANT, { q: 'deploy key' });

    expect(result.mode).toBe('keyword');
    expect(result.memories.map((memory) => memory.content)).toEqual([
      'the deploy key rotates on friday',
    ]);
    // A keyword hit has no similarity. A number here would be an invention.
    expect(result.memories[0]!.score).toBeNull();
  });

  it('reports semantic search with the cosine similarity when a model exists', async () => {
    await harness.seedEmbeddingModel(TENANT);
    const near = await harness.service.create(TENANT, { content: 'close' });
    const far = await harness.service.create(TENANT, { content: 'distant' });

    // Nearest first, as the SQL's `ORDER BY _distance` produces.
    harness.semantic.push({ id: near.id, distance: 0.1 }, { id: far.id, distance: 0.75 });

    const result = await harness.service.search(TENANT, { q: 'anything' });

    expect(result.mode).toBe('semantic');
    expect(result.memories.map((memory) => memory.id)).toEqual([near.id, far.id]);
    // `1 - distance`, so higher is closer.
    expect(result.memories[0]!.score).toBeCloseTo(0.9);
    expect(result.memories[1]!.score).toBeCloseTo(0.25);
  });

  it('rejects `includeWorkspace` with no agent to widen from', async () => {
    await expect(
      harness.service.search(TENANT, { q: 'x', includeWorkspace: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('does not silently fall back to keyword when a semantic search finds nothing', async () => {
    await harness.seedEmbeddingModel(TENANT);
    await harness.service.create(TENANT, { content: 'matches the words but not the vector' });

    // No `semantic` rows queued: the vector search genuinely returns nothing.
    const result = await harness.service.search(TENANT, { q: 'matches the words' });

    expect(result.mode).toBe('semantic');
    expect(result.memories).toEqual([]);
  });
});

describe('MemoryService — recall keeps the two pools apart', () => {
  it('returns the agent\'s own memories before the workspace pool, never interleaved', async () => {
    await harness.seedEmbeddingModel(TENANT);
    const agentId = await harness.seedAgent(TENANT);
    const own = await harness.service.create(TENANT, { content: 'own', agentId });
    const shared = await harness.service.create(TENANT, { content: 'shared' });

    // The workspace memory scores *better* and must still come second.
    harness.semantic.push({ id: shared.id, distance: 0.05 }, { id: own.id, distance: 0.6 });

    const recalled = await harness.service.recall(TENANT, { agentId, query: 'anything' });

    expect(recalled.mode).toBe('semantic');
    expect(recalled.groups.agent.map((memory) => memory.content)).toEqual(['own']);
    expect(recalled.groups.workspace.map((memory) => memory.content)).toEqual(['shared']);
    expect(recalled.memories.map((memory) => memory.content)).toEqual(['own', 'shared']);
  });
});

describe('MemoryService — remove', () => {
  it('reports a memory that was never there rather than succeeding quietly', async () => {
    await expect(harness.service.remove(TENANT, 'nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('removes a memory it owns', async () => {
    const summary = await harness.service.create(TENANT, { content: 'temporary' });

    await harness.service.remove(TENANT, summary.id);

    expect((await harness.service.list(TENANT, {})).total).toBe(0);
  });
});
