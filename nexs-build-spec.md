markdown
# NEXS Agent Control Plane — Complete Build Specification

**Version:** 2.0 (gap-closed) · **Status:** ready for AI-agent execution · **Target:** Node 20+, TypeScript strict, pnpm monorepo

---

## 0. Rules for the implementing agent

1. **Build strictly in phase order (Phase 0 → Phase 14).** Never start a phase until every acceptance criterion of the previous phase passes. Each phase ends with working, tested, running software.
2. **Two honesty rules:**
   - Every number on screen traces to a row in the database. No hard-coded dashboard values, no fake progress bars, no lorem cards.
   - The only paths that touch a model provider, an MCP server, or the filesystem are `ModelGateway`, `MCPManager`, and `FileService`.
3. **Ownership rules (enforced by code review/tests):**
   - Only `ModelGateway` may call provider adapters.
   - Only `ExecutionEngine` may mutate run/step state.
   - Only repositories may touch Prisma.
   - Only controllers may touch HTTP.
   - Zod schemas live in `@nexs/shared`; routes validate at the boundary; no `process.env` anywhere except `config.ts`.
4. **Tenant isolation is structural:** every tenant-owned model carries `tenantId`; every repository method takes `tenantId` as its first argument and includes it in every `where` clause.
5. No new top-level dependencies without noting them in the tech-decisions table. No Redis, no Temporal/Inngest, no WebSocket (SSE only).

---

## 1. Architecture

### 1.1 System diagram

```
┌────────────────────────────────────────────────────────────────────┐
│  Browser (React SPA)                                               │
│  Vite · React Router · TanStack Query · Zustand · shadcn/ui        │
│  REST (JSON)  +  SSE (real-time events)                            │
└──────────────┬─────────────────────────────────────────────────────┘
               │
┌──────────────▼─────────────────────────────────────────────────────┐
│  API Process (Express 5)                                           │
│  Routes → Controllers → Services → Repositories → Prisma → Postgres│
│  Zod validation at the route boundary                              │
│  Auth middleware (JWT in httpOnly cookie) + tenant scoping         │
│  SSE Hub (per-tenant fan-out to connected clients)                 │
└──────┬───────────────────────────────────────────┬─────────────────┘
       │                                           │
┌──────▼───────────────────────────────────────────▼─────────────────┐
│  Worker (same codebase; in-process when WORKER_ENABLED=true,       │
│  separate process in prod)                                         │
│  pg-boss consumer · ExecutionEngine (state machine)                │
│  Scheduler (cron/one-time) · MCPManager · BrowserManager           │
│  SandboxManager · ModelGateway                                     │
└───────────────┬────────────────────────────────────────────────────┘
                │  events cross the process boundary via EventBus:
                │  InMemoryBus (single process) | PgNotifyBus (pg_notify + LISTEN)
        ┌───────┴────────┬────────────────┬──────────────┬───────────┐
        ▼                ▼                ▼              ▼           ▼
   Provider        MCP Servers      Connectors     Playwright    Sandbox
   Adapters        (stdio/HTTP)     (REST/OAuth)   (browser)     (Node worker)
   (OpenAI,        (JSON-RPC)                                    → Docker later
    Anthropic,
    Google,
    Ollama…)
```

### 1.2 Process model & event bridge (added)

- One codebase (`apps/server`), two entrypoints: `src/server.ts` (API + SSE hub) and `src/worker/index.ts` (pg-boss consumers). In development both run in one process when `WORKER_ENABLED=true`.
- **EventBus interface** — the single publish/subscribe seam used by engine, tools, browser, approvals, chat:

```ts
// services/events/event-bus.ts
export interface EventBus {
  publish(tenantId: string, name: SSEEventName, payload: unknown): void;
  subscribe(tenantId: string, handler: (e: { name: SSEEventName; payload: unknown }) => void): () => void;
}

// InMemoryBus: Map<tenantId, Set<handler>> — used when API+worker are one process.
// PgNotifyBus: publish() → SELECT pg_notify('nexs_events', json.dumps({tenantId,name,payload}));
//   the API process runs a LISTEN 'nexs_events' connection and fans out to SSE clients.
// Selection at composition root: WORKER_ENABLED ? inMemory : pgNotify (worker side).
```

- The SSE hub subscribes to the bus per tenant and writes `data: {name, payload}` frames to connected clients. Payloads are JSON-validated against the catalog in §3.1 before emission (no non-serializable values cross SSE).

### 1.3 Monorepo layout

```
nexs/
├── package.json                  # pnpm workspaces: packages/*, apps/*
├── turbo.json                    # see §2.1
├── tsconfig.base.json            # see §2.2
├── .env.example                  # see §2.3
├── docker-compose.yml            # see §2.4
├── .github/workflows/ci.yml      # see §2.5
├── data/                         # STORAGE_ROOT (gitignored; uploads, screenshots, sandbox workdirs)
├── e2e/                          # Playwright e2e specs + playwright.config.ts
├── packages/
│   └── shared/                   # @nexs/shared — ZERO runtime deps (zod only)
│       └── src/
│           ├── types/            # domain types for every entity in §3
│           ├── schemas/          # Zod request/response contracts (§3.5)
│           ├── events.ts         # SSE event catalog (§3.1)
│           └── errors.ts         # ApiError shape + error codes (§3.2)
├── apps/
│   ├── server/                   # @nexs/server
│   │   ├── src/
│   │   │   ├── server.ts         # composition root ONLY
│   │   │   ├── config.ts         # env parsing via zod — the only place that reads process.env
│   │   │   ├── http/
│   │   │   │   ├── app.ts        # express app factory (middleware chain, CORS, cookies)
│   │   │   │   ├── middleware/   # authRequired, attachTenant, rateLimit, validate, errors
│   │   │   │   └── sse.ts        # SSE hub + GET /api/stream
│   │   │   ├── routes/           # thin: parse → validate (zod) → controller
│   │   │   ├── controllers/      # thin: call service → shape response envelope
│   │   │   ├── services/
│   │   │   │   ├── auth/         # AuthService, SessionService
│   │   │   │   ├── vault/        # VaultService (AES-256-GCM)
│   │   │   │   ├── providers/    # ProviderService
│   │   │   │   ├── models/       # ModelService, ModelGateway
│   │   │   │   ├── agents/       # AgentService
│   │   │   │   ├── goals/        # GoalService
│   │   │   │   ├── tasks/        # TaskService
│   │   │   │   ├── workflows/    # WorkflowService
│   │   │   │   ├── runs/         # RunService (run creation/query)
│   │   │   │   ├── engine/       # ExecutionEngine, Planner, Verifier
│   │   │   │   ├── approvals/    # ApprovalService
│   │   │   │   ├── tools/        # ToolRegistry, ToolInvoker
│   │   │   │   ├── mcp/          # MCPManager (SDK client wrapper)
│   │   │   │   ├── connectors/   # ConnectorService + adapter registry
│   │   │   │   ├── browser/      # BrowserManager (Playwright)
│   │   │   │   ├── sandbox/      # SandboxManager + NodeWorkerProvider
│   │   │   │   ├── memory/       # MemoryService
│   │   │   │   ├── research/     # ResearchService
│   │   │   │   ├── events/       # EventIngestService, EventBus (in-memory + pg-notify)
│   │   │   │   ├── schedules/    # ScheduleService (pg-boss wrapper)
│   │   │   │   ├── chat/         # ChatService + commands/ (slash handlers)
│   │   │   │   ├── files/        # FileService (path safety, grants)
│   │   │   │   └── notifications/
│   │   │   ├── repositories/     # one file per aggregate, Prisma only
│   │   │   ├── adapters/         # provider adapters
│   │   │   │   ├── ProviderAdapter.ts   # interface
│   │   │   │   ├── openai.ts anthropic.ts google.ts
│   │   │   │   ├── openaiCompatible.ts  # groq, deepseek, xai, together, openrouter, azure, custom
│   │   │   │   ├── ollama.ts  local.ts
│   │   │   │   └── registry.ts
│   │   │   ├── worker/           # worker entry, pg-boss job definitions (§4.11)
│   │   │   ├── db/               # prisma client singleton
│   │   │   └── seed/             # seed.ts (Phase 14)
│   │   ├── prisma/schema.prisma # the full schema in §3
│   │   └── vitest.config.ts     # test DB via pgvector container, globalSetup migrate
│   └── web/                      # @nexs/web
│       └── src/
│           ├── main.tsx
│           ├── app/              # router, layout, providers (QueryClient, SSE)
│           ├── components/       # ui/ (shadcn), layout/, domain/
│           ├── features/         # chat/ agents/ goals/ tasks/ workflows/ runs/ approvals/
│           │                     # models/ tools/ mcp/ connectors/ browser/ sandbox/
│           │                     # memory/ research/ dashboard/ settings/ auth/
│           ├── lib/              # api client, sse client, query keys (§6)
│           ├── stores/           # zustand: ui (theme/sidebar), chatDraft, nav
│           └── hooks/
```

### 1.4 Technology decisions (locked — do not change without a documented note)

| Area | Choice | Why |
|---|---|---|
| Runtime | Node 20+, TS `strict` | spec |
| API | Express 5 | async route handlers: rejected promises auto-forward to error middleware |
| DB | PostgreSQL 16 + `pgvector` | semantic memory search |
| ORM | Prisma | strong typing, tenant-scoped repository pattern |
| Validation | Zod in `@nexs/shared`; `validate()` middleware in routes | single source of truth for types |
| Auth | argon2id (cost 19); access JWT 15 min + refresh token 30 d (rotated, stored hashed) in httpOnly `Secure` cookies | standard, revocable |
| Tenancy | `tenantId` on every owned row; User 1:1 Tenant at signup; tenant-scoped repository helper on every query | no cross-user leakage |
| Real-time | SSE (`GET /api/stream`) | works through any HTTP infra; all events are server→client |
| Jobs/scheduling | pg-boss | Postgres-native durable cron + one-time + delayed jobs, retries, dedupe. No Redis. `node-cron` is in-memory and dies on restart — forbidden |
| MCP | `@modelcontextprotocol/sdk` Client (`client/index.js`, `client/stdio.js`, `client/streamableHttp.js`) | official SDK; stdio + Streamable HTTP transports |
| Browser | Playwright (Chromium), one isolated `BrowserContext` per session | no cookie leakage between sessions |
| Sandbox | in-process Node worker behind `SandboxProvider` interface (`child_process.spawn`, `--resourceLimits`, timeout, cwd jail); Docker provider stubbed later | honest "development isolation" label in UI |
| Frontend | Vite + React 18 + React Router 6 + TanStack Query 5 + Zustand 4 + Tailwind 4 + shadcn/ui | spec |
| Testing | Vitest + supertest (API), MSW (frontend unit), Playwright (e2e) | spec |
| Lint/format | ESLint + Prettier + `tsc --noEmit` in CI | hygiene |

