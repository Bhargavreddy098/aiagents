/**
 * Stable error-code vocabulary.
 * Every failure the API can return maps to exactly one code here, and each code
 * has one fixed HTTP status. Adding a code is a contract change — note it in the spec.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNSUPPORTED_CAPABILITY: 422,
  CONTEXT_WINDOW_EXCEEDED: 422,
  RATE_LIMITED: 429,
  ENCRYPTION_ERROR: 500,
  INTERNAL_ERROR: 500,
  PROVIDER_ERROR: 502,
  BROWSER_ERROR: 502,
  GATEWAY_FALLBACK_EXHAUSTED: 502,
  MODEL_UNAVAILABLE: 503,
  STEP_TIMEOUT: 504,
  RUN_TIMEOUT: 504,
  SANDBOX_TIMEOUT: 504,
  FEATURE_DISABLED: 404,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Shape of the `error` object on every non-2xx response. */
export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly http: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = 'ApiError';
    this.code = code;
    this.http = ERROR_CODES[code];
    if (details !== undefined) this.details = details;
    // NOTE: deliberately no Error.captureStackTrace here — it is V8-only and this
    // package must stay dependency-free (it is imported by the browser bundle too).
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
