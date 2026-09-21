# Phase 12 — Real-time (SSE) & Pulse (spec numbering)

**Status: ◑ partial — and the split matters.** The **real-time half is done and verified.** The
**dashboard half does not exist**: there is no dashboard page, and `v2.md` §12 renames what it
will become.

## What exists (the real-time half — done)

| Piece | Where | Notes |
|---|---|---|
| `SSE_EVENTS` catalog | `packages/shared/src/events.ts` | Every event name with a **typed payload**, plus `encodeSseFrame`. Nothing may cross SSE that is not declared here |
| `EventBus` | `services/sse/` | `InMemoryBus` (single process, dev) and `PgNotifyBus` (cross-process via Postgres `LISTEN`/`NOTIFY`) — this is **gap #1**, and it is what lets worker-emitted events reach API-connected clients |
| `/api/stream` | `routes/stream.ts` | Authenticated once at open, behind the shared `authRequired` |
| Reconnect contract | gap #2 | Heartbeats (`SSE_HEARTBEAT`) + `stream.closing` with a reason |
| `runWatcher` | `container.ts` | Tracks live watchers; last watcher leaving **aborts** the generation rather than billing for an unread answer |

Proven by `test/sse-hub.test.ts` and `test/stream.http.test.ts` (including "refuses an
unauthenticated connection").

## What does not exist (the dashboard half)

No `apps/web`, therefore no dashboard, no Pulse, no monitor of any kind. Every number that
`v2.md` §12 asks for exists as rows — it has simply never been rendered.

## What `v2.md` requires

### H1 / §12 — the dashboard is demoted, not deleted

`v2.md` keeps the page and changes its *job*. This is the single most important structural
change in the whole spec and it is a **routing** fact, not a visual one:

| | NEXS v1 | `v2.md` |
|---|---|---|
| Home route | `/dashboard` | **`/chat`** |
| Dashboard | home, a grid of cards | **`/pulse`** — a monitor you visit when something looks wrong |
| Rationale | control-plane first | operators live in chat; a static product opens on a moving conversation |

Consequence for this phase: the page moves to `/pulse`, keeps the v1 layout (active runs, recent
failures, provider health, usage **only if rows exist**), and gains three additions.

### §12's three additions

1. **Surfaces status panel** — which channels and devices are live, from `Channel.status` and
   `Device.status`. (The tables exist; the data does not yet.)
2. **Pending counts** — pairing and device requests, each linking to its queue.
3. **Cross-surface activity feed** — run / step / approval events over SSE, **each tagged with
   its surface glyph** (`Researcher · step 3 · via telegram`). This is what makes "one gateway,
   many surfaces" visible rather than asserted.

### §2.3 — the persistent Surfaces strip

A slim live indicator under the topbar and in the Chat header: connected surfaces as mono glyphs
with status dots (`web ● telegram ● discord ○(stale) ios ●`), plus active cross-surface sessions.
Data source: `Channel.status`, `Device.status`, live `Run` rows.

### The 12 events this phase's UI needs — already added

`channel.created|updated|status`, `pairing.requested|resolved`, `device.pending|paired|revoked`,
`binding.updated|deleted`, `plugin.updated`, `skill.installed`.

Each carries the id of the row that changed, so the client invalidates exactly one query rather
than refetching the surface list on every frame. That choice is the difference between a live UI
and a UI that flickers under load.

## Design constraints

- **`SSE` stays `SSE`.** No WebSocket. The locked decision, unchanged by `v2.md`.
- **Every new event is declared before it is emitted.** Adding an event to the catalog is a
  contract change; emitting an undeclared one would fail payload validation.
- **"Live first" means no manual refresh** (`v2.md` principle 1) — every execution-state page is
  driven by the stream, and the strip is the proof.
- **A reconnect must not lose a run.** The banner says reconnecting; the run keeps executing
  server-side, because the run is not owned by the connection except in chat (where it
  deliberately is — see Phase 8's "a chat run is never enqueued").
- **Never animate layout on an SSE update.** Reserve height, or the live page is unreadable
  (§14).

## Acceptance tests

1. Kill the SSE connection mid-run → the client reconnects with backoff and the run's final state
   is still correct (the **SSE kill test** in §21).
2. A worker-process-emitted event reaches an API-connected client — this is the `PgNotifyBus`
   proof, and it is the one that would have failed before gap #1 was closed.
3. Every declared event validates its payload; an undeclared name is rejected.
4. On Pulse, every number is reproducible with a SQL query against the DB.
5. A `waiting_approval` run appears in both the active-runs list and the pending-approvals count
   — one row, two renderings, no drift.
6. The Surfaces strip shows `disconnected` for a channel whose status row says so, and **never**
   shows a connected surface that has no `Channel` row.

## What is explicitly not in this phase

- Any new transport. If real-time needs change, the answer is a new event, not a new protocol.
- Charts. §12 asks for a monitor, and a monitor answers questions rather than decorating them.