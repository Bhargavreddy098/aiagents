import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TOOL_CAPABILITIES,
  hasSideEffects,
  isReadOnly,
  mayAutoReconnect,
  type ApiError,
} from '@nexs/shared';
import { LocalStorageService, readText } from '../src/services/storage/storage.service.js';
import {
  byteLength,
  capToolResult,
  formatBytes,
  serialiseToolResult,
  sliceUtf8,
} from '../src/services/tools/tool-result.js';

/**
 * The tool result cap, and the capability vocabulary the engine's replay policy reads.
 *
 * The plan's acceptance test for this phase is: *a 10 MB tool result is capped and the
 * run continues*. "Capped" is the easy half — the half worth testing is that the payload
 * is still recoverable afterwards, because a cap that discards data is a silent data
 * loss bug wearing a resource-limit costume.
 */

const TENANT = 'tnt_test';

let root: string;
let storage: LocalStorageService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexs-toolcap-'));
  storage = new LocalStorageService(root);
});

afterEach(async () => {
  // Best-effort: a refused delete must never be reported as a test failure.
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

// ── capability vocabulary ─────────────────────────────────────────────────────

describe('tool capabilities', () => {
  it('treats the effectful capabilities as side effects', () => {
    for (const capability of ['external_side_effect', 'writes_files', 'notify'] as const) {
      expect(hasSideEffects([capability]), capability).toBe(true);
    }
  });

  it('treats the informational capabilities as free of side effects', () => {
    for (const capability of ['search', 'http', 'transform', 'calculation', 'memory'] as const) {
      expect(hasSideEffects([capability]), capability).toBe(false);
    }
  });

  it('does not treat an unknown capability as effectful', () => {
    // The vocabulary is closed, so an unrecognised string is more likely a typo than a
    // secret effect. The complementary guard — refusing to auto-retry a tool that
    // declares nothing — belongs to the engine's policy.
    expect(hasSideEffects(['something_new'])).toBe(false);
    expect(hasSideEffects([])).toBe(false);
  });

  it('requires read_only *and* no declared effect to call a tool read-only', () => {
    expect(isReadOnly(['read_only'])).toBe(true);
    expect(isReadOnly(['read_only', 'search'])).toBe(true);

    // Contradictory declaration: the effect wins. A tool that both claims to be read-only
    // and declares a side effect must be treated as effectful, because the cost of being
    // wrong is a duplicated action rather than a redundant read.
    expect(isReadOnly(['read_only', 'external_side_effect'])).toBe(false);
    expect(isReadOnly(['search'])).toBe(false);
  });

  it('auto-reconnects only read-only tools after a crash [gap #22]', () => {
    expect(mayAutoReconnect(['read_only', 'search'])).toBe(true);
    expect(mayAutoReconnect(['external_side_effect'])).toBe(false);
    expect(mayAutoReconnect(['writes_files'])).toBe(false);
    // Declares nothing — must not be silently reconnected.
    expect(mayAutoReconnect([])).toBe(false);
  });

  it('exposes the vocabulary the engine and the UI both read', () => {
    expect(TOOL_CAPABILITIES).toContain('read_only');
    expect(TOOL_CAPABILITIES).toContain('external_side_effect');
    expect(TOOL_CAPABILITIES).toContain('writes_files');
    expect(new Set(TOOL_CAPABILITIES).size).toBe(TOOL_CAPABILITIES.length);
  });
});

// ── serialisation helpers ─────────────────────────────────────────────────────

describe('serialiseToolResult', () => {
  it('passes a string through unchanged', () => {
    expect(serialiseToolResult('already text')).toBe('already text');
  });

  it('serialises structures to JSON', () => {
    expect(serialiseToolResult({ a: 1 })).toBe('{"a":1}');
    expect(serialiseToolResult([1, 2])).toBe('[1,2]');
    expect(serialiseToolResult(null)).toBe('null');
  });

  it('survives a circular structure instead of throwing', () => {
    // Failing the step because a tool returned a cyclic object would be a poor trade.
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;

    expect(() => serialiseToolResult(cyclic)).not.toThrow();
  });

  it('survives a BigInt', () => {
    expect(() => serialiseToolResult({ big: 1n })).not.toThrow();
  });
});

describe('sliceUtf8', () => {
  it('never splits a multi-byte character', () => {
    const text = '日本語'; // 9 bytes, 3 characters

    expect(sliceUtf8(text, 3)).toBe('日');
    expect(sliceUtf8(text, 4)).toBe('日');
    expect(sliceUtf8(text, 6)).toBe('日本');
    expect(sliceUtf8(text, 9)).toBe('日本語');
  });

  it('returns the whole string when it fits', () => {
    expect(sliceUtf8('abc', 100)).toBe('abc');
  });

  it('returns nothing for a zero or negative budget', () => {
    expect(sliceUtf8('abc', 0)).toBe('');
    expect(sliceUtf8('abc', -1)).toBe('');
  });

  it('measures in bytes, not characters', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('日')).toBe(3);
  });
});

// ── the cap ───────────────────────────────────────────────────────────────────

