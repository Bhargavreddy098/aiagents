import { ApiError } from '@nexs/shared';
import type { ConnectorActionResult, ConnectorContext } from './types.js';

/**
 * The HTTP mechanics every connector adapter shares.
 *
 * Two adapters in this directory speak HTTP, and the parts they have in common are exactly the
 * parts that are easy to get subtly wrong: how a path template is filled, how arguments are split
 * between the URL and the body, and which failures are thrown versus reported. Keeping them here
 * means there is one answer to each rather than one per adapter.
 */

/**
 * Substitute `{name}` placeholders from the arguments, and return what is left over.
 *
 * Placeholders are removed from the returned bag, because a path parameter that also appeared in
 * the query string would send the same value twice — harmless for a GET and confusing in a log.
 *
 * A missing placeholder throws rather than leaving `{owner}` in the URL. A literal brace in a path
 * produces a request to a nonsense URL that the vendor answers with a 404, and "404" is a much
 * worse explanation than "this action needs an owner".
 */
export function fillPath(
  template: string,
  args: Record<string, unknown>,
): { path: string; rest: Record<string, unknown> } {
  const rest: Record<string, unknown> = { ...args };

  const path = template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => {
    const value = rest[key];
    if (value === undefined || value === null || value === '') {
      throw new ApiError('VALIDATION_ERROR', `This action needs "${key}" to build its URL`, {
        parameter: key,
      });
    }
    delete rest[key];
    return encodeURIComponent(String(value));
  });

  // A malformed template (`{owner`, `{}`) survives the replace above. Catching it here means the
  // failure names the template rather than surfacing as a 404 from a vendor.
  if (/[{}]/.test(path)) {
    throw new ApiError('VALIDATION_ERROR', `Malformed path template "${template}"`, { template });
  }

  return { path, rest };
}

/** Join a base URL and a path without doubling or dropping the slash between them. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Render leftover arguments as a query string.
 *
 * Arrays repeat the key (`?label=a&label=b`) because that is what every HTTP API means by a
 * repeated parameter, and objects are JSON-encoded because there is no other honest rendering —
 * `[object Object]` in a URL is a bug that looks like a vendor problem.
 */
export function queryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
      continue;
    }
    search.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }

  const rendered = search.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

/** `GET` and `DELETE` carry their arguments in the URL; everything else carries them in the body. */
export function carriesBody(method: string): boolean {
  const upper = method.toUpperCase();
  return upper !== 'GET' && upper !== 'DELETE' && upper !== 'HEAD';
}

/**
 * The credential as a header pair, or null when there is none.
 *
 * Exported because `GitHubConnectorAdapter.connect` builds its own request — it needs response
 * headers, which `sendJson` discards — and two implementations of "where does the token go" is
 * exactly how one of them ends up sending it somewhere else.
 */
export function credentialHeader(ctx: ConnectorContext): Record<string, string> | null {
  if (ctx.credentials.token === '') return null;
  const value =
    ctx.credentials.authScheme === ''
      ? ctx.credentials.token
      : `${ctx.credentials.authScheme} ${ctx.credentials.token}`;
  return { [ctx.credentials.authHeader]: value };
}

/**
 * Headers for one call.
 *
 * The credential is attached here and nowhere else, so there is a single place to look when asking
 * "could this token have leaked into a request it should not have". `extra` is spread *first*, so
 * an adapter cannot use it to overwrite the credential header by accident.
 */
export function requestHeaders(
  ctx: ConnectorContext,
  hasBody: boolean,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...extra };

  Object.assign(headers, credentialHeader(ctx) ?? {});
  if (hasBody) headers['content-type'] = 'application/json';

  return headers;
}

/**
 * Perform one call and normalize the answer.
 *
 * **A non-2xx is returned, not thrown.** The call happened and the vendor answered; whether that
 * answer is an error is what `isError` records. Throwing here would collapse "GitHub said 404" into
 * "we could not reach GitHub", and the two need different retry treatment — the first will fail
 * identically forever, the second is worth trying again.
 *
 * **A transport failure is thrown.** Nothing was sent or nothing came back, so there is no answer
 * to report and the caller must not treat it as the vendor's verdict.
 */
export async function sendJson(
  ctx: ConnectorContext,
  url: string,
  init: { method: string; body?: unknown; headers?: Record<string, string> },
): Promise<ConnectorActionResult> {
  const hasBody = init.body !== undefined;

  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method: init.method,
      headers: requestHeaders(ctx, hasBody, init.headers ?? {}),
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
  } catch (cause) {
    throw new ApiError(
      'PROVIDER_ERROR',
      `Could not reach the ${ctx.connectorType} connector: ${String(cause)}`,
      { connectorId: ctx.connectorId },
    );
  }

  const text = await response.text().catch(() => '');
  const payload = parseBody(text);

  if (!response.ok) {
    return {
      isError: true,
      payload: {
        status: response.status,
        // The vendor's own message is the most useful thing on the page, and it is not a secret —
        // it describes the request, not the credential.
        message: extractMessage(payload, response.statusText),
        body: payload,
      },
    };
  }

  return { payload };
}

/**
 * Reachability only: the status comes back, the body is discarded.
 *
 * Used by `connect`, which for a connector with no identity endpoint is answering "can we talk to
 * this host at all". Reading the body there would download an arbitrary response just to throw it
 * away — and a vendor that answers `connect` with a megabyte of HTML is not a reason to fail.
 */
export async function probe(
  ctx: ConnectorContext,
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; ok: boolean }> {
  const method = init.method ?? 'GET';

  try {
    const response = await ctx.fetch(url, {
      method,
      headers: requestHeaders(ctx, carriesBody(method), init.headers ?? {}),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    return { status: response.status, ok: response.ok };
  } catch (cause) {
    throw new ApiError(
      'PROVIDER_ERROR',
      `Could not reach the ${ctx.connectorType} connector: ${String(cause)}`,
      { connectorId: ctx.connectorId },
    );
  }
}

/** JSON when the body is JSON, the raw string otherwise. An empty body is `null`, not `''`. */
export function parseBody(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The vendor's error message, when its payload has one. Falls back to the status text. */
export function extractMessage(payload: unknown, fallback: string): string {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['message', 'error_description', 'error', 'detail']) {
      const value = record[key];
      if (typeof value === 'string' && value !== '') return value;
    }
  }
  return fallback;
}

/**
 * A credential this adapter cannot work without.
 *
 * `FORBIDDEN` rather than a validation error: nothing about the request was malformed, the account
 * simply has no credential attached, and the operator's fix is to add one.
 */
export function requireToken(ctx: ConnectorContext, purpose: string): string {
  if (ctx.credentials.token === '') {
    throw new ApiError('FORBIDDEN', `This connector has no credential, so it cannot ${purpose}`, {
      connectorId: ctx.connectorId,
    });
  }
  return ctx.credentials.token;
}
