/**
 * §3.1 — the collapsible startup banner.
 *
 * Four sections, always in the spec's order, with the spec's default states: **Tools open**,
 * Skills / System Prompt / MCP Servers collapsed. The defaults are the spec's and are not
 * configurable, because the point of the ordering is that the one section an operator needs on
 * every session (what can this agent *do*) is the one that is already open.
 *
 * ## Every count and every row traces to a row
 *
 * The banner is the first thing on screen and therefore the easiest place in the product to
 * quietly invent a number. So each section is fed from a real query, and a section whose query is
 * loading or failed says so **in place of its count** rather than rendering a zero:
 *
 *  - `Tools (N active)` — `GET /api/tools`, filtered to the enabled rows.
 *  - `Skills (N installed)` — `GET /api/skills`. This prefix had no client at all until this
 *    change; the section is the first thing that reads it.
 *  - `System Prompt` — the active agent's own instructions, from `GET /api/agents/:id`. There is
 *    no workspace-level `SOUL.md` in this build (the spec's is a file under
 *    `~/.hermes/profiles/<name>/`), so the section says which agent's prompt it is showing.
 *  - `MCP Servers (N connected)` — `GET /api/mcp`, with each server's own status rather than a
 *    count of rows.
 *
 * ## Why the MCP section counts `connected` rather than all servers
 *
 * The spec's own label is "3 connected: github, postgres, filesystem". A count of rows would say
 * "3 servers" whether or not any of them were up, which is the difference between a banner and a
 * status report. The count is over the status the server reported, and a server that failed to
 * connect is listed with its failure rather than omitted.
 *
 * ## Why the chip queries are hoisted
 *
 * The header chips need an agent count and the Skills heading needs a skill count, and both are
 * also read by the sections below. They are called **once, at the top of the component**, and
 * passed down — a chip component that called `useSkills` itself would be a second subscription to
 * the same key (harmless) reached through a component boundary (not harmless: it makes the data
 * flow invisible and a future refactor can silently double a request).
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { AgentDetail, ToolSummary } from '@nexs/shared';
import { apiOf } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { useAgents } from '../../features/agents/queries';
import { useMcpServers } from '../../features/catalog/queries';
import { useSkills } from '../../features/skills/queries';
import { Dot } from '../ui';
import { sigilFor } from '../../lib/sigils';

/** Which sections are open. */
type SectionId = 'tools' | 'skills' | 'prompt' | 'mcp';

/**
 * The spec's default states. Tools open, the rest collapsed.
 *
 * Exported and `readonly` so a test can assert the defaults without duplicating them — the
 * defaults are a product decision the spec made, and a test that hard-coded its own copy would
 * pass while the component drifted.
 */
export const DEFAULT_OPEN_SECTIONS: readonly SectionId[] = ['tools'];

// The four sections are written out as `<Section>` elements rather than mapped from a table, and
// that is deliberate: each one's `note` is a *different shape* — a count, a "per agent" label, a
// count-of-a-count — so a table would need four render functions to say what four JSX blocks
// already say. Order and membership live in `SectionId` and `DEFAULT_OPEN_SECTIONS`, which is
// where the tests read them from; the labels are the one thing duplicated between here and the
// spec, and they are literal strings in both places.

interface SectionProps {
  id: SectionId;
  label: string;
  /** The parenthetical the spec puts after the label. */
  note: ReactNode;
  open: boolean;
  onToggle: (id: SectionId) => void;
  children: ReactNode;
}

