/**
 * The dev fixture, as data.
 *
 * ## Why the fixture is separated from the writer
 *
 * The spec fixes the *counts* — three agents, five tasks, eight runs, two pending approvals,
 * three schedules. Those numbers are a contract with the frontend: an empty-state branch that
 * never fires because the seed always provides data is an untested branch, and a page that
 * claims "8 runs" while rendering six is the kind of lie this project refuses everywhere else.
 * Keeping the counts in one declarative file means they can be read, compared against the spec
 * and asserted by a test without reading any of the writing code.
 *
 * ## The one thing that is not data
 *
 * Cross-references are written as **local keys** (`'researcher'`, `'weekly-report'`), never as
 * ids. A fixture that hard-coded a cuid would be unreadable and would break the moment the
 * database regenerated. `run.ts` resolves every key to the id it just wrote, and throws if a
 * key does not resolve — a dangling reference is a broken fixture, not a row to skip.
 *
 * ## Timestamps are relative, never absolute
 *
 * Every timestamp is expressed as an offset from the seed's own clock ("started 180 minutes
 * ago"), so a seeded database always looks freshly used rather than frozen on the day the
 * fixture was authored. The one exception is a cron expression, which is absolute by nature.
 */
import type {
  AgentStatus,
  GoalStatus,
  RunStatus,
  StepStatus,
  TaskStatus,
  VerifierType,
  WorkflowStatus,
  WorkflowStepType,
} from '@nexs/shared';

// ── identity ──────────────────────────────────────────────────────────────────

/** The workspace the fixture lives in. A dev database holds exactly one. */
export const SEED_TENANT_NAME = 'NEXS Dev';

/**
 * The dev account.
 *
 * The password is the spec's literal `dev-password`. It is hashed with the same `hashPassword`
 * the login route verifies against, so this account can actually sign in — a seed whose user
 * cannot log in is a seed that has not been tested.
 */
export const SEED_USER = {
  email: 'dev@nexs.local',
  password: 'dev-password',
  name: 'Dev User',
} as const;

/** The name every seeded row carries in `metadata.seededBy`, so a fixture row is identifiable. */
export const SEED_MARKER = 'nexs-seed';

// ── credentials ───────────────────────────────────────────────────────────────

/**
 * Vault rows.
 *
 * `plaintext` is a **placeholder**, and deliberately shaped like a real key so the masking in
 * the UI (`sk-d…0001`) is exercised. It is stored through `VaultService.encrypt`, so the column
 * holds a real ciphertext and the round-trip is real — but no seeded value is a usable
 * credential for anything, and none is a secret belonging to anyone.
 */
export const SEED_CREDENTIALS = [
  {
    key: 'openai',
    label: 'OpenAI API key',
    kind: 'api_key',
    plaintext: 'sk-dev-placeholder-0000000000000001',
  },
  {
    key: 'github',
    label: 'GitHub personal access token',
    kind: 'token',
    plaintext: 'ghp_devplaceholder00000000000000000001',
  },
] as const;

// ── providers & models ────────────────────────────────────────────────────────

export interface SeedModel {
  name: string;
  externalModelId: string;
  type: 'chat' | 'embedding' | 'image';
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: string[];
  metadata?: Record<string, unknown>;
}

export interface SeedProvider {
  key: string;
  name: string;
  slug: string;
  type: string;
  baseUrl: string | null;
  /** A key into `SEED_CREDENTIALS`, or `null` for a provider that needs no key (a local one). */
  credentialKey: string | null;
  capabilities: string[];
  models: SeedModel[];
}

/**
 * Two providers, chosen because they differ in exactly the way that matters: one is remote and
 * keyed, one is local and keyless. A single provider would leave the "no key needed" branch of
 * the provider form unexercised.
 */
export const SEED_PROVIDERS: SeedProvider[] = [
  {
    key: 'openai',
    name: 'OpenAI',
    slug: 'openai',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    credentialKey: 'openai',
    capabilities: ['chat', 'embedding'],
    models: [
      {
        name: 'GPT-4o',
        externalModelId: 'gpt-4o-2024-08-06',
        type: 'chat',
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        capabilities: ['chat', 'tools', 'vision'],
        metadata: { pricing: { promptPer1M: 2.5, completionPer1M: 10 } },
      },
      {
        name: 'GPT-4o mini',
        externalModelId: 'gpt-4o-mini-2024-07-18',
        type: 'chat',
        contextWindow: 128_000,
        maxOutputTokens: 16_384,
        capabilities: ['chat', 'tools'],
        metadata: { pricing: { promptPer1M: 0.15, completionPer1M: 0.6 } },
      },
      {
        name: 'Text Embedding 3 Small',
        externalModelId: 'text-embedding-3-small',
        type: 'embedding',
        contextWindow: 8_191,
        maxOutputTokens: null,
        capabilities: ['embedding'],
        // The dimension is not decoration: `Memory.embedding` is `vector(1536)`, and the
        // schema comment says it "must match the embedding model". This is that model.
        metadata: { embeddingDimension: 1536 },
      },
    ],
  },
  {
    key: 'ollama',
    name: 'Ollama (local)',
    slug: 'ollama',
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    credentialKey: null,
    capabilities: ['chat', 'embedding'],
    models: [
      {
        name: 'Llama 3.1 8B',
        externalModelId: 'llama3.1:8b',
        type: 'chat',
        contextWindow: 131_072,
        maxOutputTokens: null,
        capabilities: ['chat'],
        metadata: { pricing: { promptPer1M: 0, completionPer1M: 0 } },
      },
      {
        name: 'Nomic Embed Text',
        externalModelId: 'nomic-embed-text',
        type: 'embedding',
        contextWindow: 8_192,
        maxOutputTokens: null,
        capabilities: ['embedding'],
        metadata: { embeddingDimension: 768 },
      },
    ],
  },
];

// ── agents ────────────────────────────────────────────────────────────────────

export interface SeedAgent {
  key: string;
  name: string;
  description: string;
  instructions: string;
  /** A `SEED_PROVIDERS[].models[].externalModelId`, or `null` for "no model pinned". */
  modelExternalId: string | null;
  fallbackModelExternalId: string | null;
  /** Built-in tool names. Resolved against the rows `BuiltinToolService` derives from the registry. */
  toolNames: string[];
  /**
   * Connector actions the agent may call.
   *
   * Listed separately from `toolNames` because the engine's allowlist (`AgentContext.allowedToolIds`)
   * is a set of `Tool.id`s, and a connector's tool row does not exist until its capabilities have
   * been registered — so a connector grant is a reference to an action, resolved after registration,
   * rather than a name that could be written here.
   */
  connectorTools: { connectorKey: string; action: string }[];
  /** Keys into `SEED_MCP_SERVERS`, granted to the agent as an allowlist entry. */
  mcpServerKeys: string[];
  /** Keys into `SEED_CONNECTORS` whose account is granted to the agent. */
  connectorKeys: string[];
  memoryEnabled: boolean;
  browserAccess: boolean;
  sandboxAccess: boolean;
  approvalPolicy: Record<string, unknown>;
  executionLimits: Record<string, unknown>;
  status: AgentStatus;
}

