# NEXS — UI/UX Design & Experience Guide

> **Companion to `BUILD.md` · applies to `@nexs/web`** (Vite + React + Tailwind + shadcn/ui + TanStack Query + Zustand)
> Read this before starting Phase 13. Every decision here is additive to the locked stack — no new libraries, no design drift.
> Save as: `docs/UI-UX-DESIGN.md`

---

## 0. Why this product should feel different (positioning)

NEXS competes for attention against generic admin dashboards and "AI magic" products. It wins on **trust**. The UI's single job is to make the control plane feel **alive, honest, fast, calm, and in your hands**:

| Pillar | What it means in pixels |
|---|---|
| **Alive** | Nothing is static. SSE updates rows in place, run timers count up, browser screenshots refresh, streaming text has a caret. The product visibly works while you watch. |
| **Honest** | No lorem cards, no fake progress bars, no animated confetti over real data. Every number on screen traces to a DB row. If data doesn't exist, the panel is hidden — not faked. |
| **Fast** | Instant routing (no page transitions), keyboard-first power path (`⌘K` from anywhere), optimistic updates for every user action. |
| **Calm** | Dark, near-black surfaces; one accent color; status colors only where they mean something. Density with breathing room — dense rows, generous whitespace between sections. |
| **In your hands** | Approvals are first-class citizens (Decision Inbox), destructive actions always confirm, every action is reversible or undoable. |

**The 10 "attract" moments** that make users want to open this product daily:

1. The running dot actually pulses — and stops the second the run finishes.
2. Streaming answers with a live caret, tool calls collapsing inline as they happen.
3. `⌘K` command palette with fuzzy search, recents, and real actions (not just navigation).
4. First-run checklist on the Dashboard with a progress ring — setup in 5 visible steps.
5. Approval countdowns that turn amber under 1 hour, red under 10 minutes — urgency without pressure.
6. The "receipt moment": goal completion shows a verification summary card with a subtle green check and a **View receipt** action. Proof, not celebration.
7. Browser tab showing a live screenshot crossfading as the agent navigates — you're watching it think.
8. Failed steps auto-expand in the timeline with the exact error visible — no hunting.
9. Optimistic Approve/Reject in the Decision Inbox: click → UI updates instantly → SSE confirms.
10. A full product walkthrough possible with keyboard only.

---

## 1. Design principles (the 7 rules)

1. **Live first.** Every page that shows execution state is SSE-driven. No page may require a manual refresh to reflect truth.
2. **Honest rendering.** Real data or nothing. Empty states teach; they never fake. Progress bars only when a real total exists.
3. **Density with breathing room.** Rows are compact (40px); sections are separated by 24–32px of air. Never both cramped and airy in the same viewport.
4. **Keyboard-first power path.** `⌘K`, `g d` / `g c` / `g a`, `Esc` — the product is fully usable without a mouse.
5. **Status = color + label + icon, never color alone.** Color-blind users must read every state.
6. **One accent, four status colors — nothing else.** If a new hue appears in a mockup, it's wrong.
7. **Every state is designed:** empty / loading / live / error / success. A page without all five is not done.

---

## 2. Visual identity

### 2.1 Theme

**Dark-first.** Design and build for dark; light mode is a later port of these tokens, never the source of truth. No gradients-as-decoration, no glassmorphism, no aurora blobs. Elevation comes from surface steps + borders, not drop shadows.

### 2.2 Color tokens (exact values — paste into Tailwind config / CSS variables)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0B0C10` | App background (near-black, blue-tinted) |
| `--surface-1` | `#101218` | Cards, panels, inputs |
| `--surface-2` | `#151820` | Hover states, nested surfaces, secondary buttons |
| `--surface-3` | `#1B1F29` | Active rows, selected items, focus fills |
| `--border` | `#262B36` | Default borders |
| `--border-subtle` | `#1D222C` | Dividers, table row separators |
| `--text-primary` | `#EDEFF4` | Body text (≈15.8:1 on bg) |
| `--text-secondary` | `#A6ADB9` | Secondary text (≈7.4:1) |
| `--text-muted` | `#78808F` | Meta, timestamps (≈4.5:1 — body size only, never small dense text) |
| `--accent-300` | `#A78BFF` | Accent text/icons on dark (≈8:1) |
| `--accent-400` | `#8F72FF` | Hover states, focus rings |
| `--accent-500` | `#7C5CFC` | Interactive elements, links, active indicators |
| `--accent-600` | `#6641EC` | Primary button bg (white text on it = AA) |
| `--success` | `#34D399` | ok / success · chip: bg `rgba(52,211,153,.12)`, text `#6EE7B7` |
| `--waiting` | `#FBBF24` | waiting / pending · chip: bg `rgba(251,191,36,.12)`, text `#FCD34D` |
| `--failed` | `#F87171` | failed / error · chip: bg `rgba(248,113,113,.12)`, text `#FCA5A5` |
| `--running` | `#60A5FA` | running / in-progress · chip: bg `rgba(96,165,250,.12)`, text `#93C5FD` |

**Pairing rules:**
- White text only on `accent-600` and `--failed` solid fills.
- Accent glow (`rgba(124,92,252,.35)`) is reserved for focus rings and live indicators — nothing else glows.
- Status chips always use the 12% bg + 300-level text pattern above. Never solid status backgrounds.

### 2.3 Typography

| Token | Size / weight | Use |
|---|---|---|
| `caption` | 11px / 500, uppercase, +0.04em tracking | Field labels, meta, table headers |
| `sm` | 13px / 400–500 | Dense tables, chips, breadcrumbs |
| `base` | 14px / 400–500 | UI default (body) |
| `md` | 16px / 400–500 | Form fields, messages |
| `lg` | 18px / 500–600 | Section headers |
| `title` | 24px / 600 | Page titles |
| `display` | 30px / 600 | Empty-state headlines, auth page |

- **Sans:** `Inter` (variable) — 400/500/600 only.
- **Mono:** `JetBrains Mono` — terminal output, JSON, IDs, durations, countdowns, code.
- Line heights: tight (1.25–1.35) for UI; 1.5 for message/prose text only.
- Never center-align body text. Left-align everything except empty states and auth.

### 2.4 Spacing, radii, elevation

- **Spacing scale (4px base):** 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64. Nothing in between.
- **Radii:** controls `8px` · cards `12px` · chips/pills `999px`. No other radii.
- **Elevation (dark UI):** surface step (`surface-1 → surface-2 → surface-3`) is the primary elevation signal. Real shadows only for overlays: modals/drawers use `0 8px 32px rgba(0,0,0,.6)`.

### 2.5 Iconography & brand

- **Lucide outline icons, rendered at 16px**, consistent stroke weight. Outline only — no filled icons except status dots and checkmarks.
- Wordmark: `NEXS` in Inter 600, tracking -0.02em, text-primary. No mascot, no logomark animation.

