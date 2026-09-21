import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateExpression } from '../src/services/tools/native-tools.js';
import type { NativeToolContext } from '../src/services/tools/native-tools.js';
import { createEngineHarness, TEST_TENANT, type EngineHarness } from './helpers/engine-harness.js';

let harness: EngineHarness;

beforeEach(async () => {
  harness = await createEngineHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/**
 * The context every native-tool call is made under.
 *
 * `agentId: null` because these calls are ad-hoc — no agent, no run — which is the case that
 * matters for `memory_store`: with no agent the memory it writes is the workspace's, and that is
 * the answer a missing `agentId` has to produce rather than an accidental one.
 */
const ctx: NativeToolContext = { tenantId: TEST_TENANT, runId: null, stepId: null, agentId: null };

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html' },
    ...init,
  });
}

describe('calculator — arithmetic', () => {
  it.each([
    ['1 + 1', 2],
    ['2 * 3 + 4', 10],
    ['4 + 2 * 3', 10],
    ['(4 + 2) * 3', 18],
    ['10 / 4', 2.5],
    ['10 % 3', 1],
    ['-5 + 2', -3],
    ['--5', 5],
    ['2 ^ 10', 1024],
    ['2 ^ 3 ^ 2', 512],
    ['1.5 * 2', 3],
    ['1e3 + 1', 1001],
  ])('evaluates %s to %s', (expression, expected) => {
    expect(evaluateExpression(expression)).toBe(expected);
  });

  it('applies precedence correctly rather than left to right', () => {
    expect(evaluateExpression('2 + 3 * 4')).toBe(14);
    expect(evaluateExpression('(2 + 3) * 4')).toBe(20);
  });

  it('treats ^ as right-associative, which is the conventional reading', () => {
    expect(evaluateExpression('2 ^ 3 ^ 2')).toBe(512);
  });

  it('supports the documented functions', () => {
    expect(evaluateExpression('abs(-3)')).toBe(3);
    expect(evaluateExpression('min(3, 1, 2)')).toBe(1);
    expect(evaluateExpression('max(3, 1, 2)')).toBe(3);
    expect(evaluateExpression('round(2.6)')).toBe(3);
    expect(evaluateExpression('floor(2.6)')).toBe(2);
    expect(evaluateExpression('ceil(2.1)')).toBe(3);
    expect(evaluateExpression('pow(2, 8)')).toBe(256);
    expect(evaluateExpression('sqrt(81)')).toBe(9);
  });

  it('supports the constants', () => {
    expect(evaluateExpression('pi')).toBeCloseTo(Math.PI);
    expect(evaluateExpression('e')).toBeCloseTo(Math.E);
    expect(evaluateExpression('round(pi * 100)')).toBe(314);
  });
});

describe('calculator — it parses, it does not eval', () => {
  // This is the test that matters. The expression comes from a language model reading
  // untrusted text; `Function('return ' + expr)()` would make every one of these a remote
  // code execution primitive.
  it.each([
    'process.exit(0)',
    'globalThis',
    'constructor',
    'require("fs")',
    'this',
    '(() => 1)()',
    '[].constructor',
    'process.env',
    'eval("1")',
  ])('refuses to evaluate %s', (expression) => {
    expect(() => evaluateExpression(expression)).toThrow();
  });

  it('rejects an unknown function rather than passing it through', () => {
    expect(() => evaluateExpression('exec(1)')).toThrow(/Unknown function/);
    expect(() => evaluateExpression('fetch(1)')).toThrow(/Unknown function/);
  });

  it('rejects a string literal, because the grammar has no strings', () => {
    // There is no way to smuggle code through as data: the tokeniser only knows numbers,
    // identifiers, operators and parentheses, so a quote is simply not a character it
    // accepts.
    expect(() => evaluateExpression('exec("rm -rf /")')).toThrow(/Unexpected character/);
  });

  it('rejects an unknown character', () => {
    expect(() => evaluateExpression('1 + $')).toThrow(/Unexpected character/);
  });

  it('rejects a missing closing parenthesis', () => {
    expect(() => evaluateExpression('(1 + 2')).toThrow(/Missing/);
  });

  it('rejects a function called with the wrong arity', () => {
    expect(() => evaluateExpression('pow(2)')).toThrow(/argument/);
    expect(() => evaluateExpression('abs(1, 2)')).toThrow(/argument/);
  });

  it('rejects an empty expression', () => {
    expect(() => evaluateExpression('   ')).toThrow();
  });

  it('rejects a result that is not a finite number', () => {
    // NaN and ±Infinity are not representable in JSON, so returning one would put `null`
    // in the tool result and the model would read that as a successful answer.
    expect(() => evaluateExpression('1 / 0')).toThrow(/finite/);
    expect(() => evaluateExpression('0 / 0')).toThrow(/finite/);
  });

  it('rejects trailing junk after a complete expression', () => {
    expect(() => evaluateExpression('1 + 1 2')).toThrow(/Unexpected/);
  });
});