---

## 2. Foundational artifacts (literal, paste-ready)

### 2.1 `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build":     { "dependsOn": ["^build"] },
    "dev":       { "cache": false },
    "lint":      {},
    "typecheck": {},
    "test":      { "dependsOn": ["^build"] }
  }
}
```

Root `package.json` scripts: `"dev"` → `turbo dev`, `"build"`, `"lint"`, `"typecheck"`, `"test"`, `"seed"` → `pnpm --filter @nexs/server seed`. Server package: `"dev"` (tsx watch), `"build"` (tsc), `"test"` (vitest run), `"migrate"` (`prisma migrate dev`), `"generate"` (`prisma generate`), `"seed"` (`tsx src/seed/seed.ts`). Web package: standard Vite scripts + `test` (vitest + @testing-library).

### 2.2 `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true
  }
}
```

Server: extends base + `"module": "NodeNext", "moduleResolution": "NodeNext"`. Web: extends base + `"module": "ESNext", "moduleResolution": "bundler", "jsx": "react-jsx"`.

### 2.3 `.env.example` (complete)

```bash
# --- core ---
DATABASE_URL=postgresql://nexs:nexs@localhost:5432/nexs?schema=public
PORT=4000
WEB_ORIGIN=http://localhost:5173
NODE_ENV=development
LOG_LEVEL=info
TZ=UTC

# --- crypto & auth ---
# 32-byte key, base64-encoded. Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
NEXS_MASTER_KEY=<base64-32-bytes>
JWT_SECRET=<min 32 chars, random>
ACCESS_TOKEN_TTL_SEC=900          # 15 minutes
REFRESH_TOKEN_TTL_DAYS=30

# --- worker & jobs ---
WORKER_ENABLED=true               # run pg-boss consumers in the API process (dev)
PGBOSS_SCHEMA=nexs_jobs
TENANT_CONCURRENCY=5              # max concurrently 'running' runs per tenant

# --- storage & limits ---
STORAGE_ROOT=./data/storage
MAX_UPLOAD_MB=25
RATE_LIMIT_AUTH_PER_MIN=10        # per IP, /api/auth/*
RATE_LIMIT_CHAT_PER_MIN=30        # per user, /api/chat
RATE_LIMIT_DEFAULT_PER_MIN=120    # per user, everything else

