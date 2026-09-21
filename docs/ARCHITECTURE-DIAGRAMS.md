# NEXS — Architecture Diagrams

> Companion to `nexs-build-spec.md`. Canonical set of diagrams, including the additive
> Hermes-inspired surfaces (Skills, Artifacts, Unattended runs). All diagrams are
> mermaid — render in GitHub/VS Code. ASCII fallbacks included for terminal review.

---

## D1. System context (full, incl. new surfaces)

```mermaid
flowchart TB
    subgraph Client["Browser"]
        SPA["React SPA (Vite + Tailwind + shadcn/ui)<br/>TanStack Query · Zustand · SSE client"]
    end

    subgraph API["API process — Express 5"]
        EDGE["HTTP edge: helmet · cors · cookies · correlationId · pino-http<br/>rateLimit → authRequired → validate → errorHandler"]
        ROUTERS["25 router prefixes (see D2)"]
        SSEHUB["SSE hub GET /api/stream<br/>per-tenant fan-out · 15s heartbeats · reconnect = REST refetch + live tail"]
    end

    subgraph Worker["Worker process (same codebase)"]
        PGBOSSW["pg-boss consumers: run.execute · approval.expire<br/>provider.health · recovery.scan · schedule:&lt;id&gt;"]
        ENGINE["ExecutionEngine — ONLY writer of run/step state<br/>claim CAS → plan → step loop → receipt → checkpoint commit"]
        PLANNER["Planner (strict-JSON plans, one correction retry)"]
        VERIFIER["Verifier (schema/content/http/file/browser_state/goal_criteria/human)"]
        TOOLSVC["ToolInvoker — ONLY caller of any tool"]
        MCP["MCPManager — ONLY path to MCP servers (stdio + Streamable HTTP)"]
        BROWSER["BrowserManager — ONLY path to Chromium (Playwright, per-session context)"]
        SANDBOX["SandboxManager — worker_threads resourceLimits (+ ffmpeg for media artifacts)"]
        GATEWAY["ModelGateway — ONLY path to model providers<br/>chat · stream · embed · fallback · 429/circuit-breaker · ModelUsage rows"]
        SKILLS["SkillRegistry — promptTemplate + argsSchema skills (Hermes-style)<br/>deep-research · last30days · ponytail · tech-debt-audit · diagram-maker · …"]
        SCHED["ScheduleService (pg-boss cron, per-schedule IANA tz)"]
        EVENTSVC["EventIngest (HMAC webhooks, dedupe by externalId)"]
    end

    subgraph Store["Postgres 16 + pgvector — source of truth"]
        PG[("53+ models · tenantId on every row<br/>pg-boss schema nexs_jobs<br/>tsvector FTS + vector(1536)")]
    end

    subgraph Ext["External systems"]
        PROVIDERS["OpenAI · Anthropic · Google · Ollama · OpenAI-compatible…"]
        MCPSRV["MCP servers (child processes, tracked pids)"]
        CONN["Connectors: github · slack · gmail · calendar · rest · webhook · reach (twitter/reddit/youtube)"]
    end

    DISK[("STORAGE_ROOT/<tenantId>/…<br/>uploads · screenshots · sandbox workdirs<br/>artifacts: diagrams · slides · explainers · graphs · replays.mp4")]

    SPA -->|"REST JSON + SSE"| EDGE
    EDGE --> ROUTERS
    ROUTERS --> SSEHUB
    ROUTERS -->|enqueue pg-boss — never mutates run rows| PGBOSSW
    SSEHUB -.->|"LISTEN nexs_events (PgNotifyBus)"| PG
    PGBOSSW --> ENGINE
    ENGINE --> PLANNER & VERIFIER & TOOLSVC
    TOOLSVC --> MCP & BROWSER & SANDBOX & GATEWAY
    SKILLS -->|planner emits skill steps| ENGINE
    SCHED -->|fires tasks/workflows| PGBOSSW
    EVENTSVC --> PGBOSSW
    GATEWAY --> PROVIDERS
    MCP --> MCPSRV
    TOOLSVC --> CONN
    BROWSER --> SANDBOX
    ENGINE -->|"rows + receipts"| PG
    ROUTERS -->|"repositories (tenant-scoped)"| PG
    BROWSER & SANDBOX & TOOLSVC --> DISK
```

