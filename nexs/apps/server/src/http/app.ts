import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { createContainer, type Container } from '../container.js';
import { createAuthController } from '../controllers/auth.controller.js';
import { createUserController } from '../controllers/user.controller.js';
import { correlationId } from './middleware/correlation.js';
import { createErrorHandler, notFound } from './middleware/errors.js';
import { createAuthRequired } from './middleware/auth.js';
import { createRateLimiter } from './middleware/rate-limit.js';
import { createHealthRouter, type QueueStatus } from '../routes/health.js';
import { createAuthRouter } from '../routes/auth.js';
import { createUsersRouter } from '../routes/users.js';
import { createAgentsRouter } from '../routes/agents.js';
import { createGoalsRouter } from '../routes/goals.js';
import { createTasksRouter } from '../routes/tasks.js';
import { createWorkflowsRouter } from '../routes/workflows.js';
import { createRunsRouter } from '../routes/runs.js';
import { createApprovalsRouter } from '../routes/approvals.js';
import { createNotificationsRouter } from '../routes/notifications.js';
import { createMemoryRouter } from '../routes/memory.js';
import { createResearchRouter } from '../routes/research.js';
import { createEventsRouter } from '../routes/events.js';
import { createSchedulesRouter } from '../routes/schedules.js';
import { createDashboardRouter } from '../routes/dashboard.js';
import { createStreamRouter } from '../routes/stream.js';
import { createChatRouter } from '../routes/chat.js';
import { createProvidersRouter } from '../routes/providers.js';
import { createModelsRouter } from '../routes/models.js';
import { createToolsRouter } from '../routes/tools.js';
import { createMcpRouter } from '../routes/mcp.js';
import { createBrowserRouter } from '../routes/browser.js';
import { createSandboxRouter } from '../routes/sandbox.js';
import { createFilesRouter } from '../routes/files.js';
import { createConnectorsRouter } from '../routes/connectors.js';
import { createSkillsRouter } from '../routes/skills.js';
import { createStreamController } from '../controllers/stream.controller.js';
import { createDashboardController } from '../controllers/dashboard.controller.js';
import { createChatController } from '../controllers/chat.controller.js';
import { createAgentController } from '../controllers/agent.controller.js';
import { createGoalController } from '../controllers/goal.controller.js';
import { createTaskController } from '../controllers/task.controller.js';
import { createWorkflowController } from '../controllers/workflow.controller.js';
import { createRunController } from '../controllers/run.controller.js';
import { createApprovalController } from '../controllers/approval.controller.js';
import { createExecApprovalController } from '../controllers/exec-approval.controller.js';
import { createNotificationController } from '../controllers/notification.controller.js';
import { createMemoryController } from '../controllers/memory.controller.js';
import { createResearchController } from '../controllers/research.controller.js';
import { createEventController } from '../controllers/event.controller.js';
import { createScheduleController } from '../controllers/schedule.controller.js';
import { createProviderController } from '../controllers/provider.controller.js';
import { createModelController } from '../controllers/model.controller.js';
import { createToolController } from '../controllers/tool.controller.js';
import { createMcpController } from '../controllers/mcp.controller.js';
import { createBrowserController } from '../controllers/browser.controller.js';
import { createSandboxController } from '../controllers/sandbox.controller.js';
import { createFilesController } from '../controllers/files.controller.js';
import { createConnectorController } from '../controllers/connector.controller.js';
import { createSkillController } from '../controllers/skill.controller.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  db: Db;
  queueStatus: () => QueueStatus;
  version?: string;
  /**
   * A container to use instead of building one here.
   *
   * The composition root wires a container *before* this call — it has to, because the
   * queue service that consumes `run.execute` needs the engine, and the container needs the
   * queue's boss. Handing that same container in is what keeps one engine per process:
   * building a second here would give the API and the worker two objects with two ideas of
   * a run's checkpoint. Optional, so the HTTP tests keep building their own.
   */
  container?: Container;
}

