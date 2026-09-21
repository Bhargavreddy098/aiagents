/**
 * The seed writer.
 *
 * ## Where this sits
 *
 * A seed is not a layer, it is a composition root — the same kind of file as `server.ts`. It is
 * the second (and last) place that loads configuration and builds a container, and it exists so
 * that a freshly migrated database has something in it. It is never reachable from a request.
 *
 * ## The rule for how a row is written
 *
 * **Through a repository when the row has an invariant or an identity that a service owns.**
 * An agent and its version-1 snapshot, a workflow and its first version, a goal's completion
 * pointing at the verification that established it, a tool row derived from the native registry,
 * a credential encrypted by the vault — none of those are safe to hand-write, because the
 * relationship between the rows is the thing being recorded. Those go through
 * `container.<repo>` or the service that owns them.
 *
 * **Through `db` directly when the row is a timestamped record of something that already
 * happened.** Runs, steps, tool calls, receipts, verifications and notifications are append-only
 * history in this schema, and *every* repository method that writes one stamps `new Date()` —
 * `RunRepository.create` hard-codes `status: 'queued'`, `StepRepository.markCompleted` stamps
 * `completedAt: now`, `VerificationRepository.complete` does the same. A fixture of the past
 * cannot be produced by methods whose entire purpose is to record the present. Writing those six
 * tables directly is the only way to produce a history whose timestamps agree with each other,
 * and it is why the fixture expresses every time as an offset from the seed's own clock.
 *
 * ## What it refuses to do
 *
 * It refuses to run twice. The probe is `dev@nexs.local`, which is `@unique` globally, so it
 * identifies the seeded workspace exactly and needs no new repository method. Re-running against
 * a seeded database throws rather than half-inserting a second copy of everything — a seed that
 * can silently produce a two-headed dataset is worse than one that stops.
 *
 * ## What it does not touch
 *
 * Only rows it creates. There is no delete, no truncate and no `upsert` against an existing
 * tenant anywhere in this file, so pointing it at a database that already holds real work cannot
 * damage that work: it either finds the dev account and stops, or it writes a new workspace
 * beside the existing ones.
 */
import type { Config } from '../config.js';
import { createContainer } from '../container.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import { MemoryRepository } from '../repositories/memory.repo.js';
import { toJson } from '../repositories/json.js';
import { ResearchRepository } from '../repositories/research.repo.js';
import { stepIdempotencyKey } from '../repositories/run.repo.js';
import type { WorkflowStepRow } from '../repositories/workflow.repo.js';
import { hashPassword } from '../services/auth/password.js';
import { createConnectorAdapter } from '../services/connectors/adapters/index.js';
import {
  maskToken,
  readExternalId,
  sourceOf,
} from '../services/connectors/connector.service.js';
import type { ConnectorContext } from '../services/connectors/types.js';
import { BuiltinToolService } from '../services/tools/builtin-tools.service.js';
import {
  SEED_AGENTS,
  SEED_APPROVALS,
  SEED_CONNECTORS,
  SEED_CREDENTIALS,
  SEED_GOALS,
  SEED_MARKER,
  SEED_MCP_SERVERS,
  SEED_MEMORIES,
  SEED_NOTIFICATIONS,
  SEED_PROVIDERS,
  SEED_RESEARCH,
  SEED_RUNS,
  SEED_SCHEDULES,
  SEED_TASKS,
  SEED_TENANT_NAME,
  SEED_USER,
  SEED_WORKFLOWS,
  type SeedToolRef,
  type SeedWorkflowStep,
} from './fixtures.js';

/** Raised when the dev account is already present. The CLI turns this into a friendly exit. */
export class SeedAlreadyAppliedError extends Error {
  constructor(email: string) {
    super(
      `the seed has already been applied: "${email}" exists. ` +
        'Run `pnpm db:reset` for a fresh database, or drop the "NEXS Dev" tenant first.',
    );
    this.name = 'SeedAlreadyAppliedError';
  }
}

export interface SeedDeps {
  config: Config;
  logger: Logger;
  db: Db;
  /** Overrides "now", so a test can assert the exact offsets the fixture declares. */
  now?: Date;
}

/** What was written, counted as it was written. */
export interface SeedCounts {
  tenants: number;
  users: number;
  credentials: number;
  providers: number;
  models: number;
  tools: number;
  mcpServers: number;
  connectors: number;
  connectorAccounts: number;
  agents: number;
  agentVersions: number;
  goals: number;
  tasks: number;
  workflows: number;
  workflowVersions: number;
  runs: number;
  steps: number;
  toolCalls: number;
  receipts: number;
  verifications: number;
  actions: number;
  approvals: number;
  schedules: number;
  memories: number;
  researchProjects: number;
  researchRuns: number;
  researchSources: number;
  researchFindings: number;
  notifications: number;
}

