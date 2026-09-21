# Phase 11 — Events & Scheduling (spec numbering)

**Status: ⛔ partial.** The data model and the queue infrastructure exist. There is **no scheduler
loop**, no cron registration per schedule, and nothing reads a schedule's delivery target.

## What exists

| Piece | Where | State |
|---|---|---|
| `Event` | schema | `type`, `source`, `subject`, `externalId` (webhook replay dedupe), `payload`, `occurredAt` |
| `EventSubscription` | schema | Created by operators; note the FK defect recorded in `gaps.md` #5 was fixed |
| `Schedule` | schema | `kind` (`one_time \| recurring \| event`), `cron`, `timezone` (IANA), `runAt`, `targetKind` (`task \| workflow`), `targetId`, `enabled`, `lastFiredAt`, `nextFireAt` (UTC), **`deliveryTarget`** |
| pg-boss registry | `services/queue/` | `run.execute`, `approval.expire`, `run.recover` |
| Task creation | `services/tasks/task.service.ts` | **Refuses** `recurring` and `event` triggers with `FEATURE_DISABLED`, after validating that `scheduleId` / `eventSubscriptionId` were supplied |

So the honest summary: a `Schedule` row can be written, and nothing will ever fire from it.

## What this phase must build

1. **A scheduler loop.** A cron-driven sweep (or pg-boss cron jobs per schedule) that reads
   `Schedule` rows where `enabled` and `nextFireAt <= now`, starts the target's run, and writes
   `lastFiredAt` + the next `nextFireAt`.
2. **Per-schedule cron registration with timezone.** `timezone` is stored and `nextFireAt` is
   UTC, so the conversion happens once, at write time — not at fire time on every tick.
3. **Make `TaskService` accept the triggers it currently refuses.** Both refusal branches are
   deliberate placeholders with honest messages; they become real, and their tests change from
   "refuses with `FEATURE_DISABLED`" to "resolves the schedule and enqueues".
4. **Event ingestion.** A webhook route that dedupes on `Event.externalId` and fans out to
   matching `EventSubscription`s — gap #26 (authenticate the webhook) is a prerequisite, not an
   afterthought.
5. **Delivery** — `v2.md` §10, below.

## What `v2.md` requires

### §10 — delivery to a platform

Every schedule gains a **delivery target**: `Schedule.deliveryTarget` →
`{ channelType, accountId?, peerRef? }` (the column is added; nothing reads it). When the
schedule fires:

- The run's output is posted to that channel as a message, **with a link back into NEXS**.
- The owning chat shows a **delivery receipt** (§4.6) — a line like
  `↗ Delivered to Telegram · DM you · 09:00` linking into the run.
- The receipt is written as a `Notification` with `kind: 'schedule_result'` and a `linkRoute`,
  **not** as a new table. The vocabulary already carries exactly this meaning, and a second
  location would be a second place for "was it delivered?" to disagree.

Copy must distinguish the two kinds of recurrence, and this is a correctness requirement rather
than a wording preference:

| | Durable | Session-scoped |
|---|---|---|
| Commands | `/schedule` | `/heartbeat`, `/loop` |
| Backing | `Schedule` row + pg-boss; survives a restart | in-process timer; dies with the session |
| v2 | §10 | §9 (H13) |

A user told "this repeats hourly" must be able to find out which of these they got. `/heartbeat`
and `/loop` stay in `unavailable.commands.ts` until the session-scoped timer exists, and each
names that distinction in its reply.

### §12 — schedules feed the monitor

A fired schedule should appear on **Pulse** as activity, so "did the 09:00 job run?" is
answerable without opening Schedules.

## Design constraints

- **`nextFireAt` is stored UTC.** Compute it at write time from the IANA `timezone`, so DST is
  handled once and correctly rather than by an offset that silently drifts twice a year.
- **A missed window is not silently skipped.** If the worker was down across a fire time, the
  sweep must decide explicitly: fire late, or mark it missed. Either is defensible; doing
  neither (quietly advancing `nextFireAt`) would make a scheduler that looks healthy and skips
  work.
- **Firing is idempotent.** The same schedule firing twice must not start two runs — reuse the
  `Run.idempotencyKey` pattern already proven for tasks (`task:<id>`).
- **Delivery failure must not fail the run.** The run happened; losing it because a channel post
  failed would be the wrong trade. Log it, notify, and let the receipt say what happened.

## Acceptance tests

1. A recurring schedule with a timezone fires at the right UTC instant across a DST boundary.
2. Firing twice for one window produces exactly one run (idempotency key).
3. A worker that was down across a fire time does what the written policy says — proven, not
   assumed.
4. `eventSubscriptionId`-triggered tasks fire when a matching `Event` arrives, and a replayed
   webhook with the same `externalId` does **not** fire twice.
5. A schedule with a delivery target posts to that channel and writes one `schedule_result`
   notification whose `linkRoute` opens the run.
6. A delivery failure leaves the run `completed` and records the failure where the receipt can
   show it.
7. Unauthenticated webhook delivery is rejected (gap #26).

## What is explicitly not in this phase

- A visual cron builder — Phase 13 renders a text field plus a human-readable next-fire time.
- Session-scoped `/heartbeat` and `/loop` (they need engine support from Phase 5's territory).