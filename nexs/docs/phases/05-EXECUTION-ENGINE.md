# Phase 5 — Execution Engine (spec numbering)

**Status: ✅ done.** `v2.md` asks for **mid-run controls** that this engine cannot yet express —
they are the honest gap this phase carries forward.

## What is built

| Piece | Detail |
|---|---|
| The loop | **plan → act → observe → verify**, with a checkpoint after every step |
| `Planner` | Produces a plan whose step **identity is its `id`**, not its index — which is what makes `dependsOn` and approval keys stable across a retry |
| `Verifier` | Each verification type; a goal **cannot** complete without one |
| `ApprovalGate` | The engine parks a run, emits `approval.created`, and resumes from a decision. Phase 7 wired it to a real `ApprovalService`, so the Phase 5 placeholder `step:<id>` ids are gone |
| Execution receipts | Written for **every** completed step — the "receipt moment" §22 rests on |
| Limits | `maxSteps` / `maxToolCalls` / `maxDurationMs`, each terminating the run with a clear status rather than a hang |
| Crash recovery | `Run.checkpoint` (concrete JSON shape) + the `run.recover` queue job (gap #4) |
| Idempotency | Scoped per tenant (gap #9) |
| Concurrency | A per-tenant lock (`TENANT_CONCURRENCY=5`) via CAS, never a read-then-write |

Proven by `engine.execution.test.ts` (38), `engine.plan.test.ts`, `engine.planner.test.ts` (16),
`engine.verifier.test.ts`, `engine.agent-pinning.test.ts` (4), `runs.service.test.ts` (15).

## Two invariants that everything else depends on

1. **`Step.seq` is 0-based**, and `seq` and `position` are the same loop index today. The
   approval path reads `position` and not `seq` precisely because `position` is the field that
   *means* "where in the plan" — a future step type that retries under a new `seq` would break the
   `seq` reading while leaving `position` correct. That bug was hit once already; the symptom was a
   receipt with no `approvalId`.
2. **The agent pin is a real FK** (`Run.agentVersionId`), not a JSON blob in the checkpoint. A JSON
   snapshot has no referential integrity and no migration path. A run is *proven* to execute the
   configuration it pinned by asserting on the gateway's recorded requests — not by reading the
   column back.

## What `v2.md` §9 asks for here

`v2.md` H13 lists mid-run controls as a headline Hermes capability. Three of them need engine
support, and all three are currently registered as **present but honestly unavailable**:

| Command | What it needs | Why it is an engine problem, not a chat problem |
|---|---|---|
| `/steer <note>` | A note delivered **between tool calls**, without interrupting | The engine owns the step boundary. Injecting text into a live turn requires a named point in the loop where it is safe — delivering it mid-tool-call would interleave a human instruction with a half-finished action |
| `/btw <note>` | Same, with a softer delivery guarantee | It is `/steer` with a weaker promise, and it should share the delivery point rather than grow a second one |
| `/loop <n> <prompt>` | A bounded repeat **without writing a new plan** | A plan is the auditable record of *what the run intended*. Re-running a step N times by appending N plan entries inflates that record; the loop count belongs in the step's own config |
| `/snapshot` / `/diff` / `/rollback` | A labelled checkpoint, a comparison of two, and a return to one | Checkpoints exist but are internal and unlabelled. `/rollback` additionally needs the **action ledger** to say which side effects can be reversed — rolling back something that already reached the outside world is not always possible, and pretending otherwise is the dangerous version of this feature |

`/undo` is in the same family and needs the same ledger: **an inverse for every side effect**.

### The security consequence, stated plainly

`v2.md` §9's `/steer` is a *human instruction entering a running agent*. Phase 13's threat model
says external content must never cause execution without a visible, approved plan step — and
`/steer` is that same shape, with the human as the source. So the rule is consistent rather than
exempt: a steered note may inform the agent, and any resulting side effect still passes the
approval gate. `/steer` must not become a channel for bypassing approvals.

## Acceptance test

Unchanged and passing: a run executes plan → act → observe → verify; an unapproved side-effecting
step parks; after expiry the run **fails** rather than waiting forever; a completed step has a
receipt; each limit terminates its run with a clear failure status.

The v2 additions to write with the commands above:

1. A steered note arrives after the next tool call completes, and never between a tool call's
   start and its result.
2. `/loop 3` produces three executions of one step, and the persisted plan still has one entry for it.
3. `/rollback` refuses to claim it reversed a side effect the ledger cannot invert, and says which.
4. A `/steer` note cannot cause a side-effecting tool call without a visible approval.

## Carried-forward question (settle before building anything on top)

`docs/01-ARCHITECTURE.md` says "one active run per agent" while the spec's `TENANT_CONCURRENCY=5`
is **per tenant**. These are different rules and the contradiction is deliberately **not** baked
into the migration. One active run per agent is a much stronger guarantee — it is what would make
"the agent is busy" a real state — and choosing it would change the scheduling, the queue and the
UI's notion of "active". Decide it before `/queue` (which is a *backlog*, and therefore depends on
the answer) is built.