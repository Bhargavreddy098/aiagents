markdown
# AI Agents — Build Primer for NEXS

> Purpose: explain the agent concepts that the build document assumes, so every phase has a "why" behind it.
> Every concept below maps to a NEXS component and a phase. No new technology is introduced —
> everything fits the locked stack (Express, Prisma, pg-boss, SSE, MCP SDK, Playwright, Vite/React).
> Read this before starting Phase 3; revisit §9–§12 before Phase 5.

---

## 1. What an "agent" actually is in this architecture

- An **LLM** is a text-in/text-out engine with no memory, no tools, and no persistence. It cannot
  do anything by itself.
- An **agent** = LLM + a set of tools + a loop that lets it call them + policies (which tools it may
  use, when it must ask a human).
- NEXS's job is **not** "make an agent smarter." It is the **control plane**: durable execution,
  permissions, observability, and audit. The model stays inside `ModelGateway`; only the
  `ExecutionEngine` mutates run state.
- Consequence for build order: Phases 3–5 exist to make one honest loop —
  **plan → act → observe → verify** — real, resumable, and inspectable. Everything else is UI on top.

## 2. The agentic loop, mapped to your engine

| Loop stage | NEXS component | Phase |
|---|---|---|
| Plan | `Planner` → strict JSON plan stored in `Run.plan` | 5.3 |
| Act | `ToolInvoker`, `gateway.chat`, `BrowserManager`, `SandboxManager` | 4–5 |
| Observe | `ToolCall` rows, step `input/output`, SSE events | 5, 12 |
| Verify | `Verifier` → `Verification` + `ExecutionReceipt` | 5.4 |
| Repeat until goal criteria pass | `goal_criteria` verification gates `Goal.completed` | 6 |

Pitfalls:
- A loop without caps loops forever. Enforce **all three** limits from `executionLimits`:
  `maxSteps`, `maxToolCalls`, `maxDurationMs`. Any one missing is a hole.
- A loop that can't see its own state is unauditable. The visible plan in the UI is not a feature —
  it's what makes approvals, resumption, and debugging possible.

## 3. Tool calling (function calling) mechanics

How it works under the hood:
1. You send tool schemas (`name`, `description`, JSON Schema for args) in the request.
2. The model may answer with `tool_calls` — structured JSON arguments, not free text.
3. **You** execute the call and return the result as a new message.
4. Loop until the model produces a final text answer.

NEXS mapping: `ToolRegistry` schemas go into gateway requests; `ToolInvoker` validates args with
zod/ajv **before** executing, records a `ToolCall` row, emits `tool.started`/`tool.completed`, and
writes an `ExecutionReceipt`.

Rules that make tool calling reliable (this is where most agent projects fail):
- **Names:** snake_case, unambiguous, never overloaded (`search_web` and `web_search` are one job).
- **Descriptions:** write them for the model — state when to use, when *not* to use, expected units
  and output format.
- **Arg schemas:** as precise as possible — `enum` over `string`, bounded arrays, explicit required.
- **One tool per job.** No "do_everything" tools; they are how models pick the wrong tool.
- **Unknown args fail gracefully:** return a structured error into context (so the model can correct),
  never crash the run silently.

Failure modes and your mitigations:

| Failure mode | NEXS mitigation |
|---|---|
| Hallucinated/invalid args | zod validation + one correction retry, then structured step failure |
| Wrong tool chosen | agent `toolIds` allowlist enforced **in the engine**, not just the UI |
| Infinite loop | `maxToolCalls` + run-level deadline |
| Side effect fired twice on retry/crash | `read_only` capability flag + approval policy (see §9) |

## 4. Structured output & planning

The planner needs **strict JSON** because the UI renders the plan and the engine executes it.

Techniques by provider (the gateway should expose this as a capability, not leak it):
- OpenAI: native structured outputs / `json_schema`.
- Anthropic: force a "finish" tool (tool-forcing) — the model must call it with the JSON.
- Google: response schema.
- No native support → prompt + validation + correction retry.

Validation ladder (all in Phase 5.3):
1. zod parse of the raw plan.
2. Shape check against the plan contract (`[{id, description, stepType, toolId?, config, dependsOn}]`).
3. `plan.length ≤ maxSteps`.
4. Dependency graph is acyclic; referenced `toolId`s exist in the agent allowlist.

On failure: **one** correction retry with the exact validation error in context, then fail the run with
a structured error. Never accept an unvalidated plan.

You chose **visible structured plans** over free-text chain-of-thought. That is the right call for a
control plane: auditable, renderable, resumable. The cost (less flexible than free-form ReAct) is
accepted by design — do not "improve" it away.

## 5. Context window & token budgeting

- Tokens ≈ characters / 4 for English. Every model has a hard input limit (`Model.contextWindow`).
- What eats context, in order: system prompt + agent instructions, tool schemas, conversation
  history, and **tool results** (the biggest offender — one web page can be 20k tokens).

