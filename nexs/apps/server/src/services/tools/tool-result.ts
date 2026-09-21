import { ApiError, type ToolResult } from '@nexs/shared';
import type { StorageService } from '../storage/storage.service.js';
import { contentKey } from '../storage/storage.service.js';

/**
 * [gap #18 / B5] The tool result size cap.
 *
 * A tool that returns 10 MB must not put 10 MB into a prompt, into a database row, or
 * into an SSE frame. The policy: keep the payload, move it to the storage service, and
 * hand the model a summary plus an opaque ref.
 *
 * The subtlety is that the *summary* must itself be bounded and must be a strict prefix
 * of the original. A cap that replaces a large result with a large summary has moved the
 * problem rather than solved it, and one that reorders or reformats the head is lying
 * about what the tool returned.
 */

export interface CapOptions {
  maxBytes: number;
  tenantId: string;
  /** Category segment for the storage key, e.g. `tool-results`. */
  category?: string;
  /** Included in the summary so a reader can tell which call overflowed. */
  label?: string;
}

export interface CapDeps {
  storage: StorageService;
}

/** Serialise any tool payload to the text the model would have seen. */
export function serialiseToolResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // A circular structure or a BigInt. `String(value)` at least yields `[object Object]`
    // rather than throwing inside the cap, which would fail the step for a cosmetic reason.
    return String(value);
  }
}

/** UTF-8 byte length, which is what the cap is measured in. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Keep `maxBytes` of a UTF-8 string without splitting a character.
 *
 * `Buffer.subarray` would happily cut a multi-byte sequence in half, producing a
 * replacement character in the prompt and a length that no longer matches the original.
 */
export function sliceUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;

  let end = maxBytes;
  // Walk back off a UTF-8 continuation byte (0b10xxxxxx) so the slice ends on a boundary.
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * Apply the cap.
 *
 * Under the limit the payload passes through untouched — including the exact byte count,
 * so a caller can still report "the tool returned 3 bytes" without re-serialising.
 */
export async function capToolResult(
  deps: CapDeps,
  raw: unknown,
  options: CapOptions,
): Promise<ToolResult> {
  if (options.maxBytes <= 0) {
    throw new ApiError('VALIDATION_ERROR', 'maxBytes must be positive');
  }

  const text = serialiseToolResult(raw);
  const originalBytes = byteLength(text);

  if (originalBytes <= options.maxBytes) {
    return { content: text, truncated: false, originalBytes };
  }

  const key = contentKey(options.tenantId, options.category ?? 'tool-results', text);
  await deps.storage.put(key, text, { contentType: 'text/plain' });

  return {
    content: summarise(text, originalBytes, options),
    ref: key,
    truncated: true,
    originalBytes,
  };
}

/**
 * A bounded head-and-tail excerpt.
 *
 * The tail matters as much as the head: JSON payloads and log output put their most
 * decision-relevant information (the closing object, the final error) at the end, and a
 * head-only summary of a failed request shows the request but not the reason.
 */
function summarise(text: string, originalBytes: number, options: CapOptions): string {
  const label = options.label === undefined ? '' : `${options.label}: `;
  const notice = `[${label}result truncated — ${originalBytes} bytes, full payload in storage]`;

  // Leave room for the notice and the markers inside the same budget, so the summary can
  // never itself exceed the cap.
  const budget = Math.max(0, options.maxBytes - byteLength(notice) - 64);
  if (budget === 0) return notice;

  const headBytes = Math.floor(budget * 0.6);
  const tailBytes = budget - headBytes;

  const head = sliceUtf8(text, headBytes);
  const tail = tailBytes > 0 ? tailUtf8(text, tailBytes) : '';

  return tail.length === 0 ? `${head}\n${notice}` : `${head}\n…\n${tail}\n${notice}`;
}

/** The last `maxBytes` bytes of a string, on a character boundary. */
function tailUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;

  let start = buffer.byteLength - maxBytes;
  // Advance past continuation bytes so the slice begins on a character boundary.
  while (start < buffer.byteLength && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString('utf8');
}

/** Bytes to a human string, for logs and the dashboard. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
