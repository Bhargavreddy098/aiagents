/**
 * Memory contracts (spec Phase 10; UI/UX v2 §0 H10).
 *
 * A memory is what an agent carries from one run to the next. These shapes live here for the
 * same reason the rest do: the repository, the service, the HTTP boundary and the future page
 * must agree, and a scope that cannot legally be read is rejected at the boundary rather than
 * discovered in a query later.
 */

/**
 * The memory scope vocabulary.
 *
 * `scope` is *stored* as a plain string on the row, so an older build could have written a scope
 * this build has never heard of. Reading it through this list is what keeps a row like that from
 * being mislabelled — `parseMemoryScope` refuses it rather than guessing, because the scope
 * decides where a memory is allowed to be recalled.
 */
export const MEMORY_SCOPES = [
  'short_term',
  'long_term',
  'task',
  'goal',
  'agent',
  'user',
  'tenant',
  'run',
] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/** Narrow a stored scope into the vocabulary, refusing anything else. */
export function parseMemoryScope(value: unknown): MemoryScope | null {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value)
    ? (value as MemoryScope)
    : null;
}

/**
 * Which search answered a recall.
 *
 * `semantic` is pgvector cosine similarity; `keyword` is the ILIKE fallback. This is on the wire
 * rather than kept server-side because the UI's rule ("every number traces to a row") has a
 * search-side twin: a result that looks semantic but was a substring match is a false precision,
 * and the chip has to be able to say which it is.
 */
export type MemorySearchMode = 'semantic' | 'keyword';

/**
 * One memory, as the wire sees it.
 *
 * The embedding is **absent, deliberately**. It is `Unsupported("vector(1536)")` — 1536 numbers
 * of no use to a UI — and shipping it would double the payload for information nobody renders.
 * `hasEmbedding` is the one fact that matters: the row is vector-searchable, or it is not.
 */
export interface MemorySummary {
  id: string;
  /** `null` = workspace memory, visible to every agent in the tenant. See `memory.repo.ts`. */
  agentId: string | null;
  goalId: string | null;
  taskId: string | null;
  scope: string;
  content: string;
  hasEmbedding: boolean;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * A memory that came back from a *search*, with how well it matched.
 *
 * `score` is `null` for a keyword hit and a number for a semantic one, and the `null` is the
 * point rather than an omission. A substring match has no similarity to report: the only number
 * available would be invented (a flat `1.0`, say), and a fabricated score is exactly the false
 * precision the `mode` field exists to prevent — a client that sorted by it would be sorting by
 * nothing. The field is present on every hit so a consumer can branch on it instead of guessing
 * from `mode`.
 *
 * For a semantic hit it is cosine **similarity** (`1 - distance`), so higher is closer, which is
 * the direction every ranking UI assumes.
 */
export interface MemoryMatch extends MemorySummary {
  score: number | null;
}

/** The recall answer: what matched, by which search, in what scope. */
export interface MemoryRecallResult {
  memories: MemoryMatch[];
  mode: MemorySearchMode;
  /**
   * How the result was scoped — the two halves of the ranked rule, kept distinct.
   *
   * An agent's own memory and a workspace memory are returned in separate groups rather than one
   * ranked list, because "agent first, workspace after" is the *contract*, and a single list would
   * let a better-scoring workspace memory outrank the agent's own note about the thing it is doing
   * right now.
   */
  groups: { agent: MemoryMatch[]; workspace: MemoryMatch[] };
}

/**
 * A flat search answer, for the Memory page.
 *
 * Distinct from `MemoryRecallResult` on purpose. Recall is an *agent* operation and its grouping
 * is part of its meaning; a search is an *operator* operation that asked one question about one
 * workspace, and labelling those rows "agent" or "workspace" would assert a scope the query never
 * expressed. `mode` is still reported, for the same reason as in recall: a substring match
 * presented as a semantic one is a false precision.
 */
export interface MemorySearchResult {
  memories: MemoryMatch[];
  mode: MemorySearchMode;
}