export const SEED_AGENTS: SeedAgent[] = [
  {
    key: 'researcher',
    name: 'Researcher',
    description: 'Reads sources, keeps notes, and answers with citations.',
    instructions: [
      'You research a question and answer it with evidence.',
      '',
      'Rules:',
      '- Read at least three independent sources before drawing a conclusion.',
      '- Every claim you state must cite the source it came from.',
      '- Say "not established" rather than guessing. An unsupported answer is worse than none.',
      '- Store anything worth remembering with memory_store before you finish.',
    ].join('\n'),
    modelExternalId: 'gpt-4o-2024-08-06',
    fallbackModelExternalId: 'gpt-4o-mini-2024-07-18',
    toolNames: ['memory_store', 'memory_search', 'file_read', 'file_write'],
    connectorTools: [],
    mcpServerKeys: ['filesystem'],
    connectorKeys: [],
    memoryEnabled: true,
    browserAccess: false,
    sandboxAccess: false,
    approvalPolicy: { mode: 'risk-based' },
    executionLimits: {
      maxSteps: 50,
      maxDurationMs: 600_000,
      maxToolCalls: 100,
      maxContextTokens: 100_000,
    },
    status: 'active',
  },
  {
    key: 'operator',
    name: 'Operator',
    description: 'Runs the day-to-day jobs: syncs, reports, deploys.',
    instructions: [
      'You operate scheduled and on-demand jobs for this workspace.',
      '',
      'Rules:',
      '- A job that writes outside this workspace needs approval. Ask; do not assume.',
      '- Record what you changed. The receipt is part of the job, not an extra.',
      '- If a job fails, report the failing step and stop. Do not retry blindly.',
    ].join('\n'),
    modelExternalId: 'gpt-4o-2024-08-06',
    fallbackModelExternalId: 'llama3.1:8b',
    toolNames: ['http_request', 'calculator', 'date_time', 'file_read', 'file_write', 'notify'],
    // The triage run calls a GitHub action, and the engine's allowlist is a set of tool ids —
    // so the action has to be granted here as well as the account above.
    connectorTools: [{ connectorKey: 'github', action: 'add_issue_comment' }],
    mcpServerKeys: [],
    // Granted because the triage run calls a GitHub action. An allowlist entry is configuration,
    // not a claim that the credential works — the token here is a placeholder, and a call made
    // with it fails honestly at the vendor.
    connectorKeys: ['github'],
    memoryEnabled: true,
    browserAccess: false,
    sandboxAccess: true,
    approvalPolicy: {
      mode: 'risk-based',
      // Stated explicitly so the fixture shows a policy that is more than the default: the
      // engine reads this to decide which capabilities raise a gate.
      requireApprovalFor: ['external_side_effect', 'sandbox_exec'],
    },
    executionLimits: {
      maxSteps: 80,
      maxDurationMs: 900_000,
      maxToolCalls: 200,
      maxContextTokens: 100_000,
    },
    status: 'active',
  },
  {
    key: 'browser_scout',
    name: 'Browser Scout',
    description: 'Drives a real browser to check pages, prices and forms.',
    instructions: [
      'You inspect web pages with a browser and report what you actually saw.',
      '',
      'Rules:',
      '- Quote the page, do not paraphrase it from memory.',
      '- If a page fails to load, say so. A blank screenshot is a finding, not a result.',
      '- Never submit a form that creates an account or spends money.',
    ].join('\n'),
    modelExternalId: 'gpt-4o-mini-2024-07-18',
    fallbackModelExternalId: null,
    toolNames: ['file_write', 'date_time'],
    connectorTools: [],
    mcpServerKeys: [],
    connectorKeys: [],
    memoryEnabled: false,
    browserAccess: true,
    sandboxAccess: false,
    approvalPolicy: { mode: 'always' },
    executionLimits: {
      maxSteps: 40,
      maxDurationMs: 600_000,
      maxToolCalls: 60,
      maxContextTokens: 100_000,
    },
    // `paused` rather than `active`: a fixture where every agent is active cannot show the
    // difference between "this agent is off" and "this agent has nothing to do".
    status: 'paused',
  },
];

// ── goals ─────────────────────────────────────────────────────────────────────

export interface SeedGoal {
  key: string;
  title: string;
  description: string;
  agentKey: string;
  status: GoalStatus;
  priority: number;
  /** Machine-checkable success criteria — the `criteria` column. */
  criteria: Record<string, unknown>[];
  constraints: Record<string, unknown>[];
  /** Days from now. Negative is in the past. `null` means no deadline. */
  deadlineInDays: number | null;
  /**
   * When set, the goal is completed by the verification belonging to the named run.
   *
   * A goal reaches `completed` only through a passing `goal_criteria` verification, and that
   * verification is produced by a run — so the fixture names the run and the writer uses the
   * verification that run created. Pointing at the run rather than restating the evidence is what
   * keeps `completedVerificationId` traceable back to the thing that established it.
   */
  completion?: {
    /** A local key into `SEED_RUNS`. That run's `verification` must be `goal_criteria`. */
    runKey: string;
    claim: string;
  };
}

export const SEED_GOALS: SeedGoal[] = [
  {
    key: 'reduce-triage-latency',
    title: 'Cut issue triage latency below 30 minutes',
    description:
      'Every new issue should be labelled and routed within 30 minutes of being opened, measured over a rolling week.',
    agentKey: 'operator',
    status: 'active',
    priority: 2,
    criteria: [
      {
        type: 'http_response',
        description: 'Median time-to-label over the last 7 days is under 30 minutes.',
        config: { metric: 'median_time_to_label_minutes', operator: 'lt', threshold: 30, window: 'P7D' },
      },
      {
        type: 'tool_result',
        description: 'The triage job has run on every weekday of the window.',
        config: { tool: 'http_request', minSuccessfulRuns: 5 },
      },
    ],
    constraints: [
      { description: 'Do not label issues opened by maintainers.', kind: 'exclusion' },
      { description: 'Never close an issue automatically.', kind: 'prohibition' },
    ],
    deadlineInDays: 21,
  },
  {
    key: 'ship-v1',
    title: 'Ship the v1 control plane',
    description:
      'All fourteen build phases complete, with the verification gate green and no protected document modified.',
    agentKey: 'operator',
    status: 'completed',
    priority: 1,
    criteria: [
      {
        type: 'tool_result',
        description: 'The full test suite passes.',
        config: { command: 'pnpm test', expect: 'exit_code', value: 0 },
      },
      {
        type: 'file_exists',
        description: 'The build plan document is present and unmodified.',
        config: { path: 'nexs-build-spec.md', checksumUnchanged: true },
      },
    ],
    constraints: [{ description: 'No phase may be marked done without a green gate.', kind: 'prohibition' }],
    deadlineInDays: -1,
    completion: {
      runKey: 'goal-verification',
      claim: 'All 14 phases are implemented and the verification gate is green.',
    },
  },
];

