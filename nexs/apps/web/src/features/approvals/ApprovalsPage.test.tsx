/**
 * The Decision Inbox drawer.
 *
 * This is the third of the three units Phase 14 item 3 names by hand — *"RTL units for slash
 * parser, mention resolver, approval drawer"*. The first two are pure functions; this one is
 * not, and the interesting part is not the markup. It is the two claims `ApprovalsPage.tsx`
 * makes about itself in its own header comment:
 *
 *   1. the decision settles **optimistically** — the row and the pending count move before
 *      the server has answered;
 *   2. a failed decision **rolls back** to the row the server still believes in, and the
 *      drawer stays open so the failure is visible rather than silent.
 *
 * Both are asserted against the query cache rather than against the pixels, because the cache
 * is what the next render reads. A test that only checked "the drawer closed" would pass with
 * the optimistic write deleted — which is the mistake worth catching.
 *
 * The list refetch is deliberately left hanging in the optimistic case. `useDecideApproval`
 * invalidates `['approvals']` on success, so a stub that answered that refetch would leave the
 * server's copy in the cache and the assertion would prove nothing about the write under test.
 * A never-settling response is what isolates it.
 *
 * The drawer is driven the way an operator drives it — through the table row — rather than by
 * exporting `DecisionDrawer` for the test's convenience. The row's `onClick` is part of the
 * feature, and a test that skipped it would not notice if it broke.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ApprovalDetail, ApprovalSummary } from '@nexs/shared';
import { queryKeys } from '../../lib/query-keys';
import { ApprovalsPage } from './ApprovalsPage';
import { isExecApproval, splitApprovalsByKind } from './exec-queries';

// ── fixtures ──────────────────────────────────────────────────────────────────

const NOW = Date.now();

/** A minute ago — far enough back that `formatRelative` never says "now". */
const CREATED_AT = new Date(NOW - 60_000).toISOString();
const PASSED = new Date(NOW - 30_000).toISOString();
const RUN_ID = 'run_abcdef123456';

function summary(over: Partial<ApprovalSummary> = {}): ApprovalSummary {
  return {
    id: 'ap_1',
    status: 'pending',
    title: 'Send the weekly report',
    description: null,
    isExpired: false,
    risk: { level: 'low', reasons: [] },
    requiredPermissions: [],
    agentId: null,
    goalId: null,
    taskId: null,
    runId: null,
    stepId: null,
    decidedBy: null,
    decidedAt: null,
    expiresAt: null,
    createdAt: CREATED_AT,
    ...over,
  };
}

function detail(over: Partial<ApprovalDetail> = {}): ApprovalDetail {
  return {
    ...summary(over),
    requestedAction: { tool: 'files.write', path: '/srv/reports/week.md' },
    action: { id: 'act_1', kind: 'tool_call', status: 'requested', title: 'Write the report' },
    run: { id: RUN_ID, kind: 'task', status: 'waiting_approval' },
    ...over,
  };
}

interface ApprovalListCache {
  approvals: ApprovalSummary[];
  pendingCount: number;
}

// ── the API stub ──────────────────────────────────────────────────────────────

interface StubRoute {
  status?: number;
  body?: unknown;
  /** Never settles — a request still in flight when the assertion runs. */
  hang?: boolean;
}

interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Route a request by `METHOD /api/path`.
 *
 * Each key holds a *sequence* consumed in order, with the last entry repeating. That is what
 * lets one endpoint answer the first time and hang the second, which the optimistic test needs.
 * An unstubbed request throws rather than returning an empty 200: a page that quietly fetched
 * something unexpected should fail loudly here, not render a plausible blank.
 */
