import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';
import { AgentRepository } from '../src/repositories/agent.repo.js';
import { ResearchRepository } from '../src/repositories/research.repo.js';
import { RunRepository } from '../src/repositories/run.repo.js';
import { ResearchService } from '../src/services/research/research.service.js';
import type { RunQueue, RunQueueJob } from '../src/services/queue/run-queue.js';

/**
 * `ResearchService`, through the real repositories against the in-memory fake.
 *
 * The provenance rules are the subject: a finding cites sources the *run* recorded, a run belongs
 * to a *project* that belongs to a tenant, and nothing reaches a leaf row without walking that
 * chain. Those are the rules that make "cited findings" mean something rather than being a claim
 * about a claim.
 *
 * What is *not* tested here: the protocol itself. This file is about the records — who may write
 * them, what a citation is allowed to point at, and what a tenant can see. The protocol's own
 * behaviour (decompose → search → read → organise → verify) is `research.runner.test.ts`, and it
 * lives there because it needs a model, a search provider and a reader, none of which belong in a
 * test of the record layer.
 */

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';

const logger = pino({ level: 'silent' });

interface Harness {
  db: FakeDb;
  service: ResearchService;
  research: ResearchRepository;
  runs: RunRepository;
  enqueued: RunQueueJob[];
  seedAgent(tenantId: string, name?: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const db = createFakeDb();
  const agents = new AgentRepository(db.client);
  const research = new ResearchRepository(db.client);
  const runs = new RunRepository(db.client);
  const enqueued: RunQueueJob[] = [];

  const queue: RunQueue = {
    enqueue: async (job) => {
      enqueued.push(job);
    },
  };

  const service = new ResearchService({ research, agents, runs, queue, logger });

  return {
    db,
    service,
    research,
    runs,
    enqueued,
    seedAgent: async (tenantId, name = 'researcher') => {
      const agent = await db.client.agent.create({ data: { tenantId, name } });
      return agent.id;
    },
    cleanup: async () => {
      await db.client.$disconnect();
    },
  };
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe('ResearchService — projects', () => {
  it('opens a project as active, owned by the caller', async () => {
    const project = await harness.service.createProject(TENANT, {
      title: 'EU AI Act exposure',
      question: 'What obligations does the EU AI Act place on us by August 2026?',
    });

    expect(project.status).toBe('active');
    expect(project.title).toBe('EU AI Act exposure');
    expect(project.agentId).toBeNull();
    expect(project.runs).toEqual([]);

    const row = await harness.research.findProject(TENANT, project.id);
    expect(row?.tenantId).toBe(TENANT);
  });

  it('refuses an agent that belongs to another tenant', async () => {
    const foreign = await harness.seedAgent(OTHER_TENANT);

    await expect(
      harness.service.createProject(TENANT, { title: 'x', question: 'y', agentId: foreign }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('hides another tenant\'s project', async () => {
    const mine = await harness.service.createProject(TENANT, { title: 'mine', question: 'q' });

    await expect(harness.service.get(OTHER_TENANT, mine.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await harness.service.list(OTHER_TENANT)).total).toBe(0);
  });

  it('archives rather than deletes, and archiving twice is a no-op', async () => {
    const project = await harness.service.createProject(TENANT, { title: 'x', question: 'q' });

    const archived = await harness.service.archive(TENANT, project.id);
    expect(archived.status).toBe('archived');

    const again = await harness.service.archive(TENANT, project.id);
    expect(again.status).toBe('archived');

    // The row is still there: a project's findings are evidence, and tidying a list must not
    // destroy the record of what was found.
    expect((await harness.service.list(TENANT)).total).toBe(1);
  });

  it('removes only when asked, and reports a project that was never there', async () => {
    const project = await harness.service.createProject(TENANT, { title: 'x', question: 'q' });

    await harness.service.remove(TENANT, project.id);
    expect((await harness.service.list(TENANT)).total).toBe(0);

    await expect(harness.service.remove(TENANT, 'nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('filters the list by status and by agent', async () => {
    const agentId = await harness.seedAgent(TENANT);
    const withAgent = await harness.service.createProject(TENANT, {
      title: 'with agent',
      question: 'q',
      agentId,
    });
    const other = await harness.service.createProject(TENANT, { title: 'no agent', question: 'q' });
    await harness.service.archive(TENANT, other.id);

    expect((await harness.service.list(TENANT, { agentId })).projects.map((p) => p.id)).toEqual([
      withAgent.id,
    ]);
    expect((await harness.service.list(TENANT, { status: 'archived' })).projects.map((p) => p.id)).toEqual([
      other.id,
    ]);
    // The total and the page come from the same filter, so they cannot disagree.
    expect((await harness.service.list(TENANT, { status: 'active' })).total).toBe(1);
  });
});

describe('ResearchService — starting a run', () => {
  it('wraps a real engine run of kind research and hands it to the queue', async () => {
    const agentId = await harness.seedAgent(TENANT);
    const project = await harness.service.createProject(TENANT, {
      title: 'Q3 vendor risk',
      question: 'Which of our vendors had a breach in Q3?',
      agentId,
    });

    const run = await harness.service.startRun(TENANT, project.id);

    expect(run.status).toBe('running');
    expect(run.runId).not.toBeNull();

    // The engine run is what actually executes, and its `kind` is what makes it appear as research
    // in the Runs list rather than as an anonymous task.
    const engineRun = await harness.runs.findById(TENANT, run.runId!);
    expect(engineRun?.kind).toBe('research');
    expect(engineRun?.agentId).toBe(agentId);
    // The question travels with the run: a project's question can be edited, but the run was asked
    // the question it was asked.
    expect((engineRun?.input as { context?: { question?: string } })?.context?.question).toBe(
      'Which of our vendors had a breach in Q3?',
    );

    expect(harness.enqueued).toEqual([{ runId: run.runId, tenantId: TENANT, kind: 'research' }]);
  });

  it('refuses a run that names neither an agent nor a model', async () => {
    const project = await harness.service.createProject(TENANT, { title: 'x', question: 'q' });

    // Refused here rather than becoming a run that fails a second later.
    await expect(harness.service.startRun(TENANT, project.id)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(harness.enqueued).toEqual([]);
  });

  it('runs an agent-less project when the request names a model', async () => {
    const project = await harness.service.createProject(TENANT, { title: 'x', question: 'q' });

    const run = await harness.service.startRun(TENANT, project.id, { modelId: 'mdl_research' });

    const engineRun = await harness.runs.findById(TENANT, run.runId!);
    expect(engineRun?.agentId).toBeNull();
    expect((engineRun?.input as { context?: { modelId?: string } })?.context?.modelId).toBe(
      'mdl_research',
    );
  });

  it('lists runs per project, and refuses a listing with no project', async () => {
    const agentId = await harness.seedAgent(TENANT);
    const project = await harness.service.createProject(TENANT, {
      title: 'x',
      question: 'q',
      agentId,
    });
    await harness.service.startRun(TENANT, project.id);

    const runs = await harness.service.listRuns(TENANT, { projectId: project.id });
    expect(runs).toHaveLength(1);

    await expect(harness.service.listRuns(TENANT, {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('cannot start a run against another tenant\'s project', async () => {
    const agentId = await harness.seedAgent(TENANT);
    const project = await harness.service.createProject(TENANT, {
      title: 'x',
      question: 'q',
      agentId,
    });

    await expect(harness.service.startRun(OTHER_TENANT, project.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(harness.enqueued).toEqual([]);
  });
});

describe('ResearchService — provenance', () => {
  async function startedRun(): Promise<string> {
    const agentId = await harness.seedAgent(TENANT);
    const project = await harness.service.createProject(TENANT, {
      title: 'x',
      question: 'q',
      agentId,
    });
    const run = await harness.service.startRun(TENANT, project.id);
    return run.id;
  }

  it('records a source and returns it with the run', async () => {
    const runId = await startedRun();

    const source = await harness.service.recordSource(TENANT, runId, {
      url: 'https://example.test/breach-report',
      title: 'Q3 breach report',
      credibility: 'primary',
    });

    expect(source.url).toBe('https://example.test/breach-report');

    const run = await harness.service.getRun(TENANT, runId);
    expect(run.sources.map((s) => s.id)).toEqual([source.id]);
    expect(run.findings).toEqual([]);
  });

  it('records a finding that cites a source the run really read', async () => {
    const runId = await startedRun();
    const source = await harness.service.recordSource(TENANT, runId, {
      url: 'https://example.test/a',
    });

    const finding = await harness.service.recordFinding(TENANT, runId, {
      claim: 'Vendor A disclosed a breach in August',
      verified: true,
      sourceIds: [source.id],
    });

    expect(finding.verified).toBe(true);
    expect(finding.sourceIds).toEqual([source.id]);

    const run = await harness.service.getRun(TENANT, runId);
    expect(run.findings[0]!.claim).toBe('Vendor A disclosed a breach in August');
  });

  it('refuses a finding that cites a source this run never recorded', async () => {
    const runId = await startedRun();

    // The one thing provenance exists to prevent: a claim citing evidence nobody can find.
    await expect(
      harness.service.recordFinding(TENANT, runId, {
        claim: 'something',
        sourceIds: ['src_invented'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const run = await harness.service.getRun(TENANT, runId);
    expect(run.findings).toEqual([]);
  });

  it('refuses a finding that cites another run\'s source', async () => {
    const first = await startedRun();
    const second = await startedRun();
    const source = await harness.service.recordSource(TENANT, first, {
      url: 'https://example.test/a',
    });

    // The source exists, and it is this tenant's — it is simply not *this run's* evidence.
    await expect(
      harness.service.recordFinding(TENANT, second, { claim: 'x', sourceIds: [source.id] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses to record evidence against another tenant\'s run', async () => {
    const runId = await startedRun();

    await expect(
      harness.service.recordSource(OTHER_TENANT, runId, { url: 'https://example.test/x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(harness.service.getRun(OTHER_TENANT, runId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('ResearchService — finishing a run', () => {
  async function startedRun(): Promise<{ runId: string; projectId: string }> {
    const agentId = await harness.seedAgent(TENANT);
    const project = await harness.service.createProject(TENANT, {
      title: 'x',
      question: 'q',
      agentId,
    });
    const run = await harness.service.startRun(TENANT, project.id);
    return { runId: run.id, projectId: project.id };
  }

  it('completes the project when a run completes', async () => {
    const { runId, projectId } = await startedRun();

    const run = await harness.service.finishRun(TENANT, runId, {
      status: 'completed',
      result: { summary: 'three vendors affected' },
    });

    expect(run.status).toBe('completed');
    expect(run.completedAt).not.toBeNull();
    expect(run.result).toEqual({ summary: 'three vendors affected' });

    // A project with an answer is not still being worked on.
    const project = await harness.service.get(TENANT, projectId);
    expect(project.status).toBe('completed');
  });

  it('leaves the project open when a run fails', async () => {
    const { runId, projectId } = await startedRun();

    const run = await harness.service.finishRun(TENANT, runId, { status: 'failed' });

    expect(run.status).toBe('failed');
    // The question is still open; the operator's next move is another run, not a new project.
    const project = await harness.service.get(TENANT, projectId);
    expect(project.status).toBe('active');
  });
});
