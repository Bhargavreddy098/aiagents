# NEXS Architecture — Components & Boundaries

## Component map

```
                        ┌────────────────────────────┐
                        │           Frontend         │
                        │   Vite + React (plans,     │
                        │   runs, approvals, chat)   │
                        └───────▲───────────▲────────┘
                          REST  │           │ SSE
                        ┌───────┴───────────┴────────┐
                        │          Express API        │
                        │  /api/agents /goals /tasks  │
                        │  /workflows /runs /chat     │
                        │  /approvals /notifications │
                        └──┬──────────────┬───────────┘
                           │              │
        ┌──────────────────┴──┐    ┌──────┴──────────────────┐
        │   ModelGateway      │    │     ExecutionEngine     │
        │  ONLY path to model │    │  ONLY mutator of run    │
        │  providers (chat,   │    │  state. DB-backed state │
        │  stream, embeddings)│    │  machine: claim → step  │
        └──────────▲──────────┘    │  → persist → commit     │
                   │                └──────┬──────────────────┘
        ┌──────────┴──────────┐             │
        │      Planner        │    ┌────────┴─────────┐   ┌──────────────────┐
        │  strict-JSON plans  │    │   ToolInvoker    │   │  Verifier        │
        └─────────────────────┘    └───┬───────┬─────┘   └──────────────────┘
                                       │       │
                    ┌──────────────────┴─┐  ┌──┴─────────────────┐
                    │   MCPManager       │  │ BrowserManager     │
                    │ ONLY path to MCP   │  │ Playwright, headless│
                    │ servers; canonical│  │ per-session ephemeral│
                    │ Tool rows         │  └──────────────────────┘
                    └───────────────────┘        ┌──────────────────────┐
                                                 │   SandboxManager    │
      ┌──────────────────────┐                   │ worker_threads +    │
      │     FileService      │                   │ resourceLimits      │
      │ ONLY path to disk    │                   └──────────────────────┘
      │ (tenant workdirs)    │
      └──────────────────────┘
```

## Boundary rules (enforce with code review + imports)

1. **ModelGateway** is the only module that imports provider SDKs. It exposes:
   `chat`, `stream`, `embed`, and per-provider capability metadata
   (structured-output mode, max tokens, price, embedding dimension).
2. **MCPManager** is the only module that talks to MCP servers. Discovered tools
   become canonical `Tool` rows; nothing calls a tool outside `ToolInvoker`.
3. **FileService** is the only module touching the filesystem (tenant workdirs,
   artifacts). Local disk now; interface defined so S3 can replace it without
   touching callers.
4. **ExecutionEngine** is the only writer of run/step state. API handlers enqueue
   work via pg-boss; they never mutate run rows directly.
5. **Planner / Verifier** are engine-internal phases (5.3 / 5.4). Both go through
   `ModelGateway`; neither touches tools or files directly.

## Durable execution worker

- pg-boss queue `run.execute`. Worker claims one job → loads run/step rows → executes
  exactly one step → persists `ToolCall`/`ExecutionReceipt` (side effects first) →
  marks step complete in the same transaction → commits.
- Idempotency key = `(runId, stepId, attempt)` scoping; replay of an already-complete
  step is a no-op.
- On crash: pg-boss re-claims; engine resumes from last checkpoint. Side-effecting
  steps that were interrupted park at `waiting_approval` or fail explicitly —
  they are never silently re-fired.

## SSE contract (locked, with reconnect semantics)

- Events carry monotonically increasing per-run event ids.
- Reconnect: client sends `Last-Event-ID`; server responds by having the client
  **refetch state via REST** (`GET /api/runs/:id`), then resume the live tail.
  No attempt to replay a full event history from memory.
- Cross-process fan-out (multiple worker processes): SSE hub is keyed by
  `tenantId + userId`; events are written to Postgres (the source of truth) and
  broadcast via `LISTEN/NOTIFY` channel per run — no Redis.

## Concurrency rules

- One active run per agent at a time (advisory lock / unique partial index on
  `Run(tenantId, agentId, status='running')`).
- Step claims use row-level locking (`SELECT ... FOR UPDATE SKIP LOCKED` via raw
  query in the worker).
- Approval resume goes through the engine — it does not create a new run.

## Failure policy summary

| Failure | Behavior |
|---|---|
| Provider 429 | honor `Retry-After`, backoff, circuit-break per provider (open after N consecutive failures; half-open probe) |
| Plan validation fail | **one** correction retry with exact error in context, then fail run with structured error. Never accept an unvalidated plan. |
| MCP server crash mid-run | mark step failed; do **not** auto-restart mid-run unless the tool is `read_only` |
| Context overflow | truncate oldest chat history → summarize (ladder in primer §5) |
| Zombie run | heartbeat column on `Run`; reaper job marks stale running runs failed |

## Observability rule

Every request/job gets a correlation id; it appears in logs, SSE events, and is
stored on `Run`/`Step` rows. "Every number on screen traces to a row" applies to
logs too: usage counts come from `ModelUsage`, not counters.
``