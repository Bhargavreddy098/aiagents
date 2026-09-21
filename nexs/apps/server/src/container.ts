/**
 * Composition of the non-HTTP layers.
 *
 * Repositories, services and the token service are built once here from `config` and
 * `db`, and handed to the HTTP layer as already-wired objects. Nothing below this file
 * constructs a Prisma client or reads configuration, and nothing above it knows which
 * concrete repository class it is talking to.
 */
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Logger } from './logger.js';
import { CredentialRepository } from './repositories/credential.repo.js';
import { BrowserSessionRepository } from './repositories/browser.repo.js';
import {
  SandboxExecutionRepository,
  SandboxSessionRepository,
} from './repositories/sandbox.repo.js';
import { AttachmentRepository, FolderGrantRepository } from './repositories/files.repo.js';
import { ConnectorAccountRepository, ConnectorRepository } from './repositories/connector.repo.js';
import { SkillRepository, SkillVersionRepository } from './repositories/skill.repo.js';
import {
  MCPToolRepository,
  McpServerRepository,
  ToolRepository,
} from './repositories/mcp.repo.js';
import { ModelProviderRepository } from './repositories/model-provider.repo.js';
import { ModelUsageRepository } from './repositories/model-usage.repo.js';
import { ModelRepository } from './repositories/model.repo.js';
import { PasswordResetRepository } from './repositories/password-reset.repo.js';
import { RefreshTokenRepository } from './repositories/refresh-token.repo.js';
import {
  ExecutionReceiptRepository,
  RunRepository,
  StepRepository,
  ToolCallRepository,
  VerificationRepository,
} from './repositories/run.repo.js';
import { TenantRepository } from './repositories/tenant.repo.js';
import { UserRepository } from './repositories/user.repo.js';
import { AgentRepository } from './repositories/agent.repo.js';
import { ActionRepository, ApprovalRepository } from './repositories/approval.repo.js';
import { ExecAllowlistRepository } from './repositories/exec-allowlist.repo.js';
import { GoalRepository } from './repositories/goal.repo.js';
import { NotificationRepository } from './repositories/notification.repo.js';
import { TaskRepository } from './repositories/task.repo.js';
import { WorkflowRepository } from './repositories/workflow.repo.js';
import { ScheduleRepository } from './repositories/schedule.repo.js';
import { EventRepository } from './repositories/event.repo.js';
import { ScheduleService } from './services/schedules/schedule.service.js';
import { EventService } from './services/events/event.service.js';
import { createInMemoryBus, type EventBus } from './services/events/event-bus.js';
import { OccurrenceStarter } from './services/automation/occurrence.js';
import {
  PgBossScheduleQueue,
  UnavailableScheduleQueue,
  type ScheduleQueue,
  type ScheduleQueueClient,
} from './services/queue/schedule-queue.js';
import { RecoveryService } from './services/maintenance/recovery.service.js';
import { ProviderHealthService } from './services/providers/provider-health.service.js';
import { ProviderService } from './services/providers/provider.service.js';
import { ModelService } from './services/providers/model.service.js';
import { ToolService } from './services/tools/tool.service.js';
import { McpService } from './services/mcp/mcp.service.js';
import { BrowserService } from './services/browser/browser.service.js';
import { SandboxService } from './services/sandbox/sandbox.service.js';
import { FilesService } from './services/files/files.service.js';
import { ConnectorService } from './services/connectors/connector.service.js';
import { SkillService } from './services/skills/skill.service.js';
import { DashboardService } from './services/dashboard/dashboard.service.js';
import { AuthService } from './services/auth/auth.service.js';
import { PasswordResetService } from './services/auth/password-reset.service.js';
import { TokenService } from './services/auth/token.service.js';
import { ApprovalService } from './services/approvals/approval.service.js';
import type { ApprovalExpiryScheduler } from './services/approvals/approval.service.js';
import { NotificationService } from './services/notifications/notification.service.js';
import { AgentService } from './services/agents/agent.service.js';
import { GoalService } from './services/goals/goal.service.js';
import { TaskService } from './services/tasks/task.service.js';
import { WorkflowService } from './services/workflows/workflow.service.js';
import { RunService } from './services/runs/run.service.js';
import {
  InlineRunQueue,
  PgBossRunQueue,
  type BossLike,
  type RunQueue,
} from './services/queue/run-queue.js';
import { BrowserManager } from './services/browser/browser-manager.js';
import { PlaywrightLauncher } from './services/browser/launcher.js';
import { createAgentContextResolver } from './services/engine/agent-context.js';
import { ChatService } from './services/chat/chat.service.js';
import { ChatTurnRunner } from './services/chat/chat-turn.runner.js';
import { MentionResolver } from './services/chat/mention.resolver.js';
import { MemoryService } from './services/memory/memory.service.js';
import { ResearchService } from './services/research/research.service.js';
import { ResearchRepository } from './repositories/research.repo.js';
import { SlashCommandService } from './services/chat/slash-command.service.js';
import { ChatMessageRepository, ChatSessionRepository } from './repositories/chat.repo.js';
import { MemoryRepository } from './repositories/memory.repo.js';
import { ExecutionEngine, type EngineEmitter } from './services/engine/execution-engine.js';
import { Planner } from './services/engine/planner.js';
import { Verifier } from './services/engine/verifier.js';
import { FileService } from './services/files/file.service.js';
import { ModelGateway } from './services/gateway/model-gateway.js';
import { MCPManager, parseEnvBlock } from './services/mcp/mcp-manager.js';
import { SdkMcpSessionFactory } from './services/mcp/session.js';
import { NodeWorkerProvider } from './services/sandbox/node-worker.provider.js';
import { createSseHub, type SseHub } from './services/sse/sse-hub.js';
import { LocalStorageService } from './services/storage/storage.service.js';
import { NativeToolRegistry } from './services/tools/native-tools.js';
import { BuiltinToolService } from './services/tools/builtin-tools.service.js';
import { createSearchProvider } from './services/search/search-provider.js';
import { HttpPageReader } from './services/research/page-reader.js';
import { ResearchRunner } from './services/research/research.runner.js';
import { ToolInvoker } from './services/tools/tool-invoker.js';
import { UserService } from './services/user.service.js';
import { VaultService } from './services/vault/vault.service.js';
import { ApiError } from '@nexs/shared';
import { join } from 'node:path';

