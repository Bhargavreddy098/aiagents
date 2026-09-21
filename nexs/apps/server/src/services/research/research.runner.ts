import type { ChatMessage } from '@nexs/shared';
import type { Logger } from '../../logger.js';
import type { RunRepository } from '../../repositories/run.repo.js';
import type { RunContextResolver } from '../engine/execution-engine.js';
import { extractJsonValue } from '../engine/plan.js';
import { readContextBlock } from '../engine/run-input.js';
import type { Verifier } from '../engine/verifier.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { PageReader } from './page-reader.js';
import type { ResearchService } from './research.service.js';
import type { SearchPort, SearchResult } from '../search/search-provider.js';

/**
 * The Research protocol (spec Phase 10.2), as executable code.
 *
 * > decompose question → `web_search` → browser browse → read & extract → collect sources →
 * > organize findings → verify key claims (Verifier) → structured result (JSON: summary, sections,
 * > findings with citations, verification status)
 *
 * ## Why this is a runner rather than an engine plan
 *
 * The obvious alternative was to hand the engine a preset plan whose steps are tool calls. It does
 * not work, and the reason is worth recording so nobody tries it again.
 *
 * The protocol's later stages *write rows* — a `ResearchSource` per page actually read, a
 * `ResearchFinding` per claim with its citations. There is no tool for that, and there should not
 * be one: a model-callable "record a finding" tool would let the model invent findings, which is
 * the precise failure provenance exists to prevent. Worse, the plan is static and the protocol is
 * not — "for each search result, read the page" cannot be expressed as a fixed list of steps,
 * because the result count is not known until the search runs.
 *
 * So the protocol is code, and the *engine run is still real*: the run row exists, it is claimed
 * with the same compare-and-swap the engine uses, its status moves `queued → running →
 * completed|failed`, and the structured result is written to it. What the runner does not do is
 * pretend to be a model-driven plan.
 *
 * ## What it refuses to fake
 *
 * Every source recorded here was actually fetched. Every finding cites sources by real row id, and
 * the citation is checked by `ResearchService.recordFinding`. Every `verified: true` came from the
 * **Verifier** returning `passed` for a claim's evidence against the text that was actually
 * fetched. Nothing is asserted that a row does not support — and when fewer than `minSources`
 * pages can be read, the run **fails** rather than reporting a thin answer as a success.
 */

export type ResearchGateway = Pick<ModelGateway, 'chat'>;
export type ClaimVerifier = Pick<Verifier, 'verify'>;

export interface ResearchLimits {
  /** Sub-questions to decompose the question into. */
  maxQueries: number;
  /** Pages to actually read. The expensive step, and the one worth bounding. */
  maxSources: number;
  /** Claims to keep from the model's analysis. */
  maxFindings: number;
  /** Characters of each source inlined into the analysis prompt. */
  excerptChars: number;
  /** The acceptance floor. Below this the run has not answered the question, and says so. */
  minSources: number;
}

export interface ResearchRunnerDeps {
  research: ResearchService;
  runs: RunRepository;
  /** The same resolver the engine uses, so the model is chosen one way in both places. */
  resolveContext: RunContextResolver;
  gateway: ResearchGateway;
  search: SearchPort;
  reader: PageReader;
  verifier: ClaimVerifier;
  limits: ResearchLimits;
  logger: Logger;
  now: () => number;
}

export type ResearchOutcomeStatus = 'completed' | 'failed' | 'not_claimed' | 'skipped';

export interface ResearchOutcome {
  status: ResearchOutcomeStatus;
  engineRunId: string;
  researchRunId: string | null;
  reason?: string;
}

/** The stage names, in order. Recorded on the run so a failure still says what it was attempting. */
const PROTOCOL_STAGES = [
  'decompose',
  'search',
  'browse',
  'extract',
  'collect_sources',
  'organize_findings',
  'verify_claims',
  'report',
] as const;

export class ResearchRunner {
  constructor(private readonly deps: ResearchRunnerDeps) {}

