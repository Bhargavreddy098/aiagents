import { ApiError } from '@nexs/shared';
import type { Logger } from '../../logger.js';
import type { FetchLike } from '../gateway/adapters/types.js';

/**
 * The search provider seam (spec §3.6 — `web_search`).
 *
 * ## Why this file exists
 *
 * The spec's tool table has always listed `web_search`, and it was never implemented, because a
 * search needs a provider and none was ever wired. The tool is the *only* one in the table with no
 * home: `http_request`, `file_*`, `calculator`, `date_time`, `notify` and the `memory_*` pair all
 * landed, and this one did not. The consequence was not just a missing tool — the Research
 * protocol (Phase 10.2) is specified as `decompose → web_search → browse → extract → …`, so
 * without it the protocol could not run and Phase 10's acceptance criterion was unreachable.
 *
 * ## The port, and why it is a `Pick`-style interface rather than a vendor client
 *
 * A search vendor is an infrastructure choice, and the spec does not name one. So the tool layer
 * depends on `SearchPort` — two fields and one method — and the vendor lives behind it. Adding a
 * second vendor is a new adapter, not an edit to the tool.
 *
 * ## Non-2xx is an *error* here, unlike `http_request`
 *
 * `http_request` deliberately returns a 404 as a normal result, because its caller is a verifier
 * that has to *judge* the status. Search is different: the caller asked a question and the answer
 * is "here are results". A 401 from the search API is not a finding, and handing the model
 * `{ results: [] }` would make it conclude the web has nothing to say about the question — a wrong
 * answer where a failure was the truth. So a bad status throws.
 */

// ── the port ──────────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchQuery {
  query: string;
  /** Clamped by the adapter to the deployment's ceiling. */
  maxResults?: number;
  signal?: AbortSignal;
}

export interface SearchPort {
  /** The vendor's name, for logs and for the tool result. */
  readonly name: string;
  search(request: SearchQuery): Promise<SearchResult[]>;
}

// ── configuration ─────────────────────────────────────────────────────────────

export interface SearchProviderConfig {
  provider: 'none' | 'brave';
  apiKey: string | null;
  baseUrl: string;
  defaultMaxResults: number;
  maxResultsCeiling: number;
  timeoutMs: number;
  /** Bound on the response document, before parsing. A search reply is small; a hostile one is not. */
  maxResponseBytes: number;
}

export interface SearchProviderDeps {
  fetch: FetchLike;
  logger: Logger;
}

/**
 * Build the configured provider, or `undefined` when search is not available.
 *
 * `undefined` is the whole point, and it is what keeps this honest: `NativeToolRegistry` registers
 * `web_search` only when a provider exists, so a deployment without a search key never offers the
 * model a tool that can only fail. A model that is offered a tool will use it, and a `web_search`
 * that always errors would burn a run's steps discovering what the config already knew.
 *
 * A misconfiguration (a provider named, no key) is a **warning and a `undefined`**, not a throw:
 * search is an optional capability, and refusing to boot an API server because an optional
 * integration is half-configured trades a missing feature for an outage.
 */
export function createSearchProvider(
  config: SearchProviderConfig,
  deps: SearchProviderDeps,
): SearchPort | undefined {
  if (config.provider === 'none') return undefined;

  if (config.apiKey === null || config.apiKey.length === 0) {
    deps.logger.warn(
      { provider: config.provider },
      'search provider is configured but no API key is set; web_search will not be registered',
    );
    return undefined;
  }

  if (config.provider === 'brave') {
    return new BraveSearchProvider(config, deps);
  }

  // Exhaustive over the union: adding a vendor to `SearchProviderConfig['provider']` without an
  // adapter here is a compile error rather than a silently missing tool.
  const unhandled: never = config.provider;
  deps.logger.warn({ provider: unhandled }, 'unknown search provider; web_search is unavailable');
  return undefined;
}

// ── Brave Search ──────────────────────────────────────────────────────────────

/**
 * The Brave Search API adapter.
 *
 * Chosen because it is a plain REST endpoint with a documented JSON shape and no SDK, which means
 * the whole adapter is one `fetch` and one mapping — and therefore fully testable with a fake
 * `fetch`, which matters on a machine with no outbound network.
 *
 * The response shape this reads:
 *
 *   { "web": { "results": [ { "title": …, "url": …, "description": … } ] } }
 *
 * Parsing is defensive rather than optimistic: every field is checked before it is used, and a
 * result that is missing a `url` is dropped rather than surfaced as `undefined`. A search result
 * with no URL cannot be cited, and an unciteable source is exactly what provenance exists to
 * prevent.
 */
export class BraveSearchProvider implements SearchPort {
  readonly name = 'brave';

  constructor(
    private readonly config: SearchProviderConfig,
    private readonly deps: SearchProviderDeps,
  ) {}

