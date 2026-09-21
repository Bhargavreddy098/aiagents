# Phase 1 — Database Layer (spec numbering)

**Status: ✅ done — and the phase `v2.md` changes most.** Nine models were added and three existing
models gained fields in this pass.

## What is built

- **Postgres 16 + pgvector**, via `prisma/migrations/20260918000000_init` (with
  `CREATE EXTENSION vector`).
- **52 models** covering tenancy, auth, providers, models, tools, MCP, connectors, agents,
  goals, tasks, workflows, schedules, events, runs, steps, tool calls, receipts, verifications,
  actions, approvals, chat, memory, browser, sandbox, research, skills, attachments, grants,
  notifications.
- **Tenant isolation is structural, not conventional.** `tenantId` is a plain **indexed scalar**
  on child models and deliberately **not** a Prisma relation: declaring back-relation arrays is
  exactly what made `docs/02-DATA-MODEL.md` fail validation with 11 errors. Isolation is enforced
  in the repository layer — `tenantId` is the first argument of every method and appears in every
  `where`, and updates use `updateMany({ where: { id, tenantId } })`, never `update({ where: { id } })`.
- **Documented exceptions** (rows with no `tenantId` column): `Step` (by `runId`), `MCPTool` (by
  `serverId`), `AgentVersion` (by `agentId`), `WorkflowVersion` (by `workflowId`), `WorkflowStep`
  (by `versionId`). Each is guarded by an `assertOwnedBy(tenantId, ownerId)` re-read of the owning
  row, so possessing a child id is not a capability.

## What `v2.md` §20 adds — applied in this pass

### Nine new models (`v2.md` §5, §20)

| Model | Purpose | The constraint that matters |
|---|---|---|
| `Channel` | A messaging channel | `@@unique([tenantId, type, name])`; `status` stored, with `unverified` as a real state meaning "no successful contact yet" |
| `ChannelAccount` | One identity on a channel | `@@unique([channelId, label])`; `allowFrom` / `groupAllowFrom` hold literal ids **and** `accessGroup:<name>` refs |
| `AccessGroup` | A reusable sender set | `@@unique([tenantId, name])`; `type` defaults to `message.senders` |
| `PairingRequest` | A DM asking to be let in | **No unique constraint on the sender** — one-pending-per-sender and cap-3-per-account are rules about current state, enforced in the service where both facts are read together |
| `Device` | A paired client | `access` is stamped *into* `scopes` at pairing time, so a token that meant `operator.admin` keeps meaning it |
| `DeviceToken` | Bootstrap or session token | `tokenHash` unique; single-use (`usedAt`), 10-minute expiry |
| `Binding` | Which agent answers a surface | `@@unique([tenantId, matchKey])` — see below |
| `Plugin` | Bundled or external | `@@unique([tenantId, name])`; `kind` ∈ channel/transport/capability/device-pair |
| `SkillHubEntry` | Read-only skills catalog | `slug` unique; **global**, not tenant-scoped — the only table here that is |

### Three additive field sets

| Model | Fields | Why |
|---|---|---|
| `Schedule` | `deliveryTarget Json?` | §10: where a fired schedule's output goes. Null means "nowhere", and the run + receipt still exist |
| `Approval` | `kind String @default("tool")` | §4.4/§11: `tool` is the plan-step gate; `exec` is an owner-only command whose answers are allow-once / allow-always / deny |
| `ChatSession` | `surface` (default `web`), `channelType`, `peerRef` | §4.1/§4.5: a conversation knows where it started, which is what `/handoff` rebinds and "Started on Telegram · DM you" reads |

### The one design decision worth reading twice

**`Binding.matchKey` is the identity, not the three route columns.** Every part of a route is
optional, and Postgres treats each `NULL` in a unique index as *distinct* — so
`@@unique([tenantId, channelType, accountId, peerId])` would happily store two identical
"any channel, any peer" rules and make "most specific wins" undefined. `matchKey` joins the three
parts with `|` and uses `*` for a wildcard, so specificity is a **property of the key**:

```
telegram|acct_1|peer_9   → 3 non-wildcards   (most specific)
telegram|acct_1|*        → 2
telegram|*|*             → 1
*|*|*                    → 0                 (catch-all)
```

The constraint is then real, and two distinct keys can never tie. `bindingMatchKey`,
`bindingSpecificity` and `bindingMatchOrder` in `packages/shared/src/types/surfaces.ts` are the
only implementations of that idea.

## Migration

`20260919000000_surfaces/migration.sql` — **generated, never hand-written**:

```bash
prisma migrate diff --from-schema-datamodel <before>.prisma \
                    --to-schema-datamodel prisma/schema.prisma --script
```

All three `ALTER TABLE`s are nullable-or-defaulted, so the migration is safe against a database
that already holds rows: existing schedules keep delivering nowhere (which is what they did),
existing approvals are `tool` gates, and existing sessions started on `web`.

Verified: `prisma validate` → exit 0; `prisma generate` → exit 0 (so `test/helpers/fake-db.ts`,
which derives its models from Prisma's DMMF, knows all nine new models with no extra work — a
model added to the schema cannot leave the fake behind).

## A trap worth recording

**Prisma schema comments are `//` only.** A `/** … */` block comment is a validation error
(`P1012`, "This line is invalid. It does not start with any known Prisma schema keyword"), not a
style preference. The existing schema uses `//` throughout; the nine new models follow it.

## Acceptance test

Unchanged and passing: two tenants cannot read each other's rows. Extended in spirit to the new
tables — every new repository method takes `tenantId` first, and tenant isolation is parametrised
over each new `list()`. `SkillHubEntry` is the single, documented exception, and nothing in a run
reads it.