function stubApi(routes: Record<string, readonly StubRoute[]>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const seen = new Map<string, number>();

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({
        method,
        url,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });

      const key = `${method} ${url}`;
      const sequence = routes[key];
      if (sequence === undefined) throw new Error(`unstubbed request: ${key}`);

      const index = Math.min(seen.get(key) ?? 0, sequence.length - 1);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      const route = sequence[index] as StubRoute;

      if (route.hang === true) return new Promise<never>(() => undefined);

      const status = route.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Request failed',
        text: async () => (route.body === undefined ? '' : JSON.stringify(route.body)),
      };
    }),
  );

  return calls;
}

function renderInbox(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      // A retry would turn a deliberate 500 into a slow test that passes for the wrong reason.
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ApprovalsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return client;
}

/** Open the drawer for the row with this title, and hand back the dialog. */
async function openDrawer(user: ReturnType<typeof userEvent.setup>, title: string): Promise<HTMLElement> {
  await user.click(await screen.findByText(title));
  return screen.findByRole('dialog');
}

function listCache(client: QueryClient): ApprovalListCache | undefined {
  return client.getQueryData<ApprovalListCache>(queryKeys.approvals.all);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('DecisionDrawer', () => {
  it('settles the decision optimistically, before the server has answered', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /api/approvals?actionableOnly=false': [
        {
          body: {
            approvals: [
              summary({ id: 'ap_1', title: 'Send the weekly report' }),
              summary({ id: 'ap_2', title: 'Rotate the API key' }),
            ],
            pendingCount: 2,
          },
        },
        // The invalidation refetch. Left hanging, so the only writer of the cache is the
        // optimistic update under test.
        { hang: true },
      ],
      'GET /api/approvals/ap_1': [
        { body: { approval: detail({ id: 'ap_1', title: 'Send the weekly report' }) } },
      ],
      'POST /api/approvals/ap_1/decide': [
        {
          body: {
            approval: detail({ id: 'ap_1', title: 'Send the weekly report', status: 'approved' }),
            runOutcome: null,
          },
        },
      ],
    });

    const client = renderInbox();
    const dialog = await openDrawer(user, 'Send the weekly report');

    expect(
      within(dialog).getByRole('heading', { name: 'Send the weekly report' }),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    // Success closes the drawer...
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // ...and the row is already decided in the cache, with the count moved by exactly one,
    // even though the refetch that would confirm it never answered.
    const cache = listCache(client);
    expect(cache?.approvals.find((row) => row.id === 'ap_1')?.status).toBe('approved');
    expect(cache?.approvals.find((row) => row.id === 'ap_2')?.status).toBe('pending');
    expect(cache?.pendingCount).toBe(1);

    // The header badge reads that same cache, so the number on screen moved too.
    expect(screen.getByText('1 pending')).toBeInTheDocument();

    // And the request carried the decision the button stood for.
    const decide = calls.find((call) => call.method === 'POST');
    expect(decide?.url).toBe('/api/approvals/ap_1/decide');
    expect(decide?.body).toEqual({ decision: 'approved' });
  });

  it('rolls back the row and the count when the decision fails', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /api/approvals?actionableOnly=false': [
        {
          body: {
            approvals: [
              summary({ id: 'ap_1', title: 'Send the weekly report' }),
              summary({ id: 'ap_2', title: 'Rotate the API key' }),
            ],
            pendingCount: 2,
          },
        },
      ],
      'GET /api/approvals/ap_1': [
        { body: { approval: detail({ id: 'ap_1', title: 'Send the weekly report' }) } },
      ],
      'POST /api/approvals/ap_1/decide': [
        {
          status: 500,
          body: {
            error: { code: 'INTERNAL_ERROR', message: 'the approval service is unavailable' },
          },
        },
      ],
    });

    const client = renderInbox();
    const dialog = await openDrawer(user, 'Send the weekly report');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    // The failure is shown, not swallowed.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'the approval service is unavailable',
    );

    // The row and the count are back where the server still believes they are.
    const cache = listCache(client);
    expect(cache?.approvals.find((row) => row.id === 'ap_1')?.status).toBe('pending');
    expect(cache?.pendingCount).toBe(2);

    // The drawer stays open, with the decision available to try again.
    const stillOpen = screen.getByRole('dialog');
    expect(within(stillOpen).getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(within(stillOpen).getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('offers no decision on an approval that has already been decided', async () => {
    const user = userEvent.setup();
    const decided = {
      id: 'ap_1',
      title: 'Send the weekly report',
      status: 'rejected',
      decidedBy: 'usr_owner',
      decidedAt: CREATED_AT,
    } as const;

    stubApi({
      'GET /api/approvals?actionableOnly=false': [
        { body: { approvals: [summary(decided)], pendingCount: 0 } },
      ],
      'GET /api/approvals/ap_1': [{ body: { approval: detail(decided) } }],
    });

    renderInbox();

    // The default tab is "Waiting on you", and a decided approval is waiting on nobody.
    expect(await screen.findByText('Nothing waiting')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /all/i }));
    const dialog = await openDrawer(user, 'Send the weekly report');

    expect(within(dialog).getByText('This decision has already been made.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();

    // The dialog names itself from the rendered title. It used to announce "[object Object]",
    // because `Drawer` built its `aria-label` with `String(title)` on a React element.
    expect(screen.getByRole('dialog', { name: /rejected/i })).toBeInTheDocument();
  });

  it('hides an expired approval from the actionable tab but keeps it under All', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /api/approvals?actionableOnly=false': [
        {
          body: {
            approvals: [
              summary({ id: 'ap_1', title: 'Still live' }),
              summary({ id: 'ap_2', title: 'Deadline passed', isExpired: true, expiresAt: PASSED }),
            ],
            // The server's own count already excludes the lapsed row, and the filter must
            // agree with it rather than deriving a second answer.
            pendingCount: 1,
          },
        },
      ],
    });

    renderInbox();

    expect(await screen.findByText('Still live')).toBeInTheDocument();
    expect(screen.queryByText('Deadline passed')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /all/i }));
    expect(await screen.findByText('Deadline passed')).toBeInTheDocument();
  });

  it('shows a lapsed approval but refuses to decide it', async () => {
    const user = userEvent.setup();
    const lapsed = {
      id: 'ap_2',
      title: 'Deadline passed',
      isExpired: true,
      expiresAt: PASSED,
    } as const;

    stubApi({
      'GET /api/approvals?actionableOnly=false': [
        { body: { approvals: [summary(lapsed)], pendingCount: 0 } },
      ],
      'GET /api/approvals/ap_2': [{ body: { approval: detail(lapsed) } }],
    });

    renderInbox();

    // The tabs only exist once the list has answered, so this waits for the fetch as well.
    await user.click(await screen.findByRole('tab', { name: /all/i }));
    const dialog = await openDrawer(user, 'Deadline passed');

    // The button follows `isExpired`, not the countdown: offering an Approve the server will
    // refuse is worse than a stale label.
    expect(within(dialog).getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Reject' })).toBeDisabled();

    // The countdown has run out and says so, rather than printing "in expired".
    expect(within(dialog).getByText('expired (lapsed)')).toBeInTheDocument();
  });

  it('renders the action, the permissions and the run the decision gates', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /api/approvals?actionableOnly=false': [
        {
          body: {
            approvals: [
              summary({
                id: 'ap_1',
                title: 'Send the weekly report',
                risk: {
                  level: 'high',
                  reasons: ['The tool writes outside the workspace', 'The action reaches the network'],
                },
                requiredPermissions: ['files:write', 'network:egress'],
                runId: RUN_ID,
              }),
            ],
            pendingCount: 1,
          },
        },
      ],
      'GET /api/approvals/ap_1': [
        {
          body: {
            approval: detail({
              id: 'ap_1',
              title: 'Send the weekly report',
              risk: {
                level: 'high',
                reasons: ['The tool writes outside the workspace', 'The action reaches the network'],
              },
              requiredPermissions: ['files:write', 'network:egress'],
              runId: RUN_ID,
            }),
          },
        },
      ],
    });

    renderInbox();
    const dialog = await openDrawer(user, 'Send the weekly report');

    // The raw payload, so the operator sees what would actually happen.
    expect(within(dialog).getByText(/files\.write/)).toBeInTheDocument();
    expect(within(dialog).getByText('files:write')).toBeInTheDocument();
    expect(within(dialog).getByText('network:egress')).toBeInTheDocument();
    expect(within(dialog).getByText('The tool writes outside the workspace')).toBeInTheDocument();

    // The run this decision gates is one click away.
    expect(within(dialog).getByRole('link')).toHaveAttribute('href', `/runs/${RUN_ID}`);
  });

  it('paints the risk level with the shared tone vocabulary', async () => {
    stubApi({
      'GET /api/approvals?actionableOnly=false': [
        {
          body: {
            approvals: [
              summary({ id: 'ap_1', title: 'Low risk thing', risk: { level: 'low', reasons: [] } }),
              summary({ id: 'ap_2', title: 'Medium risk thing', risk: { level: 'medium', reasons: [] } }),
              summary({ id: 'ap_3', title: 'High risk thing', risk: { level: 'high', reasons: [] } }),
            ],
            pendingCount: 3,
          },
        },
      ],
    });

    renderInbox();
    await screen.findByText('Low risk thing');

    expect(screen.getByText('low')).toHaveClass('badge-ok');
    expect(screen.getByText('medium')).toHaveClass('badge-waiting');
    expect(screen.getByText('high')).toHaveClass('badge-failed');
  });
});

