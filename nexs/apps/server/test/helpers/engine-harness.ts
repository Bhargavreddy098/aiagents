import pino from 'pino';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanStep, RunLimits, SseFrame, ToolCapability } from '@nexs/shared';
import type { Run, Tool } from '@prisma/client';
import { toJson } from '../../src/repositories/json.js';
import { createFakeDb, type FakeDb } from './fake-db.js';
import { MCPToolRepository, ToolRepository } from '../../src/repositories/mcp.repo.js';
import { ActionRepository, ApprovalRepository } from '../../src/repositories/approval.repo.js';
import {
  ExecutionReceiptRepository,
  RunRepository,
  StepRepository,
  ToolCallRepository,
  VerificationRepository,
} from '../../src/repositories/run.repo.js';
import { createInputContextResolver } from '../../src/services/engine/default-context.js';
import {
  ExecutionEngine,
  type AgentPinPort,
  type ApprovalGate,
  type EngineEmitter,
  type RunContext,
  type RunContextResolver,
  type RunExecutionOutcome,
} from '../../src/services/engine/execution-engine.js';
import type {
  GatewayChatRequest,
  GatewayChatResult,
} from '../../src/services/gateway/model-gateway.js';
import { Planner } from '../../src/services/engine/planner.js';
import { Verifier } from '../../src/services/engine/verifier.js';
import { FileService } from '../../src/services/files/file.service.js';
import { LocalStorageService } from '../../src/services/storage/storage.service.js';
import { NativeToolRegistry, type MemoryPort } from '../../src/services/tools/native-tools.js';
import type { SearchPort } from '../../src/services/search/search-provider.js';
import { ToolInvoker } from '../../src/services/tools/tool-invoker.js';
import type { FetchCall, FetchHandler } from './gateway-harness.js';

/**
 * An engine wired over the in-memory database, with every external boundary stubbed.
 *
 * The real repositories, the real invoker, the real planner and the real verifier are all
 * present, because the properties under test — tenant scoping, the receipt-before-complete
 * ordering, the validation ladder — live in those components and stubbing them would test
 * nothing. What is stubbed is only what leaves the process: the model gateway, `fetch`,
 * MCP, the browser and the sandbox.
 *
 * The gateway stub is a plain object with a `chat` method rather than a real
 * `ModelGateway` over a fake `fetch`. That is deliberate: the gateway has its own suite,
 * and driving the engine through OpenAI-shaped HTTP bodies would bury the engine's
 * behaviour under adapter noise. The dependency is a `Pick<ModelGateway, 'chat'>` port,
 * so this is the type the engine actually declares, not a cast.
 */

export const TEST_TENANT = 'tnt_engine';
export const TEST_MODEL = 'mdl_test';

export interface ScriptedReply {
  content: string;
  /** Recorded on the result so a test can assert which model served a step. */
  modelId?: string;
}

export class ScriptedGateway {
  readonly requests: GatewayChatRequest[] = [];
  private readonly queue: ScriptedReply[] = [];
  private handler: ((request: GatewayChatRequest, index: number) => ScriptedReply | Promise<ScriptedReply>) | null =
    null;

  /** Queue replies, consumed in order. */
  reply(...contents: string[]): this {
    for (const content of contents) this.queue.push({ content });
    return this;
  }

  /** Take over completely, for replies that depend on the request. */
  onChat(
    handler: (request: GatewayChatRequest, index: number) => ScriptedReply | Promise<ScriptedReply>,
  ): this {
    this.handler = handler;
    return this;
  }

  get callCount(): number {
    return this.requests.length;
  }

  async chat(request: GatewayChatRequest): Promise<GatewayChatResult> {
    const index = this.requests.length;
    this.requests.push(request);

    const reply =
      this.handler !== null
        ? await this.handler(request, index)
        : (this.queue.shift() ?? { content: '[]' });

    return {
      content: reply.content,
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      modelId: reply.modelId ?? request.modelId,
      providerId: 'prv_test',
      attempted: [],
      costEstimate: 0,
      contextTrimmed: false,
    };
  }
}

