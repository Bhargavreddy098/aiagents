import { ApiError } from '@nexs/shared';
import type { FetchLike } from '../gateway/adapters/types.js';

/**
 * The Research protocol's "browse → read & extract" step (spec Phase 10.2).
 *
 * ## Why this is a port
 *
 * The protocol needs the *text* of a page: the findings cite it, the verifier searches it, and
 * the result's sections summarise it. It does not care how the text was obtained. Two
 * implementations make sense and both are legitimate — an HTTP reader, which is what this file
 * ships, and a Playwright-backed reader for pages that render their content in JavaScript.
 *
 * The HTTP reader is the default because it is the one that works with no browser installed, which
 * is what makes the whole protocol verifiable on a machine with no outbound network and no
 * Chromium. The browser-backed reader is a drop-in behind this same interface, and is the right
 * upgrade for JS-heavy pages; it is not built here because the protocol's contract is the text,
 * not the mechanism.
 *
 * ## Extraction is deliberately crude, and that is honest
 *
 * There is no readability algorithm here. A real one is a large dependency whose behaviour is hard
 * to pin in a test. What this does instead is strip the parts of a document that are never prose
 * (`script`, `style`, `noscript`, comments) and then strip tags — and it reports `truncated` so a
 * caller can tell "the page was short" from "we cut it off". A crude extraction that admits its
 * limits beats a clever one nobody can predict.
 */

export interface PageContent {
  url: string;
  title: string;
  text: string;
  /** Bytes of the *extracted* text, after stripping. */
  bytes: number;
  truncated: boolean;
}

export interface ReadPageOptions {
  signal?: AbortSignal;
  maxBytes?: number;
}

export interface PageReader {
  read(url: string, options?: ReadPageOptions): Promise<PageContent>;
}

export interface HttpPageReaderConfig {
  fetch: FetchLike;
  /** Cap on the extracted text, not the raw body — a page's markup is mostly not prose. */
  maxTextBytes: number;
  /** Cap on the raw body actually downloaded. */
  maxBodyBytes: number;
  timeoutMs: number;
  userAgent: string;
}

export class HttpPageReader implements PageReader {
  constructor(private readonly config: HttpPageReaderConfig) {}

  async read(url: string, options: ReadPageOptions = {}): Promise<PageContent> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError('VALIDATION_ERROR', 'The page URL is not absolute', { url });
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError('VALIDATION_ERROR', 'Only http and https pages can be read', {
        protocol: parsed.protocol,
      });
    }

    const timeout = createTimeout(this.config.timeoutMs, options.signal);

    let response: Response;
    try {
      response = await this.config.fetch(url, {
        method: 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          'user-agent': this.config.userAgent,
        },
        redirect: 'follow',
        ...(timeout.signal === undefined ? {} : { signal: timeout.signal }),
      });
    } catch (cause) {
      // A page that could not be fetched is not a source. The protocol skips it and says so
      // rather than recording a source whose text is empty — an unciteable source is worse than
      // one fewer, because it looks like evidence.
      throw new ApiError('PROVIDER_ERROR', 'The page could not be fetched', {
        url,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      timeout.dispose();
    }

    if (!response.ok) {
      throw new ApiError('PROVIDER_ERROR', `The page returned ${response.status}`, {
        url,
        status: response.status,
      });
    }

    const contentType = response.headers.get('content-type') ?? '';
    const body = await readBounded(response, this.config.maxBodyBytes);
    const limit = options.maxBytes ?? this.config.maxTextBytes;

    // A non-HTML body (a PDF, an image, a binary) is decoded to mojibake by `extractText`, and
    // mojibake cited as evidence is the worst possible outcome. Saying "this is not text" is
    // cheaper and truer than letting the model reason about replacement characters.
    const isTextual =
      contentType.length === 0 ||
      contentType.includes('text/') ||
      contentType.includes('json') ||
      contentType.includes('xml');

    const text = isTextual ? extractText(body.value) : '';
    const clipped = text.length > limit;
    const value = clipped ? text.slice(0, limit) : text;

    return {
      url,
      title: extractTitle(body.value) || parsed.hostname,
      text: value,
      bytes: value.length,
      truncated: body.truncated || clipped,
    };
  }
}

// ── extraction ────────────────────────────────────────────────────────────────

/**
 * Non-prose regions, dropped wholesale before tags are stripped.
 *
 * `<head>` is first because it *contains* the others: leaving it in would put the `<title>` text at
 * the top of every page's body, so a finding quoting the page's own title would verify against a
 * string the reader synthesised rather than one the page's prose contained. `extractTitle` reads
 * the raw document separately, so the title is still available — it just is not body text.
 */
const NON_PROSE = [
  /<head\b[^>]*>[\s\S]*?<\/head>/gi,
  /<script\b[^>]*>[\s\S]*?<\/script>/gi,
  /<style\b[^>]*>[\s\S]*?<\/style>/gi,
  /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi,
  /<template\b[^>]*>[\s\S]*?<\/template>/gi,
  /<!--[\s\S]*?-->/g,
];

/** Blocks that should read as a line break once the tags are gone, not as a run-on. */
const BLOCK_BOUNDARIES = /<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|blockquote)\b[^>]*>/gi;

export function extractText(html: string): string {
  let text = html;
  for (const pattern of NON_PROSE) text = text.replace(pattern, ' ');

  // A block boundary becomes a newline *before* tags are stripped, otherwise `<p>a</p><p>b</p>`
  // collapses to `ab` and two sentences fuse into one.
  text = text.replace(BLOCK_BOUNDARIES, '\n');
  text = text.replace(/<[^>]*>/g, ' ');
  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

export function extractTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (match === null) return '';
  return decodeEntities(match[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The five entities that actually appear in page titles and prose.
 *
 * A full entity table is a large map that mostly decodes things nobody writes. These are the ones
 * whose absence is visible: an undecoded `&amp;` in a title reads as a bug, and an undecoded
 * `&nbsp;` breaks the whitespace collapse above.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Read at most `maxBytes` of a body.
 *
 * `response.text()` would buffer an unbounded document first, which is the failure this guards
 * against: a page pointed at a multi-gigabyte endpoint should be capped, not allowed to exhaust the
 * process. The reader is cancelled once the budget is spent so the socket is released rather than
 * left draining.
 */
async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<{ value: string; truncated: boolean }> {
  const body = response.body;
  if (body === null) return { value: '', truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      total += value.byteLength;
      if (total >= maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - maxBytes))));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
  }

  const merged = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { value: Buffer.from(merged).toString('utf8'), truncated };
}

/** First-to-abort wins. A stand-in for `AbortSignal.any`, which not every target has. */
function createTimeout(
  ms: number,
  external: AbortSignal | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (typeof AbortSignal.timeout !== 'function') return { signal: external, dispose: () => undefined };

  const timer = AbortSignal.timeout(ms);
  const signal = external === undefined ? timer : anySignal([timer, external]);
  return { signal, dispose: () => undefined };
}

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
