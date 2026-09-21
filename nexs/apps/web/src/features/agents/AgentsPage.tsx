/**
 * The agent list — §4-PHASE13.3's *"list (status chips)"*.
 *
 * Status chips are links, not a dropdown: `?status=active` is a shareable URL, and the
 * server filters, so a workspace with two hundred agents does not ship two hundred rows to
 * the browser to show four.
 */

import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AGENT_STATUSES } from '@nexs/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHead,
  QueryBoundary,
  StatusBadge,
} from '../../components/ui';
import { formatRelative, shortId } from '../../lib/format';
import { labelForStatus } from '../../lib/status';
import { CreateAgentWizard } from './CreateAgentWizard';
import { useAgents } from './queries';

export function AgentsPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const [wizardOpen, setWizardOpen] = useState(false);

  const query = useAgents(status === '' ? {} : { status });

  return (
    <>
      <PageHead
        title="Agents"
        subtitle="Each agent is a configuration: instructions, a model, and what it may use."
        actions={
          <Button variant="primary" onClick={() => setWizardOpen(true)}>
            New agent
          </Button>
        }
      />

      <div className="toolbar">
        <button
          type="button"
          className={status === '' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
          onClick={() => {
            const next = new URLSearchParams(params);
            next.delete('status');
            setParams(next, { replace: true });
          }}
        >
          All
        </button>
        {AGENT_STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            className={status === value ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set('status', value);
              setParams(next, { replace: true });
            }}
          >
            {labelForStatus(value)}
          </button>
        ))}
      </div>

      <Card flush>
        <QueryBoundary
          query={query}
          loadingLabel="Loading agents…"
          isEmpty={(data) => data.length === 0}
          empty={
            <EmptyState
              title={status === '' ? 'No agents yet' : `No ${status} agents`}
              hint="An agent needs a model and instructions before it can run."
              action={
                status === '' ? (
                  <Button variant="primary" onClick={() => setWizardOpen(true)}>
                    Create the first agent
                  </Button>
                ) : undefined
              }
            />
          }
        >
          {(agents) => (
            <table className="table table-clickable">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Version</th>
                  <th>Tools</th>
                  <th>Model</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <Link to={`/agents/${agent.id}`}>{agent.name}</Link>
                      {agent.description !== null ? (
                        <div className="muted small truncate">{agent.description}</div>
                      ) : null}
                    </td>
                    <td>
                      <StatusBadge status={agent.status} />
                    </td>
                    <td>
                      <Badge>v{agent.version}</Badge>
                    </td>
                    <td className="muted small">{agent.toolIds.length}</td>
                    <td className="mono small truncate" title={agent.modelId ?? ''}>
                      {agent.modelId === null ? '—' : shortId(agent.modelId, 14)}
                    </td>
                    <td className="muted small nowrap" title={agent.updatedAt}>
                      {formatRelative(agent.updatedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </QueryBoundary>
      </Card>

      {wizardOpen ? (
        <CreateAgentWizard
          onClose={() => setWizardOpen(false)}
          onCreated={() => setWizardOpen(false)}
        />
      ) : null}
    </>
  );
}
