import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';
import { AgentRepository } from '../src/repositories/agent.repo.js';
import { ResearchRepository } from '../src/repositories/research.repo.js';
import { RunRepository } from '../src/repositories/run.repo.js';
import { Verifier } from '../src/services/engine/verifier.js';
import { createInputContextResolver } from '../src/services/engine/default-context.js';
import { ResearchService } from '../src/services/research/research.service.js';
import { ResearchRunner } from '../src/services/research/research.runner.js';
import type { PageContent, PageReader } from '../src/services/research/page-reader.js';
import type { SearchPort, SearchResult } from '../src/services/search/search-provider.js';
import type { RunQueue, RunQueueJob } from '../src/services/queue/run-queue.js';
import type { FileService } from '../src/services/files/file.service.js';
import type { BrowserManager } from '../src/services/browser/browser-manager.js';

/**
 * The Research protocol (spec Phase 10.2), end to end.
 *
 * This is the file that answers the Phase 10 acceptance criterion:
 *
 * > research on a real question → **≥3 sources, cited findings, ≥1 verified claim**
 *
 * Everything is real except the three things that reach outside the process: the model, the search
 * vendor, and the web. The repositories, the service, the provenance checks, the `Verifier` and the
 * run lifecycle are the production ones, over the in-memory fake — because the interesting failures
 * are not in the plumbing, they are in what the protocol is willing to *claim*. A test that stubbed
 * the service would prove the orchestration calls the right methods and nothing about whether a
 * "verified" finding is verified.
 *
 * The negative cases carry as much weight as the positive one: a claim with no citation, a claim
 * whose quote is absent from the source it cites, and a question that yields fewer than three
 * readable pages must all end in the honest answer rather than a green tick.
 */

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const QUESTION = 'What obligations does the EU AI Act place on us?';

const logger = pino({ level: 'silent' });

// ── scripted collaborators ────────────────────────────────────────────────────

type ChatFn = (request: { messages: Array<{ role: string; content: string }> }) => Promise<{
  content: string;
}>;

interface ScriptedGateway {
  port: { chat: ChatFn };
  prompts: string[];
  setReplies(replies: string[]): void;
  failWith(error: Error): void;
}

/**
 * A gateway that replies from a queue, one reply per call.
 *
 * The protocol makes exactly two model calls (decompose, then organise), so a queue is clearer than
 * matching on prompt text. An exhausted queue throws, which turns "the protocol made an unexpected
 * third call" into a visible failure rather than a silent empty answer.
 */
function scriptedGateway(): ScriptedGateway {
  const prompts: string[] = [];
  let replies: string[] = [];
  let failure: Error | null = null;

  return {
    prompts,
    setReplies: (next) => {
      replies = [...next];
    },
    failWith: (error) => {
      failure = error;
    },
    port: {
      chat: async (request) => {
        prompts.push(request.messages.map((message) => message.content).join('\n'));
        if (failure !== null) throw failure;
        const next = replies.shift();
        if (next === undefined) throw new Error('scripted gateway ran out of replies');
        return { content: next };
      },
    },
  };
}

interface FakeSearch extends SearchPort {
  queries: string[];
  byQuery: Map<string, SearchResult[]>;
  failures: Set<string>;
}

function fakeSearch(): FakeSearch {
  const queries: string[] = [];
  const byQuery = new Map<string, SearchResult[]>();
  const failures = new Set<string>();

  return {
    name: 'fake-search',
    queries,
    byQuery,
    failures,
    search: async ({ query }) => {
      queries.push(query);
      if (failures.has(query)) throw new Error(`search failed for "${query}"`);
      return byQuery.get(query) ?? [];
    },
  };
}

interface FakeReader extends PageReader {
  /** Every URL the protocol tried to read, in order — including the ones that failed. */
  readCalls: string[];
  pages: Map<string, PageContent>;
  failures: Map<string, string>;
}

function fakeReader(): FakeReader {
  const readCalls: string[] = [];
  const pages = new Map<string, PageContent>();
  const failures = new Map<string, string>();

  return {
    readCalls,
    pages,
    failures,
    read: async (url) => {
      readCalls.push(url);
      const failure = failures.get(url);
      if (failure !== undefined) throw new Error(failure);
      const stub = pages.get(url);
      if (stub === undefined) throw new Error(`no page stubbed for ${url}`);
      return stub;
    },
  };
}