export interface SeedToolInput {
  name: string;
  description?: string;
  type?: 'native' | 'mcp' | 'browser' | 'sandbox' | 'connector';
  source?: string;
  capabilities?: ToolCapability[];
  status?: 'enabled' | 'disabled' | 'error';
  inputSchema?: Record<string, unknown>;
  mcpServerId?: string | null;
}

export interface SeedRunInput {
  kind?: string;
  input?: unknown;
  /**
   * A partial context, and a *partial limits block* within it.
   *
   * `Partial<RunContext>` alone would only make the top-level fields optional, leaving
   * `limits` requiring all five values — so a test that wanted to exercise the step budget
   * would have to restate the four limits it does not care about, and would silently stop
   * testing the defaults. The resolver merges a partial limits block over `DEFAULT_RUN_LIMITS`
   * at runtime, so the type has to allow the same thing the code does.
   */
  context?: Partial<Omit<RunContext, 'limits'>> & { limits?: Partial<RunLimits> };
  idempotencyKey?: string | null;
  status?: string;
}

export interface EngineHarness {
  fake: FakeDb;
  engine: ExecutionEngine;
  gateway: ScriptedGateway;
  runs: RunRepository;
  steps: StepRepository;
  toolCalls: ToolCallRepository;
  receipts: ExecutionReceiptRepository;
  verifications: VerificationRepository;
  tools: ToolRepository;
  mcpTools: MCPToolRepository;
  invoker: ToolInvoker;
  nativeTools: NativeToolRegistry;
  storage: LocalStorageService;
  files: FileService;
  /** Every SSE frame the engine emitted, in order. */
  frames: SseFrame[];
  /** Every outbound HTTP request a native tool made. */
  httpCalls: FetchCall[];
  onHttp(handler: FetchHandler): void;
  seedTool(input: SeedToolInput): Promise<Tool>;
  seedRun(input?: SeedRunInput): Promise<Run>;
  /**
   * A run already parked for approval, with its plan and step row written.
   *
   * Exists because a *real* park hands control back to whoever called `executeRun` — and in
   * these tests that caller is the test itself, so resuming from the test would mean
   * resuming from inside the loop that parked. `resumeRun` is built for the other case: a
   * decision arriving from an operator, on a new call stack, while nothing else is running.
   * Seeding the parked state produces exactly that situation instead of approximating it.
   */
  seedWaitingRun(input: SeedWaitingRunInput): Promise<SeededWaitingRun>;
  run(runId: string): Promise<RunExecutionOutcome>;
  cleanup(): Promise<void>;
}

export interface SeedWaitingRunInput {
  /** The plan the run parked with. One step, `waiting_approval`, is the usual shape. */
  plan: PlanStep[];
  description?: string;
  risk?: { level: 'low' | 'medium' | 'high'; reasons: string[] };
  requiredPermissions?: string[];
  /** Step row status. Defaults to `waiting_approval`; use `running` for a step that never parked. */
  stepStatus?: string;
  /**
   * The context the resumed run resolves.
   *
   * This must carry the same `approvalPolicy` the run parked under. The default is
   * `{ mode: 'none' }` — and a run resumed with no policy simply runs its step, because
   * nothing asks for approval. That is correct behaviour, and it makes an unpolicied
   * fixture silently assert nothing about the resume path. `{ mode: 'all' }` is the
   * default here because every caller of this helper is testing an approval decision.
   */
  context?: Partial<Omit<RunContext, 'limits'>> & { limits?: Partial<RunLimits> };
}

export interface SeededWaitingRun {
  run: Run;
  stepId: string;
  /** The approval row's own id — what the inbox acts on. */
  approvalId: string;
  planStepId: string;
  /** The plan step's 0-based position, which is the row's `seq`. */
  seq: number;
}

