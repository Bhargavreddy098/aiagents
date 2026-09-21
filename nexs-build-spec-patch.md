# NEXS Build Spec — Patch 01

**Applies to:** `nexs-build-spec.md` (v2.0 "gap-closed")
**Status of source file:** **unmodified.** This patch is a separate overlay; apply it by hand or
feed it to an implementing agent alongside the spec.

**Verified on:** 2026-09-17 · Prisma CLI 5.22.0 · `prisma validate`
**Source hashes at patch time:**
`nexs-build-spec.md` = `2eab65db9c433e379b59f0dcd934c9994272a6eeff915150397538bd1bd39ef6`
`PRD.md` = `dcab3e59173e178506f9f9ded6add3f1f27e884a68dd290dd4cfa6237fd3b3aa`

---

## Part A — Prisma schema corrections

The spec claims §3 is a "complete, valid Prisma" schema. Validating the `prisma` block as
written produces **16 errors**. Three of them are documentation-formatting artifacts that
cascade into 14 more; two are genuine modelling defects. Apply A1–A5 before Phase 1, or
`prisma migrate dev --name init` will not run.

### A1 — `generator` / `datasource` must be multi-line blocks

Prisma's parser does not accept single-line block declarations. As written, everything after
line 1 is parsed as if it were still inside the `generator` block, which is the source of the
14 cascading errors.

```prisma
// ❌ as written in §3
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }
```

```prisma
// ✅ corrected
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

### A2 — `model Tenant` must not be one line

Prisma does not accept `;` as a field separator. Expand to one field per line.

```prisma
// ❌ as written in §3
model Tenant { id String @id @default(cuid()); name String @default("Personal"); users User[] }
```

```prisma
// ✅ corrected
model Tenant {
  id    String @id @default(cuid())
  name  String @default("Personal")
  users User[]
}
```

### A3 — `ChatMessage.runId` is missing its opposite relation field

`Run.chatMessages ChatMessage[]` has no counterpart on `ChatMessage`, so the relation is
one-sided and rejected. This is a **real defect**, not formatting.

```prisma
// ❌ as written in §3
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
```

```prisma
// ✅ corrected — add the relation field
model ChatMessage {
  id            String   @id @default(cuid())
  tenantId      String
  runId         String?
  run           Run?     @relation(fields: [runId], references: [id])
  role          String   // user | assistant
  content       String
  toolCalls     Json?    // [{ name, args, result?, ok }] transcript for the UI
  attachmentIds String[] @default([])
  createdAt     DateTime @default(now())
  @@index([tenantId, createdAt])
}
```

### A4 — `Action` ↔ `Approval` is modelled as two overlapping 1:1 relations

Both sides declare `fields`/`references`, each with its own FK, creating a circular 1:1.
Prisma rejects this outright:

> *The relation fields `action` on Model `Approval` and `approval` on Model `Action` both
> provide the `fields` argument in the @relation attribute. You have to provide it only on
> one of the two fields.*

**Decision:** let `Approval` own the FK (it matches the write order — an `Action` is recorded
first, then an `Approval` points at it). `Action` keeps a plain back-relation and loses its
now-redundant `approvalId` scalar.

> ⚠️ **Breaking change for the API surface.** §3 documents `Action.approvalId`. Any service or
> controller that reads `action.approvalId` must instead read `action.approval?.id`, or query
> `Approval` by `actionId`. Nothing else in Parts 4–6 depends on it.

```prisma
// ❌ as written in §3 (Action)
model Action {
  id                  String    @id @default(cuid())
  tenantId            String
  runId               String?
  agentId             String?
  kind                String
  title               String
  description         String?
  payload             Json
  risk                Json      @default("{}")
  requiredPermissions String[]  @default([])
  status              String    @default("pending")
  approvalId          String?   @unique
  approval            Approval? @relation(fields: [approvalId], references: [id])
  createdAt           DateTime  @default(now())
}
```

```prisma
// ✅ corrected (Action) — back-relation only
model Action {
  id                  String    @id @default(cuid())
  tenantId            String
  runId               String?
  agentId             String?
  kind                String
  title               String
  description         String?
  payload             Json
  risk                Json      @default("{}")
  requiredPermissions String[]  @default([])
  status              String    @default("pending")
  approval            Approval?
  createdAt           DateTime  @default(now())
}
```

`Approval` is **unchanged** and remains the owning side:

```prisma
// ✅ Approval — no change needed
model Approval {
  id                  String    @id @default(cuid())
  tenantId            String
  actionId            String    @unique
  action              Action    @relation(fields: [actionId], references: [id])
  // …remaining fields as written in §3
}
```

### A5 — Validation evidence

| Schema variant | Result |
|---|---|
| §3 verbatim | 16 errors (P1012) |
| + A1, A2 (formatting) | 5 errors |
| + A3, A4 (relations) | **`The schema is valid`** |

Reproduce:

```bash
# extract the ```prisma block from nexs-build-spec.md, then:
DATABASE_URL="postgresql://u:p@localhost:5432/db?schema=public" npx prisma@5 validate --schema=schema.prisma
```

> Note: `validate` also requires `DATABASE_URL` to be present, even for a pure syntax check.
> A dummy value is sufficient.

---

## Part B — Four sections that exist only in `PRD.md`

`nexs-build-spec.md` is a superset of the older drafts **except** for these four items, which
appear only in `PRD.md`'s "Part 6 / Part 7" appendix. Ported below into the spec's numbering
and voice.

### B1 — §2.7 Response caching (L2)

> Conflicts with §0 rule 5 ("No Redis"). Resolve by keeping Postgres as the default driver and
> treating Redis as an opt-in upgrade.

```
Config: CACHE_DRIVER=postgres | redis | none   (default: postgres)
        CACHE_TTL_SEC=86400