ASCII fallback:

```
 Browser SPA ──REST/SSE──▶ Express edge ──▶ 25 routers ──▶ repositories ──▶ Postgres+pgvector
                                        │                    ▲               (pg-boss, tsvector)
                                        ▼ enqueue           │ claim CAS
                                   pg-boss jobs ──▶ ExecutionEngine ──receipts──┘
                                            ├─ Planner / Verifier ──▶ ModelGateway ──▶ providers
                                            ├─ ToolInvoker ──▶ MCPManager / Browser / Sandbox / Connectors
                                            └─ SkillRegistry (Hermes-style skills)
 Worker publishes events → pg_notify → API LISTEN → SSE hub → clients
 All bytes: STORAGE_ROOT/<tenantId>/… (uploads, screenshots, artifacts, replays)
```

---

## D2. HTTP edge — router map (14 built + 11 to wire)

| Prefix | Status | Notes |
|---|---|---|
| `/api/health` | ✅ built | public |
| `/api/auth` | ✅ built | public; rate-limited 10/min/IP |
| `/api/users` | ✅ built | me / patch |
| `/api/agents` | ✅ built | CRUD + lifecycle actions + versions |
| `/api/goals` | ✅ built | verification-gated completion |
| `/api/tasks` | ✅ built | creates Run + enqueues `run.execute` |
| `/api/workflows` | ✅ built | versioned steps, activate, run |
| `/api/runs` | ✅ built | list/detail/cancel/pause/resume |
| `/api/approvals` | ✅ built | approve/reject; expiry via pg-boss |
| `/api/notifications` | ✅ built | unread count, read, read-all |
| `/api/chat` | ✅ built | SSE stream, messages, mentions (add sessions) |
| `/api/memory` | ✅ built | CRUD + hybrid search (FTS+vector) |
| `/api/research` | ✅ built | projects/runs/sources/findings (+credibility, presets) |
| `/api/stream` | ✅ built | SSE hub |
| `/api/providers` | ⬜ wire | CRUD · `POST /:id/test` · `POST /:id/sync` |
| `/api/models` | ⬜ wire | list · `PATCH /:id` (enable, capabilities) |
| `/api/tools` | ⬜ wire | registry · `GET /:id` · `POST /:id/invoke` (test) |
| `/api/mcp` | ⬜ wire | CRUD · reconnect · resources/prompts |
| `/api/connectors` | ⬜ wire | CRUD · accounts · test · oauth start/callback |
| `/api/browser` | ⬜ wire | sessions · live state · actions |
| `/api/sandbox` | ⬜ wire | sessions · executions · exec |
| `/api/events` | ⬜ wire | webhook ingest (HMAC) · subscriptions CRUD |
| `/api/schedules` | ⬜ wire | CRUD · enable/disable · next-fire times |
| `/api/files` | ⬜ wire | upload · folder attach · preview · grants |
| `/api/dashboard` | ⬜ wire | composed aggregates — zero hard-coded numbers |
| `/api/skills` | ⬜ add (new) | CRUD · versions · `POST /:id/run` (test) — Hermes-style skill registry |

Middleware chain (all routers): `rateLimit → authRequired → attachTenant → validate(zod) → controller`.
All 25 authenticated except `/api/health` and `/api/auth/*`.

---

## D3. Component boundaries & single-path rules

