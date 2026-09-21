import pino from 'pino';
import type { SseFrame } from '@nexs/shared';
import type { Model, PrismaClient, Run, Tool, User } from '@prisma/client';
import { createFakeDb, type FakeDb } from './fake-db.js';
import {
  TEST_TENANT,
  createEngineHarness,
  ScriptedGateway,
  type EngineHarness,
  type SeedRunInput,
  type SeedWaitingRunInput,
  type SeededWaitingRun,
} from './engine-harness.js';
import type { FetchCall, FetchHandler } from './gateway-harness.js';
import { AgentRepository } from '../../src/repositories/agent.repo.js';
import { ActionRepository, ApprovalRepository } from '../../src/repositories/approval.repo.js';
import { ExecAllowlistRepository } from '../../src/repositories/exec-allowlist.repo.js';
import { GoalRepository } from '../../src/repositories/goal.repo.js';
import { NotificationRepository } from '../../src/repositories/notification.repo.js';
import { TaskRepository } from '../../src/repositories/task.repo.js';
import { ScheduleRepository } from '../../src/repositories/schedule.repo.js';
import { EventRepository } from '../../src/repositories/event.repo.js';
import { UserRepository } from '../../src/repositories/user.repo.js';
import { WorkflowRepository } from '../../src/repositories/workflow.repo.js';
import {
  ExecutionReceiptRepository,
  RunRepository,
  StepRepository,
  ToolCallRepository,
  VerificationRepository,
} from '../../src/repositories/run.repo.js';
import { ModelUsageRepository } from '../../src/repositories/model-usage.repo.js';
import { ModelRepository } from '../../src/repositories/model.repo.js';
import { ModelProviderRepository } from '../../src/repositories/model-provider.repo.js';
import { MemoryRepository } from '../../src/repositories/memory.repo.js';
import { MCPToolRepository, McpServerRepository, ToolRepository } from '../../src/repositories/mcp.repo.js';
import { MemoryService } from '../../src/services/memory/memory.service.js';
import { AgentService } from '../../src/services/agents/agent.service.js';
import { BuiltinToolService } from '../../src/services/tools/builtin-tools.service.js';
import { ApprovalService, type OwnerDirectory } from '../../src/services/approvals/approval.service.js';
import { GoalService } from '../../src/services/goals/goal.service.js';
import { NotificationService } from '../../src/services/notifications/notification.service.js';
import { TaskService } from '../../src/services/tasks/task.service.js';
import { WorkflowService } from '../../src/services/workflows/workflow.service.js';
import { RunService } from '../../src/services/runs/run.service.js';
import { ScheduleService } from '../../src/services/schedules/schedule.service.js';
import { EventService } from '../../src/services/events/event.service.js';
import { OccurrenceStarter } from '../../src/services/automation/occurrence.js';
import { RecoveryService } from '../../src/services/maintenance/recovery.service.js';
import { DashboardService } from '../../src/services/dashboard/dashboard.service.js';
import { RecordingScheduleQueue } from '../../src/services/queue/schedule-queue.js';
import { createAgentContextResolver } from '../../src/services/engine/agent-context.js';
import { RecordingRunQueue, type RunQueueJob } from '../../src/services/queue/run-queue.js';
import type { ExecutionEngine, EngineEmitter, RunExecutionOutcome } from '../../src/services/engine/execution-engine.js';
import type { Logger } from '../../src/logger.js';

/**
 * The Phase 6 control plane over the in-memory database.
 *
 * ## Why this composes with `engine-harness` instead of duplicating it
 *
 * The engine harness already wires the real engine, planner, verifier and invoker over a
 * fake DB. Phase 6 needs the same engine — because the acceptance criterion for gap #15 is
 * that a run **executes** the configuration it pinned, which is a statement about the
 * engine, not about a repository. So this harness builds the control-plane repositories and
 * services first and then hands the *same* fake DB to `createEngineHarness`, along with the
 * agent-aware context resolver and the `AgentPinPort`.
 *
 * Two harnesses each with their own DB would be worse than useless here: an agent created
 * through `AgentService` would be invisible to the engine, and the pinning test would pass
 * or fail for reasons unrelated to pinning.
 *
 * ## What is real and what is stubbed
 *
 * Real: every repository, every service, the state machines, the versioning, the engine.
 * Stubbed: the model gateway (scripted), the queue (recording, so "exactly one enqueue" is
 * an assertion), and everything that leaves the process. The same split as the engine
 * harness, for the same reason — the behaviour under test lives in the real components.
 */

