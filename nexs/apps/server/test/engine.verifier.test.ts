import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { VerifierType } from '@nexs/shared';
import { Verifier, type ApprovalLookup, type VerificationSubject } from '../src/services/engine/verifier.js';
import { createEngineHarness, TEST_TENANT, type EngineHarness } from './helpers/engine-harness.js';

const logger = pino({ level: 'silent' });

let harness: EngineHarness;

beforeEach(async () => {
  harness = await createEngineHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/** A browser inspector that answers with whatever state the test declares. */
function browserStub(state: {
  url?: string;
  title?: string;
  text?: string;
  selectors?: string[];
}) {
  const present = new Set(state.selectors ?? []);
  return {
    act: (_tenantId: string, _sessionId: string, action: { type: string; selector?: string }) => {
      if (action.type === 'inspect') {
        return Promise.resolve({
          sessionId: 'bs_test',
          action: 'inspect' as const,
          status: 'active',
          currentUrl: state.url ?? 'https://example.test/',
          title: state.title ?? 'Example',
          screenshotRef: null,
          output: { url: state.url ?? 'https://example.test/', title: state.title ?? 'Example', text: state.text ?? '' },
          durationMs: 1,
        });
      }
      if (action.type === 'extract') {
        if (action.selector !== undefined && !present.has(action.selector)) {
          return Promise.reject(new Error(`no element matches ${action.selector}`));
        }
        return Promise.resolve({
          sessionId: 'bs_test',
          action: 'extract' as const,
          status: 'active',
          currentUrl: state.url ?? null,
          title: null,
          screenshotRef: null,
          output: { selector: action.selector ?? null, value: 'found' },
          durationMs: 1,
        });
      }
      return Promise.reject(new Error(`unexpected browser action ${action.type}`));
    },
  };
}

function subject(overrides: Partial<VerificationSubject> = {}): VerificationSubject {
  return {
    output: null,
    toolResult: null,
    outputs: {},
    lastHttpResult: null,
    browserSessionId: null,
    ...overrides,
  };
}

function makeVerifier(overrides: { browser?: ReturnType<typeof browserStub>; approvals?: ApprovalLookup } = {}) {
  return new Verifier({
    files: harness.files,
    browser: overrides.browser ?? browserStub({}),
    logger,
    ...(overrides.approvals === undefined ? {} : { approvals: overrides.approvals }),
  });
}

async function verify(
  type: VerifierType,
  config: Record<string, unknown>,
  sub: VerificationSubject = subject(),
  verifier = makeVerifier(),
) {
  return verifier.verify({ tenantId: TEST_TENANT, runId: 'run_test', type, config, subject: sub });
}

describe('schema verification', () => {
  const schema = {
    type: 'object',
    properties: { count: { type: 'number' } },
    required: ['count'],
    additionalProperties: false,
  };

  it('passes when the output matches', async () => {
    const outcome = await verify('schema', { schema }, subject({ output: { count: 3 } }));
    expect(outcome.passed).toBe(true);
  });

  it('fails when the output does not match, and says why', async () => {
    const outcome = await verify('schema', { schema }, subject({ output: { count: 'three' } }));
    expect(outcome.passed).toBe(false);
    expect(JSON.stringify(outcome.evidence)).toMatch(/count/);
  });

  it('fails rather than passes when the schema itself is invalid', async () => {
    // The worst possible failure for a verification system is a check that silently passes
    // because it could not be evaluated — it turns every goal into "completed" the moment
    // something breaks.
    const outcome = await verify('schema', { schema: { type: 'nonsense-type' } }, subject({ output: 1 }));
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toBeDefined();
  });

  it('fails when no schema is supplied', async () => {
    const outcome = await verify('schema', {}, subject({ output: {} }));
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toMatch(/schema/);
  });

  it('compiles each distinct schema once', async () => {
    const verifier = makeVerifier();
    const first = await verify('schema', { schema }, subject({ output: { count: 1 } }), verifier);
    const second = await verify('schema', { schema }, subject({ output: { count: 2 } }), verifier);
    expect(first.passed).toBe(true);
    expect(second.passed).toBe(true);
  });

  it('verifies against the tool result, not the step output', async () => {
    const outcome = await verify(
      'tool_result',
      { schema: { type: 'string' } },
      subject({ output: { unrelated: true }, toolResult: 'the result' }),
    );
    expect(outcome.passed).toBe(true);
  });
});

describe('content verification', () => {
  it('passes when every needle is present', async () => {
    const outcome = await verify(
      'content',
      { source: 'output', contains: ['alpha', 'beta'] },
      subject({ output: 'alpha and beta' }),
    );
    expect(outcome.passed).toBe(true);
  });

  it('names the needles that were missing', async () => {
    const outcome = await verify(
      'content',
      { source: 'output', contains: ['alpha', 'gamma'] },
      subject({ output: 'alpha and beta' }),
    );
    expect(outcome.passed).toBe(false);
    expect((outcome.evidence['contains'] as { missing: string[] }).missing).toEqual(['gamma']);
  });

  it('applies a regex', async () => {
    const passing = await verify(
      'content',
      { source: 'output', regex: 'order #\\d{4}' },
      subject({ output: 'your order #1234 shipped' }),
    );
    expect(passing.passed).toBe(true);

    const failing = await verify(
      'content',
      { source: 'output', regex: 'order #\\d{4}' },
      subject({ output: 'no order here' }),
    );
    expect(failing.passed).toBe(false);
  });

  it('fails on an invalid regex rather than ignoring it', async () => {
    const outcome = await verify('content', { source: 'output', regex: '([' }, subject({ output: 'x' }));
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toMatch(/Invalid regex/);
  });

  it('reads from a file when asked', async () => {
    await harness.files.writeFile(TEST_TENANT, 'report.txt', 'total: 42');

    const outcome = await verify('content', { source: 'file', path: 'report.txt', contains: ['42'] });
    expect(outcome.passed).toBe(true);
  });

  it('requires a path when the source is a file', async () => {
    const outcome = await verify('content', { source: 'file' });
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toMatch(/"path" is required/);
  });

  it('rejects an unknown source', async () => {
    const outcome = await verify('content', { source: 'elsewhere' });
    expect(outcome.passed).toBe(false);
  });

  it('serialises a non-string output before matching', async () => {
    const outcome = await verify(
      'content',
      { source: 'output', contains: ['"ok":true'] },
      subject({ output: { ok: true } }),
    );
    expect(outcome.passed).toBe(true);
  });
});

describe('http_response verification', () => {
  const recorded = {
    status: 200,
    headers: { 'content-type': 'text/html', 'x-served-by': 'edge' },
    body: '<html><body>Example Domain</body></html>',
  };

  it('passes when the recorded status matches', async () => {
    const outcome = await verify('http_response', { expectedStatus: 200 }, subject({ lastHttpResult: recorded }));
    expect(outcome.passed).toBe(true);
  });

  it('fails on a status mismatch and reports both numbers', async () => {
    const outcome = await verify('http_response', { expectedStatus: 201 }, subject({ lastHttpResult: recorded }));
    expect(outcome.passed).toBe(false);
    expect(outcome.evidence['expectedStatus']).toBe(201);
    expect(outcome.evidence['actualStatus']).toBe(200);
  });

  it('checks the body contents', async () => {
    const passing = await verify(
      'http_response',
      { expectedStatus: 200, bodyContains: ['Example Domain'] },
      subject({ lastHttpResult: recorded }),
    );
    expect(passing.passed).toBe(true);

    const failing = await verify(
      'http_response',
      { expectedStatus: 200, bodyContains: ['Not Here'] },
      subject({ lastHttpResult: recorded }),
    );
    expect(failing.passed).toBe(false);
  });

  it('matches headers case-insensitively', async () => {
    // A literal comparison would report a mismatch for `Content-Type` against
    // `content-type`, which is not a real failure.
    const outcome = await verify(
      'http_response',
      { expectedStatus: 200, headers: { 'Content-Type': 'text/html' } },
      subject({ lastHttpResult: recorded }),
    );
    expect(outcome.passed).toBe(true);
  });

  it('reports a header that did not match', async () => {
    const outcome = await verify(
      'http_response',
      { expectedStatus: 200, headers: { 'x-served-by': 'origin' } },
      subject({ lastHttpResult: recorded }),
    );
    expect(outcome.passed).toBe(false);
    expect((outcome.evidence['headerMismatches'] as unknown[]).length).toBe(1);
  });

  it('fails when there is no recorded response to judge', async () => {
    const outcome = await verify('http_response', { expectedStatus: 200 });
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toMatch(/No recorded HTTP response/);
  });

  it('requires an integer expectedStatus', async () => {
    const outcome = await verify('http_response', { expectedStatus: '200' }, subject({ lastHttpResult: recorded }));
    expect(outcome.passed).toBe(false);
  });
});

describe('file_exists verification', () => {
  it('passes for a file that is there', async () => {
    await harness.files.writeFile(TEST_TENANT, 'artifact.txt', 'done');
    const outcome = await verify('file_exists', { path: 'artifact.txt' });
    expect(outcome.passed).toBe(true);
  });

  it('fails for a file that is not', async () => {
    const outcome = await verify('file_exists', { path: 'missing.txt' });
    expect(outcome.passed).toBe(false);
    expect(outcome.evidence['exists']).toBe(false);
  });

  it('treats an unreadably large file as present', async () => {
    // The 1-byte budget turns `readFile` into a `stat`: a file that exists but exceeds the
    // budget throws VALIDATION_ERROR, which is proof of existence rather than absence.
    await harness.files.writeFile(TEST_TENANT, 'big.txt', 'x'.repeat(10_000));
    const outcome = await verify('file_exists', { path: 'big.txt' });
    expect(outcome.passed).toBe(true);
  });

  it('requires a path', async () => {
    const outcome = await verify('file_exists', {});
    expect(outcome.passed).toBe(false);
  });
});

describe('browser_state verification', () => {
  const session = subject({ browserSessionId: 'bs_test' });

  it('fails when the run has no browser session', async () => {
    const outcome = await verify('browser_state', { text: 'anything' }, subject());
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toMatch(/no browser session/);
  });

  it('matches the page text', async () => {
    const verifier = makeVerifier({ browser: browserStub({ text: 'Welcome back, Ada' }) });
    const outcome = await verify('browser_state', { text: 'Welcome back' }, session, verifier);
    expect(outcome.passed).toBe(true);
  });

  it('matches the url against a pattern', async () => {
    const verifier = makeVerifier({ browser: browserStub({ url: 'https://app.test/dashboard' }) });
    const outcome = await verify('browser_state', { urlMatches: '/dashboard$' }, session, verifier);
    expect(outcome.passed).toBe(true);
  });

  it('detects an absent selector', async () => {
    const verifier = makeVerifier({ browser: browserStub({ selectors: [] }) });
    const outcome = await verify('browser_state', { selector: '#confirmation' }, session, verifier);
    expect(outcome.passed).toBe(false);
    expect((outcome.evidence['selector'] as { present: boolean }).present).toBe(false);
  });

  it('detects a present selector', async () => {
    const verifier = makeVerifier({ browser: browserStub({ selectors: ['#confirmation'] }) });
    const outcome = await verify('browser_state', { selector: '#confirmation' }, session, verifier);
    expect(outcome.passed).toBe(true);
  });

  it('fails on an invalid url pattern', async () => {
    const verifier = makeVerifier({ browser: browserStub({}) });
    const outcome = await verify('browser_state', { urlMatches: '([' }, session, verifier);
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toMatch(/Invalid urlMatches/);
  });
});

describe('goal_criteria verification', () => {
  it('passes only when every criterion passes', async () => {
    const outcome = await verify('goal_criteria', {
      criteria: [
        { type: 'content', config: { source: 'output', contains: ['ok'] }, description: 'says ok' },
        { type: 'file_exists', config: { path: 'artifact.txt' }, description: 'file written' },
      ],
    }, subject({ output: 'ok' }));
    // The file was never written, so the second criterion must fail the whole goal.
    expect(outcome.passed).toBe(false);
    expect(outcome.evidence['passedCount']).toBe(1);
    expect(outcome.evidence['totalCount']).toBe(2);
  });

  it('passes when every criterion passes', async () => {
    await harness.files.writeFile(TEST_TENANT, 'artifact.txt', 'done');
    const outcome = await verify(
      'goal_criteria',
      {
        criteria: [
          { type: 'content', config: { source: 'output', contains: ['ok'] }, description: 'says ok' },
          { type: 'file_exists', config: { path: 'artifact.txt' }, description: 'file written' },
        ],
      },
      subject({ output: 'ok' }),
    );
    expect(outcome.passed).toBe(true);
  });

  it('keeps each sub-result so a failure is diagnosable', async () => {
    const outcome = await verify('goal_criteria', {
      criteria: [
        { type: 'content', config: { source: 'output', contains: ['nope'] }, description: 'first' },
        { type: 'file_exists', config: { path: 'gone.txt' }, description: 'second' },
      ],
    }, subject({ output: 'ok' }));

    const results = outcome.evidence['criteria'] as Array<{ description: string; passed: boolean }>;
    expect(results.map((result) => result.description)).toEqual(['first', 'second']);
    expect(results.every((result) => !result.passed)).toBe(true);
  });

  it('rejects a criterion type outside the closed set', async () => {
    // A goal must not be able to certify itself: `goal_criteria` and `human` are excluded
    // from the criterion vocabulary on purpose.
    const outcome = await verify('goal_criteria', {
      criteria: [{ type: 'goal_criteria', config: {}, description: 'self-certifying' }],
    });
    expect(outcome.passed).toBe(false);
    expect(JSON.stringify(outcome.evidence)).toMatch(/not a valid success-criterion type/);
  });

  it('rejects a human criterion too', async () => {
    const outcome = await verify('goal_criteria', {
      criteria: [{ type: 'human', config: {}, description: 'ask someone' }],
    });
    expect(outcome.passed).toBe(false);
  });

  it('fails on an empty criteria list', async () => {
    const outcome = await verify('goal_criteria', { criteria: [] });
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toMatch(/non-empty array/);
  });

  it('judges the run subject, not something re-derived', async () => {
    const outcome = await verify(
      'goal_criteria',
      { criteria: [{ type: 'content', config: { source: 'output', contains: ['from the run'] }, description: 'x' }] },
      subject({ output: 'this came from the run' }),
    );
    expect(outcome.passed).toBe(true);
  });
});

describe('human verification', () => {
  it('fails when the approval service is not available', async () => {
    const outcome = await verify('human', { approvalId: 'apr_1' });
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toMatch(/approval service/);
  });

  it('passes when the approval was approved', async () => {
    const approvals: ApprovalLookup = {
      decision: () => Promise.resolve({ status: 'approved', decision: 'approved' }),
    };
    const outcome = await verify('human', { approvalId: 'apr_1' }, subject(), makeVerifier({ approvals }));
    expect(outcome.passed).toBe(true);
  });

  it('fails when the approval was rejected', async () => {
    const approvals: ApprovalLookup = {
      decision: () => Promise.resolve({ status: 'rejected', decision: 'rejected' }),
    };
    const outcome = await verify('human', { approvalId: 'apr_1' }, subject(), makeVerifier({ approvals }));
    expect(outcome.passed).toBe(false);
  });

  it('fails while the approval is still undecided', async () => {
    const approvals: ApprovalLookup = {
      decision: () => Promise.resolve({ status: 'pending', decision: null }),
    };
    const outcome = await verify('human', { approvalId: 'apr_1' }, subject(), makeVerifier({ approvals }));
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toMatch(/has not been decided/);
  });

  it('requires an approvalId', async () => {
    const approvals: ApprovalLookup = { decision: () => Promise.resolve(null) };
    const outcome = await verify('human', {}, subject(), makeVerifier({ approvals }));
    expect(outcome.passed).toBe(false);
  });
});

describe('the verifier never passes on an error', () => {
  it('fails an unknown verification type', async () => {
    const outcome = await verify('telepathy' as VerifierType, {});
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toMatch(/Unknown verification type/);
  });

  it('fails rather than throwing when a dependency blows up', async () => {
    const verifier = new Verifier({
      files: harness.files,
      browser: { act: () => Promise.reject(new Error('browser exploded')) },
      logger,
    });
    const outcome = await verify('browser_state', { text: 'x' }, subject({ browserSessionId: 'bs_1' }), verifier);
    // A thrown error would fail the *step* rather than the verification, and the run would
    // lose the distinction between "the work went wrong" and "we could not tell".
    expect(outcome.passed).toBe(false);
    expect(outcome.error).toMatch(/browser exploded/);
  });
});
