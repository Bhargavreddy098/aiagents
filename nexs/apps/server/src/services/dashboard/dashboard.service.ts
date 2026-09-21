import {
  DASHBOARD_FAILURE_WINDOW_DAYS,
  DASHBOARD_RECENT_ACTIVITY,
  DASHBOARD_RECENT_RECEIPTS,
  DASHBOARD_RECENT_RUNS,
  DASHBOARD_UPCOMING_SCHEDULES,
  type DashboardSummary,
} from '@nexs/shared';
import type { AgentRepository } from '../../repositories/agent.repo.js';
import type { ApprovalRepository } from '../../repositories/approval.repo.js';
import type { GoalRepository } from '../../repositories/goal.repo.js';
import type { MCPToolRepository, McpServerRepository } from '../../repositories/mcp.repo.js';
import type { ModelProviderRepository } from '../../repositories/model-provider.repo.js';
import type { NotificationRepository } from '../../repositories/notification.repo.js';
import type {
  ExecutionReceiptRepository,
  RunRepository,
  StepRepository,
  VerificationRepository,
} from '../../repositories/run.repo.js';
import type { ScheduleRepository } from '../../repositories/schedule.repo.js';
import type { TaskRepository } from '../../repositories/task.repo.js';
import type { WorkflowRepository } from '../../repositories/workflow.repo.js';
import type { Logger } from '../../logger.js';

/**
 * `GET /api/dashboard` — one composed snapshot of a tenant's live state.
 *
 * ## Why this is a service and not a controller with fourteen awaits in it
 *
 * The spec's requirement is **"zero hard-coded numbers"**, and the way that requirement
 * fails in practice is not someone writing `count: 7` — it is a number that *looks* computed
 * but was quietly defaulted, because the read behind it was awkward. Keeping every read in
 * one place means there is one place to check that each field traces to a query, and it
 * means the "there is no connector repository, so there is no connector count" decision is
 * made once, in a comment, rather than re-litigated per field.
 *
 * ## Why one `now` for the whole snapshot
 *
 * `now` is read once and threaded through the failure window and the pending-approval
 * deadline check. Calling `Date.now()` per aggregate would let the window's `since` and the
 * `days` label disagree by a few milliseconds — harmless in itself, but it also means two
 * fields in one response describe two different instants, and a client that compares them
 * is then comparing incomparable things. One instant per snapshot is the cheap version of
 * that guarantee.
 *
 * ## Why the reads are not wrapped in a transaction
 *
 * A dashboard is a read model over aggregates that are changing underneath it; the counts
 * are separate queries and a run can start between two of them. Wrapping them in a
 * serialisable transaction would either block writers or fail and force a retry, to make a
 * page that is stale a millisecond later anyway. `generatedAt` is what makes this honest:
 * the snapshot states the instant it describes, and a client can see it age.
 */

export interface DashboardServiceDeps {
  agents: AgentRepository;
  goals: GoalRepository;
  tasks: TaskRepository;
  workflows: WorkflowRepository;
  approvals: ApprovalRepository;
  notifications: NotificationRepository;
  runs: RunRepository;
  steps: StepRepository;
  receipts: ExecutionReceiptRepository;
  verifications: VerificationRepository;
  mcpServers: McpServerRepository;
  mcpTools: MCPToolRepository;
  providers: ModelProviderRepository;
  schedules: ScheduleRepository;
  logger: Logger;
  now?: () => number;
}

export class DashboardService {
  constructor(private readonly deps: DashboardServiceDeps) {}

