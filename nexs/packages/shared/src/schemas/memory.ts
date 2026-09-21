import { z } from 'zod';
import { MEMORY_SCOPES } from '../types/memory.js';

/**
 * Memory input schemas.
 *
 * Same conventions as the rest of `schemas/` — every schema `.strict()`, nothing `.default()`-ed,
 * so a typo in a field name is a 400 rather than a silently ignored filter. Two rules are
 * specific to this file and both are about *not* guessing:
 *
 *  1. **`content` is required and non-empty after trimming.** An empty memory is not a small
 *     memory; it is a row that will be embedded, indexed, and then recalled as noise for every
 *     future run. Rejecting it at the boundary is cheaper than filtering it out forever.
 *  2. **`metadata` is never inferred.** It is stored as JSON, and a schema that invented a shape
 *     would be a second, weaker copy of whatever the writer meant.
 */

const id = z.string().trim().min(1);

/**
 * A query-string boolean.
 *
 * `z.coerce.boolean()` is the tempting spelling and it is wrong: it is `Boolean(value)`, so the
 * *string* `'false'` coerces to `true`. That is the worst possible failure — a filter that turns
 * itself on when the client explicitly turned it off. Enumerating the two literals makes an
 * unrecognised value a 400 instead.
 */
const queryBoolean = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

/**
 * Storing a memory.
 *
 * `scope` is optional and the service supplies the default, because the right default depends on
 * what the memory is *about* — a memory written with a `taskId` is task-scoped, one written
 * without any subject is workspace-scoped. A schema cannot see the difference; the service can.
 */
export const createMemorySchema = z
  .object({
    content: z.string().trim().min(1).max(20_000),
    scope: z.enum(MEMORY_SCOPES).optional(),
    /**
     * Absent means workspace memory, which is the correct default for something an operator
     * typed: it is not an agent's private note, and scoping it to a random agent would hide it.
     */
    agentId: id.nullable().optional(),
    goalId: id.nullable().optional(),
    taskId: id.nullable().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

/**
 * The Memory page's filters.
 *
 * `agentId` and `workspace` are two different questions and the service refuses both at once
 * rather than letting one silently win: `agentId` selects an agent's own memories, `workspace`
 * selects the shared pool (`agentId IS NULL`), and passing both is a contradiction a caller
 * should hear about.
 */
export const listMemoriesSchema = z
  .object({
    agentId: id.optional(),
    /** The workspace pool only — the rows every agent in the tenant can see. */
    workspace: queryBoolean,
    scope: z.enum(MEMORY_SCOPES).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/**
 * A recall query.
 *
 * `q` is required: a search with no query is a list, and this endpoint exists to answer a
 * question. `includeWorkspace` is the agent's own toggle — it widens an agent's recall to
 * include the shared pool, and it is meaningless without an `agentId` (there is nothing to
 * widen from), which the service rejects.
 *
 * The limit is capped well below the list cap: this feeds a prompt, and a recall that returned
 * 200 memories would spend the run's whole context budget on background.
 */
export const searchMemorySchema = z
  .object({
    q: z.string().trim().min(1).max(500),
    agentId: id.optional(),
    includeWorkspace: queryBoolean,
    scope: z.enum(MEMORY_SCOPES).optional(),
    limit: z.coerce.number().int().positive().max(50).optional(),
  })
  .strict();

export type CreateMemoryInput = z.infer<typeof createMemorySchema>;
export type ListMemoriesQuery = z.infer<typeof listMemoriesSchema>;
export type SearchMemoryQuery = z.infer<typeof searchMemorySchema>;