export interface SeedSummary {
  tenantId: string;
  userId: string;
  counts: SeedCounts;
}

// ── small helpers ─────────────────────────────────────────────────────────────

/**
 * Look a fixture key up, or fail loudly.
 *
 * A missing key is a broken fixture, never a row to skip. Silently dropping it would produce a
 * dataset that looks complete and is not — an agent with no model, a run pointing at nothing —
 * and the failure would surface much later as a confusing 404 in the UI.
 */
function keyed<T>(map: ReadonlyMap<string, T>, key: string, what: string): T {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(`seed: ${what} refers to "${key}", which the fixture did not define`);
  }
  return value;
}

function keyedIndex<T>(list: readonly T[], index: number, what: string): T {
  const value = list[index];
  if (value === undefined) {
    throw new Error(`seed: ${what} refers to index ${index}, which does not exist`);
  }
  return value;
}

/** The statuses that mean a run will not run again. */
const FINISHED_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timeout']);

/** How far apart the fixture places consecutive steps of a run. */
const STEP_SPACING_MS = 2_000;

/**
 * The instant a run's work finished, used to date the verification that observed it.
 *
 * A verification is an observation *about* a run, so it is stamped after the work it observed
 * rather than at the moment the run started.
 */
function runEnd(base: Date, stepCount: number): Date {
  return new Date(base.getTime() + stepCount * STEP_SPACING_MS);
}

/** Resolve a `{kind:key}` placeholder in a notification route. */
function resolveRoute(
  route: string,
  ids: {
    run: ReadonlyMap<string, string>;
    task: ReadonlyMap<string, string>;
    goal: ReadonlyMap<string, string>;
    approval: ReadonlyMap<string, string>;
  },
): string {
  const sources: Record<string, ReadonlyMap<string, string>> = {
    runKey: ids.run,
    taskKey: ids.task,
    goalKey: ids.goal,
    approvalKey: ids.approval,
  };

  return route.replace(/\{(\w+):([\w-]+)\}/g, (_match, kind: string, key: string) => {
    const source = sources[kind];
    if (source === undefined) {
      throw new Error(`seed: notification route "${route}" uses an unknown placeholder "${kind}"`);
    }
    return keyed(source, key, `notification route "${route}"`);
  });
}

function emptyCounts(): SeedCounts {
  return {
    tenants: 0,
    users: 0,
    credentials: 0,
    providers: 0,
    models: 0,
    tools: 0,
    mcpServers: 0,
    connectors: 0,
    connectorAccounts: 0,
    agents: 0,
    agentVersions: 0,
    goals: 0,
    tasks: 0,
    workflows: 0,
    workflowVersions: 0,
    runs: 0,
    steps: 0,
    toolCalls: 0,
    receipts: 0,
    verifications: 0,
    actions: 0,
    approvals: 0,
    schedules: 0,
    memories: 0,
    researchProjects: 0,
    researchRuns: 0,
    researchSources: 0,
    researchFindings: 0,
    notifications: 0,
  };
}

// ── the writer ────────────────────────────────────────────────────────────────

/**
 * Write the fixture into `deps.db`.
 *
 * Ordering is the whole of the difficulty here: every step needs the ids produced by the steps
 * before it, and two relationships in the schema are genuinely circular (a task names the
 * schedule that fires it; a schedule names the task it fires). Both are resolved by writing the
 * authoritative side first and filling in the back-reference afterwards, which is noted at the
 * two places it happens.
 */
