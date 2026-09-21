# Phase 3 — Vault, Providers, Models & Gateway (spec numbering)

**Status: ✅ done.** `v2.md` asks for **two new commands** here and changes no existing decision.

## What is built

| Piece | Detail |
|---|---|
| `VaultService` | Encrypted credentials; the AES-256 key is **derived via HKDF from `JWT_SECRET`**, which `loadConfig()` validates before the port binds. There is no separate `NEXS_MASTER_KEY` (removed 2026-09-21) |
| Provider adapters | `services/gateway/adapters/` — **the only place a provider SDK is imported** |
| `ModelGateway` | `chat`, `stream`, `embed`. One of exactly three modules permitted to touch the outside world |
| Fallback chain | Via `Model.fallbackOf`, proven by killing the primary provider mid-stream |
| 429 / outage handling | Honours `Retry-After`, exponential backoff, per-provider **circuit breaker** (gap #20) |
| Structured output | Per-provider capability (native `json_schema` / tool-forcing / prompt) exposed as one interface — provider specifics never leak to the engine |
| Context budgeting | Tokens estimated before each call; overflow → truncate oldest history → summarise (gap #17) |
| `ModelUsage` | A row on **every** call, with cost from `Model.metadata` prices (gap #7) |
| Provider health | `lastHealthCheck` column exists; the periodic `provider.health` cron (gap #10) does **not** |

Proven by `gateway.adapters.test.ts` (46), `gateway.fallback.test.ts` (17),
`gateway.retry.test.ts`, `gateway.structured-output.test.ts`, `gateway.context-budget.test.ts`
(17), `gateway.usage.test.ts` (22) — 120+ tests on this phase alone.

### The budget ladder is the rule worth keeping

Estimating tokens before a call is what makes the difference between a graceful degradation and a
provider error the user has to interpret. The ladder is: **truncate oldest chat history first,
then summarise** — never silently drop the system prompt or the current turn, because those are
the two things whose loss changes the answer's meaning rather than its detail.

## What `v2.md` asks for here

### §9 — `/moa` (mixture of agents)

Several models answer, and a reconciliation step combines them. Marked `adminOnly: true` in the
registry, because it multiplies cost by the fan-out factor and §5.6 puts that class of decision
with the owner.

Needs from this phase: **fan-out in the gateway** (N concurrent `chat` calls with per-model
`ModelUsage` rows, so the cost is traceable to rows rather than estimated) and a reconciliation
call. Today the gateway is strictly a single-model request path with a fallback chain, which is a
different shape from fan-out: a fallback tries the *next* model only after the first fails, while
`/moa` calls several *deliberately*. Those must not share an implementation.

### §9 — `/compress` (on-demand compaction)

The compaction logic already exists — it is what context budgeting does on overflow. `/compress`
exposes it **on demand**, so a user can reclaim context before hitting the ceiling. The
implementable subtlety: an on-demand compaction must write a checkpoint or a summary that the next
turn reads, or the compression is undone as soon as the next prompt rebuilds the history.

### §0 H7 — browser copy only, no gateway change

"Cloud browser via Browser Use" maps onto the existing Playwright manager; only the option's label
changes ("Cloud browser (isolated context)"). Detail in `phases/09-BROWSER-AND-SANDBOX.md`, which
also records the constraint that the copy must not imply a *remote* browser — today's context is
local and ephemeral, so "isolated" is true and "cloud" alone would not be.

## Acceptance test

Unchanged and passing: kill the primary provider mid-stream → fallback completes the request; a 429
is retried per `Retry-After` and the circuit opens after N consecutive failures;
`SELECT sum(prompt_tokens) FROM "ModelUsage"` matches what the UI displays.

The last clause is the one that matters most for `v2.md`: it is the same two-honesty-rules
requirement that §12's Pulse and §3's mono-everywhere-numbers both rest on. A dashboard number
that cannot be reproduced with SQL against `ModelUsage` is a bug, not a rounding difference.

## Not this phase

`/moa` and `/compress` are **registered and honestly unavailable** today (both named in
`unavailable.commands.ts` with what will back them). Neither is a Phase 3 acceptance condition —
they are §9 additions that land with the gateway work.