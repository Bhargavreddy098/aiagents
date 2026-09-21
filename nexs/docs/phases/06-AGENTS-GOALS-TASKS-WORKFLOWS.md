# Phase 6 — Agents, Goals, Tasks & Workflows (spec numbering)

**Status: ✅ done (756 tests at the time; `runs` shipped here too).** `v2.md` §6 adds a **Persona
tab (`soul.md`)** to this phase — a real backend change, not a UI one.

## What is built

| Piece | Detail |
|---|---|
| Agents | Fixed identity + immutable `AgentVersion` snapshots |
| Versioning rule | A version is minted **only when a behaviour-defining field changes**; a rename does not. `AgentConfigSnapshot` deliberately excludes `name`/`description` |
| Pinning | `Run.agentVersionId` — a real FK, not a JSON blob in `Run.checkpoint` (gap #15) |
| CAS everywhere | Claim / version-bump / pin are `updateMany({where:{...}})` + `count === 1`, so a concurrent loser gets a retryable conflict instead of a `P2002` 500 |
| Goals | Cannot complete without a verification of the required type; a full goal state machine (`GOAL_TRANSITIONS`) |
| Tasks | The scheduling half of a unit of work; `@@unique([tenantId, idempotencyKey])` (gap #9) makes a duplicate delivery return the existing task and **start no second run** |
| Workflows | Versioned, steps replace wholesale; `toPlanStepType` is the single place the broader workflow vocabulary maps onto the engine's narrower plan vocabulary |
| Runs | `Run` + `Step` + `ToolCall` + `ExecutionReceipt` + `Verification`; the run filter set is exactly **status, agent, goal, task, workflow, date** — `kind` is refused by `.strict()`, never silently dropped |

## What `v2.md` §6 adds — the Persona / `soul.md`

### The requirement

Three prioritised context files per agent:

| File | Contents |
|---|---|
| `SOUL.md` | Personality, tone, boundaries — *"an actual voice, not generic assistant sludge"* |
| `IDENTITY.md` | Name, role, avatar |
| `USER.md` | Who it serves |

Plus, from §6 and §9: a live-preview editor, a **token estimate per file**, a per-file **load
state** (`loaded` / `truncated` / `shadowed`) answering *"why is my file ignored?"*, and a
**"Test the voice"** probe that sends a prompt through `ModelGateway` and shows the reply.

### Where it lands in this phase's code

1. **`AgentConfigSnapshot` gains the persona documents.** Because a version is minted only on a
   behaviour-defining change, adding persona text *is* behaviour-defining and mints one — which is
   correct, and it is why `name`/`description` are excluded while persona text must not be.
2. **The snapshot stays complete and frozen.** No ids, no status, no timestamps — those belong to
   the agent, not to a version of its configuration. Persona text belongs to the version.
3. **`createAgentContextResolver` loads them in priority order.** This is the single resolver
   shared by the engine and chat; loading persona anywhere else would create a second answer to
   "what is this agent told to be", which is exactly gap #15's failure one layer up.
4. **Load state must be recorded, not recomputed for display.** `loaded` / `truncated` / `shadowed`
   is a fact about *this run's* context assembly. Deriving it in the UI from raw file lengths would
   guess, and the guess would be wrong exactly when it matters — when the context was near the
   limit.
5. **Editing mid-run does not change a pinned run.** This is the payoff of the FK pin, and the
   editor must say so rather than leaving it to be discovered.
6. **Human-readable limits** — the `executionLimits` shape (`maxSteps`, `maxDurationMs`,
   `maxToolCalls`, `maxContextTokens`, `stepTimeoutMs`, `maxRetries`) merges over
   `DEFAULT_RUN_LIMITS`, so an operator changing one budget does not restate the other five.

### Two smaller §6 items

- **An exec-approval toggle beside `approvalPolicy`** (`v2.md` §6: "Approval policy + exec-approval
  toggle live here"). Detail in `phases/04-TOOLS-MCP-BROWSER-SANDBOX.md` and
  `SURFACES-BUILD-PLAN.md` S6.
- **Capability toggles** (browser / sandbox / memory) are already per-agent; §6 only asks that the
  Persona tab sit beside them rather than in a separate settings page.

### The UI half is Phase 13

The **Persona tab** itself — markdown editor, live preview, token estimate, load-state badges,
Test the voice — is `phases/13-FRONTEND.md` Step 5. There is no backend for it today, so that step
is blocked on the work listed above.

## Acceptance test

Unchanged and passing: agent lifecycle + versioning; a goal cannot complete without a verification;
a task happy path; a workflow condition branch; **gap #15 proven by asserting on the gateway's
recorded requests**, not on `Run.agentVersionId`.

The v2 additions to write with the persona work:

1. Editing `SOUL.md` mints a new `AgentVersion`; renaming the agent does not.
2. A run started before an edit still executes the old persona — asserted on the gateway's requests.
3. A persona file that was truncated is reported `truncated`, and a lower-priority file that lost
   its budget is reported `shadowed` — neither is reported `loaded`.
4. "Test the voice" returns a reply produced by a real gateway call (asserted on a recorded
   request), not a canned string.
5. Two agents with different `SOUL.md` produce different instructions through the **same**
   resolver instance.

## Relevant traps

- `@nexs/shared` resolves from `dist/`. A changed `AgentConfigSnapshot` type is invisible to the
  server until `packages/shared` is rebuilt — the symptom is "has no exported member" for something
  plainly visible in `src`.
- `AgentConfigSnapshot` must not grow `name`. It is excluded on purpose: including it is how a
  snapshot quietly becomes a second copy of the mutable row and starts drifting from it.