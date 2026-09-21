/**
 * The SSE frame reader for `POST /api/chat`.
 *
 * This is the seam worth testing, and the reason is in the server's own source: it writes SSE
 * frames **two different ways** — `chat.controller.ts` emits `data:` with no `event:` line,
 * while `SseHub` (via `encodeSseFrame`) emits `id:` + `event:` + `data:`. A parser that handles
 * only one shape silently loses every frame from the other endpoint, and "silently" is the
 * problem: the stream stays open, the request succeeds, and no text ever appears.
 *
 * So the cases below pin both shapes, plus the chunk-boundary cases that are invisible until a
 * delta happens to land on one — a frame split across two reads, and a multi-byte character
 * split across two reads.
 *
 * `fetch` is stubbed rather than mocked at the module level, so the code under test is the real
 * reader loop: `getReader`, the buffer, the `\n\n` scan and the trailing-frame flush.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from './api';
import { openEventStream, type AnyStreamFrame } from './sse-stream';

/** A `ReadableStream`-shaped object that yields the given chunks in order. */
function bodyFrom(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader: () => ({
      read: async () => {
        const chunk = chunks[index];
        index += 1;
        return chunk === undefined
          ? { done: true, value: undefined }
          : { done: false, value: encoder.encode(chunk) };
      },
      releaseLock: () => undefined,
    }),
  } as unknown as ReadableStream<Uint8Array>;
}

function stubFetch(init: { chunks?: readonly string[]; status?: number; json?: string }): void {
  const status = init.status ?? 200;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Bad Request',
      body: init.chunks === undefined ? null : bodyFrom(init.chunks),
      text: async () => init.json ?? '',
    })),
  );
}