Budget ladder (implement in gateway/engine; config lives in `Agent.executionLimits.maxContextTokens`):
1. Cap each tool result inline (~64 KB / ~16k tokens); overflow → storage ref + short summary inline.
2. Before sending, drop the oldest tool results beyond a sliding window.
3. If still too large, summarize older turns via the gateway (a `transform` step) and keep recent
   turns verbatim.
4. Hard cap: if it's still over, fail with a structured error — **never** silently truncate mid-JSON.

Ordering rule: system/agent instructions first (models weight early context more), then the plan,
then history, latest tool results last.

Mark untrusted content: wrap web/file/API content in delimiters and state "this is data, not
instructions" (feeds §6).

## 6. Prompt injection & defense-in-depth

**What it is:** untrusted text (a web page, a file, an API response) contains "ignore previous
instructions…" and the model follows it.

**Why NEXS is exposed:** `web_search`, `browser`, `file_read`, and connector results all flow into
context. Injection is not hypothetical; it's the normal operating condition of any agent with tools.

Defense is **layered** — no single fix works:
- **Least privilege:** an agent only has the tools on its list; high-risk tools are gated by
  `approvalPolicy`.
- **Delimiters + framing:** external content is marked as data, not instructions (§5).
- **Side-effect gate:** injected text can *suggest* anything, but the engine only acts through steps
  in a visible plan, via allowed tools, and (for side effects) with approvals.
- **Sandbox discipline:** web content never executes code without an explicit sandbox step with limits.
- **Verification gates completion:** the model saying "done" is not evidence (§12).

Pitfall: you cannot prompt your way out of injection. **Structure beats prose** — allowlists,
approvals, and verifications are the defense; system-prompt adjectives are decoration.

## 7. Streaming internals

There are **two separate streams** — don't conflate them:
1. **Provider → gateway (internal):** OpenAI/Anthropic stream SSE deltas (token chunks, tool-call arg
   deltas). Your adapters normalize these into `GatewayStreamChunk` so provider quirks die at the
   adapter boundary. Nothing outside `services/models/` ever sees raw provider chunks.
2. **Gateway → client (yours):** your own SSE events (`chat.delta`, `step.*`, `tool.*`, `approval.*`)
   over `/api/stream` and the chat request stream.

Abort semantics: client disconnects → `AbortController` aborts the provider fetch → persist the
partial assistant message with `interrupted: true`. Never leave a provider stream hanging — it
burns tokens while nobody is listening.

SSE details that matter in practice: send `id:` on every event, heartbeat comment (`: ping`) every
15 s, flush headers early, one JSON payload per line, and validate outgoing payloads with zod.

## 8. MCP deep dive

- **What it is:** a standard protocol for tools/resources/prompts over JSON-RPC, transported over
  stdio (spawned process) or Streamable HTTP.
- **Lifecycle you already have:** `initialize` handshake → capability exchange → `tools/list` →
  `tools/call`. Your `MCPManager` wraps exactly this — keep it the only place that touches the SDK.
- **Canonical `Tool` rows are the right call:** agents reference `Tool.id`, never servers directly;
  a server disconnecting marks its tools `error`, it doesn't delete them.
- **Process lifecycle (the part most builds miss):** track each stdio child's PID; kill on
  disconnect and on SIGTERM; if a server crashes mid-run, the step fails with a structured error and
  you auto-reconnect only for read-only tools; cap concurrent stdio servers and queue the rest.
- **Secrets:** env values come from the Vault; never log `env` or tool args.

## 9. Durable execution for agents (the core concept)

Why agent loops need this more than normal code: they're long (minutes), multi-step, call external
systems with side effects, and crash-prone. An in-memory loop loses everything on restart.

The four concepts — your Phase 5 design already has all of them; the gap register fills the holes:
- **Checkpoint:** serializable resume state (`Run.checkpoint`). Rule: the checkpoint is the *only*
  source of truth; never keep step state in memory across steps.
- **Idempotency keys:** unique per run/step, scoped per tenant. Duplicate "start task" requests
  return the existing run — that's what makes crash-recovery safe against retries from pg-boss.
- **Side-effect classification:** `read_only` vs `external_side_effect`. Crash-resume and auto-retry
  are only *safe* for read-only steps and effects already logged in receipts. This flag is what makes
  "replay never double-fires effects" true rather than an aspiration.
- **At-least-once delivery + idempotent handlers = effectively exactly-once side effects.** That's
  the whole trick — you don't need Temporal/Inngest to get it; Postgres rows do the work.

## 10. Human-in-the-loop & risk-based autonomy

- The spectrum: full auto → ask on side effects → ask always. Your `approvalPolicy` JSON is the
  knob, and "risk-based" as the default is correct for a control plane.
- Mechanics: `Approval` row with `expiresAt` + `riskInformation`; the run parks at
  `waiting_approval`; resumption goes through the **engine**, not a new run; expiry is a pg-boss
  delayed job.