```mermaid
flowchart LR
    subgraph HTTP["HTTP layer (only place that touches Express)"]
        C["controllers — thin: service → envelope"]
        R["routes — thin: parse → zod → controller"]
    end
    subgraph SVC["Services (domain logic)"]
        AG["AgentService"] & GO["GoalService"] & TA["TaskService"] & WF["WorkflowService"]
        RU["RunService (create/query only)"]
        EN["ExecutionEngine ★only run-state writer"]
        GW["ModelGateway ★only model path"]
        TI["ToolInvoker ★only tool caller"]
        MM["MCPManager ★only MCP path"]
        FS["FileService ★only disk path"]
        BM["BrowserManager"] & SM["SandboxManager"] & CS["ConnectorService"]
        SK["SkillRegistry"] & MS["MemoryService"] & RS["ResearchService"]
    end
    subgraph REPO["Repositories (only place that touches Prisma)"]
        RP["one file per aggregate · tenantId first arg · tenant in every WHERE"]
    end
    PG[("Postgres")]
    R --> C --> SVC
    SVC --> RP --> PG
    EN --> GW & TI
    TI --> MM & BM & SM & CS
    SK -.->|promptTemplate injected at plan time| EN
```

Rules (enforced by import tests, not convention):

- Only `ModelGateway` imports provider SDKs.
- Only `ExecutionEngine` mutates `Run`/`RunStep` rows.
- Only `ToolInvoker` executes a tool; allowlist checked at plan validation and again at invocation.
- Only repositories touch Prisma; only controllers touch HTTP.
- Skills never call tools directly — they shape the planner's output; execution still goes through the engine.

---

## D4. Execution sequence (plan → act → observe → verify)

```mermaid
sequenceDiagram
    autonumber
    participant C as SPA
    participant A as API process
    participant Q as pg-boss
    participant W as Worker process
    participant E as ExecutionEngine
    participant P as Planner
    participant V as Verifier
    participant G as ModelGateway
    participant T as ToolInvoker
    participant AP as ApprovalService
    participant H as SSE hub
    participant DB as Postgres

    C->>A: POST /api/tasks
    A->>DB: create Task and Run with status queued
    A->>Q: enqueue run.execute with runId tenantId kind
    A-->>C: 201 with runId
    Q->>W: deliver run.execute
    W->>DB: claim the run by compare-and-swap on status
    alt claim refused
        W->>Q: ack
        Note over W,Q: a duplicate delivery is a no-op, never a second execution
    else claim won
        W->>DB: load run, pinned AgentVersion, allowed tool ids
        W->>P: plan
        P->>G: chat with a strict json schema
        G->>DB: insert one ModelUsage row per call
        G-->>P: candidate plan
        P->>P: zod-validate the plan
        alt plan invalid
            P->>G: one correction retry carrying the exact error
        end
        P-->>E: PlanStep array
        loop step loop, bounded by maxSteps maxToolCalls maxDurationMs
            E->>DB: insert Step as pending
            E->>E: classify capability as read_only or side_effect
            alt policy requires a human for this capability
                E->>AP: request Action and Approval
                E->>DB: park the run at waiting_approval
                AP->>Q: send approval.expire with startAfter expiresAt
                Note over AP,C: a human decides in the Decision Inbox
                AP->>E: resumeRun on the same run, never a new run
            end
            alt step kind is model
                E->>G: chat or stream
                G->>DB: insert one ModelUsage row per call
            else step kind is tool
                E->>T: invoke the tool
                T->>DB: insert ToolCall
            end
            E->>DB: insert ExecutionReceipt before the step is marked complete
            E->>DB: commit step complete and checkpoint in one transaction
            E->>V: verify against the success criteria
            V->>DB: insert Verification
        end
        E->>DB: commit Run completed or failed with a structured error
        E->>H: publish run.completed
    end
    H-->>C: SSE run.completed
    C->>A: GET /api/runs/:id on reconnect refetch
```

---

## D5. SSE event flow & reconnect contract

