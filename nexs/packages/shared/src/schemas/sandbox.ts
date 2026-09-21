import { z } from 'zod';
import { SANDBOX_SESSION_STATUSES } from '../types/sandbox.js';

/**
 * Sandbox input schemas.
 *
 * Two ceilings are enforced here rather than only in the worker, and the reason is that they are
 * different ceilings for different threats:
 *
 *  - `code`'s length cap is a **request-size** guard. The worker has no opinion about how big its
 *    own source is, so without this a single request could be a megabyte of JavaScript.
 *  - `timeoutMs` and `maxOutputBytes` are passed through to the worker, which enforces them for
 *    real. The schema caps them so a caller cannot ask for a 10-minute run or a 100 MB capture;
 *    the worker's own defaults are the floor when they are omitted.
 */

const id = z.string().trim().min(1);

/**
 * JavaScript to run.
 *
 * The worker's wrapper treats this as the **body of a function**, not a whole program — it is
 * invoked with `input` in scope. That is a property of the worker's bootstrap and cannot be
 * expressed in a schema, so it is stated here and in `SandboxRunRequest`.
 */
const code = z.string().min(1).max(200_000);

/**
 * Starting a session.
 *
 * `workdir` is accepted but **not trusted**: the service resolves it inside the tenant's sandbox
 * root and refuses anything that escapes, because a path from a request is the classic way out of
 * a jail. The column is stored resolved, which is what makes the check auditable after the fact.
 */
export const createSandboxSessionSchema = z
  .object({
    workdir: z.string().trim().min(1).max(1024).optional(),
    runId: id.nullable().optional(),
  })
  .strict();

export const listSandboxSessionsSchema = z
  .object({
    status: z.enum(SANDBOX_SESSION_STATUSES).optional(),
    runId: id.optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

export const sandboxExecSchema = z
  .object({
    code,
    /** Passed to the code as `input`. Must be structured-cloneable — enforced by the worker. */
    input: z.unknown().optional(),
    /** Capped at two minutes: a sandbox run is a tool call, not a batch job. */
    timeoutMs: z.coerce.number().int().positive().max(120_000).optional(),
    /** Capped at 4 MB. Above that the caller wants a file, not a return value. */
    maxOutputBytes: z.coerce.number().int().positive().max(4 * 1024 * 1024).optional(),
  })
  .strict();

export type CreateSandboxSessionInput = z.infer<typeof createSandboxSessionSchema>;
export type ListSandboxSessionsQuery = z.infer<typeof listSandboxSessionsSchema>;
export type SandboxExecInput = z.infer<typeof sandboxExecSchema>;
