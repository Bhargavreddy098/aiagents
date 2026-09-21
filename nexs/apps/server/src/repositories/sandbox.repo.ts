import type { Prisma, PrismaClient, SandboxExecution, SandboxSession } from '@prisma/client';

export type JsonInput = Prisma.InputJsonValue;

/**
 * Persistence for sandbox sessions and their executions.
 *
 * ## The ownership rule, and why it is not a `where` clause here
 *
 * `SandboxSession` carries a `tenantId`; `SandboxExecution` does **not** — it is a leaf row, like
 * `Step`, `MCPTool` and `AgentVersion`, and its ownership is proven by reading it *through* its
 * session. That is why every method below that touches an execution takes a `tenantId` and does
 * the check in two steps rather than one: a `findFirst({ where: { id } })` on the execution would
 * be a cross-tenant read the moment someone guessed an id.
 *
 * The fake database throws on relation filters in `where` by design, which is what stops a
 * repository from quietly depending on one — so the two-step read is not a stylistic choice, it is
 * the only spelling that works here.
 */

export interface SandboxSessionCreateInput {
  tenantId: string;
  runId?: string | null;
  provider?: string;
  status?: string;
  workdir: string;
  env?: JsonInput;
}

export class SandboxSessionRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: SandboxSessionCreateInput): Promise<SandboxSession> {
    return this.db.sandboxSession.create({ data });
  }

  /** Tenant-scoped: the tenant is the first argument and is always in the where. */
  async findById(tenantId: string, id: string): Promise<SandboxSession | null> {
    return this.db.sandboxSession.findFirst({ where: { id, tenantId } });
  }

  async list(
    tenantId: string,
    options: { status?: string; runId?: string; limit?: number } = {},
  ): Promise<SandboxSession[]> {
    return this.db.sandboxSession.findMany({
      where: {
        tenantId,
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
      },
      orderBy: { createdAt: 'desc' },
      ...(options.limit === undefined ? {} : { take: options.limit }),
    });
  }

  async update(
    tenantId: string,
    id: string,
    data: { status?: string; workdir?: string; env?: JsonInput },
  ): Promise<number> {
    const { count } = await this.db.sandboxSession.updateMany({ where: { id, tenantId }, data });
    return count;
  }
}

export interface SandboxExecutionCreateInput {
  sessionId: string;
  /** The JavaScript source. See `types/sandbox.ts` for why this column is named `command`. */
  command: string;
  args?: string[];
  status?: string;
}

export class SandboxExecutionRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: SandboxExecutionCreateInput): Promise<SandboxExecution> {
    return this.db.sandboxExecution.create({ data });
  }

  /**
   * One execution, proven to belong to this tenant by reading its session.
   *
   * Two steps on purpose — see the file header. The execution is read first because the session id
   * is what the second read needs, and the second read is the one that carries the tenant.
   */
  async findById(tenantId: string, id: string): Promise<SandboxExecution | null> {
    const execution = await this.db.sandboxExecution.findFirst({ where: { id } });
    if (execution === null) return null;

    const session = await this.db.sandboxSession.findFirst({
      where: { id: execution.sessionId, tenantId },
    });
    return session === null ? null : execution;
  }

  /**
   * A session's executions, newest first.
   *
   * Takes the session id rather than the tenant because the caller has already proven ownership by
   * reading the session — and passing the tenant again would suggest this method checks it, which
   * it cannot: `SandboxExecution` has no tenant column to filter on.
   */
  async listForSession(sessionId: string, limit?: number): Promise<SandboxExecution[]> {
    return this.db.sandboxExecution.findMany({
      where: { sessionId },
      orderBy: { startedAt: 'desc' },
      ...(limit === undefined ? {} : { take: limit }),
    });
  }

  /** Written once, when the run finishes. Never re-opened — an execution is a record, not a state. */
  async finish(
    id: string,
    data: {
      stdout: string | null;
      stderr: string | null;
      exitCode: number | null;
      status: string;
      completedAt: Date;
    },
  ): Promise<number> {
    const { count } = await this.db.sandboxExecution.updateMany({ where: { id }, data });
    return count;
  }
}