  async execute(tenantId: string, engineRunId: string): Promise<ResearchOutcome> {
    const startedAt = this.deps.now();

    const run = await this.deps.runs.findById(tenantId, engineRunId);
    if (run === null) {
      throw new Error(`Run ${engineRunId} does not exist for tenant ${tenantId}`);
    }

    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return { status: 'skipped', engineRunId, researchRunId: null, reason: `run is ${run.status}` };
    }

    // A `run.execute` delivery whose run is not a research run is a routing mistake, not a failure.
    // Returning rather than throwing keeps the queue from retrying something that will never work.
    const researchRun = await this.deps.research.findByEngineRunId(tenantId, engineRunId);
    if (researchRun === null) {
      return { status: 'skipped', engineRunId, researchRunId: null, reason: 'not a research run' };
    }

    // The same claim the engine performs: at-least-once delivery means losing this race is normal,
    // and `not_claimed` is the correct outcome rather than a second execution.
    const claimed = await this.deps.runs.claim(
      tenantId,
      engineRunId,
      ['queued', 'planning', 'running'],
      'running',
    );
    if (claimed === null) {
      return { status: 'not_claimed', engineRunId, researchRunId: researchRun.id };
    }

    try {
      const context = await this.deps.resolveContext(claimed);
      const question = await this.resolveQuestion(tenantId, researchRun.projectId, claimed.input);

      await this.deps.research.beginProtocol(tenantId, researchRun.id, {
        protocol: [...PROTOCOL_STAGES],
        question,
        modelId: context.modelId,
        searchProvider: this.deps.search.name,
        limits: this.deps.limits,
      });

      const result = await this.runProtocol(tenantId, engineRunId, researchRun.id, question, context.modelId);

      await this.deps.research.finishRun(tenantId, researchRun.id, {
        status: 'completed',
        result,
      });
      await this.deps.runs.complete(tenantId, engineRunId, {
        output: result,
        durationMs: this.deps.now() - startedAt,
        completedAt: new Date(),
      });

      this.deps.logger.info(
        {
          tenantId,
          engineRunId,
          researchRunId: researchRun.id,
          sources: result.sources.length,
          findings: result.findings.length,
          verified: result.verification.verified,
        },
        'research protocol completed',
      );

      return { status: 'completed', engineRunId, researchRunId: researchRun.id };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      // Both rows are failed, and in this order: the research run carries the reason, and the
      // engine run is what the Runs list shows. Leaving the engine run `running` would make it a
      // zombie that only the stale-run reaper could clear.
      await this.deps.research
        .finishRun(tenantId, researchRun.id, {
          status: 'failed',
          result: { error: message, failedAt: new Date().toISOString() },
        })
        .catch((err: unknown) => {
          this.deps.logger.error({ err, researchRunId: researchRun.id }, 'could not mark the research run failed');
        });
      await this.deps.runs
        .setStatus(tenantId, engineRunId, 'failed', { error: message, completedAt: new Date() })
        .catch((err: unknown) => {
          this.deps.logger.error({ err, engineRunId }, 'could not mark the run failed');
        });

      this.deps.logger.warn({ err: cause, engineRunId, researchRunId: researchRun.id }, 'research protocol failed');
      return { status: 'failed', engineRunId, researchRunId: researchRun.id, reason: message };
    }
  }

  // ── the protocol ────────────────────────────────────────────────────────────

  private async runProtocol(
    tenantId: string,
    engineRunId: string,
    researchRunId: string,
    question: string,
    modelId: string,
  ): Promise<ResearchProtocolResult> {
    const { limits } = this.deps;

    // 1–2. decompose, then search. A decomposition failure is not fatal: the question itself is a
    // perfectly good query, and failing the whole run because a model returned unparseable JSON
    // would make research depend on a formatting accident.
    const queries = await this.decompose(tenantId, engineRunId, modelId, question);
    const found = await this.searchAll(queries, limits.maxSources);

    if (found.length === 0) {
      throw new Error(`No search results for "${question}" (queries: ${queries.join(' | ')})`);
    }

    // 3–5. browse, extract, and collect. Each page that is read becomes a source row, and the
    // source row is what a finding is later allowed to cite.
    const collected = await this.collect(tenantId, researchRunId, found, engineRunId);

    if (collected.sources.length < limits.minSources) {
      // Honest failure. The acceptance criterion is a floor, and a run that read one page has not
      // answered the question — reporting it as `completed` would make the status column describe
      // nothing and would hide exactly the case the criterion exists to catch.
      throw new Error(
        `Only ${collected.sources.length} of ${limits.minSources} required sources could be read`,
      );
    }

    // 6. organise into findings, each citing the sources it rests on.
    const analysis = await this.organise(
      tenantId,
      engineRunId,
      modelId,
      question,
      collected.sources,
      limits.maxFindings,
    );

    // 7. verify. The Verifier is the same component the engine uses for step verification, and the
    // check is `content`: does the claim's evidence actually appear in the text that was fetched.
    // That is a weaker check than entailment and a much stronger one than nothing — it is the
    // difference between "the model said so" and "the source says so".
    const verification = await this.verifyClaims(
      tenantId,
      engineRunId,
      analysis.findings,
      collected.sources,
    );

    // 8. report. Written only after verification, so a finding is stored once, with its verdict.
    const findings: ResearchFindingRecord[] = [];
    for (const finding of verification.findings) {
      const record = await this.deps.research.recordFinding(tenantId, researchRunId, {
        claim: finding.claim,
        evidence: { quote: finding.evidence, verifiedBy: finding.verified ? 'verifier:content' : null },
        verified: finding.verified,
        sourceIds: finding.sourceIds,
      });
      findings.push({
        id: record.id,
        claim: record.claim,
        verified: record.verified,
        sourceIds: record.sourceIds,
      });
    }

    return {
      question,
      queries,
      searchProvider: this.deps.search.name,
      modelId,
      sources: collected.sources.map((source) => ({
        id: source.id,
        url: source.url,
        title: source.title,
        chars: source.text.length,
        truncated: source.truncated,
      })),
      summary: analysis.summary,
      sections: analysis.sections,
      findings,
      verification: {
        checked: verification.findings.length,
        verified: verification.findings.filter((finding) => finding.verified).length,
        failed: verification.findings.filter((finding) => !finding.verified).length,
      },
      unreadable: collected.unreadable,
      completedAt: new Date(this.deps.now()).toISOString(),
    };
  }

  // ── stage 1: decompose ──────────────────────────────────────────────────────

  /**
   * Break the question into search queries.
   *
   * Falls back to the question itself on any failure — unparseable JSON, an empty list, a model
   * error. The fallback is the point: a decomposition is an optimisation, and a research run that
   * died because the model wrapped its JSON in prose would be a worse tool than one that searched
   * for the question directly.
   */
  private async decompose(
    tenantId: string,
    runId: string,
    modelId: string,
    question: string,
  ): Promise<string[]> {
    const fallback = [question];

    const reply = await this.chat(tenantId, runId, modelId, [
      {
        role: 'system',
        content:
          'You plan web research. Break the question into distinct search-engine queries that ' +
          'together would answer it. Prefer specific, keyword-like queries over full sentences. ' +
          'Reply with JSON only, shaped exactly like {"queries": ["...", "..."]}.',
      },
      { role: 'user', content: question },
    ]).catch((cause: unknown) => {
      this.deps.logger.warn({ err: cause, runId }, 'decomposition failed; searching the question directly');
      return null;
    });

    if (reply === null) return fallback;

    const parsed = parseJsonObject(reply);
    const queries = parsed === null ? null : readStringArray(parsed['queries']);

    if (queries === null || queries.length === 0) return fallback;

    // Deduplicated and capped: two queries that differ only in case would fetch the same pages, and
    // the cap bounds how much of the search budget a chatty model can spend.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const query of queries) {
      const key = query.trim().toLowerCase();
      if (key.length === 0 || seen.has(key)) continue;
      seen.add(key);
      unique.push(query.trim());
      if (unique.length >= this.deps.limits.maxQueries) break;
    }

    return unique.length === 0 ? fallback : unique;
  }

  // ── stage 2: search ─────────────────────────────────────────────────────────

  /**
   * Run every query and merge the results.
   *
   * A query that fails does not fail the run: a search that errored on one of four sub-questions
   * still leaves three, and the alternative — losing all of them — is strictly worse. The failures
   * are logged rather than swallowed.
   *
   * Deduplication is by URL with the fragment and a trailing slash removed, because the same page
   * reached from two queries is one source, and counting it twice would let a run claim to have
   * read more of the web than it did.
   */
  private async searchAll(queries: readonly string[], maxResults: number): Promise<SearchResult[]> {
    const seen = new Set<string>();
    const results: SearchResult[] = [];

    for (const query of queries) {
      let found: SearchResult[];
      try {
        found = await this.deps.search.search({ query, maxResults });
      } catch (cause) {
        this.deps.logger.warn({ err: cause, query }, 'a research query failed; continuing with the rest');
        continue;
      }

      for (const result of found) {
        const key = normaliseUrl(result.url);
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(result);
      }
    }

    return results;
  }

  // ── stages 3–5: browse, extract, collect ────────────────────────────────────

  /**
   * Read pages until `maxSources` have been collected, recording each as a source row.
   *
   * A page that cannot be read is skipped, not failed: a dead link, a 403, a PDF or a timeout is a
   * normal outcome of reading the web, and a run that stopped at the first one would be useless. The
   * skips are reported in the result so the count is honest about what it tried.
   *
   * The source row is written **after** the text is in hand. Recording a source first and filling it
   * in later would leave a citation-able row with no content behind it — evidence that is not.
   */
  private async collect(
    tenantId: string,
    researchRunId: string,
    candidates: readonly SearchResult[],
    engineRunId: string,
  ): Promise<{ sources: CollectedSource[]; unreadable: UnreadablePage[] }> {
    const sources: CollectedSource[] = [];
    const unreadable: UnreadablePage[] = [];
    const { maxSources, excerptChars } = this.deps.limits;

    for (const candidate of candidates) {
      if (sources.length >= maxSources) break;

      let page;
      try {
        page = await this.deps.reader.read(candidate.url, { maxBytes: excerptChars * 8 });
      } catch (cause) {
        unreadable.push({
          url: candidate.url,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        continue;
      }

      // A page whose extracted text is empty is a page we cannot cite. Skipping it keeps the
      // "sources were read" claim true.
      if (page.text.trim().length === 0) {
        unreadable.push({ url: candidate.url, reason: 'the page had no extractable text' });
        continue;
      }

      const record = await this.deps.research.recordSource(tenantId, researchRunId, {
        url: page.url,
        title: page.title.length > 0 ? page.title : candidate.title,
        contentRef: null,
        credibility: null,
      });

      sources.push({
        id: record.id,
        url: page.url,
        title: page.title.length > 0 ? page.title : candidate.title,
        text: page.text,
        truncated: page.truncated,
      });

      this.deps.logger.debug({ engineRunId, url: page.url }, 'research source collected');
    }

    return { sources, unreadable };
  }

  // ── stage 6: organize findings ──────────────────────────────────────────────

  /**
   * Turn the collected text into a summary, sections and cited findings.
   *
   * The sources are numbered in the prompt and the model cites by number, which is then mapped back
   * to real row ids. A model asked to cite a UUID would transcribe it wrongly often enough to
   * matter; asking for `[3]` and resolving it here makes the failure mode "a wrong source" rather
   * than "a malformed citation", and an out-of-range number is dropped rather than stored.
   */
  private async organise(
    tenantId: string,
    runId: string,
    modelId: string,
    question: string,
    sources: readonly CollectedSource[],
    maxFindings: number,
  ): Promise<{ summary: string; sections: AnalysisSection[]; findings: AnalysedFinding[] }> {
    const corpus = sources
      .map((source, index) => {
        const excerpt = source.text.slice(0, this.deps.limits.excerptChars);
        return `[${index + 1}] ${source.title}\n${source.url}\n${excerpt}`;
      })
      .join('\n\n---\n\n');

    const reply = await this.chat(tenantId, runId, modelId, [
      {
        role: 'system',
        content:
          'You are a research analyst. Using ONLY the numbered sources provided, answer the ' +
          'question. Cite a source by its number in square brackets. Do not state anything the ' +
          'sources do not support; if they are insufficient, say so in the summary. Reply with ' +
          'JSON only, shaped exactly like: ' +
          '{"summary": "...", "sections": [{"heading": "...", "body": "..."}], ' +
          '"findings": [{"claim": "...", "evidence": "a short verbatim quote from the source", ' +
          '"sources": [1, 2]}]}',
      },
      { role: 'user', content: `Question: ${question}\n\nSources:\n\n${corpus}` },
    ]);

    const parsed = parseJsonObject(reply);
    if (parsed === null) {
      throw new Error('The research analysis did not return usable JSON');
    }

    const summary = typeof parsed['summary'] === 'string' ? parsed['summary'].trim() : '';
    const sections = readSections(parsed['sections']);
    const drafts = readFindings(parsed['findings'], sources.length).slice(0, maxFindings);

    // Indexes become real row ids here, in the one place that holds the collected sources. Leaving
    // the model's `[3]` as a string would produce a citation that resolves to nothing, which is the
    // failure `recordFinding`'s provenance check exists to catch — better not to create it.
    const findings: AnalysedFinding[] = drafts.map((draft) => ({
      claim: draft.claim,
      evidence: draft.evidence,
      sourceIds: draft.indexes
        .map((index) => sources[index]?.id)
        .filter((id): id is string => id !== undefined),
    }));

    return { summary, sections, findings };
  }

  // ── stage 7: verify claims ──────────────────────────────────────────────────

  /**
   * Verify each finding's evidence against the text that was actually fetched.
   *
   * The check is the **Verifier's** `content` type, the same component the engine uses for step
   * verification — not a bespoke string compare. The haystack is the concatenation of only the
   * sources the finding cites, so a quote that appears in a source the finding did *not* cite
   * fails. That is the property worth having: it catches a model that quotes correctly but
   * attributes wrongly.
   *
   * Both sides are whitespace-collapsed and lowercased first. A quote differing from its source
   * only in line wrapping or capitalisation is still supported by it, and failing on that would
   * make the verdict a test of formatting rather than of evidence.
   */
  private async verifyClaims(
    tenantId: string,
    runId: string,
    findings: readonly AnalysedFinding[],
    sources: readonly CollectedSource[],
  ): Promise<{ findings: VerifiedFinding[] }> {
    const byId = new Map(sources.map((source) => [source.id, source]));
    const verified: VerifiedFinding[] = [];

    for (const finding of findings) {
      const cited = finding.sourceIds
        .map((id) => byId.get(id))
        .filter((source): source is CollectedSource => source !== undefined);

      const haystack = normaliseForMatch(cited.map((source) => source.text).join('\n'));
      const needle = normaliseForMatch(finding.evidence);

      // No citation, or no evidence to check: unverifiable, and therefore not verified. Storing
      // `verified: true` on a claim nothing supports is the one thing this whole protocol exists
      // to make impossible.
      if (cited.length === 0 || needle.length === 0) {
        verified.push({ ...finding, verified: false });
        continue;
      }

      const outcome = await this.deps.verifier.verify({
        tenantId,
        runId,
        type: 'content',
        config: { source: 'output', contains: [needle] },
        subject: {
          output: haystack,
          toolResult: null,
          outputs: {},
          lastHttpResult: null,
          browserSessionId: null,
        },
      });

      verified.push({ ...finding, verified: outcome.passed });
    }

    return { findings: verified };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * The question, from the run's own input first.
   *
   * The run carries the question it was asked, and a project's question can be edited after a run
   * starts — so the run's copy is the one that is true for this attempt. The project is the
   * fallback for a run created without one.
   */
  private async resolveQuestion(
    tenantId: string,
    projectId: string,
    input: unknown,
  ): Promise<string> {
    const fromInput = readContextBlock(input)['question'];
    if (typeof fromInput === 'string' && fromInput.trim().length > 0) return fromInput.trim();

    const project = await this.deps.research.get(tenantId, projectId);
    return project.question;
  }

  private async chat(
    tenantId: string,
    runId: string,
    modelId: string,
    messages: ChatMessage[],
  ): Promise<string> {
    const result = await this.deps.gateway.chat({ tenantId, runId, modelId, messages });
    return result.content;
  }
}

// ── shapes ────────────────────────────────────────────────────────────────────

export interface CollectedSource {
  id: string;
  url: string;
  title: string;
  text: string;
  truncated: boolean;
}

export interface UnreadablePage {
  url: string;
  reason: string;
}

export interface AnalysisSection {
  heading: string;
  body: string;
}

/** A finding as the model proposed it, before its citations are resolved to real row ids. */
interface AnalysedFinding {
  claim: string;
  evidence: string;
  sourceIds: string[];
}

/** A finding straight off the wire: citations are 1-based indexes into the numbered sources. */
interface FindingDraft {
  claim: string;
  evidence: string;
  indexes: number[];
}

interface VerifiedFinding extends AnalysedFinding {
  verified: boolean;
}

export interface ResearchFindingRecord {
  id: string;
  claim: string;
  verified: boolean;
  sourceIds: string[];
}

/**
 * The structured result (spec Phase 10.2), stored on the run and returned by `GET /api/research/runs/:id`.
 *
 * The counts in `verification` are the honest headline: `checked` is how many claims were put to
 * the Verifier, and `verified` is how many it passed. A reader can see at a glance whether the
 * answer is evidenced or merely plausible, which is the question a research result exists to answer.
 */
export interface ResearchProtocolResult {
  question: string;
  queries: string[];
  searchProvider: string;
  modelId: string;
  sources: Array<{ id: string; url: string; title: string; chars: number; truncated: boolean }>;
  summary: string;
  sections: AnalysisSection[];
  findings: ResearchFindingRecord[];
  verification: { checked: number; verified: number; failed: number };
  unreadable: UnreadablePage[];
  completedAt: string;
}

// ── parsing helpers ───────────────────────────────────────────────────────────

/**
 * Parse a model reply into an object, tolerating the usual packaging.
 *
 * `extractJsonValue` is reused from the planner, which already solved this: a model asked for JSON
 * will sometimes fence it, sometimes preface it with a sentence, and refusing those would spend a
 * retry on formatting. It is forgiving about packaging and strict about content.
 */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const extracted = extractJsonValue(text);
  if (extracted === null) return null;
  try {
    const value: unknown = JSON.parse(extracted);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) out.push(entry);
  }
  return out;
}