```mermaid
flowchart LR
    subgraph W["Worker / API emitters"]
        EM["engine · tools · browser · approvals · chat<br/>publish(tenantId, name, payload) — zod-validated"]
    end
    BUS{"EventBus"}
    IMB["InMemoryBus (dev: WORKER_ENABLED=true)"]
    PNB["PgNotifyBus (prod): SELECT pg_notify('nexs_events', json)"]
    PG[("Postgres LISTEN/NOTIFY")]
    HUB["SSE hub — per-tenant fan-out<br/>id: on every event · : ping every 15s<br/>dead clients removed on socket close"]
    C1["SPA tab 1"] & C2["SPA tab 2 (run detail)"]
    EM --> BUS
    BUS -->|single process| IMB --> HUB
    BUS -->|cross process| PNB --> PG --> HUB
    HUB --> C1 & C2
    C1 -.->|"drop → EventSource.onerror → backoff 1s→30s"| C1
    Note["Reconnect contract: refetch affected resources via REST (TanStack invalidation)<br/>then resume live tail. No server-side replay buffer required."]
```

Event catalog is locked (`@nexs/shared/events.ts`, §3.1 of the build spec). New surfaces reuse it — no new event names:

- Skill test-run → `task.created` + `run.*` (a skill run IS a task/run)
- Artifact completion → part of `run.completed` output; UI refetches via invalidation map
- Overnight digest → `notification.created`

---

## D6. Data model — aggregate map (53+ Prisma models, tenantId on every owned row)

