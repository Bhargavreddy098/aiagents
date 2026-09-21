import type { Memory, PrismaClient } from '@prisma/client';
import { toJson } from './json.js';

/**
 * Memories: what an agent carries from one run to the next (UI/UX v2 §0 H10).
 *
 * ## The scoping rule — the decision this file implements
 *
 * `Memory.agentId` is nullable, and the schema alone does not say what `null` means. Three
 * products fit the column, and picking wrong is expensive to undo because it changes both the
 * retrieval query and what the page's "scope" column means:
 *
 *  1. workspace-only — ignore `agentId`, one pool per tenant;
 *  2. agent-only — every memory belongs to one agent;
 *  3. **both, ranked** — `agentId: null` is *workspace* memory, visible to every agent in the
 *     tenant, and a set `agentId` is that agent's own memory.
 *
 * **This file implements (3).** It is the reading the column already expresses, it needs no
 * schema change, and it is the only one that neither leaks one agent's working notes into
 * another's context nor forces two agents on one team to relearn the same facts. The ranking is
 * stated exactly once, in `MemoryService.recall`: agent memories first, workspace memories after,
 * **never interleaved** — a workspace memory that merely scores higher must not outrank the
 * agent's own note about the thing it is doing right now.
 *
 * ## Two ways to search, one shape of answer
 *
 * `embedding` is `Unsupported("vector(1536)")`, so Prisma can neither write nor read it: those
 * methods use raw SQL and are the **only** raw queries in this layer. Everything else goes
 * through the client. That keeps the raw surface to a small, named set of methods a test can
 * stub, instead of spreading string SQL through the file.
 *
 * The consequence that catches people out: **`embedding` is absent from Prisma's generated
 * `Memory` type entirely**, so a client query cannot even ask whether a row has one.
 * `idsWithEmbeddings` exists for exactly that, and it is the only reason any non-search read
 * needs raw SQL at all.
 *
 * `searchByKeyword` is the fallback that is **always** available. Not a nicety: `pgvector` is an
 * extension, and a deployment without it has to degrade rather than break. Both searches return
 * `Memory[]` so the service picks one without a second rendering path.
 */

export interface CreateMemoryRow {
  tenantId: string;
  agentId: string | null;
  goalId: string | null;
  taskId: string | null;
  scope: string;
  content: string;
  /**
   * `unknown`, not `Prisma.InputJsonValue`, so the caller does not have to know how JSON is
   * stored. The conversion happens in `create`, next to the column it feeds — the same
   * arrangement `chat.repo.ts` uses for `toolCalls`. Absent means `{}`, the column's default.
   */
  metadata?: unknown;
}

export interface MemoryListFilters {
  agentId?: string | null;
  scope?: string;
  limit?: number;
  offset?: number;
}

export interface MemorySearchFilters extends MemoryListFilters {
  /** Include workspace memories (`agentId: null`) alongside this agent's own. */
  includeWorkspace?: boolean;
}

/**
 * A search hit: the row, and how well it matched.
 *
 * `score` lives here rather than on the row because it is a property of *the query*, not of the
 * memory — the same row scores differently against different vectors, and storing it would imply
 * otherwise. It is `null` for a keyword match: `ILIKE` either matches or it does not, and the only
 * number available to report would be a fabricated one. `MemoryMatch.score` on the wire keeps
 * that distinction; this is where it is produced.
 *
 * Both searches return this shape so `MemoryService` can pick one without a second rendering
 * path — which is the same reason they both return `Memory[]` rather than two different types.
 */
export interface ScoredMemory {
  memory: Memory;
  /** Cosine similarity (`1 - distance`) for a vector search; `null` for a keyword match. */
  score: number | null;
}

