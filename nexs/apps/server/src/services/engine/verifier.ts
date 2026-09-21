// ajv ships CommonJS and declares both a default and a named `Ajv`. The named form is the
// one that survives the interop under `module: NodeNext` — the default import resolves to
// the module namespace, which is not constructable.
import { Ajv, type ValidateFunction } from 'ajv';
import {
  ApiError,
  SUCCESS_CRITERION_TYPES,
  type SuccessCriterion,
  type VerificationOutcome,
  type VerifierType,
  type VerifierType as VerifierTypeAlias,
} from '@nexs/shared';
import type { Logger } from '../../logger.js';
import type { BrowserManager } from '../browser/browser-manager.js';
import type { FileService } from '../files/file.service.js';

/**
 * The verifier — §5.4's "prove it, don't claim it".
 *
 * A run's `completed` status is a claim about the world. This is the only component that
 * turns that claim into evidence, which is why it is deliberately boring: every check
 * here is deterministic, side-effect free, and reports what it actually observed rather
 * than a boolean with no explanation.
 *
 * Three decisions carry most of the weight.
 *
 * **A verifier that cannot run fails.** A malformed JSON Schema, an unreachable browser
 * session, an unknown criterion type — none of these produce `passed: true`. The failure
 * mode this rules out is the worst one available to a verification system: a check that
 * silently passes because it could not be evaluated, which turns every goal into
 * "completed" the moment anything breaks.
 *
 * **`goal_criteria` is evaluated against the run, not against itself.** A criterion that
 * verified another criterion would let a goal certify its own success. So the criterion
 * types are a *closed* set (`SUCCESS_CRITERION_TYPES`) that excludes `goal_criteria` and
 * `human`, and the config is checked against it at run time rather than trusted.
 *
 * **`human` is a lookup, not a prompt.** This component never asks anyone anything — it
 * reads a decision that already exists. A verifier that could block on user input would
 * make the engine's timeout budget unenforceable.
 */

// ── seams ─────────────────────────────────────────────────────────────────────

/**
 * Where a `human` verification reads its answer from. Owned by Phase 7; the verifier only
 * needs the shape.
 */
export interface ApprovalLookup {
  decision(
    tenantId: string,
    approvalId: string,
  ): Promise<{ status: string; decision: 'approved' | 'rejected' | null } | null>;
}

/**
 * The browser surface a verifier uses: `act`, for `inspect` and for the `extract` that
 * doubles as a presence test. A `Pick`-derived port so a verification test needs a page
 * object, not a Playwright launcher and a session registry.
 */
export type BrowserInspector = Pick<BrowserManager, 'act'>;

export interface VerifierDeps {
  files: FileService;
  browser: BrowserInspector;
  logger: Logger;
  approvals?: ApprovalLookup;
}

/**
 * Everything a verifier is allowed to look at.
 *
 * Assembled by the engine from the run's own state, so a verifier cannot reach outside the
 * run to find something to pass on. That constraint is the point: a verification that
 * reads the filesystem at large would be able to "prove" a goal using a file the run never
 * touched.
 */
export interface VerificationSubject {
  /** The step's own output, when this verification is attached to a step. */
  output: unknown;
  /** The step's tool result payload, when the step was a tool call. */
  toolResult: unknown;
  /** Named outputs collected in the run's checkpoint. */
  outputs: Record<string, unknown>;
  /** The most recent successful `http_request` result in the run. */
  lastHttpResult: unknown;
  /** The run's live browser session, if it opened one. */
  browserSessionId: string | null;
}

export interface VerificationRequest {
  tenantId: string;
  runId: string;
  stepId?: string | null;
  goalId?: string | null;
  type: VerifierType;
  scope?: 'step' | 'goal_criteria';
  config: Record<string, unknown>;
  subject: VerificationSubject;
}

// ── the verifier ──────────────────────────────────────────────────────────────

export class Verifier {
  private readonly ajv: Ajv;
  private readonly compiled = new Map<string, ValidateFunction>();

  constructor(private readonly deps: VerifierDeps) {
    // `strict: false` because tool schemas come from MCP servers and third parties, and a
    // schema with a keyword ajv does not know is far more likely to be a vendor extension
    // than a mistake worth refusing to verify over. `allErrors` so a failure lists every
    // problem, not just the first — the evidence is what the operator reads.
    this.ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
  }