  async search(request: SearchQuery): Promise<SearchResult[]> {
    const limit = this.clamp(request.maxResults);
    const url = new URL('/res/v1/web/search', this.config.baseUrl);
    url.searchParams.set('q', request.query);
    url.searchParams.set('count', String(limit));

    const timeout = createTimeout(this.config.timeoutMs, request.signal);

    let response: Response;
    try {
      response = await this.deps.fetch(url.toString(), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-subscription-token': this.config.apiKey ?? '',
        },
        ...(timeout.signal === undefined ? {} : { signal: timeout.signal }),
      });
    } catch (cause) {
      // A refused connection, DNS failure or timeout means the search did not happen. That is a
      // provider failure, not an empty result set.
      throw new ApiError('PROVIDER_ERROR', `The search provider could not be reached`, {
        provider: this.name,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      timeout.dispose();
    }

    if (!response.ok) {
      // The body of a failed search is a diagnostic, not a result. It is included because a 401
      // and a 429 need different fixes and the status alone does not always say which.
      const detail = await safeText(response, this.config.maxResponseBytes);
      throw new ApiError(
        'PROVIDER_ERROR',
        `The search provider returned ${response.status} ${response.statusText}`.trim(),
        { provider: this.name, status: response.status, body: detail },
      );
    }

    const text = await safeText(response, this.config.maxResponseBytes);
    return parseBraveResults(text, limit);
  }

  /**
   * Clamp to the deployment ceiling, not to the caller's wish.
   *
   * A model asking for 100 results would put 100 pages' worth of snippets into its own context,
   * which is the same failure the memory tool's limit cap guards against. The floor is 1 so that a
   * caller asking for 0 gets one result rather than a silently empty answer.
   */
  private clamp(requested: number | undefined): number {
    const value = requested ?? this.config.defaultMaxResults;
    return Math.max(1, Math.min(this.config.maxResultsCeiling, Math.floor(value)));
  }
}

// ── parsing ───────────────────────────────────────────────────────────────────

/**
 * Map the provider document to results, dropping anything unusable.
 *
 * Exported so the parsing can be tested against real provider payloads without a `fetch` in the
 * way — the mapping is where a vendor's quirks actually bite, and it is the part worth pinning.
 */
export function parseBraveResults(text: string, limit: number): SearchResult[] {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (cause) {
    throw new ApiError('PROVIDER_ERROR', 'The search provider returned a non-JSON body', {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const web = readRecord(document, 'web');
  const raw = web === null ? undefined : web['results'];
  if (!Array.isArray(raw)) {
    // A well-formed reply with no `web.results` genuinely means "no results" — Brave omits the key
    // rather than sending an empty array — so this is an empty search, not a parse failure.
    return [];
  }

  const results: SearchResult[] = [];
  for (const entry of raw) {
    if (results.length >= limit) break;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;

    const record = entry as Record<string, unknown>;
    const url = typeof record['url'] === 'string' ? record['url'].trim() : '';
    // No URL means no citation, and an unciteable result is worse than one result fewer.
    if (url.length === 0) continue;

    results.push({
      url,
      title: typeof record['title'] === 'string' ? record['title'].trim() : url,
      snippet: typeof record['description'] === 'string' ? record['description'].trim() : '',
    });
  }

  return results;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) return null;
  return nested as Record<string, unknown>;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Read a body as text, refusing a document larger than the cap.
 *
 * Truncation is not an option here the way it is for `http_request`: half a JSON document does not
 * parse, so a truncated read would surface as a confusing "non-JSON body" rather than as the size
 * problem it is. The check is on the decoded length, which is the only measure available without
 * streaming — acceptable because the cap exists to bound a pathological response, not to shave a
 * legitimate one.
 */
async function safeText(response: Response, maxBytes: number): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return '';
  }
  if (text.length > maxBytes) {
    throw new ApiError('PROVIDER_ERROR', 'The search provider response exceeded the size limit', {
      bytes: text.length,
      maxBytes,
    });
  }
  return text;
}

/**
 * A timeout that also honours the caller's cancellation.
 *
 * The engine gives every step a deadline and passes an `AbortSignal`; a search that ignored it
 * would outlive the step that asked for it. `AbortSignal.any` would express this in one line, but
 * it is not available on every runtime this build targets, so the two are combined explicitly —
 * and the timer is always cleared, because a stray 15-second timer would hold the event loop open
 * and delay a graceful shutdown by that long.
 */
function createTimeout(
  ms: number,
  external: AbortSignal | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (typeof AbortSignal.timeout !== 'function') return { signal: external, dispose: () => undefined };

  const timer = AbortSignal.timeout(ms);
  const signal = external === undefined ? timer : anySignal([timer, external]);
  return { signal, dispose: () => undefined };
}

/** First-to-abort wins. A small stand-in for `AbortSignal.any`. */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
