import {
  ApiError,
  canTransitionAgent,
  type AgentDetail,
  type AgentStatus,
  type AgentSummary,
  type CreateAgentInput,
  type ListAgentsQuery,
  type UpdateAgentInput,
} from '@nexs/shared';
import type { AgentRepository, AgentWriteResult } from '../../repositories/agent.repo.js';
import { AgentVersionConflict } from '../../repositories/agent.repo.js';
import type { GoalRepository } from '../../repositories/goal.repo.js';
import type { ModelRepository } from '../../repositories/model.repo.js';
import type { RunRepository } from '../../repositories/run.repo.js';
import type { TaskRepository } from '../../repositories/task.repo.js';
import type { Logger } from '../../logger.js';
import { toAgentDetail, toAgentSummary } from '../../mappers/control.js';
import { BUILTIN_SOURCE, type BuiltinToolService } from '../tools/builtin-tools.service.js';
import { MEMORY_TOOL_NAMES } from '../tools/native-tools.js';

/**
 * Agents: configuration, versioning, and the lifecycle an operator drives.
 *
 * The service owns two rules the repository deliberately does not:
 *
 *  1. **Legal transitions.** `canTransitionAgent` is the state machine; the repository
 *     writes whatever status it is told. Keeping the check here means the state machine is
 *     consulted at the one place an operator's request arrives, rather than being
 *     re-implemented at each call site.
 *  2. **Activation preconditions.** An agent cannot be activated without a model. A run
 *     with no model cannot plan, so activating one would produce a run that fails on its
 *     first step — and the operator would learn about the misconfiguration from a failed
 *     run rather than from the button they just pressed.
 */

export interface AgentServiceDeps {
  agents: AgentRepository;
  models: ModelRepository;
  goals: GoalRepository;
  tasks: TaskRepository;
  runs: RunRepository;
  /**
   * Provisions the built-in tool rows an agent references, so `memoryEnabled` can mean something.
   *
   * Required rather than optional: an optional dependency that silently disables a spec
   * requirement is the failure mode this codebase keeps writing comments about. If the memory
   * tools are not grantable, the wiring should not compile.
   */
  builtins: BuiltinToolService;
  logger: Logger;
}

/**
 * Defaults applied when a caller does not supply them.
 *
 * They live here rather than in the zod schema, and the difference matters: a schema
 * default is a value the caller never sent being written to a row, which makes "set this
 * to X" indistinguishable from "said nothing" further down. Applying them at the point of
 * creation keeps the boundary honest about what actually arrived.
 *
 * `risk-based` rather than `none`: an agent created and left unconfigured should ask before
 * doing something irreversible. `none` is available, but it should be a decision.
 */
export const DEFAULT_APPROVAL_POLICY = { mode: 'risk-based' } as const;

/** Mirrors the schema's own defaults, so a row created here matches one created by SQL. */
export const DEFAULT_EXECUTION_LIMITS = {
  maxSteps: 50,
  maxDurationMs: 600_000,
  maxToolCalls: 100,
  maxContextTokens: 100_000,
} as const;