// ── workflows ─────────────────────────────────────────────────────────────────

/**
 * What a step calls.
 *
 * A step names the thing it invokes, never the `Tool` row's name. For a built-in that is the
 * registry's name; for a connector it is the *action*, because the tool row's name is derived
 * (`canonicalToolName`) and a fixture that spelled it out would be a second, silently-diverging
 * copy of that derivation. `run.ts` resolves both forms to an id.
 */
export type SeedToolRef =
  | { kind: 'builtin'; name: string }
  | { kind: 'connector'; connectorKey: string; action: string };

export interface SeedWorkflowStep {
  name: string;
  stepType: WorkflowStepType;
  config: Record<string, unknown>;
  tool?: SeedToolRef;
  dependsOn?: string[];
  timeoutMs?: number;
  onFail?: string;
}

export interface SeedWorkflow {
  key: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  /** The first version. Every workflow has one. */
  steps: SeedWorkflowStep[];
  /**
   * An optional later version. Its presence is what makes "versioned" in the spec's list
   * mean something: a workflow with one version has never been edited.
   */
  revision?: {
    steps: SeedWorkflowStep[];
  };
}

export const SEED_WORKFLOWS: SeedWorkflow[] = [
  {
    key: 'content-pipeline',
    name: 'Content pipeline',
    description: 'Collects sources, drafts a post, checks it against the style guide, then notifies.',
    status: 'active',
    steps: [
      {
        name: 'Collect sources',
        stepType: 'tool',
        tool: { kind: 'builtin', name: 'http_request' },
        config: { method: 'GET', url: 'https://example.com/feed.xml', capability: 'read_only' },
        timeoutMs: 20_000,
      },
      {
        name: 'Draft the post',
        stepType: 'ai',
        config: {
          prompt: 'Write a 400-word post from the collected sources. Cite each factual claim.',
          maxTokens: 2_000,
        },
        dependsOn: ['Collect sources'],
        timeoutMs: 120_000,
      },
      {
        name: 'Style check',
        stepType: 'verification',
        config: { type: 'content', rules: ['citations-present', 'no-first-person', 'word-count<=500'] },
        dependsOn: ['Draft the post'],
      },
      {
        name: 'Notify the operator',
        stepType: 'notification',
        // A `notification` step resolves to the engine's `tool` step, because `notify` *is* a
        // registered native tool — so it must name one, like any other tool step.
        tool: { kind: 'builtin', name: 'notify' },
        config: { kind: 'task_completed', title: 'Draft ready for review' },
        dependsOn: ['Style check'],
        // A notification that fails should not discard a finished draft.
        onFail: 'continue',
      },
    ],
    revision: {
      steps: [
        {
          name: 'Collect sources',
          stepType: 'tool',
          tool: { kind: 'builtin', name: 'http_request' },
          config: { method: 'GET', url: 'https://example.com/feed.xml', capability: 'read_only' },
          timeoutMs: 20_000,
        },
        {
          name: 'Check the source count',
          stepType: 'condition',
          config: { expression: 'sources.length >= 3', else: 'stop' },
          dependsOn: ['Collect sources'],
        },
        {
          name: 'Draft the post',
          stepType: 'ai',
          config: {
            prompt:
              'Write a 400-word post from the collected sources. Cite each factual claim. If fewer than three sources were found, say so instead of padding.',
            maxTokens: 2_000,
          },
          dependsOn: ['Check the source count'],
          timeoutMs: 120_000,
        },
        {
          name: 'Style check',
          stepType: 'verification',
          config: { type: 'content', rules: ['citations-present', 'no-first-person', 'word-count<=500'] },
          dependsOn: ['Draft the post'],
        },
        {
          name: 'Notify the operator',
          stepType: 'notification',
          tool: { kind: 'builtin', name: 'notify' },
          config: { kind: 'task_completed', title: 'Draft ready for review' },
          dependsOn: ['Style check'],
          onFail: 'continue',
        },
      ],
    },
  },
  {
    key: 'nightly-maintenance',
    name: 'Nightly maintenance',
    description: 'Lists the runs that failed overnight, writes a report and notifies the operator.',
    status: 'draft',
    // No `sandbox` step here, and that is deliberate rather than an omission. `toPlanStepType`
    // maps `sandbox` to `tool`, so a sandbox step has to name a `Tool` row — and the built-in
    // registry registers no sandbox tool. Authoring one would produce a workflow that passes
    // validation and then fails to resolve at run time, so the fixture uses the tools that
    // actually exist.
    steps: [
      {
        name: 'List failed runs',
        stepType: 'tool',
        tool: { kind: 'builtin', name: 'http_request' },
        config: { method: 'GET', url: 'http://localhost:4000/api/runs?status=failed', capability: 'read_only' },
      },
      {
        name: 'Write the maintenance report',
        stepType: 'tool',
        tool: { kind: 'builtin', name: 'file_write' },
        config: { path: 'maintenance/nightly.md' },
        dependsOn: ['List failed runs'],
        onFail: 'continue',
      },
      {
        name: 'Report',
        stepType: 'notification',
        tool: { kind: 'builtin', name: 'notify' },
        config: { kind: 'schedule_result', title: 'Nightly maintenance finished' },
        dependsOn: ['Write the maintenance report'],
      },
    ],
  },
];

// ── tasks ─────────────────────────────────────────────────────────────────────

export interface SeedTask {
  key: string;
  title: string;
  description: string;
  goalKey: string | null;
  agentKey: string;
  workflowKey: string | null;
  status: TaskStatus;
  priority: number;
  triggerType: 'immediate' | 'scheduled' | 'recurring' | 'event' | 'manual';
  /** Minutes from now for a `scheduled` task. Ignored otherwise. */
  scheduledInMinutes?: number;
  scheduleKey?: string;
  input: Record<string, unknown>;
}

