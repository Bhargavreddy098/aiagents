# NEXS — phase status, verified against the code, aligned to `v2.md`

**Verification basis:** the tree in `agents/nexs/` at the time of writing, plus a full gate run
(`lint` → `typecheck` → `test` → `build`) that exits 0 with **921 tests across 43 files**.

## How to read the numbers

There are **two different 14-phase lists** in the inputs and the numbers are not
interchangeable:

| Source | Numbering |
|---|---|
| `nexs-build-spec.md` | `PHASE 0 … PHASE 14` — 15 headings. **7 = Approvals, 8 = Chat** |
| `docs/03-BUILD-PLAN.md` | a different 14-way split. **7 = Chat** |

This file uses the **spec** numbering, because that is the list the code was built against.
Always name a phase by subject, never by number alone.

## The count

- **Phases 0–8 are complete and verified — 9 headings, 8 of the numbered 1–14.**
- **Phase 9 is folded into Phase 4** (its genuinely-new work was built under Phase 4's scope).
- **Phases 10–14 are the remaining six:** 3 not started, and 2 partially built.
- **`v2.md` adds a ninth subject**: the Surfaces domain (`v2.md` §5/§20), which is what the
  last column of the table tracks. It is currently at its data-model + contracts layer.

## Phase-by-phase

| # | Subject | Status | What is actually there | What `v2.md` changes here |
|---|---|---|---|---|
| 0 | Scaffolding & foundations | ✅ done | pnpm + turbo monorepo (`packages/shared`, `apps/server`), TS strict, Express 5, pino with correlation ids, helmet/cors/cookies, CI workflow, docker-compose, `.env.example`, `loadConfig()` with zod | Nothing backend. Adds the *requirement* for an `apps/web` workspace — which does not exist yet |
| 1 | Database layer | ✅ done | 52 models, `20260918000000_init` + pgvector, tenant isolation structural (`tenantId` first, plain indexed scalar, never a relation) | **Changed:** +9 models (`Channel`, `ChannelAccount`, `AccessGroup`, `PairingRequest`, `Device`, `DeviceToken`, `Binding`, `Plugin`, `SkillHubEntry`), +3 field sets (`Schedule.deliveryTarget`, `Approval.kind`, `ChatSession.surface/channelType/peerRef`), migration `20260919000000_surfaces` |
| 2 | Auth & tenancy | ✅ done | JWT access + refresh rotation with token families and theft detection, password reset with hashed single-use tokens, per-route rate limits, cookie flags | **Adds a peer identity system:** device pairing tokens (`DeviceToken.tokenHash`, single-use, 10-min) and the command **owner** (`operator.admin`). Distinct from user auth — a paired CLI is not a user |
| 3 | Vault, providers, models, gateway | ✅ done | `ModelGateway` is the only provider-SDK importer; fallback chain, `Retry-After` handling, per-provider circuit breaker, context budgeting (truncate → summarise), `ModelUsage` on every call | §0 H7 relabels the browser option "Cloud browser (isolated context)"; §9 wants `/moa` (fan-out + reconcile) and `/compress` (on-demand compaction). **Not built** |
| 4 | Tool registry, MCP, connectors | ✅ done | MCP full lifecycle (`initialize` → `tools/list` → `tools/call`), pid tracking + zombie reaping, native tools, tool-result cap, `worker_threads` sandbox with `resourceLimits`, Playwright manager with ephemeral contexts, `FileService` with realpath + symlink guards | §0 H8 + §4.4 want an **exec approval** for owner-only commands (allow-once / allow-always / deny). The `Approval.kind` column exists; the flow does **not** |
| 5 | Execution engine | ✅ done | plan → act → observe → verify, `ApprovalGate` parking, checkpoint + resume, execution receipts, verifications, `maxSteps`/`maxToolCalls`/`maxDurationMs` limits | §9 wants mid-run controls that need engine support: `/steer` (a note delivered between tool calls), `/loop` (bounded repeat), `/snapshot`/`/diff`/`/rollback`. **Not built** — the registry names them honestly |
| 6 | Agents, goals, tasks, workflows | ✅ done | agent versioning via an immutable `AgentVersion` + `Run.agentVersionId` FK, CAS claim/version-bump/pin, goals cannot complete without verification, workflows versioned | §6 adds a **Persona tab / `soul.md`** (SOUL.md + IDENTITY.md + USER.md as prioritised context files, editable mid-run without affecting a pinned run) and an exec-approval toggle beside `approvalPolicy`. **Not built** |
| 7 | Approvals & notifications | ✅ done | CAS `decide`/`expire` (`updateMany` + `count === 1`) with `expiresAt` guards both ways, `pending → approved\|rejected\|expired` with terminal states, pg-boss `approval.expire`, notifications fanned out to every tenant member with `linkRoute` | §4.3/§11 make this **the** cross-surface feature: `kind: tool\|exec`, a source chip (which surface asked), Approve/Reject as native channel buttons resolving the *same* row, and §4.6 delivery receipts as a `schedule_result` notification |
| 8 | Chat | ✅ done | `ChatTurnRunner` with tool loop, SSE deltas, slash commands, `@` mentions over bounded pages, one shared `resolveRunContext`, attachments/folder grants, chat run claimed by the watching connection | **Changed in this pass:** the command registry now carries `surfaces` + `adminOnly`, a shared `visibleCommands()` policy filter, `/whoami`, and the full v2 §9 command list; `/help` filters by policy. Still to come: §4.1 surface chip, §4.3 in-chat `ApprovalCard`, §4.5 `/handoff` |
| 9 | Browser & sandbox | ◑ folded into 4 | The genuinely-new work of this phase was already built under Phase 4's scope (Playwright manager, sandbox provider). Nothing is pending from it | §0 H7/H8: Browser stays; add the "cloud browser" copy and make sandbox/exec an approval kind. Neither needs new browser work |
| 10 | Memory & research |  not started | Models only: `Memory` (pgvector column + keyword fallback), `ResearchProject/Run/Source/Finding`. No repository, service or route | §0 H10 reuses the Memory page as-is. §9's `/research` and `/context` land here. The memory *scoping* rule (tenant + agent) must be decided before pgvector is used |
| 11 | Events & scheduling | ⛔ partial | `Event` (+`externalId` dedupe), `EventSubscription`, `Schedule` (cron/timezone/`nextFireAt`), and the pg-boss registry. `TaskService` **refuses** `recurring`/`event` triggers with `FEATURE_DISABLED`; no scheduler loop exists | §10 upgrades every schedule with a **delivery target** (`Schedule.deliveryTarget`, column added). §9's `/heartbeat` and `/loop` are session-scoped and explicitly *not* durable recurrence — the copy must keep the two apart |
| 12 | Real-time (SSE) & dashboard | ◑ partial | SSE is **done**: `EventBus` (`InMemoryBus` / `PgNotifyBus`), `/api/stream`, the full event catalog, reconnect contract, heartbeats. The **dashboard does not exist** | §12 demotes the dashboard to **Pulse** (a monitor, not the home) and §2.3 adds a persistent **Surfaces strip**. 12 events were added for it (`channel.*`, `pairing.*`, `device.*`, `binding.*`, `plugin.updated`, `skill.installed`) |
| 13 | Frontend |  **not started** | **`apps/web` does not exist.** No Vite app, no React, no routes, no pages, no `useSSE` hook | **This is where the bulk of `v2.md` lives.** §2.2's route table, Chat as the home route, and §13's component specs (ApprovalCard, PairingRequestRow, DevicePairCard, SoulEditor, SkillCard, SlashMenu, SurfaceStatusStrip, HandoffAction…) |
| 14 | Seed, tests, hardening |  partial | Tests are real and extensive (921 / 43 files). `src/seed/seed.ts` **does not exist**; graceful-shutdown drain, workdir TTL purge and the provider-health cron are not implemented | §21's design-QA checklist adds cross-surface journeys (pair a Telegram DM → approve from Telegram → prompt settles in web), the audience being **`apps/web`** |

## Where `v2.md`'s Surfaces domain sits

| Step | Status |
|---|---|
| Data model (9 models + 3 field sets + migration) | ✅ done, `prisma validate` exit 0 |
| Shared contracts (types, schemas, 12 SSE events) | ✅ done, compiles |
| Repositories | ◑ 1 of 7 (`Channel`, `ChannelAccount`) |
| Services / HTTP / exec approvals / delivery targets | ⛔ not started |
| UI pages | ⛔ blocked on Phase 13 |

Detail and acceptance tests: `SURFACES-BUILD-PLAN.md`.

## What changed in this pass

1. **`v2.md` §9 — the unified command registry.** `SlashCommand` gained `surfaces` and
   `adminOnly`; `CommandDraft` lets each module state only what it knows; defaults are applied
   once in `createSlashCommands`; `visibleCommands()` enforces §5.2's `allow_admin_from` /
   `user_allowed_commands` split including the `/help` + `/whoami` floor; `/help` filters by
   policy and prints the owner/surface badges; **`/whoami`** is new.
2. **`v2.md` §9 — registry completeness.** All 28 not-yet-backed commands (the §3.8 three plus
   v2's 25) are present and each names what will back it, so the palette is complete without any
   of it lying about being runnable.
3. **`/skills` copy corrected.** It claimed skills were "not a table in this schema" — false:
   `Skill` and `SkillVersion` exist. It now points at §7's Skills Hub.

## One honest gap in the registry change

**Dispatch-time enforcement is not wired.** `visibleCommands()` filters what is *listed*, but
`SlashCommandService.run()` does not yet refuse an `adminOnly` command for a non-owner. That is
deliberate rather than an oversight: no channel exists yet, so no caller supplies a
`CommandRegistryPolicy` and there is no policy to enforce. The enforcement point belongs with
the channel adapters, where the policy comes from — writing it now would be a branch that no
code path can reach, and it would not be covered by any test that proves anything. Tracked in
`SURFACES-BUILD-PLAN.md` (S5).