# --- tests (CI) ---
DATABASE_URL_TEST=postgresql://nexs:nexs@localhost:5433/nexs_test?schema=public
```

`config.ts` — the only place `process.env` is read:

```ts
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  TZ: z.string().default('UTC'),
  JWT_SECRET: z.string().min(32),
  NEXS_MASTER_KEY: z.string().refine(k => Buffer.from(k, 'base64').length === 32,
    'NEXS_MASTER_KEY must be base64 of exactly 32 bytes'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  WORKER_ENABLED: z.coerce.boolean().default(true),
  PGBOSS_SCHEMA: z.string().default('nexs_jobs'),
  TENANT_CONCURRENCY: z.coerce.number().int().positive().default(5),
  STORAGE_ROOT: z.string().default('./data/storage'),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(25),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_CHAT_PER_MIN: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_DEFAULT_PER_MIN: z.coerce.number().int().positive().default(120),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid environment: ${parsed.error.message}`);
  return Object.freeze(parsed.data);
}
```

### 2.4 `docker-compose.yml`

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    ports: ["5432:5432"]
    environment:
      POSTGRES_USER: nexs
      POSTGRES_PASSWORD: nexs
      POSTGRES_DB: nexs
    volumes: [nexs_pg:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U nexs"]
      interval: 5s
      timeout: 3s
      retries: 12

volumes:
  nexs_pg: {}
```

### 2.5 `.github/workflows/ci.yml`

```yaml
name: ci
on: [push, pull_request]
jobs:
  build-test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env: { POSTGRES_USER: nexs, POSTGRES_PASSWORD: nexs, POSTGRES_DB: nexs_test }
        ports: ["5433:5432"]
        options: >-
          --health-cmd "pg_isready -U nexs" --health-interval 5s
          --health-timeout 3s --health-retries 12
    env:
      DATABASE_URL: postgresql://nexs:nexs@localhost:5433/nexs_test?schema=public
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test          # server vitest (migrate deploy against service DB) + web unit tests
      - run: pnpm build
```

### 2.6 Cross-cutting HTTP contracts

**Cookies**

| Cookie | Flags | Path | Purpose |
|---|---|---|---|
| `nexs_at` | HttpOnly, Secure (prod), SameSite=Lax | `/` | access JWT |
| `nexs_rt` | HttpOnly, Secure (prod), SameSite=Lax | `/api/auth` | refresh token (opaque; DB stores sha256 hash) |

**CORS:** origin = `WEB_ORIGIN` only; `credentials: true`; methods GET/POST/PATCH/DELETE; headers Content-Type, Authorization.

**Rate limits (express-rate-limit):** `/api/auth/*` → 10/min per IP; `/api/chat*` → 30/min per user; everything else → 120/min per user; `GET /api/stream` → 10 concurrent connections per IP.

**JWT access payload:** `{ sub: userId, tenantId, typ: 'access', iat, exp }`.

**Storage layout** (under `STORAGE_ROOT`):
- uploads: `<tenantId>/uploads/<attachmentId><ext>`
- browser screenshots: `<tenantId>/screenshots/<sessionId>-<ts>.png`
- sandbox workdirs: `<tenantId>/sandbox/<runId>`
- research artifacts: `<tenantId>/research/<projectId>/<runId>.json`

**Response envelope:** success → the resource or `{ data }`; error → `4xx/5xx` + `{ error: { code, message, details? } }`.

**Idempotency:** `Run.idempotencyKey` and `Task.idempotencyKey` are unique. Duplicate "start task" with the same key returns the existing run (200), never a second one. Clients generate UUIDs.

---

## 3. Database schema (complete, valid Prisma)

> Every tenant-owned model carries `tenantId`; every repository method takes it first. Leaf child rows (versions, steps, executions) are accessed only through their parent and may omit `tenantId`. **`ChatMessage` is new** (chat transcripts must be queryable by `/api/chat/messages`). Memory embeddings are stored as JSON arrays; vector search uses raw SQL (`§3.7`).

```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

// ---------- identity & tenancy ----------
model User {
  id            String   @id @default(cuid())
  email         String   @unique
  passwordHash  String
  name          String
  tenantId      String   @unique
  tenant        Tenant   @relation(fields: [tenantId], references: [id])
  refreshTokens RefreshToken[]
  notifications Notification[]
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
}
model Tenant { id String @id @default(cuid()); name String @default("Personal"); users User[] }
model RefreshToken {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id])
  tokenHash String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  createdAt DateTime  @default(now())
}

// ---------- providers & models ----------
model ModelProvider {
  id             String        @id @default(cuid())
  tenantId       String
  name           String
  slug           String
  type           String        // openai | anthropic | google | openai-compatible | custom |
                               // azure-openai | groq | mistral | deepseek | xai | together |
                               // openrouter | local | ollama
  baseUrl        String?
  apiKeyRef      String?       // → Credential.id (NEVER the raw key)
  organizationId String?
  projectId      String?
  enabled        Boolean       @default(true)
  status         String        @default("unverified") // unverified|healthy|degraded|error
  lastHealthCheck DateTime?
  lastModelSync  DateTime?
  modelCount     Int           @default(0)
  capabilities   String[]      @default([])
  metadata       Json          @default("{}")
  models         Model[]
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt
  @@unique([tenantId, slug])
}

model Credential {              // the vault row
  id        String   @id @default(cuid())
  tenantId  String
  label     String                     // "OpenAI key"
  kind      String                     // api_key | oauth | token
  encrypted String                     // v1:base64(nonce):base64(ct+tag)
  keyPrefix String                     // "sk-…abcd" for UI masking
  rotatedAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Model {
  id              String        @id @default(cuid())
  tenantId        String
  providerId      String
  name            String                        // display name
  externalModelId String                        // EXACT provider id, e.g. "gpt-4o-2024-08-06"
  type            String                        // chat | embedding | image
  status          String        @default("available") // available|unavailable|deprecated
  capabilities    String[]      @default([])    // chat|reasoning|embedding|image|video|audio|
                                               // speech_to_text|text_to_speech|realtime|moderation|
                                               // reranker|computer_use|multimodal|other
  contextWindow   Int?
  enabled         Boolean       @default(true)
  metadata        Json          @default("{}")
  provider        ModelProvider @relation(fields: [providerId], references: [id])
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
  @@unique([providerId, externalModelId])
}

model GatewayRoute {            // optional explicit routing overrides
  id              String  @id @default(cuid())
  tenantId        String
  modelId         String
  fallbackModelId String?
  priority        Int     @default(0)
  enabled         Boolean @default(true)
}

// ---------- agents ----------
model Agent {
  id                  String       @id @default(cuid())
  tenantId            String
  name                String
  description         String?
  instructions        String       @default("")
  modelId             String?              // → Model.id
  fallbackModelId     String?
  toolIds             String[]     @default([])   // → Tool.id (canonical registry only)
  mcpServerIds        String[]     @default([])
  connectorAccountIds String[]     @default([])
  memoryEnabled       Boolean      @default(true)
  browserAccess       Boolean      @default(false)
  sandboxAccess       Boolean      @default(false)
  approvalPolicy      Json         @default("{\"mode\":\"risk-based\"}") // shape in §3.4
  executionLimits     Json         @default("{\"maxSteps\":50,\"maxDurationMs\":600000,\"maxToolCalls\":100}")
  version             Int          @default(1)
  status              String       @default("draft") // draft|active|paused|disabled|archived
  versions            AgentVersion[]
  goals               Goal[]
  tasks               Task[]
  runs                Run[]
  createdAt           DateTime     @default(now())
  updatedAt           DateTime     @updatedAt
}
model AgentVersion {
  id        String   @id @default(cuid())
  agentId   String
  agent     Agent    @relation(fields: [agentId], references: [id])
  version   Int
  snapshot  Json                   // full immutable config snapshot
  createdAt DateTime @default(now())
  @@unique([agentId, version])
}

// ---------- goals / tasks / workflows ----------
model Goal {
  id              String    @id @default(cuid())
  tenantId        String
  title           String
  description     String?
  status          String    @default("draft") // draft|active|paused|blocked|completed|failed|cancelled
  priority        Int       @default(3)
  agentId         String?
  agent           Agent?    @relation(fields: [agentId], references: [id])
  successCriteria Json      @default("[]")     // [{type, config, description}] — §3.4
  constraints     Json      @default("[]")
  deadline        DateTime?
  verificationRef String?   // → Verification.id (completion evidence)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  completedAt     DateTime?
  tasks           Task[]
}

model Task {
  id             String    @id @default(cuid())
  tenantId       String
  title          String
  description    String?
  goalId         String?
  goal           Goal?     @relation(fields: [goalId], references: [id])
  agentId        String?
  agent          Agent?    @relation(fields: [agentId], references: [id])
  workflowId     String?
  status         String    @default("queued") // queued|running|paused|waiting_approval|completed|failed|cancelled
  priority       Int       @default(3)
  triggerType    String    @default("manual") // immediate|scheduled|recurring|event|manual
  scheduledAt    DateTime?
  scheduleId     String?   // → Schedule.id for recurring
  input          Json      @default("{}")
  output         Json?
  error          String?
  retryCount     Int       @default(0)
  idempotencyKey String?   @unique
  startedAt      DateTime?
  completedAt    DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
  runs           Run[]
}

model Workflow {
  id              String          @id @default(cuid())
  tenantId        String
  name            String
  description     String?
  status          String          @default("draft") // draft|active|disabled|archived
  activeVersionId String?
  versions        WorkflowVersion[]
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
}
model WorkflowVersion {
  id         String         @id @default(cuid())
  workflowId String
  workflow   Workflow       @relation(fields: [workflowId], references: [id])
  version    Int
  steps      WorkflowStep[]
  createdAt  DateTime       @default(now())
  @@unique([workflowId, version])
}
model WorkflowStep {
  id          String          @id @default(cuid())
  versionId   String
  version     WorkflowVersion @relation(fields: [versionId], references: [id])
  position    Int
  name        String
  type        String          // ai|tool|connector|mcp|browser|sandbox|approval|condition|verification|transform|notification
  config      Json            // type-specific: {modelId, prompt} | {toolId, args} | {expr} | …
  dependsOn   String[]        @default([])
  retryPolicy Json            @default("{\"maxRetries\":2,\"backoffMs\":1000}")
  timeoutMs   Int?
  onFail      String          @default("stop") // stop|continue|retry
}

// ---------- events ----------
model Event {
  id              String              @id @default(cuid())
  tenantId        String
  type            String
  source          String
  subject         String?
  payload         Json
  metadata        Json                @default("{}")
  occurredAt      DateTime            @default(now())
  processedAt     DateTime?
  subscriptions   EventSubscription[]
}
model EventSubscription {
  id           String  @id @default(cuid())
  tenantId     String
  eventType    String
  filter       Json    @default("{}")   // partial match on {source, subject}
  targetKind   String  // goal|task|workflow|agent
  targetId     String
  enabled      Boolean @default(true)
  eventId      String?
  event        Event?  @relation(fields: [eventId], references: [id])
}

// ---------- actions & approvals ----------
model Action {
  id                  String    @id @default(cuid())
  tenantId            String
  runId               String?
  agentId             String?
  kind                String
  title               String
  description         String?
  payload             Json
  risk                Json      @default("{}")   // { level: low|medium|high, reasons: [] }
  requiredPermissions String[]  @default([])     // vocabulary in §3.4
  status              String    @default("pending") // pending|approved|rejected|executed|expired
  approvalId          String?   @unique
  approval            Approval? @relation(fields: [approvalId], references: [id])
  createdAt           DateTime  @default(now())
}
model Approval {
  id                  String    @id @default(cuid())
  tenantId            String
  actionId            String    @unique
  action              Action    @relation(fields: [actionId], references: [id])
  title               String
  description         String?
  agentId             String?
  goalId              String?
  taskId              String?
  runId               String?
  requestedAction     Json
  reason              String?
  requiredPermissions String[]  @default([])
  riskInformation     Json      @default("{}")
  status              String    @default("pending") // pending|approved|rejected|expired
  decidedBy           String?
  decidedAt           DateTime?
  createdAt           DateTime  @default(now())
  expiresAt           DateTime?
}

// ---------- runs (the execution core) ----------
model Run {
  id             String   @id @default(cuid())
  tenantId       String
  agentId        String?
  agent          Agent?   @relation(fields: [agentId], references: [id])
  goalId         String?
  taskId         String?
  task           Task?    @relation(fields: [taskId], references: [id])
  workflowId     String?
  kind           String   @default("task") // chat|task|workflow|goal|research|event
  status         String   @default("queued") // queued|planning|running|waiting_approval|paused|completed|failed|cancelled|timeout
  plan           Json?    // PlanStep[] — visible plan, NOT raw chain-of-thought (§3.4)
  input          Json     @default("{}")
  output         Json?
  error          String?
  idempotencyKey String?  @unique
  checkpoint     Json?    // Checkpoint shape in §3.4 — engine resume state
  startedAt      DateTime?
  completedAt    DateTime?
  durationMs     Int?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  steps          RunStep[]
  receipts       ExecutionReceipt[]
  chatMessages   ChatMessage[]
  @@index([tenantId, status])
}
model RunStep {
  id             String    @id @default(cuid())
  runId          String
  run            Run       @relation(fields: [runId], references: [id])
  position       Int
  type           String    // plan|model|tool|mcp|connector|browser|sandbox|approval|verification|transform|notification
  name           String
  status         String    @default("pending") // pending|running|waiting_approval|completed|failed|skipped
  input          Json?
  output         Json?
  error          String?
  toolId         String?
  modelId        String?
  verificationId String?
  startedAt      DateTime?
  completedAt    DateTime?
  retryCount     Int       @default(0)
  idempotencyKey String?   @unique
}
model ToolCall {
  id         String   @id @default(cuid())
  tenantId   String
  runId      String?
  stepId     String?
  toolId     String
  tool       Tool     @relation(fields: [toolId], references: [id])
  args       Json
  result     Json?
  error      String?
  status     String   @default("running") // running|completed|failed
  durationMs Int?
  createdAt  DateTime @default(now())
  @@index([runId])
}

// ---------- chat (added) ----------
model ChatMessage {
  id            String   @id @default(cuid())
  tenantId      String
  runId         String?  // set when the message produced a run (tool loop)
  role          String   // user | assistant
  content       String
  toolCalls     Json?    // [{ name, args, result?, ok }] transcript for the UI
  attachmentIds String[] @default([])
  createdAt     DateTime @default(now())
  @@index([tenantId, createdAt])
}

// ---------- verification & receipts ----------
model Verification {
  id         String    @id @default(cuid())
  tenantId   String
  runId      String?
  stepId     String?
  goalId     String?
  type       String    // tool_result|http_response|file_exists|content|schema|goal_criteria|human|browser_state
  config      Json               // per-type shapes in §3.4
  status      String    @default("pending") // pending|passed|failed
  evidence    Json?
  createdAt   DateTime  @default(now())
  completedAt DateTime?
}
model ExecutionReceipt {
  id              String   @id @default(cuid())
  tenantId        String
  runId           String
  run             Run      @relation(fields: [runId], references: [id])
  action          String
  status          String
  inputRef        String?
  outputRef       String?
  verificationRef String?
  evidence        Json     @default("{}")
  durationMs      Int?
  metadata        Json     @default("{}")
  createdAt       DateTime @default(now())
}

// ---------- tools / mcp / connectors ----------
model Tool {
  id               String   @id @default(cuid())
  tenantId         String
  name             String
  description      String?
  type             String   // native|mcp|connector|browser|sandbox|plugin
  provider         String?  // "native" | mcp server id | connector id
  schema           Json     @default("{}") // JSON Schema for args
  capabilities     String[] @default([])   // vocabulary in §3.4
  status           String   @default("enabled") // enabled|disabled|error
  mcpServerId      String?
  connectorAccountId String?
  metadata         Json     @default("{}")
  toolCalls        ToolCall[]
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  @@unique([tenantId, name, provider])
}
model MCPServer {
  id              String   @id @default(cuid())
  tenantId        String
  name            String
  transport       String   // stdio | streamable-http
  command         String?
  args            String[] @default([])   // stdio
  url             String?
  headers         Json     @default("{}") // http
  envRef          String?           // → Credential.id for env secrets
  status          String   @default("disconnected") // disconnected|connecting|connected|error
  lastConnectedAt DateTime?
  lastError       String?
  tools           MCPTool[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
model MCPTool {
  id           String    @id @default(cuid())
  serverId     String
  server       MCPServer @relation(fields: [serverId], references: [id])
  externalId   String
  name         String
  description  String?
  inputSchema  Json      @default("{}")
  enabled      Boolean   @default(true)
  toolId       String?   @unique // → canonical Tool.id after registration
  @@unique([serverId, externalId])
}
model Connector {
  id                  String             @id @default(cuid())
  tenantId            String
  type                String             // gmail|google_calendar|slack|github|notion|drive|rest|webhook
  name                String
  status              String             @default("disconnected") // connected|disconnected|error
  capabilityDiscovery Json               @default("[]")
  metadata            Json               @default("{}")
  accounts            ConnectorAccount[]
  createdAt           DateTime           @default(now())
  updatedAt           DateTime           @updatedAt
}
model ConnectorAccount {
  id           String    @id @default(cuid())
  connectorId  String
  connector    Connector @relation(fields: [connectorId], references: [id])
  label        String
  accountId    String?
  credentialId String?   // → Credential.id
  scopes       String[]  @default([])
  status       String    @default("active")
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
}

// ---------- skills ----------
model Skill {
  id          String        @id @default(cuid())
  tenantId    String
  name        String
  description String?
  status      String        @default("active")
  versions    SkillVersion[]
}
model SkillVersion {
  id             String   @id @default(cuid())
  skillId        String
  skill          Skill    @relation(fields: [skillId], references: [id])
  version        Int
  promptTemplate String
  argsSchema     Json     @default("{}")
  createdAt      DateTime @default(now())
  @@unique([skillId, version])
}

// ---------- memory ----------
model Memory {
  id        String   @id @default(cuid())
  tenantId  String
  scope     String   // short_term|long_term|task|goal|agent|user
  agentId   String?
  goalId    String?
  taskId    String?
  content   String
  embedding Json?    // JSON array of floats; vector search via raw SQL (§3.7)
  metadata  Json     @default("{}") // includes { embeddingModel } for dimension consistency
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([tenantId, scope, agentId])
}

// ---------- browser / sandbox ----------
model BrowserSession {
  id            String    @id @default(cuid())
  tenantId      String
  runId         String?
  agentId       String?
  status        String    @default("idle") // idle|active|closed|error
  currentUrl    String?
  title         String?
  screenshotRef String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
}
model SandboxSession {
  id       String   @id @default(cuid())
  tenantId String
  runId    String?
  provider String   @default("node-worker")
  status   String   @default("idle") // idle|running|terminated|error
  workdir  String
  env      Json     @default("{}")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
model SandboxExecution {
  id          String    @id @default(cuid())
  sessionId   String
  command     String
  args        String[]  @default([])
  stdout      String?
  stderr      String?
  exitCode    Int?
  status      String    @default("running") // running|completed|failed|timeout
  startedAt   DateTime  @default(now())
  completedAt DateTime?
}

// ---------- research ----------
model ResearchProject {
  id        String        @id @default(cuid())
  tenantId  String
  title     String
  question  String
  agentId   String?
  status    String        @default("active") // active|completed|archived
  resultRef String?
  createdAt DateTime      @default(now())
  updatedAt DateTime      @updatedAt
  runs      ResearchRun[]
}
model ResearchRun {
  id        String            @id @default(cuid())
  projectId String
  project   ResearchProject   @relation(fields: [projectId], references: [id])
  runId     String?
  status    String            @default("queued") // queued|running|completed|failed
  plan      Json?
  result    Json?
  createdAt DateTime          @default(now())
  completedAt DateTime?
  sources   ResearchSource[]
  findings  ResearchFinding[]
}
model ResearchSource {
  id           String        @id @default(cuid())
  runId        String
  run          ResearchRun   @relation(fields: [runId], references: [id])
  url          String
  title        String?
  contentRef   String?
  credibility  String?
  accessedAt   DateTime      @default(now())
}
model ResearchFinding {
  id        String        @id @default(cuid())
  runId     String
  run       ResearchRun   @relation(fields: [runId], references: [id])
  claim     String
  evidence  Json          @default("[]")
  verified  Boolean       @default(false)
  sourceIds String[]      @default([])
}

// ---------- notifications / schedules / files ----------
model Notification {
  id       String    @id @default(cuid())
  tenantId String
  userId   String
  user     User      @relation(fields: [userId], references: [id])
  kind     String    // approval_request|task_completed|task_failed|goal_completed|agent_failed|
                     // connector_failed|provider_failed|schedule_result
  title    String
  body     String?
  link     String?
  readAt   DateTime?
  createdAt DateTime  @default(now())
  @@index([tenantId, userId, readAt])
}
model Schedule {
  id                  String    @id @default(cuid())
  tenantId            String
  name                String
  kind                String    // one_time | recurring | event
  cron                String?
  runAt               DateTime?
  eventSubscriptionId String?
  targetKind          String    // task | workflow
  targetId            String
  enabled             Boolean   @default(true)
  lastFiredAt         DateTime?
  nextFireAt          DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
}
model Attachment {
  id               String    @id @default(cuid())
  tenantId         String
  kind             String    // file | folder
  name             String
  path             String
  sizeBytes        Int?
  mimeType         String?
  scope            String    // chat | agent | task
  scopeId          String?
  readAccess       Boolean   @default(true)
  writeAccess      Boolean   @default(false)
  grantedToAgentId String?
  createdAt        DateTime  @default(now())
}
model FolderGrant {
  id           String    @id @default(cuid())
  tenantId     String
  rootPath     String
  resolvedPath String    // realpath, normalized
  agentId      String?
  taskId       String?
  read         Boolean   @default(true)
  write        Boolean   @default(false)
  createdAt    DateTime  @default(now())
}
```

### 3.1 SSE event catalog (the missing "§38")

`packages/shared/src/events.ts` — every name, with its payload type. This is the complete contract; no other events may be emitted.

```ts
export const SSE_EVENTS = {
  // ── run lifecycle ────────────────────────────────────────────────
  'run.created':    { runId: string; kind: RunKind; status: string },
  'run.started':    { runId: string },
  'run.plan_ready': { runId: string; plan: PlanStep[] },
  'run.completed':  { runId: string; output?: unknown },
  'run.failed':     { runId: string; error: { code: string; message: string } },
  'run.cancelled':  { runId: string },
  'run.paused':     { runId: string },
  'run.resumed':    { runId: string },
  // ── steps ────────────────────────────────────────────────────────
  'step.started':   { runId: string; stepId: string; position: number; type: string; name: string },
  'step.completed': { runId: string; stepId: string; durationMs?: number },
  'step.failed':    { runId: string; stepId: string; error: { code: string; message: string }; retryCount: number },
  // ── tools ────────────────────────────────────────────────────────
  'tool.started':   { runId?: string; toolName: string; args?: unknown },
  'tool.completed': { runId?: string; toolName: string; ok: boolean; durationMs?: number },
  'tool.failed':    { runId?: string; toolName: string; error: { code: string; message: string } },
  // ── approvals ────────────────────────────────────────────────────
  'approval.created':  { approvalId: string; actionId: string; title: string; risk: unknown; expiresAt?: string },
  'approval.resolved': { approvalId: string; decision: 'approved' | 'rejected'; decidedBy?: string },
  'approval.expired':  { approvalId: string },
  // ── chat ─────────────────────────────────────────────────────────
  'chat.started':     { runId: string },
  'chat.delta':       { runId: string; delta: string },
  'chat.tool_call':   { runId: string; toolName: string; args: unknown },
  'chat.tool_result': { runId: string; toolName: string; ok: boolean; result?: unknown },
  'chat.completed':   { runId: string; messageId: string },
  'chat.error':       { runId: string; error: { code: string; message: string } },
  // ── browser & sandbox (live session state) ───────────────────────
  'browser.started':      { sessionId: string; url?: string },
  'browser.updated':      { sessionId: string; url?: string; title?: string; screenshotRef?: string },
  'browser.closed':       { sessionId: string },
  'sandbox.exec_started': { executionId: string; command: string },
  'sandbox.exec_completed': { executionId: string; status: string; exitCode?: number },
  // ── entity changes (drive live list updates) ────────────────────
  'agent.created':   { agentId: string };  'agent.updated': { agentId: string };  'agent.deleted': { agentId: string },
  'goal.created':    { goalId: string };   'goal.updated':  { goalId: string },
  'task.created':    { taskId: string };   'task.updated':  { taskId: string },
  'provider.synced': { providerId: string; modelCount: number },
  'provider.health': { providerId: string; ok: boolean; status: string },
  'mcp.connected':   { serverId: string; toolCount: number },
  'connector.connected': { connectorId: string },
  'notification.created': { notificationId: string },
} as const;

export type SSEEventName = keyof typeof SSE_EVENTS;
export type SsePayload<N extends SSEEventName> = typeof SSE_EVENTS[N];
```

SSE frame format: `data: {"name":"run.started","payload":{...}}\n\n`. On connect, the hub replays unread `Notification` rows as `notification.created` frames.

### 3.2 Error codes (stable vocabulary)

| code | HTTP | raised when |
|---|---|---|
| `VALIDATION_ERROR` | 400 | zod parse failure at route boundary |
| `UNAUTHORIZED` | 401 | missing/invalid/expired token |
| `FORBIDDEN` | 403 | tenant mismatch, path escapes grant, tool not in agent allowlist |
| `NOT_FOUND` | 404 | resource absent (or in another tenant) |
| `CONFLICT` | 409 | duplicate slug/unique constraint, idempotency replay |
| `UNSUPPORTED_CAPABILITY` | 422 | model lacks required capability |
| `RATE_LIMITED` | 429 | rate limit exceeded |
| `PROVIDER_ERROR` | 502 | adapter failure (network/auth/invalid key) |
| `BROWSER_ERROR` | 502 | Playwright action failure |
| `MODEL_UNAVAILABLE` | 503 | model disabled/deprecated, provider unhealthy |
| `GATEWAY_FALLBACK_EXHAUSTED` | 502 | primary + fallback both failed |
| `STEP_TIMEOUT` / `RUN_TIMEOUT` / `SANDBOX_TIMEOUT` | 504 | deadline exceeded |
| `ENCRYPTION_ERROR` | 500 | vault decrypt/auth-tag mismatch |

`errors.ts`: `ApiError extends Error { code, http, details? }`; error middleware maps `ApiError → res.status(http).json({error:{code,message,details}})`, ZodError → 400 `VALIDATION_ERROR`, unknown → 500 (logged, no stack leaked).

### 3.3 Gateway & tool contracts (normalized internal shapes)

```ts
// provider-agnostic message shape — adapters normalize in/out of this
export type GatewayMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: { id: string; name: string; arguments: unknown }[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ToolSchema { name: string; description: string; parameters: JsonSchema }

export interface GatewayChatRequest {
  modelId: string; messages: GatewayMessage[]; tools?: ToolSchema[];
  fallbackModelId?: string; timeoutMs?: number; idempotencyKey?: string;
  temperature?: number; maxTokens?: number;
}
export interface ChatResult {
  content: string; toolCalls?: { id: string; name: string; arguments: unknown }[];
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  model: string; provider: string;
}
export type StreamChunk = { type: 'delta'; text: string } | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'done'; result: ChatResult } | { type: 'error'; error: { code: string; message: string } };

export interface ToolResult { ok: boolean; data?: unknown; error?: { code: string; message: string }; meta?: Record<string, unknown> }
export interface HealthResult { ok: boolean; latencyMs?: number; error?: string }
export interface DiscoveredModel { externalModelId: string; name?: string; type: 'chat'|'embedding'|'image'; contextWindow?: number; capabilities: string[] }
```

### 3.4 JSON shape contracts (the previously vague ones)

**PlanStep** (`Run.plan`):
```ts
{ id: string; description: string; stepType: 'model'|'tool'|'condition'|'approval'|'verification'|'transform';
  config: Record<string, unknown>; dependsOn?: string[] }
```
Planner emits this as strict JSON (zod-validated); the UI renders the plan, never raw model reasoning.

**Checkpoint** (`Run.checkpoint`):
```ts
{ nextIndex: number;                                // index of next step to execute in Run.plan
  completedSteps: Record<string, { output?: unknown }>;  // stepId → last good output (replay-safe)
  outputs: Record<string, unknown>;                  // named outputs for condition/transform steps
  toolCallCount: number; startedAt: string }
```

**ApprovalPolicy** (`Agent.approvalPolicy`):
```ts
{ mode: 'none' | 'all' | 'risk-based';
  rules?: { match: { toolCapabilities?: string[]; minRisk?: 'low'|'medium'|'high'; toolNames?: string[] }; }[];
  expiryMs?: number }   // default 900_000 (15 min)
```

**SuccessCriterion** (`Goal.successCriteria` items): `{ type: VerifierType, config: Record<string, unknown>, description: string }` where `VerifierType ∈ { schema, content, http_response, file_exists, tool_result, browser_state }`. A goal may only reach `completed` with a passing `Verification` of type `goal_criteria` referencing these criteria.

**Permission vocabulary:** `read_files`, `write_files`, `network_internal`, `network_external`, `browser_control`, `sandbox_exec`, `memory_read`, `memory_write`, `send_notification`, `create_task`.

**Tool capability vocabulary:** `search`, `http`, `filesystem_read`, `filesystem_write`, `external_side_effect`, `browser`, `sandbox_exec`, `memory`, `notify`, `transform`, `calculation`.

**Risk shape (Action.risk / Approval.riskInformation):** `{ level: 'low'|'medium'|'high', reasons: string[] }`.

**Verifier configs:**
- `schema`: `{ schema: JsonSchema }` — validate step output
- `content`: `{ source: 'output'|'file'; path?; contains?: string[]; regex? }`
- `http_response`: `{ expectedStatus: number; bodyContains?: string[]; headers?: Record<string,string> }` (asserts against the recorded http tool result)
- `file_exists`: `{ path: string }`
- `tool_result`: `{ schema: JsonSchema }` (against ToolCall.result)
- `browser_state`: `{ selector?; text?; urlMatches? }`
- `goal_criteria`: `{ criteria: SuccessCriterion[] }`
- `human`: `{ approvalId?: string }`

### 3.5 Zod schemas (representative — every route has one in `@nexs/shared/schemas`)

```ts
export const signupSchema = z.object({ email: z.string().email(), password: z.string().min(12), name: z.string().min(1) });
export const loginSchema  = z.object({ email: z.string().email(), password: z.string().min(1) });

export const providerCreateSchema = z.object({
  name: z.string().min(1), slug: z.string().regex(/^[a-z0-9-]+$/),
  type: z.enum(['openai','anthropic','google','openai-compatible','azure-openai','groq','mistral',
                'deepseek','xai','together','openrouter','local','ollama']),
  baseUrl: z.string().url().optional(), apiKey: z.string().min(1),
  organizationId: z.string().optional(), projectId: z.string().optional(),
});

export const agentCreateSchema = z.object({
  name: z.string().min(1), description: z.string().optional(), instructions: z.string().default(''),
  modelId: z.string().optional(), fallbackModelId: z.string().optional(),
  toolIds: z.array(z.string()).default([]), mcpServerIds: z.array(z.string()).default([]),
  connectorAccountIds: z.array(z.string()).default([]),
  memoryEnabled: z.boolean().default(true), browserAccess: z.boolean().default(false),
  sandboxAccess: z.boolean().default(false), approvalPolicy: z.record(z.unknown()).default({ mode: 'risk-based' }),
});

export const taskCreateSchema = z.object({
  title: z.string().min(1), description: z.string().optional(), goalId: z.string().optional(),
  agentId: z.string().optional(), workflowId: z.string().optional(),
  triggerType: z.enum(['immediate','scheduled','recurring','event','manual']).default('manual'),
  scheduledAt: z.coerce.date().optional(), scheduleId: z.string().optional(),
  input: z.record(z.unknown()).default({}), idempotencyKey: z.string().uuid().optional(),
});

export const chatMessageSchema = z.object({
  content: z.string().min(1), attachmentIds: z.array(z.string()).default([]),
  context: z.record(z.unknown()).optional(),
});

// route helper (apps/server/src/http/middleware/validate.ts)
export function validate<T extends z.ZodTypeAny>(schema: T, source: 'body'|'query'|'params') {
  return (req: any, _res: any, next: any) => {
    const parsed = schema.safeParse(req[source]);
    if (!parsed.success) return next(new ApiError('VALIDATION_ERROR', 400, parsed.error.issues));
    req[source] = parsed.data; next();
  };
}
```

### 3.6 Native tools (name · args · returns · capabilities)

| tool | args | returns | capabilities |
|---|---|---|---|
| `web_search` | `{ query: string; maxResults?: number }` | `{ results: { title, url, snippet }[] }` | search, external_side_effect |
| `http_request` | `{ method: 'GET'\|'POST'\|…; url: string; headers?; body? }` | `{ status, headers, body }` | http, network_external, external_side_effect (non-GET) |
| `file_read` | `{ path: string; grantId?: string }` | `{ content }` | filesystem_read |
| `file_write` | `{ path: string; content: string; mode?: 'overwrite'\|'append' }` | `{ bytesWritten }` | filesystem_write, external_side_effect |
| `calculator` | `{ expression: string }` | `{ result: number }` | calculation |
| `date_time` | `{ operation: 'now'\|'format'; format?; timezone? }` | `{ value }` | — |
| `notify` | `{ title: string; body?: string; kind?: string }` | `{ notificationId }` | notify |
| `memory_store` | `{ scope: Scope; content: string; metadata?: object }` | `{ memoryId }` | memory, external_side_effect |
| `memory_search` | `{ query: string; scope?; agentId?; limit? }` | `{ results: { id, content, score, metadata }[] }` | memory |

### 3.7 Vector search (Memory)

Embeddings stored as JSON arrays in `Memory.embedding`. Search via raw SQL (dimension must match the embedding model recorded in `metadata.embeddingModel`; store all memories for a tenant with one embedding model):

```ts
await db.$queryRaw`
  SELECT * FROM "Memory"
  WHERE "tenantId" = ${tenantId} AND "scope" IN (${scopes}) AND "embedding" IS NOT NULL
    ${agentId ? sql`AND "agentId" = ${agentId}` : sql``}
  ORDER BY ("embedding"::text)::vector <=> ${vec}::text::vector
  LIMIT ${limit}`;
```

### 3.8 Slash commands (exact syntax → behavior)

| command | syntax | effect |
|---|---|---|
| `/help` | — | list all commands |
| `/status` | — | system state: provider health, running runs, pending approvals |
| `/models` `/agents` `/goals` `/runs [status]` `/tools` `/mcp` `/skills` | — | registry listings from real services |
| `/agent <name> <instructions>` | creates Agent (active) with default model | `agent.created` event |
| `/goal <title> [description]` | creates Goal (draft) | `goal.created` |
| `/run <task description> --agent <agentNameOrId>` | creates Task + Run, enqueues | `task.created`, `run.created` |
| `/schedule <cron-or-in-2h> <task description>` | creates Schedule + target task | — |
| `/research <question>` | creates ResearchProject + research run | — |
| `/browser <url> <action: screenshot\|title\|text>` | browser action via BrowserManager | `browser.*` events |
| `/connect <providerType>` | guided provider setup reply (key entry in UI) | — |
| `/approve <approvalId>` `/reject <approvalId>` | same as inbox buttons | `approval.resolved` |
| `/stop <runId>` `/pause <runId>` `/resume <runId>` | run control | `run.cancelled/paused/resumed` |
| `/clear` | clears composer state (client-side) | — |

Handler contract: `interface SlashCommand { name: string; usage: string; description: string; run(args: ParsedArgs, ctx: ChatContext): Promise<{ reply: string }> }`. Every command is backed by a real service — no canned text for listings.

### 3.9 Mention autocomplete

`GET /api/chat/mentions?q=…&kind=agent` → `{ items: [{ kind, id, name, subtitle? }] }`. Kinds: `agent | model | tool | mcp | skill | goal | workflow | connector | run | file`. Resolved from live registry queries (tenant-scoped, case-insensitive prefix/substring match, limit 20).

---

## 4. Step-by-step build plan

Build strictly in this order. Each phase ends with working, tested, running software. Never start a phase until the previous phase's acceptance criteria pass.

### PHASE 0 — Scaffolding & foundations (Day 1)

1. pnpm workspaces monorepo: `packages/shared`, `apps/server`, `apps/web`; `turbo.json` per §2.1; CI per §2.5; docker-compose per §2.4.
2. Root tsconfig per §2.2; ESLint + Prettier.
3. `apps/server/src/config.ts` per §2.3 (zod-parsed frozen `Config`; no other `process.env` reads).
4. `@nexs/shared`: `events.ts` (§3.1), `errors.ts` (§3.2), domain types for every entity in §3, zod schemas (§3.5).
5. `.env.example` per §2.3.

**Acceptance:** `pnpm dev` boots Postgres (healthcheck green), an Express server returning `GET /api/health` → `{ status: 'ok', db: 'up' }`, and an empty Vite app. CI green.

### PHASE 1 — Database layer (Day 1–2)

1. Write the full `schema.prisma` from §3 verbatim.
2. `prisma migrate dev --name init`.
3. Repositories: one per aggregate (`AgentRepository`, `GoalRepository`, `TaskRepository`, `RunRepository`, …). Pattern:

```ts
// repositories/run.repo.ts
export class RunRepository {
  constructor(private db: PrismaClient) {}
  async create(tenantId: string, data: NewRun) { return this.db.run.create({ data: { ...data, tenantId } }); }
  async findMany(tenantId: string, q: RunQuery) { /* where: { tenantId, ...q.toWhere() } */ }
  async findUniqueBy(tenantId: string, id: string) { return this.db.run.findFirst({ where: { id, tenantId } }); }
}
```

4. `TenantScope` test helper: two users; create resources in both; assert zero cross-visibility for every repository.

**Acceptance:** migrations apply cleanly; repository unit tests pass against a real Postgres (pgvector image).

### PHASE 2 — Auth & tenancy (Day 2–3)

1. `POST /api/auth/signup` — zod validate, argon2id hash (cost 19), create Tenant + User in one transaction; issue tokens (§2.6 cookies).
2. `POST /api/auth/login` — verify; access JWT (15 min) + refresh token (30 d, opaque; sha256 hash stored in `RefreshToken`).
3. `POST /api/auth/refresh` — rotation: revoke old (set `revokedAt`), issue new. Old token must be dead after rotation.
4. `POST /api/auth/logout`, `GET /api/users/me`.
5. Middleware chain: `authRequired` → `attachTenant` → `rateLimit` (§2.6 values).
6. Error middleware per §3.2 — one consistent error shape.

**Acceptance:** full auth flow tested with supertest; refresh rotation revokes old tokens; tenant isolation test walks every list endpoint: user A cannot GET user B's anything.

### PHASE 3 — Vault, Providers, Models, Gateway (Day 3–6) ← the heart of the system

**3.1 Vault (build first):**

```ts
// services/vault/vault.service.ts
import * as ENC from 'node:crypto';
export class VaultService {
  constructor(private masterKey: Buffer) {} // 32 bytes from NEXS_MASTER_KEY
  encrypt(plain: string): string {
    const nonce = ENC.randomBytes(12);
    const cipher = ENC.createCipheriv('aes-256-gcm', this.masterKey, nonce);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${nonce.toString('base64')}:${Buffer.concat([ct, tag]).toString('base64')}`;
  }
  decrypt(stored: string): string { /* parse v1: → createDecipheriv, setAuthTag, throw ENCRYPTION_ERROR on mismatch */ }
}
```

- `POST /api/providers` accepts `apiKey` **once** → encrypt → `Credential` row → returns `apiKeyRef` + masked `keyPrefix`. No GET ever returns plaintext. Rotate = new Credential row; old one marked `rotatedAt`.

**3.2 Provider adapters:**

```ts
export interface ProviderAdapter {
  readonly type: ProviderType;
  validateConfig(cfg: ProviderConfig): Promise<void>;
  testConnection(cfg: ProviderConfig): Promise<HealthResult>;
  listModels(cfg: ProviderConfig): Promise<DiscoveredModel[]>;
  chat(req: GatewayChatRequest, cfg: ProviderConfig): Promise<ChatResult>;
  streamChat(req: GatewayChatRequest, cfg: ProviderConfig): AsyncIterable<StreamChunk>;
  embed?(req: EmbedRequest, cfg: ProviderConfig): Promise<EmbedResponse>;
  supportsCapability(cap: string): boolean;
}
```

`openai.ts` is the reference implementation; `openaiCompatible.ts` parameterizes `baseUrl` and covers groq, deepseek, xai, together, openrouter, azure-openai, custom, local. `anthropic.ts`, `google.ts` handle native APIs. `ollama.ts`/`local.ts` for local servers. `registry.ts`: `getAdapter(type)`. Capability detection on discovery: parse provider metadata; when unknown, probe cheaply or default conservatively and let the user edit.

**3.3 Endpoints:** `POST /api/providers` (validate → testConnection → listModels → upsert `Model` rows keyed by exact `externalModelId` → set `lastModelSync`, `modelCount`, `status`) · `POST /:id/test` · `POST /:id/sync` · `PATCH /:id` · `GET /api/models?providerId=` · `PATCH /api/models/:id`.

**3.4 Model Gateway (the ONLY door to models):** as sketched in the original doc — load model+provider, assert capability, materialize config (decrypt `apiKeyRef`), call adapter via `withRetryAndTimeout` (retries 2, exponential backoff, timeout default 60 s, idempotency key), on failure use `fallbackModelId` once, else throw structured `GatewayError { code, provider, model, retryable }`. Normalize in/out to §3.3 shapes; usage written to receipts; every failure is a stable error code (§3.2).

**Acceptance:** add a provider with a real key → models appear with exact external IDs; chat works through the gateway for ≥2 provider types; killing the provider mid-stream yields structured error + fallback; no code outside `services/models/` imports an adapter.

### PHASE 4 — Tool Registry, MCP, Connectors (Day 6–9)

**4.1 Tool Registry & invocation:**

```ts
export interface ToolDefinition { id: string; name: string; description: string; type: ToolType; schema: JsonSchema;
  invoke(args: unknown, ctx: ToolContext): Promise<ToolResult>; }
export interface ToolContext { tenantId: string; agentId?: string; runId?: string; stepId?: string;
  attachments: Attachment[]; browser?: BrowserManager; sandbox?: SandboxManager;
  connectors: ConnectorService; mcp: MCPManager; emit(event: { name: SSEEventName; payload: unknown }): void; }
```

Native tools per §3.6. `ToolInvoker`: validate args against schema (ajv), enforce the agent's `toolIds` allowlist (no self-granting — asserted in engine tests), record `ToolCall`, emit `tool.started/completed/failed`, write `ExecutionReceipt`.

**4.2 MCP (official SDK, verified import paths):**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
// connect(): transport by type (stdio: command/args/env via vaultEnv; http: url/headers) → client.connect(transport)
//   → listTools() → upsert MCPTool rows → register canonical Tool rows (type 'mcp', provider = serverId)
// callTool(serverId, externalId, args) → normalizeMCPResult(r) → ToolResult
// also: listResources(), listPrompts(), disconnect(), reconnect()
```

Endpoints: `POST /api/mcp` → connect → `GET /api/mcp/:id` (tools/resources/prompts) · `POST /:id/reconnect` · `PATCH /:id` · `DELETE /:id` (unregister canonical tools). Agents reference canonical `Tool.id`, never the MCP server directly.

**4.3 Connectors:** `ConnectorAdapter { connect(creds), disconnect(), discoverCapabilities(), execute(action, args, account), subscribeEvents?(handler) }`. Adapters: `rest` (generic config-driven — proves the framework isn't hard-coded), `webhook`, `github`, `slack`, `gmail`, `google_calendar`, `notion`, `drive`. Credentials in Vault; accounts in `ConnectorAccount`; adapter events → normalized `Event` rows.

**Acceptance:** connect an MCP server (filesystem or GitHub) → tools appear in `/api/tools` as canonical tools → an agent with that tool invokes it in a run. GitHub connector with token → capability discovery lists actions.

### PHASE 5 — Execution Engine (Day 9–14) ← the second heart

Persisted state machine + one-step-at-a-time worker + idempotent side effects. Do not call Temporal/Inngest.

**5.1 State machines:**
```
Run:    queued → planning → running ⇄ waiting_approval → completed
                        │         │
                        ├─────────┼→ failed
                        └→ paused ⇄ running
                        any → cancelled / timeout
RunStep: pending → running → completed
                     │→ failed (→ retry if under policy → running)
                     │→ waiting_approval → running
                     └→ skipped
```

**5.2 Engine core** (per original doc): `executeRun(runId)` claims via `SELECT … FOR UPDATE`; loads `checkpoint` or plans on first pass; loop: ensure step row (idempotent by `RunStep.idempotencyKey`) → skip completed steps (replay-safe) → mark running → emit `step.started` → execute by type (`model` via gateway only, `tool`/`mcp` via ToolInvoker, `browser`, `sandbox`, `condition`, `approval` throws `ApprovalRequired`, `verification`, `transform`) → **record receipt BEFORE completing the step** (side effect logged before commit) → save checkpoint (commit boundary). Catch: `ApprovalRequired` → pause; else retryOrFail per policy.

Critical properties (each gets a dedicated test):
- **Crash recovery:** kill worker mid-run → restart → pg-boss re-delivers → resume from checkpoint, completed steps skipped.
- **Idempotency:** duplicate start returns existing run via `Run.idempotencyKey`.
- **Timeouts:** per-step `timeoutMs` (AbortController); run deadline = `executionLimits.maxDurationMs`; timeout → `status: 'timeout'` + notification.
- **Pause/resume/cancel:** status transitions; cancel flag checked at every step boundary.
- **Concurrency:** max `TENANT_CONCURRENCY` (5) running runs per tenant, enforced by counting before claim.

**5.3 Planner:** one gateway chat call with agent instructions + goal/task + tool schemas → strict JSON plan validated by zod (§3.4 PlanStep) → stored in `Run.plan` → emitted as `run.plan_ready`.

**5.4 Verifier:** implements all types per §3.4 configs. Goal `completed` only via passing `goal_criteria` verification; store `Verification` + receipt as evidence.

**Acceptance ("no fake runtime"):** task "use http_request to GET example.com, verify status 200" → run → UI shows real step states, real tool call/response, verification passed, receipt written. Kill server mid-run, restart, watch resume and finish.

### PHASE 6 — Agents, Goals, Tasks, Workflows (Day 14–18)

1. **Agents:** CRUD + zod; every update increments `version` and writes immutable `AgentVersion` snapshot. Actions: activate (requires model + valid config), pause, resume, disable, duplicate (new row, version 1), delete → `archived`. `GET /api/agents/:id` composes identity, config, goals, tasks, runs, schedules, approvals, versions.
2. **Goals:** status machine; service refuses `completed` without a passing `goal_criteria` Verification reference.
3. **Tasks:** create (immediate/scheduled/recurring/event/manual) → creates Run (kind `task`) + enqueues `run.execute`. Recurring → `Schedule`; event → `EventSubscription`.
4. **Workflows:** versioned steps; "Activate" sets `activeVersionId`; "Run" creates Run (kind `workflow`), engine honors `dependsOn`, `retryPolicy`, `timeoutMs`, `onFail`.
5. **Runs:** list with filters; full detail (steps, tool calls, receipts, verifications, sessions, usage); cancel/pause/resume.

**Acceptance:** agent → goal → task → run → verified completion end-to-end with real model calls; workflow condition branch takes the correct path; all lists tenant-scoped.

### PHASE 7 — Approvals (Decision Inbox) & Notifications (Day 18–19)

1. Approval step or risk-policy match → `Action` + `Approval` (`expiresAt`, `riskInformation`, `requiredPermissions`) → run `waiting_approval` → `approval.created` + `Notification`.
2. approve/reject endpoints → `approval.resolved` → engine resumes (approved: execute; rejected: skipped/failed per policy).
3. Expired approvals: pg-boss delayed job (`approval.expire`) marks expired, fails the step.
4. Notifications on: approval requests, task/goal completion & failure, agent/connector/provider failures, scheduled results. Endpoints: list (unread count), `PATCH /:id/read`, `POST /read-all`.

**Acceptance:** agent requiring approval for external `http_request` → run pauses → inbox shows full detail → approve → resumes → receipt cites the approval as evidence.

### PHASE 8 — Chat (Day 19–23)

Chat is a first-class execution path: same gateway, tools, engine; actions produce real runs/receipts. **User and assistant messages persist in `ChatMessage`** (added model), with `toolCalls` transcript JSON for the UI.

1. `POST /api/chat` (SSE response stream): body per §3.5 `chatMessageSchema`.
2. Pipeline: parse → slash command? handler : mentions? resolve from real registry data and inject as context : agent-style loop — gateway `streamChat` with tool schemas → on tool call → ToolInvoker → feed result back → until final answer. Emit `chat.*` events (§3.1). Persist assistant `ChatMessage` with transcript; link produced runs via `runId`.
3. Slash commands per §3.8 (each a small handler in `services/chat/commands/`, all backed by real services).
4. `GET /api/chat/mentions` per §3.9. `GET /api/chat/messages` → `{ data: ChatMessage[] }` (tenant-scoped, newest first).
5. Attachments & folders (`/api/files`): upload (multer → `${STORAGE_ROOT}/<tenantId>/uploads/…`, row in `Attachment`), folder attach (resolve `realpath`, store `FolderGrant` with read/write flags), preview endpoint streams with content-type. **Path safety:** `FileService.resolve(grant, requestedPath)` → normalize → realpath → `resolvedPath.startsWith(grant.resolvedPath + sep)` → reject symlink escapes (`lstat`) → 403 `FORBIDDEN`.

**Acceptance:** "create an agent called Scout that monitors news, use gpt-4o" → real Agent row; `/runs` shows real runs; `@` autocomplete returns live registry entries; read-only folder grant → write attempt returns structured 403.

### PHASE 9 — Browser & Sandbox (Day 23–26)

**9.1 Browser:** one shared Chromium; **one isolated `BrowserContext` per `BrowserSession`**. Actions: `open, navigate, click, type, select, extract, upload, download, screenshot, wait, inspect`. Each action emits `browser.started/updated` with URL + screenshot ref; session row updated live (Browser tab renders real state). `browser_state` assertions feed the Verifier.

**9.2 Sandbox:**
```ts
interface SandboxProvider { create(cfg: SandboxConfig): Promise<SandboxHandle>;
  exec(handle, cmd, args, opts: { timeoutMs; env; cwd }): Promise<ExecResult>; terminate(handle): Promise<void>; }
// NodeWorkerProvider: child_process.spawn, cwd = tenant workdir (§2.6), node --resourceLimits=maxOldGenerationSizeMb=512,
//   env allowlist [PATH, HOME, TZ, NODE_ENV], stdout/stderr capture, kill on timeout. DockerProvider stubbed (interface-ready).
```
UI copy: "in-process worker (development isolation)". `SandboxExecution` rows store command/stdout/stderr/exitCode → Terminal tab renders real executions; events per §3.1.

**Acceptance:** "open example.com, screenshot, extract `<title>`" → Browser tab shows real URL progression + screenshot; `node -e "console.log(1+1)"` → Terminal shows real output, exit 0.

### PHASE 10 — Memory & Research (Day 26–28)

1. **Memory:** store (embedding via gateway `embed`, capability-checked first; record `metadata.embeddingModel`) / search (§3.7 raw SQL, always tenant-scoped) / CRUD. Agents with `memoryEnabled` get `memory_search`/`memory_store` tools automatically.
2. **Research:** project → ResearchRun + Run (kind `research`) executing the protocol: decompose question → web_search → browser browse → read & extract → collect sources → organize findings → verify key claims (Verifier) → structured result (JSON: summary, sections, findings with citations, verification status). Each phase writes `ResearchSource`/`ResearchFinding`; artifact stored per §2.6 and rendered in the Research UI.

**Acceptance:** research on a real question → ≥3 sources, cited findings, ≥1 verified claim; memory of one tenant invisible to another.

### PHASE 11 — Events & Scheduling (Day 28–30)

1. **Event ingestion:** `POST /api/events` + internal emitter → normalize `{ type, source, subject, payload, occurredAt, metadata }` → store `Event` → match subscriptions (type + filter on source/subject) → trigger target (task/workflow/agent action) → mark processed.
2. **Scheduling (pg-boss — full queue registry):**

| queue | kind | behavior |
|---|---|---|
| `run.execute` | work (retry 2, backoff) | engine `executeRun(job.data.runId)` — idempotent, safe to redeliver |
| `approval.expire` | delayed (`startAfter`) | mark approval expired → fail step per policy |
| `provider.health` | cron `*/10 * * * *` | testConnection each enabled provider → update `status`, `lastHealthCheck` → emit `provider.health` |
| `recovery.scan` | one-time on boot + hourly | find orphaned `running` runs (crash before checkpoint) → re-enqueue `run.execute` |
| `schedule:<id>` | cron (`boss.schedule(cron, name, data)`) or one-time (`boss.send(name, data, { startAfter })`) | handler creates Task/Run → updates `lastFiredAt`/`nextFireAt`; `boss.remove(name)` on delete; unique job name = schedule id (dedupe) |

Survives restarts — no browser timers. `GET /api/schedules` with next-fire times; enable/disable/delete.

**Acceptance:** recurring schedule fires while the API process is down (worker only) → real run created; webhook event triggers subscribed workflow.

### PHASE 12 — Real-time (SSE) & Dashboard (Day 30–31)

1. `GET /api/stream` (SSE): cookie auth same-origin, or `?token=` for cross-origin; per-tenant fan-out from the EventBus (§1.2); on connect replay unread notifications. All emitters publish to this one bus; catalog = §3.1 complete.
2. Frontend `useSSE` hook: reconnect with exponential backoff (1 s → 30 s cap), dispatch into TanStack Query cache per the invalidation map in §6.4.
3. **Dashboard** (`GET /api/dashboard`): one service composing real aggregates — active agents, running tasks/workflows, active goals, pending approvals count, recent runs (10, live via SSE), recent agent activity (latest steps), provider health, connected services, next 5 schedules by `nextFireAt`, failures last 7 d, verification summary, recent receipts. **Zero hard-coded numbers.**

**Acceptance:** dashboard + run detail open in two tabs; start a run; both update live without refresh.

### PHASE 13 — Frontend (Day 31–40)

Build in this order (each page = `features/<name>/` module: page + components + queries):

1. **Shell:** dark-first theme (§6.3 tokens), sidebar with the exact navigation tree (Dashboard, Chat, Agents, Goals, Tasks, Workflows, Runs, Decision Inbox, Models, Tools, MCP, Connectors, Browser, Sandbox, Memory, Research, Settings — no Traffic/Impact/Audit), topbar notifications bell + user menu, shortcuts (§6.5).
2. **Chat** (flagship): composer with slash-command menu (fuzzy, real list), `@` mention popup (live registry), attachment/folder picker with permission badges, tool calls rendered inline (collapsible: name, args, result, duration), SSE streaming.
3. **Agents:** list (status chips); create wizard (name → instructions → model picker from real models → tools/MCP/connectors checkboxes → capability toggles → approval policy); details tabs Overview/Config/Goals/Tasks/Runs/Versions/Schedules/Approvals + actions (Run, Pause, Resume, Edit, Duplicate, Disable, Delete).
4. **Goals:** active/history; success criteria with per-criterion verification state; progress (tasks completed/total); linked runs; evidence panel.
5. **Tasks:** active/scheduled/completed tabs; status timeline, input/output, error, retry count, linked run.
6. **Workflows:** step editor (type picker → type-specific config form → position/dependsOn); versioned step list (readable, not a fake canvas); run history; activate/deactivate.
7. **Runs = Agent Workspace** tabs: Overview / Timeline (real step rows with timing) / Tools (ToolCall table) / Browser (live URL/title/screenshots) / Terminal (sandbox executions) / Files / Artifacts (receipts+outputs) / Approvals / Verification (with evidence). Live via SSE.
8. **Decision Inbox:** risk badges; detail drawer (action JSON, permissions, reason, expiry countdown); Approve/Reject with optimistic update + SSE confirm.
9. **Models:** Providers tab (cards: status dot, model count, last sync; Test Connection / Sync Models / Edit) + Models table (capabilities chips, context window, enabled toggle). Provider form: type → dynamic fields → key entry (show-once, then masked).
10. **Tools:** registry table (type filter, search); details with schema viewer + test-invocation panel (real invocation, real result).
11. **MCP:** servers list (status, tool count, last connected); add form (stdio: command/args/env; http: url/headers); tools/resources/prompts tables; reconnect/delete.
12. **Connectors:** add flow (type → credentials → account selection → discovery results shown); accounts, capabilities, subscriptions, test action.
13. **Browser:** active sessions (live URL/title/screenshot), history, action log.
14. **Sandbox:** sessions, execution log, provider indicator ("in-process worker — development isolation").
15. **Memory:** scope/agent filters, semantic search box, CRUD.
16. **Research:** projects; run view: question, plan phases with status, sources table, findings with verification checkmarks, final artifact (copyable JSON/MD).
17. **Settings:** profile, security (change password, sessions), key rotation, notification prefs, danger zone.
18. **Auth pages:** signup/login with loading/error states.

**Acceptance:** every page renders real data; kill a run mid-flight → UI reflects `failed` via SSE; full journey: signup → provider → agent → goal → task → run → approve → verify → receipt.

### PHASE 14 — Seed, Tests, Hardening (Day 40–44)

1. **Seed** (`pnpm seed`): user `dev@nexs.local`/`dev-password`; agents Researcher/Operator/Browser Scout; providers OpenAI + Ollama with models; goals (1 active, 1 completed with verification evidence); 5 tasks across states; 2 workflows (1 active, versioned); 8 runs across states with real steps/receipts/verifications; 2 pending approvals; 1 MCP server; 1 connector; 3 schedules; sample memory; 1 research project with sources/findings; notifications.
2. **Backend test matrix** (Vitest + supertest, pgvector test container): auth flows; tenant isolation parametrized over all list endpoints; vault round-trip + tamper detection; provider CRUD/discovery (mock adapter); gateway routing/capability/fallback/retry/timeout (mock adapter); agent lifecycle+versioning; goal cannot-complete-without-verification; task happy path; workflow condition branch; event→subscription→trigger; approval pause/resume; tool invocation contract; MCP discovery (mock SDK client); connector execution (mock adapter); browser step (mock manager); sandbox exec (real child process); memory scoping; verifier each type; receipts for every completed step; schedule create/fire; **crash-recovery** (start run, kill worker, restart, assert resume).
3. **Frontend tests:** RTL units for slash parser, mention resolver, approval drawer; Playwright e2e: auth→dashboard; agent creation; chat slash command creates a real agent; SSE run monitoring; approval flow; provider setup.
4. **Security pass:** rate limits on auth+chat; zod on every input; output validation on SSE payloads; path-traversal fuzz + symlink-escape tests on FileService; CORS locked to `WEB_ORIGIN`; cookies Secure/HttpOnly/SameSite=Lax; agent tool allowlist asserted in engine; no key in any GET response (scan with mock vault).

---

## 5. API surface (complete)

| Prefix | Endpoints |
|---|---|
| `/api/health` | `GET /` → `{ status, db }` |
| `/api/auth` | `POST /signup` `POST /login` `POST /refresh` `POST /logout` |
| `/api/users` | `GET /me` `PATCH /me` |
| `/api/agents` | CRUD · `POST /:id/activate\|pause\|resume\|disable\|duplicate` · `GET /:id` (composed) · `GET /:id/versions` |
| `/api/goals` | CRUD · `POST /:id/pause\|resume` · `GET /:id` (progress, evidence) |
| `/api/tasks` | CRUD · `POST /:id/cancel\|retry` · list filters `status=active\|scheduled\|completed` |
| `/api/workflows` | CRUD · `POST /:id/versions` · `POST /:id/activate` · `POST /:id/run` |
| `/api/runs` | list (filters) · `GET /:id` (steps, toolcalls, receipts, verifications, sessions) · `POST /:id/cancel\|pause\|resume` |
| `/api/events` | `POST /` (ingest) · list · `GET /subscriptions` CRUD |
| `/api/approvals` | list · `POST /:id/approve` `POST /:id/reject` |
| `/api/providers` | CRUD · `POST /:id/test` `POST /:id/sync` |
| `/api/models` | list · `PATCH /:id` (enable, capabilities) · `GET /:id` |
| `/api/tools` | list · `GET /:id` · `POST /:id/invoke` (test) |
| `/api/mcp` | CRUD · `POST /:id/reconnect` · `GET /:id/resources\|prompts` |
| `/api/connectors` | CRUD · `POST /:id/accounts` · `POST /:id/test` |
| `/api/browser` | sessions list · `GET /:id` (live) · `POST /:id/actions` |
| `/api/sandbox` | sessions · executions · `POST /:id/exec` |
| `/api/memory` | CRUD · `POST /search` |
| `/api/research` | projects CRUD · runs · sources · findings |
| `/api/notifications` | list (unread count) · `PATCH /:id/read` · `POST /read-all` |
| `/api/schedules` | CRUD · `POST /:id/enable\|disable` |
| `/api/chat` | `POST /` (SSE) · `GET /messages` · `GET /mentions?q=&kind=` |
| `/api/files` | upload · folder attach · `GET /:id/preview` · grants |
| `/api/stream` | SSE (§3.1 catalog) |
| `/api/dashboard` | `GET /` (composed aggregates) |

Envelope: success → resource/`{data}`; error → 4xx/5xx + `{ error: { code, message, details? } }` (§3.2).

---

## 6. Frontend contracts

### 6.1 Routes

```
/login /signup
/dashboard            # default redirect from /
/chat                 # flagship page
/agents               /agents/:id
/goals                /goals/:id
/tasks                /tasks/:id
/workflows            /workflows/:id
/runs                 /runs/:id   # Agent Workspace (9 tabs, §4-PHASE13.7)
/approvals            # Decision Inbox
/models               /tools      /tools/:id
/mcp                  /mcp/:id
/connectors           /connectors/:id
/browser              /sandbox    /memory
/research             /research/:id
/settings
```

### 6.2 Query keys convention

`['auth','me'] · ['dashboard'] · ['agents'] / ['agents', id] · ['goals'] / ['goals', id] · ['tasks'] / ['tasks', id] · ['workflows'] / ['workflows', id] · ['runs'] / ['runs', id] · ['approvals'] · ['providers'] · ['models'] · ['tools'] · ['mcp'] · ['connectors'] · ['browser','sessions'] · ['sandbox','sessions'] · ['memory'] · ['research'] / ['research', id] · ['notifications'] · ['schedules'] · ['chat','messages']`

### 6.3 Theme tokens (Tailwind)

```
--bg #0a0b0d · --surface #121417 · --border #23262b · --text #e6e8eb · --muted #9aa0a8
--accent #4f8cff (running/links)
status: ok #22c55e · waiting #f59e0b · failed #ef4444 · running #3b82f6
```

### 6.4 SSE → query invalidation map

`run.*` → `['runs'], ['dashboard'], ['runs', runId]` · `step.*/tool.*/chat.*` (with runId) → `['runs', runId], ['chat','messages']` · `approval.*` → `['approvals'], ['dashboard']` · `agent.created/updated/deleted` → `['agents']` · `goal.*` → `['goals']` · `task.*` → `['tasks']` · `provider.synced/health` → `['providers'], ['models']` · `mcp.connected` → `['mcp'], ['tools']` · `notification.created` → `['notifications']`.

### 6.5 API client + SSE hook (sketch)

```ts
// lib/api.ts
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: 'include', ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers } });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiClientError(body?.error ?? { code: `HTTP_${res.status}`, message: res.statusText });
  return (body?.data !== undefined ? body.data : body) as T;
}