  async verify(request: VerificationRequest): Promise<VerificationOutcome> {
    try {
      return await this.dispatch(request.type, request.config, request.subject, request);
    } catch (cause) {
      // A thrown error is an unevaluable check, which fails. The alternative — letting it
      // propagate — would fail the *step* rather than the verification, and the run would
      // lose the distinction between "the work went wrong" and "we could not tell".
      this.deps.logger.warn(
        { err: cause, type: request.type, runId: request.runId },
        'verification could not be evaluated',
      );
      return {
        passed: false,
        evidence: { type: request.type, config: request.config },
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  private async dispatch(
    type: VerifierType,
    config: Record<string, unknown>,
    subject: VerificationSubject,
    request: VerificationRequest,
  ): Promise<VerificationOutcome> {
    switch (type) {
      case 'schema':
        return this.verifySchema(config, subject.output);
      case 'tool_result':
        return this.verifySchema(config, subject.toolResult);
      case 'content':
        return this.verifyContent(request.tenantId, config, subject);
      case 'http_response':
        return this.verifyHttpResponse(config, subject.lastHttpResult);
      case 'file_exists':
        return this.verifyFileExists(request.tenantId, config);
      case 'browser_state':
        return this.verifyBrowserState(request.tenantId, config, subject);
      case 'goal_criteria':
        return this.verifyGoalCriteria(config, subject, request);
      case 'human':
        return this.verifyHuman(request.tenantId, config);
      default:
        return {
          passed: false,
          evidence: { type },
          error: `Unknown verification type "${String(type)}"`,
        };
    }
  }

  // ── schema ──────────────────────────────────────────────────────────────────

  private verifySchema(config: Record<string, unknown>, value: unknown): VerificationOutcome {
    const schema = config['schema'];
    if (schema === null || typeof schema !== 'object') {
      return { passed: false, evidence: { config }, error: 'schema verification needs a "schema" object' };
    }

    const validate = this.compile(schema);
    if (validate === null) {
      return { passed: false, evidence: { schema }, error: 'the supplied JSON Schema is not valid' };
    }

    const passed = validate(value) === true;
    return {
      passed,
      evidence: {
        schema,
        value: truncateForEvidence(value),
        ...(passed ? {} : { errors: validate.errors ?? [] }),
      },
    };
  }

  /**
   * Compile once per distinct schema.
   *
   * ajv caches by schema *identity*, and a schema that arrives from a database column is a
   * fresh object on every read, so the built-in cache never hits. Keying on the
   * serialisation is what actually makes this cheap for a run that verifies the same shape
   * on every step.
   */
  private compile(schema: unknown): ValidateFunction | null {
    let key: string;
    try {
      key = JSON.stringify(schema);
    } catch {
      return null;
    }

    const cached = this.compiled.get(key);
    if (cached !== undefined) return cached;

    try {
      const validate = this.ajv.compile(schema as object);
      this.compiled.set(key, validate);
      return validate;
    } catch {
      return null;
    }
  }

  // ── content ─────────────────────────────────────────────────────────────────

  private async verifyContent(
    tenantId: string,
    config: Record<string, unknown>,
    subject: VerificationSubject,
  ): Promise<VerificationOutcome> {
    const source = config['source'] ?? 'output';
    if (source !== 'output' && source !== 'file') {
      return { passed: false, evidence: { config }, error: '"source" must be "output" or "file"' };
    }

    const contains = stringArray(config['contains'], 'contains');
    if (contains === null) {
      return { passed: false, evidence: { config }, error: '"contains" must be an array of strings' };
    }
    const regex = config['regex'];
    if (regex !== undefined && typeof regex !== 'string') {
      return { passed: false, evidence: { config }, error: '"regex" must be a string' };
    }

    let text: string;
    if (source === 'file') {
      const path = config['path'];
      if (typeof path !== 'string' || path.length === 0) {
        return { passed: false, evidence: { config }, error: '"path" is required when source is "file"' };
      }
      text = (await this.deps.files.readFile(tenantId, path)).toString('utf8');
    } else {
      text = toText(subject.output);
    }

    const missing = contains.filter((needle) => !text.includes(needle));

    let regexMatched: boolean | null = null;
    let regexError: string | undefined;
    if (typeof regex === 'string') {
      try {
        // NOTE: a tenant-supplied pattern is evaluated by a backtracking engine, so a
        // pathological pattern can burn CPU. The subject is capped to bound the damage; a
        // full fix is a linear-time engine, which is a larger change than this phase.
        regexMatched = new RegExp(regex, 's').test(text.slice(0, MAX_REGEX_SUBJECT_CHARS));
      } catch (cause) {
        regexError = cause instanceof Error ? cause.message : String(cause);
      }
    }

    const passed = missing.length === 0 && regexMatched !== false && regexError === undefined;
    return {
      passed,
      evidence: {
        source,
        bytes: text.length,
        contains: { checked: contains, missing },
        ...(regexMatched === null ? {} : { regexMatched }),
        ...(regexError === undefined ? {} : { regexError }),
        excerpt: text.slice(0, EVIDENCE_EXCERPT_CHARS),
      },
      ...(regexError === undefined ? {} : { error: `Invalid regex: ${regexError}` }),
    };
  }

  // ── http_response ───────────────────────────────────────────────────────────

  private verifyHttpResponse(
    config: Record<string, unknown>,
    lastHttpResult: unknown,
  ): VerificationOutcome {
    const expectedStatus = config['expectedStatus'];
    if (typeof expectedStatus !== 'number' || !Number.isInteger(expectedStatus)) {
      return { passed: false, evidence: { config }, error: '"expectedStatus" must be an integer' };
    }

    const result = asRecord(lastHttpResult);
    if (result === null || typeof result['status'] !== 'number') {
      // The verifier is looking at the *recorded* result, so this means the run never made
      // an http_request that succeeded — not that the endpoint is unreachable.
      return {
        passed: false,
        evidence: { expectedStatus, recorded: truncateForEvidence(lastHttpResult) },
        error: 'No recorded HTTP response is available to verify against',
      };
    }

    const status = result['status'] as number;
    const body = typeof result['body'] === 'string' ? result['body'] : '';
    const headers = asRecord(result['headers']) ?? {};

    const bodyContains = stringArray(config['bodyContains'], 'bodyContains') ?? [];
    const missingBody = bodyContains.filter((needle) => !body.includes(needle));

    const expectedHeaders = asRecord(config['headers']) ?? {};
    const headerMismatches: Array<{ name: string; expected: unknown; actual: unknown }> = [];
    for (const [name, expected] of Object.entries(expectedHeaders)) {
      // HTTP header names are case-insensitive, so a literal comparison would report a
      // mismatch for `Content-Type` against `content-type`, which is not a real failure.
      const actualKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
      const actual = actualKey === undefined ? undefined : headers[actualKey];
      if (actual !== expected) headerMismatches.push({ name, expected, actual: actual ?? null });
    }

    const passed =
      status === expectedStatus && missingBody.length === 0 && headerMismatches.length === 0;

    return {
      passed,
      evidence: {
        expectedStatus,
        actualStatus: status,
        bodyContains: { checked: bodyContains, missing: missingBody },
        headerMismatches,
        bodyBytes: body.length,
        bodyExcerpt: body.slice(0, EVIDENCE_EXCERPT_CHARS),
      },
    };
  }

  // ── file_exists ─────────────────────────────────────────────────────────────

  private async verifyFileExists(
    tenantId: string,
    config: Record<string, unknown>,
  ): Promise<VerificationOutcome> {
    const path = config['path'];
    if (typeof path !== 'string' || path.length === 0) {
      return { passed: false, evidence: { config }, error: '"path" is required' };
    }

    // A 1-byte budget turns `readFile` into a `stat`: it throws NOT_FOUND when the path is
    // not a readable file and VALIDATION_ERROR when it is simply larger than the budget.
    // So "it threw, but not with NOT_FOUND" is exactly "it exists".
    try {
      await this.deps.files.readFile(tenantId, path, { maxBytes: 1 });
      return { passed: true, evidence: { path, exists: true, readable: true } };
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'NOT_FOUND') {
        return { passed: false, evidence: { path, exists: false } };
      }
      if (cause instanceof ApiError && cause.code === 'VALIDATION_ERROR') {
        return { passed: true, evidence: { path, exists: true, readable: true, note: 'exceeds 1 byte' } };
      }
      throw cause;
    }
  }

  // ── browser_state ───────────────────────────────────────────────────────────

  private async verifyBrowserState(
    tenantId: string,
    config: Record<string, unknown>,
    subject: VerificationSubject,
  ): Promise<VerificationOutcome> {
    const sessionId = subject.browserSessionId;
    if (sessionId === null) {
      return { passed: false, evidence: { config }, error: 'The run has no browser session' };
    }

    const inspect = await this.deps.browser.act(tenantId, sessionId, { type: 'inspect' });
    const state = asRecord(inspect.output) ?? {};
    const url = typeof state['url'] === 'string' ? state['url'] : '';
    const text = typeof state['text'] === 'string' ? state['text'] : '';

    const selector = config['selector'];
    let selectorPresent: boolean | null = null;
    if (typeof selector === 'string' && selector.length > 0) {
      // `extract` throws when nothing matches, which is the presence test. There is no
      // "does this selector match" call that does not also fetch, so the throw is the API.
      try {
        await this.deps.browser.act(tenantId, sessionId, { type: 'extract', selector });
        selectorPresent = true;
      } catch {
        selectorPresent = false;
      }
    }

    const expectedText = config['text'];
    const textFound = typeof expectedText === 'string' ? text.includes(expectedText) : null;

    const urlMatches = config['urlMatches'];
    let urlMatched: boolean | null = null;
    let urlError: string | undefined;
    if (typeof urlMatches === 'string') {
      try {
        urlMatched = new RegExp(urlMatches).test(url);
      } catch (cause) {
        urlError = cause instanceof Error ? cause.message : String(cause);
      }
    }

    const passed =
      selectorPresent !== false && textFound !== false && urlMatched !== false && urlError === undefined;

    return {
      passed,
      evidence: {
        url,
        title: state['title'] ?? null,
        selector: { checked: selector ?? null, present: selectorPresent },
        text: { checked: expectedText ?? null, found: textFound },
        urlMatches: { pattern: urlMatches ?? null, matched: urlMatched },
        ...(urlError === undefined ? {} : { urlError }),
      },
      ...(urlError === undefined ? {} : { error: `Invalid urlMatches pattern: ${urlError}` }),
    };
  }

  // ── goal_criteria ───────────────────────────────────────────────────────────

  /**
   * All criteria must pass, and each one is evaluated as a first-class verification.
   *
   * The sub-results are kept in the evidence rather than reduced to a boolean, because
   * "the goal is not complete" is only actionable if the operator can see *which* of four
   * criteria failed and what it observed.
   */
  private async verifyGoalCriteria(
    config: Record<string, unknown>,
    subject: VerificationSubject,
    request: VerificationRequest,
  ): Promise<VerificationOutcome> {
    const raw = config['criteria'];
    if (!Array.isArray(raw) || raw.length === 0) {
      return { passed: false, evidence: { config }, error: '"criteria" must be a non-empty array' };
    }

    const results: Array<{ type: string; description: string; passed: boolean; evidence: unknown }> = [];

    for (const [index, entry] of raw.entries()) {
      const criterion = entry as Partial<SuccessCriterion>;
      const type = criterion.type;

      if (typeof type !== 'string' || !SUCCESS_CRITERION_TYPES.includes(type as never)) {
        results.push({
          type: String(type),
          description: criterion.description ?? `criterion ${index}`,
          passed: false,
          evidence: {
            error: `"${String(type)}" is not a valid success-criterion type`,
            allowed: [...SUCCESS_CRITERION_TYPES],
          },
        });
        continue;
      }

      const criterionConfig = asRecord(criterion.config) ?? {};
      // The subject is threaded through unchanged: a criterion judges the run's own
      // evidence, and re-deriving it here would let a criterion see something the run did
      // not produce.
      const outcome = await this.dispatch(type as VerifierTypeAlias, criterionConfig, subject, request);

      results.push({
        type,
        description: criterion.description ?? `criterion ${index}`,
        passed: outcome.passed,
        evidence: outcome.error === undefined ? outcome.evidence : { ...outcome.evidence, error: outcome.error },
      });
    }

    return {
      passed: results.every((result) => result.passed),
      evidence: {
        criteria: results,
        passedCount: results.filter((result) => result.passed).length,
        totalCount: results.length,
      },
    };
  }

  // ── human ───────────────────────────────────────────────────────────────────

  private async verifyHuman(
    tenantId: string,
    config: Record<string, unknown>,
  ): Promise<VerificationOutcome> {
    const lookup = this.deps.approvals;
    if (lookup === undefined) {
      return {
        passed: false,
        evidence: { config },
        error: 'Human verification requires the approval service, which is not available yet',
      };
    }

    const approvalId = config['approvalId'];
    if (typeof approvalId !== 'string' || approvalId.length === 0) {
      return { passed: false, evidence: { config }, error: '"approvalId" is required' };
    }

    const approval = await lookup.decision(tenantId, approvalId);
    if (approval === null) {
      return { passed: false, evidence: { approvalId }, error: 'No such approval' };
    }

    return {
      passed: approval.decision === 'approved',
      evidence: { approvalId, status: approval.status, decision: approval.decision },
      ...(approval.decision === null ? { error: 'The approval has not been decided' } : {}),
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

const EVIDENCE_EXCERPT_CHARS = 2_000;
const MAX_REGEX_SUBJECT_CHARS = 1_000_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, key: string): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new ApiError('VALIDATION_ERROR', `"${key}" must contain only strings`);
    }
    out.push(entry);
  }
  return out;
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Cap what goes into `Verification.evidence`.
 *
 * The evidence column is read by the UI and kept forever, so an unbounded excerpt of a
 * 10 MB tool result would put the payload in the database — the thing the result cap in
 * Phase 4 exists to prevent.
 */
function truncateForEvidence(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= EVIDENCE_EXCERPT_CHARS
      ? value
      : `${value.slice(0, EVIDENCE_EXCERPT_CHARS)}… [truncated]`;
  }
  const text = toText(value);
  if (text.length <= EVIDENCE_EXCERPT_CHARS) return value;
  return `${text.slice(0, EVIDENCE_EXCERPT_CHARS)}… [truncated]`;
}
