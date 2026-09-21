# Phase 13 — Frontend (spec numbering)

**Status: ⛔ not started. `apps/web` does not exist.** No workspace, no Vite app, no React, no
routes, no pages, no `useSSE` hook. This is the largest gap in the project, and it is where the
majority of `v2.md` lives.

Nothing in this document is built. It is the build order for the phase, aligned to `v2.md`.

## Stack (locked, unchanged by `v2.md`)

Vite + React 18 + React Router 6 + TanStack Query 5 + Zustand 4 + Tailwind 4 + shadcn/ui, with
Vitest + Testing Library for units and Playwright for e2e. `v2.md`'s header confirms every one of
these and adds no new dependency.

## Step 0 — reconcile the design system *before* writing a component

This is first because it is the cheapest thing to get right and the most expensive to get wrong.

`docs/UI-UX-DESIGN.md` contains **two contradictory specifications**:

| | Experience Guide (§0–§14) | the second draft (§1–§10) |
|---|---|---|
| Accent | `#7C5CFC` family, 4 shades | `#8B5CF6` |
| Background | `#0B0C10` with surface steps | `#0B0B10` |
| Status chips | 12% background + 300-level text | flat |
| Verdict | **canonical** | **retired** |

`v2.md` §3 settles it: the **Experience-Guide set wins**, and it says so explicitly ("v2
consolidates your two conflicting token drafts into one source of truth. The second draft's
`#8B5CF6` / `#0B0B10` values are retired."). So:

1. Define the tokens **once**, in the Tailwind 4 `@theme` block.
2. Delete the conflicting set from the source doc, or mark it retired in place — do not leave two
   plausible palettes where an implementer can find both.
3. Ship a `/styleguide` route rendering every token and component state. Every later step
   references it instead of a hex value.

### Tokens to implement (`v2.md` §3)

```
surfaces  --bg #0B0C10 · --surface-1 #101218 · --surface-2 #151820 · --surface-3 #1B1F29
borders   --border #262B36 · --border-subtle #1D222C
text      --text-primary #EDEFF4 · --text-secondary #A6ADB9 · --text-muted #78808F
accent    300 #A78BFF · 400 #8F72FF · 500 #7C5CFC · 600 #6641EC  (white on 600 = AA)
status    --success #34D399 · --waiting #FBBF24 · --failed #F87171 · --running #60A5FA
```

Each status is **12% background + 300-level text** — the chip pattern, not a full-bleed fill.
Fonts: Inter (variable) 400/500/600 for UI, **JetBrains Mono for every machine string** — ids,
JSON, args, results, URLs, timestamps, model names, durations, countdowns, setup codes. Radii 8 /
12 / 999. Elevation is surface steps plus borders; a real shadow only on overlays.

**The four status colours are the *only* semantic colours.** Surface status reuses them:
connected = ok, live = running, stale/reconnecting = waiting, disconnected/error = failed. Channel
brand glyphs render **monochrome** (Lucide-style outline, 16/18px) so the one-accent rule
survives; a brand colour is permitted only inside the glyph at ≤40% as a hover tint, with
`aria-label` + tooltip always.

## Step 1 — shell, routes and the home flip

`v2.md` §2.1 and §2.2. The load-bearing changes from v1:

- **`/chat` is the home route**, and `/` redirects to it. `/dashboard` becomes **`/pulse`**.
- Sidebar groups: **Converse** (Chat) · **Surfaces** (Channels, Skills, Plugins, Commands) ·
  **Build** (Agents, Goals, Tasks, Workflows, Runs, Decisions, Schedules) · **System** (Models,
  Tools, MCP, Connectors, Browser, Sandbox, Memory, Research, Pulse, Settings).
- Pending **Decisions** render an amber pill on their row; pending **pairing/device** requests
  render a waiting pill on the Channels row. Both counts come from the API, never computed
  client-side.
- The **Surfaces strip** (Step 4) sits under the topbar.

Route table (§2.2) — note which routes have no backend yet and must render an honest empty state
rather than a mock:

| Route | Backend today |
|---|---|
| `/login` `/signup` | ✅ exists |
| `/chat` | ✅ exists (`/api/chat`, `/api/chat/messages`, `/api/chat/mentions`) |
| `/agents` `/agents/:id` | ✅ exists (missing: Persona tab, §6) |
| `/goals` `/tasks` `/workflows` `/runs` `/runs/:id` | ✅ exists |
| `/approvals` | ✅ exists (missing: `kind`, source chip — §11) |
| `/models` `/tools` `/mcp` | ✅ exists |
| `/channels` `/pairing` `/devices` `/bindings` `/plugins` `/commands` `/skills` | ⛔ **no API** — Surfaces domain (see `SURFACES-BUILD-PLAN.md`) |
| `/schedules` | ◑ rows exist; no scheduler, no delivery target |
| `/connectors` `/browser` `/sandbox` `/memory` `/research` | ◑ browser/sandbox services exist; no routes yet |
| `/pulse` `/settings` |  no API |

**A page whose API does not exist must not be built against fixtures.** It ships with an empty
state naming what is missing, or it does not ship. That is `v2.md` principle 2 ("honest
rendering: real data or nothing") and it is also the only way the UI cannot quietly become a
mock of the product.
**A page whose API does not exist must not be built against fixtures.** It ships with an empty
state naming what is missing, or it does not ship. That is `v2.md` principle 2 ("honest
rendering: real data or nothing") and it is also the only way the UI cannot quietly become a
mock of the product.

## Step 2 — the live system

- `useSSE` hook: reconnect with exponential backoff (1 s → 30 s cap), dispatching into the
  TanStack Query cache per the invalidation map.
- **Kill test as the acceptance bar**: kill the stream mid-run; the client must recover and the
  final state must be correct.
- Height reservation on streaming updates. Never animate layout (§14).

## Step 3 — Chat, the flagship (§4)

Built before the other pages because it is now the home. Layout per v1 (full-height, message
column max 760 centred, composer pinned); `v2.md` changes four things:

1. **Surface context chip** (§4.1) — where this conversation is live (`● web · telegram`) plus a
   Handoff action. A session started elsewhere reads "Started on Telegram · DM you", from
   `ChatSession.surface` / `channelType` / `peerRef` (columns exist).
2. **Composer mid-run controls** (§4.2) — while a run is live, ghost chips for `/steer`, `/queue`
   and `/stop`; Send becomes a square Stop while streaming. These commands are registered and
   **honestly answer "not available"** until Phase 5/8 support lands, so the chips must not
   promise more than the reply delivers.
3. **`ApprovalCard` inline** (§4.3) — the signature interaction. See Step 6.
4. **Delivery receipts** (§4.6) — `↗ Delivered to Telegram · DM you · 09:00`, linking into the run.
   Absence of rows means no fake activity.

## Step 4 — Surfaces strip and the Surfaces pages (§5)

Blocked on the Surfaces API (`SURFACES-BUILD-PLAN.md` S3–S5). The strip renders
`Channel.status` / `Device.status`; the pages are Channels, Pairing, Devices, Bindings, Commands,
Plugins, Skills Hub.

The **Commands page** is the registry from Phase 8 rendered read-only: name, one-line
description, mono args hint, **surface-availability glyphs**, and an **owner-only badge**. It is
generated from `GET` on the same registry the composer and CLI use — that is what "one registry,
every interface" means, and hand-maintaining a table here would break it.

## Step 5 — Agents Persona tab (§6)

`soul.md` editor: markdown editor + live preview, token estimate, per-file load state
(`loaded` / `truncated` / `shadowed`, answering "why is my file ignored?"), and **Test the voice**
which sends a probe through `ModelGateway` and shows the reply in the agent's voice. `soul.md` is
part of the immutable `AgentVersion` snapshot, so the editor must say that editing mid-run does
not change a pinned run. **No backend for this yet.**

## Step 6 — the component specs (§13)

Each ships the **full state matrix**: default / hover / focus / active / disabled / loading / error.

| Component | The part that is easy to get wrong |
|---|---|
| `ApprovalCard` | Three variants (in-chat, drawer, channel-native) from **one** component. RiskBadge, plain-language "what will happen", collapsible `JSONViewer` of `requestedAction`, permission chips, an expiry countdown (amber <1h, red <10min), Approve/Reject — and for `kind: 'exec'`, Allow once / Allow always / Deny. Optimistic settle, then confirm or **revert with a failed note** on SSE |
| `PairingRequestRow` | mono 8-char code, 1h countdown, cap indicator, Approve (notify + make-first-owner) / Dismiss |
| `DevicePairCard` | Full/Limited access, setup code modal with QR **and selectable text** (10-min expiry) |
| `ChannelCard` | mono glyph, status dot, DM/group policy segmented control, allowlist editor with access-group picker, admin/user command split, delivery defaults |
| `BindingRow` | channel/account/peer → agent, editable, **Test routing** probe |
| `SoulEditor` | markdown + preview + token estimate + load state + voice test |
| `SlashMenu` | grouped by the §9 sections, surface glyphs, owner badge, fuzzy, ↑↓↵, and the name-collision marker ("slash command unavailable — name taken by built-in") |
| `SurfaceStatusStrip` | mono glyphs + status dots, no invented surfaces, `aria-label` on every glyph |

## Step 7 — keyboard and accessibility (§15, §17)

`⌘K` palette, `g`-keys (`g h` Channels, `g p` Pairing/Devices, `g s` Skills, `g m` Memory, plus
the v1 set), `Esc`. Shortcuts inactive while an input is focused.

WCAG 2.1 AA, non-negotiable: in-channel approval cards focusable and keyboard-operable; QR/setup
codes have a selectable text alternative; every glyph has `aria-label` + tooltip; countdowns
announce on expiry via `aria-live="polite"`; status is **never** colour alone; focus returns to
the trigger after every modal; targets ≥24px desktop / ≥44px touch; `prefers-reduced-motion`
collapses pulse → static, shimmer → static block, slide → fade.

## Acceptance tests (`v2.md` §21, frontend half)

1. Keyboard-only journey: sign in → create an agent → start a run → approve → view the receipt,
   without a mouse.
2. The SSE kill test (Step 2), plus the reconnect banner appearing and clearing.
3. Five states on **every** page: empty / loading / live / error / success.
4. No lorem, no fixture data, no placeholder numbers anywhere.
5. `prefers-reduced-motion` honoured.
6. 390px width usable for Chat, Decisions and Pulse.
7. A page whose API is missing shows an empty state naming what is missing.
8. The `/styleguide` route renders every token and every component state.
9. Cross-surface journey (§21): pair a Telegram DM → chat from Telegram while a run executes → an
   approval posted in-chat *and* as a Telegram button message → approve from Telegram → the same
   row settles in the web Decision Inbox.

## What is explicitly not in this phase

- New UI libraries. shadcn/ui + Tailwind 4 are the locked choice; `v2.md` adds none.
- A dashboard home. The chat is the home, and this phase is what makes that true.