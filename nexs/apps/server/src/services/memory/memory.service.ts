import {
  ApiError,
  type CreateMemoryInput,
  type ListMemoriesQuery,
  type MemoryMatch,
  type MemoryRecallResult,
  type MemorySearchMode,
  type MemorySearchResult,
  type MemorySummary,
  type SearchMemoryQuery,
} from '@nexs/shared';
import type { Memory } from '@prisma/client';
import type { Logger } from '../../logger.js';
import type { AgentRepository } from '../../repositories/agent.repo.js';
import type { MemoryRepository, ScoredMemory } from '../../repositories/memory.repo.js';
import type { ModelRepository } from '../../repositories/model.repo.js';
import type { ModelGateway } from '../gateway/model-gateway.js';

/**
 * Memory — what an agent carries from one run to the next (spec Phase 10.1, UI/UX v2 §0 H10).
 *
 * ## The two rules this file exists to keep
 *
 * **1. Storing a memory never fails because of an embedding.** Embeddings are an *optimisation*:
 * `searchByKeyword` is always available, and the spec requires memory to work in a deployment
 * with no embedding model and no `pgvector`. So every embedding failure here — no model
 * configured, the provider rejecting the call, a vector of the wrong width — degrades to a
 * stored memory that is keyword-searchable, with the reason written into the row's `metadata`
 * and logged. Losing the memory instead would be the one outcome with no recovery path: the
 * user typed it, and the gateway's bad afternoon is not their problem.
 *
 * **2. The reported `mode` is the mode that actually answered.** `semantic` means pgvector
 * cosine similarity; `keyword` means a substring match. They are not interchangeable and the
 * wire says which one it was, because a substring match presented as a semantic one is a false
 * precision — the search-side twin of "every number traces to a row".
 *
 * ## Why there is no automatic semantic → keyword fallback on an empty result
 *
 * It is the obvious convenience and it is refused deliberately. "The embedding search found
 * nothing" and "the keyword search found nothing either" are two different facts, and silently
 * running the second would let an empty answer be reported as `keyword` when the caller asked a
 * semantic question — or, worse, let a weak substring match masquerade as a semantic hit. The
 * fallback exists for exactly one condition, the one the spec names: **no embedding model is
 * configured**. Everything else is reported as what it is.
 */

/** The port the service needs from the gateway — one method, so a test can stand in for it. */
export type MemoryGateway = Pick<ModelGateway, 'embed'>;

/**
 * The width of `Memory.embedding`, from `schema.prisma` (`vector(1536)`).
 *
 * A constant here rather than read from the model catalog because the *column* is the
 * constraint, not the catalog. A catalog entry declaring 768 dimensions does not make the column
 * accept 768 numbers — it makes that model unusable for this table, which is a thing worth
 * failing loudly about rather than discovering as an opaque Postgres error.
 */
const MEMORY_VECTOR_DIMENSION = 1536;

/** Recall feeds a prompt, so it is deliberately small: background, not the whole archive. */
const DEFAULT_RECALL_LIMIT = 10;
const DEFAULT_SEARCH_LIMIT = 20;

export interface MemoryServiceDeps {
  memories: MemoryRepository;
  agents: AgentRepository;
  models: ModelRepository;
  gateway: MemoryGateway;
  logger: Logger;
}

export interface RecallOptions {
  /** The agent recalling. Recall is an agent operation; there is no tenant-wide recall. */
  agentId: string;
  query: string;
  limit?: number;
  scope?: string;
}

export interface MemoryListResult {
  memories: MemorySummary[];
  total: number;
}

export class MemoryService {
  constructor(private readonly deps: MemoryServiceDeps) {}

