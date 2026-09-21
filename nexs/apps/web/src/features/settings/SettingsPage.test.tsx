/**
 * Settings, as a master-detail view.
 *
 * ## What this file asserts, and what it replaced
 *
 * `SettingsCard.test.tsx` used to live here. Most of it was about a dialog — that it renders
 * nothing when closed, that Escape closes it, that the notification row dismisses it on the way
 * out — and none of that survives, because there is no dialog. What survived is the part that was
 * never about the dialog at all: that the account, the notifications and the theme are still
 * reachable, that a failed read says it failed, and that every destination in the tree is named in
 * words somewhere.
 *
 * The rest is about the two things this view does that a dialog could not:
 *
 *  - **the directory is complete.** `SETTINGS_DIRECTORY` is rendered, and every path in it has a
 *    summary component — the second half matters because a missing summary would render *no
 *    count* rather than an error, which is the one failure mode a reader cannot see;
 *  - **a section opens in place.** Clicking a row swaps the panel and changes the URL without
 *    leaving `/settings`, which is the whole point of a master-detail over a route per section.
 *
 * Requests are stubbed at `fetch` rather than by mocking the query hooks, so the query keys, the
 * envelope shapes and the counts all run for real. An unstubbed request throws.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { GOTO_SHORTCUTS } from '../../hooks/useKeyboardShortcuts';
import { SETTINGS_DIRECTORY } from '../../lib/navigation';
import { THEME_STORAGE_KEY } from '../../lib/theme';
import { AuthProvider } from '../auth/auth-context';
import { DIRECTORY_SUMMARY_PATHS } from './DirectoryDetail';
import { SettingsPage } from './SettingsPage';

// ── fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date(2026, 8, 21, 9, 0, 0);

/** A local-time Date as the ISO string the API sends. */
function at(year: number, month: number, day: number, hour = 9): string {
  return new Date(year, month, day, hour).toISOString();
}

const USER = {
  id: 'u1',
  email: 'ada@example.test',
  name: 'Ada Lovelace',
  tenantId: 't1',
  tenantName: 'Analytical Engines',
};

function agent(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    status: 'active',
    version: 3,
    activeVersionId: null,
    modelId: null,
    toolIds: [],
    createdAt: at(2026, 8, 1),
    updatedAt: at(2026, 8, 1),
  };
}

// ── the API stub ──────────────────────────────────────────────────────────────

interface StubRoute {
  status?: number;
  body?: unknown;
}

function stubApi(routes: Record<string, StubRoute>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const route = routes[`${method} ${url}`];
      // Loud, not silent: a page that quietly fetched something unexpected should fail here
      // rather than render a plausible empty panel.
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

/**
 * The two reads Settings always makes.
 *
 * The account, because the nav is inside `AuthProvider` and the Profile panel is the default; and
 * the approvals, because the Decision Inbox row carries a live count and therefore reads on every
 * render of the list. Everything else is per-panel and stubbed by the test that opens it — which
 * is itself the property worth having: opening Settings costs two requests, not eleven.
 */
function defaultRoutes(over: Record<string, StubRoute> = {}): Record<string, StubRoute> {
  return {
    'GET /api/users/me': { body: { user: USER } },
    'GET /api/approvals?actionableOnly=false': { body: { approvals: [], pendingCount: 0 } },
    ...over,
  };
}

/** Where the router ended up, so a navigation can be asserted without leaving the component. */
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}`}</span>;
}

function renderSettings(initialEntry = '/settings'): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <SettingsPage />
          <LocationProbe />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

/** The user-event instance, wired to the fake clock the suite installs. */
function user() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

/** A row in the section list, by its label — the count and the hint are not part of the name. */
function row(label: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${label}`) });
}

/** The pane's heading, which is what tells you which panel is open. */
function openPanel(): string {
  return screen.getByRole('heading', { level: 1 }).textContent ?? '';
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  // The theme store caches at module scope and only drops it on a `storage` event naming its own
  // key. Without this, a test that chose dark would leave the next test dark — an ordering
  // dependency that would read as a flaky theme test.
  window.localStorage.clear();
  window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── the directory ─────────────────────────────────────────────────────────────

describe('the directory', () => {
  it('names every destination that moved out of the sidebar', async () => {
    stubApi(defaultRoutes());
    renderSettings();

    await screen.findByRole('heading', { level: 1 });

    for (const item of SETTINGS_DIRECTORY) {
      expect(row(item.label)).toBeTruthy();
    }

    // And nothing is listed twice.
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const paths = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent ?? '');
    expect(paths.filter((text) => text.includes('Agents'))).toHaveLength(1);
  });

  it('has a summary component for every destination, so no row can silently show no count', () => {
    // The assertion that makes the silence impossible. `DIRECTORY_SUMMARY` is a lookup by path; a
    // destination added to the tree without a summary would render a panel with a heading, an Open
    // button and *no number*, and nothing would fail. This is the test that fails instead.
    const expected = SETTINGS_DIRECTORY.map((item) => item.path).sort();
    expect([...DIRECTORY_SUMMARY_PATHS].sort()).toEqual(expected);
  });

  it('opens a destination in place, showing a real count and the way through', async () => {
    stubApi(
      defaultRoutes({
        'GET /api/agents': { body: { agents: [agent('a1', 'Research Scout'), agent('a2', 'Inbox')] } },
      }),
    );
    renderSettings();

    await user().click(row('Agents'));

    // The count is the server's, and the panel is the one that was asked for.
    expect(openPanel()).toBe('Agents');
    expect(await screen.findByText('2')).toBeTruthy();
    expect(screen.getByText('agents')).toBeTruthy();

    const open = screen.getByRole('link', { name: 'Open Agents' });
    expect(open.getAttribute('href')).toBe('/agents');
  });

  it('reports a failed count as a failure rather than as zero', async () => {
    stubApi(defaultRoutes({ 'GET /api/agents': { status: 500 } }));
    renderSettings();

    await user().click(row('Agents'));

    expect(await screen.findByText('Could not read the count from the server.')).toBeTruthy();
    // "Nothing here yet" and "we could not ask" are different facts.
    expect(screen.queryByText('Nothing here yet.')).toBeNull();
  });

  it('takes its key hints from the live binding table, so a hint cannot advertise a dead key', async () => {
    stubApi(defaultRoutes());
    renderSettings();

    await screen.findByRole('heading', { level: 1 });

    const inbox = row('Decision Inbox');
    const hint = within(inbox).getByText(/^g /).textContent;
    expect(GOTO_SHORTCUTS.find((entry) => entry.key === hint.replace('g ', ''))?.path).toBe(
      '/approvals',
    );

    // And a destination with no binding shows no hint at all, rather than an invented one.
    expect(within(row('Goals')).queryByText(/^g /)).toBeNull();
  });

  it('badges the inbox with the live pending count', async () => {
    stubApi(
      defaultRoutes({
        'GET /api/approvals?actionableOnly=false': { body: { approvals: [], pendingCount: 4 } },
      }),
    );
    renderSettings();

    await screen.findByRole('heading', { level: 1 });
    expect(within(row('Decision Inbox')).getByText('4')).toBeTruthy();
  });
});