  /**
   * The snapshot, for one tenant and one user.
   *
   * `userId` is a parameter rather than something read from the tenant because the unread
   * count is per person — see the field's comment in the shared contract. Everything else is
   * tenant-wide.
   */
  async get(tenantId: string, userId: string): Promise<DashboardSummary> {
    const now = this.deps.now?.() ?? Date.now();
    const nowDate = new Date(now);
    const since = new Date(now - DASHBOARD_FAILURE_WINDOW_DAYS * 86_400_000);

    // The counted tiles, the recent runs, and the recent receipts have no dependency on each
    // other, so they go out together. The two reads that *do* depend on another read's result
    // — activity (needs the runs) and the MCP tool counts (needs the servers) — follow below.
    const [
      agentsActive,
      agentsTotal,
      goalsActive,
      tasksRunning,
      workflowsActive,
      runsActive,
      approvalsPending,
      recentRuns,
      recentReceipts,
      providers,
      mcpServers,
      verifications,
      failureCount,
      unreadNotifications,
    ] = await Promise.all([
      this.deps.agents.count(tenantId, { status: 'active' }),
      this.deps.agents.count(tenantId),
      this.deps.goals.count(tenantId, { status: 'active' }),
      this.deps.tasks.count(tenantId, { status: 'running' }),
      this.deps.workflows.count(tenantId, { status: 'active' }),
      // The same predicate the scheduler uses for per-tenant concurrency, so this tile and
      // the scheduler cannot disagree about how much headroom exists.
      this.deps.runs.countActiveForTenant(tenantId),
      this.deps.approvals.countPending(tenantId, nowDate),
      this.deps.runs.list(tenantId, { limit: DASHBOARD_RECENT_RUNS }),
      this.deps.receipts.listRecentWithContext(tenantId, DASHBOARD_RECENT_RECEIPTS),
      // Enabled providers only. `provider.health` skips a disabled provider, so its `status`
      // column is a frozen reading from whenever it was last enabled — reporting that as
      // current health would be a number that looks live and is not, which is the exact
      // failure the "zero hard-coded numbers" rule exists to prevent.
      this.deps.providers.list(tenantId, { enabledOnly: true }),
      this.deps.mcpServers.list(tenantId),
      this.deps.verifications.summarize(tenantId),
      // Windowed on `createdAt`, the same bound `RunRepository.list` applies, so the number
      // and the filtered runs list a client clicks through to agree on their contents.
      this.deps.runs.count(tenantId, { status: 'failed', since }),
      this.deps.notifications.countUnread(tenantId, userId),
    ]);

    // Ownership proof for both leaf reads below: the ids come from a tenant-scoped read, never
    // from the caller. `Step` and `MCPTool` carry no `tenantId` of their own, so this is what
    // makes reading them safe — see `StepRepository.listRecentForRuns`.
    const [recentActivity, toolCounts, upcomingSchedules] = await Promise.all([
      this.deps.steps.listRecentForRuns(
        recentRuns.map((run) => run.id),
        DASHBOARD_RECENT_ACTIVITY,
      ),
      this.deps.mcpTools.countsByServer(mcpServers.map((server) => server.id)),
      this.deps.schedules.list(tenantId, {
        enabled: true,
        hasNextFire: true,
        limit: DASHBOARD_UPCOMING_SCHEDULES,
      }),
    ]);

    return {
      generatedAt: nowDate.toISOString(),
      counts: {
        agentsActive,
        agentsTotal,
        goalsActive,
        tasksRunning,
        workflowsActive,
        runsActive,
        approvalsPending,
      },
      recentRuns: recentRuns.map((run) => ({
        id: run.id,
        kind: run.kind,
        status: run.status,
        agentId: run.agentId,
        taskId: run.taskId,
        workflowId: run.workflowId,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
        error: run.error,
      })),
      recentActivity: recentActivity.map((step) => ({
        runId: step.runId,
        stepId: step.id,
        seq: step.seq,
        type: step.stepType,
        name: step.name,
        status: step.status,
        startedAt: step.startedAt?.toISOString() ?? null,
        completedAt: step.completedAt?.toISOString() ?? null,
      })),
      providerHealth: providers.map((provider) => ({
        providerId: provider.id,
        name: provider.name,
        type: provider.type,
        status: provider.status,
        lastHealthCheck: provider.lastHealthCheck?.toISOString() ?? null,
      })),
      /**
       * MCP servers, and only MCP servers.
       *
       * The spec's phrase is "connected services", and this system tracks exactly one kind of
       * external service: an MCP server. `Connector` / `ConnectorAccount` exist in the schema
       * but have no repository, no service and no route — nothing in the product reads them.
       * Reporting `connectors: 0` here would be a hard-coded number wearing a computed
       * number's clothes, which is precisely what this endpoint is not allowed to do. So the
       * array carries what exists, and the absence of connectors is visible as the absence of
       * a `kind`, which a client can render honestly.
       */
      connectedServices: mcpServers.map((server) => ({
        kind: 'mcp' as const,
        id: server.id,
        name: server.name,
        status: server.status,
        toolCount: toolCounts.get(server.id) ?? 0,
      })),
      upcomingSchedules: upcomingSchedules.map((schedule) => ({
        id: schedule.id,
        name: schedule.name,
        kind: schedule.kind,
        targetKind: schedule.targetKind,
        targetId: schedule.targetId,
        cron: schedule.cron,
        // Non-null by construction: the query filters on `nextFireAt: { not: null }`, so this
        // assertion is the filter's guarantee restated for the type checker. The `?? ''` arm
        // is unreachable and exists only so a future change to that filter cannot silently
        // emit a `null` into a field the contract declares non-null.
        nextFireAt: schedule.nextFireAt?.toISOString() ?? '',
        lastFiredAt: schedule.lastFiredAt?.toISOString() ?? null,
      })),
      failures: {
        days: DASHBOARD_FAILURE_WINDOW_DAYS,
        since: since.toISOString(),
        count: failureCount,
      },
      verifications,
      recentReceipts: recentReceipts.map(({ receipt, runId, toolName }) => ({
        id: receipt.id,
        toolCallId: receipt.toolCallId,
        runId,
        toolName,
        effect: receipt.effect,
        createdAt: receipt.createdAt.toISOString(),
      })),
      unreadNotifications,
    };
  }
}