---

## 3. Layout system

### 3.1 Shell geometry

| Element | Measurement |
|---|---|
| Sidebar | 240px expanded · collapses to 56px icon rail |
| Topbar | 52px height, `border-subtle` bottom border, sticky |
| Content padding | 24px (1024–1439) · 32px (≥1440) |
| List pages | Full width, inner max 1440px |
| Forms / wizards | Max 720px, centered |
| Chat column | Messages max 760px, centered |
| Run workspace | Two-pane at ≥1280: timeline left (min 480), detail right (flex) |

### 3.2 Breakpoints

| Range | Behavior |
|---|---|
| ≥1440 | Ideal. All columns visible. |
| 1024–1439 | Padding reduced; tables drop lowest-priority columns (progressive disclosure via CSS, not different data). |
| 768–1023 | Sidebar auto-collapses to icon rail with tooltips; nav opens as slide-over on demand. |
| <768 | **Monitoring mode** (designed, not an afterthought): Chat, Dashboard summary, and Decision Inbox are fully usable at 390px. Other pages: readable lists, actions move into a bottom action bar. |

---

## 4. Component specifications

Every component ships with this state matrix — no exceptions:

| State | Visual rule |
|---|---|
| default | Per spec below |
| hover | `surface-2` bg (or border → `--border` + text-primary) |
| focus-visible | 2px ring `--accent-400`, offset 2px. Never remove outline without replacing it. |
| active | bg one step darker or scale `.98` (buttons only) |
| disabled | opacity `.5`, cursor `default`, no hover, still labeled |
| loading | Spinner replaces icon **inside a fixed width** — layout never shifts |
| error | border `--failed/60` + 13px message below in `#FCA5A5`, linked via `aria-describedby` |

### 4.1 Buttons

- **Variants:** `primary` (accent-600 bg, white text) · `secondary` (surface-2 bg, border, text-primary) · `ghost` (transparent, hover surface-2) · `danger` (solid `#E5484D`, white text — confirm modals only) · `outline-danger` (transparent, border failed/40, text failed-300).
- **Sizes:** sm h-8 · md h-9 · lg h-10. Radius 8px. One primary button per view; everything else secondary/ghost.
- Loading: label persists, spinner replaces leading icon, width locked to the longest label in the group.

### 4.2 Inputs, selects, toggles

- Input/select height 36px, `surface-1` bg, border default → accent-500 on focus (with the ring).
- Labels: 11px caption above the field, never placeholder-as-label.
- Toggle/switch: 36×20 track, accent-500 when on, surface-3 when off. Keyboard operable, labeled by adjacent text.
- Textareas auto-size (max 8 rows) in Chat composer; fixed height elsewhere with resize handle.

### 4.3 Tables (the workhorse of this product)

- Row height 40px; sticky header; no zebra striping — hover `surface-2`, selected row `surface-3`.
- Sortable headers show a muted arrow → accent when active. Filter/search row above the table, never inside it.
- Bulk actions: selecting rows reveals an action bar (count + actions + Clear).
- Every table has a caption (visually hidden if redundant) and `scope="col"` headers.

### 4.4 Status system (the heart of the product)

| Status | Dot | Label | Motion | Extra affordance |
|---|---|---|---|---|
| ok / success | green dot or ✓ icon | "Completed" | static | — |
| running | blue dot | "Running · 2m 14s" (mono duration, live) | **pulse** (see §11) | Pause/Cancel in row menu |
| waiting / pending approval | amber dot | "Waiting for approval" | static | Link to Decision Inbox |
| failed | red dot | "Failed" | static | Retry icon-button + error visible on expand |

- Dot = 8px circle. **The label is always rendered next to it.** Color is never the only signal.
- Elapsed timers are real (from `startedAt`), ticking every second, mono type.

### 4.5 Chips & badges

- Pill radius, status-chip color pattern from §2.2, 13px text.
- Capability chips (models/tools): neutral `surface-2` bg, text-secondary, e.g. `json_schema`, `read_only`, `side_effect`.
- RiskBadge (Decision Inbox): `low` = success outline · `medium` = waiting outline · `high` = failed outline + dot.

### 4.6 Overlays

| Component | Spec |
|---|---|
| **Modal** | Centered, max 520px (forms: 640). Slide-up 8px + fade, 180ms. Esc closes; focus trapped; focus returns to trigger on close. Destructive confirms: no close-on-overlay-click. |
| **Drawer** | Right-anchored, 480–640px, slide 240ms slow easing, overlay `rgba(0,0,0,.6)`. Used for Decision Inbox detail and row details. Same focus rules as modal. |
| **Toast** | Bottom-right stack, max 3 visible, width 360. Icon + title + optional description + one action button. Auto-dismiss: success/info 5s; error persists until dismissed or acted on. Slide-up 16px + fade, 180ms. `role="status"` (success/info) / `role="alert"` (error). |
| **Command palette** | `⌘K`. Centered at 20% from top, width 640. Sections: *Go to · Agents · Runs · Actions*. Fuzzy match, arrow-key nav, Enter executes, Esc closes. Empty query shows recent items. Right side shows kbd hints (`g d`, `⌘K`). |
| **Skeleton** | `surface-2` blocks shaped exactly like the final layout (zero layout shift) + shimmer sweep 1.8s. Never a full-page spinner; spinners only for actions <1s. |

### 4.7 Empty & error states

- **EmptyState:** centered, max 480px. Glyph icon in a 48px `surface-2` circle → headline (`lg`) → one sentence of what to do next (`text-secondary`) → primary CTA + optional secondary. No illustrated scenes, no stock art.
- **ErrorState:** same shape, red-tinted glyph, message from `error.message`, `error.code` in mono caption, Retry (secondary) + one context action. Global 5xx: slim banner under topbar with "Retry" and "View details" (expands to the error envelope).

### 4.8 Domain components (build once, reuse everywhere)

| Component | Spec |
|---|---|
| **Timeline** (Run workspace) | Vertical step list. Row: status icon · title · duration (mono). Collapsible args/result JSON — collapsed by default, **auto-expanded when failed**. Current step: running dot + live elapsed timer. |
| **ProgressBar** | Only when a real total exists (`tasks completed/total`, `steps done/total`). Track `surface-3`, fill accent-500 (or success on 100%). No indeterminate bars — use the running dot instead. |
| **Countdown** (approvals) | Mono text, human-relative above 60min ("Expires in 4h 12m"), clock format below ("09:41:22"). Turns amber < 1h, red < 10min. On expiry: status → `expired` with reason line. |
| **JSONViewer** | Pretty-printed, syntax-tinted (keys accent-300, strings success-300, numbers waiting-300), max-height scroll, "Copy" button → toast "Copied". Truncates at 40 lines with "Show more". |
| **KVList** | Key–value grid for Overview panels: caption keys left, values right (values may be chips/links). Two columns ≥1280, one below. |
| **ScreenshotFrame** (Browser) | 16:9, `surface-1` bg, URL + title bar above (real data), image crossfades 200ms on each SSE update. Placeholder: muted globe glyph + "Waiting for first navigation". |