export class MemoryRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: CreateMemoryRow): Promise<Memory> {
    return this.db.memory.create({
      data: {
        tenantId: data.tenantId,
        agentId: data.agentId,
        goalId: data.goalId,
        taskId: data.taskId,
        scope: data.scope,
        content: data.content,
        metadata: toJson(data.metadata ?? {}),
      },
    });
  }

  async findById(tenantId: string, id: string): Promise<Memory | null> {
    return this.db.memory.findFirst({ where: { id, tenantId } });
  }

  /**
   * List memories, scoped to an agent when one is given.
   *
   * `agentId: undefined` means "everything in the workspace"; `agentId: null` means "the
   * workspace-level pool only". That is why the filter is spread conditionally rather than
   * compared — collapsing the two would leave the Memory page unable to show either of them.
   */
  async list(tenantId: string, filters: MemoryListFilters = {}): Promise<Memory[]> {
    return this.db.memory.findMany({
      where: {
        tenantId,
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
        ...(filters.scope === undefined ? {} : { scope: filters.scope }),
      },
      orderBy: [{ createdAt: 'desc' }],
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
      ...(filters.offset === undefined ? {} : { skip: filters.offset }),
    });
  }

  async count(tenantId: string, filters: MemoryListFilters = {}): Promise<number> {
    return this.db.memory.count({
      where: {
        tenantId,
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
        ...(filters.scope === undefined ? {} : { scope: filters.scope }),
      },
    });
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const { count } = await this.db.memory.deleteMany({ where: { id, tenantId } });
    return count === 1;
  }

  /**
   * Keyword search over `content` — the always-available fallback.
   *
   * `mode: 'insensitive'` is what makes this the ILIKE the schema comment promises. **The
   * in-memory fake accepts that option and treats it as case-sensitive**, so no test here can
   * prove the case-insensitivity; only Postgres can. That is stated rather than glossed over,
   * because it is exactly the kind of gap a green suite would otherwise imply was covered.
   *
   * Every hit's `score` is `null`. There is no similarity to report — a substring either matched
   * or it did not — and a flat `1.0` would let a caller rank keyword hits against semantic ones
   * on a number that means nothing.
   */
  async searchByKeyword(
    tenantId: string,
    query: string,
    filters: MemorySearchFilters = {},
  ): Promise<ScoredMemory[]> {
    const rows = await this.db.memory.findMany({
      where: {
        tenantId,
        content: { contains: query, mode: 'insensitive' },
        ...this.agentScope(filters),
        ...(filters.scope === undefined ? {} : { scope: filters.scope }),
      },
      orderBy: [{ createdAt: 'desc' }],
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
    return rows.map((memory) => ({ memory, score: null }));
  }

  /**
   * Write an embedding. Raw SQL, because the column is `Unsupported` to Prisma.
   *
   * The vector is passed as a parameter and cast in SQL rather than interpolated: the dimension
   * is then checked by Postgres against the column type, which is the only authoritative place.
   * `Model.embeddingDimension` is a declaration; the column is the constraint.
   */
  async writeEmbedding(tenantId: string, id: string, vector: readonly number[]): Promise<number> {
    const literal = toVectorLiteral(vector);
    return this.db.$executeRaw`
      UPDATE "Memory" SET embedding = ${literal}::vector
      WHERE id = ${id} AND "tenantId" = ${tenantId}
    `;
  }

  /**
   * Cosine-similarity search. Raw SQL, for the same reason as `writeEmbedding`.
   *
   * **Four literal queries instead of one composed one**, and that is the point: a raw query is
   * the single place in this codebase where tenant isolation is *not* structural, so each variant
   * is written so the `"tenantId" = …` predicate is visible in the same line as the table it
   * filters. A composed query with a conditional fragment is exactly where that predicate gets
   * dropped by a branch nobody reads.
   *
   * `<=>` is cosine distance, matching the `vector_cosine_ops` HNSW index the migration comment
   * specifies. The operator and the index must agree, or the query silently falls back to a scan.
   *
   * The distance is **selected, not just ordered by**. Ordering alone would leave the caller with
   * a correctly sorted list and no way to say how close any of it was — which is precisely the
   * number `memory_search` promises the model. Selecting it into `_distance` and ordering by that
   * alias computes it once. `1 - distance` is the similarity the caller gets, so higher is closer.
   */
  async searchByEmbedding(
    tenantId: string,
    vector: readonly number[],
    filters: MemorySearchFilters = {},
  ): Promise<ScoredMemory[]> {
    const literal = toVectorLiteral(vector);
    const limit = filters.limit ?? 20;

    if (filters.agentId === undefined) {
      return scoredByDistance(await this.db.$queryRaw<DistanceRow[]>`
        SELECT *, (embedding <=> ${literal}::vector) AS _distance FROM "Memory"
        WHERE "tenantId" = ${tenantId} AND embedding IS NOT NULL
        ORDER BY _distance LIMIT ${limit}`);
    }

    if (filters.agentId === null) {
      return scoredByDistance(await this.db.$queryRaw<DistanceRow[]>`
        SELECT *, (embedding <=> ${literal}::vector) AS _distance FROM "Memory"
        WHERE "tenantId" = ${tenantId} AND "agentId" IS NULL AND embedding IS NOT NULL
        ORDER BY _distance LIMIT ${limit}`);
    }

    if (filters.includeWorkspace === true) {
      return scoredByDistance(await this.db.$queryRaw<DistanceRow[]>`
        SELECT *, (embedding <=> ${literal}::vector) AS _distance FROM "Memory"
        WHERE "tenantId" = ${tenantId} AND ("agentId" = ${filters.agentId} OR "agentId" IS NULL)
          AND embedding IS NOT NULL
        ORDER BY _distance LIMIT ${limit}`);
    }

    return scoredByDistance(await this.db.$queryRaw<DistanceRow[]>`
      SELECT *, (embedding <=> ${literal}::vector) AS _distance FROM "Memory"
      WHERE "tenantId" = ${tenantId} AND "agentId" = ${filters.agentId}
        AND embedding IS NOT NULL
      ORDER BY _distance LIMIT ${limit}`);
  }

  /**
   * Which of these memories actually carry an embedding.
   *
   * Raw SQL, and it has to be: `embedding` is `Unsupported` to Prisma, so it is **not a field on
   * the generated `Memory` type** and no client query can select it, compare it, or even
   * acknowledge it. `MemorySummary.hasEmbedding` therefore cannot be derived from a row — it has
   * to be looked up.
   *
   * One query for a whole page rather than one per row, and only the id comes back: the vector
   * itself is 1536 numbers nobody here wants. The `::text[]` cast is explicit because an
   * untyped parameter leaves Postgres guessing at `= ANY($1)`, and guessing wrong turns this
   * into a runtime type error rather than a compile-time one.
   *
   * Returns a `Set` because every caller's next move is `set.has(id)`.
   */
  async idsWithEmbeddings(tenantId: string, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();

    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Memory"
      WHERE "tenantId" = ${tenantId} AND embedding IS NOT NULL AND id = ANY(${ids}::text[])`;

    return new Set(rows.map((row) => row.id));
  }

  /**
   * The agent-scope predicate, in one place so the two searches cannot disagree about it.
   *
   * `includeWorkspace: true` widens to the agent's own memories **plus** the workspace pool; the
   * default is only the agent's own. No `agentId` at all is the whole tenant — what the Memory
   * page needs, and what an agent never does.
   */
  private agentScope(filters: MemorySearchFilters): Record<string, unknown> {
    if (filters.agentId === undefined) return {};
    if (filters.agentId === null) return { agentId: null };
    return filters.includeWorkspace === true
      ? { OR: [{ agentId: filters.agentId }, { agentId: null }] }
      : { agentId: filters.agentId };
  }
}

/**
 * `number[]` → the `[1,2,3]` literal pgvector accepts.
 *
 * `Number(value)` per element is not defensive padding: a `NaN` in the array would make Postgres
 * reject the whole statement with a parse error that names the column rather than the value, and
 * coercing here turns a confusing 500 into a wrong-but-valid vector that the dimension check then
 * catches. The dimension check is the one that matters.
 */
function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => Number(value)).join(',')}]`;
}

/**
 * A `SELECT *` row plus the cosine distance the query asked for alongside it.
 *
 * `_distance` is prefixed with an underscore because it is not a column: it exists for the length
 * of one function, and the name should not be mistaken for part of the `Memory` model.
 */
type DistanceRow = Memory & { _distance: number };

/**
 * Distance rows → scored hits.
 *
 * `Number(...)` around the distance is not defensive padding: the driver's treatment of a
 * `double precision` is not something this file should assume, and `1 - '0.2'` is `NaN` — a score
 * that would sort unpredictably and read as a bug in the *search* rather than in this line.
 *
 * The distance is stripped from the row before it is handed back, so the returned `memory` is a
 * real `Memory` and nothing downstream can start depending on a field the database will not
 * always produce.
 */
function scoredByDistance(rows: DistanceRow[]): ScoredMemory[] {
  return rows.map(({ _distance, ...memory }) => ({
    memory: memory as Memory,
    score: 1 - Number(_distance),
  }));
}