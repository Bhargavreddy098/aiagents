# Phase 14 — Seed, Tests & Hardening (spec numbering)

**Status: ◑ partial.** Tests are real and extensive (**921 across 43 files**, all green). What is
missing is the seed, the ops hardening, and the release sweep.

## What exists

| Piece | State |
|---|---|
| Per-phase tests | ✅ 43 files. Real repositories and services run against the DMMF-derived in-memory fake — stubbing them would test nothing, since tenant isolation lives in that layer |
| HTTP tests | ✅ `auth.http.test.ts`, `control.http.test.ts`, `stream.http.test.ts` — including "refuses every control-plane route without a cookie" |
| Tenant isolation | ✅ `repositories.tenant-isolation.test.ts` (parametrised) |
| Crash recovery | ◑ `run.recover` exists in the queue registry; the kill-and-resume test is not written |
| The gate | ✅ `lint` → `typecheck` (src **and** test) → `test` → `build` |
| Live boot smoke test | ✅ with no DB, `/api/health` → `503 {status:'degraded',db:'down',queue:'down'}` and every `/api/chat*` route → `401` |

## What does not exist

1. **`src/seed/seed.ts`.** The `package.json` `seed` script points at a file that is not there.
   Nothing in the repo can produce a demo tenant, so every manual test starts from an empty
   database.
2. **Graceful shutdown drain.** `server.ts` has the working signal-handler pattern, but the
   sequence *stop accepting → drain the active step → commit or park → exit* is not implemented
   for a step in flight.
3. **Health sweep job.** MCP server states, stale runs and stuck approvals are not swept on a
   schedule. (MCP *orphan* cleanup on disconnect does exist and is tested.)
4. **Tenant workdir cleanup.** Disk grows with finished-run artifacts; no TTL purge.
5. **Secrets rotation runbook.** Provider keys and refresh-token families have no documented
   rotation procedure.
6. **Load/limit tests.** `maxSteps` / `maxToolCalls` / `maxDurationMs` each terminate their run
   correctly in unit tests; they have never been driven at volume.
7. **The kill -9 chaos test** on a live run, asserting zero double-fired side effects.

## What `v2.md` requires of this phase

### §21 — the acceptance checklist grows a cross-surface axis

The v1 frontend checklist is unchanged. `v2.md` adds journeys that span surfaces, and they are
the hardest tests in the spec because they prove the *architecture* rather than a page:

1. **The full channel journey.** Pair a Telegram DM → chat with the agent from Telegram while a
   run executes elsewhere → an approval is posted in-chat *and* as a Telegram button message →
   Approve **from Telegram** → the run resumes, and the same row settles in the web Decision
   Inbox. This is H6/O4 made real, and it is the single most valuable test in `v2.md`.
2. **One decision, every surface.** An approval requested in web chat is approvable from a bound
   channel and vice versa.
3. **DM pairing end-to-end.** Unknown sender → 8-char code (1h expiry, cap 3/account) → Approve
   with notify + make-first-owner → the sender can DM. Dismiss path works.
4. **Device pairing.** Pair → Full/Limited → setup code/QR → approve pending with correct scopes;
   a re-request for broader scopes creates a **fresh pending**, never a silent widening.
5. **`soul.md` voice test** returns an in-voice reply via the gateway; editing mid-run does not
   change a pinned run.
6. **A skill installed from the Hub** appears as `/skill <name>` in the web composer, CLI/TUI
   autocomplete and channel menus — with the name-collision rule enforced.
7. **A schedule with a delivery target** posts to the bound channel and shows a delivery receipt.
8. **Handoff** replays the role-aware transcript and confirms in the new place.

Every one of these is **blocked** on the Surfaces backend (`SURFACES-BUILD-PLAN.md` S3–S7) and
the frontend (Phase 13). This file records them so the phase cannot be declared done without
them.

## The one environment caveat, stated honestly

**Signal handlers are not testable on this machine.** POSIX signals do not reach Node on win32
via Git Bash `kill`; a script with `process.on('SIGTERM'|'SIGINT')` receives neither and is not
terminated. So the graceful-shutdown work must be verified **by inspection against the
already-working `server.ts` pattern**, and any claim that "the shutdown test passes" would be
false. `kill -9` does work, which is what the chaos test uses.

Two other environment facts worth knowing before debugging a red test:

- The sandbox safe-delete shim blocks bulk temp unlinks, which is why
  `file.service.test.ts` can fail *only* inside the full suite (it passes 29/29 alone). That is
  an environment hazard, not a regression.
- `vitest` does **not** typecheck. A green suite plus a failing `build` is a normal state here,
  and it is why `typecheck` covers both tsconfigs and `build` runs `tsc` for real.

## Acceptance tests

1. `pnpm seed` creates a demo tenant, a user, a provider+model, one agent with a version, and one
   goal with a task — and is idempotent (running it twice does not duplicate).
2. `kill -9` a worker mid-run → on restart the run resumes from its checkpoint with **zero**
   double-fired side effects.
3. `maxSteps` exceeded → the run terminates `failed` with a clear reason, not a hang.
4. Health sweep marks a stale run and a stuck approval, and the fix for each is visible.
5. Workdir TTL purge bounds disk after N finished runs.
6. All v1 frontend checks plus the eight `v2.md` cross-surface journeys.
7. Every phase's acceptance test re-run in order, in CI, green.

## What is explicitly not in this phase

- A load-testing framework. `maxSteps`/`maxToolCalls`/`maxDurationMs` bounded by unit tests plus
  one chaos test is the bar; a benchmarking suite is a different project.
- Multi-region or HA topology. The locked stack is one Postgres and one worker.