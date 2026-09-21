/**
 * The terminal.
 *
 * ## The assertion that matters most
 *
 * `ls -la` must reach the evaluator as the string `ls -la` and fail there. This file proves that
 * by inspecting the request body the page actually sent, because the tempting alternative — a
 * terminal that recognises shell words and answers them itself — would pass a test that only
 * looked at the screen. The screen would show a directory listing either way; only the wire can
 * tell you whether anything ran.
 *
 * The rest is the ordinary contract of a command line: history, help that matches the commands
 * that exist, and a refusal that points somewhere instead of failing silently.
 *
 * Requests are stubbed at `fetch`, so the query keys, the envelope keys and the session-on-demand
 * rule all run for real. An unstubbed request throws.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { CliPage } from './CliPage';

// ── fixtures ──────────────────────────────────────────────────────────────────

const AT = '2026-09-21T08:00:00.000Z';

const SESSION = {
  id: 's1abcdefghijkl',
  runId: null,
  provider: 'in-process',
  status: 'running',
  workdir: '/tmp/nexs/sandbox/s1',
  createdAt: AT,
  updatedAt: AT,
};

/** An execution row as the API returns it. */
function execution(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'e1',
    sessionId: SESSION.id,
    command: '1 + 1',
    stdout: null,
    stderr: null,
    exitCode: 0,
    status: 'succeeded',
    startedAt: AT,
    completedAt: AT,
    ...over,
  };
}

/** The `POST /sandbox/:id/exec` response: the durable row plus the ephemeral return value. */
function outcome(value: unknown, over: Partial<Record<string, unknown>> = {}) {
  return {
    outcome: {
      execution: execution(over),
      value,
      durationMs: 4,
      outputTruncated: false,
    },
  };
}

// ── the API stub ──────────────────────────────────────────────────────────────

interface StubRoute {
  status?: number;
  body?: unknown;
}

/** Every request the page sent, so a test can assert what actually went over the wire. */
let sent: string[] = [];

function stubApi(routes: Record<string, StubRoute>): void {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      // Every request, body or not: recording only the ones with a body would make a `GET` look
      // like it never happened, and the interesting assertion here is about a `POST` body.
      sent.push(
        typeof init?.body === 'string' ? `${method} ${url} ${init.body}` : `${method} ${url}`,
      );

      const route = routes[`${method} ${url}`];
      if (route === undefined) throw new Error(`unstubbed request: ${method} ${url}`);

      const status = route.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Request failed',
        text: async () => (route.body === undefined ? '' : JSON.stringify(route.body)),
      };
    }),
  );
}

/** The reads and writes the terminal makes, with a session that already exists. */
function defaultRoutes(over: Record<string, StubRoute> = {}): Record<string, StubRoute> {
  return {
    'GET /api/sandbox?limit=100': { body: { sessions: [SESSION] } },
    'POST /api/sandbox': { body: { session: SESSION } },
    [`POST /api/sandbox/${SESSION.id}/exec`]: { body: outcome(2) },
    ...over,
  };
}

/**
 * Mount the page the way the app mounts it — inside `StrictMode`.
 *
 * This is not decoration. `main.tsx` wraps the whole tree in `StrictMode`, which double-invokes
 * effects in development, and this harness used not to. The banner was printed from an effect
 * and therefore appeared twice in the real browser while every test here saw it once; the suite
 * was testing a tree the app never renders. Anything this page does in an effect is now exercised
 * twice, exactly as a user would experience it.
 */
function renderCli(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <CliPage />
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

/** Type a line and press Enter. */
async function type(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText('Terminal input'));
  await user.keyboard(text);
  await user.keyboard('{Enter}');
}

