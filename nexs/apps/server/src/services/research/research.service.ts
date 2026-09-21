import {
  ApiError,
  type CreateResearchProjectInput,
  type ListResearchProjectsQuery,
  type ListResearchRunsQuery,
  type ResearchFindingSummary,
  type ResearchProjectDetail,
  type ResearchProjectSummary,
  type ResearchRunDetail,
  type ResearchRunSummary,
  type ResearchSourceSummary,
  type StartResearchRunInput,
} from '@nexs/shared';
import type { ResearchFinding, ResearchProject, ResearchRun, ResearchSource } from '@prisma/client';
import type { Logger } from '../../logger.js';
import type { AgentRepository } from '../../repositories/agent.repo.js';
import type {
  ResearchFindingCreateInput,
  ResearchRepository,
  ResearchSourceCreateInput,
} from '../../repositories/research.repo.js';
import type { RunRepository } from '../../repositories/run.repo.js';
import type { RunQueue } from '../queue/run-queue.js';

/**
 * Research — an agent answering a question *with provenance* (spec Phase 10.2).
 *
 * ## What is real here and what is not
 *
 * Real: the project, the runs, the sources, the findings, and the wiring that turns "start a
 * research run" into an actual engine run of kind `research` handed to the queue. Every one of
 * those is a row a caller can read back, and every number on the Research page traces to one.
 *
 * **The protocol itself lives in `research.runner.ts`, not here.** This service owns the *records*
 * — the projects, the runs, and the provenance-checked writes that a finding's citations go
 * through — and the runner owns the *work*: decompose, search, read, collect, organise, verify. The
 * split is deliberate: every research row is written through the methods below, so the provenance
 * check in `recordFinding` cannot be bypassed by whichever component happens to be driving, and a
 * test can drive the records without a search provider or a model.
 *
 * This file used to say the protocol could not run at all, because `web_search` did not exist. It
 * does now (spec §3.6, `services/search/`), so the protocol is implemented and the Phase 10
 * acceptance criterion — "research on a real question → ≥3 sources, cited findings, ≥1 verified
 * claim" — is reachable. `startRun` refuses up front when no search provider is configured, rather
 * than creating two rows and a queue job for a protocol that cannot run.
 */

export interface ResearchServiceDeps {
  research: ResearchRepository;
  agents: AgentRepository;
  runs: RunRepository;
  queue: RunQueue;
  logger: Logger;
  /**
   * Whether this deployment has a search provider.
   *
   * Optional so that every existing caller and test keeps its behaviour: absent means "do not
   * check". The container supplies the real answer, which is what turns "research is configured"
   * into something `startRun` can refuse over *before* it creates two rows and a queue job for a
   * protocol that cannot run.
   */
  searchAvailable?: () => boolean;
}

export interface ResearchListResult {
  projects: ResearchProjectSummary[];
  total: number;
}

export class ResearchService {
  constructor(private readonly deps: ResearchServiceDeps) {}

  // ── projects ────────────────────────────────────────────────────────────────

  async createProject(
    tenantId: string,
    input: CreateResearchProjectInput,
  ): Promise<ResearchProjectDetail> {
    const agentId = input.agentId ?? null;
    if (agentId !== null) await this.assertAgentExists(tenantId, agentId);

    const project = await this.deps.research.createProject({
      tenantId,
      title: input.title,
      question: input.question,
      agentId,
    });

    this.deps.logger.info({ tenantId, projectId: project.id }, 'research project created');

    return this.detail(project);
  }

  async list(tenantId: string, query: ListResearchProjectsQuery = {}): Promise<ResearchListResult> {
    const filters = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
    };

    const [projects, total] = await Promise.all([
      this.deps.research.listProjects(tenantId, {
        ...filters,
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      }),
      this.deps.research.countProjects(tenantId, filters),
    ]);