// hooks/useSSE.ts — EventSource('/api/stream', { withCredentials: true });
// onmessage: parse { name, payload } → dispatch per §6.4 map (setQueryData / invalidateQueries);
// onerror: exponential backoff 1s→30s reconnect; single global connection per tab.
```

### 6.6 Keyboard shortcuts

`⌘K` command palette (fuzzy over routes + actions) · `g d` dashboard · `g c` chat · `g a` agents · `g r` runs · `g i` inbox · then any matching key within 2 s.

---

## 7. Testing & security matrix

- **Test DB:** pgvector/pgvector:pg16 container (CI service on :5433); vitest globalSetup runs `prisma migrate deploy`.
- **Backend matrix** = PHASE 14 list, verbatim.
- **Frontend:** RTL units (slash parser, mention resolver, approval drawer) + Playwright e2e suite per PHASE 14.
- **Security pass** = PHASE 14 item 4, verbatim.

---

## 8. Final execution checklist (literal order to type)

1. ☐ Monorepo + CI + docker-compose Postgres (§2 artifacts pasted)
2. ☐ `@nexs/shared`: types, zod schemas, SSE event catalog (§3.1), error codes (§3.2), contracts (§3.3–3.5)
3. ☐ Prisma schema (§3 verbatim) + migration + repositories + tenant-scope tests
4. ☐ Auth (argon2id, JWT+refresh rotation) + middleware + rate limits (§2.6)
5. ☐ Vault (AES-256-GCM) + Credential endpoints
6. ☐ Provider adapters (openai, openaiCompatible, anthropic, google, ollama) + registry
7. ☐ Provider CRUD + connection test + model discovery (exact `externalModelId`)
8. ☐ Model Gateway (routing, capability check, normalization, retry/timeout/fallback, streaming)
9. ☐ Tool Registry + ToolInvoker + native tools (§3.6)
10. ☐ MCP Manager (SDK, stdio + Streamable HTTP) → canonical tool registration
11. ☐ Connector framework + 8 adapters incl. generic REST
12. ☐ Execution Engine (state machine, checkpoints §3.4, idempotency, planner, verifier, receipts) + crash-recovery test
13. ☐ Agents (versioning, lifecycle) · Goals (verification-gated completion) · Tasks · Workflows
14. ☐ Approvals (Decision Inbox) + Notifications
15. ☐ Chat (SSE streaming, slash commands §3.8, @mentions §3.9, `ChatMessage` persistence, path-safe FileService)
16. ☐ Browser (Playwright, isolated contexts) + Sandbox (NodeWorkerProvider)
17. ☐ Memory (pgvector raw-SQL search §3.7, scoped) + Research (protocol run)
18. ☐ Events + pg-boss scheduling (queue registry §4-PHASE11) + boot recovery job + provider health cron
19. ☐ SSE hub (EventBus incl. PgNotifyBus §1.2) + live dashboard
20. ☐ Frontend: shell → chat → agents → goals → tasks → workflows → runs workspace → inbox → models → tools → MCP → connectors → browser → sandbox → memory → research → settings (§6 contracts)
21. ☐ Seed data (PHASE 14)
22. ☐ Full test matrix + security pass

**Two rules that keep this project honest:** (1) every number on screen traces to a row 