// ── master and detail ─────────────────────────────────────────────────────────

describe('the master-detail', () => {
  it('opens on Profile, with no section in the URL', async () => {
    stubApi(defaultRoutes());
    renderSettings();

    expect(openPanel()).toBe('Profile');
    // The default is spelled as an absent parameter, so `/settings` is the canonical address.
    expect(screen.getByTestId('location').textContent).toBe('/settings');
  });

  it('swaps the panel in place instead of navigating to a page', async () => {
    stubApi(defaultRoutes());
    renderSettings();

    await user().click(row('Appearance'));

    expect(openPanel()).toBe('Appearance');
    // Still `/settings` — the panel changed, the route did not. A route per section would have
    // made this a page load.
    expect(screen.getByTestId('location').textContent).toBe('/settings?section=appearance');
  });

  it('reads the open panel from the URL, so a reload keeps your place', async () => {
    stubApi(defaultRoutes({ 'GET /api/notifications': { body: { notifications: [], unreadCount: 0 } } }));
    renderSettings('/settings?section=notifications');

    expect(openPanel()).toBe('Notifications');
  });

  it('falls back to Profile when the URL names a section that does not exist', async () => {
    stubApi(defaultRoutes());
    renderSettings('/settings?section=nonsense');

    expect(openPanel()).toBe('Profile');
    // Not a blank page and not a crash — an unrecognised parameter is a miss, and a reader who
    // hand-edited the URL gets the panel the page opens on.
    expect(screen.queryByText(/No such settings section/)).toBeNull();
  });

  it('marks the open panel as the current row, and only that one', async () => {
    stubApi(defaultRoutes());
    renderSettings();

    await screen.findByRole('heading', { level: 1 });

    // Named, not "the first one that says current" — that assertion would pass whichever row was
    // marked, including the wrong one.
    expect(row('Profile').getAttribute('aria-current')).toBe('true');

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const current = within(nav)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'true');

    expect(current).toHaveLength(1);
  });
});

// ── the panels that came from the card ────────────────────────────────────────

describe('the account panel', () => {
  it('shows the account that used to be behind the topbar corner square', async () => {
    stubApi(defaultRoutes());
    renderSettings();

    expect(await screen.findByText('Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('ada@example.test')).toBeTruthy();
    expect(screen.getByText('Analytical Engines')).toBeTruthy();
  });
});

describe('the notifications panel', () => {
  it('says a failed read failed, rather than showing an empty inbox', async () => {
    stubApi(defaultRoutes({ 'GET /api/notifications': { status: 500 } }));
    renderSettings('/settings?section=notifications');

    expect(await screen.findByText('Could not load notifications.')).toBeTruthy();
    expect(screen.queryByText(/Nothing yet/)).toBeNull();
  });

  it('carries the unread count and opens what the notification is about', async () => {
    stubApi(
      defaultRoutes({
        'GET /api/notifications': {
          body: {
            unreadCount: 1,
            notifications: [
              {
                id: 'n1',
                kind: 'task_completed',
                title: 'Nightly digest finished',
                body: 'Twelve sources, one verified claim.',
                linkRoute: '/runs/r1',
                readAt: null,
                isRead: false,
                createdAt: at(2026, 8, 21, 8),
              },
            ],
          },
        },
        // The row marks itself read on the way out, so the write has to be answered too.
        'PATCH /api/notifications/n1/read': { body: {} },
      }),
    );
    renderSettings('/settings?section=notifications');

    expect(await screen.findByText('1 unread.')).toBeTruthy();
    await user().click(screen.getByText('Nightly digest finished'));

    // A notification you cannot act on is a dead end, so the row navigates.
    expect(screen.getByTestId('location').textContent).toBe('/runs/r1');
  });
});

describe('the appearance panel', () => {
  it('offers both themes and applies the one chosen', async () => {
    stubApi(defaultRoutes());
    renderSettings('/settings?section=appearance');

    expect(
      (await screen.findByRole('button', { name: 'Light' })).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')).toBe('false');

    await user().click(screen.getByRole('button', { name: 'Dark' }));

    // The attribute is what the browser reads; the stored value is what the next cold load reads.
    // A control that set only one of the two would look like it worked.
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });
});

describe('the session panel', () => {
  it('keeps sign out', async () => {
    stubApi(defaultRoutes());
    renderSettings('/settings?section=session');

    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
});