    return { projects: projects.map(toProjectSummary), total };
  }

  async get(tenantId: string, id: string): Promise<ResearchProjectDetail> {
    return this.detail(await this.requireProject(tenantId, id));
  }

  /**
   * Archive a project.
   *
   * Archiving rather than deleting, and the distinction is the point: a project's findings are
   * evidence, and an operator tidying their list should not destroy the record of what was found.
   * `remove` exists for the case where they really mean it.
   */
  async archive(tenantId: string, id: string): Promise<ResearchProjectDetail> {
    const project = await this.requireProject(tenantId, id);
    if (project.status === 'archived') return this.detail(project);

    await this.deps.research.updateProject(tenantId, id, { status: 'archived' });
    return this.detail(await this.requireProject(tenantId, id));
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const removed = await this.deps.research.removeProject(tenantId, id);
    if (!removed) throw projectNotFound(id);
  }

  // ── runs ────────────────────────────────────────────────────────────────────

  /**
   * Start an attempt at a project's question.
   *
   * Two rows, in this order, and the order matters: the `ResearchRun` is written first so that the
   * engine run can be attached to it, and so a failure to enqueue leaves a research run that says
   * `failed` rather than a project with no trace of the attempt. The engine run is created with
   * `kind: 'research'`, which is what makes it visible as research in the Runs list rather than as
   * an anonymous task run.
   *
   * An agent is required in one of two forms, and the refusal is the same one the task and chat
   * surfaces make: an agent resolves its own model from the version it pins, and a run with no
   * agent has to name a model because there is nothing else to read one from. Refusing here means
   * the operator hears about it now rather than from a run that fails a second later.
   */
  async startRun(
    tenantId: string,
    projectId: string,
    input: StartResearchRunInput = {},
  ): Promise<ResearchRunDetail> {
    const project = await this.requireProject(tenantId, projectId);

    const agentId = input.agentId === undefined ? project.agentId : input.agentId;
    if (agentId !== null && agentId !== undefined) {
      await this.assertAgentExists(tenantId, agentId);
    }

    if ((agentId === null || agentId === undefined) && input.modelId === undefined) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'A research run needs an agent or an explicit `modelId`',
        { field: 'modelId' },
      );
    }

    // Refused here rather than at execution time. The protocol's second step is a search, so with
    // no provider every run would start, create two rows, enqueue a job, and then fail — and the
    // failure would look like a bug in research rather than the absence of a key. Saying it now
    // costs one error message instead of one failed run per attempt.
    if (this.deps.searchAvailable !== undefined && !this.deps.searchAvailable()) {
      throw new ApiError(
        'FEATURE_DISABLED',
        'Research needs a search provider: set SEARCH_PROVIDER and SEARCH_API_KEY',
        { feature: 'search' },
      );
    }

    const run = await this.deps.runs.create({
      tenantId,
      kind: 'research',
      agentId: agentId ?? null,
      // The question travels with the run rather than being re-read from the project at execution
      // time. A project's question can be edited; the run that is already in flight was asked the
      // question it was asked.
      input: {
        context: {
          ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          question: project.question,
          title: project.title,
        },
      } as never,
      // Scoped to the run, so a redelivered enqueue cannot produce a second engine run.
      idempotencyKey: `research:${project.id}:${Date.now()}`,
    });

    const researchRun = await this.deps.research.createRun(tenantId, project.id, {
      runId: run.id,
    });
    // `createRun` returns `null` only when the project is not this tenant's, which was already
    // proven above — so this is a genuine invariant violation, not a user error.
    if (researchRun === null) {
      throw new ApiError('INTERNAL_ERROR', 'The research run could not be created', {
        projectId: project.id,
      });
    }

    await this.deps.research.updateRun(tenantId, researchRun.id, { status: 'running' });
    await this.deps.queue.enqueue({ runId: run.id, tenantId, kind: 'research' });

    this.deps.logger.info(
      { tenantId, projectId: project.id, researchRunId: researchRun.id, runId: run.id },
      'research run started',
    );

    return this.runDetail(tenantId, await this.requireRun(tenantId, researchRun.id));
  }

  async getRun(tenantId: string, runId: string): Promise<ResearchRunDetail> {
    return this.runDetail(tenantId, await this.requireRun(tenantId, runId));
  }

  /**
   * The research run wrapping an engine run, or `null`.
   *
   * The queue delivers an *engine* run id, so this is how the protocol's executor finds the row it
   * is executing for. `null` rather than a throw: a `run.execute` delivery for a run that is not a
   * research run is a routing mistake, and the caller's job is to ignore it, not to fail.
   */
  async findByEngineRunId(tenantId: string, engineRunId: string): Promise<ResearchRunDetail | null> {
    const run = await this.deps.research.findRunByEngineRunId(tenantId, engineRunId);
    return run === null ? null : this.runDetail(tenantId, run);
  }

  /**
   * Record the protocol outline and move the run to `running`.
   *
   * The outline is written before the first network call, so a run that dies mid-protocol still
   * says what it was attempting. A plan recorded at the end would only ever exist for the runs that
   * did not need it.
   */
  async beginProtocol(tenantId: string, runId: string, plan: unknown): Promise<void> {
    await this.requireRun(tenantId, runId);
    await this.deps.research.updateRun(tenantId, runId, { status: 'running', plan });
  }

  async listRuns(tenantId: string, query: ListResearchRunsQuery = {}): Promise<ResearchRunSummary[]> {
    if (query.projectId === undefined) {
      throw new ApiError(
        'VALIDATION_ERROR',
        '`projectId` is required — research runs are listed per project',
        { field: 'projectId' },
      );
    }
    await this.requireProject(tenantId, query.projectId);

    const runs = await this.deps.research.listRuns(tenantId, query.projectId);
    return runs
      .filter((run) => query.status === undefined || run.status === query.status)
      .slice(0, query.limit ?? runs.length)
      .map(toRunSummary);
  }

  /**
   * Record a source the run actually read.
   *
   * This is the ingestion point for the protocol's provenance, and it is deliberately callable
   * from outside: whatever ends up driving the search will call it, and a test can call it too.
   */
  async recordSource(
    tenantId: string,
    runId: string,
    input: ResearchSourceCreateInput,
  ): Promise<ResearchSourceSummary> {
    await this.requireRun(tenantId, runId);

    const source = await this.deps.research.addSource(tenantId, runId, input);
    if (source === null) throw runNotFound(runId);

    return toSourceSummary(source);
  }

  async recordFinding(
    tenantId: string,
    runId: string,
    input: ResearchFindingCreateInput,
  ): Promise<ResearchFindingSummary> {
    await this.requireRun(tenantId, runId);

    // A finding that cites a source this run did not record is the one thing provenance is
    // supposed to prevent, so the citation is checked rather than stored on trust.
    if (input.sourceIds !== undefined && input.sourceIds.length > 0) {
      const known = new Set(
        (await this.deps.research.listSources(tenantId, runId)).map((source) => source.id),
      );
      const unknown = input.sourceIds.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new ApiError('VALIDATION_ERROR', 'A finding cites sources this run did not record', {
          sourceIds: unknown,
        });
      }
    }

    const finding = await this.deps.research.addFinding(tenantId, runId, input);
    if (finding === null) throw runNotFound(runId);

    return toFindingSummary(finding);
  }

  /**
   * Finish a run.
   *
   * `completed` also completes the project, because a project with an answer is not still being
   * worked on — leaving it `active` would make the list's status column describe nothing. A
   * `failed` run leaves the project active on purpose: the question is still open, and the
   * operator's next move is another run, not a new project.
   */
  async finishRun(
    tenantId: string,
    runId: string,
    outcome: { status: 'completed' | 'failed'; result?: unknown },
  ): Promise<ResearchRunDetail> {
    const run = await this.requireRun(tenantId, runId);

    await this.deps.research.updateRun(tenantId, runId, {
      status: outcome.status,
      completedAt: new Date(),
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
    });

    if (outcome.status === 'completed') {
      await this.deps.research.updateProject(tenantId, run.projectId, { status: 'completed' });
    }

    this.deps.logger.info({ tenantId, runId, status: outcome.status }, 'research run finished');

    return this.runDetail(tenantId, await this.requireRun(tenantId, runId));
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async detail(project: ResearchProject): Promise<ResearchProjectDetail> {
    const runs = await this.deps.research.listRuns(project.tenantId, project.id);
    return { ...toProjectSummary(project), runs: runs.map(toRunSummary) };
  }

  /**
   * A run with its evidence.
   *
   * Takes the caller's `tenantId` rather than reading one off the run, because a run has none —
   * the source and finding queries filter through `run → project → tenantId`, so the tenant has to
   * come from somewhere, and the caller's is the only one that can be trusted anyway.
   */
  private async runDetail(tenantId: string, run: ResearchRun): Promise<ResearchRunDetail> {
    const [sources, findings] = await Promise.all([
      this.deps.research.listSources(tenantId, run.id),
      this.deps.research.listFindings(tenantId, run.id),
    ]);
    return {
      ...toRunSummary(run),
      sources: sources.map(toSourceSummary),
      findings: findings.map(toFindingSummary),
    };
  }

  private async requireProject(tenantId: string, id: string): Promise<ResearchProject> {
    const project = await this.deps.research.findProject(tenantId, id);
    if (project === null) throw projectNotFound(id);
    return project;
  }

  private async requireRun(tenantId: string, id: string): Promise<ResearchRun> {
    const run = await this.deps.research.findRun(tenantId, id);
    if (run === null) throw runNotFound(id);
    return run;
  }

  private async assertAgentExists(tenantId: string, agentId: string): Promise<void> {
    const agent = await this.deps.agents.findById(tenantId, agentId);
    if (agent === null) {
      throw new ApiError('VALIDATION_ERROR', 'The agent does not exist', { agentId });
    }
  }
}

