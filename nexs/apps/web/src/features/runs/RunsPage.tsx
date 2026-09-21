/**
 * The run list.
 *
 * Filters are sent to the server rather than applied in memory, because runs are the one
 * collection here that grows without bound — a client-side filter would mean fetching every
 * run a tenant ever produced to show twenty.
 *
 * Live updates come from the SSE map, not from polling: `run.*` and `step.*` both
 * invalidate `['runs']`, so a row's status changes on its own.
 */

import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { RUN_STATUSES } from '@nexs/shared';
import { Badge, Card, EmptyState, PageHead, QueryBoundary, StatusBadge } from '../../components/ui';
import { formatDuration, formatRelative, shortId } from '../../lib/format';
import { labelForStatus } from '../../lib/status';
import { useRuns } from './queries';

const PAGE_SIZE = 50;

export function RunsPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [offset, setOffset] = useState(0);

  const query = useRuns({
    ...(status !== '' ? { status } : {}),
    limit: PAGE_SIZE,
    offset,
  });

  return (
    <>
      <PageHead
        title="Runs"
        subtitle="Every execution, with its steps, tool calls and receipts."
      />

      <div className="toolbar">
        <select
          className="select"
          value={status}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            if (event.target.value === '') next.delete('status');
            else next.set('status', event.target.value);
            setParams(next, { replace: true });
            // A new filter is a new result set, so page 3 of the old one is meaningless.
            setOffset(0);
          }}
          aria-label="Filter by status"
        >
          <option value="">Any status</option>
          {RUN_STATUSES.map((value) => (
            <option key={value} value={value}>
              {labelForStatus(value)}
            </option>
          ))}
        </select>
      </div>

      <Card flush>
        <QueryBoundary
          query={query}
          loadingLabel="Loading runs…"
          isEmpty={(data) => data.runs.length === 0}
          empty={
            <EmptyState
              title={status === '' ? 'No runs yet' : `No runs with status "${status}"`}
              hint="Runs are created by agents, tasks, workflows and chat."
            />
          }
        >
          {(data) => (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Kind</th>
                    <th>Status</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>Correlation</th>
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <Link className="mono" to={`/runs/${run.id}`} title={run.id}>
                          {shortId(run.id)}
                        </Link>
                        {run.error !== null ? (
                          <div className="small" style={{ color: 'var(--status-failed)' }}>
                            {run.error.message}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <Badge tone="accent">{run.kind}</Badge>
                      </td>
                      <td>
                        <StatusBadge status={run.status} />
                      </td>
                      <td className="muted small nowrap" title={run.startedAt ?? run.createdAt}>
                        {formatRelative(run.startedAt ?? run.createdAt)}
                      </td>
                      <td className="muted small nowrap">
                        {formatDuration(run.durationMs)}
                      </td>
                      <td className="muted mono small truncate" title={run.correlationId}>
                        {shortId(run.correlationId, 12)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="pager">
                <span className="muted small grow">
                  {data.runs.length} of {data.total}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={offset + PAGE_SIZE >= data.total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </QueryBoundary>
      </Card>
    </>
  );
}