export function createApp(deps: AppDeps): Express {
  const { config, logger, db } = deps;
  const app = express();
  const container = deps.container ?? createContainer({ config, logger, db });

  app.disable('x-powered-by');
  app.use(helmet());

  // CORS is locked to the single configured web origin — never a wildcard.
  // `credentials: true` is what lets the browser attach the auth cookies.
  app.use(
    cors({
      origin: config.WEB_ORIGIN,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
    }),
  );

  app.use(express.json({ limit: `${config.MAX_UPLOAD_MB}mb` }));
  app.use(express.urlencoded({ extended: false, limit: `${config.MAX_UPLOAD_MB}mb` }));
  app.use(cookieParser());

  app.use(correlationId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as unknown as { correlationId?: string }).correlationId ?? randomUUID(),
      customLogLevel: (_req, res, err) => {
        if (err !== undefined && err !== null) return 'error';
        if (res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // Mounted before the general limiter on purpose: health probes come from the
  // platform, not from users, and must not be throttled by API traffic.
  app.use(
    '/api/health',
    createHealthRouter({
      db,
      config,
      queueStatus: deps.queueStatus,
      version: deps.version ?? '0.1.0',
    }),
  );

  // Baseline throttle for everything below. The auth endpoints add a much tighter
  // limiter of their own on top of this.
  app.use(createRateLimiter(config.RATE_LIMIT_DEFAULT_PER_MIN));

  app.use(
    '/api/auth',
    createAuthRouter({
      controller: createAuthController({
        auth: container.auth,
        passwordReset: container.passwordReset,
        config,
        logger,
      }),
      rateLimitPerMinute: config.RATE_LIMIT_AUTH_PER_MIN,
    }),
  );

  app.use(
    '/api/users',
    createUsersRouter({
      controller: createUserController({ users: container.userService }),
      authRequired: createAuthRequired({ users: container.users, tokens: container.tokens }),
    }),
  );

  // ── phase 6: the control plane ────────────────────────────────────────────
  //
  // Every router below is authenticated as a whole. Building `authRequired` once and
  // handing it to each router means a route added to any of them cannot forget it, and
  // there is exactly one place the auth strategy is configured.
  const authRequired = createAuthRequired({ users: container.users, tokens: container.tokens });

  app.use(
    '/api/agents',
    createAgentsRouter({
      controller: createAgentController({ agents: container.agentService }),
      authRequired,
    }),
  );

  app.use(
    '/api/goals',
    createGoalsRouter({
      controller: createGoalController({ goals: container.goalService }),
      authRequired,
    }),
  );

  app.use(
    '/api/tasks',
    createTasksRouter({
      controller: createTaskController({ tasks: container.taskService }),
      authRequired,
    }),
  );

  app.use(
    '/api/workflows',
    createWorkflowsRouter({
      controller: createWorkflowController({ workflows: container.workflowService }),
      authRequired,
    }),
  );

  app.use(
    '/api/runs',
    createRunsRouter({
      controller: createRunController({ runs: container.runService }),
      authRequired,
    }),
  );

  // ── phase 7: the Decision Inbox and the notification bell ──────────────────
  //
  // Both live behind the same shared `authRequired`, for the reason stated above: a route
  // added to either cannot forget it.
  app.use(
    '/api/approvals',
    createApprovalsRouter({
      controller: createApprovalController({ approvals: container.approvalService }),
      // The exec half (§4.4). Same service, because it is the same table and the same
      // compare-and-swap — a separate controller because it is a different question with a
      // different answer vocabulary.
      exec: createExecApprovalController({ approvals: container.approvalService }),
      authRequired,
    }),
  );

  app.use(
    '/api/notifications',
    createNotificationsRouter({
      controller: createNotificationController({ notifications: container.notificationService }),
      authRequired,
    }),
  );

  // ── phase 8: chat ─────────────────────────────────────────────────────────
  //
  // Behind the same `authRequired`, and additionally behind a limiter keyed **per user**
  // rather than per IP (§2.6: `/api/chat*` → 30/min per user). The IP limiter above is still
  // the outer layer, so an unauthenticated flood is caught before it can consume a budget.
  app.use(
    '/api/chat',
    createChatRouter({
      controller: createChatController({
        chat: container.chat,
        runner: container.chatRunner,
        hub: container.sseHub,
        mentions: container.mentions,
        commands: container.slashCommands,
      }),
      authRequired,
      rateLimitPerMinute: config.RATE_LIMIT_CHAT_PER_MIN,
    }),
  );

  // ── phase 10: memory ──────────────────────────────────────────────────────
  //
  // Behind `authRequired` only. Memory is not a provider call and not billed per request, so it
  // sits on the general default limiter rather than getting a budget of its own.
  app.use(
    '/api/memory',
    createMemoryRouter({
      controller: createMemoryController({ memory: container.memory }),
      authRequired,
    }),
  );

  // ── phase 10: research ────────────────────────────────────────────────────
  //
  // Same reasoning as memory: authenticated, on the default limiter. Starting a run is the one
  // route here that costs anything, and it costs it in the worker rather than in this request —
  // the handler returns as soon as the run is handed to the queue.
  app.use(
    '/api/research',
    createResearchRouter({
      controller: createResearchController({ research: container.research }),
      authRequired,
    }),
  );

  // ── phase 11: events & scheduling ─────────────────────────────────────────
  //
  // Behind the same `authRequired` as everything else. Both are on the default limiter
  // rather than a budget of their own: ingestion writes one row and matches a handful of
  // subscriptions, and the cost of what it starts lands in the worker, not in this request.
  app.use(
    '/api/events',
    createEventsRouter({
      controller: createEventController({ events: container.eventService }),
      authRequired,
    }),
  );

  app.use(
    '/api/schedules',
    createSchedulesRouter({
      controller: createScheduleController({ schedules: container.scheduleService }),
      authRequired,
    }),
  );

  // ── phase 3, surfaced: providers and the model catalogue ──────────────────
  //
  // The vault, the gateway and the provider health sweep were built in phase 3 and had no HTTP
  // surface until now. Both sit behind the same `authRequired` as everything else, and neither
  // gets a limiter of its own: the only expensive route here is `POST /:id/sync`, which is a
  // deliberate operator action against their own vendor rather than traffic, and `POST /:id/test`
  // probes reachability rather than spending money.
  //
  // `sync` and `test` are POST because both write to the provider row — see `routes/providers.ts`.
  app.use(
    '/api/providers',
    createProvidersRouter({
      controller: createProviderController({ providers: container.providerService }),
      authRequired,
    }),
  );

  app.use(
    '/api/models',
    createModelsRouter({
      controller: createModelController({ models: container.modelService }),
      authRequired,
    }),
  );

  // ── phase 4, surfaced: the tool registry and the MCP servers ──────────────
  //
  // Same reasoning as providers and models: the services were built phases ago and the HTTP layer
  // never was. Both sit behind the shared `authRequired`.
  //
  // `POST /api/tools/:id/invoke` is the one route in this pair that can change something outside
  // the system, and it is guarded rather than merely authenticated — see `ToolService` for the
  // confirmation an effectful call requires.
  app.use(
    '/api/tools',
    createToolsRouter({
      controller: createToolController({ tools: container.toolService }),
      authRequired,
    }),
  );

  app.use(
    '/api/mcp',
    createMcpRouter({
      controller: createMcpController({ mcp: container.mcpService }),
      authRequired,
    }),
  );

  // ── phases 4 and 9, surfaced: browser and sandbox ─────────────────────────
  //
  // The last two prefixes the spec's API table names that had no route. Both sit behind the shared
  // `authRequired` and neither gets a limiter of its own — the expensive half of each already
  // happens behind a manager that bounds it (`BrowserManager`'s per-session queue and screenshot
  // cap; `SandboxService`'s per-session run chain and the worker's own resource limits).
  //
  // `POST /api/sandbox/:id/exec` runs arbitrary JavaScript and `POST /api/browser/:id/actions` can
  // click anything the session can reach. Both are POST for that reason, and both validate their
  // body as a closed shape before anything runs.
  app.use(
    '/api/browser',
    createBrowserRouter({
      controller: createBrowserController({ browser: container.browserService }),
      authRequired,
    }),
  );

  app.use(
    '/api/sandbox',
    createSandboxRouter({
      controller: createSandboxController({ sandbox: container.sandboxService }),
      authRequired,
    }),
  );

  // ── files: uploads, previews and folder grants ────────────────────────────
  //
  // The last prefix in the spec's API table. Behind the shared `authRequired`, and the upload
  // ceiling is the same `MAX_UPLOAD_MB` the body parser uses — one number rather than two that
  // could disagree about what "too big" means.
  //
  // `/api/files/grants` is declared inside the router before `/:id`; see `routes/files.ts` for why
  // that ordering is load-bearing rather than cosmetic.
  app.use(
    '/api/files',
    createFilesRouter({
      controller: createFilesController({ files: container.filesService }),
      authRequired,
      maxUploadBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
    }),
  );

  // ── connectors and skills ─────────────────────────────────────────────────
  //
  // The last two of the spec's 25 prefixes, and the only two that needed services built rather
  // than routers wired: connectors had no `ConnectorService` at all, and `Skill` had models and
  // nothing else. Both are token-only — the OAuth flow §C2 describes is deliberately not here,
  // which is the scope decision that file already records.
  app.use(
    '/api/connectors',
    createConnectorsRouter({
      controller: createConnectorController({ connectors: container.connectorService }),
      authRequired,
    }),
  );

  app.use(
    '/api/skills',
    createSkillsRouter({
      controller: createSkillController({ skills: container.skillService }),
      authRequired,
    }),
  );

  // ── phase 12: the dashboard ───────────────────────────────────────────────
  //
  // The snapshot the UI renders on load. Kept current afterwards by the stream below rather
  // than by polling — which is the spec's acceptance criterion, and the reason this endpoint
  // is a plain pull with no query parameters and no emitter of its own.
  app.use(
    '/api/dashboard',
    createDashboardRouter({
      controller: createDashboardController({ dashboard: container.dashboardService }),
      authRequired,
    }),
  );

  // ── the live tail ─────────────────────────────────────────────────────────
  //
  // Mounted after the routers above so an ordinary REST request never pays for the stream's
  // setup, and behind the same `authRequired` — the connection is authenticated once, at open.
  app.use(
    '/api/stream',
    createStreamRouter({
      controller: createStreamController({
        hub: container.sseHub,
        // The connect-time replay of unread notifications (§3.1). The service rather than the
        // repository, so the user-scoping this needs is the same predicate every other
        // notification read uses and cannot drift from it.
        notifications: container.notificationService,
        logger,
      }),
      authRequired,
    }),
  );

  app.use(notFound);
  app.use(createErrorHandler(logger));

  return app;
}