```mermaid
erDiagram
    %% ── tenancy: every owned row carries tenantId as an indexed scalar ──
    TENANT ||--o{ USER : "owns"
    TENANT ||--o{ MODEL_PROVIDER : "owns"
    TENANT ||--o{ CREDENTIAL : "owns"
    TENANT ||--o{ MODEL : "owns"
    TENANT ||--o{ GATEWAY_ROUTE : "owns"
    TENANT ||--o{ MODEL_USAGE : "owns"
    TENANT ||--o{ TOOL : "owns"
    TENANT ||--o{ MCP_SERVER : "owns"
    TENANT ||--o{ CONNECTOR : "owns"
    TENANT ||--o{ AGENT : "owns"
    TENANT ||--o{ GOAL : "owns"
    TENANT ||--o{ TASK : "owns"
    TENANT ||--o{ WORKFLOW : "owns"
    TENANT ||--o{ SCHEDULE : "owns"
    TENANT ||--o{ EVENT : "owns"
    TENANT ||--o{ EVENT_SUBSCRIPTION : "owns"
    TENANT ||--o{ RUN : "owns"
    TENANT ||--o{ TOOL_CALL : "owns"
    TENANT ||--o{ EXECUTION_RECEIPT : "owns"
    TENANT ||--o{ VERIFICATION : "owns"
    TENANT ||--o{ ACTION : "owns"
    TENANT ||--o{ APPROVAL : "owns"
    TENANT ||--o{ CHAT_SESSION : "owns"
    TENANT ||--o{ CHAT_MESSAGE : "owns"
    TENANT ||--o{ MEMORY : "owns"
    TENANT ||--o{ BROWSER_SESSION : "owns"
    TENANT ||--o{ SANDBOX_SESSION : "owns"
    TENANT ||--o{ RESEARCH_PROJECT : "owns"
    TENANT ||--o{ SKILL : "owns"
    TENANT ||--o{ ATTACHMENT : "owns"
    TENANT ||--o{ FOLDER_GRANT : "owns"
    TENANT ||--o{ NOTIFICATION : "owns"
    TENANT ||--o{ CHANNEL : "owns"
    TENANT ||--o{ CHANNEL_ACCOUNT : "owns"
    TENANT ||--o{ ACCESS_GROUP : "owns"
    TENANT ||--o{ PAIRING_REQUEST : "owns"
    TENANT ||--o{ DEVICE : "owns"
    TENANT ||--o{ DEVICE_TOKEN : "owns"
    TENANT ||--o{ BINDING : "owns"
    TENANT ||--o{ PLUGIN : "owns"
    TENANT ||--o{ EXEC_ALLOWLIST_RULE : "owns"

    %% ── identity ──
    USER ||--o{ REFRESH_TOKEN : "issues"
    USER ||--o{ PASSWORD_RESET : "requests"
    USER ||--o{ NOTIFICATION : "receives"

    %% ── gateway, models, spend ──
    MODEL_PROVIDER ||--o{ MODEL : "offers"
    MODEL ||--o{ MODEL_USAGE : "billed as"
    RUN |o--o{ MODEL_USAGE : "spends on"

    %% ── tools, MCP, connectors ──
    MCP_SERVER ||--o{ MCP_TOOL : "exposes"
    MCP_SERVER |o--o{ TOOL : "projects into"
    CONNECTOR ||--o{ CONNECTOR_ACCOUNT : "authorises"

    %% ── control plane ──
    AGENT ||--o{ AGENT_VERSION : "versions"
    GOAL |o--o{ TASK : "decomposes into"
    WORKFLOW ||--o{ WORKFLOW_VERSION : "versions"
    WORKFLOW_VERSION ||--o{ WORKFLOW_STEP : "contains"
    EVENT |o--o{ EVENT_SUBSCRIPTION : "matched by"
    AGENT |o--o{ RUN : "executes"
    AGENT_VERSION |o--o{ RUN : "pins"
    TASK |o--o{ RUN : "spawns"

    %% ── execution chain ──
    RUN ||--o{ STEP : "contains"
    RUN |o--o{ TOOL_CALL : "records"
    STEP |o--o{ TOOL_CALL : "makes"
    TOOL ||--o{ TOOL_CALL : "invoked as"
    TOOL_CALL ||--o{ EXECUTION_RECEIPT : "proves"
    RUN |o--o{ VERIFICATION : "checked by"

    %% ── approvals ──
    ACTION ||--o{ APPROVAL : "awaits"

    %% ── chat ──
    CHAT_SESSION |o--o{ CHAT_MESSAGE : "contains"
    RUN |o--o{ CHAT_MESSAGE : "answers"

    %% ── runtime sessions ──
    SANDBOX_SESSION ||--o{ SANDBOX_EXECUTION : "runs"

    %% ── research ──
    RESEARCH_PROJECT ||--o{ RESEARCH_RUN : "attempts"
    RESEARCH_RUN ||--o{ RESEARCH_SOURCE : "reads"
    RESEARCH_RUN ||--o{ RESEARCH_FINDING : "asserts"

    %% ── skills ──
    SKILL ||--o{ SKILL_VERSION : "versions"

    %% ── channels, devices (v2) ──
    CHANNEL ||--o{ CHANNEL_ACCOUNT : "authenticates"
    DEVICE ||--o{ DEVICE_TOKEN : "holds"
```

**Ownership shape.** 56 models today. 41 carry `tenantId` as the first indexed column and are
drawn with an `owns` edge above. The other 15 are child rows scoped through a parent rather than
directly by tenant — `RefreshToken`, `PasswordReset` (via `User`), `AgentVersion` (via `Agent`),
`WorkflowVersion` / `WorkflowStep` (via `Workflow`), `MCPTool` (via `McpServer`), `ConnectorAccount`
(via `Connector`), `Step` (via `Run`), `SandboxExecution` (via `SandboxSession`), `ResearchRun`
(via `ResearchProject`), `ResearchSource` / `ResearchFinding` (via `ResearchRun`), `SkillVersion`
(via `Skill`), plus `Tenant` itself. Every edge above is a declared Prisma relation; `tenantId`
itself is deliberately a plain indexed scalar, never a relation — which is what makes tenant
isolation structural instead of conventional.

Invariants: `Goal.completed` refused without passing `goal_criteria` Verification · `Run.agentVersionId`
frozen at start · side-effecting `ToolCall` requires `ExecutionReceipt` before step complete ·
embedding dimension validated at write time.

---

## D7. Skills & artifacts pipeline (new — Hermes-inspired, additive)