  /**
   * Store a memory.
   *
   * The embedding is resolved *before* the row is written so that the dimension check happens
   * against a value we already hold, and so `metadata` can record the outcome in the same insert
   * rather than needing a follow-up update. The vector itself is written second because it needs
   * the row id — that is the only reason the two are not one operation.
   */
  async create(tenantId: string, input: CreateMemoryInput): Promise<MemorySummary> {
    // A memory attached to another tenant's agent would be invisible to that tenant (every read
    // is tenant-scoped) and would still be a row pointing across a boundary. Checked, not
    // assumed — `Memory.agentId` is a plain scalar with no FK to enforce it.
    if (input.agentId !== undefined && input.agentId !== null) {
      await this.assertAgentExists(tenantId, input.agentId);
    }

    const embedding = await this.resolveEmbedding(tenantId, input.content);

    const row = await this.deps.memories.create({
      tenantId,
      agentId: input.agentId ?? null,
      goalId: input.goalId ?? null,
      taskId: input.taskId ?? null,
      scope: input.scope ?? defaultScopeFor(input),
      content: input.content,
      metadata: { ...(input.metadata ?? {}), ...embedding.metadata },
    });

    if (embedding.vector === null) {
      return toSummary(row, false);
    }

    try {
      const written = await this.deps.memories.writeEmbedding(tenantId, row.id, embedding.vector);
      // `writeEmbedding` is an `UPDATE … WHERE id = ? AND "tenantId" = ?`, so zero rows means the
      // row is not there to update. That is a bug rather than a race worth retrying, and reporting
      // `hasEmbedding: true` would bury it behind a field no caller has a reason to doubt.
      if (written === 0) {
        this.deps.logger.warn(
          { tenantId, memoryId: row.id },
          'the embedding write matched no rows; the memory is keyword-searchable only',
        );
        return toSummary(row, false);
      }
      return toSummary(row, true);
    } catch (err) {
      // The row exists and is keyword-searchable; only its vector is missing. Reported as
      // `hasEmbedding: false` rather than assumed true, and logged, because `metadata` already
      // claims a model — so this is the one case where the two disagree and the log is the
      // record of why.
      this.deps.logger.warn(
        { err, tenantId, memoryId: row.id },
        'memory stored without its embedding; the vector write failed',
      );
      return toSummary(row, false);
    }
  }

  /** The Memory page's list, with the count that belongs beside it. */
  async list(tenantId: string, filters: ListMemoriesQuery): Promise<MemoryListResult> {
    if (filters.workspace === true && filters.agentId !== undefined) {
      throw new ApiError(
        'VALIDATION_ERROR',
        '`agentId` and `workspace` select different pools and cannot both be set',
        { fields: ['agentId', 'workspace'] },
      );
    }

    const repoFilters = {
      ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
      // `workspace: true` is the repository's `agentId: null` — the shared pool. Spelled as a
      // flag on the wire because a query string has no way to express a null.
      ...(filters.workspace === true ? { agentId: null } : {}),
      ...(filters.scope === undefined ? {} : { scope: filters.scope }),
      ...(filters.limit === undefined ? {} : { limit: filters.limit }),
      ...(filters.offset === undefined ? {} : { offset: filters.offset }),
    };

    const [rows, total] = await Promise.all([
      this.deps.memories.list(tenantId, repoFilters),
      this.deps.memories.count(tenantId, repoFilters),
    ]);

    const embedded = await this.deps.memories.idsWithEmbeddings(
      tenantId,
      rows.map((row) => row.id),
    );

    return {
      memories: rows.map((row) => toSummary(row, embedded.has(row.id))),
      total,
    };
  }

  async get(tenantId: string, id: string): Promise<MemorySummary> {
    const row = await this.deps.memories.findById(tenantId, id);
    if (row === null) throw notFound(id);

    const embedded = await this.deps.memories.idsWithEmbeddings(tenantId, [id]);
    return toSummary(row, embedded.has(id));
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const removed = await this.deps.memories.remove(tenantId, id);
    // Reported as missing rather than as a silent success: deleting something that was never
    // there is usually a client working from a stale list, and a 204 would hide that.
    if (!removed) throw notFound(id);
  }

  /**
   * The Memory page's search — one question, one workspace, a flat answer.
   *
   * Flat rather than grouped because the query did not name a scope: labelling the rows "agent"
   * or "workspace" would assert something the caller never asked.
   */
  async search(tenantId: string, query: SearchMemoryQuery): Promise<MemorySearchResult> {
    if (query.includeWorkspace === true && query.agentId === undefined) {
      throw new ApiError(
        'VALIDATION_ERROR',
        '`includeWorkspace` widens an agent\'s recall and needs an `agentId` to widen from',
        { field: 'includeWorkspace' },
      );
    }

    const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;
    const vector = await this.embedQuery(tenantId, query.q);

    if (vector !== null) {
      const rows = await this.deps.memories.searchByEmbedding(tenantId, vector, {
        ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
        ...(query.includeWorkspace === undefined ? {} : { includeWorkspace: query.includeWorkspace }),
        ...(query.scope === undefined ? {} : { scope: query.scope }),
        limit,
      });
      // Every row here came back from `WHERE embedding IS NOT NULL`, so the flag is known
      // without a second query — the one place it is free. The score comes from the query's own
      // distance, so it is a measurement rather than a placeholder.
      return { memories: rows.map(({ memory, score }) => toMatch(memory, true, score)), mode: 'semantic' };
    }

    const rows = await this.deps.memories.searchByKeyword(tenantId, query.q, {
      ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
      ...(query.includeWorkspace === undefined ? {} : { includeWorkspace: query.includeWorkspace }),
      ...(query.scope === undefined ? {} : { scope: query.scope }),
      limit,
    });

    return { memories: await this.withEmbeddingFlags(tenantId, rows), mode: 'keyword' };
  }

