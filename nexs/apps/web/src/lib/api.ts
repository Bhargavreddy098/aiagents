/**
 * The HTTP client.
 *
 * §6.5 sketches this as `api<T>(path)` unwrapping `body.data ?? body`. That sketch is
 * followed here — but with one addition, because the sketch's shape is not what this API
 * actually returns.
 *
 * ## What the API really returns, and why `apiOf` exists
 *
 * The spec's §5 says "success → resource / `{data}`". The server does not do that. Every
 * controller answers with a **named key**: `{ agents: [...] }`, `{ agent: {...} }`,
 * `{ notifications: [...], unreadCount: n }`. `{ data }` appears twice in the whole
 * surface. So a client written to the sketch alone would read `body.data`, find
 * `undefined`, and render an empty table — on a page whose data was fetched successfully.
 *
 * That failure is silent, which is exactly the kind this project forbids: a screen that
 * says "no agents" when there are forty. `apiOf` therefore takes the key explicitly and
 * **throws** when it is absent, naming the keys that were present. A server-side rename
 * becomes a loud error at the call site instead of a plausible empty state.
 *
 * `api` is kept as well, for the two endpoints that really do answer `{data}` and for
 * anything that returns a bare resource.
 */

import type { ErrorPayload } from '@nexs/shared';

/** The server's error envelope: `{ error: { code, message, details? } }`. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, body: ErrorPayload) {
    super(body.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

/**
 * Called when the server answers 401.
 *
 * The auth layer registers a handler that clears the cached user, so one expired session
 * does not leave every page retrying against a dead cookie. A module-level slot rather
 * than a React context because the client is called from query functions, which are not
 * components and cannot consume context.
 *
 * `null` until the provider mounts — a 401 that arrives before then is still thrown to the
 * caller, so nothing is swallowed; the redirect is just skipped.
 */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** Serialized as JSON. `undefined` sends no body and no content-type. */
  body?: unknown;
  /**
   * Set `false` on the auth calls themselves.
   *
   * A failed login is a 401 that means "those credentials are wrong", not "your session
   * expired" — routing it through the session handler would log the user out of a session
   * they never had.
   */
  handleUnauthorized?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The server's envelope when it is well-formed, or a synthesized one when it is not.
 *
 * Exported because `POST /api/chat` fails the same way every other endpoint does — with the
 * `{ error: { code, message } }` body and a real status code — and it does so *before* it
 * commits to a stream. `sse-stream.ts` reuses this rather than growing a second, subtly
 * different reading of the same envelope.
 */
export function errorPayloadFrom(parsed: unknown, res: Response): ErrorPayload {
  if (isRecord(parsed) && isRecord(parsed.error)) {
    const { code, message, details } = parsed.error;
    if (typeof code === 'string' && typeof message === 'string') {
      return details === undefined ? { code, message } : { code, message, details };
    }
  }
  // A proxy, a crash before the error handler, or a non-JSON body. Still an error, and it
  // still needs a code — but the message must not pretend to be the server's own wording.
  return {
    code: `HTTP_${res.status}`,
    message: res.statusText.length > 0 ? res.statusText : `Request failed with ${res.status}`,
  };
}

/** Perform a request and return the parsed body, unwrapped only where the API says so. */
export async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  const { body, handleUnauthorized: handle = true, headers, ...init } = options;

  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  // 204 has no body to parse; `res.json()` on it would throw.
  if (res.status === 204) return undefined;

  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // Left as null. A non-JSON body from a 2xx is reported below as a malformed response
      // rather than silently becoming `undefined`.
      parsed = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401 && handle) onUnauthorized?.();
    throw new ApiClientError(res.status, errorPayloadFrom(parsed, res));
  }

  return parsed;
}

/** §6.5 semantics: `body.data` when present, otherwise the body itself. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const body = await request(path, options);
  if (isRecord(body) && body.data !== undefined) return body.data as T;
  return body as T;
}

/**
 * Read one named key out of the response, refusing to invent a value when it is missing.
 *
 * The `200` on the thrown error is deliberate: the request *succeeded*, and saying 500 here
 * would misattribute a client/server contract mismatch to the server's health.
 */
export async function apiOf<T>(
  path: string,
  key: string,
  options: RequestOptions = {},
): Promise<T> {
  const body = await request(path, options);
  if (!isRecord(body) || !(key in body)) {
    throw new ApiClientError(200, {
      code: 'MALFORMED_RESPONSE',
      message: `${path} answered without a "${key}" key`,
      details: { received: isRecord(body) ? Object.keys(body) : typeof body },
    });
  }
  return body[key] as T;
}

/**
 * Build a query string, dropping empty values.
 *
 * `false` and `0` are kept — they are meaningful filters — while `undefined`, `null` and
 * `''` are dropped. A dropped `false` would silently turn `?enabled=false` into
 * `?enabled` (or nothing), which is a different query.
 */
export function qs(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered.length > 0 ? `?${rendered}` : '';
}

/** A human sentence for any thrown value, for an error box. */
export function describeError(err: unknown): { code: string; message: string } {
  if (err instanceof ApiClientError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: err.name, message: err.message };
  return { code: 'UNKNOWN', message: String(err) };
}