```mermaid
flowchart TB
    subgraph Registry["Skill registry (DB rows, zero new infra)"]
        S1["deep-research (8-phase, credibility scoring)"]
        S2["last30days (recency window + platform sources)"]
        S3["user-research (interviews/surveys synthesis)"]
        S4["ponytail (minimal-code policy) · tech-debt-audit · humanizer · napkin/runbook-keeper"]
        S5["diagram-maker (SVG/mermaid) · slides-builder (HTML deck) · code-explainer (knowledge graph) · seo-audit"]
    end
    subgraph Plan["Planner"]
        P["skill stepType resolved at plan time:<br/>promptTemplate + argsSchema → strict-JSON PlanStep[]<br/>(same validation ladder, same allowlist gates)"]
    end
    subgraph Exec["Engine executes as normal steps"]
        X["model / tool / browser / sandbox steps<br/>→ ToolCall rows, receipts, verifications — all real"]
    end
    subgraph Artifacts["Artifact writers (FileService only path to disk)"]
        A1["diagram: svg/png/mermaid"]
        A2["slides: self-contained HTML deck"]
        A3["explainer: run plan-audit page (HTML)"]
        A4["graph: knowledge-graph JSON + interactive HTML"]
        A5["report: TECH_DEBT_AUDIT.md / research report (JSON/MD)"]
        A6["replay: run-replay MP4 — BrowserManager screenshots + step timeline via sandbox ffmpeg (probe-first, verify-last)"]
    end
    DISK[("STORAGE_ROOT/<tenantId>/artifacts/<runId>/…")]
    UI["Artifacts tab in Run workspace:<br/>ArtifactViewer renders by type (mermaid / iframe preview / video player)<br/>Copy as JSON · Copy as MD · Download"]
    Registry --> P --> X --> Artifacts --> DISK --> UI
```

Rules: artifacts are bytes on disk referenced from `ExecutionReceipt.outputRef` /
`ResearchRun.resultRef` — the UI never renders derived state. Artifact generation is a normal step:
it costs tokens, shows in the timeline, can fail and be retried like any other step.

---

## D8. Unattended runs (ARIS pattern — "research while you sleep")

```mermaid
flowchart TB
    subgraph Setup["One-time setup (UI)"]
        SCH["Schedule: cron e.g. 0 23 * * * (IANA tz, pg-boss per-schedule tz)"]
        AG["Agent with unattended-safe policy:<br/>approvalPolicy mode=risk-based + sleepSafe=true<br/>maxSteps / maxToolCalls / maxDurationMs all set"]
        REV["Reviewer model configured (2nd model via gateway — cross-model adversarial review)"]
    end
    subgraph Night["Overnight (no human present)"]
        FIRE["pg-boss fires → Task + Run(kind=research, preset=overnight-research)"]
        LOOP["plan → act → observe loop with hard limits"]
        PARK{"side effect requested?"}
        P1["read_only → proceeds automatically"]
        P2["parks at waiting_approval (does NOT fail — sleepSafe)<br/>expiry set to morning + 2h"]
        REVEW["reviewer model pass: independent critique of findings<br/>(a normal 'model' step with its own gateway call)"]
    end
    subgraph Morning["Human returns"]
        DIGEST["notification.created: 'Overnight research finished — 14 sources, 9 verified claims, 2 awaiting approval'<br/>deep-links to run + inbox"]
        INBOX["Decision Inbox: parked side effects with full requestedAction detail"]
        REPLAY["Run replay video + explainer artifact for the whole night"]
    end
    Setup --> FIRE --> LOOP
    LOOP --> PARK
    PARK --> P1 --> LOOP
    PARK --> P2
    P2 --> DIGEST
    LOOP --> REVEW --> DIGEST
    DIGEST --> INBOX & REPLAY
```

Why this is the flagship demo of NEXS's core guarantee: a multi-hour, multi-step, side-effecting
workload that survives restarts, never double-fires effects, asks a human only when it must, and
proves completion with verifications + receipts.