export interface Container {
  users: UserRepository;
  tenants: TenantRepository;
  refreshTokens: RefreshTokenRepository;
  passwordResets: PasswordResetRepository;
  credentials: CredentialRepository;
  providers: ModelProviderRepository;
  models: ModelRepository;
  modelUsage: ModelUsageRepository;
  mcpServers: McpServerRepository;
  mcpTools: MCPToolRepository;
  tools: ToolRepository;
  connectors: ConnectorRepository;
  connectorAccounts: ConnectorAccountRepository;
  skills: SkillRepository;
  skillVersions: SkillVersionRepository;
  browserSessions: BrowserSessionRepository;
  runs: RunRepository;
  steps: StepRepository;
  toolCalls: ToolCallRepository;
  receipts: ExecutionReceiptRepository;
  verifications: VerificationRepository;
  agents: AgentRepository;
  goals: GoalRepository;
  tasks: TaskRepository;
  workflows: WorkflowRepository;
  actions: ActionRepository;
  approvals: ApprovalRepository;
  notifications: NotificationRepository;
  vault: VaultService;
  gateway: ModelGateway;
  storage: LocalStorageService;
  files: FileService;
  sandbox: NodeWorkerProvider;
  mcp: MCPManager;
  browser: BrowserManager;
  nativeTools: NativeToolRegistry;
  invoker: ToolInvoker;
  planner: Planner;
  verifier: Verifier;
  engine: ExecutionEngine;
  /** The handoff between "a run row exists" and "something executes it". */
  queue: RunQueue;
  agentService: AgentService;
  goalService: GoalService;
  taskService: TaskService;
  workflowService: WorkflowService;
  runService: RunService;
  approvalService: ApprovalService;
  notificationService: NotificationService;
  /** Owns chat sessions and messages, and creates the run behind a turn. */
  chat: ChatService;
  /**
   * Drives a chat turn's generation.
   *
   * Separate from `chat` because generation begins *after* the HTTP response is committed:
   * the flush has already happened by the time this runs, so it cannot live in a service the
   * controller calls and then returns from.
   */
  chatRunner: ChatTurnRunner;
  /** Resolves `@` mentions from live registry data (§3.9). */
  mentions: MentionResolver;
  /** Answers `/`-prefixed turns (§PHASE-8.3). */
  slashCommands: SlashCommandService;
  /**
   * Memories: store with an embedding, search semantically with a keyword fallback (§PHASE-10.1).
   *
   * Also the store behind the `memory_search` / `memory_store` tools, which is why it is on the
   * container rather than owned by the Memory routes — the tools and the page must get the same
   * answers to "what does this agent remember".
   */
  memory: MemoryService;
  /**
   * Research: projects, the runs that attempt them, and the sources and findings they produce
   * (§PHASE-10.2).
   *
   * The protocol's own steps need a search provider this build does not have, so what this owns is
   * the storage, the provenance links and the run wiring — see the service's header for exactly
   * where the line is.
   */
  research: ResearchService;
  /** The protocol behind a research run's `kind` — see the note at its construction. */
  researchRunner: ResearchRunner;
  /**
   * Phase 11. The repositories are exposed alongside the services because
   * `TaskService.assertTriggerSatisfied` has to prove a `scheduleId` / `eventSubscriptionId`
   * exists before accepting a recurring or event task — and that check belongs in the task
   * service, not behind the schedule service's CRUD surface.
   */
  schedules: ScheduleRepository;
  events: EventRepository;
  scheduleService: ScheduleService;
  eventService: EventService;
  occurrenceStarter: OccurrenceStarter;
  recoveryService: RecoveryService;
  providerHealthService: ProviderHealthService;
  /**
   * Phase 3's services, surfaced over HTTP.
   *
   * `providerService` owns the key lifecycle (encrypt once, never return) and the catalogue
   * sync; `modelService` owns the operator's corrections to what a sync discovered. Split
   * because they answer to different rules — see `ProviderSyncResult` for why the sync must be
   * additive and `ModelService` for why it is the only writer of an edit.
   */
  providerService: ProviderService;
  modelService: ModelService;
  /**
   * Phase 4's services, surfaced over HTTP.
   *
   * `toolService` owns the registry reads and the guarded test-invoke; `mcpService` owns the
   * server lifecycle and the secret handling around it. Both take the managers built in phase 4
   * rather than reimplementing them — the invoker's capability resolution and the MCP manager's
   * idempotent connect are the behaviours the routes depend on.
   */
  toolService: ToolService;
  mcpService: McpService;
  /**
   * The browser and sandbox surfaces.
   *
   * Both are serialisation boundaries over managers built in phases 4 and 9 — they add no
   * capability, only a way to reach one that already existed. `browserService` exposes the live
   * session view the Browser tab renders; `sandboxService` owns the session rows, the per-session
   * run queue and the workdir containment check.
   */
  browserService: BrowserService;
  sandboxService: SandboxService;
  /**
   * The file surface: uploads, previews and folder grants.
   *
   * Takes `FileService` — the single module allowed to hand a path to `node:fs` — rather than
   * touching the filesystem itself. Every read re-resolves and re-checks containment, which is what
   * makes a tampered stored path a 403 rather than a leak.
   */
  filesService: FilesService;
  /**
   * Connectors: authorised third-party services and the actions they can perform.
   *
   * Held on the container as well as handed to the invoker, because the HTTP surface is not the
   * only reader — the engine reaches the same instance through its port, which is what makes
   * "the tool the operator tested" and "the tool the run invoked" the same object.
   */
  connectorService: ConnectorService;
  /** Skills: versioned prompt templates. Nothing in the engine invokes these; they are content. */
  skillService: SkillService;
  /**
   * Phase 12. Composes the dashboard snapshot from the repositories above.
   *
   * A service rather than an aggregate on each repository because the "zero hard-coded
   * numbers" rule is about the *composition* — it is the place where a missing read would
   * otherwise be papered over with a plausible constant, so it is the place that has to be
   * inspectable in one piece.
   */
  dashboardService: DashboardService;
  /**
   * The event bridge (§1.2) — the single seam every emitter publishes to.
   *
   * Exposed because it is the honest way to observe what the system emits: a test can
   * subscribe for a tenant and assert on frames without reaching into a service. The SSE hub
   * is one subscriber; it is not the only possible one.
   */
  bus: EventBus;
  /** The live transport behind `GET /api/stream`. Owns every open SSE connection. */
  sseHub: SseHub;
  tokens: TokenService;
  auth: AuthService;
  passwordReset: PasswordResetService;
  userService: UserService;
}

