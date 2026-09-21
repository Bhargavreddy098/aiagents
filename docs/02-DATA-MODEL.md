markdown
# NEXS Data Model (Prisma)

Full schema sketch. Keep this file current as you build; migrations are the source of truth.
Gap fixes from `GAPS-AND-FIXES.md` are already included and marked with `[gap #n]`.

```prisma
// ────────────────────────── Tenancy & Auth ──────────────────────────
model Tenant {
  id        String   @id @default(cuid())
  name      String
  createdAt DateTime @default(now())
  users     User[]
  agents    Agent[]
  // ... all tenant-scoped rows carry tenantId
}

model User {
  id            String   @id @default(cuid())
  tenantId      String
  tenant        Tenant   @relation(fields: [tenantId], references: [id])
  email         String
  passwordHash  String
  name          String
  createdAt     DateTime @default(now())
  // [gap #11] refresh token family rotation
  activeTokenFamily String?
  tokenVersion  Int      @default(0)
  notifications Notification[]
  @@unique([tenantId, email])
}

// [gap #12] password reset
model PasswordReset {
  id        String   @id @default(cuid())
  userId    String
  tokenHash String
  expiresAt DateTime
  usedAt    DateTime?
  createdAt DateTime @default(now())
}

// [gap #11] refresh tokens with family + rotation
model RefreshToken {
  id        String   @id @default(cuid())
  userId    String
  family    String
  tokenHash String
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime @default(now())
}

// ────────────────────────── Models & Gateway ──────────────────────────
model Model {
  id          String   @id @default(cuid())
  tenantId    String
  provider    String            // "openai" | "anthropic" | "google" | ...
  name        String
  metadata    Json              // price per 1k tokens, maxContextTokens,
                                // structuredOutput: "native"|"tool_forcing"|"prompt",
                                // embeddingDimension (for embed models) [gap #8]
  enabled     Boolean  @default(true)
  fallbackOf String?           // fallback ordering chain [gap #20]
  createdAt   DateTime @default(now())
}

// [gap #7] cost/usage tracking — every number on screen traces here
model ModelUsage {
  id        String   @id @default(cuid())
  tenantId  String
  runId     String?
  modelId   String
  promptTokens    Int  @default(0)
  completionTokens Int @default(0)
  costEstimate    Float @default(0)   // from Model.metadata prices
  createdAt DateTime @default(now())
}

// ────────────────────────── Tools & MCP ──────────────────────────
model Tool {
  id          String   @id @default(cuid())
  tenantId    String
  source      String            // "mcp:<serverId>" | "builtin"
  name        String
  description String
  inputSchema Json              // JSON Schema for arguments
  capabilities Json              // [gap #14] { read_only: boolean, side_effect: boolean }
  mcpServerId String?
  createdAt   DateTime @default(now())
  @@unique([tenantId, source, name])
}

model McpServer {
  id          String   @id @default(cuid())
  tenantId    String
  name        String
  transport   String            // "stdio" | "streamable_http"
  command     String?           // for stdio
  url         String?           // for streamable_http
  status      String            // "stopped"|"starting"|"running"|"crashed"
  pid         Int?              // [gap #22] child process tracking
  lastError   String?
  createdAt   DateTime @default(now())
}

// ────────────────────────── Agents ──────────────────────────
model Agent {
  id             String   @id @default(cuid())
  tenantId       String
  name           String
  modelId        String?
  systemPrompt   String?
  approvalPolicy Json              // risk-based autonomy knob
  executionLimits Json             // { maxSteps, maxToolCalls, maxDurationMs } — enforce ALL THREE
  toolAllowlist  Json               // tool ids this agent may use
  status         String             // "active"|"paused"|"disabled"|"archived"
  version        Int      @default(1)
  activeVersionId String?
  archivedAt     DateTime?          // soft delete
  createdAt      DateTime @default(now())
  versions       AgentVersion[]
  runs           Run[]
}

// immutable snapshot on every update [gap #15]
model AgentVersion {
  id        String   @id @default(cuid())
  agentId   String
  version   Int
  config    Json              // full frozen config at this version
  createdAt DateTime @default(now())
  @@unique([agentId, version])
}

// ────────────────────────── Goals / Tasks / Schedules / Events ──────────────────────────
model Goal {
  id        String   @id @default(cuid())
  tenantId  String
  agentId   String
  title     String
  criteria  Json              // machine-checkable goal_criteria for the Verifier
  status    String             // draft→active→(paused|blocked)→completed|failed|cancelled
  completedVerificationId String?  // MUST reference a passing Verification
  createdAt DateTime @default(now())
}

model Task {
  id        String   @id @default(cuid())
  tenantId  String
  agentId   String
  goalId    String?
  kind      String             // "immediate"|"scheduled"|"recurring"|"event"|"manual"
  payload   Json
  scheduleId String?
  eventSubscriptionId String?
  status    String
  createdAt DateTime @default(now())
}

model Schedule {
  id          String   @id @default(cuid())
  tenantId    String
  cron        String
  timezone    String             // [gap #13] IANA tz, e.g. "Europe/Berlin"; passed to pg-boss per-schedule `tz`
  nextFireAt  DateTime           // stored UTC
  lastFiredAt DateTime?
}

model EventSubscription {
  id        String   @id @default(cuid())
  tenantId  String
  topic     String
  secret    String?              // [gap #26] HMAC verification for webhooks
  createdAt DateTime @default(now())
}

// ────────────────────────── Workflows ──────────────────────────
model Workflow {
  id          String   @id @default(cuid())
  tenantId    String
  name        String
  activeVersionId String?
  versions    WorkflowVersion[]
}

model WorkflowVersion {
  id       String   @id @default(cuid())
  workflowId String
  version  Int
  steps    WorkflowStep[]
  createdAt DateTime @default(now())
}

model WorkflowStep {
  id          String   @id @default(cuid())
  versionId   String
  stepType    String
  config      Json
  dependsOn   String[]
  retryPolicy Json
  timeoutMs   Int
  onFail      String             // "stop"|"continue"|"retry_then_stop"
}

// ────────────────────────── Execution (the heart of the system) ──────────────────────────
model Run {
  id            String   @id @default(cuid())
  tenantId      String
  agentId       String
  agentVersionId String          // [gap #15] pin the exact config version at start
  kind          String           // "task" | "workflow" | "chat_goal"
  goalId        String?
  taskId        String?
  workflowId    String?
  plan          Json             // visible structured plan: [{id, description, stepType, toolId?, config, dependsOn}]
  status        String           // queued|planning|running|waiting_approval|paused|completed|failed|cancelled
  lastHeartbeatAt DateTime?      // [gap #4] zombie-run detection
  correlationId String           // [gap #30] traces logs ↔ rows
  startedAt     DateTime?
  finishedAt    DateTime?
  steps         Step[]
  toolCalls     ToolCall[]
  verifications Verification[]
  modelUsage    ModelUsage[]
}

model Step {
  id            String   @id @default(cuid())
  runId         String
  seq           Int
  description   String
  stepType      String
  toolId        String?
  input         Json?
  output        Json?
  status        String             // pending|running|waiting_approval|completed|failed|skipped
  checkpoint    Json               // resume payload
  idempotencyKey String            // [gap #9] scope: (runId, stepId, attempt)
  retryCount    Int      @default(0)
  startedAt     DateTime?
  finishedAt    DateTime?
  toolCalls     ToolCall[]
}

// side effects recorded BEFORE step marked complete → replay-safe
model ToolCall {
  id            String   @id @default(cuid())
  runId         String
  stepId        String
  toolId        String
  args          Json
  result        Json?
  status        String             // "requested"|"executed"|"failed"
  sideEffect    Boolean  @default(false)   // [gap #14] mirrors Tool.capabilities
  createdAt     DateTime @default(now())
}

model ExecutionReceipt {
  id            String   @id @default(cuid())
  toolCallId    String
  effect        Json               // what actually happened (row written, file saved, ...)
  idempotencyKey String
  createdAt     DateTime @default(now())
  @@unique([toolCallId])
}

model Verification {
  id            String   @id @default(cuid())
  runId         String
  kind          String             // "step" | "goal_criteria"
  passed        Boolean
  evidence      Json
  createdAt     DateTime @default(now())
}

// ────────────────────────── Approvals (human-in-the-loop) ──────────────────────────
model Approval {
  id            String   @id @default(cuid())
  runId         String
  stepId        String
  requestedAction Json             // answers: what exactly will happen, to what, and why now
  riskInformation Json
  status        String             // "pending"|"approved"|"rejected"|"expired"
  decidedBy     String?
  expiresAt     DateTime           // expiry enforced by pg-boss delayed job
  createdAt     DateTime @default(now())
}

// ────────────────────────── Chat [gap #6: chat is persisted, not memory-only] ──────────────────────────
model ChatMessage {
  id        String   @id @default(cuid())
  tenantId  String
  userId    String
  agentId   String?
  runId     String?
  role      String             // "user"|"assistant"|"tool"
  content   Json
  createdAt DateTime @default(now())
}

// ────────────────────────── Memory (RAG-lite) [gap #8] ──────────────────────────
model Memory {
  id        String   @id @default(cuid())
  tenantId  String
  agentId   String?
  scope     String             // "tenant" | "agent" | "run"
  content   String
  embedding Unsupported("vector(1536)")  // dimension must match Model.metadata.embeddingDimension; validate at write time
  createdAt DateTime @default(now())
}

// [gap #8] Prisma doesn't define vector indexes natively → raw migration:
// CREATE EXTENSION IF NOT EXISTS vector;
// CREATE INDEX memory_embedding_idx ON "Memory" USING hnsw (embedding vector_cosine_ops);
// Fallback when no embedding model is configured: keyword search (ILIKE) so memory still works.

model Notification {
  id        String   @id @default(cuid())
  userId    String
  title     String
  body      String
  linkRoute String             // [gap] deep-link routing for notification clicks
  readAt    DateTime?
  createdAt DateTime @default(now())
}

// ────────────────────────── Indexes (hot paths) ──────────────────────────
// Run(tenantId, status) · Task(tenantId, status, scheduledAt)
// Notification(userId, readAt) · unique partial: one 'running' Run per agent
```

## Schema invariants

1. `Goal.status = "completed"` is refused by the service without a passing
   `goal_criteria` `Verification` reference.
2. `Run.agentVersionId` is set at creation from the agent's active version and never changes.
3. `ToolCall.sideEffect = true` rows must have an `ExecutionReceipt` before their step
   can be marked complete.
4. Embedding dimension on write must equal the embedding model's declared dimension;
   mismatch → reject, don't truncate silently.