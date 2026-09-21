/**
 * SSE frame reader shared by the streaming adapters.
 *
 * Deliberately hand-rolled rather than pulled from a dependency: the framing rules are
 * a dozen lines, and the only part that is easy to get wrong — a chunk boundary landing
 * in the middle of a `data:` line or between the two newlines of the frame separator —
 * is exactly the part a wrapper would hide from us.
 */

/** Structural type so this does not depend on DOM/undici typings. */
export interface ByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
    releaseLock(): void;
  };
}

/** Yields the payload of each `data:` line, in order, across frame boundaries. */
export async function* iterateSseData(body: ByteStream | null | undefined): AsyncGenerator<string> {
  if (body === null || body === undefined) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const drainFrames = function* (): Generator<string> {
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) yield line.slice('data:'.length).trim();
      }
      separator = buffer.indexOf('\n\n');
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        // Normalise CRLF so the frame separator is always exactly "\n\n".
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      }
      yield* drainFrames();
    }

    // A final frame may arrive without its trailing blank line before EOF.
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data:')) yield line.slice('data:'.length).trim();
    }
  } finally {
    reader.releaseLock();
  }
}
