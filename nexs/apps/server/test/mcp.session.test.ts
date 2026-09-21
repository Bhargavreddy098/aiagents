import { describe, expect, it } from 'vitest';
import { ApiError, isReadOnly, mayAutoReconnect } from '@nexs/shared';
import {
  capabilitiesFromAnnotations,
  normaliseMcpContent,
} from '../src/services/mcp/session.js';
import { Semaphore } from '../src/services/mcp/semaphore.js';

/**
 * The pure parts of the MCP seam.
 *
 * `normaliseMcpContent` is the fiddliest code in the phase: it consumes arbitrary JSON from
 * a third-party server and has to produce one honest string. `capabilitiesFromAnnotations`
 * is the most *dangerous* code in the phase: it decides whether replaying a tool is safe,
 * and getting it wrong is how a crash-resume sends the same email twice.
 */

// ── result normalisation ──────────────────────────────────────────────────────

describe('normalising a tools/call result', () => {
  it('inlines text blocks, joined in order', () => {
    const result = normaliseMcpContent({
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    });

    expect(result).toEqual({ content: 'first\nsecond', isError: false });
  });

  it('describes an image rather than inlining its base64', () => {
    // Base64 in a prompt is enormous and useless to a text model, and pushing it through
    // the tool-result cap would produce a head/tail summary of base64 — meaningless. Saying
    // what arrived and how big it was is the honest alternative.
    const result = normaliseMcpContent({
      content: [{ type: 'image', data: 'A'.repeat(2048), mimeType: 'image/png' }],
    });

    expect(result.content).toBe('[image image/png — 2048 base64 chars, not inlined into the prompt]');
    expect(result.content).not.toContain('AAAA');
  });

  it('describes an audio block the same way', () => {
    const result = normaliseMcpContent({
      content: [{ type: 'audio', data: 'B'.repeat(64), mimeType: 'audio/wav' }],
    });

    expect(result.content).toBe('[audio audio/wav — 64 base64 chars, not inlined into the prompt]');
  });

  it('inlines the text of an embedded resource', () => {
    const result = normaliseMcpContent({
      content: [{ type: 'resource', resource: { uri: 'file:///notes.md', text: '# Notes' } }],
    });

    expect(result.content).toBe('# Notes');
  });

  it('describes a binary embedded resource', () => {
    const result = normaliseMcpContent({
      content: [
        {
          type: 'resource',
          resource: { uri: 'file:///x.png', mimeType: 'image/png', blob: 'C'.repeat(32) },
        },
      ],
    });

    expect(result.content).toBe('[resource file:///x.png image/png — 32 base64 chars, not inlined]');
  });

  it('renders a resource link as a reference', () => {
    const result = normaliseMcpContent({
      content: [{ type: 'resource_link', uri: 'file:///a.txt', name: 'a.txt' }],
    });

    expect(result.content).toBe('[resource_link a.txt file:///a.txt]');
  });

  it('falls back to structuredContent when there are no text blocks', () => {
    // Servers that return structured output typically send no text at all. Without this
    // fallback the model sees an empty string and concludes the tool returned nothing.
    const result = normaliseMcpContent({
      content: [],
      structuredContent: { temperature: 21, unit: 'C' },
    });

    expect(JSON.parse(result.content)).toEqual({ temperature: 21, unit: 'C' });
  });

  it('prefers text blocks over structuredContent when both are present', () => {
    const result = normaliseMcpContent({
      content: [{ type: 'text', text: 'It is 21C' }],
      structuredContent: { temperature: 21 },
    });

    expect(result.content).toBe('It is 21C');
  });

  it('carries isError through instead of throwing', () => {
    // A tool reporting failure is a *successful call* with a negative answer. Folding it
    // into a transport error would make the engine retry a deterministic failure.
    const result = normaliseMcpContent({
      content: [{ type: 'text', text: 'file not found' }],
      isError: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBe('file not found');
  });

  it('understands the 2024-10-07 compatibility shape', () => {
    const result = normaliseMcpContent({ toolResult: { legacy: true } });

    expect(JSON.parse(result.content)).toEqual({ legacy: true });
    expect(result.isError).toBe(false);
  });

  it('survives a payload that is not an object at all', () => {
    expect(normaliseMcpContent('plain string').content).toBe('plain string');
    expect(normaliseMcpContent(null).content).toBe('null');
    expect(normaliseMcpContent(undefined).content).toBe('undefined');
  });

  it('serialises an unknown block type rather than dropping it', () => {
    // Dropping it would silently lose data a future protocol version sent us; the JSON at
    // least survives into the transcript where a human can see it.
    const result = normaliseMcpContent({ content: [{ type: 'hologram', payload: 7 }] });

    expect(JSON.parse(result.content)).toEqual({ type: 'hologram', payload: 7 });
  });

  it('ignores non-object entries in the content array', () => {
    const result = normaliseMcpContent({
      content: [null, 'oops', 42, { type: 'text', text: 'kept' }],
    });

    expect(result.content).toBe('kept');
  });
});

// ── capability inference ──────────────────────────────────────────────────────

describe('inferring capabilities from MCP annotations', () => {
  it('treats a tool that declares nothing as having an effect', () => {
    // The conservative direction, and the whole reason this function exists: a
    // third-party tool's capabilities cannot be read off its name, so an unannotated tool
    // must not be silently granted the right to be replayed.
    expect(capabilitiesFromAnnotations(undefined)).toEqual(['external_side_effect']);
    expect(capabilitiesFromAnnotations({})).toEqual(['external_side_effect']);
  });

  it('honours a positive readOnlyHint', () => {
    expect(capabilitiesFromAnnotations({ readOnlyHint: true })).toEqual(['read_only']);
  });

  it('does not honour an explicit readOnlyHint: false', () => {
    expect(capabilitiesFromAnnotations({ readOnlyHint: false })).toEqual(['external_side_effect']);
  });

  it('treats a contradictory destructiveHint as decisive', () => {
    // A server that says "this only reads" and "this is destructive" in the same breath has
    // told us it cannot be trusted about the first claim.
    expect(capabilitiesFromAnnotations({ readOnlyHint: true, destructiveHint: true })).toEqual([
      'external_side_effect',
    ]);
  });

  it('ignores a destructiveHint: false, which adds no information', () => {
    expect(capabilitiesFromAnnotations({ destructiveHint: false })).toEqual([
      'external_side_effect',
    ]);
  });

  it('produces a set the replay policy actually accepts', () => {
    // The two functions must agree, or the annotation policy is decorative.
    const readOnly = capabilitiesFromAnnotations({ readOnlyHint: true });
    const effectful = capabilitiesFromAnnotations(undefined);

    expect(isReadOnly(readOnly)).toBe(true);
    expect(mayAutoReconnect(readOnly)).toBe(true);

    expect(isReadOnly(effectful)).toBe(false);
    expect(mayAutoReconnect(effectful)).toBe(false);
  });
});

// ── the concurrency cap ───────────────────────────────────────────────────────

describe('the stdio semaphore', () => {
  it('hands out permits up to its capacity without queueing', async () => {
    const semaphore = new Semaphore(2);
    const first = await semaphore.acquire();
    const second = await semaphore.acquire();

    expect(semaphore.inUse).toBe(2);
    expect(semaphore.queued).toBe(0);

    first();
    second();
    expect(semaphore.inUse).toBe(0);
  });

  it('parks a caller that arrives after the cap is reached', async () => {
    const semaphore = new Semaphore(1);
    const held = await semaphore.acquire();

    let admitted = false;
    const waiting = semaphore.acquire().then((release) => {
      admitted = true;
      return release;
    });

    // Let every microtask run: if the waiter were going to be admitted it would be by now.
    await Promise.resolve();
    await Promise.resolve();
    expect(admitted).toBe(false);
    expect(semaphore.queued).toBe(1);
    expect(semaphore.inUse).toBe(1);

    held();
    const release = await waiting;
    expect(admitted).toBe(true);
    expect(semaphore.queued).toBe(0);
    // Still one, not two: the permit was transferred rather than duplicated.
    expect(semaphore.inUse).toBe(1);

    release();
    expect(semaphore.inUse).toBe(0);
  });

  it('admits exactly one waiter per release, in arrival order', async () => {
    const semaphore = new Semaphore(1);
    const held = await semaphore.acquire();

    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      semaphore.acquire().then((release) => {
        order.push(n);
        return release;
      }),
    );

    held();
    const first = await waiters[0]!;
    expect(order).toEqual([1]);
    expect(semaphore.inUse).toBe(1);

    first();
    const second = await waiters[1]!;
    expect(order).toEqual([1, 2]);

    second();
    const third = await waiters[2]!;
    expect(order).toEqual([1, 2, 3]);
    // Still one, never two: each release hands its permit straight to the next waiter
    // rather than adding one back to the pool and then taking another out.
    expect(semaphore.inUse).toBe(1);

    third();
    expect(semaphore.inUse).toBe(0);
  });

  it('ignores a double release, which would otherwise inflate the cap', async () => {
    // The manager releases from a `catch` *and* from a crash handler. Without the guard,
    // every failure would hand back an extra permit and the cap would drift upward until it
    // stopped bounding anything.
    const semaphore = new Semaphore(1);
    const release = await semaphore.acquire();

    release();
    release();
    release();

    expect(semaphore.inUse).toBe(0);
    // A second acquire must still work — and a third must not, because the capacity is one.
    const next = await semaphore.acquire();
    expect(semaphore.inUse).toBe(1);

    let second = false;
    void semaphore.acquire().then(() => {
      second = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(second).toBe(false);

    next();
  });

  it('refuses a capacity that cannot bound anything', () => {
    expect(() => new Semaphore(0)).toThrow(ApiError);
    expect(() => new Semaphore(-1)).toThrow(ApiError);
    expect(() => new Semaphore(1.5)).toThrow(ApiError);
  });

  it('reports its capacity', () => {
    expect(new Semaphore(10).total).toBe(10);
  });
});