function page(url: string, text: string, title = url): PageContent {
  return { url, title, text, bytes: text.length, truncated: false };
}

function hit(url: string, title = url): SearchResult {
  return { url, title, snippet: `snippet for ${url}` };
}

// ── harness ───────────────────────────────────────────────────────────────────

interface Harness {
  db: FakeDb;
  service: ResearchService;
  runner: ResearchRunner;
  runs: RunRepository;
  gateway: ScriptedGateway;
  search: FakeSearch;
  reader: FakeReader;
  enqueued: RunQueueJob[];
  searchAvailable: { value: boolean };
  start(question?: string): Promise<{ projectId: string; researchRunId: string; engineRunId: string }>;
  cleanup(): Promise<void>;
}

const LIMITS = { maxQueries: 3, maxSources: 4, maxFindings: 5, excerptChars: 500, minSources: 3 };

async function createHarness(): Promise<Harness> {
  const db = createFakeDb();
  const agents = new AgentRepository(db.client);
  const research = new ResearchRepository(db.client);
  const runs = new RunRepository(db.client);
  const enqueued: RunQueueJob[] = [];
  const searchAvailable = { value: true };

  const queue: RunQueue = {
    enqueue: async (job) => {
      enqueued.push(job);
    },
  };

  const service = new ResearchService({
    research,
    agents,
    runs,
    queue,
    logger,
    searchAvailable: () => searchAvailable.value,
  });

  const gateway = scriptedGateway();
  const search = fakeSearch();
  const reader = fakeReader();

  // `content` verification with `source: 'output'` reads neither of these. They reject rather than
  // returning something plausible, so a change that made the verifier reach for a file or a page
  // would fail this test loudly instead of quietly verifying against nothing.
  const verifier = new Verifier({
    files: {
      readFile: () => Promise.reject(new Error('the verifier must not read files in this test')),
    } as unknown as FileService,
    browser: {
      act: () => Promise.reject(new Error('the verifier must not drive a browser in this test')),
    } as unknown as BrowserManager,
    logger,
  });

  const runner = new ResearchRunner({
    research: service,
    runs,
    resolveContext: createInputContextResolver({}),
    gateway: gateway.port as never,
    search,
    reader,
    verifier,
    limits: LIMITS,
    logger,
    now: () => Date.now(),
  });

  return {
    db,
    service,
    runner,
    runs,
    gateway,
    search,
    reader,
    enqueued,
    searchAvailable,
    start: async (question = QUESTION) => {
      const project = await service.createProject(TENANT, { title: 'EU AI Act', question });
      const run = await service.startRun(TENANT, project.id, { modelId: 'model-1' });
      return { projectId: project.id, researchRunId: run.id, engineRunId: run.runId! };
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

/**
 * The decomposition reply, shared by every test that keeps the three-source corpus.
 *
 * It has to match the query keys the search stub is populated with. A test that swaps in a
 * different decomposition is also swapping which queries get searched — and a query with no stubbed
 * results searches an empty web, which fails the run for a reason that has nothing to do with what
 * the test meant to exercise.
 */
const THREE_SOURCE_QUERIES = JSON.stringify({
  queries: ['EU AI Act obligations', 'AI Act timeline'],
});

/** The analysis reply that goes with the three-source corpus below. */
const THREE_SOURCE_ANALYSIS = JSON.stringify({
  summary: 'The Act phases in obligations over two years.',
  sections: [{ heading: 'Timeline', body: 'Most duties apply from August 2026.' }],
  findings: [
    { claim: 'Most obligations apply from August 2026', evidence: 'most obligations apply from August 2026', sources: [1] },
    { claim: 'Providers must document risk', evidence: 'document the risk management system', sources: [2] },
    { claim: 'Penalties scale with turnover', evidence: 'fines scale with global turnover', sources: [3] },
  ],
});

/** Three pages, each containing the quote its finding cites, reachable from two queries. */
function stubThreeSources(h: Harness): void {
  h.gateway.setReplies([THREE_SOURCE_QUERIES, THREE_SOURCE_ANALYSIS]);

  h.search.byQuery.set('EU AI Act obligations', [hit('https://example.eu/a', 'A'), hit('https://example.eu/b', 'B')]);
  h.search.byQuery.set('AI Act timeline', [hit('https://example.eu/c', 'C')]);

  h.reader.pages.set(
    'https://example.eu/a',
    page('https://example.eu/a', 'Under the Act most obligations apply from August 2026.', 'A'),
  );
  h.reader.pages.set(
    'https://example.eu/b',
    page('https://example.eu/b', 'Providers must document the risk management system.', 'B'),
  );
  h.reader.pages.set(
    'https://example.eu/c',
    page('https://example.eu/c', 'Penalties are fines scale with global turnover.', 'C'),
  );
}

// ── the acceptance criterion ──────────────────────────────────────────────────

describe('ResearchRunner — the Phase 10 acceptance criterion', () => {
  it('produces ≥3 sources, cited findings and ≥1 verified claim', async () => {
    stubThreeSources(harness);
    const { researchRunId, engineRunId } = await harness.start();

    const outcome = await harness.runner.execute(TENANT, engineRunId);

    expect(outcome.status).toBe('completed');

    const detail = await harness.service.getRun(TENANT, researchRunId);

    // ≥3 sources, each a row for a page that was actually fetched.
    expect(detail.sources.length).toBeGreaterThanOrEqual(3);
    expect(detail.sources.map((source) => source.url)).toEqual([
      'https://example.eu/a',
      'https://example.eu/b',
      'https://example.eu/c',
    ]);

    // Cited findings: every finding points at real source rows, not at strings.
    expect(detail.findings.length).toBeGreaterThanOrEqual(1);
    const sourceIds = new Set(detail.sources.map((source) => source.id));
    for (const finding of detail.findings) {
      expect(finding.sourceIds.length).toBeGreaterThan(0);
      for (const id of finding.sourceIds) expect(sourceIds.has(id)).toBe(true);
    }

    // ≥1 verified claim — and here all three verify against their own sources.
    expect(detail.findings.filter((finding) => finding.verified).length).toBeGreaterThanOrEqual(1);
    expect(detail.status).toBe('completed');
  });

  it('stores the structured result the spec asks for on the run', async () => {
    stubThreeSources(harness);
    const { researchRunId, engineRunId } = await harness.start();

    await harness.runner.execute(TENANT, engineRunId);
    const detail = await harness.service.getRun(TENANT, researchRunId);

    expect(detail.result).toMatchObject({
      question: QUESTION,
      searchProvider: 'fake-search',
      modelId: 'model-1',
      summary: 'The Act phases in obligations over two years.',
      sections: [{ heading: 'Timeline', body: 'Most duties apply from August 2026.' }],
      verification: { checked: 3, verified: 3, failed: 0 },
    });
  });

  it('completes the engine run with the same result', async () => {
    stubThreeSources(harness);
    const { engineRunId } = await harness.start();

    await harness.runner.execute(TENANT, engineRunId);

    const run = await harness.runs.findById(TENANT, engineRunId);
    expect(run?.status).toBe('completed');
    expect(run?.output).toMatchObject({ searchProvider: 'fake-search' });
  });

  it('writes the protocol outline before the first network call', async () => {
    stubThreeSources(harness);
    const { researchRunId, engineRunId } = await harness.start();

    await harness.runner.execute(TENANT, engineRunId);

    const detail = await harness.service.getRun(TENANT, researchRunId);
    expect(detail.plan).toMatchObject({
      protocol: [
        'decompose',
        'search',
        'browse',
        'extract',
        'collect_sources',
        'organize_findings',
        'verify_claims',
        'report',
      ],
      question: QUESTION,
      searchProvider: 'fake-search',
    });
  });
});

// ── honesty ───────────────────────────────────────────────────────────────────

describe('ResearchRunner — what it refuses to claim', () => {
  it('marks a claim unverified when its quote is not in the source it cites', async () => {
    stubThreeSources(harness);
    harness.gateway.setReplies([
      THREE_SOURCE_QUERIES,
      JSON.stringify({
        summary: 's',
        sections: [],
        findings: [
          { claim: 'Supported', evidence: 'most obligations apply from August 2026', sources: [1] },
          { claim: 'Invented', evidence: 'the Act requires a moon base', sources: [1] },
        ],
      }),
    ]);

    const { researchRunId, engineRunId } = await harness.start();
    await harness.runner.execute(TENANT, engineRunId);

    const detail = await harness.service.getRun(TENANT, researchRunId);
    const supported = detail.findings.find((finding) => finding.claim === 'Supported');
    const invented = detail.findings.find((finding) => finding.claim === 'Invented');

    expect(supported?.verified).toBe(true);
    // The whole point of the protocol: a plausible sentence with no support is stored as *not*
    // verified, rather than as a finding.
    expect(invented?.verified).toBe(false);
  });

  it('never verifies a claim that cites nothing', async () => {
    stubThreeSources(harness);
    harness.gateway.setReplies([
      THREE_SOURCE_QUERIES,
      JSON.stringify({
        summary: 's',
        sections: [],
        findings: [{ claim: 'Uncited assertion', evidence: 'something', sources: [] }],
      }),
    ]);

    const { researchRunId, engineRunId } = await harness.start();
    await harness.runner.execute(TENANT, engineRunId);

    const detail = await harness.service.getRun(TENANT, researchRunId);
    expect(detail.findings[0]?.verified).toBe(false);
    expect(detail.findings[0]?.sourceIds).toEqual([]);
  });

  it('checks a quote against only the sources the finding cites', async () => {
    stubThreeSources(harness);
    // The quote is real — but it is in source 2, not source 1, which is what the finding claims.
    harness.gateway.setReplies([
      THREE_SOURCE_QUERIES,
      JSON.stringify({
        summary: 's',
        sections: [],
        findings: [{ claim: 'Misattributed', evidence: 'document the risk management system', sources: [1] }],
      }),
    ]);

    const { researchRunId, engineRunId } = await harness.start();
    await harness.runner.execute(TENANT, engineRunId);

    const detail = await harness.service.getRun(TENANT, researchRunId);
    // Catches the model that quotes correctly and attributes wrongly.
    expect(detail.findings[0]?.verified).toBe(false);
  });

  it('drops a citation that points past the sources it was given', async () => {
    stubThreeSources(harness);
    harness.gateway.setReplies([
      THREE_SOURCE_QUERIES,
      JSON.stringify({
        summary: 's',
        sections: [],
        findings: [{ claim: 'Out of range', evidence: 'most obligations apply from August 2026', sources: [9] }],
      }),
    ]);

    const { researchRunId, engineRunId } = await harness.start();
    await harness.runner.execute(TENANT, engineRunId);

    const detail = await harness.service.getRun(TENANT, researchRunId);
    // Clamping to the last source would silently attribute the claim to the wrong page.
    expect(detail.findings[0]?.sourceIds).toEqual([]);
    expect(detail.findings[0]?.verified).toBe(false);
  });

  it('fails the run when fewer than the required sources can be read', async () => {
    harness.gateway.setReplies([JSON.stringify({ queries: ['q'] }), THREE_SOURCE_ANALYSIS]);
    harness.search.byQuery.set('q', [hit('https://example.eu/a'), hit('https://example.eu/b')]);
    harness.reader.pages.set('https://example.eu/a', page('https://example.eu/a', 'Only this one reads.'));
    harness.reader.failures.set('https://example.eu/b', 'the page returned 403');

    const { researchRunId, engineRunId } = await harness.start();
    const outcome = await harness.runner.execute(TENANT, engineRunId);

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('3 required sources');

    const detail = await harness.service.getRun(TENANT, researchRunId);
    expect(detail.status).toBe('failed');
    // The run row says why, so the operator is not left guessing.
    expect(JSON.stringify(detail.result)).toContain('3 required sources');

    const run = await harness.runs.findById(TENANT, engineRunId);
    expect(run?.status).toBe('failed');
  });

  it('fails the run when the search finds nothing', async () => {
    harness.gateway.setReplies([JSON.stringify({ queries: ['nothing at all'] }), THREE_SOURCE_ANALYSIS]);
    harness.search.byQuery.set('nothing at all', []);

    const { engineRunId } = await harness.start();
    const outcome = await harness.runner.execute(TENANT, engineRunId);

    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('No search results');
  });

  it('reports pages it could not read rather than counting them as sources', async () => {
    stubThreeSources(harness);
    harness.search.byQuery.set('EU AI Act obligations', [
      hit('https://example.eu/a'),
      hit('https://example.eu/dead'),
      hit('https://example.eu/b'),
    ]);
    harness.reader.failures.set('https://example.eu/dead', 'the page returned 404');

    const { researchRunId, engineRunId } = await harness.start();
    await harness.runner.execute(TENANT, engineRunId);

    const detail = await harness.service.getRun(TENANT, researchRunId);
    expect(detail.sources.map((source) => source.url)).not.toContain('https://example.eu/dead');
    expect(JSON.stringify(detail.result)).toContain('the page returned 404');
  });

  it('skips a page whose extraction produced no text', async () => {
    stubThreeSources(harness);
    harness.search.byQuery.set('EU AI Act obligations', [
      hit('https://example.eu/a'),
      hit('https://example.eu/empty'),
      hit('https://example.eu/b'),
    ]);
    harness.reader.pages.set('https://example.eu/empty', page('https://example.eu/empty', '   '));

    const { researchRunId, engineRunId } = await harness.start();
    await harness.runner.execute(TENANT, engineRunId);

    const detail = await harness.service.getRun(TENANT, researchRunId);
    // A page with no text cannot be cited, so it is not a source.
    expect(detail.sources.map((source) => source.url)).not.toContain('https://example.eu/empty');
  });
});

// ── resilience ────────────────────────────────────────────────────────────────

describe('ResearchRunner — degradation', () => {
  it('falls back to the question when the decomposition is unusable', async () => {
    harness.gateway.setReplies([
      'I am afraid I cannot produce JSON today.',
      JSON.stringify({
        summary: 's',
        sections: [],
        findings: [{ claim: 'c', evidence: 'most obligations apply from August 2026', sources: [1] }],
      }),
    ]);
    harness.search.byQuery.set(QUESTION, [
      hit('https://example.eu/a'),
      hit('https://example.eu/b'),
      hit('https://example.eu/c'),
    ]);
    harness.reader.pages.set(
      'https://example.eu/a',
      page('https://example.eu/a', 'Under the Act most obligations apply from August 2026.'),
    );
    harness.reader.pages.set('https://example.eu/b', page('https://example.eu/b', 'More text here.'));
    harness.reader.pages.set('https://example.eu/c', page('https://example.eu/c', 'And more text.'));

    const { engineRunId } = await harness.start();
    const outcome = await harness.runner.execute(TENANT, engineRunId);

    // A decomposition is an optimisation. Losing the run over a model that wrapped its JSON in
    // prose would make research depend on a formatting accident.
    expect(outcome.status).toBe('completed');
    expect(harness.search.queries).toEqual([QUESTION]);
  });

  it('falls back to the question when the decomposition throws', async () => {
    harness.gateway.setReplies([THREE_SOURCE_ANALYSIS]);
    harness.gateway.failWith(new Error('the model is unavailable'));
    harness.search.byQuery.set(QUESTION, [hit('https://example.eu/a')]);

    const { engineRunId } = await harness.start();
    const outcome = await harness.runner.execute(TENANT, engineRunId);

    // The first model call failed; the protocol still searched, with the question itself.
    expect(harness.search.queries).toEqual([QUESTION]);
    expect(outcome.status).toBe('failed'); // one source is below the floor, and it says so
  });

  it('keeps going when one query fails', async () => {
    stubThreeSources(harness);
    harness.search.failures.add('EU AI Act obligations');

    const { engineRunId } = await harness.start();
    await harness.runner.execute(TENANT, engineRunId);

    // The failed query did not stop the others from running.
    expect(harness.search.queries).toEqual(['EU AI Act obligations', 'AI Act timeline']);
  });

  it('counts a page found by two queries once', async () => {
    stubThreeSources(harness);
    // Both queries return the same page; only three distinct pages exist.
    harness.search.byQuery.set('EU AI Act obligations', [
      hit('https://example.eu/a'),
      hit('https://example.eu/a#section'),
      hit('https://example.eu/b'),
    ]);
    harness.search.byQuery.set('AI Act timeline', [hit('https://example.eu/c')]);

    const { researchRunId, engineRunId } = await harness.start();
    await harness.runner.execute(TENANT, engineRunId);

    const detail = await harness.service.getRun(TENANT, researchRunId);
    // A fragment is not a different page, and counting it twice would let a run claim to have read
    // more of the web than it did.
    expect(detail.sources.map((source) => source.url)).toEqual([
      'https://example.eu/a',
      'https://example.eu/b',
      'https://example.eu/c',
    ]);
  });

  it('fails the run when the analysis returns unusable JSON', async () => {
    stubThreeSources(harness);
    harness.gateway.setReplies([
      THREE_SOURCE_QUERIES,
      'Sorry, here is a prose answer with no JSON.',
    ]);

    const { researchRunId, engineRunId } = await harness.start();
    const outcome = await harness.runner.execute(TENANT, engineRunId);

    expect(outcome.status).toBe('failed');
    // No summary is invented, and no finding is stored on the strength of a missing analysis.
    const detail = await harness.service.getRun(TENANT, researchRunId);
    expect(detail.findings).toEqual([]);
    expect(detail.status).toBe('failed');
  });
});

// ── lifecycle ─────────────────────────────────────────────────────────────────

describe('ResearchRunner — lifecycle', () => {
  it('skips a run that is already finished', async () => {
    stubThreeSources(harness);
    const { engineRunId } = await harness.start();
    await harness.runs.setStatus(TENANT, engineRunId, 'completed');

    const outcome = await harness.runner.execute(TENANT, engineRunId);

    expect(outcome.status).toBe('skipped');
    expect(harness.search.queries).toEqual([]);
  });

  it('skips a run that is not a research run', async () => {
    // An ordinary run: a real row, with no research row wrapping it.
    const run = await harness.runs.create({
      tenantId: TENANT,
      kind: 'task',
      agentId: null,
      input: { context: { modelId: 'model-1' } } as never,
      idempotencyKey: 'ordinary-run',
    });

    const outcome = await harness.runner.execute(TENANT, run.id);

    // A routing mistake, not a failure — the queue must not retry it.
    expect(outcome.status).toBe('skipped');
    expect(outcome.reason).toBe('not a research run');
  });

  it('loses the claim race gracefully', async () => {
    stubThreeSources(harness);
    const { engineRunId } = await harness.start();
    // Someone else holds it: move it somewhere the runner cannot claim.
    await harness.runs.setStatus(TENANT, engineRunId, 'waiting_approval');

    const outcome = await harness.runner.execute(TENANT, engineRunId);

    expect(outcome.status).toBe('not_claimed');
    expect(harness.search.queries).toEqual([]);
  });

  it("does not touch another tenant's run", async () => {
    stubThreeSources(harness);
    const { engineRunId } = await harness.start();

    await expect(harness.runner.execute(OTHER_TENANT, engineRunId)).rejects.toThrow(
      /does not exist for tenant/,
    );
  });
});

// ── the configuration gate ────────────────────────────────────────────────────

describe('ResearchService — the search gate', () => {
  it('refuses to start a run when no search provider is configured', async () => {
    harness.searchAvailable.value = false;
    const project = await harness.service.createProject(TENANT, { title: 't', question: 'q' });

    // Refused before two rows and a queue job exist for a protocol that cannot run.
    await expect(
      harness.service.startRun(TENANT, project.id, { modelId: 'model-1' }),
    ).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });

    expect(harness.enqueued).toHaveLength(0);
    const detail = await harness.service.get(TENANT, project.id);
    expect(detail.runs).toHaveLength(0);
  });

  it('starts a run when a provider is configured', async () => {
    const project = await harness.service.createProject(TENANT, { title: 't', question: 'q' });

    const run = await harness.service.startRun(TENANT, project.id, { modelId: 'model-1' });

    expect(run.status).toBe('running');
    expect(harness.enqueued).toHaveLength(1);
    expect(harness.enqueued[0]!.kind).toBe('research');
  });
});