/**
 * The exec/tool split (§6.2 of the terminal spec).
 *
 * The rule looks trivial and is not.  carries **no  field** — the
 * discriminator the server branched on lives on the *detail*'s , and the summary's
 * only usable signal is . So the split reads a permission list to answer a
 * question about a type, which is exactly the kind of indirection that breaks silently: if the
 * server ever stops putting \ in that array, every exec approval silently becomes a tool
 * approval and the three-answer overlay stops appearing. Nothing crashes. That is why it is tested
 * directly rather than only through the page.
 */
describe('the exec/tool split', () => {
  it('treats an approval requiring the exec permission as exec', () => {
    expect(isExecApproval(summary({ requiredPermissions: ['exec'] }))).toBe(true);
  });

  it('does not treat a tool approval as exec', () => {
    expect(isExecApproval(summary({ requiredPermissions: ['files.write'] }))).toBe(false);
  });

  it('does not treat an approval with no permissions as exec', () => {
    // The empty list is the default fixture, so this is the case most rows hit.
    expect(isExecApproval(summary())).toBe(false);
  });

  it('reads exec out of a longer permission list', () => {
    // A command that both writes and executes carries both, and must still route to the overlay.
    expect(isExecApproval(summary({ requiredPermissions: ['files.write', 'exec'] }))).toBe(true);
  });

  it('is not fooled by a permission that merely contains the word', () => {
    //  is an exact-match test on the array, not a substring test on the string. A
    // half-written permission like \ must not open a three-answer overlay.
    expect(isExecApproval(summary({ requiredPermissions: ['exec_readonly'] }))).toBe(false);
  });

  it('partitions every row, losing none and duplicating none', () => {
    const rows = [
      summary({ id: 'ap_tool', requiredPermissions: ['files.write'] }),
      summary({ id: 'ap_exec', requiredPermissions: ['exec'] }),
      summary({ id: 'ap_bare' }),
    ];

    const { tool, exec } = splitApprovalsByKind(rows);

    expect(exec.map((row) => row.id)).toEqual(['ap_exec']);
    expect(tool.map((row) => row.id)).toEqual(['ap_tool', 'ap_bare']);
    expect(tool.length + exec.length).toBe(rows.length);
  });

  it('preserves the order it was given inside each partition', () => {
    const rows = [
      summary({ id: 'a', requiredPermissions: ['exec'] }),
      summary({ id: 'b' }),
      summary({ id: 'c', requiredPermissions: ['exec'] }),
      summary({ id: 'd' }),
    ];

    const { tool, exec } = splitApprovalsByKind(rows);

    // The server sorts by urgency; re-sorting here would be a second opinion about that order.
    expect(exec.map((row) => row.id)).toEqual(['a', 'c']);
    expect(tool.map((row) => row.id)).toEqual(['b', 'd']);
  });

  it('handles an empty inbox without inventing a row', () => {
    expect(splitApprovalsByKind([])).toEqual({ tool: [], exec: [] });
  });
});

