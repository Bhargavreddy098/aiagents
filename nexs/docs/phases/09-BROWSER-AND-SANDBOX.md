# Phase 9 — Browser & Sandbox (spec numbering)

**Status: ◑ folded into Phase 4.** The genuinely-new work of this phase was built under Phase
4's scope. Nothing is pending *from this phase*, and that is the honest situation rather than a
completion claim: this phase never had its own build pass, so it also has no dedicated tests or
artifacts that name it.

## What already exists (built in Phase 4)

| Component | Where | What it does |
|---|---|---|
| `BrowserManager` | `services/browser/browser-manager.ts` | Playwright, headless by default; open / act / close; screenshot capture with a size cap; per-session ephemeral storage |
| `PlaywrightLauncher` | `services/browser/launcher.ts` | Process-level launch, isolated so tests substitute a fake |
| Reconcile / orphans | `browser-manager.ts` (`reconcile()`) | Sweeps sessions whose process died, so a leaked Chromium context is reclaimed |
| `BrowserSession` | schema | One row per session, with `status` and `screenshotRef` |
| Node sandbox | `services/sandbox/node-worker.provider.ts` | **`worker_threads` with `resourceLimits`** — JS isolation in-process, with a wall-clock ceiling that kills an infinite loop |
| Sandbox rows | `SandboxSession` / `SandboxExecution` | One row per execution, with exit code and status |
| `/browser` command | `services/chat/commands/control.commands.ts` | `/browser <url> <screenshot\|title\|text>`; opens, reads, and **always closes** in a `finally` |

Proven by `test/browser.manager.test.ts` (31 tests), `test/sandbox.provider.test.ts` (26 tests,
including "the wall-clock ceiling kills an infinite loop instead of waiting for it") and
`test/file.service.test.ts`.

## What `v2.md` requires of this phase

### H7 — Browser stays, with one copy change

`v2.md` §0 maps Hermes' "cloud browser via Browser Use" onto the existing Browser page and asks
only for the option to read **"Cloud browser (isolated context)"**. There is nothing to build:
per-session ephemeral contexts already *are* an isolated context, so the copy would be
describing something true. It belongs in Phase 13 (the Browser page's header).

**One constraint on that copy:** it must not imply a remote browser. Today's context is local
and ephemeral; "isolated context" is accurate, "cloud" alone would not be. The upgrade path to
persistent or remote contexts is documented in the code and is *not* part of this phase.

### H8 + §4.4 — Sandbox exec becomes approval-gated

This is the real work, and it is mostly in Phase 4's territory with a presentation half here:

1. An **exec approval** — `Approval.kind = 'exec'`, `requestedAction: ExecRequestedAction`
   (`{ command, args, cwd }`), outcomes `allow_once` / `allow_always` / `deny` (§4.4).
   The `kind` column exists (added with the Surfaces migration); the flow does not.
2. `allow_always` writes a **tool allowlist rule**, so the second invocation does not ask.
3. Only the configured **owner** (`operator.admin`, §5.6) may grant either — a non-owner
   attempting it gets `FORBIDDEN`, not a silent no-op.
4. `deny` must fail the step through the same path a rejection takes, so the run does not stay
   parked.

Owned by `SURFACES-BUILD-PLAN.md` S6, because the owner identity and the approval surface are
both Surfaces-domain concepts. This file records the requirement, not a second implementation.

## Design constraints that must survive

- **`cwd` is part of the approval.** `npm test` in two repositories is two different actions;
  an approval that omitted the directory asks the operator to authorise something they cannot
  see (§4.4's own reasoning, encoded in `ExecRequestedAction`).
- **`allow_always` is scoped, never global.** It writes a rule for *that* command in *that*
  directory. A blanket "allow everything" would make the second approval the last one ever.
- **The sandbox ceiling stays.** An approved command still runs under the wall-clock limit; an
  approval authorises *running* something, not running it forever.
- **Never `child_process` `resourceLimits`.** It does not exist there — this is the Phase 4
  trap that `worker_threads` exists to avoid, and it must not be reintroduced by exec support.

## Acceptance tests

1. A command with no approval rule parked at `waiting_approval`; `allow_once` resumes it and a
   second identical command parks again.
2. `allow_always` writes one allowlist rule; the second identical command does **not** park, and
   a *different* command still does.
3. A non-owner calling the decision endpoint gets `FORBIDDEN` and the approval stays `pending`.
4. `deny` fails the step (not the whole run) and the run does not stay parked.
5. An approved command that loops forever is still killed by the wall-clock ceiling.
6. A screenshot over the size cap is rejected rather than stored.
7. `reconcile()` reclaims a session whose browser process was killed mid-read.

## What is explicitly not in this phase

- Persistent browser profiles / remote browser hosting (documented upgrade path only).
- OS-level process isolation (a container or `ulimit`) — the `worker_threads` provider is the
  locked choice.
- Any browser **write** action in a slash command. `click`, `type` and `upload` stay in the
  approval flow; `/browser` reads only, which is why its action vocabulary is
  `screenshot | title | text`.