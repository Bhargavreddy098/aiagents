/**
 * Reading an SSE response body from `fetch`.
 *
 * `EventSource` can only issue a GET, and `POST /api/chat` needs a body — a prompt is bounded
 * at 32,000 characters and a GET would put it in a query string. So the composer POSTs and
 * reads the response body as a stream, which means this parser rather than `EventSource`.
 *
 * ## The two frame shapes on this wire, and why one parser reads both
 *
 * The server writes SSE frames two different ways, and a client that handles only one of them
 * silently loses every frame from the other endpoint:
 *
 *  - `POST /api/chat` writes `data: {"name":…,"payload":…}` with **no `event:` line** — see the
 *    local `frame()` helper in `controllers/chat.controller.ts`.
 *  - `GET /api/stream` writes `id:` + `event: <name>` + `data: {"name":…,"payload":…}` — see
 *    `encodeSseFrame` in `@nexs/shared`.
 *
 * Both carry the same JSON in `data`, so the name is read from the JSON when it is there and
 * falls back to the `event:` field. That is not defensive coding for its own sake: it is one
 * parser serving both endpoints instead of two that can drift apart.
 *
 * ## What this deliberately does not do
 *
 * There is no `Last-Event-ID` handling and no resume. The server keeps no replay buffer — that
 * is the documented SSE contract — so a dropped stream is recovered by **refetching over REST
 * and then reconnecting**, never by asking the stream to catch up. A reconnect loop here would
 * be a promise this transport cannot keep.
 */

import { isSseEventName, type SSEEventName, type SsePayload } from '@nexs/shared';
import { ApiClientError, errorPayloadFrom } from './api';

/** One frame, narrowed to a single known event. */
export interface StreamFrame<N extends SSEEventName> {
  name: N;
  payload: SsePayload<N>;
}

/**
 * Any frame, as a **distributed** union.
 *
 * `StreamFrame<SSEEventName>` looks like the same thing and is not. With `N` bound to the whole
 * union, `payload` becomes the union of every payload in the catalog and the pairing between a
 * name and its payload is lost — so `switch (frame.name) { case 'chat.delta': … }` cannot
 * narrow, and `frame.payload.delta` is a type error even though that case can only ever carry
 * a delta.
 *
 * Distributing over the members preserves the pairing. It is what makes the consumer's switch
 * work, and it is why this type exists rather than a default on the one above.
 */
export type AnyStreamFrame = {
  [N in SSEEventName]: { name: N; payload: SsePayload<N> };
}[SSEEventName];

export interface OpenStreamOptions {
  /** Path relative to `/api`, e.g. `'/chat'`. */
  path: string;
  /** Sent as JSON. */
  body: unknown;
  /** Aborting this stops the request *and* the server's generation (gap #21). */
  signal: AbortSignal;
  /** Called once per frame, in arrival order. A throw here ends the stream. */
  onFrame: (frame: AnyStreamFrame) => void;
}

/**
 * POST a body and deliver the frames it answers with.
 *
 * Resolves when the stream ends, and rejects when it could not be opened — with an
 * `ApiClientError` carrying the server's own status and code, because a validation failure
 * here is an ordinary 400 that happens *before* the response is committed (the controller
 * persists the turn first and only then flushes headers).
 */
export async function openEventStream(options: OpenStreamOptions): Promise<void> {
  const { path, body, signal, onFrame } = options;

  const res = await fetch(`/api${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      // The server answers `text/event-stream`; this asks a proxy not to buffer it.
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    // A failure here is JSON, not SSE — the stream was never opened. Read it and raise the
    // same error type every other call site raises, so `describeError` works on it unchanged.
    const text = await res.text().catch(() => '');
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    throw new ApiClientError(res.status, errorPayloadFrom(parsed, res));
  }

  if (res.body === null) {
    throw new ApiClientError(200, {
      code: 'NO_STREAM',
      message: `${path} answered without a readable body`,
    });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // `stream: true` so a multi-byte character split across two chunks is reassembled rather
      // than becoming a replacement character in the middle of a delta.
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Everything after the last separator is a partial
      // frame and stays in the buffer until the rest of it arrives.
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const frame = parseFrame(raw);
        if (frame !== null) onFrame(frame);

        boundary = buffer.indexOf('\n\n');
      }
    }

    // A final frame with no trailing blank line. The server ends with `\n\n`, but a stream cut
    // off mid-frame would otherwise drop the last delta it did deliver.
    const tail = parseFrame(buffer);
    if (tail !== null) onFrame(tail);
  } finally {
    // Releases the reader's lock and lets the connection be torn down. On abort this is what
    // stops the fetch from holding the socket open.
    reader.releaseLock();
  }
}

/**
 * One block of an SSE stream, as a frame — or `null` when it carries no data.
 *
 * A block is a set of `field: value` lines. Three fields matter:
 *  - `:` — a comment. The server opens every stream with `: connected`, which is a keep-alive
 *    and not an event; a parser that treated it as one would emit a frame named "connected".
 *  - `event:` — the name, used only when the JSON does not carry one.
 *  - `data:` — the payload. Multiple `data:` lines in one block are joined with newlines, per
 *    the SSE specification.
 */
function parseFrame(raw: string): AnyStreamFrame | null {
  if (raw.length === 0) return null;

  let eventName: string | null = null;
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    // A comment, or a line that is only whitespace. Neither carries data.
    if (line.startsWith(':') || line.trim().length === 0) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // One optional leading space after the colon is stripped, per the specification.
    const rawValue = colon === -1 ? '' : line.slice(colon + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
    // `id`, `retry` and anything unknown are ignored: this transport does not resume.
  }

  if (dataLines.length === 0) return null;

  const joined = dataLines.join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(joined);
  } catch {
    // A frame this client cannot read is dropped rather than thrown. The alternative — failing
    // the whole stream because one frame was malformed — would turn a single bad delta into a
    // lost conversation, and the REST refetch is the recovery path either way.
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  // The envelope both endpoints write: `{ name, payload }`. `payload` may legitimately be any
  // JSON value, so only its presence is checked.
  if (typeof record.name === 'string' && 'payload' in record) {
    return asFrame(record.name, record.payload);
  }

  // `data:` held the payload itself rather than the envelope, so the name has to come from
  // `event:`. A block with neither is not addressable and is dropped.
  if (eventName !== null) return asFrame(eventName, parsed);

  return null;
}

/**
 * Assert one wire frame into the catalog's union.
 *
 * This is the only assertion in the file, and it sits exactly where an untyped wire meets the
 * typed catalog. `isSseEventName` checks that the name is one the catalog declares — an
 * undeclared name is dropped rather than delivered as a frame nothing can match, so a server
 * that adds an event without the client knowing is a silent no-op instead of a crash. The
 * payload's *shape* is the server's contract and is deliberately not re-validated: a schema
 * check per frame would be a second implementation of the event catalog.
 */
function asFrame(name: string, payload: unknown): AnyStreamFrame | null {
  if (!isSseEventName(name)) return null;
  return { name, payload } as AnyStreamFrame;
}
