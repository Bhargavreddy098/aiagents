import type {
  PrismaClient,
  ResearchFinding,
  ResearchProject,
  ResearchRun,
  ResearchSource,
} from '@prisma/client';
import { toJson } from './json.js';

/**
 * Research: a question, the attempts at answering it, and the evidence those attempts found.
 *
 * ## The shape, and why the child rows carry no `tenantId`
 *
 * `ResearchProject` is tenant-owned and every method that reads one takes `tenantId` first.
 * `ResearchRun`, `ResearchSource` and `ResearchFinding` are **leaf rows** — they are only ever
 * reached through their project, so they carry no `tenantId` of their own. That is the same
 * arrangement `AgentVersion`, `Step` and `ExecutionReceipt` use, and it is what the data model
 * means by "accessed only through their parent".
 *
 * The consequence is a real one and it is handled here rather than assumed: a leaf query has no
 * tenant predicate of its own to get wrong, so **the ownership check has to come from somewhere**.
 * It is a **read through the parent** — every leaf method resolves the run, and every run method
 * resolves the project, against `tenantId` first, and refuses when the chain does not lead back to
 * this tenant.
 *
 * The other way to write it is a relation filter (`where: { project: { tenantId } }`), which
 * Prisma supports and which reads more like a single query. It is not used, for a reason worth
 * recording: the in-memory fake that every test in this repository runs against **refuses relation
 * filters by design** — it throws rather than quietly returning something plausible — so that
 * spelling would produce production code no test could exercise. A query predicate nothing can
 * verify is worth less than a read that everything can.
 */

export interface ResearchProjectCreateInput {
  tenantId: string;
  title: string;
  question: string;
  agentId: string | null;
}

export interface ResearchProjectFilters {
  status?: string;
  agentId?: string;
  limit?: number;
}

export interface ResearchProjectUpdate {
  title?: string;
  question?: string;
  agentId?: string | null;
  status?: string;
  resultRef?: string | null;
}

export interface ResearchRunCreateInput {
  /** The engine run this wraps. `null` until the run row exists. */
  runId: string | null;
  plan?: unknown;
}

export interface ResearchRunUpdate {
  status?: string;
  runId?: string | null;
  plan?: unknown;
  result?: unknown;
  completedAt?: Date | null;
}

export interface ResearchSourceCreateInput {
  url: string;
  title?: string | null;
  contentRef?: string | null;
  credibility?: string | null;
}

export interface ResearchFindingCreateInput {
  claim: string;
  evidence?: unknown;
  verified?: boolean;
  sourceIds?: string[];
}

export class ResearchRepository {
  constructor(private readonly db: PrismaClient) {}

  // ── projects ────────────────────────────────────────────────────────────────

  async createProject(data: ResearchProjectCreateInput): Promise<ResearchProject> {
    return this.db.researchProject.create({
      data: {
        tenantId: data.tenantId,
        title: data.title,
        question: data.question,
        agentId: data.agentId,
      },
    });
  }

  async findProject(tenantId: string, id: string): Promise<ResearchProject | null> {
    return this.db.researchProject.findFirst({ where: { id, tenantId } });
  }

  async listProjects(
    tenantId: string,
    filters: ResearchProjectFilters = {},
  ): Promise<ResearchProject[]> {
    return this.db.researchProject.findMany({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
      },
      orderBy: [{ createdAt: 'desc' }],
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
  }

  async countProjects(tenantId: string, filters: ResearchProjectFilters = {}): Promise<number> {
    return this.db.researchProject.count({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
      },
    });
  }