describe('capToolResult', () => {
  it('passes a small result through untouched', async () => {
    const result = await capToolResult({ storage }, 'small payload', {
      maxBytes: 1_000,
      tenantId: TENANT,
    });

    expect(result).toEqual({ content: 'small payload', truncated: false, originalBytes: 13 });
    // Nothing was written, so a small result costs no storage.
    expect(await storage.exists(`${TENANT}/tool-results`)).toBe(false);
  });

  it('does not truncate a result exactly at the limit', async () => {
    const payload = 'x'.repeat(1_000);
    const result = await capToolResult({ storage }, payload, {
      maxBytes: 1_000,
      tenantId: TENANT,
    });

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(payload);
  });

  it('caps a 10 MB result and keeps the full payload retrievable', async () => {
    // The plan's acceptance test.
    const payload = 'A'.repeat(10 * 1024 * 1024);

    const result = await capToolResult({ storage }, payload, {
      maxBytes: 64 * 1024,
      tenantId: TENANT,
      label: 'http_request',
    });

    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(payload.length);
    expect(result.ref).toBeDefined();

    // The inline content stays within the cap...
    expect(byteLength(result.content)).toBeLessThanOrEqual(64 * 1024);

    // ...and nothing was lost: the whole 10 MB is still in storage.
    const stored = await readText(storage, result.ref!);
    expect(stored.length).toBe(payload.length);
    expect(stored).toBe(payload);
  });

  it('keeps the head and the tail, which is where the meaning is', async () => {
    const payload = `START${'m'.repeat(10_000)}END`;

    const result = await capToolResult({ storage }, payload, {
      maxBytes: 500,
      tenantId: TENANT,
    });

    // A head-only summary of a failed request shows the request and not the reason.
    expect(result.content.startsWith('START')).toBe(true);
    expect(result.content).toContain('END');
    expect(result.content).toContain('truncated');
  });

  it('reports the original size and the label in the summary', async () => {
    const payload = 'z'.repeat(5_000);

    const result = await capToolResult({ storage }, payload, {
      maxBytes: 300,
      tenantId: TENANT,
      label: 'browser_screenshot',
    });

    expect(result.content).toContain('browser_screenshot');
    expect(result.content).toContain('5000 bytes');
  });

  it('never produces a summary larger than the cap it was given', async () => {
    // The failure mode this guards against: replacing a large result with a large summary
    // and calling it capped.
    const payload = 'q'.repeat(1_000_000);

    for (const maxBytes of [64, 200, 1_024, 8_192]) {
      const result = await capToolResult({ storage }, payload, { maxBytes, tenantId: TENANT });
      expect(byteLength(result.content), `cap ${maxBytes}`).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('stores each distinct payload under its own key', async () => {
    const first = await capToolResult({ storage }, 'a'.repeat(500), {
      maxBytes: 100,
      tenantId: TENANT,
    });
    const second = await capToolResult({ storage }, 'b'.repeat(500), {
      maxBytes: 100,
      tenantId: TENANT,
    });

    expect(first.ref).not.toBe(second.ref);
    expect(await readText(storage, first.ref!)).toBe('a'.repeat(500));
    expect(await readText(storage, second.ref!)).toBe('b'.repeat(500));
  });

  it('stores the same payload once, however many times it is capped', async () => {
    // Content-addressed keys mean a tool that returns the same large blob on every poll
    // does not fill the disk with copies of it.
    const payload = 'c'.repeat(500);

    const first = await capToolResult({ storage }, payload, { maxBytes: 100, tenantId: TENANT });
    const second = await capToolResult({ storage }, payload, { maxBytes: 100, tenantId: TENANT });

    expect(first.ref).toBe(second.ref);
  });

  it('keeps tenants’ overflowed payloads in separate keyspaces', async () => {
    const payload = 'd'.repeat(500);

    const one = await capToolResult({ storage }, payload, { maxBytes: 100, tenantId: 't1' });
    const two = await capToolResult({ storage }, payload, { maxBytes: 100, tenantId: 't2' });

    expect(one.ref).not.toBe(two.ref);
    expect(one.ref!.startsWith('t1/')).toBe(true);
    expect(two.ref!.startsWith('t2/')).toBe(true);
  });

  it('caps a structured payload too, not just a string', async () => {
    const payload = { rows: Array.from({ length: 5_000 }, (_, i) => ({ i, value: 'x' })) };

    const result = await capToolResult({ storage }, payload, {
      maxBytes: 1_024,
      tenantId: TENANT,
    });

    expect(result.truncated).toBe(true);
    expect(byteLength(result.content)).toBeLessThanOrEqual(1_024);

    // The stored copy is the JSON the model would have seen, so a later reader can parse
    // it back into the same shape.
    const stored = JSON.parse(await readText(storage, result.ref!)) as { rows: unknown[] };
    expect(stored.rows).toHaveLength(5_000);
  });

  it('rejects a non-positive cap', async () => {
    const error = (await capToolResult({ storage }, 'x', {
      maxBytes: 0,
      tenantId: TENANT,
    }).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('VALIDATION_ERROR');
  });
});

describe('formatBytes', () => {
  it('reads as a size a human can use in a log line', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2_048)).toBe('2.0 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
  });
});