function Section({ id, label, note, open, onToggle, children }: SectionProps): ReactNode {
  // One button wrapping the whole header row rather than a label plus a separate control: the
  // spec says the caret *or* the section is clickable, and one target is one focus stop.
  return (
    <div className="banner-section">
      <button
        type="button"
        className="banner-toggle"
        aria-expanded={open}
        aria-controls={`banner-${id}`}
        onClick={() => onToggle(id)}
      >
        <span className="banner-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="banner-section-label">{label}</span>
        <span className="banner-section-note">{note}</span>
      </button>
      {open ? (
        <div className="banner-section-body" id={`banner-${id}`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export interface StartupBannerProps {
  /** The workspace name, for the header chip. */
  workspace: string;
  version?: string;
  /**
   * The agent whose instructions the System Prompt section shows.
   *
   * Passed in rather than chosen here when the page knows which agent it is about — the chat
   * page's session has an `agentId`, and showing a *different* agent's prompt in that banner
   * would be actively misleading. `null` falls back to a picker.
   */
  agentId?: string | null;
}

export function StartupBanner({
  workspace,
  version = '0.1.0',
  agentId = null,
}: StartupBannerProps): ReactNode {
  const [open, setOpen] = useState<Set<SectionId>>(() => new Set(DEFAULT_OPEN_SECTIONS));

  // Hoisted: read once, used by both a heading and a body.
  const tools = useQuery({
    queryKey: [...queryKeys.tools.all, 'banner'] as const,
    queryFn: () => apiOf<ToolSummary[]>('/tools?limit=200', 'tools'),
    // The banner is on screen for the whole session and the registry changes only when an
    // operator changes it, so a long stale window is a saving rather than a staleness risk —
    // a `tool.*` frame invalidates this key anyway.
    staleTime: 60_000,
  });
  const skills = useSkills({ limit: 200 });
  const mcp = useMcpServers();
  const agents = useAgents({ limit: 200 });

  const toggle = (id: SectionId): void => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const enabledTools = (tools.data ?? []).filter((tool) => tool.status === 'enabled').length;
  const allTools = (tools.data ?? []).length;
  const connectedServers = (mcp.data ?? []).filter((server) => server.status === 'connected').length;
  const allServers = (mcp.data ?? []).length;

  return (
    <section className="banner" aria-label="Environment">
      <header className="banner-head">
        <span className="banner-title">
          <span className="banner-sigil" aria-hidden="true">
            ☤
          </span>
          NEXS AGENT
          <span className="muted" style={{ fontWeight: 400 }}>
            v{version}
          </span>
        </span>
        <span className="banner-meta">
          <span className="banner-chip" title="Workspace">
            {workspace}
          </span>
          <span className="banner-chip">
            {agents.isSuccess ? `${agents.data.length} agents` : 'agents —'}
          </span>
        </span>
      </header>

      <Section
        id="tools"
        label="Tools"
        note={<Count label="active" value={tools.isSuccess ? enabledTools : null} />}
        open={open.has('tools')}
        onToggle={toggle}
      >
        <ToolsBody query={tools} total={allTools} enabled={enabledTools} />
      </Section>

      <Section
        id="skills"
        label="Skills"
        note={<Count label="installed" value={skills.isSuccess ? skills.data.length : null} />}
        open={open.has('skills')}
        onToggle={toggle}
      >
        <SkillsBody query={skills} />
      </Section>

      <Section
        id="prompt"
        label="System Prompt"
        note={<span className="muted">per agent</span>}
        open={open.has('prompt')}
        onToggle={toggle}
      >
        <PromptBody agentId={agentId} />
      </Section>

      <Section
        id="mcp"
        label="MCP Servers"
        note={
          <Count
            label="connected"
            value={mcp.isSuccess ? connectedServers : null}
            of={mcp.isSuccess && allServers !== connectedServers ? allServers : null}
          />
        }
        open={open.has('mcp')}
        onToggle={toggle}
      >
        <McpBody query={mcp} />
      </Section>
    </section>
  );
}

/** `(N label)` or `(N of M label)`, or `(label —)` when the count is not known. */
function Count({
  label,
  value,
  of = null,
}: {
  label: string;
  value: number | null;
  of?: number | null;
}): ReactNode {
  if (value === null) return <>({label}&nbsp;—)</>;
  if (of === null) return <>({value} {label})</>;
  return <>({value} of {of} {label})</>;
}

/** A failed or pending query, rendered where its content would be. */
function QueryNote({
  error,
  pending,
  pendingLabel,
  errorLabel,
  onRetry,
}: {
  error: boolean;
  pending: boolean;
  pendingLabel: string;
  errorLabel: string;
  onRetry: () => void;
}): ReactNode {
  if (pending) return <div className="muted small">{pendingLabel}</div>;
  if (error) {
    return (
      <div className="muted small">
        {errorLabel}{' '}
        <button type="button" className="chip" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  return null;
}

function ToolsBody({
  query,
  total,
  enabled,
}: {
  query: ReturnType<typeof useQuery<ToolSummary[]>>;
  total: number;
  enabled: number;
}): ReactNode {
  if (query.isPending || query.isError) {
    return (
      <QueryNote
        pending={query.isPending}
        error={query.isError}
        pendingLabel="Loading the registry…"
        errorLabel="Could not read the tool registry."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (total === 0) return <div className="muted small">No tools are registered in this workspace.</div>;

  const rows = (query.data ?? []).filter((tool) => tool.status === 'enabled');
  return (
    <>
      <div className="banner-grid">
        {rows.map((tool) => (
          <div className="banner-item" key={tool.id} title={tool.description ?? tool.name}>
            <span className="banner-item-bullet" aria-hidden="true">
              •
            </span>
            <Link className="banner-item-name" to={`/tools/${tool.id}`}>
              {tool.name}
            </Link>
            <span className="banner-item-desc">{tool.description ?? '—'}</span>
          </div>
        ))}
      </div>
      {enabled < total ? (
        <p className="muted small" style={{ marginTop: 8 }}>
          {total - enabled} disabled {total - enabled === 1 ? 'tool is' : 'tools are'} not shown.{' '}
          <Link to="/tools">See all</Link>
        </p>
      ) : null}
    </>
  );
}

function SkillsBody({ query }: { query: ReturnType<typeof useSkills> }): ReactNode {
  if (query.isPending || query.isError) {
    return (
      <QueryNote
        pending={query.isPending}
        error={query.isError}
        pendingLabel="Loading skills…"
        errorLabel="Could not read skills."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.data.length === 0) {
    return (
      <div className="muted small">
        No skills yet. A skill is a versioned prompt template a run can be pointed at.{' '}
        <Link to="/skills">Create one</Link>
      </div>
    );
  }

  return (
    <div className="banner-grid">
      {query.data.map((skill) => (
        <div className="banner-item" key={skill.id} title={skill.description ?? skill.name}>
          <span className="banner-item-bullet" aria-hidden="true">
            •
          </span>
          <Link className="banner-item-name" to={`/skills/${skill.id}`}>
            /{skill.name}
          </Link>
          <span className="banner-item-desc">
            {skill.latestVersion === null
              ? // Null rather than 0: version numbers start at 1, and a `v0` on screen would
                // look like a version that exists.
                'no version published'
              : `v${skill.latestVersion}`}
            {skill.status === 'disabled' ? ' · disabled' : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

function PromptBody({ agentId }: { agentId: string | null }): ReactNode {
  const [picked, setPicked] = useState('');
  const agents = useAgents({ limit: 200 });
  const rows = agents.data ?? [];

  // Precedence: what the page told us, then what the operator picked, then the first row. Held
  // as a derived value rather than state so a list that reloads cannot leave this pointing at
  // an agent that no longer exists.
  const selected = agentId ?? (picked !== '' ? picked : (rows[0]?.id ?? ''));

  const agent = useQuery({
    queryKey: queryKeys.agents.one(selected),
    queryFn: () => apiOf<AgentDetail>(`/agents/${selected}`, 'agent'),
    enabled: selected !== '',
  });

  if (agents.isPending) return <div className="muted small">Loading agents…</div>;
  if (agents.isError) return <div className="muted small">Could not read agents.</div>;
  if (rows.length === 0) {
    return (
      <div className="muted small">
        No agents yet — a system prompt belongs to an agent in this build.{' '}
        <Link to="/agents">Create one</Link>
      </div>
    );
  }

  const sigil = sigilFor(`${agent.data?.name ?? ''} ${agent.data?.description ?? ''}`);

  return (
    <div className="stack-sm">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="small muted" htmlFor="banner-agent">
          Agent
        </label>
        <select
          id="banner-agent"
          className="input"
          style={{ maxWidth: 260 }}
          value={selected}
          // A page-supplied agent is shown but not overridable: the banner is reporting whose
          // prompt this is, and letting it be changed here would let it disagree with the
          // session it sits above.
          disabled={agentId !== null}
          onChange={(event) => setPicked(event.target.value)}
        >
          {rows.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
        <span className="muted small">
          {sigil.glyph} {sigil.role}
        </span>
      </div>

      {agent.isPending ? (
        <div className="muted small">Loading the prompt…</div>
      ) : agent.isError ? (
        <div className="muted small">Could not read this agent’s instructions.</div>
      ) : (
        <pre className="banner-pre">
          {agent.data.instructions !== null && agent.data.instructions !== ''
            ? agent.data.instructions
            : '// This agent has no instructions. It runs on the model default prompt.'}
        </pre>
      )}

      <p className="muted small">
        Per-agent instructions. This build has no workspace-level <code className="mono">SOUL.md</code>;
        the durable persona is the agent row.
      </p>
    </div>
  );
}

function McpBody({ query }: { query: ReturnType<typeof useMcpServers> }): ReactNode {
  if (query.isPending || query.isError) {
    return (
      <QueryNote
        pending={query.isPending}
        error={query.isError}
        pendingLabel="Loading MCP servers…"
        errorLabel="Could not read MCP servers."
        onRetry={() => void query.refetch()}
      />
    );
  }
  if (query.data.length === 0) {
    return (
      <div className="muted small">
        No MCP servers configured. <Link to="/mcp">Add one</Link>
      </div>
    );
  }

  return (
    <div className="banner-grid">
      {query.data.map((server) => (
        <div className="banner-item" key={server.id} title={server.status}>
          <Dot
            tone={
              server.status === 'connected'
                ? 'ok'
                : server.status === 'connecting'
                  ? 'waiting'
                  : server.status === 'error'
                    ? 'failed'
                    : 'neutral'
            }
          />
          <Link className="banner-item-name" to={`/mcp/${server.id}`}>
            {server.name}
          </Link>
          <span className="banner-item-desc">{server.status}</span>
        </div>
      ))}
    </div>
  );
}