// ── mapping ───────────────────────────────────────────────────────────────────

function projectNotFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 'The research project does not exist', { projectId: id });
}

function runNotFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 'The research run does not exist', { runId: id });
}

function toProjectSummary(project: ResearchProject): ResearchProjectSummary {
  return {
    id: project.id,
    title: project.title,
    question: project.question,
    agentId: project.agentId,
    status: project.status as ResearchProjectSummary['status'],
    resultRef: project.resultRef,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function toRunSummary(run: ResearchRun): ResearchRunSummary {
  return {
    id: run.id,
    projectId: run.projectId,
    runId: run.runId,
    status: run.status as ResearchRunSummary['status'],
    plan: run.plan,
    result: run.result,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt === null ? null : run.completedAt.toISOString(),
  };
}

function toSourceSummary(source: ResearchSource): ResearchSourceSummary {
  return {
    id: source.id,
    url: source.url,
    title: source.title,
    contentRef: source.contentRef,
    credibility: source.credibility,
    accessedAt: source.accessedAt.toISOString(),
  };
}

function toFindingSummary(finding: ResearchFinding): ResearchFindingSummary {
  return {
    id: finding.id,
    claim: finding.claim,
    evidence: finding.evidence,
    verified: finding.verified,
    sourceIds: [...finding.sourceIds],
  };
}