/** Drive `openEventStream` and collect the frames it delivered. */
async function collect(chunks: readonly string[]): Promise<AnyStreamFrame[]> {
  stubFetch({ chunks });
  const frames: AnyStreamFrame[] = [];
  await openEventStream({
    path: '/chat?sessionId=s1',
    body: { content: 'hi' },
    signal: new AbortController().signal,
    onFrame: (frame) => frames.push(frame),
  });
  return frames;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openEventStream', () => {
  it('reads the POST /chat shape, which has no event: line', async () => {
    const frames = await collect([
      ': connected\n\n',
      'data: {"name":"chat.started","payload":{"runId":"run_1"}}\n\n',
      'data: {"name":"chat.delta","payload":{"runId":"run_1","delta":"Hello"}}\n\n',
      'data: {"name":"chat.completed","payload":{"runId":"run_1","messageId":"msg_1"}}\n\n',
    ]);

    expect(frames.map((frame) => frame.name)).toEqual([
      'chat.started',
      'chat.delta',
      'chat.completed',
    ]);
    // Narrowing is the point of `AnyStreamFrame`: this only compiles because the union
    // distributes, and it is why the consumer's `switch` works.
    const delta = frames.find((frame) => frame.name === 'chat.delta');
    expect(delta?.name === 'chat.delta' ? delta.payload.delta : undefined).toBe('Hello');
  });

  it('reads the hub shape, which carries id: and event:', async () => {
    const frames = await collect([
      'id: 7\nevent: chat.delta\ndata: {"name":"chat.delta","payload":{"runId":"r","delta":"x"}}\n\n',
    ]);

    expect(frames).toHaveLength(1);
    expect(frames[0]?.name).toBe('chat.delta');
  });

  it('ignores comment lines', async () => {
    // The server opens every stream with `: connected`. A parser that treated it as an event
    // would deliver a frame named "connected" that nothing can match.
    const frames = await collect([': connected\n\n', ': ping\n\n']);
    expect(frames).toEqual([]);
  });

  it('reassembles a frame split across two chunks', async () => {
    // The realistic case: a delta arrives while the previous frame is half-written.
    const frames = await collect([
      'data: {"name":"chat.delta","payl',
      'oad":{"runId":"r","delta":"half"}}\n\n',
    ]);

    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame?.name === 'chat.delta' ? frame.payload.delta : undefined).toBe('half');
  });

  it('reassembles a multi-byte character split across two chunks', async () => {
    // "é" is two UTF-8 bytes. Decoding each chunk independently would produce a replacement
    // character in the middle of a delta — the classic streaming-decoder bug.
    const encoder = new TextEncoder();
    const full = encoder.encode('data: {"name":"chat.delta","payload":{"runId":"r","delta":"café"}}\n\n');
    const splitAt = full.indexOf(0xc3) + 1;

    const stream = {
      getReader: () => {
        let step = 0;
        return {
          read: async () => {
            step += 1;
            if (step === 1) return { done: false, value: full.slice(0, splitAt) };
            if (step === 2) return { done: false, value: full.slice(splitAt) };
            return { done: true, value: undefined };
          },
          releaseLock: () => undefined,
        };
      },
    } as unknown as ReadableStream<Uint8Array>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', body: stream, text: async () => '' })),
    );

    const frames: AnyStreamFrame[] = [];
    await openEventStream({
      path: '/chat',
      body: {},
      signal: new AbortController().signal,
      onFrame: (frame) => frames.push(frame),
    });

    const frame = frames[0];
    expect(frame?.name === 'chat.delta' ? frame.payload.delta : undefined).toBe('café');
  });

  it('handles several frames arriving in one chunk', async () => {
    const frames = await collect([
      'data: {"name":"chat.started","payload":{"runId":"r"}}\n\n' +
        'data: {"name":"chat.delta","payload":{"runId":"r","delta":"a"}}\n\n' +
        'data: {"name":"chat.delta","payload":{"runId":"r","delta":"b"}}\n\n',
    ]);

    expect(frames.map((frame) => frame.name)).toEqual(['chat.started', 'chat.delta', 'chat.delta']);
  });

  it('joins multiple data lines in one frame', async () => {
    // Per the SSE specification, repeated `data:` lines are concatenated with newlines. The
    // joined result here is still valid JSON because the split falls outside the JSON value.
    const frames = await collect([
      'data: {"name":"chat.delta",\ndata: "payload":{"runId":"r","delta":"joined"}}\n\n',
    ]);

    const frame = frames[0];
    expect(frame?.name === 'chat.delta' ? frame.payload.delta : undefined).toBe('joined');
  });

  it('delivers a final frame that has no trailing blank line', async () => {
    // A stream cut off mid-frame would otherwise drop the last delta it did deliver.
    const frames = await collect(['data: {"name":"chat.delta","payload":{"runId":"r","delta":"last"}}']);
    expect(frames).toHaveLength(1);
  });

  it('drops a frame whose name is not in the catalog', async () => {
    // An undeclared name is a silent no-op rather than a crash: a server that adds an event
    // without the client knowing must not break the stream.
    const frames = await collect([
      'data: {"name":"not.a.real.event","payload":{}}\n\n',
      'data: {"name":"chat.delta","payload":{"runId":"r","delta":"ok"}}\n\n',
    ]);

    expect(frames.map((frame) => frame.name)).toEqual(['chat.delta']);
  });

  it('drops a frame whose data is not JSON', async () => {
    const frames = await collect([
      'data: not json at all\n\n',
      'data: {"name":"chat.delta","payload":{"runId":"r","delta":"ok"}}\n\n',
    ]);

    expect(frames.map((frame) => frame.name)).toEqual(['chat.delta']);
  });

  it('raises the server error when the stream was never opened', async () => {
    // A validation failure happens before the response is committed, so it is an ordinary JSON
    // 4xx rather than a frame. It must surface as the same error type every other call raises.
    stubFetch({
      status: 400,
      json: JSON.stringify({ error: { code: 'VALIDATION_ERROR', message: 'content is required' } }),
    });

    await expect(
      openEventStream({
        path: '/chat',
        body: {},
        signal: new AbortController().signal,
        onFrame: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });

  it('synthesizes an error for a non-JSON failure', async () => {
    stubFetch({ status: 502, json: '<html>bad gateway</html>' });

    const error = await openEventStream({
      path: '/chat',
      body: {},
      signal: new AbortController().signal,
      onFrame: () => undefined,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('HTTP_502');
  });

  it('refuses a 2xx with no readable body', async () => {
    stubFetch({ status: 200 });

    await expect(
      openEventStream({
        path: '/chat',
        body: {},
        signal: new AbortController().signal,
        onFrame: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'NO_STREAM' });
  });
});