export function createContainer(deps: {
  config: Config;
  logger: Logger;
  db: Db;
  /**
   * Override for the emitter every service is given.
   *
   * Absent — the production case — means frames go to the event bus, which the SSE hub
   * subscribes to. Supplied, it replaces the bus entirely, which is how a test observes
   * frames without standing one up.
   */
  emit?: EngineEmitter;
  /**
   * The pg-boss connection, once one exists.
   *
   * Absent means runs execute in-process — see `InlineRunQueue`. It is a parameter rather
   * than something this file constructs because a queue connection is a lifecycle the
   * server owns (it must be started and drained on shutdown), and a container that opened
   * one could not be built in a test.
   */
  boss?: BossLike;
  /**
   * Enqueues `approval.expire` for a new approval.
   *
   * Passed in rather than constructed, because the scheduler *is* the queue service and the
   * queue service needs this container's approval service — the dependency runs both ways
   * across a construction boundary. Taking the port keeps the cycle from existing in the
   * module graph at all.
   */
  approvalExpiry?: ApprovalExpiryScheduler;
}): Container {
  const users = new UserRepository(deps.db);
  const tenants = new TenantRepository(deps.db);
  const refreshTokens = new RefreshTokenRepository(deps.db);
  const passwordResets = new PasswordResetRepository(deps.db);

  const credentials = new CredentialRepository(deps.db);
  const providers = new ModelProviderRepository(deps.db);
  const models = new ModelRepository(deps.db);
  const modelUsage = new ModelUsageRepository(deps.db);

  // The vault key is derived from the signing secret, so there is nothing extra to configure.
  // Rotating `JWT_SECRET` invalidates stored credentials — see `vault.service.ts`.
  const vault = new VaultService(deps.config.JWT_SECRET);

  const tokens = new TokenService({
    jwtSecret: deps.config.JWT_SECRET,
    accessTokenTtlSec: deps.config.ACCESS_TOKEN_TTL_SEC,
    refreshTokenTtlDays: deps.config.REFRESH_TOKEN_TTL_DAYS,
  });

  // ── the event bridge (§1.2) ────────────────────────────────────────────────
  //
  // Built **first**, before anything that emits, and that ordering is the whole point. The
  // SSE hub has to be built late (it takes the chat runner, which takes the gateway, which
  // takes the model catalog), so an emitter that needed the hub could not be wired at all —
  // which is exactly what had happened: the `emit` callbacks below were only ever populated
  // by tests, and in production every one of them was a no-op. The bus inverts that
  // dependency. Emitters publish to it, the hub subscribes to it, and neither has to exist
  // before the other.
  //
  // Always in-memory: this build runs the API and the worker in one process. The
  // `PgNotifyBus` half of §1.2 is the variant for a separate worker process, and it is
  // deliberately not written — it needs the `pg` driver and a live database to be verifiable
  // at all, and the seam below is what makes it a drop-in when that exists.
  const bus: EventBus = createInMemoryBus({ logger: deps.logger });

  /**
   * The one emitter every service is given.
   *
   * `deps.emit` still wins when supplied, so a test can observe frames without standing up a
   * bus — but it is an override rather than the mechanism, and nothing in production passes
   * one. The default is the bus, which is what makes the live tail live.
   */
  const emit: EngineEmitter =
    deps.emit ?? ((tenantId, frame) => bus.publish(tenantId, frame.name, frame.payload));

  const gateway = new ModelGateway({
    models,
    providers,
    usage: modelUsage,
    credentials,
    vault,
    logger: deps.logger,
    // The only place `fetch` is taken from the ambient global rather than injected.
    fetch: globalThis.fetch,
  });

  // ── phase 4: storage, files, sandbox, MCP, browser ────────────────────────

  const mcpServers = new McpServerRepository(deps.db);
  const mcpTools = new MCPToolRepository(deps.db);
  const tools = new ToolRepository(deps.db);
  const browserSessions = new BrowserSessionRepository(deps.db);
  // Sessions carry the tenant; executions are leaf rows proven through their session. That
  // asymmetry is why they are two repositories rather than one — see `sandbox.repo.ts`.
  const sandboxSessions = new SandboxSessionRepository(deps.db);
  const sandboxExecutions = new SandboxExecutionRepository(deps.db);
  // Attachments are files the system already has; grants are folders it may reach. Two halves of
  // one permission question — see `files.repo.ts`.
  const attachments = new AttachmentRepository(deps.db);
  const grants = new FolderGrantRepository(deps.db);
  // Connectors and skills. `ConnectorAccount` and `SkillVersion` carry no `tenantId` — they are
  // leaf rows proven through their parent — so each pair is two repositories rather than one,
  // the same split as sandbox sessions and executions.
  const connectors = new ConnectorRepository(deps.db);
  const connectorAccounts = new ConnectorAccountRepository(deps.db);
  const skills = new SkillRepository(deps.db);
  const skillVersions = new SkillVersionRepository(deps.db);

  const storage = new LocalStorageService(deps.config.STORAGE_ROOT);
  // The file jail lives in a fixed subdirectory rather than at the storage root. Object
  // keys put the tenant id first (`<tenantId>/screenshots/…`), so a jail rooted at the same
  // place would let a tenant whose id happened to be `tenants` address every other tenant's
  // files through an ordinary grant.
  const files = new FileService({
    root: join(deps.config.STORAGE_ROOT, 'tenants'),
    logger: deps.logger,
  });

  const sandbox = new NodeWorkerProvider({
    maxOldGenerationSizeMb: deps.config.SANDBOX_MAX_OLD_SPACE_MB,
    maxYoungGenerationSizeMb: deps.config.SANDBOX_MAX_YOUNG_SPACE_MB,
    stackSizeMb: deps.config.SANDBOX_STACK_MB,
    defaultTimeoutMs: deps.config.SANDBOX_TIMEOUT_MS,
    defaultMaxOutputBytes: deps.config.SANDBOX_MAX_OUTPUT_KB * 1024,
  });

  const mcp = new MCPManager({
    servers: mcpServers,
    mcpTools,
    tools,
    storage,
    sessionFactory: new SdkMcpSessionFactory(),
    // The only place a decrypted credential becomes a child process's environment. The
    // plaintext is returned straight into the spec and never stored, logged, or echoed
    // back through the API — see the manager's own test for the assertion that holds that.
    resolveEnv: async (tenantId, envRef) => {
      if (envRef === null || envRef.length === 0) return {};

      const credential = await credentials.findById(tenantId, envRef);
      if (credential === null) {
        // Deliberately not "not found": the server row exists, its secret does not, and an
        // operator reading `lastError` needs to know which of the two to fix.
        throw new ApiError('NOT_FOUND', 'The credential referenced by envRef does not exist', {
          envRef,
        });
      }
      return parseEnvBlock(vault.decrypt(credential.encrypted));
    },
    logger: deps.logger,
    options: {
      maxStdioServers: deps.config.MCP_MAX_STDIO_SERVERS,
      callTimeoutMs: deps.config.MCP_CALL_TIMEOUT_MS,
      connectTimeoutMs: deps.config.MCP_CONNECT_TIMEOUT_MS,
      toolResultMaxBytes: deps.config.TOOL_RESULT_MAX_KB * 1024,
    },
  });

  const browser = new BrowserManager({
    sessions: browserSessions,
    storage,
    // Headless is the default and the launcher's business, not the manager's: the manager
    // decides *what* to do to a page, never *how* the page was started.
    launcher: new PlaywrightLauncher({
      headless: deps.config.BROWSER_HEADLESS,
      timeoutMs: deps.config.BROWSER_TIMEOUT_MS,
    }),
    logger: deps.logger,
    options: {
      timeoutMs: deps.config.BROWSER_TIMEOUT_MS,
      screenshotMaxBytes: deps.config.BROWSER_SCREENSHOT_MAX_KB * 1024,
      inlineTextMaxBytes: deps.config.BROWSER_INLINE_TEXT_MAX_KB * 1024,
    },
  });

  // ── phase 5: the execution engine ─────────────────────────────────────────

  const runs = new RunRepository(deps.db);
  const steps = new StepRepository(deps.db);
  const toolCalls = new ToolCallRepository(deps.db);
  const receipts = new ExecutionReceiptRepository(deps.db);
  const verifications = new VerificationRepository(deps.db);

  // ── phase 7: approvals and notifications ──────────────────────────────────
  //
  // Built here, before the tool registry, because two Phase 4 components need them at
  // construction time: `NativeToolRegistry` registers `notify` only when a sink exists, and
  // the engine takes `ApprovalService` as its approval gate. Everything they depend on
  // (repositories, the logger) is already in scope.
  const actions = new ActionRepository(deps.db);
  const approvals = new ApprovalRepository(deps.db);
  const notifications = new NotificationRepository(deps.db);
  const execRules = new ExecAllowlistRepository(deps.db);

  const notificationService = new NotificationService({
    notifications,
    users,
    logger: deps.logger,
    emit,
  });

  const approvalService = new ApprovalService({
    approvals,
    actions,
    runs,
    execRules,
    /**
     * The command owner (§5.6) is read from the tenant row, which is where it lives.
     *
     * Built here as the port rather than passed as a `TenantRepository`, so the approval service
     * never learns that ownership is a column on another aggregate. `?? null` covers both "the
     * tenant row is gone" and "no owner is set": the two are the same answer to this port's only
     * question — nobody may grant an exec approval — and collapsing them here is deliberate.
     */
    owner: {
      findOwner: async (tenantId) => (await tenants.findById(tenantId))?.ownerUserId ?? null,
    },
    notifications: notificationService,
    logger: deps.logger,
    emit,
    // The scheduler is a port, so the container does not import the queue — the queue
    // needs this container's approval service, and importing it back would be a cycle.
    ...(deps.approvalExpiry === undefined ? {} : { expiry: deps.approvalExpiry }),
  });

  // ── phase 10: memory (§PHASE-10.1) ────────────────────────────────────────
  //
  // Built here, *above* the tool registry, because `NativeToolRegistry` registers the
  // `memory_store` / `memory_search` handlers only when a store exists behind them — the same
  // conditional-registration rule `notify` follows. A memory tool offered with nothing behind it
  // is a tool that can only fail, and a model that is offered a tool will use it.
  //
  // `agents` is built here too rather than with the other Phase 6 repositories below, because the
  // memory service checks that an `agentId` names a real agent in this tenant before it writes a
  // row pointing at it — `Memory.agentId` is a plain scalar with no foreign key to enforce that.
  const agents = new AgentRepository(deps.db);
  const memories = new MemoryRepository(deps.db);
  // The real gateway, not a stub: memory's embedding path is capability-checked through the
  // model catalog and then embedded through the same gateway every other provider call uses, so
  // there is one place where a provider is reached and one place where usage is recorded.
  const memoryService = new MemoryService({
    memories,
    agents,
    models,
    gateway,
    logger: deps.logger,
  });

  // The search provider behind `web_search`, built here for the same reason the memory service is:
  // the registry decides whether to register the handler by asking whether one exists. `undefined`
  // means "no search in this deployment", and the tool is then simply absent from `list()` — so
  // `BuiltinToolService.ensure` never writes a row for it either, and no agent can be granted it.
  const searchProvider = createSearchProvider(
    {
      provider: deps.config.SEARCH_PROVIDER,
      apiKey: deps.config.SEARCH_API_KEY ?? null,
      baseUrl: deps.config.SEARCH_BASE_URL,
      defaultMaxResults: deps.config.SEARCH_MAX_RESULTS,
      maxResultsCeiling: deps.config.SEARCH_MAX_RESULTS_CEILING,
      timeoutMs: deps.config.SEARCH_TIMEOUT_MS,
      maxResponseBytes: deps.config.SEARCH_MAX_RESPONSE_KB * 1024,
    },
    { fetch: globalThis.fetch, logger: deps.logger },
  );

  const nativeTools = new NativeToolRegistry({
    files,
    memory: memoryService,
    ...(searchProvider === undefined ? {} : { search: searchProvider }),
    // `notify` is registered only when a sink exists, so the model is never offered a tool
    // that can only fail. The sink arrives with notifications in Phase 7: this is what turns
    // "the agent can notify an operator" from a described capability into a real one, and
    // the tool's own test asserts the registration is conditional.
    notifications: notificationService,
    fetch: globalThis.fetch,
    logger: deps.logger,
    now: Date.now,
    httpMaxBytes: deps.config.HTTP_RESPONSE_MAX_KB * 1024,
  });

  // The rows behind the registry. Built next to it because the registry is what they are derived
  // from: `ensure` reads `nativeTools.list()`, so a tool can never have a row without a handler or
  // a handler without a row — which is the failure that makes a working tool unreachable.
  const builtinTools = new BuiltinToolService({
    tools,
    native: nativeTools,
    logger: deps.logger,
  });

  /**
   * Connectors.
   *
   * Built *before* the invoker because the invoker takes it as a port — the engine's dispatch table
   * needs somewhere to send a `connector`-typed tool. The dependency runs one way: this service
   * knows about tools (it registers them) and nothing about the engine that invokes them.
   *
   * `fetch` is left to the service's own default rather than passed here, so a test that constructs
   * the container can still drive a whole connector without a network by overriding one dependency.
   */
  const connectorService = new ConnectorService({
    connectors,
    accounts: connectorAccounts,
    credentials,
    tools,
    vault,
    logger: deps.logger,
    emit,
  });

  const skillService = new SkillService({
    skills,
    versions: skillVersions,
    logger: deps.logger,
  });

  const invoker = new ToolInvoker({
    tools,
    mcpTools,
    native: nativeTools,
    mcp,
    browser,
    connectors: connectorService,
    sandbox,
    storage,
    logger: deps.logger,
    now: Date.now,
    options: { toolResultMaxBytes: deps.config.TOOL_RESULT_MAX_KB * 1024 },
  });

  const planner = new Planner({ gateway, tools, logger: deps.logger });
  const verifier = new Verifier({ files, browser, logger: deps.logger });

  // ── phase 6: agents, goals, tasks, workflows ──────────────────────────────
  //
  // `agents` itself is built up with the Phase 10 memory block, because the memory service needs
  // it to check that an `agentId` names a real agent. Only the repositories that arrive *with*
  // Phase 6 are created here.
  const goals = new GoalRepository(deps.db);
  const tasks = new TaskRepository(deps.db);
  const workflows = new WorkflowRepository(deps.db);

  /**
   * The one resolver that decides what an agent is configured to do.
   *
   * Built here, above the engine and above the chat block, because both need it and there must
   * be exactly one. Two instances would be two answers to the same question — the divergence
   * `agentVersionId` pinning exists to prevent, reintroduced one layer up.
   *
   * It reads the `AgentVersion` a run pinned at start, never the live `Agent` row (gap #15), so
   * an agent edited mid-conversation cannot change what an in-flight turn is allowed to do.
   */
  const resolveRunContext = createAgentContextResolver({
    agents,
    goals,
    logger: deps.logger,
  });

  const engine = new ExecutionEngine({
    runs,
    steps,
    toolCalls,
    receipts,
    verifications,
    tools,
    invoker,
    planner,
    verifier,
    gateway,
    // The real resolver: a run reads its configuration from the `AgentVersion` it pinned at
    // start, never from the live `Agent` row (gap #15). A run with no agent still falls back
    // to describing itself in its own input, which is how ad-hoc and chat runs work.
    // Built once above and shared with `ChatService`, deliberately — see the comment there.
    resolveContext: resolveRunContext,
    // The engine pins the version before resolving the context. Given the same port the
    // resolver uses, so a run created without an agent-aware service is still pinned.
    agents,
    // The approval gate. Phase 5 deliberately ran without one — an unwired gate makes the
    // engine park a run and hand back a placeholder id, which was enough to build and test
    // the park/resume cycle. Now the rows are real: a step that the policy judges risky
    // writes an `Action` and an `Approval`, and the id the engine cites is the one the
    // inbox acts on.
    approvals: approvalService,
    logger: deps.logger,
    now: Date.now,
    browserSessions,
    emit,
    options: {
      maxSteps: deps.config.ENGINE_MAX_STEPS,
      maxToolCalls: deps.config.ENGINE_MAX_TOOL_CALLS,
      maxDurationMs: deps.config.ENGINE_MAX_DURATION_MS,
      stepTimeoutMs: deps.config.ENGINE_STEP_TIMEOUT_MS,
      maxRetries: deps.config.ENGINE_MAX_RETRIES,
      tenantConcurrency: deps.config.TENANT_CONCURRENCY,
    },
  });

  // Close the cycle: the gate the engine holds is this service, and the service now holds
  // the engine it resumes runs on. Exactly one of the two edges has to be late, and this is
  // the cheaper one — see `ApprovalService.bindEngine` for why nothing can call it too early.
  approvalService.bindEngine(engine);

  const queue: RunQueue =
    deps.boss === undefined
      ? // No pg-boss connection yet, so runs execute in this process. That is not a stub:
        // the run really does execute, through the same engine, which is what makes the
        // Phase 6 API exercisable end to end before the worker lands. See `InlineRunQueue`
        // for the three production properties it does not have.
        new InlineRunQueue({
          execute: (job) => engine.executeRun(job.tenantId, job.runId),
          logger: deps.logger,
        })
      : new PgBossRunQueue(deps.boss, deps.logger);

  const agentService = new AgentService({
    agents,
    models,
    goals,
    tasks,
    runs,
    // Grants the memory tools to an agent whose `memoryEnabled` is on, which is what the spec's
    // "automatically" means in an architecture where the model can only call a tool that has a row.
    builtins: builtinTools,
    logger: deps.logger,
  });

  const researchService = new ResearchService({
    research: new ResearchRepository(deps.db),
    agents,
    runs,
    // The same queue tasks use, so a research run is handed off and recovered exactly like any
    // other run — nothing about it is special-cased except its `kind`.
    queue,
    logger: deps.logger,
    // Lets `startRun` refuse before it creates two rows and a queue job for a protocol whose second
    // step cannot run. The provider object is the answer: no provider, no search, no research.
    searchAvailable: () => searchProvider !== undefined,
  });

  // ── the research protocol (spec Phase 10.2) ─────────────────────────────────
  //
  // The runner owns the protocol's *work*; `ResearchService` owns its *records*. Every source and
  // finding is written through the service, so the provenance check on a finding's citations cannot
  // be bypassed by the component that happens to be driving.
  //
  // `resolveContext` is the engine's own resolver, deliberately: the model a research run uses is
  // resolved the same way a normal run's is, including the `AgentVersion` pin, so there is one
  // answer to "which model is this run using" rather than two that can disagree.
  const pageReader = new HttpPageReader({
    fetch: globalThis.fetch,
    maxTextBytes: deps.config.RESEARCH_PAGE_MAX_KB * 1024,
    maxBodyBytes: deps.config.RESEARCH_PAGE_MAX_KB * 1024 * 4,
    timeoutMs: deps.config.RESEARCH_PAGE_TIMEOUT_MS,
    userAgent: 'NEXS-Research/0.1 (+https://nexs.local)',
  });

  const researchRunner = new ResearchRunner({
    research: researchService,
    runs,
    resolveContext: resolveRunContext,
    gateway,
    // Non-null by construction: the runner is only ever reached for a run whose `startRun` refused
    // to exist without a provider. The fallback keeps the type honest if that ever stops being true
    // — a search that throws is a failed run, not a crash at wiring time.
    search: searchProvider ?? {
      name: 'unavailable',
      search: async () => {
        throw new ApiError(
          'FEATURE_DISABLED',
          'Research needs a search provider: set SEARCH_PROVIDER and SEARCH_API_KEY',
          { feature: 'search' },
        );
      },
    },
    reader: pageReader,
    verifier,
    limits: {
      maxQueries: deps.config.RESEARCH_MAX_QUERIES,
      maxSources: deps.config.RESEARCH_MAX_SOURCES,
      maxFindings: deps.config.RESEARCH_MAX_FINDINGS,
      excerptChars: deps.config.RESEARCH_EXCERPT_CHARS,
      minSources: deps.config.RESEARCH_MIN_SOURCES,
    },
    logger: deps.logger,
    now: Date.now,
  });

  const goalService = new GoalService({
    goals,
    verifications,
    agents,
    runs,
    logger: deps.logger,
  });

  const workflowService = new WorkflowService({
    workflows,
    tools,
    agents,
    runs,
    queue,
    logger: deps.logger,
  });

  // Phase 11's repositories are built here rather than beside their services further down,
  // because `TaskService` needs both: a `recurring` task has to prove its `scheduleId`
  // exists, and an `event` task its `eventSubscriptionId`. Building them after the task
  // service would mean it could not do that check.
  const schedules = new ScheduleRepository(deps.db);
  const events = new EventRepository(deps.db);

  const taskService = new TaskService({
    tasks,
    runs,
    agents,
    goals,
    workflows,
    schedules,
    events,
    queue,
    logger: deps.logger,
  });

  const runService = new RunService({
    runs,
    steps,
    toolCalls,
    receipts,
    verifications,
    modelUsage,
    queue,
    logger: deps.logger,
    emit,
  });

  // ── phase 11: events & scheduling ─────────────────────────────────────────
  //
  // The order here is forced by one dependency: `OccurrenceStarter` calls
  // `WorkflowService.run`, so it must be built after `workflowService` above. Everything
  // else reads repositories that already exist.
  //
  // `PgBossScheduleQueue` wraps the same boss the run queue does. It is a *producer* — it
  // registers crons and delayed jobs — so it is built here rather than in the queue service:
  // the queue service owns consumers, and a schedule's transport registration is written by
  // whichever process creates or edits the schedule.
  const scheduleQueue: ScheduleQueue =
    deps.boss === undefined
      ? new UnavailableScheduleQueue(deps.logger)
      : new PgBossScheduleQueue(deps.boss as unknown as ScheduleQueueClient, deps.logger);

  const occurrenceStarter = new OccurrenceStarter({
    runs,
    tasks,
    agents,
    workflows: workflowService,
    queue,
    logger: deps.logger,
  });

  const scheduleService = new ScheduleService({
    schedules,
    subscriptions: events,
    tasks,
    workflows,
    occurrences: occurrenceStarter,
    queue: scheduleQueue,
    logger: deps.logger,
    emit,
  });

  const eventService = new EventService({
    events,
    tasks,
    workflows,
    agents,
    occurrences: occurrenceStarter,
    logger: deps.logger,
    emit,
  });

  const recoveryService = new RecoveryService({
    runs,
    queue,
    logger: deps.logger,
    staleAfterMs: deps.config.RUN_STALE_AFTER_MS,
  });

  const providerHealthService = new ProviderHealthService({
    providers,
    credentials,
    vault,
    logger: deps.logger,
    timeoutMs: deps.config.PROVIDER_HEALTH_TIMEOUT_MS,
    emit,
    resolveBaseUrl: (type) => gateway.defaultBaseUrlFor(type),
  });

  // ── phase 3, surfaced: the provider and model pages ────────────────────────
  //
  // The vault, the gateway and the health service were all built phases ago and had no HTTP
  // surface at all — the services existed, the routes never did. These two services are the
  // thin layer that closes that gap: `providerService` owns the key lifecycle and the
  // catalogue sync, `modelService` owns the operator's corrections to what a sync discovered.
  //
  // `providerService` is built after `providerHealthService` because it delegates `test` to it
  // rather than probing again itself — the button and the ten-minute cron must answer the same
  // question the same way, and two implementations is how they stop doing that.
  const providerService = new ProviderService({
    providers,
    credentials,
    models,
    vault,
    gateway,
    health: providerHealthService,
    logger: deps.logger,
    emit,
  });

  const modelService = new ModelService({ models });

  // ── phase 4, surfaced: the tool registry and the MCP servers ───────────────
  //
  // The registry, the invoker and the MCP manager were all built in phase 4 and had no HTTP
  // surface either. Both services are built here rather than beside their dependencies because
  // they read `credentials` and `vault`, which are created early, and because nothing below them
  // consumes them.
  const toolService = new ToolService({ tools, builtin: builtinTools, invoker });

  const mcpService = new McpService({
    servers: mcpServers,
    mcpTools,
    tools,
    credentials,
    vault,
    manager: mcp,
    logger: deps.logger,
  });

  // ── phases 4 and 9, surfaced: browser and sandbox ─────────────────────────
  //
  // Both are thin serialisation boundaries over managers that were already built and already
  // tested. `sandboxService` additionally needs `files`, because a sandbox workdir is resolved
  // through the same path jail every other file access uses — a second resolver would be a second
  // place the containment check could be got wrong.
  const browserService = new BrowserService({ browser });

  const sandboxService = new SandboxService({
    sessions: sandboxSessions,
    executions: sandboxExecutions,
    provider: sandbox,
    files,
    logger: deps.logger,
  });

  // ── the file surface ───────────────────────────────────────────────────────
  //
  // Built last of the newly-surfaced services because it needs `files` (the path jail), which is
  // created early, and nothing below consumes it. The upload ceiling is the same
  // `MAX_UPLOAD_MB` the Express body parser uses — one number, so a request cannot be rejected by
  // one layer for being large while the other would have accepted it.
  const filesService = new FilesService({
    attachments,
    grants,
    files,
    logger: deps.logger,
    maxUploadBytes: deps.config.MAX_UPLOAD_MB * 1024 * 1024,
  });

  // ── phase 12: the dashboard ───────────────────────────────────────────────
  //
  // Built after everything it reads. It takes no `emit` and produces no frames: the dashboard
  // is a pull, and the *live* half of the spec's acceptance criterion is the stream itself —
  // the run and notification emitters already publish, and this service only has to be
  // re-fetchable. Giving it an emitter would be the first step toward pushing a whole
  // recomputed snapshot on every frame, which is a different (and much more expensive) design
  // than the one the spec describes.
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
    logger: deps.logger,
  });

  // ── phase 7: the live transport ───────────────────────────────────────────

  /**
   * The late-bound edge: filled in once the chat runner exists, a few lines below.
   *
   * The hub and the chat runner need each other — the hub asks "did the last watcher of this
   * run just leave?", and the runner is what can answer it by aborting — so one of the two
   * edges has to be late-bound. This is the cheaper one: a single optional indirection, versus
   * giving the hub a back-reference to a service it otherwise has no business knowing about.
   *
   * The callback cannot fire before the runner is constructed, because it is only reachable
   * through an open stream, and no stream can be opened until `createApp` has returned.
   *
   * A `const` holder with a mutable field rather than a `let` binding: the hub's closure reads
   * the property at call time, so what has to be mutable is the field, not the binding. `let`
   * would also work, but nothing here reassigns the binding — and saying `const` is what makes
   * that visible instead of leaving a reader to check every line for a second assignment.
   */
  const runWatcher: { onUnwatched?: (tenantId: string, runId: string) => void } = {};

  const sseHub = createSseHub({
    logger: deps.logger,
    maxConnectionsPerIp: deps.config.SSE_MAX_CONNECTIONS_PER_IP,
    onRunUnwatched: (tenantId, runId) => runWatcher.onUnwatched?.(tenantId, runId),
    // The edge that makes the tail live. The hub subscribes per tenant on the first client of
    // that tenant, so everything the emitters above publish reaches the browsers watching —
    // which, before this line existed, was nothing at all.
    bus,
  });

  // ── phase 8: chat ─────────────────────────────────────────────────────────
  //
  // Two objects, in this order, plus one binding:
  //
  //   ChatService    — owns sessions, messages, and creating a turn's run
  //   ChatTurnRunner — owns generation, which happens after the response is committed
  //   the hub binding — closes gap #21, aborting a generation whose last watcher left
  //
  // Both read their configuration through `resolveRunContext` above, the same resolver the
  // engine uses — see its comment for why there is only one.
  const chatSessions = new ChatSessionRepository(deps.db);
  const chatMessages = new ChatMessageRepository(deps.db);

  const chatService = new ChatService({
    sessions: chatSessions,
    messages: chatMessages,
    runs,
    agents,
    tools,
    // `ChatService` needs only these three fields, but it must not re-derive them: narrowing
    // the shared resolver's result here is what keeps the pinned-version lookup in one place.
    // The array is copied because the resolver exposes it as readonly and the service's port
    // is a mutable array — copying is cheaper than widening the resolver's contract.
    resolver: async (run) => {
      const context = await resolveRunContext(run);
      return {
        instructions: context.instructions,
        modelId: context.modelId,
        allowedToolIds: [...context.allowedToolIds],
      };
    },
    logger: deps.logger,
  });

  const chatRunner = new ChatTurnRunner({
    gateway,
    tools: invoker,
    messages: chatMessages,
    runs,
    hub: sseHub,
    logger: deps.logger,
  });

  // `@` autocomplete. Built from the same tenant-scoped repositories every other service uses,
  // so a mention can only ever name something the caller can already see — there is no separate
  // index to fall out of step with what exists.
  const mentionResolver = new MentionResolver({
    agents,
    models,
    tools,
    mcpServers,
    goals,
    workflows,
    runs,
    logger: deps.logger,
  });

  // Slash commands. Every entry below is a real service method — the spec's rule is that a
  // listing shows actual rows, so the adapter is a direct pass-through and deliberately does
  // not narrow, reshape, or default anything on the way in.
  const slashCommands = new SlashCommandService({
    services: {
      agents: {
        list: (tenantId) => agentService.list(tenantId),
        create: (tenantId, input) => agentService.create(tenantId, input),
        get: (tenantId, id) => agentService.get(tenantId, id),
      },
      goals: {
        list: (tenantId) => goalService.list(tenantId),
        create: (tenantId, input) => goalService.create(tenantId, input),
      },
      tasks: {
        create: (tenantId, input) =>
          taskService.create(tenantId, { ...input, triggerType: 'manual' }),
      },
      runs: {
        list: (tenantId, query) => runService.list(tenantId, query),
        get: (tenantId, id) => runService.get(tenantId, id),
        cancel: (tenantId, id) => runService.cancel(tenantId, id),
        pause: (tenantId, id) => runService.pause(tenantId, id),
        resume: (tenantId, id) => runService.resume(tenantId, id),
      },
      approvals: {
        list: (tenantId, filters) => approvalService.list(tenantId, filters),
        decide: (tenantId, id, userId, input) => approvalService.decide(tenantId, id, userId, input),
        countPending: (tenantId) => approvalService.countPending(tenantId),
      },
      notifications: {
        unreadCount: (tenantId, userId) => notificationService.unreadCount(tenantId, userId),
      },
      models: {
        list: async (tenantId) => {
          const rows = await models.list(tenantId, { enabledOnly: true });
          return rows.map((row) => ({
            id: row.id,
            name: row.name,
            providerName: row.provider.name,
          }));
        },
      },
      tools: {
        list: (tenantId) => tools.list(tenantId),
      },
      mcp: {
        list: (tenantId) => mcpServers.list(tenantId),
      },
      providers: {
        list: (tenantId) => providers.list(tenantId),
      },
      browser: {
        open: (tenantId, options) => browser.open(tenantId, options),
        act: (tenantId, sessionId, action) => browser.act(tenantId, sessionId, action),
        close: (tenantId, sessionId) => browser.close(tenantId, sessionId),
      },
    },
    logger: deps.logger,
  });

  // The late-bound edge the hub was built for. A chat run is not enqueued, so the connection
  // that renders it is what drives it; when the last watcher leaves there is nothing left to
  // render into, and the generation is aborted rather than left to bill for an unread answer.
  runWatcher.onUnwatched = (tenantId, runId) => {
    chatRunner.cancel(tenantId, runId);
  };

  return {
    users,
    tenants,
    refreshTokens,
    passwordResets,
    credentials,
    providers,
    models,
    modelUsage,
    mcpServers,
    mcpTools,
    tools,
    connectors,
    connectorAccounts,
    skills,
    skillVersions,
    browserSessions,
    runs,
    steps,
    toolCalls,
    receipts,
    verifications,
    agents,
    goals,
    tasks,
    workflows,
    actions,
    approvals,
    notifications,
    vault,
    gateway,
    storage,
    files,
    sandbox,
    mcp,
    browser,
    nativeTools,
    invoker,
    planner,
    verifier,
    engine,
    queue,
    agentService,
    goalService,
    taskService,
    workflowService,
    runService,
    approvalService,
    notificationService,
    chat: chatService,
    chatRunner,
    mentions: mentionResolver,
    slashCommands,
    memory: memoryService,
    research: researchService,
    researchRunner,
    schedules,
    events,
    scheduleService,
    eventService,
    occurrenceStarter,
    recoveryService,
    providerHealthService,
    providerService,
    modelService,
    toolService,
    mcpService,
    browserService,
    sandboxService,
    filesService,
    connectorService,
    skillService,
    dashboardService,
    bus,
    sseHub,
    tokens,
    auth: new AuthService({ users, tenants, refreshTokens, tokens, logger: deps.logger }),
    passwordReset: new PasswordResetService({ users, passwordResets, refreshTokens, tokens }),
    userService: new UserService({ users, tenants }),
  };
}
