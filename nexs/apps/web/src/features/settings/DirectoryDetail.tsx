/**
 * One destination, as the Settings pane shows it.
 *
 * ## What a directory row is for
 *
 * The destinations filed under `home: 'settings'` in `lib/navigation.ts` are pages, not controls —
 * Dashboard, Agents, Goals, Tasks, Workflows, Runs, Decision Inbox, Memory, Research, Files. They
 * left the sidebar because they are *the work* rather than the way to it, and what a person wants
 * from a directory is two things: **what is in there right now**, and a door.
 *
 * So this renders exactly that. A count, and an Open button. Nothing else — no preview of the
 * rows, because a preview in a 200px pane is a worse version of the page it links to.
 *
 * ## Every number here comes from the server
 *
 * There is one rule this file exists to obey: a count is only rendered if an endpoint reports it.
 * Nine small components, each calling one hook, rather than a loop over a table of fabricated
 * numbers. Where a list endpoint returns a `total` computed by a separate `COUNT` — memory and
 * research both do — that is the number used, and the request asks for `limit: 1` because the
 * rows are not wanted and the total does not depend on the limit. (`memory.repo.ts` and
 * `research.repo.ts` both exclude `limit` from their `count`.)
 *
 * ## Why one component per destination instead of a table
 *
 * The obvious shape is a `Record<path, () => number>`, and it cannot be written: a hook has to be
 * called at the top level of a component, so a map of hooks would have to be invoked through a
 * name the linter cannot see is a hook. Each summary is therefore its own component with its own
 * hook at its own top level, and `DIRECTORY_SUMMARY` is a map of *component references* — which
 * React can mount and unmount normally.
 *
 * The consequence is deliberate: **one request runs at a time**, for whichever destination is
 * selected. The alternative — every hook in one component — would fire every list query the
 * moment Settings opened.
 *
 * `DIRECTORY_SUMMARY` is keyed by path, so a destination added to the tree without a summary
 * would silently render no count. `SettingsPage.test.tsx` asserts the two sets are equal, which
 * is what makes the silence impossible.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { NavItem } from '../../lib/navigation';
import { api, qs } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { useAgents } from '../agents/queries';
import { useApprovals } from '../approvals/queries';
import { useDashboard } from '../dashboard/queries';
import { useFolderGrants } from '../files/queries';
import { useGoals } from '../goals/queries';
import { useRuns } from '../runs/queries';
import { useTasks } from '../tasks/queries';
import { useWorkflows } from '../workflows/queries';

// ── the one line every summary renders ────────────────────────────────────────

interface CountLineProps {
  pending: boolean;
  error: boolean;
  /** `undefined` while pending or after a failure — never coerced to `0`. */
  count: number | undefined;
  singular: string;
  plural: string;
}

/**
 * How many of a thing there are.
 *
 * A failed read is never rendered as `0`. "Nothing here yet" and "we could not ask" are different
 * facts, and printing the first when the second is true is the failure this codebase refuses
 * everywhere else — a page that reads as empty when the server is down.
 */
function CountLine({ pending, error, count, singular, plural }: CountLineProps): ReactNode {
  if (pending) return <p className="muted small">Counting…</p>;
  if (error) return <p className="muted small">Could not read the count from the server.</p>;
  if (count === undefined) return null;
  if (count === 0) return <p className="muted small">Nothing here yet.</p>;

  return (
    <p className="muted small">
      <strong className="settings-count">{count}</strong> {count === 1 ? singular : plural}
    </p>
  );
}

// ── one component per destination ─────────────────────────────────────────────

/** The snapshot's own live count: runs in flight, which is the one number on it that moves. */
function DashboardSummary(): ReactNode {
  const query = useDashboard();
  return (
    <CountLine
      pending={query.isPending}
      error={query.isError}
      count={query.data?.counts.runsActive}
      singular="run in flight"
      plural="runs in flight"
    />
  );
}

function AgentsSummary(): ReactNode {
  const query = useAgents();
  return (
    <CountLine
      pending={query.isPending}
      error={query.isError}
      count={query.data?.length}
      singular="agent"
      plural="agents"
    />
  );
}