---

## 5. Live system (SSE-driven UX)

1. **Optimistic updates** for every user action (approve, reject, pause, resume, cancel, create). UI changes instantly; SSE confirms or rolls back with a toast on mismatch.
2. **In-place row updates.** SSE events patch the specific row/card — never a list reload that scrolls the user away from where they were.
3. **Reconnect banner.** If the SSE stream drops: slim amber banner under topbar — "Reconnecting… last updated 12:04:31" — auto-dismisses on resume. Data behind it is dimmed to 60% opacity while stale.
4. **Auto-scroll discipline (Chat).** Auto-scroll only while the user is within one viewport of the bottom; otherwise show a "↓ Jump to latest" pill. Never fight the scroll.
5. **Live header indicator.** Any page showing an active run shows a small "● Live" chip (running blue, pulsing) in the header while SSE events for that run are flowing.

---

## 6. Page experience specs

> Rule for every page: implement all five states — **empty / loading / live / error / success** — and render real data only.

### 6.1 Dashboard

```
┌──────────────────────────────────────────────────────────────┐
│ Overview                          ● Live          [bell] [user]│
│                                                                │
│ ┌─────────────────────────────────┐ ┌───────────────────────┐ │
│ │ Active runs (top 5)             │ │ Setup checklist       │ │
│ │ ● Researcher — "Summarize Q3"   │ │ ✓ Add provider        │ │
│ │   running · 2m 14s  [→ run]     │ │ → Create an agent     │ │
│ │ ● Operator — "Deploy staging"   │ │ ○ Define a goal       │ │
│ │   waiting approval [→ inbox]    │ │ ○ Run a task          │ │
│ │ ✕ Browser Scout — failed        │ │ ○ Approve & verify    │ │
│ └─────────────────────────────────┘ ├───────────────────────┤ │
│ ┌─────────────────────────────────┐ │ Pending approvals: 2  │ │
│ │ Recent failures (top 3)         │ │ Provider health       │ │
│ └─────────────────────────────────┘ │ ✓ OpenAI · 12 models  │ │
│                                      │ ● Ollama · connecting │ │
└──────────────────────────────────────┴───────────────────────┘
```

- Left 2/3: **Active runs** list (status dot, agent name, goal link, live elapsed, progress if real total) + **Recent failures** (top 3, each with a "View" link into the run).
- Right 1/3: **Setup checklist** card (only while setup is incomplete — see §8), **Pending approvals** count linking to Decision Inbox, **Provider health** cards.
- **Usage panel appears only if `ModelUsage` rows exist** — hidden entirely otherwise (honesty rule).
- Fresh tenant empty state: one "Start here" card with three real actions: *Add provider* / *Create agent* / *View guide*. No lorem cards, ever.

### 6.2 Chat (flagship page)

```
┌──────────────────────────────────────────────────────────────┐
│ NEXS Chat                                                    │
│                                                                │
│   You: @researcher summarize the Q3 report                    │
│                                                                │
│   N  Summarizing…                                             │
│   ┌─ tool · read_file · 0.4s ─────────────── [▾] ┐            │
│   │ args/result JSON (collapsed)                  │            │
│   └──────────────────────────────────────────────┘            │
│   The Q3 report shows… ▌                                      │
│                                                                │
│ ┌──────────────────────────────────────────────────────────┐  │
│ │ [textarea — auto-sizing]              [📎]   [Send →]     │  │
│ └──────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

- Full-height page; message column max 760px centered.
- **Composer:** auto-sizing textarea (max 8 rows); `Enter` sends, `Shift+Enter` newline; Send button enabled only with content or attachments.
- **Slash menu:** opens on `/`, fuzzy over the real command list, grouped: *System · Create · Control*. Each item shows a one-line description.
- **`@` mention popup:** real registry autocomplete (agents, models, tools, goals, runs, files…) with kind icons and labels from `GET /api/chat/mentions`.
- **Attachments:** folder/file picker with permission badges (`read`, `write`, `grant`).
- **Tool calls inline:** collapsible card — tool icon + name (mono) + duration chip; expanded shows args/result via JSONViewer. Collapsed by default, auto-expanded on error.
- **Streaming:** SSE deltas append live with a blinking caret at the end. No per-delta scroll if the user scrolled up (§5.4).
- **Empty state:** "Ask, or type `/help`" + 3 example chips that fill the composer with real, runnable examples (referencing agents that actually exist; if none exist, the CTA is *Create your first agent*).

### 6.3 Agents

- **List:** table rows — name · model chip · status chip · last-run relative time · row menu (Run / Pause / Resume / Edit / Duplicate / Disable / Delete). Status chips follow the lifecycle (`active`, `paused`, `disabled`, `draft`).
- **Create wizard (4 steps, left rail progress):** Identity → Instructions & Model → Capabilities → Review. Each step gates Next on validation; model picker is grouped by provider with real capability chips; approval policy selector uses plain-language descriptions: *"Auto — read-only tools run freely; side effects ask you."* Review step = summary card + **Create agent**.
- **Detail:** header (identity + status + action buttons) + tabs exactly per build doc: Overview / Config / Goals / Tasks / Runs / Versions / Schedules / Approvals.

### 6.4 Goals

- Active / History tabs. List rows: title · progress (`3/5 tasks`, real total only) · verification state summary · status chip.
- **Detail:** success criteria list — each criterion row shows its verification state (pending = muted check outline, passed = green ✓, failed = red ✕ with reason); linked runs list; evidence panel (receipts + verifications).
- **Completion moment:** when the Verifier passes all criteria, the detail header swaps to a success summary card: green check icon (subtle 400ms fade-in, no confetti), "Goal verified" + **View receipt** primary. This is the product's signature delight beat.

### 6.5 Tasks

- Active / Scheduled / Completed tabs. Detail: status timeline (reuse Timeline component), input/output via JSONViewer, error block with retry count, linked run link.

### 6.6 Workflows

- List with version badges + active indicator. **Step editor is a vertical numbered list — readable, not a fake canvas:** each step card has type icon, inline config form, position handle, `dependsOn` select. Activate/deactivate in header. Run history tab.

### 6.7 Runs — the Agent Workspace (flagship detail page)

```
┌──────────────────────────────────────────────────────────────┐
│ Run · Summarize Q3 report        ● Live   [Pause] [Cancel]   │
│ agent: Researcher · goal: Q3 summary · started 12:04:31      │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ Overview Timeline Tools Browser Terminal Files Artifacts │ │
│ │ Approvals Verification                                    │ │
│ ├──────────────────────────────────────────────────────────┤ │
│ │ 1 ✓ load report            0.8s                          │ │
│ │ 2 ✓ extract sections       1.2s          [▾] args/result │ │
│ │ 3 ● summarize (step 4/9)   2m 14s  ← live, pulsing       │ │
│ │ 4 ○ draft summary                                      │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