export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  async create(tenantId: string, input: CreateAgentInput): Promise<AgentDetail> {
    // Resolved once and used for both the row and the tool set, so the flag an operator reads
    // back is the same one that decided which tools were granted.
    const memoryEnabled = input.memoryEnabled ?? true;

    const created = await this.deps.agents.create({
      tenantId,
      name: input.name,
      description: input.description ?? null,
      instructions: input.instructions ?? '',
      modelId: input.modelId ?? null,
      fallbackModelId: input.fallbackModelId ?? null,
      toolIds: await this.toolIdsFor(tenantId, memoryEnabled, input.toolIds ?? []),
      mcpServerIds: input.mcpServerIds ?? [],
      connectorAccountIds: input.connectorAccountIds ?? [],
      memoryEnabled,
      browserAccess: input.browserAccess ?? false,
      sandboxAccess: input.sandboxAccess ?? false,
      approvalPolicy: (input.approvalPolicy ?? DEFAULT_APPROVAL_POLICY) as never,
      executionLimits: (input.executionLimits ?? DEFAULT_EXECUTION_LIMITS) as never,
      // Always `draft`. An agent that could be created `active` would be one that starts
      // running before anyone has read its instructions.
      status: 'draft',
    });

    this.deps.logger.info(
      { tenantId, agentId: created.agent.id, version: 1 },
      'agent created',
    );

    return this.detail(tenantId, created.agent.id);
  }

  async list(tenantId: string, query: ListAgentsQuery = {}): Promise<AgentSummary[]> {
    const agents = await this.deps.agents.list(tenantId, {
      ...(query.status === undefined || query.status === 'all' ? {} : { status: query.status }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return agents.map(toAgentSummary);
  }

  async get(tenantId: string, id: string): Promise<AgentDetail> {
    return this.detail(tenantId, id);
  }

  /**
   * Apply a partial update.
   *
   * An `archived` agent is read-only. Editing one would mint a new version of an agent that
   * can never run — and the version history is what an audit reads, so adding versions to a
   * retired agent is noise at best.
   */
  async update(tenantId: string, id: string, input: UpdateAgentInput): Promise<AgentDetail> {
    const current = await this.requireAgent(tenantId, id);

    if (current.status === 'archived') {
      throw new ApiError('CONFLICT', 'An archived agent cannot be edited', { status: 'archived' });
    }

    // The memory setting and the tool set are decided together, because `memoryEnabled` is what
    // decides whether the memory tools belong in the allowlist. `??` on the flag keeps "not
    // supplied" meaning "leave it as it is" rather than "turn it off" — the same distinction the
    // patch below exists to preserve.
    const memoryEnabled = input.memoryEnabled ?? current.memoryEnabled;
    const toolIds = await this.toolIdsFor(tenantId, memoryEnabled, input.toolIds ?? current.toolIds);

    // `undefined` means "not supplied" and must not reach the repository, which would treat
    // it as a value to write. Building the patch explicitly is what keeps the two apart.
    const patch = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.fallbackModelId === undefined ? {} : { fallbackModelId: input.fallbackModelId }),
      // Written only when the set actually changed. Including it unconditionally would make every
      // edit look like a tool change, and a config change is what publishes a version.
      ...(sameIds(toolIds, current.toolIds) ? {} : { toolIds }),
      ...(input.mcpServerIds === undefined ? {} : { mcpServerIds: input.mcpServerIds }),
      ...(input.connectorAccountIds === undefined
        ? {}
        : { connectorAccountIds: input.connectorAccountIds }),
      ...(input.memoryEnabled === undefined ? {} : { memoryEnabled: input.memoryEnabled }),
      ...(input.browserAccess === undefined ? {} : { browserAccess: input.browserAccess }),
      ...(input.sandboxAccess === undefined ? {} : { sandboxAccess: input.sandboxAccess }),
      ...(input.approvalPolicy === undefined
        ? {}
        : { approvalPolicy: input.approvalPolicy as never }),
      ...(input.executionLimits === undefined
        ? {}
        : { executionLimits: input.executionLimits as never }),
    };

    const result = await this.applyOrConflict(tenantId, id, patch);

    if (result.version !== null) {
      this.deps.logger.info(
        { tenantId, agentId: id, version: result.version.version },
        'agent config changed, version published',
      );
    }

    return this.detail(tenantId, id);
  }

  /**
   * Move an agent to a new status.
   *
   * The preconditions differ per target, and the order they are checked in is the order
   * that produces the most useful message: the transition is checked first, so a caller
   * asking to activate an already-active agent is told that, rather than being told about a
   * missing model they were not trying to change.
   */
  async setStatus(tenantId: string, id: string, target: AgentStatus): Promise<AgentDetail> {
    const current = await this.requireAgent(tenantId, id);
    const from = current.status as AgentStatus;

    if (from === target) {
      throw new ApiError('CONFLICT', `The agent is already ${target}`, { status: from });
    }
    if (!canTransitionAgent(from, target)) {
      throw new ApiError('CONFLICT', `An agent cannot go from ${from} to ${target}`, {
        from,
        to: target,
      });
    }

    if (target === 'active') await this.assertActivatable(tenantId, current.modelId);

    const updated = await this.deps.agents.setStatus(
      tenantId,
      id,
      target,
      // Archiving is the only status that stamps a time, and clearing it on any other
      // transition would let an archived-then-reactivated agent lose the record of when it
      // was retired.
      target === 'archived' ? { archivedAt: new Date() } : {},
    );
    if (updated === null) throw notFound(id);

    this.deps.logger.info({ tenantId, agentId: id, from, to: target }, 'agent status changed');
    return this.detail(tenantId, id);
  }

  /**
   * Duplicate an agent.
   *
   * A new row at version 1, not a new version of the original — see `AgentRepository.duplicate`
   * for why that distinction is the point. The name is suffixed rather than required, because
   * making the caller invent one turns a one-click action into a form.
   */
  async duplicate(tenantId: string, id: string, name?: string): Promise<AgentDetail> {
    const source = await this.requireAgent(tenantId, id);
    const copyName = name ?? `${source.name} (copy)`;

    const copy = await this.deps.agents.duplicate(tenantId, id, copyName);
    if (copy === null) throw notFound(id);

    this.deps.logger.info(
      { tenantId, sourceId: id, agentId: copy.agent.id },
      'agent duplicated',
    );
    return this.detail(tenantId, copy.agent.id);
  }

  /** Soft delete. Archiving is terminal, so this is the end of the agent's lifecycle. */
  async archive(tenantId: string, id: string): Promise<AgentDetail> {
    return this.setStatus(tenantId, id, 'archived');
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * The composed detail view.
   *
   * The counts are three real `count()` queries, not derived from a loaded relation. A
   * count computed from an included array would be bounded by whatever `take` that include
   * used, and would report a number that is not the number of rows.
   */
  private async detail(tenantId: string, id: string): Promise<AgentDetail> {
    const agent = await this.requireAgent(tenantId, id);
    const versions = await this.deps.agents.listVersions(tenantId, id);
    const [goals, tasks, runs] = await Promise.all([
      this.deps.goals.count(tenantId, { agentId: id }),
      this.deps.tasks.count(tenantId, { agentId: id }),
      this.deps.runs.count(tenantId, { agentId: id }),
    ]);

    return toAgentDetail(agent, versions, { goals, tasks, runs });
  }

  /**
   * The tool allowlist an agent should carry, given its memory setting.
   *
   * `memoryEnabled` decides, and it decides in **both** directions: `true` grants the memory tools,
   * `false` withdraws them. That is what makes the flag a capability rather than a hint — a switch
   * that left the tools in place would be one an operator could flip with nothing happening, which
   * is worse than no switch at all. Ids the caller supplied are otherwise kept exactly as given.
   *
   * The built-in rows are provisioned first, because a tool id that names no row grants nothing:
   * the planner builds its list from the rows and filters by the allowlist, so a dangling id is
   * dropped without a word and the agent quietly loses the tool it was configured with.
   */
  private async toolIdsFor(
    tenantId: string,
    memoryEnabled: boolean,
    requested: readonly string[],
  ): Promise<string[]> {
    const rows = await this.deps.builtins.ensure(tenantId);
    const memoryIds = rows
      .filter((row) => row.source === BUILTIN_SOURCE && isMemoryTool(row.name))
      .map((row) => row.id);

    if (!memoryEnabled) {
      return [...new Set(requested.filter((id) => !memoryIds.includes(id)))];
    }
    return [...new Set([...requested, ...memoryIds])];
  }

  private async requireAgent(tenantId: string, id: string) {
    const agent = await this.deps.agents.findById(tenantId, id);
    if (agent === null) throw notFound(id);
    return agent;
  }

  /**
   * An agent needs a model that this tenant can actually use.
   *
   * Checked at activation rather than at creation, because an agent is assembled over
   * several edits and only has to be complete when it is asked to run. Checked *here* rather
   * than at run start, because the operator is present now and can fix it.
   */
  private async assertActivatable(tenantId: string, modelId: string | null): Promise<void> {
    if (modelId === null) {
      throw new ApiError('VALIDATION_ERROR', 'An agent needs a model before it can be activated', {
        field: 'modelId',
      });
    }

    const model = await this.deps.models.findById(tenantId, modelId);
    if (model === null) {
      throw new ApiError('VALIDATION_ERROR', 'The agent’s model does not exist', { modelId });
    }
    if (!model.enabled) {
      throw new ApiError('VALIDATION_ERROR', 'The agent’s model is disabled', { modelId });
    }
    if (model.status !== 'available') {
      throw new ApiError('VALIDATION_ERROR', 'The agent’s model is not available', {
        modelId,
        status: model.status,
      });
    }
  }

  /**
   * Run an update, turning the version race into a retryable conflict.
   *
   * `AgentVersionConflict` is a domain error from the repository; an operator gets a 409
   * and can retry, rather than a 500 that reads as a bug in this system.
   */
  private async applyOrConflict(
    tenantId: string,
    id: string,
    patch: Parameters<AgentRepository['applyUpdate']>[2],
  ): Promise<AgentWriteResult> {
    try {
      const result = await this.deps.agents.applyUpdate(tenantId, id, patch);
      if (result === null) throw notFound(id);
      return result;
    } catch (err) {
      if (err instanceof AgentVersionConflict) {
        throw new ApiError('CONFLICT', 'The agent was modified by someone else; retry', {
          expectedVersion: err.expectedVersion,
        });
      }
      throw err;
    }
  }
}

function notFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 'The agent does not exist', { agentId: id });
}

/**
 * Set equality, order-insensitive.
 *
 * An agent's `toolIds` is an allowlist — a *set* — so a reordering is not a configuration change
 * and must not publish a version. Comparing arrays element-wise would do exactly that the first
 * time the memory ids were appended to a list they were already in.
 */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((id) => set.has(id));
}

/** Whether a built-in tool name is one of the memory tools. */
function isMemoryTool(name: string): boolean {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}