export interface EngineHarnessOptions {
  /** Defaults to the production value of 5. */
  tenantConcurrency?: number;
  /**
   * Reuse an existing in-memory database rather than creating one.
   *
   * This is how the control-plane harness composes with this one: it builds the fake DB,
   * the repositories and the services first, then hands the same DB here so the engine
   * runs against the rows those services wrote. Two harnesses each with their own DB would
   * mean an agent created through `AgentService` was invisible to the engine.
   */
  fake?: FakeDb;
  /**
   * Replace the run-context resolver.
   *
   * Phase 6 needs `createAgentContextResolver` here so a run reads the `AgentVersion` it
   * pinned; the default resolver reads `Run.input` and would never consult the pin.
   */
  resolveContext?: RunContextResolver;
  /**
   * A memory store, so the `memory_store` / `memory_search` handlers are registered.
   *
   * Omitted by default, which is what makes the "registered only when a store exists" rule
   * testable: with no port the tools are absent from `nativeTools.list()`, and a test can assert
   * that rather than assume it.
   */
  memory?: MemoryPort;
  /**
   * A search provider, so the `web_search` handler is registered.
   *
   * Omitted by default for the same reason `memory` is: with no provider the tool is absent from
   * `nativeTools.list()`, which is the rule worth pinning — a deployment without a search key must
   * never offer a model a tool that can only fail.
   */
  search?: SearchPort;
  /** Enable agent-version pinning in the engine — the `AgentPinPort`. */
  agents?: AgentPinPort;
  /**
   * Wire an approval gate, so a run the policy judges risky writes real rows.
   *
   * Left out by default, which is how the Phase 5 tests exercise the park/resume cycle
   * without a table behind it. Phase 7 passes an `ApprovalService`, and that is the only
   * difference between "the engine knows how to ask" and "the question is recorded".
   */
  approvals?: ApprovalGate;
  /**
   * Collect SSE frames somewhere other than this harness's own array.
   *
   * The control-plane harness needs the engine's frames and `RunService`'s frames in one
   * ordered stream, because a test asserting on "what an operator sees" cares about the
   * order they arrived in, not which component emitted them.
   */
  emit?: EngineEmitter;
}

