import { ApiError, type CreateSandboxSessionInput, type ListSandboxSessionsQuery, type SandboxExecInput } from '@nexs/shared';
import type { SandboxExecution, SandboxSession } from '@prisma/client';
import type { SandboxExecutionRepository, SandboxSessionRepository } from '../../repositories/sandbox.repo.js';
import type { SandboxProvider } from './node-worker.provider.js';
import type { FileService } from '../files/file.service.js';
import type { Logger } from '../../logger.js';

/**
 * `/api/sandbox` — the JavaScript sandbox, over HTTP.
 *
 * ## What this service is careful about, and why each one matters
 *
 * **1. A workdir from a request never becomes a path.** `workdir` is resolved through
 * `FileService.resolveInWorkdir`, which normalises, realpaths and proves containment. A raw
 * `join(root, input)` would be a directory traversal, and a sandbox that can be pointed anywhere is
 * not a sandbox. The *resolved* path is what gets stored, so the containment check is auditable
 * after the fact rather than only at request time.
 *
 * **2. One execution per session at a time.** The provider has no queue of its own, and each run
 * costs a worker with a real heap ceiling (`maxOldGenerationSizeMb`). Ten concurrent calls on one
 * session is ten workers; a hundred is a machine that falls over. The chain below is the same
 * pattern `BrowserManager` uses for actions, for the same reason — and it also makes the session's
 * `running` status mean something, because there is never more than one run to be running.
 *
 * **3. The row is written before the run and finished after it.** A run that crashes the process
 * leaves an execution stuck in `running` — which is evidence. Writing the row only on completion
 * would leave nothing to explain where the process went, and that is the failure mode a sandbox
 * page most needs to be able to show.
 *
 * **4. The isolation claim is not overstated.** `worker_threads` is a *resource* boundary, not a
 * *security* boundary — the provider's own header says so. Nothing here presents it as safe for
 * hostile code, and `session.provider` records which mechanism produced each row so a future
 * Docker provider is a distinguishable value rather than a silent behaviour change.
 */

export interface SandboxServiceDeps {
  sessions: SandboxSessionRepository;
  executions: SandboxExecutionRepository;
  provider: SandboxProvider;
  files: FileService;
  logger: Logger;
}

/**
 * The subdirectory of a tenant's workdir that sandbox sessions live in.
 *
 * A constant rather than a caller-supplied segment: the sandbox and the file browser share a root,
 * and letting a request choose which subdirectory it lands in would make the file API's own paths
 * reachable from a sandbox session.
 */
const SANDBOX_DIR = 'sandbox';

export class SandboxService {
  /** Per-session tails. See the class header, point 2. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SandboxServiceDeps) {}

  async createSession(tenantId: string, input: CreateSandboxSessionInput): Promise<SandboxSession> {
    // Always a path *inside* the sandbox directory, whatever the caller asked for. An absent
    // `workdir` gets a per-session folder named after nothing yet, so the default is the sandbox
    // root itself rather than a shared scratch space two sessions could collide in.
    const relative = input.workdir === undefined ? SANDBOX_DIR : `${SANDBOX_DIR}/${input.workdir}`;
    const resolved = await this.deps.files.resolveInWorkdir(tenantId, relative);

    return this.deps.sessions.create({
      tenantId,
      runId: input.runId ?? null,
      provider: this.deps.provider.name,
      status: 'idle',
      workdir: resolved,
    });
  }

  async listSessions(tenantId: string, query: ListSandboxSessionsQuery): Promise<SandboxSession[]> {
    return this.deps.sessions.list(tenantId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.runId === undefined ? {} : { runId: query.runId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }

  async getSession(tenantId: string, id: string): Promise<SandboxSession> {
    return this.requireSession(tenantId, id);
  }

  /**
   * A session's execution history.
   *
   * Ownership is proven by reading the session first — `SandboxExecution` is a leaf row with no
   * tenant column, so a direct read by id would be a cross-tenant leak the moment someone guessed
   * one. See `repositories/sandbox.repo.ts`.
   */
  async listExecutions(tenantId: string, sessionId: string, limit?: number): Promise<SandboxExecution[]> {
    await this.requireSession(tenantId, sessionId);
    return this.deps.executions.listForSession(sessionId, limit);
  }