Key:    model:<providerSlug>:<externalModelId>:<sha256(normalizedRequest)>
        normalizedRequest = { messages, tools, temperature, maxTokens } — sorted keys,
        tool schemas included so a tool-less call never hits a tool-bearing entry.

Behaviour:
  - Only cache deterministic calls: temperature === 0 and no idempotencyKey.
  - On hit → return the cached ChatResult, mark receipt metadata { cached: true }.
  - On miss → call the gateway, write the row, return.
  - Never cache: streamChat, embed, tool-calling loops, or any error response.
  - Store as a Postgres table (model, providerSlug, promptHash, response Json, expiresAt)
    with a unique index on the key; a `cache.evict` pg-boss job prunes expired rows hourly.
```

### B2 — §2.8 LLM context-window guard

```
Before every ModelGateway.chat / streamChat:
  1. Resolve the target Model.contextWindow. If null, treat as 8192 and log a warning.
  2. Estimate prompt tokens (provider tokenizer when available, else ceil(chars / 4)).
  3. Budget = floor(contextWindow * 0.95) - maxTokens.
  4. If prompt exceeds the budget:
       - drop oldest non-system messages until it fits, recording which were dropped;
       - if a single system message alone exceeds the budget → fail fast.
  5. On exhaustion, throw ApiError('CONTEXT_WINDOW_EXCEEDED', 422, { contextWindow,
     estimatedTokens, droppedMessages }) — never silently truncate.

Add CONTEXT_WINDOW_EXCEEDED to the §3.2 error table.
Emit `chat.limit.reached` when the guard trips inside a chat run.
```

### B3 — §2.9 Feature flags

```
Env (zod-parsed in config.ts, all default true):
  FEATURE_MCP · FEATURE_CONNECTORS · FEATURE_SANDBOX

Server: when a flag is false, mount no routes for that prefix and have the corresponding
  service throw ApiError('FEATURE_DISABLED', 404).
Web:    read the resolved flags from GET /api/health and hide the matching nav entries
        (MCP, Connectors, Sandbox) in the §6 shell.

CI: run the matrix twice — once with all flags true, once with all false — so both code
    paths stay green.
```

### B4 — §9 References (links corrected)

Four of the six links in `PRD.md` Part 7 resolve; **two are dead (HTTP 404)**. Corrected table:

| Topic | URL | Status |
|---|---|---|
| MCP specification | https://modelcontextprotocol.io | live |
| Durable execution for agent runtimes | https://zylos.ai/research/2026-04-24-durable-execution-agent-runtimes/ | live |
| AES-256-GCM implementation notes | https://veilock.com/blog/aes-256-gcm/ | live |
| SSE vs WebSocket for LLM streaming | https://doc.tokenpapa.ai/en/docs/blog/streaming-websocket-llm-guide | live |
| pg-boss | https://pgboss.io · https://github.com/timgit/pg-boss | **corrected** |
| ~~pg-boss (as listed in PRD.md)~~ | ~~https://github.com/ross/improved_cron~~ | **404 — wrong project** |
| ~~OpenAI gateway reference~~ | ~~https://github.com/laughingman777/openai-gateway~~ | **404 — dead, no replacement found** |

> Caveat: a 200 response proves a URL is live, not that it is authoritative. The three
> third-party blogs (zylos.ai, veilock.com, tokenpapa.ai) are unvetted — they were carried
> over from `PRD.md` and should not be treated as normative. The MCP spec and pg-boss links
> are the only ones worth citing in code comments.

**Neither dead link removes a component from the architecture.** `PRD.md` Part 7 is a
*reading list* ("Topic → URL"), not a dependency manifest:

- **pg-boss is a live, actively maintained package** — `npm i pg-boss`,
  https://github.com/timgit/pg-boss, docs at https://pgboss.io. Only the URL printed in
  `PRD.md` was wrong (it pointed at an unrelated cron project). The §1.4 decision stands
  unchanged, and it remains the Redis-free scheduling choice.
- **The Model Gateway is our own internal service**, not a third-party dependency. It lives at
  `apps/server/src/services/models/` (`ModelGateway`) and is defined by §0 rule 3, §1.3, and
  §4-PHASE3.4. There is nothing to install, so a dead external "OpenAI gateway" link has no
  bearing on it — the name collision between that link's label and our component is
  coincidental. Drop the link; keep the gateway.

---

## Checklist

- [ ] A1 `generator` / `datasource` expanded
- [ ] A2 `model Tenant` expanded
- [ ] A3 `ChatMessage.run` relation added
- [ ] A4 `Action.approvalId` removed, back-relation kept — **and audit call sites**
- [ ] A5 re-run `prisma validate` → expect "The schema is valid"
- [ ] B1 cache config + `CACHE_DRIVER` added to `.env.example` (§2.3)
- [ ] B2 context guard + `CONTEXT_WINDOW_EXCEEDED` added to §3.2
- [ ] B3 feature flags added to §2.3 and §6 shell
- [ ] B4 reference table replaced