describe('http_request', () => {
  it('returns a non-2xx status as a result rather than throwing', async () => {
    // The acceptance test is "GET example.com and verify status 200". If a 404 threw, the
    // verifier would never see the status it exists to judge.
    harness.onHttp(() => htmlResponse('not here', { status: 404 }));

    const result = (await harness.nativeTools.execute(
      'http_request',
      { url: 'https://example.test/missing' },
      ctx,
    )) as Record<string, unknown>;

    expect(result['status']).toBe(404);
    expect(result['ok']).toBe(false);
    expect(result['body']).toBe('not here');
  });

  it('reports the status, headers and body of a success', async () => {
    harness.onHttp(
      () => htmlResponse('<h1>hi</h1>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );

    const result = (await harness.nativeTools.execute(
      'http_request',
      { url: 'https://example.test/' },
      ctx,
    )) as Record<string, unknown>;

    expect(result['status']).toBe(200);
    expect(result['body']).toBe('<h1>hi</h1>');
    expect((result['headers'] as Record<string, string>)['content-type']).toBe('text/html');
  });

  it('classifies a GET as read-only and a POST as a side effect', () => {
    expect(harness.nativeTools.capabilitiesFor('http_request', { url: 'https://x.test/' })).toEqual([
      'http',
      'read_only',
    ]);
    expect(
      harness.nativeTools.capabilitiesFor('http_request', { url: 'https://x.test/', method: 'POST' }),
    ).toEqual(['http', 'external_side_effect']);
  });

  it('treats an unlisted method as unsafe rather than defaulting to GET', async () => {
    harness.onHttp(() => htmlResponse('ok'));
    const result = (await harness.nativeTools.execute(
      'http_request',
      { url: 'https://x.test/', method: 'TRACE' },
      ctx,
    ).catch((cause: unknown) => cause)) as Error;
    expect(result.message).toMatch(/Unsupported HTTP method/);
  });

  it('rejects a relative url', async () => {
    await expect(
      harness.nativeTools.execute('http_request', { url: '/relative' }, ctx),
    ).rejects.toThrow(/absolute URL/);
  });

  it('rejects a non-http protocol', async () => {
    await expect(
      harness.nativeTools.execute('http_request', { url: 'file:///etc/passwd' }, ctx),
    ).rejects.toThrow(/http or https/);
  });

  it('caps a body that exceeds the response budget', async () => {
    const huge = 'x'.repeat(200_000);
    harness.onHttp(() => htmlResponse(huge));

    const result = (await harness.nativeTools.execute(
      'http_request',
      { url: 'https://x.test/huge' },
      ctx,
    )) as Record<string, unknown>;

    // The harness registry is configured with a 4 MB budget, so this body fits — the point
    // here is that the reported byte count is honest, not that it was truncated.
    expect(result['bodyBytes']).toBe(200_000);
    expect(result['bodyTruncated']).toBe(false);
  });

  it('sends the declared headers and method', async () => {
    harness.onHttp(() => htmlResponse('ok'));
    await harness.nativeTools.execute(
      'http_request',
      { url: 'https://x.test/', method: 'post', headers: { 'x-token': 'abc' }, body: '{"a":1}' },
      ctx,
    );

    expect(harness.httpCalls[0]!.method).toBe('POST');
    expect(harness.httpCalls[0]!.headers['x-token']).toBe('abc');
  });
});

describe('file tools', () => {
  it('round-trips a file through the workspace jail', async () => {
    await harness.nativeTools.execute('file_write', { path: 'notes/todo.txt', content: 'buy milk' }, ctx);

    const read = (await harness.nativeTools.execute(
      'file_read',
      { path: 'notes/todo.txt' },
      ctx,
    )) as Record<string, unknown>;

    expect(read['content']).toBe('buy milk');
    expect(read['bytes']).toBe(8);
    expect(read['validUtf8']).toBe(true);
  });

  it('creates a file on first append rather than failing', async () => {
    await harness.nativeTools.execute('file_write', { path: 'log.txt', content: 'a', mode: 'append' }, ctx);
    await harness.nativeTools.execute('file_write', { path: 'log.txt', content: 'b', mode: 'append' }, ctx);

    const read = (await harness.nativeTools.execute('file_read', { path: 'log.txt' }, ctx)) as Record<
      string,
      unknown
    >;
    expect(read['content']).toBe('ab');
  });

  it('overwrites by default', async () => {
    await harness.nativeTools.execute('file_write', { path: 'a.txt', content: 'first' }, ctx);
    await harness.nativeTools.execute('file_write', { path: 'a.txt', content: 'second' }, ctx);

    const read = (await harness.nativeTools.execute('file_read', { path: 'a.txt' }, ctx)) as Record<
      string,
      unknown
    >;
    expect(read['content']).toBe('second');
  });

  it('refuses to escape the workspace', async () => {
    await expect(
      harness.nativeTools.execute('file_write', { path: '../../escape.txt', content: 'nope' }, ctx),
    ).rejects.toThrow();
  });

  it('declares the write capabilities that make it unsafe to replay', () => {
    expect(harness.nativeTools.capabilitiesFor('file_write', {})).toEqual([
      'filesystem_write',
      'writes_files',
    ]);
    expect(harness.nativeTools.capabilitiesFor('file_read', {})).toEqual([
      'filesystem_read',
      'read_only',
    ]);
  });
});

describe('date_time', () => {
  it('returns the current instant', async () => {
    const result = (await harness.nativeTools.execute('date_time', {}, ctx)) as Record<string, unknown>;
    expect(typeof result['iso']).toBe('string');
    expect(Number.isFinite(result['epochMs'])).toBe(true);
  });

  it('formats an explicit timestamp in a named timezone', async () => {
    const result = (await harness.nativeTools.execute(
      'date_time',
      { operation: 'format', timestamp: '2024-01-01T12:00:00Z', timezone: 'America/New_York' },
      ctx,
    )) as Record<string, unknown>;

    expect(result['iso']).toBe('2024-01-01T12:00:00.000Z');
    expect(String(result['formatted'])).toContain('2024');
  });

  it('rejects an invalid timestamp', async () => {
    await expect(
      harness.nativeTools.execute('date_time', { operation: 'format', timestamp: 'not a date' }, ctx),
    ).rejects.toThrow(/valid date/);
  });

  it('rejects an unknown operation', async () => {
    await expect(harness.nativeTools.execute('date_time', { operation: 'travel' }, ctx)).rejects.toThrow(
      /Unsupported operation/,
    );
  });
});

describe('the registry', () => {
  it('registers exactly the tools whose dependencies exist', () => {
    const names = harness.nativeTools.list().map((tool) => tool.name).sort();
    // `notify` is absent because no notification sink was supplied. Offering a tool that
    // can only fail is worse than not offering it: a model that is given a tool will use it.
    expect(names).toEqual(['calculator', 'date_time', 'file_read', 'file_write', 'http_request']);
  });

  it('gives every tool a JSON Schema and a description', () => {
    for (const tool of harness.nativeTools.list()) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('rejects an unknown tool name', async () => {
    await expect(harness.nativeTools.execute('rm_rf', {}, ctx)).rejects.toThrow(/Unknown native tool/);
  });
});
