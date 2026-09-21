# Phase 10 — Memory & Research (spec numbering)

**Status: ⛔ not started.** Models exist; nothing reads or writes them. There is no repository,
no service and no route for either feature.

## What exists

| Model | Columns that matter | Notes |
|---|---|---|
| `Memory` | `tenantId`, `agentId?`, scope, content, embedding | The vector column is `Unsupported("vector")` in Prisma, so a raw query is required — the fake DB does not emulate raw SQL and the one test that needs it stubs `rawQuery` explicitly |
| `ResearchProject` | `tenantId`, question, status | |
| `ResearchRun` | `projectId`, `runId?`, plan, result, sources, findings | `runId` is the link to a real engine run |
| `ResearchSource` | `runId`, url, title, contentRef, credibility, accessedAt | |
| `ResearchFinding` | `runId`, claim, evidence, verified, sourceIds | |

No `apps/server/src/repositories/memory.repo.ts`, no `services/memory/`, no
`/api/memory` route. `prisma/schema.prisma` is the whole of this phase today.

## What `v2.md` requires

### H10 — Memory is *reused*, not rebuilt

`v2.md` §0 maps Hermes' memory onto "Existing Memory page (pgvector + keyword fallback)". So the
UI contract is already decided and this phase's job is to make it true:

- `pgvector` similarity search **with a keyword fallback that is always available**. The fallback
  is not a nicety: `pgvector` is an extension, and a deployment without it must still answer,
  degraded rather than broken.
- Every number on the page traces to a `Memory` row — the standing rule.

### H9 / §9 — `/research` and `/context` land here

Both are currently registered as *present but unavailable* (`unavailable.commands.ts`), each
naming what will back it. When this phase lands, both become real:

- **`/research <question>`** creates a `ResearchProject` plus a `ResearchRun` linked to a real
  engine run, and collects the sources the run actually visited. It must not fabricate a
  project id — the existing test asserts the unavailable reply contains neither `prj_` nor the
  word "created", and that assertion should be *replaced* by one proving the real command
  creates exactly one project.
- **`/context`** answers "why was my file ignored?" — which means it depends on Phase 6's
  persona files (`soul.md`, `IDENTITY.md`, `USER.md`) and their load states
  (`loaded` / `truncated` / `shadowed`). If this phase lands first, `/context` must report only
  what exists rather than inventing a persona.

### §9 — the registry entry must be retired, not duplicated

Removing a command from `PENDING` in `unavailable.commands.ts` is the *last* step, in the same
commit that adds the real one. Two entries with the same name throw
(`Duplicate slash command: /research`) — which is the registry defending itself, and the reason
the swap must be atomic.

## The decision that must be made before writing any code

**Memory scoping is unresolved.** The model carries both `tenantId` and a nullable `agentId`,
which admits three different products:

1. **Workspace memory** — one pool per tenant, every agent sees it. Simple; leaks one agent's
   notes into another's context.
2. **Per-agent memory** — `agentId` is required, `tenantId` is the isolation boundary. Safe;
   an agent cannot learn from a sibling's experience.
3. **Both, ranked** — agent memory first, workspace memory as a fallback. Most useful, and the
   only one that needs a written rule for what "ranked" means at retrieval time.

This is a spec gap, not an implementation detail: it determines the schema (is `agentId`
nullable or not), the retrieval query, and what the page's "scope" column means. Decide it, put
the answer in `README.md`, then build. **Do not** let it be decided implicitly by whichever
query gets written first.

## Acceptance tests

1. Similarity search returns rows ordered by distance, and the keyword fallback returns the same
   answer shape when `pgvector` is absent.
2. Tenant isolation: tenant B's memories are invisible to tenant A (parametrised, like every
   other `list()`).
3. Whichever scoping rule is chosen, an assertion proves it — including the negative case
   (agent 1 cannot retrieve agent 2's memory under rule 2).
4. `/research <question>` creates exactly one project and one run, and the run is a real engine
   run with a `Run` row.
5. `/context` reports load state per file and does not claim a file loaded when it was truncated.
6. Deleting a project cascades its runs, sources and findings, and leaves no orphan.

## What is explicitly not in this phase

- A memory *editor* UI (Phase 13 renders the page read-only, per §0's "reuse").
- Automatic memory extraction from every chat turn. Memory is written deliberately, so that
  "why is this in my context?" always has a row behind it.