  /**
   * Recall, for an agent about to work (spec Phase 10.1).
   *
   * Returns the two groups **separately and in order** — the agent's own memories, then the
   * workspace pool — because that ordering is the contract. A single ranked list would let a
   * workspace memory that merely scores higher outrank the agent's own note about the thing it
   * is doing right now, which is exactly backwards.
   *
   * Two queries rather than one, for the same reason: a single query cannot return two ordered
   * groups without a `CASE` in its `ORDER BY` that no one will be able to read later.
   */
  async recall(tenantId: string, options: RecallOptions): Promise<MemoryRecallResult> {
    const limit = options.limit ?? DEFAULT_RECALL_LIMIT;
    const scope = options.scope === undefined ? {} : { scope: options.scope };
    const vector = await this.embedQuery(tenantId, options.query);

    if (vector !== null) {
      const [agent, workspace] = await Promise.all([
        this.deps.memories.searchByEmbedding(tenantId, vector, {
          agentId: options.agentId,
          ...scope,
          limit,
        }),
        this.deps.memories.searchByEmbedding(tenantId, vector, { agentId: null, ...scope, limit }),
      ]);
      const agentMatches = agent.map(({ memory, score }) => toMatch(memory, true, score));
      const workspaceMatches = workspace.map(({ memory, score }) => toMatch(memory, true, score));
      return {
        mode: 'semantic',
        groups: { agent: agentMatches, workspace: workspaceMatches },
        // The flat field repeats the two groups in their contract order rather than re-sorting
        // them: it is a convenience view of the same answer, and a second ordering would be a
        // second opinion about which memory matters.
        memories: [...agentMatches, ...workspaceMatches],
      };
    }

    const [agentRows, workspaceRows] = await Promise.all([
      this.deps.memories.searchByKeyword(tenantId, options.query, {
        agentId: options.agentId,
        ...scope,
        limit,
      }),
      this.deps.memories.searchByKeyword(tenantId, options.query, { agentId: null, ...scope, limit }),
    ]);

    const [agent, workspace] = await Promise.all([
      this.withEmbeddingFlags(tenantId, agentRows),
      this.withEmbeddingFlags(tenantId, workspaceRows),
    ]);

    return { mode: 'keyword', groups: { agent, workspace }, memories: [...agent, ...workspace] };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Attach the embedding flag to a page of keyword hits, in one lookup.
   *
   * The scores come through untouched — every one of them `null` — rather than being recomputed
   * here. The repository is where the search happened, and a second place that decides what a
   * score means is a second place that can disagree with the first.
   */
  private async withEmbeddingFlags(tenantId: string, rows: ScoredMemory[]): Promise<MemoryMatch[]> {
    const embedded = await this.deps.memories.idsWithEmbeddings(
      tenantId,
      rows.map(({ memory }) => memory.id),
    );
    return rows.map(({ memory, score }) => toMatch(memory, embedded.has(memory.id), score));
  }

  private async assertAgentExists(tenantId: string, agentId: string): Promise<void> {
    const agent = await this.deps.agents.findById(tenantId, agentId);
    if (agent === null) {
      throw new ApiError('VALIDATION_ERROR', 'The agent does not exist', { agentId });
    }
  }

  /**
   * The embedding for a *stored* memory, or the reason there is none.
   *
   * Never throws. Every branch that cannot produce a vector returns the metadata that explains
   * it, so the row itself records why it is not vector-searchable — which is the difference
   * between "this deployment has no embedding model" and "this one memory failed", and those are
   * worth telling apart from the Memory page.
   */
  private async resolveEmbedding(
    tenantId: string,
    content: string,
  ): Promise<{ vector: number[] | null; metadata: Record<string, unknown> }> {
    const model = await this.findEmbeddingModel(tenantId);
    if (model === null) {
      return { vector: null, metadata: { embeddingModel: null, embeddingSkipped: 'no embedding model configured' } };
    }

    let vector: number[];
    try {
      const response = await this.deps.gateway.embed({
        tenantId,
        modelId: model.id,
        input: [content],
      });
      const first = response.vectors[0];
      if (first === undefined) {
        return {
          vector: null,
          metadata: { embeddingModel: model.id, embeddingSkipped: 'the provider returned no vector' },
        };
      }
      vector = first;
    } catch (err) {
      this.deps.logger.warn({ err, tenantId, modelId: model.id }, 'embedding call failed; storing without a vector');
      return {
        vector: null,
        metadata: { embeddingModel: model.id, embeddingSkipped: 'the embedding call failed' },
      };
    }

    // The column is `vector(1536)`. A model that returns anything else cannot be stored in this
    // table at all, so the memory is kept and the mismatch is named — including the width the
    // catalog *claimed*, because "declared 768, returned 768, column wants 1536" and "declared
    // 1536, returned 768" are different bugs with the same symptom.
    if (vector.length !== MEMORY_VECTOR_DIMENSION) {
      const declared = declaredEmbeddingDimension(model.metadata);
      this.deps.logger.warn(
        { tenantId, modelId: model.id, returned: vector.length, declared, expected: MEMORY_VECTOR_DIMENSION },
        'embedding dimension does not match the Memory column; storing without a vector',
      );
      return {
        vector: null,
        metadata: {
          embeddingModel: model.id,
          embeddingSkipped: `dimension mismatch: model returned ${vector.length}, column requires ${MEMORY_VECTOR_DIMENSION}`,
        },
      };
    }

    return { vector, metadata: { embeddingModel: model.id } };
  }

  /**
   * The embedding for a *query*, or `null` to use the keyword search.
   *
   * Unlike `resolveEmbedding` this is not recorded anywhere — a search is not a row. A failure
   * is logged and the caller falls back, which is the same degrade-instead-of-break rule.
   */
  private async embedQuery(tenantId: string, query: string): Promise<number[] | null> {
    const model = await this.findEmbeddingModel(tenantId);
    if (model === null) return null;

    try {
      const response = await this.deps.gateway.embed({ tenantId, modelId: model.id, input: [query] });
      const vector = response.vectors[0];
      if (vector === undefined || vector.length !== MEMORY_VECTOR_DIMENSION) return null;
      return vector;
    } catch (err) {
      this.deps.logger.warn({ err, tenantId }, 'query embedding failed; falling back to keyword search');
      return null;
    }
  }

  /**
   * The tenant's embedding model, or `null`.
   *
   * `enabledOnly` because a disabled model is one an operator turned off, and quietly using it
   * anyway would make the Models page's toggle a lie. First match wins: the catalog is ordered,
   * and choosing by a heuristic would make recall depend on an ordering nobody declared.
   */
  private async findEmbeddingModel(tenantId: string) {
    const models = await this.deps.models.list(tenantId, { type: 'embedding', enabledOnly: true });
    return models[0] ?? null;
  }
}

function notFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 'The memory does not exist', { memoryId: id });
}