export async function runSeed(deps: SeedDeps): Promise<SeedSummary> {
  const now = deps.now ?? new Date();
  const at = (minutesAgo: number): Date => new Date(now.getTime() - minutesAgo * 60_000);
  const inMinutes = (minutes: number): Date => new Date(now.getTime() + minutes * 60_000);
  const inDays = (days: number): Date => new Date(now.getTime() + days * 86_400_000);

  const container = createContainer({ config: deps.config, logger: deps.logger, db: deps.db });
  const counts = emptyCounts();

  // ── guard ──────────────────────────────────────────────────────────────────
  // Before anything is written. `dev@nexs.local` is unique across the whole database, so a hit
  // here means this exact fixture is already present and a second pass would double every count.
  const existing = await container.users.findByEmail(SEED_USER.email);
  if (existing !== null) throw new SeedAlreadyAppliedError(SEED_USER.email);

  // ── tenant & owner ─────────────────────────────────────────────────────────
  // The same two calls `AuthService.signup` makes, in the same order: the tenant and its first
  // user are created in one transaction, and the owner is set afterwards. Going through the
  // repository rather than inserting directly is what guarantees the dev account can log in —
  // the password is hashed by the same function the login route verifies against.
  const passwordHash = await hashPassword(SEED_USER.password);
  const { tenant, user } = await container.tenants.createWithOwner({
    tenantName: SEED_TENANT_NAME,
    email: SEED_USER.email,
    passwordHash,
    userName: SEED_USER.name,
  });
  const tenantId = tenant.id;
  await container.tenants.setOwner(tenantId, user.id);
  counts.tenants += 1;
  counts.users += 1;

  // ── credentials (vault) ────────────────────────────────────────────────────
  // The ciphertext is produced by the real `VaultService`, so these rows round-trip and the
  // masking in the UI is exercised. The plaintexts are placeholders shaped like real keys.
  const credentialIds = new Map<string, string>();
  for (const seed of SEED_CREDENTIALS) {
    const row = await container.credentials.create({
      tenantId,
      label: seed.label,
      kind: seed.kind,
      encrypted: container.vault.encrypt(seed.plaintext),
      keyPrefix: maskToken(seed.plaintext),
    });
    credentialIds.set(seed.key, row.id);
    counts.credentials += 1;
  }

  // ── providers & models ─────────────────────────────────────────────────────
  const modelIds = new Map<string, string>();
  for (const seed of SEED_PROVIDERS) {
    const provider = await container.providers.create({
      tenantId,
      name: seed.name,
      slug: seed.slug,
      type: seed.type,
      baseUrl: seed.baseUrl,
      apiKeyRef:
        seed.credentialKey === null
          ? null
          : keyed(credentialIds, seed.credentialKey, `provider "${seed.key}" credential`),
      capabilities: seed.capabilities,
      metadata: toJson({ seededBy: SEED_MARKER }),
    });
    counts.providers += 1;

    for (const model of seed.models) {
      const row = await container.models.upsert({
        tenantId,
        providerId: provider.id,
        name: model.name,
        externalModelId: model.externalModelId,
        type: model.type,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        capabilities: model.capabilities,
        metadata: toJson(model.metadata ?? {}),
      });
      modelIds.set(model.externalModelId, row.id);
      counts.models += 1;
    }

    // The honesty rule applied to the fixture: `modelCount` is a number the provider list renders,
    // so it is set from the rows just written rather than declared alongside them.
    await container.providers.setModelCount(tenantId, provider.id, seed.models.length);
  }

  // ── built-in tools ─────────────────────────────────────────────────────────
  // Derived from the native registry, never listed here. A tool with a handler and no row is
  // invisible to every agent; a row with no handler is a tool that fails when called. Letting the
  // registry be the single source of truth is what keeps the two from disagreeing.
  const builtinTools = new BuiltinToolService({
    tools: container.tools,
    native: container.nativeTools,
    logger: deps.logger,
  });
  const toolIds = new Map<string, string>();
  for (const row of await builtinTools.ensure(tenantId)) {
    toolIds.set(row.name, row.id);
    counts.tools += 1;
  }

  // ── MCP servers ────────────────────────────────────────────────────────────
  // Seeded `disconnected`, and with no cached tool list, because nothing is listening. A row
  // claiming `connected` would render a green badge over a server that cannot answer a call.
  const mcpServerIds = new Map<string, string>();
  for (const seed of SEED_MCP_SERVERS) {
    const server = await container.mcpServers.create({
      tenantId,
      name: seed.name,
      transport: seed.transport,
      command: seed.command,
      args: seed.args,
      url: seed.url,
      envRef:
        seed.envCredentialKey === null
          ? null
          : keyed(credentialIds, seed.envCredentialKey, `mcp server "${seed.key}" credential`),
    });
    mcpServerIds.set(seed.key, server.id);
    counts.mcpServers += 1;
  }

  // ── connectors ─────────────────────────────────────────────────────────────
  const connectorAccountIds = new Map<string, string>();
  /** `${connectorKey}\u0000${action}` → the tool row the registration produced. */
  const connectorToolIds = new Map<string, string>();
  for (const seed of SEED_CONNECTORS) {
    const connector = await container.connectors.create({
      tenantId,
      type: seed.type,
      name: seed.name,
      // Not `connected`: the seeded token is a placeholder and has never been accepted by the
      // vendor. `disconnected` is the honest reading of "configured but unverified".
      status: 'disconnected',
      metadata: toJson({ config: seed.config, seededBy: SEED_MARKER }),
    });
    counts.connectors += 1;

    // The capability list is asked of the adapter rather than restated in the fixture, so it
    // cannot drift from what the adapter actually declares. `discoverCapabilities` is a pure
    // function for every implemented adapter — it makes no request — which is what makes this
    // call safe in an offline seed.
    const adapter = createConnectorAdapter(seed.type);
    const context: ConnectorContext = {
      connectorId: connector.id,
      connectorType: seed.type,
      connectorName: seed.name,
      baseUrl: typeof seed.config['baseUrl'] === 'string' ? seed.config['baseUrl'] : '',
      config: seed.config,
      credentials: {
        token: '',
        authHeader: typeof seed.config['authHeader'] === 'string' ? seed.config['authHeader'] : 'authorization',
        authScheme: typeof seed.config['authScheme'] === 'string' ? seed.config['authScheme'] : 'Bearer',
      },
      fetch: globalThis.fetch,
      logger: deps.logger,
    };
    const capabilities = await adapter.discoverCapabilities(context);
    await container.connectors.setDiscovery(tenantId, connector.id, toJson(capabilities));

    const account =
      seed.credentialKey === null
        ? null
        : await container.connectorAccounts.create({
            connectorId: connector.id,
            label: seed.accountLabel,
            credentialId: keyed(credentialIds, seed.credentialKey, `connector "${seed.key}" credential`),
            scopes: [],
            status: 'active',
          });
    if (account !== null) {
      connectorAccountIds.set(seed.key, account.id);
      counts.connectorAccounts += 1;
    }

    // The projection of capabilities into `Tool` rows, run by the service that owns the rule
    // rather than reimplemented here. `registerCapabilities` is where the canonical naming and the
    // capability-asymmetry check live, and a second copy in a script would be a second, weaker
    // opinion about what removes an approval gate.
    await container.connectorService.registerCapabilities(tenantId, connector, capabilities, account);

    // Indexed by the *action*, which the row records in `metadata.externalId`, because the row's
    // `name` is a derived slug. The fixture refers to actions; this is what resolves them.
    const registered = await container.tools.listForSource(tenantId, sourceOf(connector.id));
    for (const tool of registered) {
      const action = readExternalId(tool);
      if (action !== null) connectorToolIds.set(`${seed.key}\u0000${action}`, tool.id);
    }
    counts.tools += registered.length;
  }

  /**
   * Resolve a fixture tool reference to a `Tool.id`.
   *
   * Both forms are looked up rather than constructed, so a reference the seed cannot satisfy fails
   * here with the name of the step that made it.
   */
  const resolveTool = (ref: SeedToolRef, what: string): string =>
    ref.kind === 'builtin'
      ? keyed(toolIds, ref.name, what)
      : keyed(connectorToolIds, `${ref.connectorKey}\u0000${ref.action}`, what);

  // ── agents ─────────────────────────────────────────────────────────────────
  // `AgentRepository.create` writes the version-1 snapshot and points `activeVersionId` at it in
  // one transaction, which is exactly the invariant a run depends on when it pins a version.
  const agents = new Map<string, { agentId: string; versionId: string | null }>();
  for (const seed of SEED_AGENTS) {
    const result = await container.agents.create({
      tenantId,
      name: seed.name,
      description: seed.description,
      instructions: seed.instructions,
      modelId:
        seed.modelExternalId === null
          ? null
          : keyed(modelIds, seed.modelExternalId, `agent "${seed.key}" model`),
      fallbackModelId:
        seed.fallbackModelExternalId === null
          ? null
          : keyed(modelIds, seed.fallbackModelExternalId, `agent "${seed.key}" fallback model`),
      toolIds: [
        ...seed.toolNames.map((name) =>
          resolveTool({ kind: 'builtin', name }, `agent "${seed.key}" tool`),
        ),
        ...seed.connectorTools.map((ref) =>
          resolveTool({ kind: 'connector', ...ref }, `agent "${seed.key}" connector tool`),
        ),
      ],
      // Both allowlists are configuration rather than a claim that the capability works: the MCP
      // server is disconnected and the connector's token is a placeholder. Granting them is what
      // lets the agent *attempt* the call and fail honestly at the vendor.
      mcpServerIds: seed.mcpServerKeys.map((key) =>
        keyed(mcpServerIds, key, `agent "${seed.key}" mcp server`),
      ),
      connectorAccountIds: seed.connectorKeys.map((key) =>
        keyed(connectorAccountIds, key, `agent "${seed.key}" connector account`),
      ),
      memoryEnabled: seed.memoryEnabled,
      browserAccess: seed.browserAccess,
      sandboxAccess: seed.sandboxAccess,
      approvalPolicy: toJson(seed.approvalPolicy),
      executionLimits: toJson(seed.executionLimits),
      status: seed.status,
    });
    agents.set(seed.key, { agentId: result.agent.id, versionId: result.version?.id ?? null });
    counts.agents += 1;
    if (result.version !== null) counts.agentVersions += 1;
  }

  // ── goals ──────────────────────────────────────────────────────────────────
  // A goal with a `completion` is created `active` and completed later, once the run that
  // produced its verification exists. Creating it `completed` here would mean writing the status
  // before the evidence, which is the state the schema's `completedVerificationId` exists to
  // make impossible.
  const goalIds = new Map<string, string>();
  for (const seed of SEED_GOALS) {
    const goal = await container.goals.create({
      tenantId,
      title: seed.title,
      description: seed.description,
      agentId: keyed(agents, seed.agentKey, `goal "${seed.key}" agent`).agentId,
      priority: seed.priority,
      criteria: toJson(seed.criteria),
      constraints: toJson(seed.constraints),
      deadline: seed.deadlineInDays === null ? null : inDays(seed.deadlineInDays),
      status: seed.completion === undefined ? seed.status : 'active',
    });
    goalIds.set(seed.key, goal.id);
    counts.goals += 1;
  }

  // ── workflows ──────────────────────────────────────────────────────────────
  const workflowIds = new Map<string, string>();
  const toStepRow = (step: SeedWorkflowStep): WorkflowStepRow => ({
    name: step.name,
    stepType: step.stepType,
    config: toJson(step.config),
    // `WorkflowStep` has no `toolId` column — the repository folds this into `config.toolId`, and
    // the engine resolves it there. A `tool`, `connector`, `mcp`, `browser`, `sandbox` or
    // `notification` step must name one, so the fixture names it and this resolves it.
    ...(step.tool === undefined
      ? {}
      : { toolId: resolveTool(step.tool, `workflow step "${step.name}" tool`) }),
    ...(step.dependsOn === undefined ? {} : { dependsOn: step.dependsOn }),
    ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    ...(step.onFail === undefined ? {} : { onFail: step.onFail }),
  });

  for (const seed of SEED_WORKFLOWS) {
    const created = await container.workflows.create({
      tenantId,
      name: seed.name,
      description: seed.description,
      status: seed.status,
      steps: seed.steps.map(toStepRow),
    });
    workflowIds.set(seed.key, created.workflow.id);
    counts.workflows += 1;
    counts.workflowVersions += 1;

    if (seed.revision !== undefined) {
      // `addVersion` derives the number from the current maximum and re-points `activeVersionId`
      // in the same transaction, so publishing a revision is one call and cannot leave the
      // pointer on a version that was never written.
      const revised = await container.workflows.addVersion(tenantId, created.workflow.id, {
        steps: seed.revision.steps.map(toStepRow),
      });
      if (revised === null) throw new Error(`seed: could not publish revision of "${seed.key}"`);
      counts.workflowVersions += 1;
    }
  }

  // ── tasks ──────────────────────────────────────────────────────────────────
  // `scheduleId` is left null here and filled in after the schedules are written, because a
  // schedule names its target and the two references form a cycle. The schedule's `targetId` is
  // the authoritative one; the task's `scheduleId` is a back-reference, and `TaskRepository`
  // exposes no patch for it, so the fill-in is a tenant-scoped `updateMany` below.
  const taskIds = new Map<string, string>();
  for (const seed of SEED_TASKS) {
    const task = await container.tasks.create({
      tenantId,
      title: seed.title,
      description: seed.description,
      goalId: seed.goalKey === null ? null : keyed(goalIds, seed.goalKey, `task "${seed.key}" goal`),
      agentId: keyed(agents, seed.agentKey, `task "${seed.key}" agent`).agentId,
      workflowId:
        seed.workflowKey === null
          ? null
          : keyed(workflowIds, seed.workflowKey, `task "${seed.key}" workflow`),
      status: seed.status,
      priority: seed.priority,
      triggerType: seed.triggerType,
      scheduledAt: seed.scheduledInMinutes === undefined ? null : inMinutes(seed.scheduledInMinutes),
      scheduleId: null,
      eventSubscriptionId: null,
      input: toJson(seed.input),
      idempotencyKey: null,
    });
    taskIds.set(seed.key, task.id);
    counts.tasks += 1;
  }

  // ── runs, steps, calls, receipts, verifications ─────────────────────────────
  // Written through `db` for the reason at the top of this file: these six tables record what
  // happened, and the repositories that write them stamp `new Date()`. The step clock is derived
  // from the run's start so the whole history is monotonic and internally consistent.
  const runIds = new Map<string, string>();
  const stepIdsByRun = new Map<string, string[]>();
  const verificationIdByRun = new Map<string, string>();

  for (const seed of SEED_RUNS) {
    const agent = keyed(agents, seed.agentKey, `run "${seed.key}" agent`);
    const createdAt = at(seed.createdMinutesAgo);
    const startedAt = seed.startedMinutesAgo === undefined ? null : at(seed.startedMinutesAgo);
    const completedAt =
      startedAt !== null && seed.durationMs !== undefined && FINISHED_RUN_STATUSES.has(seed.status)
        ? new Date(startedAt.getTime() + seed.durationMs)
        : null;

    const run = await deps.db.run.create({
      data: {
        tenantId,
        agentId: agent.agentId,
        agentVersionId: agent.versionId,
        goalId: seed.goalKey === undefined ? null : keyed(goalIds, seed.goalKey, `run "${seed.key}" goal`),
        taskId: seed.taskKey === undefined ? null : keyed(taskIds, seed.taskKey, `run "${seed.key}" task`),
        workflowId:
          seed.workflowKey === undefined
            ? null
            : keyed(workflowIds, seed.workflowKey, `run "${seed.key}" workflow`),
        kind: seed.kind,
        status: seed.status,
        ...(seed.plan === undefined ? {} : { plan: toJson(seed.plan) }),
        input: toJson(seed.input),
        ...(seed.output === undefined ? {} : { output: toJson(seed.output) }),
        ...(seed.error === undefined ? {} : { error: seed.error }),
        ...(seed.checkpoint === undefined ? {} : { checkpoint: toJson(seed.checkpoint) }),
        ...(startedAt === null ? {} : { startedAt }),
        ...(seed.durationMs === undefined ? {} : { durationMs: seed.durationMs }),
        ...(completedAt === null ? {} : { completedAt }),
        ...(seed.heartbeatMinutesAgo === undefined
          ? {}
          : { lastHeartbeatAt: at(seed.heartbeatMinutesAgo) }),
        // `correlationId` is the column that traces logs to a row; a seeded run gets a stable,
        // recognisable one rather than a fresh cuid, so a log line can be matched to the fixture.
        correlationId: `seed-${seed.key}`,
        createdAt,
      },
    });
    runIds.set(seed.key, run.id);
    counts.runs += 1;

    const base = startedAt ?? createdAt;
    const stepIds: string[] = [];

    for (const [index, step] of seed.steps.entries()) {
      const seq = index + 1;
      const stepStart = new Date(base.getTime() + index * STEP_SPACING_MS);
      const stepEnd = new Date(stepStart.getTime() + (step.call?.durationMs ?? 1_200));
      const finished = step.status === 'completed' || step.status === 'failed';

      const row = await deps.db.step.create({
        data: {
          runId: run.id,
          seq,
          position: index,
          name: step.name,
          description: step.description ?? null,
          stepType: step.stepType,
          toolId:
            step.tool === undefined
              ? null
              : resolveTool(step.tool, `run "${seed.key}" step "${step.name}" tool`),
          modelId:
            step.modelExternalId === undefined
              ? null
              : keyed(modelIds, step.modelExternalId, `run "${seed.key}" step "${step.name}" model`),
          status: step.status,
          ...(step.input === undefined ? {} : { input: toJson(step.input) }),
          ...(step.output === undefined ? {} : { output: toJson(step.output) }),
          ...(step.error === undefined ? {} : { error: step.error }),
          // The same triple the unique index guards, written in its readable form so a receipt
          // can cite the exact attempt that produced it.
          idempotencyKey: stepIdempotencyKey(run.id, seq, 0),
          attempt: 0,
          ...(step.status === 'pending' ? {} : { startedAt: stepStart }),
          ...(finished ? { completedAt: stepEnd } : {}),
        },
      });
      stepIds.push(row.id);
      counts.steps += 1;

      const call = step.call;
      if (call === undefined) continue;

      const toolCall = await deps.db.toolCall.create({
        data: {
          tenantId,
          runId: run.id,
          stepId: row.id,
          toolId: resolveTool(call.tool, `run "${seed.key}" tool call "${step.name}"`),
          args: toJson(call.args),
          result: toJson(call.result),
          ...(call.failedWith === undefined ? {} : { error: call.failedWith }),
          status: call.failedWith === undefined ? 'executed' : 'failed',
          sideEffect: call.sideEffect,
          durationMs: call.durationMs,
          createdAt: stepStart,
        },
      });
      counts.toolCalls += 1;

      // A receipt exists for a call that *left an effect*, which is not the same as a call that
      // succeeded: a failed write may still have written. The fixture states which calls have one
      // rather than this deriving it, because only the fixture knows what the call did.
      if (call.receipt !== undefined) {
        await deps.db.executionReceipt.create({
          data: {
            tenantId,
            toolCallId: toolCall.id,
            effect: toJson(call.receipt.effect),
            idempotencyKey: `${stepIdempotencyKey(run.id, seq, 0)}:receipt`,
            evidence: toJson(call.receipt.evidence ?? {}),
            createdAt: stepEnd,
          },
        });
        counts.receipts += 1;
      }
    }

    stepIdsByRun.set(seed.key, stepIds);

    if (seed.verification !== undefined) {
      const verification = seed.verification;
      const row = await deps.db.verification.create({
        data: {
          tenantId,
          runId: run.id,
          stepId:
            verification.stepIndex === undefined
              ? null
              : keyedIndex(stepIds, verification.stepIndex, `run "${seed.key}" verification step`),
          goalId:
            seed.goalKey === undefined
              ? null
              : keyed(goalIds, seed.goalKey, `run "${seed.key}" verification goal`),
          type: verification.type,
          scope: verification.scope,
          config: toJson(verification.config),
          passed: verification.passed,
          status: verification.passed ? 'passed' : 'failed',
          evidence: toJson(verification.evidence),
          createdAt: runEnd(base, seed.steps.length),
          completedAt: runEnd(base, seed.steps.length),
        },
      });
      verificationIdByRun.set(seed.key, row.id);
      counts.verifications += 1;
    }
  }

  // ── complete the goals that have a verification ─────────────────────────────
  // Through `GoalRepository.completeWithVerification`, which is the only writer of
  // `completedVerificationId`. This is why the goal was created `active`: the status and the
  // evidence are set together, in one statement, from a verification that already exists.
  for (const seed of SEED_GOALS) {
    if (seed.completion === undefined) continue;
    const verificationId = verificationIdByRun.get(seed.completion.runKey);
    if (verificationId === undefined) {
      throw new Error(
        `seed: goal "${seed.key}" is completed by run "${seed.completion.runKey}", ` +
          'which declares no verification',
      );
    }
    const goalId = keyed(goalIds, seed.key, 'goal');
    const runId = keyed(runIds, seed.completion.runKey, `goal "${seed.key}" completion run`);
    const run = await container.runs.findById(tenantId, runId);
    await container.goals.completeWithVerification(
      tenantId,
      goalId,
      verificationId,
      run?.completedAt ?? now,
    );
  }

  // ── approvals ──────────────────────────────────────────────────────────────
  // Two rows per approval: the `Action` is what will happen, the `Approval` is the gate on it.
  // `Approval.actionId` is unique and required, so an approval without an action cannot exist —
  // which is why the fixture declares both and the writer never creates one alone.
  const approvalIds = new Map<string, string>();
  for (const seed of SEED_APPROVALS) {
    const runId = keyed(runIds, seed.runKey, `approval "${seed.key}" run`);
    const action = await container.actions.create({
      tenantId,
      runId,
      agentId: keyed(agents, seed.agentKey, `approval "${seed.key}" agent`).agentId,
      kind: seed.action.kind,
      title: seed.action.title,
      description: seed.action.description,
      payload: toJson(seed.action.payload),
      risk: toJson(seed.action.risk),
      requiredPermissions: seed.action.requiredPermissions,
    });
    counts.actions += 1;

    const approval = await container.approvals.create({
      tenantId,
      actionId: action.id,
      title: seed.title,
      description: seed.description,
      agentId: keyed(agents, seed.agentKey, `approval "${seed.key}" agent`).agentId,
      goalId: seed.goalKey === undefined ? null : keyed(goalIds, seed.goalKey, `approval "${seed.key}" goal`),
      taskId: seed.taskKey === undefined ? null : keyed(taskIds, seed.taskKey, `approval "${seed.key}" task`),
      runId,
      stepId: keyedIndex(
        stepIdsByRun.get(seed.runKey) ?? [],
        seed.stepIndex,
        `approval "${seed.key}" step`,
      ),
      requestedAction: toJson(seed.requestedAction),
      reason: seed.reason,
      requiredPermissions: seed.requiredPermissions,
      riskInformation: toJson(seed.riskInformation),
      // In the future, so the approval is genuinely pending: an `expiresAt` in the past would be
      // swept to `expired` by the next `approval.expire` tick and the inbox would be empty.
      expiresAt: inMinutes(seed.expiresInMinutes),
      kind: seed.kind,
    });
    approvalIds.set(seed.key, approval.id);
    counts.approvals += 1;
  }

  // ── schedules ──────────────────────────────────────────────────────────────
  const scheduleIds = new Map<string, string>();
  for (const seed of SEED_SCHEDULES) {
    const targetId =
      seed.targetKind === 'workflow'
        ? keyed(workflowIds, seed.targetKey, `schedule "${seed.key}" workflow`)
        : keyed(taskIds, seed.targetKey, `schedule "${seed.key}" task`);

    const schedule = await container.schedules.create({
      tenantId,
      name: seed.name,
      kind: seed.kind,
      cron: seed.cron,
      timezone: seed.timezone,
      runAt: seed.runInMinutes === undefined ? null : inMinutes(seed.runInMinutes),
      eventSubscriptionId: null,
      targetKind: seed.targetKind,
      targetId,
      enabled: seed.enabled,
      nextFireAt: inMinutes(seed.nextFireInMinutes),
      ...(seed.deliveryTarget === null ? {} : { deliveryTarget: toJson(seed.deliveryTarget) }),
    });
    scheduleIds.set(seed.key, schedule.id);
    counts.schedules += 1;
  }

  // The back-reference half of the task/schedule cycle noted above.
  for (const seed of SEED_TASKS) {
    if (seed.scheduleKey === undefined) continue;
    await deps.db.task.updateMany({
      where: { id: keyed(taskIds, seed.key, 'task'), tenantId },
      data: { scheduleId: keyed(scheduleIds, seed.scheduleKey, `task "${seed.key}" schedule`) },
    });
  }

  // ── memory ─────────────────────────────────────────────────────────────────
  // `MemoryRepository` is constructed here rather than taken from the container because the
  // container exposes `MemoryService`, whose `create` computes an embedding — and computing one
  // would mean calling a provider. A seed must work with no network and no key.
  const memories = new MemoryRepository(deps.db);
  for (const seed of SEED_MEMORIES) {
    await memories.create({
      tenantId,
      scope: seed.scope,
      content: seed.content,
      agentId:
        seed.agentKey === null ? null : keyed(agents, seed.agentKey, `memory "${seed.key}" agent`).agentId,
      goalId: seed.goalKey === null ? null : keyed(goalIds, seed.goalKey, `memory "${seed.key}" goal`),
      taskId: seed.taskKey === null ? null : keyed(taskIds, seed.taskKey, `memory "${seed.key}" task`),
      metadata: { ...seed.metadata, seededBy: SEED_MARKER },
    });
    counts.memories += 1;
  }

  // ── research ───────────────────────────────────────────────────────────────
  // Same reasoning as memory: `ResearchService` is on the container, but the storage layer is the
  // repository, and the fixture writes storage. The completed run carries four sources and three
  // findings, two of them verified — the protocol's own acceptance criterion, so the seeded
  // project is one that *would have passed* rather than a decorative one.
  const research = new ResearchRepository(deps.db);
  for (const seed of SEED_RESEARCH) {
    const project = await research.createProject({
      tenantId,
      title: seed.title,
      question: seed.question,
      agentId: keyed(agents, seed.agentKey, `research project "${seed.key}" agent`).agentId,
    });
    counts.researchProjects += 1;

    for (const runSeed of seed.runs) {
      const created = await research.createRun(tenantId, project.id, {
        runId:
          runSeed.engineRunKey === null
            ? null
            : keyed(runIds, runSeed.engineRunKey, `research run "${runSeed.key}" engine run`),
        ...(runSeed.plan === null ? {} : { plan: runSeed.plan }),
      });
      if (created === null) throw new Error(`seed: research project "${seed.key}" vanished mid-write`);
      counts.researchRuns += 1;

      const sourceIds: string[] = [];
      for (const source of runSeed.sources) {
        const row = await research.addSource(tenantId, created.id, {
          url: source.url,
          title: source.title,
          contentRef: source.contentRef,
          credibility: source.credibility,
        });
        if (row === null) throw new Error(`seed: could not add source "${source.url}"`);
        sourceIds.push(row.id);
        counts.researchSources += 1;
      }

      for (const finding of runSeed.findings) {
        const row = await research.addFinding(tenantId, created.id, {
          claim: finding.claim,
          verified: finding.verified,
          // Provenance is the point of the table: a finding cites the sources it came from, and a
          // finding citing a source that was never collected is the failure mode this prevents.
          sourceIds: finding.sourceIndexes.map((index) =>
            keyedIndex(sourceIds, index, `finding of research run "${runSeed.key}"`),
          ),
          evidence: finding.evidence,
        });
        if (row === null) throw new Error(`seed: could not add finding to "${runSeed.key}"`);
        counts.researchFindings += 1;
      }

      await research.updateRun(tenantId, created.id, {
        status: runSeed.status,
        ...(runSeed.result === null ? {} : { result: runSeed.result }),
        ...(runSeed.status === 'completed' ? { completedAt: now } : {}),
      });
    }
  }

  // ── notifications ──────────────────────────────────────────────────────────
  // Through `db` because `createdAt` orders the list and drives the unread badge: a repository
  // that stamped `now` on all five would show them as having arrived simultaneously, which is not
  // what the fixture describes.
  for (const seed of SEED_NOTIFICATIONS) {
    await deps.db.notification.create({
      data: {
        tenantId,
        userId: user.id,
        kind: seed.kind,
        title: seed.title,
        body: seed.body,
        linkRoute: resolveRoute(seed.linkRoute ?? '', {
          run: runIds,
          task: taskIds,
          goal: goalIds,
          approval: approvalIds,
        }),
        readAt: seed.read ? at(seed.createdMinutesAgo - 1) : null,
        createdAt: at(seed.createdMinutesAgo),
      },
    });
    counts.notifications += 1;
  }

  deps.logger.info({ tenantId, email: SEED_USER.email, counts }, 'seed applied');

  return { tenantId, userId: user.id, counts };
}