  /** `updateMany` with the tenant in the `where`, so a cross-tenant write is a no-op. */
  async updateProject(
    tenantId: string,
    id: string,
    patch: ResearchProjectUpdate,
  ): Promise<number> {
    const { count } = await this.db.researchProject.updateMany({
      where: { id, tenantId },
      data: {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.question === undefined ? {} : { question: patch.question }),
        ...(patch.agentId === undefined ? {} : { agentId: patch.agentId }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.resultRef === undefined ? {} : { resultRef: patch.resultRef }),
      },
    });
    return count;
  }

  async removeProject(tenantId: string, id: string): Promise<boolean> {
    const { count } = await this.db.researchProject.deleteMany({ where: { id, tenantId } });
    return count === 1;
  }

  // ── runs, reached through the project ───────────────────────────────────────

  /**
   * Create a run under a project this tenant owns.
   *
   * `null` when it does not. A create has no `where` clause to filter, so the ownership check is
   * necessarily a read first — and returning `null` rather than throwing keeps this layer from
   * deciding what a missing project means over HTTP.
   */
  async createRun(
    tenantId: string,
    projectId: string,
    data: ResearchRunCreateInput,
  ): Promise<ResearchRun | null> {
    if ((await this.findProject(tenantId, projectId)) === null) return null;

    return this.db.researchRun.create({
      data: {
        projectId,
        runId: data.runId,
        ...(data.plan === undefined ? {} : { plan: toJson(data.plan) }),
      },
    });
  }

  async listRuns(tenantId: string, projectId: string): Promise<ResearchRun[]> {
    // Through the parent: no project of this tenant, no runs to list. An empty array rather than a
    // throw, because "this project has no runs" and "this project is not yours" are the same answer
    // to the only question being asked, and the service has already refused the second case.
    if ((await this.findProject(tenantId, projectId)) === null) return [];

    return this.db.researchRun.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'desc' }],
    });
  }

  /**
   * A run this tenant owns, or `null`.
   *
   * Two hops, because a run carries no `tenantId`: read the run, then prove its project is this
   * tenant's. The alternative — trusting the caller to have checked — is exactly the assumption
   * that makes a leaf row reachable across a tenant boundary.
   */
  async findRun(tenantId: string, runId: string): Promise<ResearchRun | null> {
    const run = await this.db.researchRun.findUnique({ where: { id: runId } });
    if (run === null) return null;
    return (await this.findProject(tenantId, run.projectId)) === null ? null : run;
  }

  /**
   * The research run wrapping an engine run, or `null`.
   *
   * This is how the protocol's executor finds its own row: the queue delivers an *engine* run id,
   * and `ResearchRun.runId` is the link back. `findFirst` rather than `findUnique` because the
   * column is deliberately not unique — a re-run of a project creates a second research run, and
   * only one of them ever wraps a given engine run, but that is an invariant rather than a
   * constraint the database enforces.
   *
   * Ownership is the same two-hop read as `findRun`: a research run has no `tenantId`, so the
   * project is what proves it. A `findFirst` on `runId` alone would let a caller read another
   * tenant's run by guessing an engine run id.
   */
  async findRunByEngineRunId(tenantId: string, engineRunId: string): Promise<ResearchRun | null> {
    const run = await this.db.researchRun.findFirst({ where: { runId: engineRunId } });
    if (run === null) return null;
    return (await this.findProject(tenantId, run.projectId)) === null ? null : run;
  }

  async updateRun(tenantId: string, runId: string, patch: ResearchRunUpdate): Promise<number> {
    // `updateMany` cannot filter through a relation in Prisma, so ownership is proven first and
    // the write is then scoped by the id alone. The window between the two is not a hazard here:
    // a project cannot change tenant, so a run that was this tenant's a moment ago still is.
    if ((await this.findRun(tenantId, runId)) === null) return 0;

    const { count } = await this.db.researchRun.updateMany({
      where: { id: runId },
      data: {
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.runId === undefined ? {} : { runId: patch.runId }),
        ...(patch.plan === undefined ? {} : { plan: toJson(patch.plan) }),
        ...(patch.result === undefined ? {} : { result: toJson(patch.result) }),
        ...(patch.completedAt === undefined ? {} : { completedAt: patch.completedAt }),
      },
    });
    return count;
  }

  // ── sources and findings, reached through the run ───────────────────────────

  async listSources(tenantId: string, runId: string): Promise<ResearchSource[]> {
    if ((await this.findRun(tenantId, runId)) === null) return [];

    return this.db.researchSource.findMany({
      where: { runId },
      orderBy: [{ accessedAt: 'asc' }],
    });
  }

  /** `null` when the run is not this tenant's — see `createRun`. */
  async addSource(
    tenantId: string,
    runId: string,
    data: ResearchSourceCreateInput,
  ): Promise<ResearchSource | null> {
    if ((await this.findRun(tenantId, runId)) === null) return null;

    return this.db.researchSource.create({
      data: {
        runId,
        url: data.url,
        title: data.title ?? null,
        contentRef: data.contentRef ?? null,
        credibility: data.credibility ?? null,
      },
    });
  }

  async listFindings(tenantId: string, runId: string): Promise<ResearchFinding[]> {
    if ((await this.findRun(tenantId, runId)) === null) return [];

    return this.db.researchFinding.findMany({ where: { runId } });
  }

  async addFinding(
    tenantId: string,
    runId: string,
    data: ResearchFindingCreateInput,
  ): Promise<ResearchFinding | null> {
    if ((await this.findRun(tenantId, runId)) === null) return null;

    return this.db.researchFinding.create({
      data: {
        runId,
        claim: data.claim,
        evidence: toJson(data.evidence ?? []),
        verified: data.verified ?? false,
        sourceIds: data.sourceIds ?? [],
      },
    });
  }
}