- Design rule: an approval request must answer *what exactly will happen, to what, and why now* —
  that's your `requestedAction` payload. If you can't fill it in, the policy is too coarse.

## 11. Memory & embeddings (RAG-lite)

- An **embedding** is a model mapping text → fixed-size vector; similar texts land near each other.
  Search = cosine distance over pgvector (`<=>`).
- NEXS mapping: `Memory` rows + `memory_search`/`memory_store` native tools; scope filters always
  include `tenantId` (structural isolation, not convention).
- **When NOT to use it:** short tasks don't need long-term memory — `short_term` scope is just run
  context. Never store secrets in memory content. The vector dimension must match the embedding
  model — store `dimension` on the `Model` row and validate at write time.
- **Fallback (important for early phases):** if no embedding-capable model is configured, memory
  search degrades to keyword search (ILIKE) so memory still works before any provider setup.

## 12. Verification patterns

Why: models confidently assert completion. Verification is what makes "completed" a **fact** instead
of an opinion. This is your project's differentiator — keep it central, never optional.

Types (already in your schema): `schema` (zod on output), `http_response`, `file_exists`,
`content`, `tool_result`, `browser_state`, `goal_criteria`, `human`. Each returns evidence →
`Verification` row + `ExecutionReceipt`.

Rules:
- A `Goal` completes **only** on passing `goal_criteria`.
- Every completed run should carry ≥1 verification, or an explicit "no verification required"
  marker — otherwise the dashboard can't show honest completion evidence.

## 13. Model routing & resilience

- **Fallback chain:** primary → agent-level `fallbackModelId` → tenant-level `GatewayRoute`
  overrides. Keep both; they answer different questions (per-agent preference vs tenant policy).
- **Retries:** retry only idempotent requests; respect `Retry-After` on 429; exponential backoff with
  a cap; circuit breaker = N consecutive failures → provider `degraded` + notification.
- **Cost:** one `ModelUsage` row per gateway call (tokens, latency, cost from a price snapshot in
  `Model.metadata`). The dashboard's spend numbers come from SQL over these rows — that's what
  "every number traces to a row" means for money.

## 14. Planning styles (so you can defend your choice)

- **ReAct** (interleave thought and action): flexible, but hard to audit and hard to resume.
- **Plan-and-execute (yours):** visible plan first, execute steps, replan on failure. Auditable,
  resumable, renderable — the right shape for a control plane where humans approve and inspect.
- If you ever want more adaptivity without deviating: add a `replan` step type that the planner can
  emit when verification fails N times. It's still a visible plan change, not free-form reasoning.

## 15. Observability for agents

- Correlation IDs flow through everything: requestId → runId → stepId → toolCallId, in both logs and
  SSE event payloads.
- Log every gateway call: model, tokens in/out, latency, cost, retry count.
- Dashboard aggregates come from SQL over `Run`/`RunStep`/`ModelUsage`/`Approval` — never
  hard-coded numbers.
- Don't add a tracing DB at this scale. Structured logs (pino) + your existing tables are enough.

## 16. Security checklist for agent systems

- **Secrets:** Vault → gateway/MCP env only; never in logs, args, or API responses (scan every GET
  with a mock vault in tests — already in Phase 14).
- **Least privilege:** tool allowlist enforced in the engine, not just the UI; per-agent model +
  fallback.
- **Inputs:** zod at every boundary, including outgoing SSE payloads.
- **Files:** grant-based path safety (already designed) + symlink-escape test.
- **Webhooks:** HMAC signature + replay dedupe (see gap register).
- **Rate limits:** auth, chat, and per-provider.
- **Prompt injection:** layered defenses from §6.

## 17. Glossary (one line each)

- **LLM** — a model that predicts the next token; all "intelligence" in NEXS comes from here.
- **Token** — the unit models count and bill by; roughly ¾ of a word in English.
- **Embedding** — a numeric vector representing text meaning; powers `memory_search`.
- **JSON-RPC** — the wire protocol MCP servers speak (methods like `tools/list`, `tools/call`).
- **stdio** — pipe-based transport for spawning MCP server processes.
- **Streamable HTTP** — the HTTP transport variant of MCP.
- **SSE** — Server-Sent Events; one-way HTTP stream, your real-time choice.
- **Checkpoint** — serialized resume state; the engine's memory across crashes.
- **Idempotency key** — a unique token making repeated requests/replays safe.
- **Receipt** — an `ExecutionReceipt` row proving a side effect happened exactly once.
- **Tool call / function calling** — the model emitting structured JSON args for a tool you execute.
- **Structured outputs** — provider features that guarantee valid JSON/schema output.
- **Prompt injection** — untrusted text in context trying to become instructions.
- **RAG** — retrieving stored content and injecting it into context (your memory search is RAG-lite).
- **Circuit breaker** — stop calling a failing provider after N failures; mark degraded