- Header: status chip + live duration + entity links (agent/goal/task/workflow) + context-aware actions. "● Live" chip while SSE is flowing (§5.5).
- Tabs exactly per build doc §31: Overview / Timeline / Tools / Browser / Terminal / Files / Artifacts / Approvals / Verification — all live via SSE.
- **Browser tab:** ScreenshotFrame (live crossfade) + action log below.
- **Terminal tab:** mono blocks, exit-code chip (green `0`, red non-zero), stdout/stderr toggle.
- **Overview:** KVList summary + plan steps with per-step status + usage stats only if present.

### 6.8 Decision Inbox

```
┌──────────────────────────────────────────────────────────────┐
│ Pending (2)   Decided (14)                                    │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ [high] Operator — send email to x@y.com                  │ │
│ │        reason: "Approved in goal criteria"  · expires 09:41│
│ │        [Approve] [Reject]                               │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

- Row: RiskBadge · agent name · human-readable summary line · reason (muted) · expiry Countdown · **Approve / Reject inline** — optimistic update, SSE confirm (§5.1).
- **Detail drawer:** "what will happen" in plain language, requested action JSON via JSONViewer, permissions required (chips), agent's reason, expiry countdown ring, Approve (primary) / Reject (secondary). After decision: toast + row moves to *Decided* with timestamp.
- Empty state: green check glyph — "Nothing waiting on you."

### 6.9 Models / Tools / MCP / Connectors

- **Models:** Providers tab = cards (name, type, status dot, model count, last sync, health) with actions **Test Connection** (inline spinner → "Connected — 12 models found"), **Sync Models**, Edit. Models tab = table (name, provider, external ID, capability chips, context window, enabled toggle). Provider create: type picker → dynamic fields → key entry **shown once, then masked** with a one-time notice: *"Key shown once — you can't see it again."*
- **Tools:** registry table (type filter + search); detail = schema viewer (JSONViewer), capability chips, **test-invocation panel** (form generated from the schema → Run → real result with duration).
- **MCP:** servers list (status dot, tool count, last connected); add form (stdio: command+args+env · http: url+headers); detail = tools/resources/prompts tables, enable/disable toggles, Reconnect, Delete.
- **Connectors:** connected services; add flow type → credentials → account selection → **capability discovery results shown as chips**; detail = accounts, capabilities, event subscriptions, Test action.

### 6.10 Browser / Sandbox / Memory / Research / Settings / Auth

- **Browser:** active sessions grid (live URL/title/screenshot via ScreenshotFrame), session history table, action log.
- **Sandbox:** session list + execution log (command, exit-code chip, stdout/stderr) + provider indicator text: *"In-process worker — development isolation"* (honesty rule in copy).
- **Memory:** scoped browser (scope filter + agent filter), semantic search box, CRUD cards with content preview + created/updated.
- **Research:** projects list; run view = question, plan phases with status, sources table, findings with verification checkmarks, final artifact structured and **copyable as JSON/MD** (Copy button → toast).
- **Settings:** profile · security (change password, sessions) · provider key management (rotate) · notification preferences · **Danger zone** (red-bordered card; delete confirm uses type-to-confirm "delete").
- **Auth:** centered card max 400px, wordmark above, inline field validation (errors under the field, not toasts), wrong-password = inline banner, loading state on button. Signup adds name. Zero marketing copy — functional only.

---

## 7. Interaction design

### 7.1 Keyboard map

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl K` | Command palette (from anywhere) |
| `g d` | Dashboard · `g c` Chat · `g a` Agents · `g t` Tasks · `g r` Runs · `g i` Decision Inbox |
| `Esc` | Close drawer/modal/palette; second press clears selection |
| `↑ ↓ Enter` | Navigate + execute in palette, menus, lists |
| `Tab / Shift+Tab` | Roving focus through tabs and step wizards |

### 7.2 Notifications policy (bell vs toast — keep it strict)

- **Toast** = transient feedback for *your own* actions (created/updated/error) + SSE events that need attention (run failed, run waiting approval). Max 3 stacked; errors persist until acted on.
- **Bell** = everything persisted, with unread count badge. Click → panel list (read/unread state, "Mark all read"); each notification deep-links to the entity.
- Rule: if it's toast-only and the user misses it, that's a bug — attention events also land in the bell.

### 7.3 Destructive actions & undo

- Delete (agent/goal/task) → confirm modal naming the object ("Delete **Researcher**? Its 12 runs remain visible.") → soft delete → toast with **Undo** (6s window).
- Cancel run → inline confirm popover (not a full modal): "Cancel this run? Completed steps are kept."

---

## 8. Onboarding & first-run journey

The acceptance journey from the build doc — *signup → add provider → create agent → create goal → create task → run → approve → verify → view receipt* — is the onboarding. The UI makes it visible:

1. **Setup checklist card** (Dashboard, right column) with a progress ring; steps mirror the journey: ✓ Add provider → → Create an agent → ○ Define a goal → ○ Run a task → ○ Approve & verify. Each step links to its destination page.
2. **Contextual hint banners** on each destination page while setup is incomplete (dismissible, one per page): e.g., Models page: *"Add your first provider to start running agents."* Real copy only.
3. Checklist auto-completes from real state (no manual "mark done"); it disappears once all steps are satisfied or after 7 days.
4. No forced tour, no modals-on-load. The product teaches by being honest: empty states point at the next action.

---

## 9. State catalog (required on every page)

| State | Pattern |
|---|---|
| **Empty** | EmptyState component (§4.7) with a real CTA into the next step of the journey. Never lorem cards. |
| **Loading** | Skeletons shaped like the final layout; spinners only <1s actions. No full-page loaders. |
| **Live** | SSE patches in place (§5); running dots pulse; timers tick; "● Live" chip where applicable. |
| **Error** | Inline field errors; panel ErrorState with code + Retry; global 5xx banner. `401` → redirect to login preserving return path. `409` conflicts show the server's message verbatim in a toast. |
| **Success** | Toast (transient) or the signature beats: receipt card (§6.4), "Connected — N models found" (§6.9). |

---

## 10. Accessibility (WCAG 2.1 AA)

