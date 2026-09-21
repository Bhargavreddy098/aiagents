import { describe, expect, it } from 'vitest';
import {
  HttpPageReader,
  extractText,
  extractTitle,
} from '../src/services/research/page-reader.js';
import type { FetchLike } from '../src/services/gateway/adapters/types.js';

/**
 * The Research protocol's "browse → read & extract" step.
 *
 * The extraction is deliberately crude, so what is pinned here is not quality — it is the two
 * properties the protocol depends on. Prose must survive in a readable order (block boundaries must
 * not fuse two sentences into one), and a page that is **not text** must yield empty text rather
 * than mojibake. Mojibake cited as evidence is the worst outcome available to this component: it
 * looks like a quotation and means nothing.
 */

const CONFIG = {
  maxTextBytes: 4_096,
  maxBodyBytes: 64 * 1_024,
  timeoutMs: 5_000,
  userAgent: 'test-agent',
};

function htmlResponse(body: string, contentType = 'text/html; charset=utf-8'): Response {
  return new Response(body, { status: 200, statusText: 'OK', headers: { 'content-type': contentType } });
}

function stubFetch(response: Response | Error): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (response instanceof Error) throw response;
    return response.clone();
  }) as unknown as FetchLike;
  return { fetch, calls };
}

function reader(response: Response | Error, overrides: Partial<typeof CONFIG> = {}): HttpPageReader {
  return new HttpPageReader({ ...CONFIG, ...overrides, fetch: stubFetch(response).fetch });
}

describe('extractText', () => {
  it('drops script, style, noscript and template contents', () => {
    const html = `
      <html><head><style>.a{color:red}</style></head>
      <body>
        <script>var secret = 'do not cite me';</script>
        <noscript>enable JS</noscript>
        <template><p>hidden</p></template>
        <p>The actual sentence.</p>
      </body></html>`;

    const text = extractText(html);

    expect(text).toContain('The actual sentence.');
    expect(text).not.toContain('do not cite me');
    expect(text).not.toContain('enable JS');
    expect(text).not.toContain('hidden');
    expect(text).not.toContain('color:red');
  });

  it('keeps adjacent paragraphs as separate lines rather than fusing them', () => {
    // Without a boundary rule `<p>a</p><p>b</p>` collapses to `ab`, and two sentences become one
    // that appears in neither source. A quotation check would then fail on text that is really there.
    const text = extractText('<p>First sentence.</p><p>Second sentence.</p>');

    expect(text.split('\n')).toEqual(['First sentence.', 'Second sentence.']);
  });

  it('strips comments', () => {
    expect(extractText('<p>visible</p><!-- hidden note -->')).toBe('visible');
  });

  it('decodes the entities that actually appear in prose', () => {
    expect(extractText('<p>Tom &amp; Jerry &lt;3 &quot;quoted&quot; &#39;x&#39;</p>')).toBe(
      'Tom & Jerry <3 "quoted" \'x\'',
    );
  });

  it('collapses runs of whitespace but preserves line structure', () => {
    expect(extractText('<p>a   b\t\tc</p>\n\n\n<p>d</p>')).toBe('a b c\nd');
  });

  it('returns an empty string for a document with no prose', () => {
    expect(extractText('<html><head><style>a{}</style></head><body></body></html>')).toBe('');
  });
});

describe('extractTitle', () => {
  it('reads the title and decodes it', () => {
    expect(extractTitle('<title>EU AI Act &amp; you</title>')).toBe('EU AI Act & you');
  });

  it('collapses whitespace inside a title', () => {
    expect(extractTitle('<title>\n  Spread   out\n</title>')).toBe('Spread out');
  });

  it('returns empty when there is no title', () => {
    expect(extractTitle('<html><body>x</body></html>')).toBe('');
  });
});

describe('HttpPageReader', () => {
  it('returns the extracted text and the title', async () => {
    const page = await reader(
      htmlResponse('<html><head><title>AI Act</title></head><body><p>Body text.</p></body></html>'),
    ).read('https://example.eu/ai-act');

    expect(page.url).toBe('https://example.eu/ai-act');
    expect(page.title).toBe('AI Act');
    expect(page.text).toBe('Body text.');
    expect(page.truncated).toBe(false);
  });

  it('falls back to the hostname when the page has no title', async () => {
    const page = await reader(htmlResponse('<html><body><p>x</p></body></html>')).read(
      'https://example.eu/page',
    );

    expect(page.title).toBe('example.eu');
  });

  it('returns empty text for a non-textual content type instead of mojibake', async () => {
    // A PDF decoded as UTF-8 is replacement characters, and a finding quoting it would be quoting
    // noise. "This is not text" is the honest answer.
    const page = await reader(htmlResponse('%PDF-1.7 binary…', 'application/pdf')).read(
      'https://example.eu/doc.pdf',
    );

    expect(page.text).toBe('');
  });

  it('still extracts from text/plain', async () => {
    const page = await reader(htmlResponse('plain words', 'text/plain')).read('https://example.eu/t.txt');

    expect(page.text).toBe('plain words');
  });

  it('reports truncation when the text exceeds the cap', async () => {
    const long = `<p>${'word '.repeat(500)}</p>`;
    const page = await reader(htmlResponse(long), { maxTextBytes: 50 }).read('https://example.eu/long');

    expect(page.truncated).toBe(true);
    expect(page.text.length).toBe(50);
  });

  it('throws on a non-2xx status rather than returning an empty page', async () => {
    const response = new Response('nope', { status: 403, statusText: 'Forbidden' });

    await expect(reader(response).read('https://example.eu/x')).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('wraps a network failure', async () => {
    await expect(
      reader(new Error('ENOTFOUND')).read('https://example.eu/x'),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('refuses a URL that is not absolute http(s)', async () => {
    const r = reader(htmlResponse('<p>x</p>'));

    await expect(r.read('not-a-url')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(r.read('ftp://example.eu/x')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
