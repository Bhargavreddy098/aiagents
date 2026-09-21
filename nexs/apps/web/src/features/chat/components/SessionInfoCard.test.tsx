/**
 * The session info card.
 *
 * ## Why this is tested at all
 *
 * Two components that used to be mounted on the chat page for the whole session — the startup
 * banner and the status bar — now exist only inside this card. A card that silently failed to
 * render them would be a *deletion* of both, and the page it left behind would look perfectly
 * fine: a clean transcript with no banner and no bar is exactly the design that was asked for.
 * That is the failure mode worth a test, because nothing else would catch it.
 *
 * The two assertions that matter are therefore "closed renders nothing at all" and "open renders
 * both". Escape is the third: `Modal` draws the scrim and the dialog and owns no keyboard
 * handling, so the card has to supply it and nothing else checks.
 *
 * ## Why the fetch stub is permissive
 *
 * The banner reads the tool registry, the skills, the MCP servers and the agents. Those reads
 * have their own suites, and enumerating four route shapes here would make this file fail for
 * reasons that are not about this file. What is asserted is that the card renders the banner and
 * the bar, not what either of them says.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { sessionMetrics } from '../../../lib/session-metrics';
import { readContext } from '../../../lib/context';
import { SessionInfoCard, type SessionInfoCardProps } from './SessionInfoCard';

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      // Every envelope the banner might ask for, empty. See the file header on why this is not
      // the strict per-route stub the panel's test uses.
      text: async () =>
        JSON.stringify({ tools: [], skills: [], servers: [], mcpServers: [], agents: [] }),
    })),
  );
}

/** The real metrics and context objects, built from the same functions the page uses. */
function defaults(over: Partial<SessionInfoCardProps> = {}): SessionInfoCardProps {
  return {
    open: true,
    onClose: () => undefined,
    workspace: 'Analytical Engines',
    agentId: null,
    title: 'Alpha',
    model: null,
    metrics: sessionMetrics({ session: null, runs: [], usage: [] }),
    context: readContext(null, null),
    approximate: false,
    contextNote: 'No model context window is known for this conversation.',
    stashCount: 0,
    onOpenContext: () => undefined,
    runId: null,
    onOpenRun: () => undefined,
    ...over,
  };
}

function renderCard(over: Partial<SessionInfoCardProps> = {}): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      {/* The banner links to the agent it is describing, so it needs a router around it. */}
      <MemoryRouter>
        <SessionInfoCard {...defaults(over)} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the session info card', () => {
  it('renders nothing at all when closed', () => {
    stubApi();
    renderCard({ open: false });

    // Not "renders hidden" — the page it sits on is the clean transcript, and a dialog left in
    // the tree would trap focus and swallow Escape on the chat page.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('.session-card')).toBeNull();
  });

  it('renders the banner and the status bar when open', () => {
    stubApi();
    renderCard();

    expect(screen.getByRole('dialog')).toBeTruthy();
    // The banner, by its own section label.
    expect(screen.getByText(/System Prompt/i)).toBeTruthy();
    // The status bar, by the region it declares.
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('closes on Escape, because the dialog supplies no keyboard handling itself', async () => {
    stubApi();
    const onClose = vi.fn();
    renderCard({ onClose });

    await userEvent.setup().keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('links the in-flight run rather than describing it', async () => {
    stubApi();
    const onOpenRun = vi.fn();
    renderCard({ runId: 'run_1', onOpenRun });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Open run' }));
    expect(onOpenRun).toHaveBeenCalledWith('run_1');
  });

  it('shows no run link when no turn is in flight', () => {
    stubApi();
    renderCard();

    expect(screen.queryByRole('button', { name: 'Open run' })).toBeNull();
  });
});