function GoalsSummary(): ReactNode {
  const query = useGoals();
  return (
    <CountLine
      pending={query.isPending}
      error={query.isError}
      count={query.data?.length}
      singular="goal"
      plural="goals"
    />
  );
}

function TasksSummary(): ReactNode {
  const query = useTasks();
  return (
    <CountLine
      pending={query.isPending}
      error={query.isError}
      count={query.data?.length}
      singular="task"
      plural="tasks"
    />
  );
}

function WorkflowsSummary(): ReactNode {
  const query = useWorkflows();
  return (
    <CountLine
      pending={query.isPending}
      error={query.isError}
      count={query.data?.length}
      singular="workflow"
      plural="workflows"
    />
  );
}

function RunsSummary(): ReactNode {
  const query = useRuns();
  return (
    <CountLine
      pending={query.isPending}
      error={query.isError}
      // `RunListResponse` carries a server-side `total`, so this is the count of runs matching
      // the (empty) filter rather than the length of whatever page came back.
      count={query.data?.total}
      singular="run"
      plural="runs"
    />
  );
}

function ApprovalsSummary(): ReactNode {
  const query = useApprovals();
  return (
    <CountLine
      pending={query.isPending}
      error={query.isError}
      // `pendingCount` is the server's own count of approvals that are pending *and* not past
      // their deadline — not the length of the list, which is unfiltered.
      count={query.data?.pendingCount}
      singular="decision waiting"
      plural="decisions waiting"
    />
  );
}

/** `/memory` returns `{ memories, total }`; `total` is a separate `COUNT`, so `limit: 1` is enough. */
function MemorySummary(): ReactNode {
  const query = useQuery({
    queryKey: [...queryKeys.memory, 'count'] as const,
    queryFn: () => api<{ memories: unknown[]; total: number }>(`/memory${qs({ limit: 1 })}`),
  });
  return (
    <CountLine
      pending={query.isPending}
      error={query.isError}
      count={query.data?.total}
      singular="memory"
      plural="memories"
    />
  );
}

/** `/research` returns `{ projects, total }`, computed the same way. */
function ResearchSummary(): ReactNode {
  const query = useQuery({
    queryKey: [...queryKeys.research.all, 'count'] as const,
    queryFn: () => api<{ projects: unknown[]; total: number }>(`/research${qs({ limit: 1 })}`),
  });
  return (
    <CountLine
      pending={query.isPending}
      error={query.isError}
      count={query.data?.total}
      singular="research project"
      plural="research projects"
    />
  );
}

function FilesSummary(): ReactNode {
  const query = useFolderGrants();
  return (
    <CountLine
      pending={query.isPending}
      error={query.isError}
      count={query.data?.length}
      singular="folder grant"
      plural="folder grants"
    />
  );
}

/**
 * The summaries, by path.
 *
 * A map of component *references*, not of hooks — see the header. Keyed by the same path strings
 * `SETTINGS_DIRECTORY` carries, and asserted against it by the test.
 */
const DIRECTORY_SUMMARY: Record<string, () => ReactNode> = {
  '/dashboard': DashboardSummary,
  '/agents': AgentsSummary,
  '/goals': GoalsSummary,
  '/tasks': TasksSummary,
  '/workflows': WorkflowsSummary,
  '/runs': RunsSummary,
  '/approvals': ApprovalsSummary,
  '/memory': MemorySummary,
  '/research': ResearchSummary,
  '/files': FilesSummary,
};

/** The paths this file can count — exported so the test compares against the real map. */
export const DIRECTORY_SUMMARY_PATHS: readonly string[] = Object.keys(DIRECTORY_SUMMARY);

// ── the pane ──────────────────────────────────────────────────────────────────

/**
 * A destination in the detail pane: how much of it there is, and the way in.
 *
 * The `Link` carries the button classes rather than wrapping a `<button>`: a button inside an
 * anchor is invalid HTML and a browser resolves the ambiguity by dropping one of them.
 */
export function DirectoryDetail({ item }: { item: NavItem }): ReactNode {
  const Summary = DIRECTORY_SUMMARY[item.path];

  return (
    <div className="stack">
      {Summary === undefined ? null : <Summary />}

      <div className="row">
        <Link className="btn btn-primary settings-open" to={item.path}>
          Open {item.label}
        </Link>
      </div>
    </div>
  );
}
