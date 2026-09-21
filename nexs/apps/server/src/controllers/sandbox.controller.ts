import type { RequestHandler } from 'express';
import {
  listSandboxSessionsSchema,
  type CreateSandboxSessionInput,
  type SandboxExecInput,
} from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { SandboxService } from '../services/sandbox/sandbox.service.js';
import type { SandboxExecution, SandboxSession } from '@prisma/client';

/**
 * `/api/sandbox` — the sandbox page.
 *
 * Thin by design: authenticate, parse, delegate, serialise. Every rule that could be broken — that
 * a workdir cannot escape the tenant's directory, that one session runs one thing at a time, that
 * the execution row exists before the run does — lives in `SandboxService`.
 */
export interface SandboxControllerDeps {
  sandbox: SandboxService;
}

export interface SandboxController {
  listSessions: RequestHandler;
  createSession: RequestHandler;
  getSession: RequestHandler;
  listExecutions: RequestHandler;
  exec: RequestHandler;
}

function toSessionSummary(row: SandboxSession) {
  return {
    id: row.id,
    runId: row.runId,
    provider: row.provider,
    status: row.status,
    workdir: row.workdir,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toExecutionSummary(row: SandboxExecution) {
  return {
    id: row.id,
    sessionId: row.sessionId,
    // The JavaScript source. See `types/sandbox.ts` for why the column is named `command`.
    command: row.command,
    stdout: row.stdout,
    stderr: row.stderr,
    exitCode: row.exitCode,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
  };
}

export function createSandboxController(deps: SandboxControllerDeps): SandboxController {
  return {
    listSessions: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const sessions = await deps.sandbox.listSessions(
          tenantId,
          parseQuery(listSandboxSessionsSchema, req),
        );
        res.status(200).json({ sessions: sessions.map(toSessionSummary) });
      } catch (err) {
        next(err);
      }
    },

    createSession: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        // Already parsed and replaced by `validateBody` on the route.
        const session = await deps.sandbox.createSession(tenantId, req.body as CreateSandboxSessionInput);
        res.status(201).json({ session: toSessionSummary(session) });
      } catch (err) {
        next(err);
      }
    },

    getSession: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const session = await deps.sandbox.getSession(tenantId, pathParam(req, 'id'));
        res.status(200).json({ session: toSessionSummary(session) });
      } catch (err) {
        next(err);
      }
    },

    listExecutions: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const executions = await deps.sandbox.listExecutions(tenantId, pathParam(req, 'id'));
        res.status(200).json({ executions: executions.map(toExecutionSummary) });
      } catch (err) {
        next(err);
      }
    },

    /**
     * Run code.
     *
     * 200 whether the code succeeded or reported its own failure, because both are *results* — the
     * execution row records which, and the two need different treatment downstream. A session that
     * does not exist, or a workdir that escapes, is an error response thrown by the service.
     */
    exec: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const outcome = await deps.sandbox.exec(
          tenantId,
          pathParam(req, 'id'),
          req.body as SandboxExecInput,
        );

        res.status(200).json({
          outcome: {
            execution: toExecutionSummary(outcome.execution),
            ...(outcome.value === undefined ? {} : { value: outcome.value }),
            durationMs: outcome.durationMs,
            ...(outcome.terminatedReason === undefined
              ? {}
              : { terminatedReason: outcome.terminatedReason }),
            outputTruncated: outcome.outputTruncated,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  };
}