- **Contrast:** all token pairings meet AA (values in §2.2). `--text-muted` never below body size.
- **Focus:** visible 2px `accent-400` ring on every interactive element; focus order = DOM order = visual order.
- **Status:** color + label + icon always (§4.4). Failed rows include an icon, not just red.
- **Screen readers:** `aria-live="polite"` region announces run status changes ("Run *Summarize Q3* completed"); streaming announces on completion, never per-delta; toasts use `role="status"`/`role="alert"`.
- **Overlays:** focus trap + `aria-modal`; focus returns to trigger on close.
- **Forms:** labels always present; errors linked via `aria-describedby`; wizards show an error summary listing all failing fields on submit.
- **Tables:** captions + `scope="col"`; sortable headers announce sort state.
- **Motion:** `prefers-reduced-motion` → pulse becomes static dot, shimmer becomes static blocks, drawers/modals fade only (§11).
- **Targets:** ≥24px hit areas (desktop), 44px touch targets (mobile).

---

## 11. Motion system

| Token | Value | Use |
|---|---|---|
| `duration-fast` | 120ms | Hover, toggles, chip states |
| `duration-base` | 180ms | Dropdowns, toasts, collapses, modals |
| `duration-slow` | 260ms | Drawers, large panel swaps |
| `easing` | `cubic-bezier(0.2, 0, 0, 1)` | Everything (one easing, no bounces) |

- **Pulse dot (running):** opacity `.4 → 1`, scale `.8 → 1`, 1.6s infinite. The product's signature "alive" signal.
- **Streaming caret:** 1s blink at the end of live text.
- **Shimmer skeleton:** gradient sweep, 1.8s linear infinite.
- **Screenshot crossfade:** 200ms opacity on Browser updates.
- **Never animate layout.** Streaming and SSE updates reserve height — zero layout shift. No page transitions: routing is instant.
- `prefers-reduced-motion`: pulse → static dot, shimmer → static blocks, slide → fade only.

---

## 12. Voice & microcopy

**Tone:** calm, precise, second person. No exclamation marks, no "AI magic", no marketing adjectives. The product sounds like a reliable operator, not a chatbot.

| Moment | Copy |
|---|---|
| Empty dashboard | "No runs yet — create an agent and run your first task to see live activity here." |
| Empty inbox | "Nothing waiting on you." |
| Approval summary pattern | "{Agent} wants to {action}. {reason}" |
| Approve / Reject buttons | "Approve" · "Reject" (never "Yes/No") |
| Expiry | "Expires in 4h 12m" → switches to clock format under 60min |
| Running row | "Running · 2m 14s" |
| Failed row | "Failed" + error code caption + Retry |
| Provider connected | "Connected — 12 models found" |
| Key entry | "Key shown once — you can't see it again." |
| Sandbox indicator | "In-process worker — development isolation" |
| Delete confirm | "Delete **{name}? {consequence sentence}." |
| Undo toast | "{Name} deleted. [Undo]" |

**Rules:** durations and IDs in mono; relative time for <7 days, absolute beyond; every button label is a verb ("Test connection", "Sync models" — never "Submit"); error messages state what happened + what to do next, with the raw `error.code` available one level deeper.

---

## 13. Anti-patterns (what this product never does)

- ❌ Gradient blobs, aurora backgrounds, glassmorphism
- ❌ Fake canvas graphs / node editors (workflows are a readable list)
- ❌ Lorem cards, placeholder avatars, fake sparklines
- ❌ Full-page spinners; spinners over 1 second anywhere
- ❌ Color-only status signals
- ❌ More than one accent color in any view
- ❌ `alert()`/`confirm()` dialogs
- ❌ Auto-scroll that fights the user
- ❌ Progress bars without a real denominator
- ❌ Confetti, bounces, or anything that animates layout

---

## 14. Design QA & acceptance checklist

Run this after Phase 13, before Phase 14:

- ☐ Contrast pass: every token pairing meets WCAG AA (§2.2)
- ☐ Full user journey (signup → … → view receipt) completable **keyboard-only**
- ☐ SSE kill test: kill a run mid-flight → UI reflects `failed` within 1s, no manual refresh
- ☐ Reconnect banner appears on SSE drop and auto-dismisses on resume; stale data dimmed
- ☐ No lorem/placeholder data anywhere; every number traces to a DB row
- ☐ All five states (empty/loading/live/error/success) present on all 17 pages + auth
- ☐ Command palette opens from any page via `⌘K` and covers navigation + top actions
- ☐ Decision Inbox fully usable by keyboard; approvals work with optimistic update + SSE confirm
- ☐ Failed steps auto-expand in Timeline with the exact error visible
- ☐ No layout shift during streaming or SSE updates (height reserved)
- ☐ Every destructive action is confirmed and undoable (soft delete + Undo toast)
- ☐ `prefers-reduced-motion` mode tested (static dots, no shimmer)
- ☐ Mobile (390px): Chat, Dashboard summary, Decision Inbox fully usable
- ☐ Focus returns to trigger after every modal/drawer close
- ☐ All status colors paired with labels/icons; zero color-only signals
- ☐ Setup checklist appears on fresh tenant, auto-completes from real state, and disappears when done

---

*End of `UI-UX-DESIGN.md` — keep this file at `docs/UI-UX-DESIGN.md`, referenced from `BUILD.md` Phase 13.*
``



markdown
# NEXS — UI/UX Design Specification

> **Purpose:** Make the Agent Control Plane attractive, fast to learn, and delightful to live in.
> **Audience:** Developers and operators who run AI agents all day. They are expert users —
> "attractive" here means *precision, liveliness, and zero friction*, not decoration.
> **Locked constraints (do not change):** dark-first theme · Tailwind 4 tokens · shadcn/ui ·
> one accent color + four status colors (green=ok, amber=waiting, red=failed, blue=running) ·
> sidebar nav tree exactly as §4 · topbar with notifications bell + user menu ·
> `⌘K` command palette · `g d` / `g c` / `g a` navigation shortcuts.

---

## 1. Design Positioning

**One sentence:** *NEXS is mission control for AI agents — it should feel like a live instrument panel, not a CRUD app.*

Three principles, in priority order:

1. **Live first.** Every screen should show motion when the system is working (streaming text,
   pulsing status dots, progress rings, SSE-driven updates). A static NEXS is a dead NEXS —
   the "alive" feeling is the single biggest attractor.
