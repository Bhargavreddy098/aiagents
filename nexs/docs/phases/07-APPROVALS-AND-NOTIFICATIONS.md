# Phase 7 — Approvals & Notifications · the Decision Inbox (spec numbering)

**Status: ✅ done.** `v2.md` makes this phase **the cross-surface feature of the whole product** —
"one decision, every surface". The states and the CAS are already the right foundation; what is
missing is the second kind, the surface attribution, and the channel leg.

## What is built

| Piece | Detail |
|---|---|
| State machine | `pending → approved \| rejected \| expired`, terminal states have **no** outgoing edges |
| Expiry as refusal | An expired approval tells the engine `rejected`, so the run **fails** rather than waiting forever for someone already given a deadline |
| CAS decisions | `decide()` and `expire()` are compare-and-swap (`updateMany` + `count === 1`), with `expiresAt: { gt: now }` / `{ lte: now }` guards — so "a decision beats the clock" holds **both** ways |
| Two identifiers | The engine keys decisions on the **plan-step id** (`send-report`); the `Approval` FK points at the **step row**. `planStepIdFor` translates by reading `Run.plan[step.position].id` |
| Resume through the engine | The approval row is updated *first* (that CAS decides who won), then `engine.resumeRun` — because flipping a status would make the inbox look right and leave the run parked |
| pg-boss | `approval.expire` as a delayed job, plus `expireDue()` as the durable backstop |
| Notifications | Fanned out to **every member of the tenant** — the honest scope while there are no roles — each with a `linkRoute` deep link |

Proven by `approvals.service.test.ts` (16) and `approvals.repo.test.ts`.

### Why "two identifiers" is the crux of this file

`Step.seq` is 0-based, and the first implementation read `seq - 1`, which for the first step walked
off the front of the plan array — and the fallback quietly returned the approval's own id.
Everything downstream still "worked", because a decision recorded under the wrong key simply parks
the step again. **The only visible symptom was a receipt with no `approvalId`.** The fix reads
`position` rather than `seq`, because `position` is the field that means "where in the plan". Any
future change here must keep an assertion on the receipt's `approvalId`.

## What `v2.md` requires

### §11 — `kind: tool | exec` (the column exists; the flow does not)

`kind` defaults to `'tool'` and is now in the schema. The flow is `SURFACES-BUILD-PLAN.md` S6.
The distinction is the *answers*, not the routing:

| | `kind: 'tool'` | `kind: 'exec'` |
|---|---|---|
| Subject | Step 3 of a plan | An owner-only shell command |
| Answers | Approve / Reject | **Allow once / Allow always / Deny** |
| `allow_always` | n/a | Writes a tool allowlist rule |
| Authority | Any tenant member | The owner (`operator.admin`) only |

### §4.3 — the `ApprovalCard` is one component, three surfaces

The signature interaction. It renders inline in web chat, in the inbox drawer, and as a **native
button message** on a bound channel (Telegram/Discord/Slack inline buttons) — all calling the same
`POST /api/approvals/:id/approve|reject`. **No web session required**, which is what makes H4
("talk to it from Telegram while it works elsewhere") real rather than aspirational.

Required content: RiskBadge (low = ok outline, medium = waiting, high = failed + dot), a
plain-language "what will happen", the requested action as collapsed JSON, permission chips, an
expiry countdown (**amber <1h, red <10min**), and Approve/Reject. Optimistic settle, then confirm
or **revert with a failed note** on SSE `approval.resolved`.

### §11 — a source chip per approval

Which surface it was requested from *and* delivered to (`web chat · Telegram · Discord…`). This is
what makes "one decision, every surface" auditable rather than a slogan. Implementation note: the
requesting surface is derivable from the `Run`/`ChatSession` that raised it; the delivered surfaces
are the channel messages that were actually sent — so **the chip must be built from rows, never
from a client-side guess**.

### §4.6 — delivery receipts

A fired schedule's delivery writes a `Notification` with `kind: 'schedule_result'` and a
`linkRoute`, and the owning chat shows `↗ Delivered to Telegram · DM you · 09:00`. **No new model**
— the notification vocabulary already carries exactly this meaning, and a second table would be a
second place for "was it delivered?" to disagree.

### §12 — the inbox feeds Pulse

Pending counts, and the same rows appearing as activity in the cross-surface feed.

## The non-negotiable properties to preserve

These are what the existing tests defend, and every `v2.md` addition must keep them:

1. **A decided approval is a record.** No transitions out of a terminal state — a record that can
   be edited is not a record. Re-running is a new run.
2. **A decision beats the clock, both directions.** An approval answered cannot later be marked
   expired, even if the expiry job was already queued. The `expiresAt` guards on *both* the decide
   and the expire paths are what make that true rather than merely likely.
3. **`decidedBy` is never accepted from the request body.** It is the authenticated user, read from
   the session. It is exactly the field an audit reads to answer "who let this happen?", so a
   caller must not be able to name someone else. `/approve` and `/reject` follow the same rule.
4. **A loser must not resume anything.** The CAS decides; the engine is called only by the winner.
5. **The three failure descriptions stay distinct** — someone else decided it, the clock ran out,
   or the row is gone. A single "conflict" would leave the operator unable to tell whether to
   re-read the inbox or chase a colleague.

## Acceptance test

Unchanged and passing: an unapproved side-effecting step parks the run; after expiry the run is
**failed** (not silently continued); clicking a notification lands on the exact run/step.

The v2 additions to write:

1. **One decision, every surface.** An approval raised in web chat is approvable from a bound
   channel and vice versa; both paths produce one `approval.resolved` and one settled row.
2. An `exec` approval offers allow-once / allow-always / deny, and a `tool` approval does **not**
   offer "allow always" — the schemas are separate precisely so this cannot happen.
3. A non-owner deciding an exec approval → `FORBIDDEN`, approval still `pending`.
4. The source chip names a surface a row can attest to; with no channel bound it shows only
   `web chat` rather than inventing a second surface.
5. A `schedule_result` notification's `linkRoute` opens the exact run that was delivered.
6. An approval whose decision loses the race reports **which** race, not a generic conflict.

## Not this phase

The `ApprovalCard` component, the in-channel button rendering and the source chip are Phase 13 plus
the Surfaces backend. This file records the contract they must satisfy.