export const SEED_TASKS: SeedTask[] = [
  {
    key: 'weekly-report',
    title: 'Compile the weekly research digest',
    description: 'Summarise everything the researcher read this week into one page.',
    goalKey: null,
    agentKey: 'researcher',
    workflowKey: 'content-pipeline',
    status: 'completed',
    priority: 3,
    // `manual`, not `recurring`: a recurring trigger means a `Schedule` row exists, and no
    // schedule targets this task. It is started by hand, or as part of the content workflow.
    triggerType: 'manual',
    input: { period: 'P7D', format: 'markdown' },
  },
  {
    key: 'triage-issues',
    title: 'Triage newly opened issues',
    description: 'Label and route every issue opened since the last run.',
    goalKey: 'reduce-triage-latency',
    agentKey: 'operator',
    workflowKey: null,
    status: 'completed',
    priority: 2,
    triggerType: 'recurring',
    scheduleKey: 'nightly-sync',
    input: { since: 'last-run', labelStrategy: 'content-based' },
  },
  {
    key: 'scan-pricing',
    title: 'Scan competitor pricing pages',
    description: 'Record the current price points from the tracked competitor list.',
    goalKey: null,
    agentKey: 'researcher',
    workflowKey: null,
    status: 'running',
    priority: 3,
    triggerType: 'manual',
    input: { competitors: ['example.com', 'example.org'] },
  },
  {
    key: 'deploy-staging',
    title: 'Deploy release 0.1.0 to staging',
    description: 'Promote the tagged build and run the smoke test against it.',
    goalKey: null,
    agentKey: 'operator',
    workflowKey: null,
    status: 'waiting_approval',
    priority: 1,
    triggerType: 'manual',
    input: { tag: 'v0.1.0', environment: 'staging' },
  },
  {
    key: 'audit-site',
    title: 'Audit the marketing site',
    description: 'Check every page loads, every link resolves and the pricing table is accurate.',
    goalKey: null,
    agentKey: 'browser_scout',
    workflowKey: null,
    status: 'queued',
    priority: 4,
    triggerType: 'scheduled',
    scheduledInMinutes: 960,
    scheduleKey: 'daily-site-audit',
    input: { site: 'https://example.com', maxDepth: 2 },
  },
];

// ── runs ──────────────────────────────────────────────────────────────────────

export interface SeedToolCall {
  tool: SeedToolRef;
  args: Record<string, unknown>;
  result: unknown;
  /** Mirrors the tool's declared capabilities at the moment of the call. */
  sideEffect: boolean;
  durationMs: number;
  /** Written only for a call that left an effect — see the note in `run.ts`. */
  receipt?: { effect: Record<string, unknown>; evidence?: Record<string, unknown> };
  /** When present the call failed and no receipt is written. */
  failedWith?: string;
}

export interface SeedStep {
  name: string;
  description?: string;
  stepType: string;
  status: StepStatus;
  tool?: SeedToolRef;
  modelExternalId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  call?: SeedToolCall;
}

export interface SeedVerification {
  type: VerifierType;
  scope: 'step' | 'goal_criteria';
  config: Record<string, unknown>;
  passed: boolean;
  evidence: Record<string, unknown>;
  /** Which step this verified. Omitted for a run-level or goal-level verification. */
  stepIndex?: number;
}

export interface SeedRun {
  key: string;
  kind: 'chat' | 'task' | 'workflow' | 'goal' | 'research' | 'event';
  status: RunStatus;
  agentKey: string;
  goalKey?: string;
  taskKey?: string;
  workflowKey?: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  /** Minutes before "now" that the run was created. */
  createdMinutesAgo: number;
  /** Minutes before "now" that the run was first claimed. Absent for a run that never started. */
  startedMinutesAgo?: number;
  durationMs?: number;
  /** Set only for a run that is still alive, and always recent. */
  heartbeatMinutesAgo?: number;
  checkpoint?: Record<string, unknown>;
  plan?: Record<string, unknown>[];
  steps: SeedStep[];
  verification?: SeedVerification;
}

/**
 * Eight runs, covering seven of the nine run states.
 *
 * `planning` and `timeout` are the two that are absent, and that is a deliberate choice rather
 * than an oversight: both are transient states the engine passes through in milliseconds, so a
 * fixture that showed one sitting still would be depicting something that cannot actually
 * persist. A `cancelled` run is likewise omitted — it looks exactly like a failed one in the
 * list, and the state that distinguishes them is already carried by the error text.
 */