/**
 * The exec/tool split (section 6.2 of the terminal spec).
 *
 * The rule looks trivial and is not. `ApprovalSummary` carries **no `kind` field** -- the
 * discriminator the server branched on lives on the *detail*'s `action.kind`, and the summary's
 * only usable signal is `requiredPermissions`. So the split reads a permission list to answer a
 * question about a type, which is exactly the kind of indirection that breaks silently: if the
 * server ever stops putting `exec` in that array, every exec approval silently becomes a tool
 * approval and the three-answer overlay stops appearing. Nothing crashes. That is why it is tested
 * directly rather than only through the page.
 */
describe('the exec/tool split', () => {
  it('treats an approval requiring the exec permission as exec', () => {
    expect(isExecApproval(summary({ requiredPermissions: ['exec'] }))).toBe(true);
  });

  it('does not treat a tool approval as exec', () => {
    expect(isExecApproval(summary({ requiredPermissions: ['files.write'] }))).toBe(false);
  });

  it('does not treat an approval with no permissions as exec', () => {
    // The empty list is the default fixture, so this is the case most rows hit.
    expect(isExecApproval(summary())).toBe(false);
  });

  it('reads exec out of a longer permission list', () => {
    // A command that both writes and executes carries both, and must still route to the overlay.
    expect(isExecApproval(summary({ requiredPermissions: ['files.write', 'exec'] }))).toBe(true);
  });

  it('is not fooled by a permission that merely contains the word', () => {
    // `includes` is an exact-match test on the array, not a substring test on the string. A
    // half-written permission like `exec_readonly` must not open a three-answer overlay.
    expect(isExecApproval(summary({ requiredPermissions: ['exec_readonly'] }))).toBe(false);
  });

  it('partitions every row, losing none and duplicating none', () => {
    const rows = [
      summary({ id: 'ap_tool', requiredPermissions: ['files.write'] }),
      summary({ id: 'ap_exec', requiredPermissions: ['exec'] }),
      summary({ id: 'ap_bare' }),
    ];

    const { tool, exec } = splitApprovalsByKind(rows);

    expect(exec.map((row) => row.id)).toEqual(['ap_exec']);
    expect(tool.map((row) => row.id)).toEqual(['ap_tool', 'ap_bare']);
    expect(tool.length + exec.length).toBe(rows.length);
  });

  it('preserves the order it was given inside each partition', () => {
    const rows = [
      summary({ id: 'a', requiredPermissions: ['exec'] }),
      summary({ id: 'b' }),
      summary({ id: 'c', requiredPermissions: ['exec'] }),
      summary({ id: 'd' }),
    ];

    const { tool, exec } = splitApprovalsByKind(rows);

    // The server sorts by urgency; re-sorting here would be a second opinion about that order.
    expect(exec.map((row) => row.id)).toEqual(['a', 'c']);
    expect(tool.map((row) => row.id)).toEqual(['b', 'd']);
  });

  it('handles an empty inbox without inventing a row', () => {
    expect(splitApprovalsByKind([])).toEqual({ tool: [], exec: [] });
  });
});