export const CONTROL_TENANT = TEST_TENANT;
export const OTHER_TENANT = 'tnt_other';

export interface SeedModelInput {
  tenantId?: string;
  name?: string;
  externalModelId?: string;
  enabled?: boolean;
  status?: string;
}

export interface SeedToolInput {
  tenantId?: string;
  name: string;
  type?: 'native' | 'mcp' | 'browser' | 'sandbox' | 'connector';
  status?: 'enabled' | 'disabled' | 'error';
  capabilities?: string[];
}

export interface ControlHarness {
  fake: FakeDb;
  db: PrismaClient;
  logger: Logger;

  // repositories
  agents: AgentRepository;
  goals: GoalRepository;
  tasks: TaskRepository;
  workflows: WorkflowRepository;
  actions: ActionRepository;
  approvals: ApprovalRepository;
  notifications: NotificationRepository;
  runs: RunRepository;
  steps: StepRepository;
  toolCalls: ToolCallRepository;
  receipts: ExecutionReceiptRepository;
  verifications: VerificationRepository;
  modelUsage: ModelUsageRepository;
  models: ModelRepository;
  tools: ToolRepository;
  /** Standing exec permissions (§4.4) — what `allow_always` writes. */
  execRules: ExecAllowlistRepository;

  // services
  agentService: AgentService;
  goalService: GoalService;
  taskService: TaskService;
  workflowService: WorkflowService;
  runService: RunService;
  approvalService: ApprovalService;
  notificationService: NotificationService;

  /**
   * The command owner (§5.6) — the same port the approval service consults.
   *
   * A workspace starts with **no** owner, so a test that never calls `claimOwner` exercises
   * the refusal path, which is the one most likely to break silently.
   */
  owner: OwnerDirectory;
  /** Claim ownership for a tenant. The map is the state; this is the only verb that writes it. */
  claimOwner(tenantId: string, userId: string): void;

  // engine + queue
  engine: ExecutionEngine;
  gateway: ScriptedGateway;
  queue: RecordingRunQueue;
  /**
   * Phase 11: the repositories, so a test can seed a schedule or subscription directly.
   *
   * Exposed rather than reached through the services because seeding a *target* (a schedule
   * for a recurring task to name, a subscription for an event task to name) has to happen
   * before the thing under test exists.
   */
  schedules: ScheduleRepository;
  events: EventRepository;
  scheduleService: ScheduleService;
  eventService: EventService;
  occurrenceStarter: OccurrenceStarter;
  recoveryService: RecoveryService;
  /**
   * Phase 12: the composed dashboard snapshot, over this harness's own rows.
   *
   * Exposed as the service rather than as the aggregates, so a dashboard test asserts on the
   * same composition the route serves — a test that re-counted the rows itself would agree
   * with a service that had stopped counting them.
   */
  dashboardService: DashboardService;
  /**
   * The repositories behind "connected services" and "provider health".
   *
   * Exposed because seeding them is the only way to reach those two fields: neither MCP
   * servers nor model providers are created by any service this harness builds.
   */
  mcpServers: McpServerRepository;
  mcpTools: MCPToolRepository;
  providers: ModelProviderRepository;
  /** Every schedule registration and removal the service asked the transport for. */
  scheduleQueue: RecordingScheduleQueue;
  /**
   * The outbound-HTTP stub and the run driver, forwarded from the engine harness.
   *
   * Forwarded rather than re-declared because there is exactly one engine and exactly one
   * `fetch` stub behind it. A second copy on this harness would let a test configure one
   * and assert against the other.
   */
  onHttp(handler: FetchHandler): void;
  seedRun(input?: SeedRunInput): Promise<Run>;
  /**
   * A run already parked for approval, with its plan, step row and approval row written.
   *
   * The reason this is forwarded rather than duplicated: the parked state has to be written
   * against the *same* database the service reads, and there is exactly one here.
   */
  seedWaitingRun(input: SeedWaitingRunInput): Promise<SeededWaitingRun>;
  run(runId: string): Promise<RunExecutionOutcome>;
  /** Every outbound HTTP request a native tool made, forwarded from the engine harness. */
  readonly httpCalls: FetchCall[];
  /** Every `run.execute` handoff, in order. */
  enqueued: RunQueueJob[];
  /** Every SSE frame the engine and the services emitted, in order. */
  frames: SseFrame[];
  /** Every `approval.expire` job requested, in order — the delayed expiry mechanism. */
  readonly expiryJobs: Array<{ approvalId: string; expiresAt: Date }>;

