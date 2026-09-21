markdown
# NEXS Agent Control Plane — Vision & Scope

## The original idea (locked)

NEXS is **not** "a smarter agent." It is a **control plane** for AI agents:
durable execution, permissions, observability, and audit. The model stays inside
`ModelGateway`; the `ExecutionEngine` is the only component that mutates run state;
the UI renders what the database says.

## The two honesty rules (non-negotiable)

1. **Every number on screen traces to a row in the database.** No derived-in-memory
   counters, no client-side totals. If it's displayed, it's queryable.
2. **The only paths that touch a model provider, an MCP server, or the filesystem are
   `ModelGateway`, `MCPManager`, and `FileService`.** Nothing else imports their clients.

## Locked stack (do not deviate)

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js + TypeScript | single language end to end |
| HTTP | Express | REST API + SSE endpoints |
| DB | PostgreSQL via Prisma | + `pgvector` extension for memory embeddings |
| Queue/scheduling | pg-boss | jobs, cron (per-schedule `tz`, default UTC), delayed jobs |
| Realtime | Server-Sent Events (SSE) | no WebSockets, no Redis pub/sub |
| MCP | `@modelcontextprotocol/sdk` | stdio + Streamable HTTP transports |
| Browser | Playwright (headless by default) | via `BrowserManager` only |
| Sandbox | `worker_threads` with `resourceLimits` | NOT `child_process resourceLimits` (it doesn't exist there) |
| Frontend | Vite + React | renders plans, runs, approvals from REST + SSE |

Explicitly **not** in scope: Redis, Temporal/Inngest, message brokers, second databases,
free-text chain-of-thought execution (we use visible structured plans).

## Core loop (what Phases 3–5 make real)

```
plan → act → observe → verify   (repeat until goal criteria pass or limits hit)
```

- **Plan:** Planner produces a strict-JSON plan stored in `Run.plan` — visible, renderable, resumable.
- **Act:** `ToolInvoker`, `gateway.chat`, `BrowserManager`, `SandboxManager`.
- **Observe:** `ToolCall` rows, step input/output, SSE events.
- **Verify:** Verifier produces `Verification`; only a passing `goal_criteria`
  verification may set `Goal.completed`.

## Durable execution (locked pattern)

DB-backed state machine — no Temporal/Inngest:

- Every run and step is a row with `status`, checkpoint payload, idempotency key, retry count.
- A worker loop claims queued work via pg-boss, executes **one step**, persists, commits.
- Crash → re-claim → resume from last checkpoint.
- Side effects are recorded in `ToolCall`/`ExecutionReceipt` **before** the step is marked
  complete, so replay never double-fires effects.
- Only steps whose tool has capability `read_only` may be auto-retried; side-effecting
  steps stop and ask (approval) or fail explicitly.

## Execution limits (enforce all three)

`maxSteps`, `maxToolCalls`, `maxDurationMs` — from the agent's `executionLimits`.
Any one missing is a hole. A loop without caps loops forever.

## What "done" means

Each phase in `03-BUILD-PLAN.md` ends with an **acceptance test**. Follow the phases in
order; each acceptance test is your proof that the layer underneath is real.

## File map

| File | Purpose | When to read |
|---|---|---|
| `00-VISION-AND-SCOPE.md` | invariants and locked decisions | before anything |
| `01-ARCHITECTURE.md` | components, boundaries, data flows | before Phase 1 |
| `02-DATA-MODEL.md` | full schema (Prisma) | before Phase 1; maintain through all phases |
| `03-BUILD-PLAN.md` | the 14-phase build with acceptance tests | your working document |
| `AI-AGENTS-PRIMER.md` | agent concepts mapped to NEXS components | before Phase 3; §9–§12 before Phase 5 |
| `GAPS-AND-FIXES.md` | full gap register with minimal fixes | when a phase touches the area |