export const SEED_RUNS: SeedRun[] = [
  {
    key: 'weekly-digest',
    kind: 'task',
    status: 'completed',
    agentKey: 'researcher',
    taskKey: 'weekly-report',
    workflowKey: 'content-pipeline',
    createdMinutesAgo: 185,
    startedMinutesAgo: 184,
    durationMs: 42_300,
    input: { task: 'weekly-report', period: 'P7D' },
    output: {
      summary: 'Six sources read; four findings survived verification.',
      wordCount: 412,
      citations: 6,
    },
    plan: [
      { id: 's1', type: 'tool', description: 'Fetch the week’s feed', toolName: 'http_request' },
      { id: 's2', type: 'model', description: 'Draft the digest' },
      { id: 's3', type: 'tool', description: 'Write the digest to disk', toolName: 'file_write' },
      { id: 's4', type: 'verification', description: 'Check citations are present' },
    ],
    steps: [
      {
        name: 'Fetch the week’s feed',
        description: 'Read the tracked feeds and keep the entries from the last seven days.',
        stepType: 'tool',
        status: 'completed',
        tool: { kind: 'builtin', name: 'http_request' },
        input: { method: 'GET', url: 'https://example.com/feed.xml' },
        output: { status: 200, entries: 14 },
        call: {
          tool: { kind: 'builtin', name: 'http_request' },
          args: { method: 'GET', url: 'https://example.com/feed.xml' },
          result: { status: 200, entries: 14 },
          sideEffect: false,
          durationMs: 340,
        },
      },
      {
        name: 'Draft the digest',
        description: 'Summarise the fourteen entries into one page with citations.',
        stepType: 'model',
        status: 'completed',
        modelExternalId: 'gpt-4o-2024-08-06',
        input: { entries: 14, maxWords: 500 },
        output: { words: 412, citations: 6, promptTokens: 8_120, completionTokens: 610 },
      },
      {
        name: 'Write the digest to disk',
        description: 'Persist the draft so the run can be read back without the model.',
        stepType: 'tool',
        status: 'completed',
        tool: { kind: 'builtin', name: 'file_write' },
        input: { path: 'digests/2026-w38.md' },
        output: { bytes: 3_140 },
        call: {
          tool: { kind: 'builtin', name: 'file_write' },
          args: { path: 'digests/2026-w38.md', contents: '# Weekly digest\n\n…' },
          result: { bytes: 3_140 },
          sideEffect: true,
          durationMs: 45,
          receipt: {
            effect: { kind: 'file_written', path: 'digests/2026-w38.md', bytes: 3_140 },
            evidence: { sha256: 'a3f1c2…9d40', workdir: 'tenants/dev' },
          },
        },
      },
      {
        name: 'Check citations are present',
        description: 'Every factual sentence must carry a source.',
        stepType: 'verification',
        status: 'completed',
        output: { passed: true, rules: { 'citations-present': true, 'word-count<=500': true } },
      },
    ],
    verification: {
      type: 'content',
      scope: 'step',
      config: { rules: ['citations-present', 'word-count<=500'] },
      passed: true,
      evidence: { words: 412, citations: 6, checkedRules: 2 },
      stepIndex: 3,
    },
  },
  {
    key: 'issue-triage',
    kind: 'task',
    status: 'completed',
    agentKey: 'operator',
    goalKey: 'reduce-triage-latency',
    taskKey: 'triage-issues',
    createdMinutesAgo: 100,
    startedMinutesAgo: 99,
    durationMs: 18_900,
    input: { task: 'triage-issues', since: 'last-run' },
    output: { labelled: 7, routed: 7, medianMinutes: 12 },
    plan: [
      { id: 's1', type: 'tool', description: 'List untriaged issues', toolName: 'http_request' },
      { id: 's2', type: 'tool', description: 'Apply labels', toolName: 'connector:github' },
      { id: 's3', type: 'verification', description: 'Confirm every issue carries a label' },
    ],
    steps: [
      {
        name: 'List untriaged issues',
        stepType: 'tool',
        status: 'completed',
        tool: { kind: 'builtin', name: 'http_request' },
        input: { method: 'GET', url: 'https://api.github.com/repos/example/nexs/issues' },
        output: { status: 200, count: 7 },
        call: {
          tool: { kind: 'builtin', name: 'http_request' },
          args: { method: 'GET', url: 'https://api.github.com/repos/example/nexs/issues' },
          result: { status: 200, count: 7 },
          sideEffect: false,
          durationMs: 520,
        },
      },
      {
        name: 'Apply labels',
        stepType: 'connector',
        status: 'completed',
        tool: { kind: 'connector', connectorKey: 'github', action: 'add_issue_comment' },
        input: { issue: 41, body: 'Triaged: routed to the engine queue.' },
        output: { status: 201 },
        call: {
          tool: { kind: 'connector', connectorKey: 'github', action: 'add_issue_comment' },
          args: { owner: 'example', repo: 'nexs', issue_number: 41, body: 'Triaged: routed to the engine queue.' },
          result: { status: 201, id: 2_145_000_001 },
          sideEffect: true,
          durationMs: 610,
          receipt: {
            effect: { kind: 'external_write', system: 'github', resource: 'issue_comment', id: 2_145_000_001 },
            evidence: { url: 'https://api.github.com/repos/example/nexs/issues/comments/2145000001' },
          },
        },
      },
      {
        name: 'Confirm every issue carries a label',
        stepType: 'verification',
        status: 'completed',
        output: { passed: true, labelled: 7, unlabelled: 0 },
      },
    ],
    verification: {
      type: 'tool_result',
      scope: 'step',
      config: { expect: 'every issue has at least one label' },
      passed: true,
      evidence: { checked: 7, failures: 0 },
      stepIndex: 2,
    },
  },
  {
    key: 'goal-verification',
    kind: 'goal',
    status: 'completed',
    agentKey: 'operator',
    goalKey: 'ship-v1',
    createdMinutesAgo: 40,
    startedMinutesAgo: 39,
    durationMs: 6_400,
    input: { goal: 'ship-v1' },
    output: { passed: true, criteria: 2, failed: 0 },
    plan: [
      { id: 's1', type: 'tool', description: 'Run the verification gate' },
      { id: 's2', type: 'verification', description: 'Check every success criterion' },
    ],
    steps: [
      {
        name: 'Run the verification gate',
        stepType: 'sandbox',
        status: 'completed',
        input: { commands: ['pnpm lint', 'pnpm build', 'pnpm typecheck', 'pnpm test'] },
        output: { exitCode: 0, tests: 1_405 },
      },
      {
        name: 'Check every success criterion',
        stepType: 'verification',
        status: 'completed',
        output: { passed: true, criteria: 2, failed: 0 },
      },
    ],
    verification: {
      type: 'goal_criteria',
      scope: 'goal_criteria',
      config: { criteria: 2, requireAll: true },
      passed: true,
      evidence: {
        criteria: [
          { description: 'The full test suite passes.', passed: true, observed: { exitCode: 0, tests: 1_405 } },
          { description: 'The build plan document is unmodified.', passed: true, observed: { checksum: 'unchanged' } },
        ],
      },
    },
  },
  {
    key: 'nightly-sync',
    kind: 'task',
    status: 'failed',
    agentKey: 'operator',
    createdMinutesAgo: 260,
    startedMinutesAgo: 259,
    durationMs: 4_100,
    error: 'Provider "OpenAI" returned 401 — the stored credential was rejected.',
    input: { job: 'nightly-provider-sync' },
    plan: [{ id: 's1', type: 'tool', description: 'List the provider catalogue' }],
    steps: [
      {
        name: 'List the provider catalogue',
        stepType: 'tool',
        status: 'failed',
        tool: { kind: 'builtin', name: 'http_request' },
        input: { method: 'GET', url: 'https://api.openai.com/v1/models' },
        error: 'HTTP 401 Unauthorized',
        call: {
          tool: { kind: 'builtin', name: 'http_request' },
          args: { method: 'GET', url: 'https://api.openai.com/v1/models' },
          result: { status: 401, body: { error: { message: 'Incorrect API key provided' } } },
          sideEffect: false,
          durationMs: 290,
          failedWith: 'HTTP 401 Unauthorized',
        },
      },
    ],
  },
  {
    key: 'pricing-scan',
    kind: 'task',
    status: 'running',
    agentKey: 'researcher',
    taskKey: 'scan-pricing',
    createdMinutesAgo: 13,
    startedMinutesAgo: 12,
    heartbeatMinutesAgo: 1,
    input: { task: 'scan-pricing', competitors: ['example.com', 'example.org'] },
    plan: [
      { id: 's1', type: 'tool', description: 'Fetch the first pricing page' },
      { id: 's2', type: 'tool', description: 'Fetch the second pricing page' },
      { id: 's3', type: 'model', description: 'Compare the price points' },
    ],
    steps: [
      {
        name: 'Fetch the first pricing page',
        stepType: 'tool',
        status: 'completed',
        tool: { kind: 'builtin', name: 'http_request' },
        input: { method: 'GET', url: 'https://example.com/pricing' },
        output: { status: 200, bytes: 48_200 },
        call: {
          tool: { kind: 'builtin', name: 'http_request' },
          args: { method: 'GET', url: 'https://example.com/pricing' },
          result: { status: 200, bytes: 48_200 },
          sideEffect: false,
          durationMs: 430,
        },
      },
      {
        name: 'Fetch the second pricing page',
        stepType: 'tool',
        status: 'running',
        tool: { kind: 'builtin', name: 'http_request' },
        input: { method: 'GET', url: 'https://example.org/pricing' },
      },
      {
        name: 'Compare the price points',
        stepType: 'model',
        status: 'pending',
        modelExternalId: 'gpt-4o-2024-08-06',
      },
    ],
  },
  {
    key: 'staging-deploy',
    kind: 'task',
    status: 'waiting_approval',
    agentKey: 'operator',
    taskKey: 'deploy-staging',
    createdMinutesAgo: 46,
    startedMinutesAgo: 45,
    heartbeatMinutesAgo: 44,
    input: { task: 'deploy-staging', tag: 'v0.1.0', environment: 'staging' },
    checkpoint: { completedSteps: 2, awaiting: 'approval:deploy-staging' },
    plan: [
      { id: 's1', type: 'tool', description: 'Build the release artefact' },
      { id: 's2', type: 'verification', description: 'Check the artefact signature' },
      { id: 's3', type: 'tool', description: 'Promote to staging' },
      { id: 's4', type: 'tool', description: 'Smoke test staging' },
    ],
    steps: [
      {
        name: 'Build the release artefact',
        stepType: 'sandbox',
        status: 'completed',
        input: { command: 'pnpm build' },
        output: { exitCode: 0, artifact: 'nexs-server-0.1.0.tgz' },
      },
      {
        name: 'Check the artefact signature',
        stepType: 'verification',
        status: 'completed',
        output: { passed: true, sha256: 'b7d2…91ac' },
      },
      {
        name: 'Promote to staging',
        stepType: 'tool',
        status: 'waiting_approval',
        tool: { kind: 'builtin', name: 'http_request' },
        input: { method: 'POST', url: 'https://deploy.example.com/staging/promote' },
      },
      {
        name: 'Smoke test staging',
        stepType: 'tool',
        status: 'pending',
        tool: { kind: 'builtin', name: 'http_request' },
      },
    ],
  },
  {
    key: 'site-audit',
    kind: 'task',
    status: 'paused',
    agentKey: 'browser_scout',
    createdMinutesAgo: 70,
    startedMinutesAgo: 69,
    durationMs: 21_000,
    heartbeatMinutesAgo: 55,
    input: { site: 'https://example.com', maxDepth: 2 },
    checkpoint: { completedSteps: 2, pausedBy: 'operator', reason: 'waiting for the pricing page to be published' },
    plan: [
      { id: 's1', type: 'browser', description: 'Open the home page' },
      { id: 's2', type: 'tool', description: 'Save the screenshot' },
      { id: 's3', type: 'browser', description: 'Walk the pricing page' },
    ],
    steps: [
      {
        name: 'Open the home page',
        stepType: 'browser',
        status: 'completed',
        input: { url: 'https://example.com' },
        output: { title: 'Example — home', status: 200, links: 24 },
      },
      {
        name: 'Save the screenshot',
        stepType: 'tool',
        status: 'completed',
        tool: { kind: 'builtin', name: 'file_write' },
        input: { path: 'audits/home.png' },
        output: { bytes: 184_320 },
        call: {
          tool: { kind: 'builtin', name: 'file_write' },
          args: { path: 'audits/home.png', encoding: 'base64' },
          result: { bytes: 184_320 },
          sideEffect: true,
          durationMs: 88,
          receipt: {
            effect: { kind: 'file_written', path: 'audits/home.png', bytes: 184_320 },
            evidence: { sha256: 'c19e…44b7' },
          },
        },
      },
      {
        name: 'Walk the pricing page',
        stepType: 'browser',
        status: 'pending',
        input: { url: 'https://example.com/pricing' },
      },
    ],
  },
  {
    key: 'research-durable-execution',
    kind: 'research',
    status: 'queued',
    agentKey: 'researcher',
    createdMinutesAgo: 4,
    input: { question: 'What breaks first in a durable execution engine at scale?', maxSources: 6 },
    steps: [],
  },
];

