# NEXS Agent Control Plane — project memory

> Detail: `.workbuddy-ai/memory/2026-09-*.md`. Workflow: the `nexs-phase-build` skill.

## Hard rules
- **Never modify the user's documents** (`nexs-build-spec.md`, `PRD.md`, `docs/`, `gaps.md`, `v2.md`,
  `message-*.md`) — inputs only. New artifacts: `nexs/` or a root `*-report.md`.
- `agents/nexs/` = pnpm + turbo: `packages/shared`, `apps/server`, `apps/web` (Vite 5 + React 19 +
  react-router 6 + TanStack Query 5, plain CSS on §6.3 tokens, **no Tailwind**).
- **Tenant isolation is structural**: `tenantId` is the FIRST arg of every tenant-owned repo method and
  appears in every `where`. Updates use `updateMany({where:{id,tenantId}})`.
- **`config.ts` is the only module reading `process.env`**; the rest take `Config` by injection.
- **The vault key is derived, not configured**: `hkdfSync('sha256', JWT_SECRET, 'nexs.vault.v1',
  'provider-credential-encryption', 32)`. There is no `NEXS_MASTER_KEY`. Rotating `JWT_SECRET` makes
  every stored credential undecryptable — and the ciphertext is the only record of the old key.
- **Two honesty rules**: every number on screen traces to a DB row; only `ModelGateway`, `MCPManager`
  and `FileService` touch providers, MCP, or the filesystem.
- **`POST /api/chat`'s response is a frame sink** (`onFrame` → `encodeSseFrame`), the same encoder the
  hub uses. It used to be a 13-byte `: connected` with zero frames on a 1238 ms turn.
- **Two conflicting phase lists** (spec 0→14; `docs/03-BUILD-PLAN.md` another 14) — name a phase by
  **subject**, never by number. No Phase 15.

## Status (2026-09-21)
- **0–13 done**; of 14: seed, backend matrix, security pass done — only Playwright e2e open.
- **Light-first theme**: `:root` = light, §6.3 dark verbatim under `[data-theme='dark']`; `--accent` →
  `#2f6fe0` and darker status hues (`nexs-light-theme-report.md`). The pre-paint script in
  `index.html` duplicates the storage key; `theme.test.tsx` guards the drift.
- **Shell = three regions** (56px rail + 248px panel + main, soft-UI `--neu-*`). Panel tabs: Sessions |
  Agents | **Settings** (last). Topbar: `⌘K Search` + `?`.
- **`/cli` terminal**: evaluates **JavaScript** via `POST /sandbox/:id/exec` — no shell. `prepareCode`
  wraps a single expression in `return (…)`; the engine runs the snippet as a **function body**.
- **HTTP surface CLOSED** — all 26 spec prefixes mounted (+ `/api/skills`).

## Open gaps
- A duplicate delivery can double-execute a LIVE run (`RunRepository.claim` compares status and
  `running` is in `allowedFrom`); needs a heartbeat-conditional reclaim.
- A `sandbox` workflow step cannot be authored; `SkillHubEntry` has no repository.

## Traps
- **A comment asserting a guarantee is a claim, not evidence** — grep for the code enforcing it.
- **A `.strict()` query schema makes a wrong parameter name a 400, not an ignored filter** — and the
  page then renders its *empty* state, which reads as "no rows". Pin query strings against the schema.
- **A harness without `StrictMode` tests a tree the app never renders** (`main.tsx` has it).
- **Never batch two `Edit` calls on the same file** — the last write wins silently.
- **Hand-written CSS fails silently** — a wrong token name is just a dropped declaration; diff
  used-vs-defined against `dist/assets/*.css`. Lighting a neumorphic surface needs a screenshot.
- **Never chain the gate with `&&`** — a skipped `$OUT` assignment leaves the loop running every
  command with an empty redirection while printing "done": a phantom green. Re-run typecheck last.
