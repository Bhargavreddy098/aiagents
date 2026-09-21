# Phase 0 — Scaffolding & Foundations (spec numbering)

**Status: ✅ done.** No `v2.md` change (this phase is infrastructure), one **new requirement**.

## What is built

| Piece | Detail |
|---|---|
| Monorepo | pnpm workspaces + turborepo: `packages/shared`, `apps/server` |
| `packages/shared` | Dependency-free and browser-safe (no `Error.captureStackTrace`) — it is imported by the future web bundle, so it cannot pull in Node built-ins |
| TypeScript | strict, `NodeNext` for the server, `bundler` for the web workspace |
| HTTP | Express 5 + helmet + CORS locked to the single configured `WEB_ORIGIN` (never a wildcard, with `credentials: true` for the auth cookies) + cookie-parser |
| Logging | pino, with a **correlation id** per request (gap #30) that threads request → job → run → step → SSE event |
| Config | `config.ts` is the **only** module that reads `process.env`; `loadConfig()` validates with zod and exits before binding a port if anything is missing |
| CI | lint + typecheck + unit tests on every push (gap #31) |
| Local infra | `docker-compose.yml`, `.env.example` (gap #32) |

## What `v2.md` requires here

**One new workspace: `apps/web`.** `v2.md`'s header locks the stack as *"Vite + React + Tailwind 4
+ shadcn/ui + TanStack Query + Zustand"* and its §2.1 shell assumes a React SPA exists. The
scaffolding phase therefore has unfinished business: the monorepo declares a web workspace in its
config and CI, but **the directory does not exist**.

Concretely, following the existing conventions rather than inventing new ones:

1. `apps/web` with the standard Vite scripts plus `test` (Vitest + Testing Library), and its own
   `eslint` in `devDependencies` — pnpm's isolated layout does not expose root devDeps, which is
   the trap this repo already hit once.
2. `tsconfig.json` extending the base with `"module": "ESNext"`, `"moduleResolution": "bundler"`,
   `"jsx": "react-jsx"`.
3. A Vite dev proxy or an env-driven API base URL pointing at the server; the SSE connection is
   the same origin story and must not become a CORS exception.
4. `turbo.json` gains the web tasks; CI's test step already assumes "web unit tests" exist.

Detail: `phases/13-FRONTEND.md` Step 0.

## Acceptance test

Unchanged, and it passes today: `GET /api/health` returns 200 with db + queue status, and a
failing test is caught by CI. The v2 addition is that `pnpm build` must also build `apps/web` —
which cannot be claimed until the workspace exists.

## Note on environment

The repo is **not** a git repository (`git status` fails at the workspace root), so the CI workflow
is a file that would run somewhere else rather than something running here. Worth knowing before
debugging why CI "did not run".