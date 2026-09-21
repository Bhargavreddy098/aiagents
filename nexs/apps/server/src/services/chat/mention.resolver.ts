import {
  MENTION_LIMIT,
  type MentionItem,
  type MentionKind,
  type MentionList,
} from '@nexs/shared';
// The persisted rows, because that is what the repositories return and what carries `Date`
// fields. The shared DTOs (`RunSummary` and friends) are the *wire* shapes, built by mappers —
// importing one here would mean inventing a mapper's work inside a picker query.
import type { Agent, Run, Workflow } from '@prisma/client';
import type { Logger } from '../../logger.js';
import type { AgentRepository } from '../../repositories/agent.repo.js';
import type { GoalRepository } from '../../repositories/goal.repo.js';
import type { McpServerRepository, ToolRepository } from '../../repositories/mcp.repo.js';
import type { ModelRepository } from '../../repositories/model.repo.js';
import type { RunRepository } from '../../repositories/run.repo.js';
import type { WorkflowRepository } from '../../repositories/workflow.repo.js';

/**
 * `@` autocomplete (§3.9).
 *
 * ## Why the matching happens here rather than in the database
 *
 * Every source is a tenant-scoped `list()` that already exists, and none of them takes a
 * search term. Pushing a `contains` filter into each repository would mean nine new query
 * shapes, nine new indexes, and nine chances for one of them to forget `tenantId` — to save
 * filtering a page that is bounded by `CANDIDATE_LIMIT` anyway. So each source reads a bounded
 * page through its existing tenant-scoped method and the substring match happens in memory.
 *
 * The consequence, stated plainly: an `@` query only searches the newest `CANDIDATE_LIMIT`
 * rows of each kind. For the sizes this autocomplete exists for — picking one of your agents,
 * one of your models — that is the whole set. A tenant with 10,000 runs would not find run
 * #9,000 by typing its name, which is the right trade for a picker that must answer within a
 * keystroke.
 *
 * ## Why every kind is queried even when the caller names one
 *
 * `kind` narrows *after* the fetch, not before. The alternative — a `switch` per kind — would
 * be nine code paths where eight of them are unreachable for any given request, and one of
 * them is the one that forgets the tenant scope. One path that always reads tenant-scoped
 * pages is easier to be sure about than nine that conditionally do.
 */

/** How many rows of each kind are read before matching. */
const CANDIDATE_LIMIT = 200;

export interface MentionResolverDeps {
  agents: AgentRepository;
  models: ModelRepository;
  tools: ToolRepository;
  mcpServers: McpServerRepository;
  goals: GoalRepository;
  workflows: WorkflowRepository;
  runs: RunRepository;
  logger: Logger;
}

export class MentionResolver {
  constructor(private readonly deps: MentionResolverDeps) {}

  /**
   * Resolve `@`-autocomplete entries from live registry data.
   *
   * Never throws for a source that fails: an autocomplete that 500s because one table is
   * momentarily unavailable is worse than one that shows eight of nine groups, and the user
   * cannot tell the difference between "no goals" and "goals could not be read" at a keystroke.
   * A failed source is logged and contributes nothing.
   */
  async resolve(
    tenantId: string,
    query: { q?: string; kind?: MentionKind } = {},
  ): Promise<MentionList> {
    const groups = await Promise.all([
      this.agents(tenantId),
      this.models(tenantId),
      this.tools(tenantId),
      this.mcp(tenantId),
      this.goals(tenantId),
      this.workflows(tenantId),
      this.runs(tenantId),
    ]);

    const needle = (query.q ?? '').trim().toLowerCase();
    const wanted = query.kind;

    const items: MentionItem[] = [];
    for (const group of groups.flat()) {
      if (wanted !== undefined && group.kind !== wanted) continue;
      if (needle.length > 0 && !matches(group, needle)) continue;
      items.push(group);
      if (items.length >= MENTION_LIMIT) break;
    }

    return { items };
  }

  private async agents(tenantId: string): Promise<MentionItem[]> {
    const rows = await this.read('agent', () =>
      this.deps.agents.list(tenantId, { excludeArchived: true, limit: CANDIDATE_LIMIT }),
    );
    return rows.map((row: Agent) => ({
      kind: 'agent' as const,
      id: row.id,
      name: row.name,
      ...(row.description === null ? {} : { subtitle: row.description }),
    }));
  }

  private async models(tenantId: string): Promise<MentionItem[]> {
    const rows = await this.read('model', () =>
      this.deps.models.list(tenantId, { enabledOnly: true }),
    );
    return rows.map((row) => ({
      kind: 'model' as const,
      id: row.id,
      name: row.name,
      // The provider's display name, not the API id: this line is for a human choosing a
      // model, and "OpenAI · gpt-4o-2024-08-06" says more than two opaque identifiers.
      subtitle: `${row.provider.name} · ${row.externalModelId}`,
    }));
  }

  private async tools(tenantId: string): Promise<MentionItem[]> {
    const rows = await this.read('tool', () => this.deps.tools.list(tenantId));
    return rows
      .filter((row) => row.status === 'enabled')
      .map((row) => ({
        kind: 'tool' as const,
        id: row.id,
        name: row.name,
        ...(row.description === null ? {} : { subtitle: row.description }),
      }));
  }

  private async mcp(tenantId: string): Promise<MentionItem[]> {
    const rows = await this.read('mcp', () => this.deps.mcpServers.list(tenantId));
    return rows.map((row) => ({
      kind: 'mcp' as const,
      id: row.id,
      name: row.name,
      subtitle: row.status,
    }));
  }

  private async goals(tenantId: string): Promise<MentionItem[]> {
    const rows = await this.read('goal', () =>
      this.deps.goals.list(tenantId, { limit: CANDIDATE_LIMIT }),
    );
    return rows.map((row) => ({
      kind: 'goal' as const,
      id: row.id,
      name: row.title,
      subtitle: row.status,
    }));
  }

  private async workflows(tenantId: string): Promise<MentionItem[]> {
    const rows = await this.read('workflow', () =>
      this.deps.workflows.list(tenantId, { limit: CANDIDATE_LIMIT }),
    );
    return rows.map((row: Workflow) => ({
      kind: 'workflow' as const,
      id: row.id,
      name: row.name,
      subtitle: row.status,
    }));
  }

  private async runs(tenantId: string): Promise<MentionItem[]> {
    const rows = await this.read('run', () =>
      this.deps.runs.list(tenantId, { limit: CANDIDATE_LIMIT }),
    );
    return rows.map((row: Run) => ({
      kind: 'run' as const,
      id: row.id,
      // A run has no name of its own, so it is shown as what it is: a kind of work, dated.
      // A run id is a cuid and is useless in a picker, which is why the kind leads.
      name: `${row.kind} run · ${row.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`,
      subtitle: row.status,
    }));
  }

  /**
   * Read one source, degrading to empty on failure.
   *
   * The `catch` is deliberately broad. A source can fail for reasons this class cannot fix —
   * a table not yet migrated, a transient connection error — and in every one of them the
   * correct behaviour is the same: show the other groups and say nothing to the user.
   */
  private async read<T>(kind: string, load: () => Promise<T[]>): Promise<T[]> {
    try {
      return await load();
    } catch (err) {
      this.deps.logger.warn({ err, kind }, 'mention source unavailable; omitting it');
      return [];
    }
  }
}

/** Case-insensitive substring match against the entry's name, then its subtitle. */
function matches(item: MentionItem, needle: string): boolean {
  if (item.name.toLowerCase().includes(needle)) return true;
  return (item.subtitle ?? '').toLowerCase().includes(needle);
}