// ── approvals ─────────────────────────────────────────────────────────────────

export interface SeedApproval {
  key: string;
  kind: 'tool' | 'exec';
  title: string;
  description: string;
  runKey: string;
  agentKey: string;
  goalKey?: string;
  taskKey?: string;
  /** Which step of the run the gate sits on, by index. */
  stepIndex: number;
  requestedAction: Record<string, unknown>;
  reason: string;
  requiredPermissions: string[];
  riskInformation: Record<string, unknown>;
  action: {
    kind: string;
    title: string;
    description: string;
    payload: Record<string, unknown>;
    risk: Record<string, unknown>;
    requiredPermissions: string[];
  };
  expiresInMinutes: number;
}

/**
 * Two pending approvals, one of each kind.
 *
 * The `exec` one exists because §4.4's allow-once / allow-always / deny is a different answer
 * vocabulary from a tool gate's approve / reject, and a fixture that only ever produced tool
 * gates would leave the exec path with nothing to render — and, worse, with nothing to click
 * when a developer wants to check that the owner-only guard actually refuses a non-owner.
 */
export const SEED_APPROVALS: SeedApproval[] = [
  {
    key: 'promote-staging',
    kind: 'tool',
    title: 'Promote release v0.1.0 to staging',
    description:
      'The operator wants to POST the release artefact to the staging environment. This writes outside the workspace.',
    runKey: 'staging-deploy',
    agentKey: 'operator',
    taskKey: 'deploy-staging',
    stepIndex: 2,
    requestedAction: {
      tool: 'http_request',
      arguments: { method: 'POST', url: 'https://deploy.example.com/staging/promote', body: { tag: 'v0.1.0' } },
      effects: ['external_side_effect'],
    },
    reason: 'Deploying release v0.1.0 to staging was requested manually and the agent policy gates external writes.',
    requiredPermissions: ['http_request'],
    riskInformation: {
      level: 'medium',
      reasons: [
        'Writes to an external system.',
        'The staging environment is shared with two other developers.',
      ],
      reversible: true,
      rollback: 'Re-deploy the previous tag.',
    },
    action: {
      kind: 'tool_invocation',
      title: 'POST https://deploy.example.com/staging/promote',
      description: 'Promote the tagged build to staging.',
      payload: { method: 'POST', url: 'https://deploy.example.com/staging/promote' },
      risk: { level: 'medium', reasons: ['external_side_effect'] },
      requiredPermissions: ['http_request'],
    },
    expiresInMinutes: 720,
  },
  {
    key: 'restart-worker',
    kind: 'exec',
    title: 'Restart the job worker',
    description:
      'The operator wants to run a privileged command to restart the worker process. Only the workspace owner can answer this.',
    runKey: 'nightly-sync',
    agentKey: 'operator',
    stepIndex: 0,
    requestedAction: {
      command: 'systemctl',
      args: ['restart', 'nexs-worker'],
      cwd: '/srv/nexs',
      effects: ['sandbox_exec', 'privileged_command'],
    },
    reason: 'The nightly sync failed with a stale connection; a worker restart is the documented remedy.',
    requiredPermissions: ['sandbox_exec'],
    riskInformation: {
      level: 'high',
      reasons: [
        'Runs a privileged command outside the sandbox.',
        'Interrupts any in-flight run owned by this worker.',
      ],
      reversible: false,
    },
    action: {
      kind: 'exec_command',
      title: 'systemctl restart nexs-worker',
      description: 'Restart the worker unit.',
      payload: { command: 'systemctl', args: ['restart', 'nexs-worker'] },
      risk: { level: 'high', reasons: ['privileged_command'] },
      requiredPermissions: ['sandbox_exec'],
    },
    expiresInMinutes: 120,
  },
];

// ── mcp ───────────────────────────────────────────────────────────────────────