/**
 * The scope a memory gets when the caller did not name one.
 *
 * Derived from what the memory is *about*, which is the only signal available: a memory written
 * against a task is task-scoped, one against a goal is goal-scoped, one against an agent is that
 * agent's, and one with no subject at all is workspace-wide. `tenant` is the vocabulary's name
 * for that last case, and it is the right default for something an operator typed by hand —
 * scoping it to a random agent would hide it from everyone else.
 */
function defaultScopeFor(input: CreateMemoryInput): string {
  if (input.taskId !== undefined && input.taskId !== null) return 'task';
  if (input.goalId !== undefined && input.goalId !== null) return 'goal';
  if (input.agentId !== undefined && input.agentId !== null) return 'agent';
  return 'tenant';
}

/** `Model.metadata.embeddingDimension`, when the catalog declares a usable one. */
function declaredEmbeddingDimension(metadata: unknown): number | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>).embeddingDimension;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * A row as the wire sees it.
 *
 * `hasEmbedding` is passed in rather than read off the row because it *cannot* be read off the
 * row — `embedding` is `Unsupported` to Prisma and absent from the generated `Memory` type. See
 * `MemoryRepository.idsWithEmbeddings`.
 */
function toSummary(row: Memory, hasEmbedding: boolean): MemorySummary {
  return {
    id: row.id,
    agentId: row.agentId,
    goalId: row.goalId,
    taskId: row.taskId,
    scope: row.scope,
    content: row.content,
    hasEmbedding,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * A summary plus its match score.
 *
 * The score is threaded through rather than defaulted, because a default would have to pick a
 * number for "unknown" and any number it picked would be a lie the caller could sort by. `null`
 * is the only honest value for a keyword hit, and it survives to the wire as `null`.
 */
function toMatch(row: Memory, hasEmbedding: boolean, score: number | null): MemoryMatch {
  return { ...toSummary(row, hasEmbedding), score };
}

/** Re-exported so callers can name the search vocabulary without a second import. */
export type { MemorySearchMode };