  // seeding
  seedModel(input?: SeedModelInput): Promise<Model>;
  seedTool(input: SeedToolInput): Promise<Tool>;
  /**
   * A real user row, for the notification fan-out.
   *
   * `ApprovalService` notifies every member of the tenant, and
   * `NotificationService.create` refuses a recipient that does not exist — so a test that
   * wants to see an approval notification has to have a user to send it to. There is no
   * default: seeding one silently would make every noise-free assertion in this file
   * depend on hidden state.
   */
  seedUser(input?: { tenantId?: string; email?: string; name?: string }): Promise<User>;
  /** A `goal_criteria` verification that has passed — the only thing that completes a goal. */
  seedPassingVerification(input?: {
    tenantId?: string;
    goalId?: string | null;
    runId?: string | null;
  }): Promise<string>;
  /** A `goal_criteria` verification that has failed. */
  seedFailedVerification(input?: { tenantId?: string; goalId?: string | null }): Promise<string>;

  cleanup(): Promise<void>;
}

export async function createControlHarness(): Promise<ControlHarness> {
  const fake = createFakeDb();
  const db = fake.client;
  const logger = pino({ level: 'silent' });

  // ── repositories ────────────────────────────────────────────────────────────
  const agents = new AgentRepository(db);
  const goals = new GoalRepository(db);
  const tasks = new TaskRepository(db);
  const workflows = new WorkflowRepository(db);
  const actions = new ActionRepository(db);
  const approvals = new ApprovalRepository(db);
  const execRules = new ExecAllowlistRepository(db);
  // The command owner, per tenant. Empty until a test claims one — see the `owner` port below.
  const ownerByTenant = new Map<string, string>();
  /**
   * The owner port (§5.6), backed by the map above.
   *
   * Held as one named value rather than written inline twice: the approval service and the
   * harness's own `owner` field must be the *same* object, or a test could claim ownership
   * through one and find the service consulting the other.
   */
  const ownerDirectory: OwnerDirectory = {
    findOwner: async (tenantId) => ownerByTenant.get(tenantId) ?? null,
  };
  const notifications = new NotificationRepository(db);
  const runs = new RunRepository(db);
  const steps = new StepRepository(db);
  const toolCalls = new ToolCallRepository(db);
  const receipts = new ExecutionReceiptRepository(db);
  const verifications = new VerificationRepository(db);
  const modelUsage = new ModelUsageRepository(db);
  const models = new ModelRepository(db);
  const tools = new ToolRepository(db);

  // ── frames ──────────────────────────────────────────────────────────────────
  const frames: SseFrame[] = [];
  /**
   * Records every frame the services emit.
   *
   * The tenant argument is dropped rather than recorded. `SseFrame` has no tenant field, and
   * every assertion in this suite asks *what* was emitted rather than to whom — routing is the
   * hub's and the bus's business, and both have their own tests. Recording it here would mean
   * inventing a shape for the frame that the wire format does not have.
   */
  const emit: EngineEmitter = (_tenantId, frame) => {
    frames.push(frame);
  };

  /**
   * Every `approval.expire` job the service asked for, in order.
   *
   * A recorder rather than a real queue: the assertion that matters is that an approval
   * gets a *delayed job at its own deadline* rather than at a fixed offset, and that is a
   * fact about the request, not about pg-boss.
   */
  const expiryJobs: Array<{ approvalId: string; expiresAt: Date }> = [];

  // ── phase 7: notifications and the approval gate ───────────────────────────
  //
  // Built before the engine harness, because the harness needs the gate at construction
  // time. The service needs the engine back, so that edge is bound after — the same
  // arrangement the container uses, for the same reason.
  const notificationService = new NotificationService({
    notifications,
    users: new UserRepository(db),
    logger,
    emit,
  });

  const approvalService = new ApprovalService({
    approvals,
    actions,
    runs,
    notifications: notificationService,
    logger,
    emit,
    /**
     * Standing exec permissions, on the same fake DB as the rest of the harness — a rule written
     * by an exec decision must be visible to a later `checkExec` in the same test.
     */
    execRules,
    /**
     * The owner port, stood in by a per-tenant map so a test can flip ownership in one line.
     * The default is a workspace with **no** owner, which is the state every fresh tenant starts
     * in — so a test that never calls `claimOwner` exercises the refusal path, and that is the
     * path most likely to be broken silently.
     */
    owner: ownerDirectory,
    // The real port the container injects, stood in by a recorder. What a test needs from
    // this is "an expiry job was requested for *this* approval at *this* deadline" — the
    // transport itself is pg-boss's, and is exercised separately in queue.service.test.ts.
    expiry: {
      scheduleApprovalExpiry: (id, at) => {
        expiryJobs.push({ approvalId: id, expiresAt: at });
        return Promise.resolve();
      },
    },
  });

  // ── phase 10: memory ────────────────────────────────────────────────────────
  //
  // A real `MemoryService` over this same database, built *before* the engine harness because the
  // tool registry decides which handlers exist at construction time — and the memory tools exist
  // only when a store does.
  //
  // The gateway is a refusal rather than a stub returning a plausible vector: nothing in this
  // harness may leave the process, and a fabricated embedding is a lie a test could then assert
  // on. `MemoryService` degrades instead of failing when it cannot produce a vector, so
  // `memory_store` still works here — the memory is simply keyword-searchable, which is the
  // deployment the spec requires to work at all.
  const memories = new MemoryRepository(db);
  const memoryService = new MemoryService({
    memories,
    agents,
    models,
    gateway: {
      embed: () => Promise.reject(new Error('control-harness: embedding is not wired')),
    },
    logger,
  });

  // ── engine, over this same database ─────────────────────────────────────────
  const engineHarness: EngineHarness = await createEngineHarness({
    fake,
    memory: memoryService,
    // The real resolver: a pinned run reads its `AgentVersion`, never the live agent.
    //
    // No `defaultModelId`, matching the container exactly. Supplying one here would make
    // every agent-less run resolve a model that production does not have, and would hide
    // the fact that an agent-less run has to name its own model.
    resolveContext: createAgentContextResolver({
      agents,
      goals,
      logger,
    }),
    // The port the engine uses to pin. `AgentRepository` satisfies it structurally.
    agents,
    // The gate, so a parked run records a real `Action` and `Approval` rather than the
    // placeholder id Phase 5 handed back. This is the difference the Phase 7 acceptance
    // criterion turns on: the id the engine cites is the one the inbox acts on.
    approvals: approvalService,
    // One ordered frame stream for the engine and the services, so a test asserting on
    // "what the operator saw" does not have to merge two arrays and guess the order.
    emit,
  });

  approvalService.bindEngine(engineHarness.engine);

  const gateway = engineHarness.gateway;

  // ── queue ───────────────────────────────────────────────────────────────────
  const queue = new RecordingRunQueue();
  const enqueued = queue.jobs;

  // ── services ────────────────────────────────────────────────────────────────
  //
  // The built-in tool rows, derived from the same registry the engine harness runs tools from.
  // Sharing the registry is the point: a tool `AgentService` grants and a tool the engine can
  // actually execute are then the same set by construction, which is the property a test of
  // "memoryEnabled grants the memory tools" is really asserting.
  const builtinTools = new BuiltinToolService({
    tools,
    native: engineHarness.nativeTools,
    logger,
  });

  const agentService = new AgentService({
    agents,
    models,
    goals,
    tasks,
    runs,
    builtins: builtinTools,
    logger,
  });
  const goalService = new GoalService({ goals, verifications, agents, runs, logger });

  // Phase 11's two repositories, built before the task service because it validates a
  // `recurring` task's `scheduleId` and an `event` task's `eventSubscriptionId` against them.
  const schedules = new ScheduleRepository(db);
  const events = new EventRepository(db);

  const taskService = new TaskService({
    tasks,
    runs,
    agents,
    goals,
    workflows,
    schedules,
    events,
    queue,
    logger,
  });
  const workflowService = new WorkflowService({
    workflows,
    tools,
    agents,
    runs,
    queue,
    logger,
  });
  const runService = new RunService({
    runs,
    steps,
    toolCalls,
    receipts,
    verifications,
    modelUsage,
    queue,
    logger,
    emit,
  });

  // ── phase 11: events & scheduling ─────────────────────────────────────────
  //
  // `RecordingScheduleQueue` rather than the pg-boss adapter: the transport's own firing is
  // the one thing that cannot be exercised without Postgres, so the recorder makes "was the
  // cron registered, and was it removed on disable?" an assertion instead of a hope.
  const scheduleQueue = new RecordingScheduleQueue();

  const occurrenceStarter = new OccurrenceStarter({
    runs,
    tasks,
    agents,
    workflows: workflowService,
    queue,
    logger,
  });

  const scheduleService = new ScheduleService({
    schedules,
    subscriptions: events,
    tasks,
    workflows,
    occurrences: occurrenceStarter,
    queue: scheduleQueue,
    logger,
    emit,
  });

  const eventService = new EventService({
    events,
    tasks,
    workflows,
    agents,
    occurrences: occurrenceStarter,
    logger,
    emit,
  });

  const recoveryService = new RecoveryService({
    runs,
    queue,
    logger,
    staleAfterMs: 900_000,
  });

  // ── phase 12: the dashboard ────────────────────────────────────────────────
  //
  // The MCP and provider repositories are built here rather than beside their Phase 4
  // services, because nothing in this harness read them until the dashboard did: it is the
  // first thing here that reports connected services and provider health.
  const mcpServers = new McpServerRepository(db);
  const mcpTools = new MCPToolRepository(db);
  const providers = new ModelProviderRepository(db);

  const dashboardService = new DashboardService({
    agents,
    goals,
    tasks,
    workflows,
    approvals,
    notifications,
    runs,
    steps,
    receipts,
    verifications,
    mcpServers,
    mcpTools,
    providers,
    schedules,
    logger,
  });

  return {
    fake,
    db,
    logger,
    agents,
    goals,
    tasks,
    workflows,
    schedules,
    events,
    actions,
    approvals,
    notifications,
    runs,
    steps,
    toolCalls,
    receipts,
    verifications,
    modelUsage,
    models,
    tools,
    agentService,
    goalService,
    taskService,
    workflowService,
    runService,
    scheduleService,
    eventService,
    occurrenceStarter,
    recoveryService,
    dashboardService,
    mcpServers,
    mcpTools,
    providers,
    /** The schedule queue's recorded registrations — see its construction for why. */
    scheduleQueue,
    approvalService,
    notificationService,
    engine: engineHarness.engine,
    /**
     * Standing exec permissions (§4.4) and the owner port (§5.6).
     *
     * Exposed so a test can inspect the rule an `allow_always` decision wrote, and so it can
     * read ownership back through the same port the service consults. The map itself stays
     * private: `claimOwner` is the only way to change it, which keeps "who is the owner" a
     * single verb rather than a field two call sites could disagree about.
     */
    execRules,
    owner: ownerDirectory,
    /** One-line claim: `claimOwner(tenantId, userId)` — the map is the state, this is the verb. */
    claimOwner: (tenantId: string, userId: string) => ownerByTenant.set(tenantId, userId),
    gateway,
    queue,
    enqueued,
    frames,
    expiryJobs,
    onHttp: (handler) => engineHarness.onHttp(handler),
    seedRun: (input) => engineHarness.seedRun(input),
    seedWaitingRun: (input) => engineHarness.seedWaitingRun(input),
    run: (runId) => engineHarness.run(runId),
    // The same array instance, not a copy: the engine appends to it as requests happen, so
    // a snapshot taken here would never see them.
    httpCalls: engineHarness.httpCalls,

    async seedModel(input = {}): Promise<Model> {
      const tenantId = input.tenantId ?? CONTROL_TENANT;
      // A provider per tenant, reused across models — `(tenantId, slug)` is unique.
      const provider = await db.modelProvider.upsert({
        where: { tenantId_slug: { tenantId, slug: 'test-provider' } },
        create: {
          tenantId,
          name: 'Test Provider',
          slug: 'test-provider',
          type: 'openai',
          enabled: true,
          status: 'healthy',
        },
        update: {},
      });

      return models.upsert({
        tenantId,
        providerId: provider.id,
        name: input.name ?? 'Test Model',
        externalModelId: input.externalModelId ?? `test-model-${Math.random().toString(36).slice(2, 8)}`,
        type: 'chat',
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.status === undefined ? {} : { status: input.status }),
      } as never);
    },

    async seedTool(input: SeedToolInput): Promise<Tool> {
      const tenantId = input.tenantId ?? CONTROL_TENANT;
      const row = await tools.upsert({
        tenantId,
        source: 'builtin',
        name: input.name,
        description: input.name,
        type: input.type ?? 'native',
        provider: 'native',
        inputSchema: { type: 'object', properties: {} },
        capabilities: input.capabilities ?? ['read_only'],
        mcpServerId: null,
      });
      if (input.status !== undefined && input.status !== 'enabled') {
        await tools.setStatus(tenantId, row.id, input.status);
      }
      return row;
    },

    async seedUser(input = {}): Promise<User> {
      const tenantId = input.tenantId ?? CONTROL_TENANT;
      // The tenant first: `User.tenantId` is a real foreign key, so a user cannot exist
      // before the workspace it belongs to.
      await db.tenant.upsert({
        where: { id: tenantId },
        create: { id: tenantId, name: 'Test Tenant' },
        update: {},
      });

      return db.user.create({
        data: {
          tenantId,
          email: input.email ?? `user-${Math.random().toString(36).slice(2, 8)}@test.local`,
          // A real-looking hash, never verified in these tests: nothing here authenticates,
          // and a literal `'hash'` invites a future reader to think it might be checkable.
          passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$placeholder',
          name: input.name ?? 'Test User',
        },
      });
    },

    async seedPassingVerification(input = {}): Promise<string> {
      return seedVerification(verifications, { ...input, passed: true });
    },

    async seedFailedVerification(input = {}): Promise<string> {
      return seedVerification(verifications, { ...input, passed: false });
    },

    async cleanup() {
      await engineHarness.cleanup();
    },
  };
}

/**
 * Create a `goal_criteria` verification and complete it.
 *
 * Two calls rather than one because that is how the engine does it: the row is written when
 * the check is *scheduled* and completed when it has run. A test that inserted a finished
 * row directly would not exercise the same column pair the gate reads.
 */
async function seedVerification(
  verifications: VerificationRepository,
  input: {
    tenantId?: string;
    goalId?: string | null;
    runId?: string | null;
    passed: boolean;
  },
): Promise<string> {
  const tenantId = input.tenantId ?? CONTROL_TENANT;
  const row = await verifications.create({
    tenantId,
    runId: input.runId ?? null,
    goalId: input.goalId ?? null,
    type: 'schema',
    scope: 'goal_criteria',
    config: { check: 'test' },
  });

  const changed = await verifications.complete(tenantId, row.id, {
    passed: input.passed,
    evidence: { note: 'seeded by control-harness' },
  });
  if (changed !== 1) throw new Error('control-harness: could not complete the verification');

  return row.id;
}