2. **Truth on screen.** Every number traces to a DB row (the project's honesty rule). The UI's
   job is to make that truth *visible and legible at a glance*: status chips, progress, receipts.
3. **Keyboard is a first-class citizen.** Power users should be able to do the full journey
   (signup → agent → goal → run → approve → verify) without touching a mouse. The command
   palette (`⌘K`) is the hero interaction and the onboarding centerpiece.

**The "wow" moments** (design these with extra care — they're what people screenshot):

| Moment | Where | Why it attracts |
|---|---|---|
| Streaming chat with inline tool-call cards that shimmer while running, then collapse to a clean summary | Chat | Shows the agent *thinking and working*, not just typing |
| Approval drawer: risk badge, exact action JSON, live expiry countdown ring → Approve/Reject with optimistic UI | Decision Inbox | Makes human-in-the-loop feel safe and fast |
| Run Timeline: real step rows filling in live over SSE, each with timing | Runs (Agent Workspace) | The "watch the machine work" feeling |
| Verified goal: success criteria flip to green checkmarks one by one, then a subtle receipt stamp animation | Goals | Proof, visualized |
| `⌘K` palette: instant fuzzy results from real registry data, full keyboard flow | Everywhere | Power-user delight, onboarding hook |

---

## 2. Visual Identity

### 2.1 Color tokens (Tailwind 4 `@theme`)

Dark-first only for v1. Light mode is a later phase — design all surfaces against these tokens
so light mode can be added without rework.

```css
/* Surfaces — near-black base, one step of elevation per layer */
--color-bg:          #0B0B10;  /* app background (near-black)            */
--color-surface:     #121218;  /* cards, panels                           */
--color-surface-2:   #1A1A23;  /* raised: popovers, inputs, hover rows     */
--color-border:      #262633;  /* default borders                         */
--color-border-hi:   #34344A;  /* focused/hovered borders                  */

/* Text — three levels, no more */
--color-text:        #EDEDF2;  /* primary                                 */
--color-text-muted:  #9C9CB0;  /* secondary, labels                       */
--color-text-faint:  #6B6B80;  /* placeholders, timestamps                */

/* THE accent — one color, used sparingly (CTAs, focus, active nav, links) */
--color-accent:      #8B5CF6;  /* violet — deliberately distinct from status blue */
--color-accent-hi:   #A78BFA;  /* hover / lighter tint on dark              */
--color-accent-dim:  #4C3A8F;  /* pressed, inactive accent surfaces         */

/* Status (locked semantics — never repurpose) */
--color-ok:          #22C55E;  /* green  = ok / succeeded / verified        */
--color-waiting:     #F59E0B;  /* amber  = waiting for approval / pending   */
--color-failed:      #EF4444;  /* red    = failed / error                    */
--color-running:     #38BDF8;  /* blue   = running / streaming / active     */

/* Status tints — chip backgrounds (10–15% alpha of the hue on surface) */
--color-ok-bg:       rgba(34,197,94,.12);
--color-waiting-bg:  rgba(245,158,11,.12);
--color-failed-bg:   rgba(239,68,68,.12);
--color-running-bg:  rgba(56,189,248,.12);
```

**Accent usage rules (this is what keeps it looking designed, not noisy):**
- Accent appears in: primary buttons, active nav item, focus rings, links, selected rows,
  progress bars. Nowhere else.
- Never use accent for status. Status is always the four semantic colors.
- Max ~20% of visible pixels may carry accent at any time.

### 2.2 Typography

| Token | Family / size / line-height | Use |
|---|---|---|
| `--font-ui` | **Geist** (variable), fallback Inter | All UI text |
| `--font-mono` | **JetBrains Mono**, fallback ui-monospace | Tool args/results, JSON, IDs, code, terminal output |

```
text-xs    12/16   — timestamps, badges, table headers
text-sm    14/20   — body default (tables, lists, forms)
text-base  16/24   — chat messages, detail prose
text-lg    18/28   — section titles in detail panes
text-xl    20/28   — page titles
mono-sm    12/16   — tool call args/results (cap line height for density)
```

Rules:
- Page title + one-line summary is the only large text on any page. No hero headers inside the app.
- All JSON, IDs, timestamps, and model names render in `--font-mono`. This single rule makes
  the product read as "serious tooling" instantly.
- Truncate with ellipsis; never wrap a status chip or a table cell mid-word.

### 2.3 Spacing, radii, elevation

```
Spacing scale: 4px base grid (p-1 … p-6); standard card padding = 16px;
gap between cards = 16px; gap inside dense tables = 8px.
Radii:  controls 8px · cards/panels 10px · popovers/modals 12px · avatars full-round
Elevation (dark theme = lightness, not shadow):
  level 0  surface        #121218  — page content cards
  level 1  surface-2      #1A1A23  — inputs, hover states, nested panels
  level 2  surface-2 + border-hi + shadow-lg (black 40%) — popovers, modals, command palette
```

### 2.4 Iconography

- **Lucide** at 16px in UI chrome, 18px in nav, stroke width 1.75 for anything below 18px.
- Icons are *labels, not decoration*: every icon-only control has a tooltip + `aria-label`.
- Status is never color-only: status chips always pair dot/icon + text (`● Running`, `✓ Verified`).

---

## 3. Layout System (the Shell)

```
┌──────────────────────────────────────────────────────────────┐
│ ⌘K search            ·······················   🔔(3)   👤 menu │  topbar 48px, sticky
├─────────────┬────────────────────────────────────────────────┤
│ sidebar     │  content area (max-w-6xl centered, px-6)       │
│ 240px fixed │                                                │
│ ─────────── │  page header: title + summary + primary action │
│ NEXS        │  ────────────────────────────────────────────── │
│ ● Dashboard │  content: cards / tables / detail panes        │
│ ● Chat      │                                                │
│ ▸ Agents    │                                                │
│ ▸ Goals     │                                                │
│ ▸ Tasks     │                                                │
│ ▸ Workflows │                                                │
│ ▸ Runs      │                                                │
│ ⚠ Decisions │                                                │
│ ─────────── │                                                │
│ Models      │                                                │
│ Tools       │  MCP · Connectors · Browser · Sandbox          │
│ Memory      │  Research · Settings                           │
└─────────────┴────────────────────────────────────────────────┘
```

- **Sidebar:** exactly the §4 tree, no additions. Section dividers only where listed above.
  Active item: `surface-2` background + accent left indicator (2px). Pending Decision Inbox
  count renders as an amber pill on its row — this is the app's "pull" notification.
- **Topbar:** sticky, 48px, `bg-bg/80` with backdrop-blur when content scrolls under it.
  Left: `⌘K` button (search icon + faint text) — clicking opens the command palette.
  Right: bell with unread count badge (accent), user menu (avatar initials in a circle).
- **Content:** centered, max width 1152px (`max-w-6xl`). Dense pages (tables) may use full
  width minus `px-6`.
- **Responsive:** sidebar collapses to icon rail at <1024px; topbar search hides behind `⌘K`
  everywhere. Detail pages with side panels stack panels below the main pane at <768px.
  v1 is desktop-first; mobile is "readable and usable", not "delightful".

---

## 4. Component Specs (the pieces that make it look designed)

### 4.1 Status chip — the most-repeated element in the app

```
[● Running]   dot 6px, color per status; text-xs; px-2 py-0.5 rounded-full
              bg = status tint; text = full-brightness status color
[✓ Verified]  icon replaces dot when a check applies
[⏸ Paused]   [✕ Failed]  [… Waiting approval]
```

Rules: chips are the *only* place status colors appear as fills. Everywhere else, status is
a colored dot + neutral text (e.g., table rows). Running dots pulse (`opacity 1→0.4`, 1.6s,
`prefers-reduced-motion` disables it).

### 4.2 Cards

- `surface` background, `border` border, radius 10px, padding 16px.
- Card header: 14px semibold title + optional right-aligned meta in `text-faint`.
- No card shadows at rest (dark theme). Hoverable cards: border → `border-hi`, translate-y −1px,
  120ms ease-out. Clickable rows in tables get the same hover treatment on the row.

### 4.3 Buttons

| Variant | Style | Use |
|---|---|---|
| Primary | accent bg, white text, radius 8, h-9 | One per view (the obvious next action) |
| Secondary | `surface-2` bg, border, text primary | common alternatives |
| Ghost | transparent, hover `surface-2` | row actions, icon buttons |
| Danger | failed tint bg + failed text | Delete, Reject — **never** solid red (too loud) |

- Loading: label replaced by 14px spinner; button stays the same width (no layout shift).
- Disabled = reduced opacity + `cursor-not-allowed` + tooltip explaining *why*
  ("Agent is running a task").

### 4.4 Forms & inputs

- Inputs: `surface-2` bg, radius 8, h-9; focus ring = accent 2px with 2px offset.
- Labels above inputs (12px, muted). Helper text below in `text-faint`. Errors: failed-color
  border + inline message with icon — **never** a browser alert.
- Long forms (agent wizard, provider create) are **stepped**, one screen-width of content per
  step, progress shown as "Step 2 of 5" text + thin accent progress bar. Never a 1200px-tall form.

### 4.5 Tables

- Header row: `text-xs uppercase tracking-wide text-faint`, sticky.
- Row height ~44px; zebra off (rows separated by border); hover `surface-2`.
- Every table has: search box (top-right of card), filter chips, and a count ("14 agents · 3 running").
- Long JSON in cells: truncated to one line with an "expand" affordance → opens inline expandable
  block or drawer. Never a modal for reading; modals are for *decisions*.

### 4.6 Command palette (`⌘K`) — the hero component

- Centered, level-2 elevation, max-w-xl, backdrop dims content to 50%.
- Input on top (no placeholder — just cursor), results grouped: **Pages**, **Actions**, **Objects**
  (agents/goals/runs from real registry data).
- Full keyboard flow: ↑↓ navigate, ↵ open, esc close. Recent items pinned at top of Pages.
- Fuzzy matching against real names/IDs. Zero-latency feel is the point — this is where users
  fall in love with the product.

### 4.7 Empty states (do not ship lorem cards)

Every list has a designed empty state: small inline illustration or icon, one sentence of
plain truth, and **one** primary action that creates the first item.

```
┌─────────────────────────────────────────┐
│              ◇                           │
│        No agents yet                     │
│   Your first agent needs a name and     │
│   instructions — takes about a minute.  │
│            [ Create agent ]             │
└─────────────────────────────────────────┘
```

### 4.8 Error states

- Inline: failed-color icon + one line of what happened + one retry affordance ("Try again").
- Page-level failure: centered card, same pattern, plus "Back to {page}" secondary action.
- Never show raw stack traces in v1 UI; log them, and show "Something went wrong — try again."
  (Detail view for power users: expandable mono block with the API error body.)

---

## 5. Page-Level UX (flagship pages)

### 5.1 Dashboard — the pulse

- **Top row (3 cards):** Active runs (count + list of top 3, each with agent name + step
  progress ring), Pending decisions (amber, links to Decision Inbox), Recent failures (red,
  only shown when >0 — absence is good news).
- **Activity feed (main column):** reverse-chronological stream of run/step/approval events
  over SSE. Each row: status dot + actor (agent name) + action verb + object link + relative
  time ("12s ago", auto-refreshing). This is the "alive" centerpiece — it should be moving
  whenever the system is working.
- **Right rail:** Up next (scheduled tasks in the next hour), and a tiny "System" card:
  provider health dots (green/amber/red per provider), last sync time.
- No marketing hero. The first thing a user sees is *their agents, doing things, right now*.

### 5.2 Chat — the flagship page

Layout: full-height, no sidebar padding (content edge-to-edge minus `px-6`). Composer pinned
at bottom; message stream scrolls.

**Composer:**
- Auto-growing textarea (min 40px, max 320px), accent border on focus, `↵` sends / `⇧↵` newline.
- `/` opens the slash-command menu: fuzzy list of the **real** command list, each row =
  command + one-line description + mono args hint. Arrow keys + ↵.
- `@` opens the mention popup: real registry autocomplete (agents, models, tools, mcp,
  skills, goals, workflows, connectors, runs, files), grouped by kind, with kind icons.
- Attachment/folder picker button: selected attachments render as chips above the textarea
  with permission badges (`read`, `write`, `none`) — badge color per permission (ok/failed/faint).
- While streaming: send button becomes a stop button (square icon); composer stays editable.

**Message stream:**
- Assistant messages stream token-by-token over SSE with a blinking caret at the head of the text.
- **Tool calls render inline as collapsible cards** — this is the signature interaction:

```
┌─ ⚙ web_search · 1.2s ──────────────── [−] ┐   (collapsed, after completion)
│  query: "nexs agent control plane"         │
│  → 4 results · 1.2s                       │
└───────────────────────────────────────────┘

While running: card border shimmers in accent→transparent sweep; header shows spinner +
elapsed time ticking (0.3s, 0.7s, 1.2s…). Expands automatically to show args as they arrive.
```

- User messages: right-aligned, `surface-2` bubble, max-w 640px.
- Failed stream: message ends in a failed-color inline note + "Retry" ghost button.
- Slash-command results (e.g., `/agents`) render as compact result cards, not chat bubbles.

### 5.3 Agents

- **List:** table (name, model, status chip, last run, actions). Status chips per §4.1.
- **Create wizard:** stepped (name → instructions → model picker from real models →
  tools/MCP/connectors checkboxes → capabilities toggles → approval policy). Model picker is a
  searchable list of *real* models with capability chips and context window — no fake dropdowns.
  Final step shows a summary card of everything chosen, then "Create agent".
- **Details:** tabs Overview / Config / Goals / Tasks / Runs / Versions / Schedules / Approvals.
  Header: name + status chip + action buttons (Run, Pause, Resume, Edit, Duplicate, Disable,
  Delete) — **Run** is the only primary button; Delete is a danger ghost in a "More" menu so it's
  one click away but never accidental.

### 5.4 Goals

- Details page centerpiece: **success criteria list** — each row = criterion text + per-criterion
  verification state chip (pending / verifying / verified / failed). Progress bar above the list:
  "2 of 5 tasks complete". Evidence panel: mono blocks of receipts/outputs, expandable.
- The moment: as SSE delivers verifications, rows flip to green checkmarks one at a time with a
  200ms fade — and when all are verified, a subtle receipt stamp appears in the header
  ("Verified · receipt #abc123") — small, tasteful, screenshot-worthy.

### 5.5 Runs — the Agent Workspace

- **Run details = the most information-dense page in the app.** Tabs: Overview / Timeline /
  Tools / Browser / Terminal / Files / Artifacts / Approvals / Verification. All live via SSE.
- **Timeline tab:** real step rows, each with: index, tool name (mono), status chip, duration,
  start time. Running steps show a thin accent progress shimmer on the row. This is the
  "watch the machine work" screen — keep it dense and legible, mono everywhere it belongs.
- **Browser tab:** live session view — URL bar, title, latest screenshot (grayscale when stale),
  action log below in mono.
- **Terminal tab:** sandbox executions as a read-only terminal: command line in accent, stdout
  in text, stderr in failed-color. No editable prompt in v1.

### 5.6 Decision Inbox — safety made visible

- Pending list: each row = risk badge (low/medium/high → ok/waiting/failed tints), requested
  action summary, agent name, **expiry countdown** ("expires in 4m 12s", turns amber under 1m).
- Detail drawer (right side, 480px): "What will happen" in plain language → requested action
  JSON in a mono block → permissions list → reason → Approve / Reject buttons.
- **Approve/Reject are optimistic**: UI updates immediately, SSE confirms; if the server rejects,
  revert with an inline failed-color note. This is where latency must feel zero.

### 5.7 Everything else

- **Models:** provider cards (name, type, status dot, model count, last sync, health) + models
  table with capability chips and context window. Provider create: type picker → dynamic fields
  → key entry that is **show-once then masked** (the classic secret-entry pattern, done well:
  "Show once" button, then `••••` with a copy icon).
- **Tools / MCP / Connectors:** registry tables + detail pages with schema viewers and
  test-invocation panels. Test results render in mono blocks with ok/failed chips.
- **Memory:** scoped browser (scope filter, agent filter) + semantic search box; results show
  relevance score faintly. CRUD via inline edit — no modal for editing a memory.
- **Research:** run view = question, plan phases with status chips, sources table, findings
  with verification checkmarks, final artifact rendered structured with "Copy as JSON / Copy as
  Markdown" buttons.
- **Settings:** profile, security, provider keys (rotate), notification preferences, danger zone
  (danger-zone actions require typing the agent/tenant name to confirm — one of those details
  that makes a product feel careful).
- **Auth pages:** centered card on `bg`, logo top, argon2-backed signup/login with designed
  error states ("Email already registered" inline) and loading spinners. No marketing copy.

---

## 6. Motion & Micro-interactions

All motion is purposeful; every animation must answer "what changed?". Respect
`prefers-reduced-motion` (disable pulses, shimmers, transitions → instant state changes).

| Interaction | Spec |
|---|---|
| Streaming text | caret blink 1s; no per-token animation beyond natural append |
| Running status dot | opacity pulse 1.6s ease-in-out infinite |
| Running tool-call card | border shimmer: accent→transparent linear sweep, 1.4s loop |
| SSE row insertion (feeds, timelines) | fade + translate-y 4px in, 200ms ease-out; no scroll-jacking — only auto-scroll if user is at the bottom |
| Chip state change (e.g., pending→verified) | 200ms crossfade of icon + tint |
| Hoverable cards/rows | border-hi + translate-y −1px, 120ms ease-out |
| Drawer/palette open | scale 0.98→1 + fade, 160ms; backdrop fade 120ms |
| Optimistic action (approve/reject) | instant; confirmation via SSE = no animation needed, just state settle |
| Receipt stamp (goal verified) | one-time: fade-in + scale 1.02→1, 300ms — never repeats |

**Rules:** durations only from {120ms, 160ms, 200ms, 300ms}; easing `cubic-bezier(0.2, 0, 0, 1)`;
no bouncing, no springs, no parallax. If a motion doesn't convey state, cut it.

---

## 7. Voice & Copy

- Short, factual, present tense. No exclamation marks anywhere in the app.
- Status copy names the actor and verb: "Researcher is browsing 3 sources." / "Approval waiting — browser will navigate to example.com."
- Empty states say what's missing and what one action fixes (see §4.7).
- Errors state what happened + the next move, never blame the user ("We couldn't reach the
  provider — check its status or try again.").
- Numbers are always real DB values; relative times auto-refresh ("12s ago" → "1m ago").

---

## 8. Accessibility (non-negotiable)

- **Contrast:** all text ≥ WCAG AA on its surface (verify: `#EDEDF2` on `#0B0B10` ≈ 15:1;
  accent `#8B5CF6` on `#0B0B10` ≈ 4.9:1 — fine for text; use `--color-accent-hi` for small accent text).
- Status is never color-only: dot/icon + text label, always.
- Full keyboard coverage: tab order matches visual order; every interactive element reachable;
  focus ring = accent 2px, offset 2px, visible on all surfaces.
- `⌘K` palette and `g d` / `g c` / `g a` shortcuts work with the palette closed and don't trap
  typing (shortcuts inactive while an input is focused).
- Tables: real `<table>` semantics, `scope="col"` headers; timelines are ordered lists.
- Live regions: SSE-driven updates that matter (run failed, approval resolved) announce via
  `aria-live="polite"`; streaming text is `aria-busy` while in flight.
- `prefers-reduced-motion`: all §6 animations collapse to instant state changes.

---

## 9. Do / Don't

**Do:**
- Use mono for every machine-generated string (JSON, IDs, args, results, URLs, timestamps).
- Keep one primary action per view; make it accent.
- Design the running/failed states before the success state — this app lives in motion.
- Let the Decision Inbox pull attention (amber pill on nav row) instead of pushing popups.

**Don't:**
- Don't add marketing heroes, illustrations with faces, or confetti inside the app shell.
- Don't use accent for status, or status colors outside their four meanings.
- Don't ship lorem-ipsum cards, fake dropdowns, or placeholder data in any screen.
- Don't put Delete next to primary actions at button level (it lives in "More").
- Don't animate more than one thing per viewport at rest.

---

## 10. Design QA Checklist (run before each phase demo)

- [ ] Every page renders real data; kill a run mid-flight and watch the UI reflect `failed` via SSE.
- [ ] Full journey works with keyboard only: signup → add provider → create agent → goal → task → run → approve → verify → view receipt.
- [ ] `⌘K` opens from anywhere, fuzzy-matches real registry data, full arrow-key flow.
- [ ] All status chips pair icon/dot + text; all four status colors appear with correct semantics.
- [ ] No layout shift on loading (skeletons match final geometry), no modal for reading-only content.
- [ ] Every empty state has exactly one primary action; every error has a next move.
- [ ] `prefers-reduced-motion` tested: app is fully usable with animations off.
- [ ] Contrast spot-check: muted text on `surface`, accent text, status tints all pass AA.
- [ ] One primary button per view; Delete one level deep; optimistic actions revert cleanly on failure.