function readSections(value: unknown): AnalysisSection[] {
  if (!Array.isArray(value)) return [];
  const sections: AnalysisSection[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const heading = typeof record['heading'] === 'string' ? record['heading'].trim() : '';
    const body = typeof record['body'] === 'string' ? record['body'].trim() : '';
    if (heading.length === 0 && body.length === 0) continue;
    sections.push({ heading, body });
  }
  return sections;
}

/**
 * Read the model's findings, keeping each citation as a 1-based index into the numbered sources.
 *
 * Indexes rather than ids because this function has no access to the sources — the mapping happens
 * in `organise`, which does. Out-of-range numbers are dropped rather than clamped: a model citing
 * `[7]` when seven sources were not provided has made an error, and clamping it to the last source
 * would silently attribute the claim to the wrong page.
 */
function readFindings(value: unknown, sourceCount: number): FindingDraft[] {
  if (!Array.isArray(value)) return [];
  const findings: FindingDraft[] = [];

  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;

    const claim = typeof record['claim'] === 'string' ? record['claim'].trim() : '';
    if (claim.length === 0) continue;

    const evidence = typeof record['evidence'] === 'string' ? record['evidence'].trim() : '';
    const cited = Array.isArray(record['sources']) ? record['sources'] : [];

    const indexes: number[] = [];
    for (const item of cited) {
      if (typeof item !== 'number' || !Number.isInteger(item)) continue;
      if (item < 1 || item > sourceCount) continue;
      indexes.push(item - 1);
    }

    findings.push({ claim, evidence, indexes });
  }

  return findings;
}

/** Collapse whitespace and case, so a verdict is about evidence rather than about formatting. */
function normaliseForMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A URL without its fragment or a trailing slash, so the same page counts once. */
function normaliseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.host}${path}${parsed.search}`.toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}