export async function createEngineHarness(
  options: EngineHarnessOptions = {},
): Promise<EngineHarness> {
  const fake = options.fake ?? createFakeDb();
  const logger = pino({ level: 'silent' });
  const root = await mkdtemp(join(tmpdir(), 'nexs-engine-'));

  const runs = new RunRepository(fake.client);
  const steps = new StepRepository(fake.client);
  const toolCalls = new ToolCallRepository(fake.client);
  const receipts = new ExecutionReceiptRepository(fake.client);
  const verifications = new VerificationRepository(fake.client);
  const tools = new ToolRepository(fake.client);
  const mcpTools = new MCPToolRepository(fake.client);
  // Only used by `seedWaitingRun`, to write the rows a real park would have written. The
  // engine itself reaches the approval table through the injected gate, never directly.
  const actionsRepo = new ActionRepository(fake.client);
  const approvalsRepo = new ApprovalRepository(fake.client);

  const files = new FileService({ root: join(root, 'tenants'), logger });
  const storage = new LocalStorageService(join(root, 'storage'));

  const httpCalls: FetchCall[] = [];
  let httpHandler: FetchHandler = () => {
    throw new Error('engine-harness: no HTTP handler registered — call onHttp() first');
  };
  const fetchStub: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: FetchCall = { url, method: init?.method ?? 'GET', headers, body: {} };
    httpCalls.push(call);
    return Promise.resolve(httpHandler(call));
  };

  const nativeTools = new NativeToolRegistry({
    files,
    fetch: fetchStub,
    logger,
    now: Date.now,
    httpMaxBytes: 4 * 1024 * 1024,
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.search === undefined ? {} : { search: options.search }),
  });

  const invoker = new ToolInvoker({
    tools,
    mcpTools,
    native: nativeTools,
    // Never reached unless a test seeds an MCP or browser tool; both throw loudly.
    mcp: {
      callTool: () => Promise.reject(new Error('engine-harness: MCP is not wired in this test')),
    },
    browser: {
      act: () => Promise.reject(new Error('engine-harness: browser is not wired in this test')),
      list: () => Promise.resolve([]),
      open: () => Promise.reject(new Error('engine-harness: browser is not wired in this test')),
    },
    // Same contract as the two above: a harness has no vault, so it cannot build a real
    // `ConnectorService`, and a test that seeds a connector tool here gets a loud failure rather
    // than a silent success. Connector invocation is covered end-to-end against a real service in
    // `connectors.http.test.ts`, which is where a credential actually exists to decrypt.
    connectors: {
      executeAction: () =>
        Promise.reject(new Error('engine-harness: connectors are not wired in this test')),
    },
    sandbox: {
      name: 'engine-harness-stub',
      run: () => Promise.reject(new Error('engine-harness: sandbox is not wired in this test')),
      dispose: () => Promise.resolve(),
    },
    storage,
    logger,
    now: Date.now,
    options: { toolResultMaxBytes: 64 * 1024 },
  });

  const gateway = new ScriptedGateway();
  const planner = new Planner({ gateway, tools, logger });
  const verifier = new Verifier({ files, browser: { act: () => Promise.reject(new Error('no browser')) }, logger });

  const frames: SseFrame[] = [];
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
    resolveContext:
      options.resolveContext ?? createInputContextResolver({ defaultModelId: TEST_MODEL }),
    logger,
    now: Date.now,
    emit: (tenantId, frame) => {
      // The two-argument shape is the production one: the tenant is what the hub routes on.
      // A harness that collected the *first* argument would silently record tenant ids where
      // tests expect frames — which is exactly the failure this wiring used to produce.
      if (options.emit !== undefined) {
        options.emit(tenantId, frame);
        return;
      }
      frames.push(frame);
    },
    browserSessions: { list: () => Promise.resolve([]) },
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    ...(options.tenantConcurrency === undefined
      ? {}
      : { options: { tenantConcurrency: options.tenantConcurrency } }),
  });

  return {
    fake,
    engine,
    gateway,
    runs,
    steps,
    toolCalls,
    receipts,
    verifications,
    tools,
    mcpTools,
    invoker,
    nativeTools,
    storage,
    files,
    frames,
    httpCalls,

    onHttp(handler) {
      httpHandler = handler;
    },

    async seedTool(input: SeedToolInput): Promise<Tool> {
      const row = await tools.upsert({
        tenantId: TEST_TENANT,
        source: input.source ?? 'builtin',
        name: input.name,
        description: input.description ?? input.name,
        type: input.type ?? 'native',
        provider: 'native',
        inputSchema: toJson(input.inputSchema ?? { type: 'object', properties: {} }),
        capabilities: input.capabilities ?? ['read_only'],
        mcpServerId: input.mcpServerId ?? null,
      });
      if (input.status !== undefined && input.status !== 'enabled') {
        await tools.setStatus(TEST_TENANT, row.id, input.status);
      }
      return row;
    },

    async seedRun(input: SeedRunInput = {}): Promise<Run> {
      const context: Record<string, unknown> = {
        modelId: TEST_MODEL,
        instructions: 'You are a test agent.',
        ...(input.context ?? {}),
      };
      const payload =
        input.input !== undefined && input.input !== null && typeof input.input === 'object'
          ? { ...(input.input as Record<string, unknown>), context }
          : { context };

      const run = await runs.create({
        tenantId: TEST_TENANT,
        kind: input.kind ?? 'task',
        input: payload,
        idempotencyKey: input.idempotencyKey ?? null,
      });

      if (input.status !== undefined && input.status !== 'queued') {
        await runs.setStatus(TEST_TENANT, run.id, input.status as never);
        const refreshed = await runs.findById(TEST_TENANT, run.id);
        return refreshed ?? run;
      }
      return run;
    },

    run(runId: string) {
      return engine.executeRun(TEST_TENANT, runId);
    },

    async seedWaitingRun(input: SeedWaitingRunInput): Promise<SeededWaitingRun> {
      const run = await runs.create({
        tenantId: TEST_TENANT,
        kind: 'task',
        input: {
          context: {
            modelId: TEST_MODEL,
            instructions: 'You are a test agent.',
            // `all` rather than `none`: see the field's comment. A resumed step must still
            // be gated, or the decision under test is never consulted.
            approvalPolicy: { mode: 'all' },
            ...(input.context ?? {}),
          },
        },
        idempotencyKey: null,
      });
      await runs.savePlan(TEST_TENANT, run.id, input.plan);

      // `planned: true` and a `startedAt` are the two fields `readCheckpoint` requires to
      // accept a checkpoint at all; without them the engine would treat the parked run as
      // never having started and re-plan from scratch.
      await runs.saveCheckpoint(TEST_TENANT, run.id, {
        nextIndex: 0,
        completedSteps: {},
        outputs: {},
        toolCallCount: 0,
        startedAt: new Date().toISOString(),
        planned: true,
      });

      const first = input.plan[0]!;
      const step = await steps.ensure({
        runId: run.id,
        seq: 0,
        position: 0,
        name: first.id,
        description: first.description,
        stepType: first.stepType,
        toolId: first.toolId ?? null,
        input: first.config,
      });
      // Defaults to the state a real park leaves behind. `running` is the alternative, for
      // a decision arriving at a step that never parked at all.
      if (input.stepStatus === 'running') {
        await steps.markRunning(run.id, step.id);
      } else {
        await steps.markWaitingApproval(run.id, step.id);
      }

      // The approval row the engine would have written, keyed on the *row* id as its
      // foreign key demands — the translation to the plan-step id is the caller's problem,
      // and is precisely what `ApprovalService.planStepIdFor` has to get right.
      //
      // An `Action` accompanies it for the same reason it does in production: the inbox
      // renders the action, and a decision mirrors back onto it.
      const risk = input.risk ?? { level: 'high' as const, reasons: ['test fixture'] };
      const requiredPermissions = [...(input.requiredPermissions ?? ['http', 'external_side_effect'])];
      const title = input.description ?? first.description;
      const expiresAt = new Date(Date.now() + 3_600_000);

      const action = await actionsRepo.create({
        tenantId: TEST_TENANT,
        runId: run.id,
        agentId: null,
        kind: 'approval',
        title,
        description: title,
        payload: { runId: run.id, stepId: step.id, title, requiredPermissions, risk },
        risk,
        requiredPermissions,
      });

      const approval = await approvalsRepo.create({
        tenantId: TEST_TENANT,
        actionId: action.id,
        title,
        description: title,
        agentId: null,
        goalId: null,
        taskId: null,
        runId: run.id,
        stepId: step.id,
        requestedAction: { runId: run.id, title, description: title, risk, requiredPermissions },
        reason: title,
        requiredPermissions,
        riskInformation: risk,
        expiresAt,
      });

      await runs.setStatus(TEST_TENANT, run.id, 'waiting_approval');
      const refreshed = await runs.findById(TEST_TENANT, run.id);

      return {
        run: refreshed ?? run,
        stepId: step.id,
        approvalId: approval.id,
        planStepId: first.id,
        seq: 0,
      };
    },

    async cleanup() {
      // Best-effort by design. This runs from every suite's `afterAll`, so a throw here is
      // reported against whichever suite happened to call it — a cleanup failure masquerading
      // as a test failure. Each harness gets its own `mkdtemp`, so a leaked directory is inert.
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** A plan body, as the model would emit it. */
export function planJson(steps: PlanStep[]): string {
  return JSON.stringify(steps);
}