/** The transcript's own text, so an assertion cannot accidentally match the header or the banner. */
function transcript(): string {
  const screen = document.querySelector('.cli-screen');
  if (screen === null) throw new Error('no transcript rendered');
  return screen.textContent ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('what the terminal says it is', () => {
  it('says it is not a shell before it says anything else', () => {
    stubApi(defaultRoutes());
    renderCli();

    // Asserted by exact opening words, because the caveat appears twice on purpose: once in the
    // banner and once in the header, so scrolling the banner away does not lose it.
    expect(screen.getByText(/^It is not a POSIX shell/)).toBeTruthy();
    expect(screen.getByText(/^Evaluates JavaScript in a sandbox session/)).toBeTruthy();
  });

  it('prints the banner exactly once, under StrictMode', () => {
    stubApi(defaultRoutes());
    renderCli();

    // Counted in the transcript, because the caveat is deliberately in two places on the page —
    // the banner and the header — and only the transcript should hold one copy. An effect would
    // print this twice under the double-invoke; initial state cannot.
    const occurrences = transcript().split('It is not a POSIX shell').length - 1;
    expect(occurrences).toBe(1);
  });

  it('says how to get a value out of a statement', () => {
    stubApi(defaultRoutes());
    renderCli();

    // The engine discards the value of a bare expression, so the banner has to say which form
    // prints and which does not, or the first line anyone types looks like it did nothing.
    expect(transcript()).toContain('A line that is a single expression is returned for you');
    expect(transcript()).toContain('write `return` when you want the value of one');
  });

  it('shows the prompt before a session exists', () => {
    stubApi(defaultRoutes());
    renderCli();

    expect(screen.getByText('nexs:~$')).toBeTruthy();
  });
});

describe('running a line', () => {
  it('sends the line to the evaluator and prints what it returned', async () => {
    stubApi(defaultRoutes());
    renderCli();

    await type('1 + 1');

    expect(await screen.findByText('⇒ 2')).toBeTruthy();
    // The engine evaluates the snippet as a function body, so an expression has to be wrapped to
    // come back at all — `1 + 1` sent bare is evaluated and discarded. Asserted on the wire
    // rather than tolerated: `prepareCode` is the only place a typed line is ever altered, and
    // this is what proves it altered it in the one way it documents.
    expect(sent.some((entry) => entry.includes('"code":"return (\\n1 + 1\\n);"'))).toBe(true);
  });

  it('sends a statement verbatim, because wrapping one would not compile', async () => {
    stubApi(defaultRoutes());
    renderCli();

    await type('const answer = 1 + 1');

    // Not `return (const answer = 1 + 1);`, which is a syntax error. The fallback is the whole
    // reason the check is a compile and not a guess.
    expect(sent.some((entry) => entry.includes('"code":"const answer = 1 + 1"'))).toBe(true);
  });

  it('sends a shell-looking line to the evaluator rather than answering it itself', async () => {
    // The honesty position of the feature, asserted on the wire. If this ever becomes a
    // fabricated listing, this test is the one that fails.
    stubApi(
      defaultRoutes({
        [`POST /api/sandbox/${SESSION.id}/exec`]: {
          body: outcome(undefined, {
            status: 'failed',
            stderr: 'ReferenceError: ls is not defined',
            exitCode: 1,
          }),
        },
      }),
    );
    renderCli();

    await type('ls -la');

    // The engine's own words, not ours.
    expect(await screen.findByText('ReferenceError: ls is not defined')).toBeTruthy();
    // `ls -la` is `ls - la` to a JavaScript parser — subtraction — so it is wrapped like any
    // other expression. What matters is that the terminal did not answer it: the line inside the
    // wrapper is unchanged, and the error above came from the engine. A fabricated listing would
    // have to rewrite this string, which is why asserting on it is worth doing.
    expect(sent.some((entry) => entry.includes('"code":"return (\\nls -la\\n);"'))).toBe(true);
  });

  it('opens a session on the first line that needs one, and reuses it after', async () => {
    stubApi(defaultRoutes({ 'GET /api/sandbox?limit=100': { body: { sessions: [] } } }));
    renderCli();

    await type('1 + 1');
    expect(await screen.findByText('⇒ 2')).toBeTruthy();

    // The prompt names the session, which is the surface that tells you *where* a line will run.
    expect(await screen.findByText('nexs:s1abcde$')).toBeTruthy();
    expect(sent.filter((entry) => entry.startsWith('POST /api/sandbox ')).length).toBe(1);

    await type('2 + 2');
    // Still one creation — a session per keystroke would be a write per keystroke.
    expect(sent.filter((entry) => entry.startsWith('POST /api/sandbox ')).length).toBe(1);
  });

  it('prints the engine message when the execution is refused outright', async () => {
    stubApi(
      defaultRoutes({
        [`POST /api/sandbox/${SESSION.id}/exec`]: {
          status: 400,
          body: { error: { code: 'BAD_REQUEST', message: 'code must not be empty' } },
        },
      }),
    );
    renderCli();

    await type('1 + 1');

    expect(await screen.findByText(/code must not be empty/)).toBeTruthy();
  });
});

describe('the commands', () => {
  it('lists the real commands for /help', async () => {
    stubApi(defaultRoutes());
    renderCli();

    await type('/help');
    await screen.findByText(/Commands:/);

    // Read off the transcript rather than the page: "/help" also appears in the banner, and a
    // page-wide query would pass on the banner alone without the table ever being rendered.
    const shown = transcript();
    for (const usage of ['/help', '/clear', '/new', '/sessions', '/use <session-id>']) {
      expect(shown).toContain(usage);
    }
  });

  it('refuses an unknown verb and points at /help', async () => {
    stubApi(defaultRoutes());
    renderCli();

    await type('/ls');

    expect(await screen.findByText(/No such command: \/ls/)).toBeTruthy();
    expect(transcript()).toContain('Type /help for the ones that exist.');
  });

  it('asks for the argument /use needs', async () => {
    stubApi(defaultRoutes());
    renderCli();

    await type('/use');

    expect(await screen.findByText('Usage: /use <session-id>')).toBeTruthy();
  });

  it('clears the screen', async () => {
    stubApi(defaultRoutes());
    renderCli();

    await type('1 + 1');
    expect(await screen.findByText('⇒ 2')).toBeTruthy();

    await type('/clear');
    await waitFor(() => {
      expect(screen.queryByText('⇒ 2')).toBeNull();
    });
  });

  it('says there are no sessions rather than printing an empty table', async () => {
    stubApi(defaultRoutes({ 'GET /api/sandbox?limit=100': { body: { sessions: [] } } }));
    renderCli();

    await type('/sessions');

    expect(await screen.findByText(/No sandbox sessions yet/)).toBeTruthy();
  });

  it('accepts a session the workspace has, and refuses one it does not', async () => {
    stubApi(defaultRoutes());
    renderCli();

    // Wait for the session list to arrive, because the check is against it.
    await waitFor(() => {
      expect(sent.length).toBeGreaterThan(0);
    });

    await type('/use nope');
    expect(await screen.findByText(/No sandbox session nope in this workspace/)).toBeTruthy();

    await type(`/use ${SESSION.id}`);
    expect(await screen.findByText(`Running in ${SESSION.id}.`)).toBeTruthy();
  });
});

describe('the prompt', () => {
  it('recalls the previous line with the up arrow', async () => {
    stubApi(defaultRoutes());
    renderCli();

    await type('1 + 1');
    await screen.findByText('⇒ 2');

    const user = userEvent.setup();
    const input = screen.getByLabelText('Terminal input');
    await user.click(input);
    await user.keyboard('{ArrowUp}');

    expect((input as HTMLTextAreaElement).value).toBe('1 + 1');
  });

  it('returns to the draft when the down arrow runs past the newest line', async () => {
    stubApi(defaultRoutes());
    renderCli();

    await type('1 + 1');
    await screen.findByText('⇒ 2');

    const user = userEvent.setup();
    const input = screen.getByLabelText('Terminal input') as HTMLTextAreaElement;
    await user.click(input);
    await user.keyboard('half-typed');
    await user.keyboard('{ArrowUp}');
    expect(input.value).toBe('1 + 1');
    await user.keyboard('{ArrowDown}');

    // The extra history slot is the draft, which is why ↓ restores what was being typed instead
    // of repeating the newest command.
    expect(input.value).toBe('half-typed');
  });
});