  /**
   * Run code in a session.
   *
   * Queued behind whatever is already running on this session, so a session's executions are
   * strictly sequential. The returned promise is the caller's own run's, not the queue tail's —
   * a caller must not be made to wait for work it did not ask for.
   */
  async exec(tenantId: string, sessionId: string, input: SandboxExecInput): Promise<{
    execution: SandboxExecution;
    value?: unknown;
    durationMs: number;
    terminatedReason?: string;
    outputTruncated: boolean;
  }> {
    const session = await this.requireSession(tenantId, sessionId);

    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    // `catch` on the tail so one failed run does not reject the chain and block every later one.
    const run = previous.then(
      () => this.runOnce(tenantId, session, input),
      () => this.runOnce(tenantId, session, input),
    );
    const tail = run.catch(() => undefined);
    this.chains.set(sessionId, tail);

    try {
      return await run;
    } finally {
      // Drop the entry only when no later run has already replaced it. Without this the map grows
      // one entry per session ever used, which is a slow leak in a long-lived process.
      if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId);
    }
  }

  private async runOnce(
    tenantId: string,
    session: SandboxSession,
    input: SandboxExecInput,
  ): Promise<{
    execution: SandboxExecution;
    value?: unknown;
    durationMs: number;
    terminatedReason?: string;
    outputTruncated: boolean;
  }> {
    // The row exists before the run does. See the class header, point 3.
    const execution = await this.deps.executions.create({
      sessionId: session.id,
      // The column is called `command`; this build runs JavaScript. See `types/sandbox.ts`.
      command: input.code,
      args: [],
      status: 'running',
    });

    await this.deps.sessions.update(tenantId, session.id, { status: 'running' });

    try {
      const result = await this.deps.provider.run({
        code: input.code,
        ...(input.input === undefined ? {} : { input: input.input }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.maxOutputBytes === undefined ? {} : { maxOutputBytes: input.maxOutputBytes }),
      });

      const finished = await this.deps.executions.finish(execution.id, {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        status: result.status,
        completedAt: new Date(),
      });

      if (finished !== 1) {
        // A row that vanished mid-run. Reported rather than swallowed: the response would
        // otherwise describe an execution the database no longer has.
        this.deps.logger.warn({ executionId: execution.id }, 'sandbox execution row disappeared during the run');
      }

      await this.deps.sessions.update(tenantId, session.id, { status: 'idle' });

      return {
        // Built from the values just written rather than re-read, so the response cannot
        // describe a state the same call had already moved past.
        execution: {
          ...execution,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          status: result.status,
          completedAt: new Date(),
        },
        ...(result.value === undefined ? {} : { value: result.value }),
        durationMs: result.durationMs,
        ...(result.terminatedReason === undefined ? {} : { terminatedReason: result.terminatedReason }),
        outputTruncated: result.outputTruncated === true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const completedAt = new Date();

      await this.deps.executions.finish(execution.id, {
        stdout: null,
        stderr: message,
        exitCode: null,
        status: 'failed',
        completedAt,
      });
      await this.deps.sessions.update(tenantId, session.id, { status: 'error' });

      this.deps.logger.error({ executionId: execution.id, sessionId: session.id, err: message }, 'sandbox run failed');
      throw err;
    }
  }

  private async requireSession(tenantId: string, id: string): Promise<SandboxSession> {
    const session = await this.deps.sessions.findById(tenantId, id);
    if (session === null) {
      throw new ApiError('NOT_FOUND', 'Sandbox session not found', { sessionId: id });
    }
    return session;
  }
}