export interface SeedMcpServer {
  key: string;
  name: string;
  transport: 'stdio' | 'streamable-http';
  command: string | null;
  args: string[];
  url: string | null;
  envCredentialKey: string | null;
}

/**
 * One MCP server, seeded `disconnected`.
 *
 * **Why not `connected`.** The row would survive a boot — `McpServerRepository.listAllWithPids`
 * only selects rows carrying a `pid`, so the orphan reaper would leave it alone — but nothing
 * would be listening, and every tool call against it would fail. A green badge over a server
 * that cannot answer is exactly the "present and broken" state the project refuses everywhere
 * else. Seeded `disconnected`, the page shows a real server with a working Connect button, and
 * a developer who presses it gets a truthful outcome either way.
 */
export const SEED_MCP_SERVERS: SeedMcpServer[] = [
  {
    key: 'filesystem',
    name: 'Filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', './data/shared'],
    url: null,
    envCredentialKey: null,
  },
];

// ── connectors ────────────────────────────────────────────────────────────────

export interface SeedConnector {
  key: string;
  type: string;
  name: string;
  /** Config that is *not* a secret — where the token goes, never what it is. */
  config: Record<string, unknown>;
  /** A key into `SEED_CREDENTIALS`, or `null` for a connector with no account yet. */
  credentialKey: string | null;
  accountLabel: string;
}

export const SEED_CONNECTORS: SeedConnector[] = [
  {
    key: 'github',
    type: 'github',
    name: 'GitHub',
    config: { baseUrl: 'https://api.github.com', authHeader: 'Authorization', authScheme: 'Bearer' },
    credentialKey: 'github',
    accountLabel: 'dev (placeholder token)',
  },
];

// ── schedules ─────────────────────────────────────────────────────────────────

export interface SeedSchedule {
  key: string;
  name: string;
  kind: 'one_time' | 'recurring' | 'event';
  cron: string | null;
  timezone: string;
  /** Minutes from now, for a `one_time` schedule. */
  runInMinutes?: number;
  targetKind: 'task' | 'workflow';
  /** A local key into `SEED_TASKS` or `SEED_WORKFLOWS`, resolved by the writer. */
  targetKey: string;
  enabled: boolean;
  /**
   * The next fire time, in minutes from now. Computed rather than cron-derived: deriving it
   * would mean running the scheduler's own cron maths inside the fixture, and a fixture that
   * disagrees with the scheduler about when the next fire is would show a wrong date.
   */
  nextFireInMinutes: number;
  deliveryTarget: Record<string, unknown> | null;
}

export const SEED_SCHEDULES: SeedSchedule[] = [
  {
    key: 'daily-content',
    name: 'Daily content pipeline',
    kind: 'recurring',
    cron: '0 7 * * *',
    // Deliberately not UTC: the timezone column exists (gap #13) because "07:00" means
    // something different to every operator, and a fixture that only ever used UTC would
    // never exercise the branch that reads it.
    timezone: 'Asia/Kolkata',
    targetKind: 'workflow',
    targetKey: 'content-pipeline',
    enabled: true,
    nextFireInMinutes: 810,
    deliveryTarget: { channelType: 'telegram', accountId: null, peerRef: '@nexs-dev' },
  },
  {
    key: 'nightly-sync',
    name: 'Nightly provider sync',
    kind: 'recurring',
    cron: '0 2 * * *',
    timezone: 'UTC',
    targetKind: 'task',
    targetKey: 'triage-issues',
    enabled: true,
    nextFireInMinutes: 840,
    deliveryTarget: null,
  },
  {
    key: 'daily-site-audit',
    name: 'Daily site audit',
    kind: 'recurring',
    cron: '30 9 * * *',
    timezone: 'Asia/Kolkata',
    targetKind: 'task',
    targetKey: 'audit-site',
    enabled: true,
    nextFireInMinutes: 960,
    deliveryTarget: null,
  },
];

// ── memory ────────────────────────────────────────────────────────────────────

export interface SeedMemory {
  key: string;
  scope: string;
  content: string;
  agentKey: string | null;
  goalKey: string | null;
  taskKey: string | null;
  metadata: Record<string, unknown>;
}

export const SEED_MEMORIES: SeedMemory[] = [
  {
    key: 'style-guide',
    scope: 'user',
    content:
      'The operator prefers British spelling and no exclamation marks in anything published. Citations are inline, never footnoted.',
    agentKey: null,
    goalKey: null,
    taskKey: null,
    metadata: { source: 'manual', confidence: 'high' },
  },
  {
    key: 'researcher-preference',
    scope: 'agent',
    content:
      'When a source is a vendor’s own documentation, record it as low credibility and look for an independent account before relying on it.',
    agentKey: 'researcher',
    goalKey: null,
    taskKey: null,
    metadata: { source: 'learned', confidence: 'medium' },
  },
  {
    key: 'triage-threshold',
    scope: 'goal',
    content:
      'Seven issues were triaged in the first run; the median time to label was 12 minutes, well inside the 30-minute target.',
    agentKey: 'operator',
    goalKey: 'reduce-triage-latency',
    taskKey: null,
    metadata: { source: 'run', runKey: 'issue-triage', confidence: 'high' },
  },
  {
    key: 'provider-401',
    scope: 'long_term',
    content:
      'The OpenAI credential was rejected on the nightly sync. The stored key is a placeholder in this environment; replace it before relying on any OpenAI model.',
    agentKey: 'operator',
    goalKey: null,
    taskKey: null,
    metadata: { source: 'run', runKey: 'nightly-sync', confidence: 'high' },
  },
  {
    key: 'digest-shape',
    scope: 'task',
    content:
      'The weekly digest is expected to be one page: a lead paragraph, then one bullet per finding, each with its source.',
    agentKey: 'researcher',
    goalKey: null,
    taskKey: 'weekly-report',
    metadata: { source: 'manual', confidence: 'medium' },
  },
  {
    key: 'scratch-competitors',
    scope: 'short_term',
    content: 'Competitor list for this scan: example.com, example.org. Both publish pricing openly.',
    agentKey: 'researcher',
    goalKey: null,
    taskKey: 'scan-pricing',
    metadata: { source: 'run', runKey: 'pricing-scan', confidence: 'low' },
  },
];

// ── research ──────────────────────────────────────────────────────────────────

export interface SeedResearch {
  key: string;
  title: string;
  question: string;
  agentKey: string;
  status: 'active' | 'completed' | 'archived';
  resultRef: string | null;
  runs: {
    key: string;
    status: 'queued' | 'running' | 'completed' | 'failed';
    /** A local key into `SEED_RUNS`, linking the research run to its engine run. */
    engineRunKey: string | null;
    plan: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    // No `createdMinutesAgo` here, unlike a run: `ResearchRun.createdAt` is stamped by the
    // repository and is not in its update patch, so declaring an age would be declaring
    // something the writer cannot honour.
    sources: { url: string; title: string; credibility: string; contentRef: string | null }[];
    findings: { claim: string; verified: boolean; sourceIndexes: number[]; evidence: Record<string, unknown>[] }[];
  }[];
}

