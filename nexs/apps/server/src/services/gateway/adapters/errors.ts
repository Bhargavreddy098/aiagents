import type { GatewayFailureKind } from '@nexs/shared';

/**
 * A provider call that failed, carrying the *classification* the gateway needs rather
 * than a raw status code. Adapters translate; the gateway only decides policy.
 */
export class ProviderError extends Error {
  readonly kind: GatewayFailureKind;
  readonly status: number | undefined;
  /** Milliseconds the provider asked us to wait, when it said so. */
  readonly retryAfterMs: number | null;

  constructor(
    kind: GatewayFailureKind,
    message: string,
    options: { status?: number; retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  /** Only these are worth another attempt. */
  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'unavailable';
  }
}

/**
 * Context-length complaints arrive as a 400 with prose, not a dedicated code, and the
 * wording differs per provider — so this is a heuristic. Getting it wrong is not
 * dangerous: a false positive sends us down the budgeting ladder, which shrinks the
 * prompt and retries; a false negative just fails the call with the provider's message.
 */
const CONTEXT_HINTS = [
  'context length',
  'context_length',
  'maximum context',
  'too many tokens',
  'token limit',
  'reduce the length',
  'prompt is too long',
  'exceeds the maximum',
];

export function classifyStatus(status: number, body: string): GatewayFailureKind {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 408 || status === 409 || status === 425) return 'unavailable';
  if (status >= 500) return 'unavailable';
  if (status === 400 || status === 404 || status === 422) {
    const lowered = body.toLowerCase();
    return CONTEXT_HINTS.some((hint) => lowered.includes(hint)) ? 'context_exceeded' : 'bad_request';
  }
  return 'unknown';
}

/** Pull a human-readable message out of an error body without assuming its shape. */
export function extractErrorMessage(body: string, fallback: string): string {
  if (body.trim().length === 0) return fallback;

  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const error = record['error'];
      if (typeof error === 'string') return error;
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>)['message'];
        if (typeof message === 'string') return message;
      }
      const message = record['message'];
      if (typeof message === 'string') return message;
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }

  // Truncate: an HTML error page is not a useful log line.
  return body.length > 500 ? `${body.slice(0, 500)}…` : body;
}