/**
 * One project, two runs.
 *
 * The completed run carries four sources and three findings, two of them verified — which is
 * the research protocol's own acceptance criterion (≥3 sources, cited findings, ≥1 verified
 * claim, asserted end-to-end in `research.runner.test.ts`). Seeding exactly that shape means
 * the research page renders a project that *would have passed* the protocol, rather than a
 * decorative one that could not have.
 */
export const SEED_RESEARCH: SeedResearch[] = [
  {
    key: 'durable-execution',
    title: 'Durable execution patterns',
    question: 'What breaks first in a durable execution engine at scale, and what does the industry do about it?',
    agentKey: 'researcher',
    status: 'active',
    resultRef: null,
    runs: [
      {
        key: 'durable-execution-1',
        status: 'completed',
        engineRunKey: null,
        plan: {
          steps: ['decompose', 'search', 'read', 'collect', 'organise', 'verify', 'report'],
          subQuestions: [
            'How is a step’s effect recorded so a replay does not repeat it?',
            'What happens to an in-flight run when the worker dies?',
          ],
        },
        result: {
          summary:
            'The first failure mode at scale is duplicate side effects after a crash, not throughput. Idempotency keys written before the effect, plus a receipt after it, are the common remedy.',
          verifiedClaims: 2,
          totalClaims: 3,
        },
        sources: [
          {
            url: 'https://docs.temporal.io/workflows',
            title: 'Temporal — Workflow execution semantics',
            credibility: 'high',
            contentRef: 'research/durable-execution/temporal.md',
          },
          {
            url: 'https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html',
            title: 'AWS Step Functions — error handling and retries',
            credibility: 'high',
            contentRef: 'research/durable-execution/step-functions.md',
          },
          {
            url: 'https://martinfowler.com/articles/patterns-of-distributed-systems/idempotent-receiver.html',
            title: 'Idempotent Receiver — Patterns of Distributed Systems',
            credibility: 'high',
            contentRef: 'research/durable-execution/idempotent-receiver.md',
          },
          {
            url: 'https://blog.example.com/durable-execution-war-stories',
            title: 'Durable execution: war stories from a payments team',
            credibility: 'medium',
            contentRef: null,
          },
        ],
        findings: [
          {
            claim:
              'A crash between "the effect happened" and "the effect was recorded" is the dominant source of duplicate side effects; recording the intent before the effect narrows the window but does not close it.',
            verified: true,
            sourceIndexes: [0, 2],
            evidence: [
              { quote: 'Activities are retried by default; the workflow must be replay-safe.', sourceIndex: 0 },
              { quote: 'The receiver must be idempotent, because delivery is at-least-once.', sourceIndex: 2 },
            ],
          },
          {
            claim:
              'A receipt written after the effect, keyed by the same idempotency key, is what makes an interrupted effect detectable on resume rather than silently repeated.',
            verified: true,
            sourceIndexes: [1, 2],
            evidence: [
              { quote: 'Each state keeps its own retry policy and history.', sourceIndex: 1 },
              { quote: 'Store the result against the key so a repeat can be answered from the store.', sourceIndex: 2 },
            ],
          },
          {
            claim:
              'Throughput becomes the binding constraint only after the duplicate-effect problem is solved; teams that report the reverse usually have not measured replays.',
            verified: false,
            sourceIndexes: [3],
            evidence: [
              {
                quote:
                  'We stopped worrying about duplicates once the receipt table was in place, and then throughput bit us.',
                sourceIndex: 3,
              },
            ],
          },
        ],
      },
      {
        key: 'durable-execution-2',
        status: 'running',
        engineRunKey: 'research-durable-execution',
        plan: {
          steps: ['decompose', 'search', 'read'],
          subQuestions: ['Which storage layout makes the receipt lookup cheapest on resume?'],
        },
        result: null,
        sources: [
          {
            url: 'https://www.postgresql.org/docs/current/sql-createindex.html',
            title: 'PostgreSQL — CREATE INDEX',
            credibility: 'high',
            contentRef: null,
          },
          {
            url: 'https://example.com/partial-index-benchmarks',
            title: 'Partial index benchmarks for append-only receipt tables',
            credibility: 'medium',
            contentRef: null,
          },
        ],
        findings: [
          {
            claim:
              'A partial index on the receipt key, restricted to rows newer than the retention window, keeps the resume lookup proportional to the retention window rather than the table.',
            verified: false,
            sourceIndexes: [0, 1],
            evidence: [
              { quote: 'A partial index contains entries only for rows satisfying the predicate.', sourceIndex: 0 },
            ],
          },
        ],
      },
    ],
  },
];

// ── notifications ─────────────────────────────────────────────────────────────

export interface SeedNotification {
  key: string;
  kind:
    | 'approval_request'
    | 'task_completed'
    | 'task_failed'
    | 'goal_completed'
    | 'agent_failed'
    | 'connector_failed'
    | 'provider_failed'
    | 'schedule_result';
  title: string;
  body: string;
  /** A frontend route, with `{runKey}` / `{taskKey}` / `{goalKey}` / `{approvalKey}` placeholders. */
  linkRoute: string | null;
  read: boolean;
  createdMinutesAgo: number;
}

export const SEED_NOTIFICATIONS: SeedNotification[] = [
  {
    key: 'approval-pending',
    kind: 'approval_request',
    title: 'Approval needed: promote v0.1.0 to staging',
    body: 'The Operator is waiting on an external write. It will not proceed until you answer.',
    linkRoute: '/approvals/{approvalKey:promote-staging}',
    read: false,
    createdMinutesAgo: 45,
  },
  {
    key: 'provider-401',
    kind: 'provider_failed',
    title: 'OpenAI rejected the stored credential',
    body: 'The nightly sync stopped at the first step with HTTP 401. Replace the key in Settings → Providers.',
    linkRoute: '/providers',
    read: false,
    createdMinutesAgo: 258,
  },
  {
    key: 'goal-completed',
    kind: 'goal_completed',
    title: 'Goal completed: Ship the v1 control plane',
    body: 'Both success criteria passed. The completion cites the verification that established it.',
    linkRoute: '/goals/{goalKey:ship-v1}',
    read: false,
    createdMinutesAgo: 39,
  },
  {
    key: 'task-completed',
    kind: 'task_completed',
    title: 'Weekly research digest compiled',
    body: 'Six sources read, four findings survived verification, 412 words written.',
    linkRoute: '/runs/{runKey:weekly-digest}',
    read: true,
    createdMinutesAgo: 182,
  },
  {
    key: 'exec-approval',
    kind: 'approval_request',
    title: 'Approval needed: restart the job worker',
    body: 'A privileged command was requested. Only the workspace owner can answer this one.',
    linkRoute: '/approvals/{approvalKey:restart-worker}',
    read: true,
    createdMinutesAgo: 250,
  },
];
