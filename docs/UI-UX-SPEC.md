# NEXS — UI/UX Specification v2 (canonical, additive)

> **Supersedes** the two earlier design docs and §6.3 of the build spec. Where they conflicted,
> this file decides (§2.0). Everything here is additive to the locked stack: Vite + React +
> Tailwind 4 + shadcn/ui + TanStack Query + Zustand. No new libraries.
> **Companion:** `docs/ARCHITECTURE-DIAGRAMS.md` (D1–D8).

---

## 0. Positioning

NEXS is mission control for AI agents — a live instrument panel, not a CRUD app.
The UI's single job: make the control plane feel **alive, honest, fast, calm, in your hands.**

| Pillar | In pixels |
|---|---|
| Alive | SSE patches rows in place; timers tick; screenshots crossfade; streaming caret; running dots pulse — and stop the second the run finishes |
| Honest | Every number traces to a DB row. No lorem cards, no fake progress bars. If data doesn't exist, the panel is hidden — not faked |
| Fast | Instant routing (no page transitions), `⌘K` from anywhere, optimistic updates for every action |
| Calm | Near-black surfaces, one accent, status colors only where they mean something. Dense rows, generous section air |
| In your hands | Approvals are first-class; destructive actions confirm + undo; keyboard-only full journey |

**Attract moments** (design these with extra care):

1. Running dot pulses — and stops exactly when the run finishes.
2. Streaming answers with live caret; tool calls collapse inline as they complete.
3. `⌘K` palette: fuzzy over real registry data, recents, real actions.
4. First-run checklist with progress ring — setup in 5 visible steps.
5. Approval countdowns: amber under 1h, red under 10min. Urgency without pressure.
6. **The receipt moment:** goal verified → subtle green check + "View receipt". Proof, not confetti.
7. Browser tab crossfading live screenshots — you're watching it think.
8. Failed steps auto-expand with the exact error visible.
9. Optimistic Approve/Reject: click → instant → SSE confirms.
10. **Run replay video** (new): a generated mp4 of the whole run — screenshots + timeline. "Watch your agent work."
11. **Overnight digest** (new): wake up to one notification that deep-links a finished, verified, replayable research run.

---

## 1. Design principles (7 rules)

1. **Live first.** Every execution-state page is SSE-driven; no manual refresh ever reflects truth.
2. **Honest rendering.** Real data or nothing. Progress bars only with a real denominator.
3. **Density with breathing room.** 40px rows; 24–32px between sections. Never cramped and airy in the same viewport.
4. **Keyboard-first power path.** `⌘K`, `g <key>` navigation, `Esc`. Fully usable without a mouse.
5. **Status = color + label + icon, never color alone.**
6. **One accent, four status colors — nothing else.** A fifth hue in a mockup is wrong.
7. **Every state designed:** empty / loading / live / error / success. Five states or the page isn't done.

---

## 2. Visual identity

### 2.0 Token reconciliation (the decision)

Three token sets existed across prior docs. Canonical set below; the others are deprecated:

- ❌ Blue accent `#4f8cff` (build spec §6.3) — **collides with running-blue status color**. Rejected.
- ❌ `#8B5CF6 / #0B0B10` variant — merged into canonical.
- ✅ Canonical: violet accent on blue-tinted near-black (table below). Violet is deliberately distinct from running-blue so accent never reads as status.

### 2.1 Color tokens (exact — paste into Tailwind 4 `@theme`)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0B0C10` | App background |
| `--surface-1` | `#101218` | Cards, panels, inputs |
| `--surface-2` | `#151820` | Hover, nested surfaces, secondary buttons |
| `--surface-3` | `#1B1F29` | Active/selected rows, focus fills |
| `--border` | `#262B36` | Default borders |
| `--border-subtle` | `#1D222C` | Dividers, row separators |
| `--text-primary` | `#EDEFF4` | Body (≈15.8:1) |
| `--text-secondary` | `#A6ADB9` | Secondary (≈7.4:1) |
| `--text-muted` | `#78808F` | Meta/timestamps — body size only, never small dense text |
| `--accent-300` | `#A78BFF` | Accent text/icons on dark |
| `--accent-400` | `#8F72FF` | Hover, focus rings |
| `--accent-500` | `#7C5CFC` | Links, active indicators |
| `--accent-600` | `#6641EC` | Primary button bg (white text = AA) |
| `--success` | `#34D399` | ok · chip: bg `rgba(52,211,153,.12)`, text `#6EE7B7` |
| `--waiting` | `#FBBF24` | waiting/pending · chip: bg `rgba(251,191,36,.12)`, text `#FCD34D` |
| `--failed` | `#F87171` | failed/error · chip: bg `rgba(248,113,113,.12)`, text `#FCA5A5` |
| `--running` | `#60A5FA` | running/streaming · chip: bg `rgba(96,165,250,.12)`, text `#93C5FD` |

**Pairing rules:** white text only on `accent-600` and solid `--failed`. Accent glow
(`rgba(124,92,252,.35)`) reserved for focus rings + live indicators. Status chips always use the
12% bg + 300-level text pattern. Never solid status backgrounds.

### 2.2 Typography

| Token | Spec | Use |
|---|---|---|
| `caption` | 11px/500, uppercase, +0.04em | Field labels, table headers, meta |
| `sm` | 13px/400–500 | Dense tables, chips, breadcrumbs |
| `base` | 14px/400–500 | UI default |
| `md` | 16px/400–500 | Form fields, messages |
| `lg` | 18px/500–600 | Section headers |
| `title` | 24px/600 | Page titles |
| `display` | 30px/600 | Empty-state headlines, auth |

- **Sans:** Inter (variable) — 400/500/600 only. **Mono:** JetBrains Mono — JSON, IDs, durations, countdowns, terminal, tool args/results, URLs.
- Tight line heights (1.25–1.35) for UI; 1.5 for prose/messages only. Left-align everything except empty states and auth.

### 2.3 Spacing · radii · elevation

- Spacing: 4px base scale — 4·8·12·16·20·24·32·40·48·64. Nothing in between.
- Radii: controls `8px` · cards `12px` · chips `999px`. No others.
- Elevation = surface step (`surface-1→2→3`) + borders. Real shadow only for overlays: modals/drawers `0 8px 32px rgba(0,0,0,.6)`.

### 2.4 Iconography & brand

Lucide outline icons at 16px (nav 18px), consistent stroke; no filled icons except status dots/checkmarks.
Every icon-only control has tooltip + `aria-label`. Wordmark: `NEXS` in Inter 600, tracking −0.02em. No mascot, no logo animation.

---

## 3. Layout system

### 3.1 Shell & navigation tree (canonical — includes new Automation group)

```
┌───────────────────────────────────────────────────────────────┐
│  ⌘K search              ● Live          🔔 (3)      👤 menu   │  topbar 52px sticky
├──────────────┬────────────────────────────────────────────────┤
│  NEXS        │  content (max-w 1440, px-24 / px-32 ≥1440)     │
│              │                                                │
│  ● Dashboard │                                                │
│  ● Chat      │                                                │
│  ▸ Agents    │                                                │
│  ▸ Goals     │                                                │
│  ▸ Tasks     │                                                │
│  ▸ Workflows │                                                │
│  ▸ Runs      │                                                │
│  ⚠ Decisions (2)   ← amber pill = pending count                │
│              │                                                │
│  ─ Automation ─                                               │
│    Schedules       ← NEW (was API-only, no surface)           │
│    Events          ← NEW (subscriptions + webhook status)     │
│              │                                                │
│  ─ Capabilities ─                                             │
│    Models                                                     │
│    Tools                                                      │
│    MCP                                                        │
│    Connectors                                                 │
│    Skills          ← NEW (Hermes-style registry)              │
│              │                                                │
│  ─ Runtime ────                                               │
│    Browser                                                    │
│    Sandbox                                                    │
│    Memory                                                     │
│    Research                                                   │
│    Settings                                                   │
└──────────────┴────────────────────────────────────────────────┘
```

### 3.2 Geometry & breakpoints

| Element | Measurement |
|---|---|
| Sidebar | 240px expanded · 56px icon rail collapsed |
| Topbar | 52px, `border-subtle` bottom border, sticky; backdrop-blur when content scrolls under |
| Content padding | 24px (1024–1439) · 32px (≥1440) |
| Forms/wizards | max 720px centered |
| Chat column | messages max 760px centered |
| Run workspace | two-pane ≥1280: timeline min 480 left, detail flex right |

| Range | Behavior |
|---|---|
| ≥1440 | Ideal; all columns visible |
| 1024–1439 | Reduced padding; tables drop lowest-priority columns (CSS progressive disclosure) |
| 768–1023 | Sidebar auto-collapses to icon rail with tooltips |
| <768 | **Monitoring mode** (designed, not afterthought): Chat, Dashboard summary, Decision Inbox fully usable at 390px; other pages = readable lists + bottom action bar |

---

## 4. Component specifications

Every component ships this state matrix — no exceptions:
default · hover (`surface-2`) · focus-visible (2px ring `accent-400`, offset 2) · active (darker or scale .98, buttons only) · disabled (opacity .5, still labeled) · loading (spinner inside fixed width — zero layout shift) · error (border `failed/60` + 13px message below in `#FCA5A5`, `aria-describedby`).

### 4.1 Buttons

`primary` (accent-600, white) · `secondary` (surface-2, border) · `ghost` (transparent → surface-2 hover) · `danger` (solid `#E5484D`, confirm modals only) · `outline-danger`. Sizes sm h-8 / md h-9 / lg h-10, radius 8. **One primary per view.** Loading: label persists, spinner replaces leading icon, width locked.

### 4.2 Inputs & selects

Height 36px; `surface-1` bg; border → accent-500 + ring on focus. Labels = 11px caption above (never placeholder-as-label). Toggle 36×20, accent-500 on / surface-3 off, keyboard operable. Chat textarea auto-sizes (max 8 rows); elsewhere fixed height + resize handle.

### 4.3 Tables (the workhorse)

Row 40px; sticky header; no zebra — hover `surface-2`, selected `surface-3`. Sortable headers: muted arrow → accent when active. Search/filter row above the table, never inside. Bulk select reveals action bar (count + actions + Clear). Every table has caption + `scope="col"` headers + a count line ("14 agents · 3 running").

### 4.4 Status system (the heart)

| Status | Dot | Label | Motion | Extra affordance |
|---|---|---|---|---|
| ok/success | green dot or ✓ | "Completed" | static | — |
| running | blue dot | "Running · 2m 14s" (mono, live) | **pulse** (§11) | Pause/Cancel in row menu |
| waiting approval | amber dot | "Waiting for approval" | static | Link to Decision Inbox |
| failed | red dot | "Failed" + error code caption | static | Retry icon-button; error visible on expand |

Dot = 8px. Label always rendered beside it. Elapsed timers are real (`startedAt`), ticking per second, mono.

### 4.5 Chips & badges

Pill radius, status-chip pattern from §2.1, 13px text. Capability chips: neutral `surface-2`, text-secondary (`json_schema`, `read_only`, `side_effect`). RiskBadge (inbox): low = success outline · medium = waiting outline · high = failed outline + dot. **CredibilityBadge** (new, research sources): 3-tier — high = success outline, medium = waiting outline, low = muted; always with tooltip explaining the score inputs (domain authority, citation count, corroboration).

### 4.6 Overlays

| Component | Spec |
|---|---|
| Modal | Centered ≤520px (forms 640). Slide-up 8px + fade 180ms. Esc closes; focus trapped; focus returns to trigger. Destructive confirms: no close-on-overlay-click |
| Drawer | Right-anchored 480–640px, slide 240ms, overlay `rgba(0,0,0,.6)`. Decision detail + row details. Same focus rules |
| Toast | Bottom-right stack, max 3, width 360. Icon + title + description + one action. Auto-dismiss success/info 5s; errors persist until acted on. `role="status"` / `role="alert"` |
| Command palette | `⌘K`. Centered at 20% top, width 640. Sections: Go to · Agents · Runs · Actions. Fuzzy match, arrow nav, Enter executes, Esc closes; empty query = recents; kbd hints right side |
| Skeleton | `surface-2` blocks shaped exactly like final layout (zero shift) + shimmer 1.8s. Never full-page spinners; spinners only for <1s actions |

### 4.7 Empty & error states

**EmptyState:** centered ≤480px. Glyph in 48px `surface-2` circle → headline (`lg`) → one sentence of what to do next → primary CTA + optional secondary. No illustrated scenes, ever.

**ErrorState:** same shape, red-tinted glyph, message from `error.message`, `error.code` mono caption, Retry (secondary) + one context action. Global 5xx: slim banner under topbar with "Retry" and "View details" (expands to error envelope).

### 4.8 Domain components (build once, reuse everywhere)

| Component | Spec |
|---|---|
| **Timeline** (run workspace) | Vertical step list: status icon · title · duration (mono). Collapsible args/result JSON — collapsed by default, **auto-expanded on failure**. Current step: running dot + live elapsed timer |
| **ProgressBar** | Only with a real total. Track `surface-3`, fill accent-500 (success at 100%). No indeterminate bars — use the running dot instead |
| **Countdown** (approvals) | Mono. Human-relative >60min ("Expires in 4h 12m"), clock below ("09:41:22"). Amber <1h, red <10min. On expiry → status `expired` + reason line |
| **JSONViewer** | Pretty-printed, syntax-tinted (keys accent-300, strings success-300, numbers waiting-300), max-height scroll, Copy → toast "Copied", truncate at 40 lines with "Show more" |
| **KVList** | Key–value grid for Overview panels; caption keys left, values right (values may be chips/links); 2 cols ≥1280 |
| **ScreenshotFrame** (browser) | 16:9, `surface-1` bg, URL + title bar above (real data), image crossfades 200ms per SSE update. Placeholder: muted globe + "Waiting for first navigation". Grayscale when stale (SSE disconnected) |
| **ArtifactViewer** (NEW) | Renders by artifact type: `diagram` → mermaid/SVG inline with zoom; `slides`/`explainer`/`graph` → sandboxed iframe preview (self-contained HTML from storage) + "Open full page" (dedicated route); `video` → native `<video>` player with step-timeline scrubber synced to chapter markers; `report` → rendered MD + tabs "Copy as JSON / Copy as MD / Download". Every artifact shows: type chip, size, created step link, verification status if any |
| **SkillCard** (NEW) | Name · one-line description · version chip (`v3`) · capability chips · "Last run" relative time + status dot. Actions: Run test (opens args form generated from `argsSchema`), Edit, Version history, Disable |
| **ProtocolPhaseList** (NEW, research) | Ordered phases with per-phase status chips (pending/running/completed/failed), each expandable to its sources/findings subset. This is the research run's timeline — same component DNA as Timeline |

---

## 5. Live system (SSE-driven UX)

1. **Optimistic updates** for every user action (approve, reject, pause, resume, cancel, create). UI changes instantly; SSE confirms or rolls back with a toast on mismatch.
2. **In-place row patches.** Events patch the specific row/card — never a list reload that scrolls the user away.
3. **Reconnect banner.** SSE drop → slim amber banner under topbar: "Reconnecting… last updated 12:04:31"; auto-dismisses on resume; data behind it dimmed to 60% opacity while stale. Backoff 1s→30s.
4. **Auto-scroll discipline (Chat).** Auto-scroll only while within one viewport of the bottom; otherwise "↓ Jump to latest" pill. Never fight the scroll.
5. **Live header chip.** Any page showing an active run shows "● Live" (running-blue, pulsing) in the header while that run's SSE events flow.

**SSE → query invalidation map (from build spec §6.4 — canonical):**
`run.*` → `['runs'], ['dashboard'], ['runs', runId]` · `step.*/tool.*/chat.*` (with runId) → `['runs', runId], ['chat','messages']` · `approval.*` → `['approvals'], ['dashboard']` · `agent.*` → `['agents']` · `goal.*` → `['goals']` · `task.*` → `['tasks']` · `provider.synced/health` → `['providers'], ['models']` · `mcp.connected` → `['mcp'], ['tools']` · `notification.created` → `['notifications']`.

**New surfaces reuse the catalog (no new event names):** skill test-runs ride `task.*/run.*`; artifact completion rides `run.completed` + refetch; overnight digest = `notification.created`.

---

## 6. Page experience specs

> Rule for every page: all five states — empty / loading / live / error / success — and real data only.

### 6.1 Auth

Centered card ≤400px on `--bg`, wordmark above, zero marketing copy. Inline field validation (errors under the field, never toasts); wrong password = inline banner; loading state on button; signup adds name. `401` anywhere → redirect to login preserving return path.

### 6.2 Dashboard — the pulse

```
┌──────────────────────────────────────────────────────────────┐
│ Overview                                  ● Live  [bell] [user]
├─────────────────────────────────────┬────────────────────────┤
│ Active runs (top 5)                 │ Setup checklist  ◔ 2/5 │
│                                     │                        │
│  ● Researcher — "Summarize Q3"      │  ✓ Add provider        │
│    running · 2m 14s      [→ run]    │  → Create an agent     │
│  ● Operator — "Deploy staging"      │  ○ Define a goal       │
│    waiting approval      [→ inbox]  │  ○ Run a task          │
│  ✕ Browser Scout — failed           │  ○ Approve & verify    │
│                                     │                        │
├─────────────────────────────────────┼────────────────────────┤
│ Recent failures (top 3)             │ Pending approvals: 2   │
│                                     │                        │
│                                     │ Provider health        │
│                                     │  ✓ OpenAI · 12 models  │
│                                     │  ● Ollama · connecting │
└─────────────────────────────────────┴────────────────────────┘
```

Left 2/3: **Active runs** (dot, agent, goal link, live elapsed, real progress) + **Recent failures** (top 3, "View" into run). Right 1/3: **Setup checklist** (only while incomplete — §8), **Pending approvals** count → inbox, **Provider health** (from `provider.health` cron rows — real). **Usage panel appears only if `ModelUsage` rows exist** — hidden entirely otherwise.
Fresh tenant: one "Start here" card with three real actions: *Add provider / Create agent / View guide*. No lorem cards, ever.

### 6.3 Chat (flagship)

```
┌───────────────┬──────────────────────────────────────────────┐
│ Sessions      │  You: @researcher summarize the Q3 report     │
│               │                                               │
│ ● Q3 summary  │  N Summarizing…                               │
│ ○ Deploy prep │  ┌─ tool · read_file · 0.4s ─────────── [▾] ┐  │
│ ○ Research    │  │ args/result JSON (collapsed)            │  │
│               │  └─────────────────────────────────────────┘  │
│               │                                               │
│               │  The Q3 report shows… ▌                       │
│               │                                               │
│               │  ┌──────────────────────────────────────────┐ │
│ [+ New chat]  │  │ [auto-sizing textarea]   [📎]  [Send →]  │ │
│               │  └──────────────────────────────────────────┘ │
└───────────────┴──────────────────────────────────────────────┘
```

- **Session list (new — `ChatSession` rows):** left rail ≤240px, real sessions with relative time + last-message snippet; "+ New chat"; delete = ghost icon in row menu. Persisted history survives restarts (`GET /api/chat/sessions`, `GET /api/chat/sessions/:id/messages`).
- **Composer:** auto-sizing textarea (max 8 rows); `Enter` sends, `Shift+Enter` newline; while streaming, Send becomes Stop (square icon), composer stays editable.
- **Slash menu** on `/`: fuzzy over the real command list (§3.8 of build spec), grouped System · Create · Control; each row = command + one-line description + mono args hint.
- **`@` mention popup:** live registry autocomplete from `GET /api/chat/mentions` (agents, models, tools, mcp, skills, goals, workflows, connectors, runs, files) with kind icons.
- **Attachments:** folder/file picker; permission badges (`read` ok · `write` accent · none faint).
- **Tool calls inline:** collapsible card — tool icon + name (mono) + duration chip; expanded = args/result via JSONViewer. Collapsed by default, auto-expanded on error. While running: border shimmer + elapsed ticking.
- **Streaming:** SSE deltas append live with blinking caret; no per-delta scroll fight (§5.4). Failed stream: failed-color inline note + Retry ghost button.
- **Empty state:** "Ask, or type `/help`" + 3 example chips referencing agents that actually exist (if none: CTA = *Create your first agent*).

### 6.4 Agents

- **List:** table — name · model chip · status chip (`active|paused|disabled|draft`) · last-run relative time · row menu (Run / Pause / Resume / Edit / Duplicate / Disable / Delete).
- **Create wizard (4 steps, left rail progress):** Identity → Instructions & Model → Capabilities → Review. Next gated on validation per step. Model picker grouped by provider with real capability chips + context window. Approval policy selector in plain language: *"Auto — read-only tools run freely; side effects ask you."* / *"Ask for everything."* / *"Never ask."* Review = summary card + **Create agent**.
- **Detail:** header (identity + status + actions; **Run** is the only primary; Delete lives in "More") + tabs: Overview / Config / Goals / Tasks / Runs / Versions / Schedules / Approvals. Versions tab: immutable snapshots with diff view (JSONViewer side-by-side).

### 6.5 Goals

Active / History tabs. Rows: title · progress (`3/5 tasks` — real total only) · verification summary · status chip.

**Detail:** success criteria list — each row = criterion + per-criterion verification state (pending = muted check outline, passed = green ✓, failed = red ✕ + reason); linked runs; evidence panel (receipts + verifications).

**Completion moment (signature beat):** when the Verifier passes all criteria, header swaps to success card: green check with subtle 400ms fade-in (no confetti), "Goal verified" + **View receipt** primary.

### 6.6 Tasks

Active / Scheduled / Completed tabs. Detail: status timeline (Timeline component), input/output via JSONViewer, error block with retry count, linked run link.

### 6.7 Workflows

List with version badges + active indicator. **Step editor = vertical numbered list, readable, not a fake canvas:** each step card = type icon, inline config form, position handle, `dependsOn` select, `onFail` select. Activate/deactivate in header. Run history tab.

### 6.8 Runs — the Agent Workspace (flagship detail)

```
┌──────────────────────────────────────────────────────────────┐
│ Run · Summarize Q3 report        ● Live   [Pause]  [Cancel]  │
│ agent: Researcher · goal: Q3 summary · started 12:04:31      │
├──────────────────────────────────────────────────────────────┤
│ Overview  Timeline  Tools  Browser  Terminal  Files           │
│ Artifacts  Approvals  Verification                            │
├──────────────────────────────────────────────────────────────┤
│  1  ✓  load report                                    0.8s   │
│  2  ✓  extract sections                               1.2s   │
│        [▾] args/result                                       │
│  3  ●  summarize (step 4/9)                     2m 14s ← live │
│  4  ○  draft summary                                         │
└──────────────────────────────────────────────────────────────┘
```

- Header: status chip + live duration + entity links (agent/goal/task/workflow) + context-aware actions. "● Live" while SSE flows.
- Tabs (all live via SSE): Overview / Timeline / Tools / Browser / Terminal / Files / **Artifacts** / Approvals / Verification.
- **Browser tab:** ScreenshotFrame (live crossfade, grayscale when stale) + action log below.
- **Terminal tab:** mono blocks; command in accent, stdout text, stderr failed-color; exit-code chip (green `0`, red non-zero); stdout/stderr toggle.
- **Artifacts tab (new):** grid of ArtifactViewer cards for every artifact the run produced — diagrams, slides, explainer page, knowledge graph, reports, and the **run replay video** (when generated). Each card: type chip · title · size · producing step link. Video card shows duration + "Generate replay" secondary when not yet built (post-run job; honest state, no spinner theater).
- **Overview:** KVList summary + plan steps with per-step status + usage stats only if `ModelUsage` rows exist.

### 6.9 Decision Inbox

```
┌──────────────────────────────────────────────────────────────┐
│ Pending (2)          Decided (14)                            │
├──────────────────────────────────────────────────────────────┤
│ [high]  Operator — send email to x@y.com                     │
│         reason: "Approved in goal criteria" · expires 09:41  │
│                                    [Approve]      [Reject]   │
└──────────────────────────────────────────────────────────────┘
```

Row: RiskBadge · agent name · plain-language summary ("{Agent} wants to {action}.") · reason (muted) · expiry Countdown · **Approve / Reject inline** — optimistic, SSE confirms (§5.1).

**Detail drawer:** "what will happen" in plain language → requested action JSON (JSONViewer) → permissions required (chips) → agent's reason → expiry countdown ring → Approve (primary) / Reject (secondary). After decision: toast + row moves to Decided with timestamp.
Empty state: green check glyph — "Nothing waiting on you."
**Overnight variant:** parked-while-unattended approvals show a "parked overnight" chip and the run link; digest notification deep-links here first.

### 6.10 Models & providers

- **Providers tab:** cards (name, type, status dot, model count, last sync, health) with actions **Test Connection** (inline spinner → "Connected — 12 models found"), **Sync Models**, Edit. Health comes from the `provider.health` cron row — never a guess.
- **Models tab:** table (name, provider, external ID mono, capability chips, context window, enabled toggle).
- **Provider create:** type picker → dynamic fields → key entry **shown once, then masked** with one-time notice: *"Key shown once — you can't see it again."* Rotate = new credential row; old one shows `rotatedAt`.

### 6.11 Tools

Registry table (type filter + search). Detail = schema viewer (JSONViewer), capability chips, **test-invocation panel**: form generated from the schema → Run → real result with duration + ok/failed chip. Test invocations are real `ToolCall` rows — visible in the run-less test log below.

### 6.12 MCP

Servers list (status dot, tool count, last connected). Add form: stdio (command+args+env) · http (url+headers). Detail = tools/resources/prompts tables, enable/disable toggles, Reconnect, Delete (confirms canonical Tool rows will be unregistered).

### 6.13 Connectors

Connected services list (status dot, account count, capability chips). Add flow: type → credentials → account selection → **capability discovery results shown as chips**. Detail = accounts, capabilities, event subscriptions, Test action. Includes the `reach` preset family (twitter/reddit/youtube/github readers) with honest copy: *"Read-only via public endpoints — no API fees; rate limits apply."*

### 6.14 Skills (NEW page — Hermes-style registry)

```
┌──────────────────────────────────────────────────────────────┐
│ Skills                              [Install starter pack]   │
├──────────────────────────────────────────────────────────────┤
│ deep-research  v3   research    2d ago      ● passed         │
│   8-phase pipeline · credibility scoring                     │
│   [Run test]   [Edit]   [History]                            │
├──────────────────────────────────────────────────────────────┤
│ ponytail  v1   coding   never run                            │
│   minimal-code policy — stdlib over custom                   │
└──────────────────────────────────────────────────────────────┘
```

- **List:** SkillCards grouped by category (research · engineering · create · growth). Category filter + search.
- **Detail:** description · version history (immutable `SkillVersion` rows, diff view) · args schema (JSONViewer) · recent test runs with receipts · enable/disable toggle.
- **Run test:** modal form generated from `argsSchema` → creates a real Task+Run (kind=task) → toast deep-links to the run workspace. Honest: a skill test IS a run — it appears in Runs, costs tokens, writes receipts.
- **Install starter pack** (first-run only): seeds the curated skills (deep-research, last30days, user-research, ponytail, tech-debt-audit, diagram-maker, slides-builder, humanizer, runbook-keeper) with one confirm: *"Install 9 starter skills? They are instructions + your existing tools — no new services."*
- **Empty state:** "No skills yet. Skills are versioned instruction packs that turn your agents into specialists — install the starter pack or create your first skill."

### 6.15 Schedules & Events (NEW — Automation group)

- **Schedules tab:** table — name · target (task/workflow link) · cron expression (mono) + human-readable ("Weekdays at 09:00 Europe/Berlin") · timezone chip · next-fire (live countdown) · last-fired · enabled toggle · row menu (Fire now / Edit / Delete). Create wizard: kind (one-time / recurring / event) → target picker → cron builder with tz picker (IANA, DST-correct preview of next 5 fires).
- **Events tab:** subscription list — topic · filter (JSONViewer inline) · target · enabled · recent deliveries table (event id mono, received at, dedupe status "duplicate skipped" chips when `externalId` replay was caught). Webhook setup card: endpoint URL + per-subscription secret (show-once pattern) + HMAC verification note + copy-curl example.
- **Empty states** point at the next real action ("Create a schedule to run your nightly research unattended").

### 6.16 Browser / Sandbox

- **Browser:** active sessions grid (live URL/title/screenshot via ScreenshotFrame), session history table, per-session action log (mono).
- **Sandbox:** session list + execution log (command, exit-code chip, stdout/stderr) + provider indicator: *"In-process worker — development isolation"* (honesty rule in copy). Media capability chip when ffmpeg available.

### 6.17 Memory

Scoped browser (scope filter tenant/agent/run + agent filter), hybrid semantic search box (vector + full-text fusion; results show relevance score faintly + match-type chip "semantic" / "keyword"), CRUD cards with content preview + created/updated. **Lessons section (napkin convention):** agent-scoped entries tagged `lessons` render in a curated, priority-sorted list with a cap indicator — the persistent-mistake-memory pattern, surfaced honestly as data.

### 6.18 Research (upgraded)

Projects list; run view:

- **ProtocolPhaseList** at top: phases with live status chips (decompose → search → browse → extract → sources → findings → verify → report). Protocol preset shown as a chip on the project (`deep-research` · `last30days` · `user-research` · `overnight`).
- **Sources table:** url · title · fetched at · **CredibilityBadge** (new) · content ref link. Credibility is a stored score with tooltip breakdown — never a vibe.
- **Findings list:** claim + verification checkmark (verified = green ✓, unverified = muted) + source citation chips.
- **Final artifact:** structured render (summary, sections, findings) + ArtifactViewer actions: **Copy as JSON · Copy as MD · Export slides · Open explainer page**.
- **Overnight runs** show a "ran unattended" chip with the reviewer-model name and its verdict summary.

### 6.19 Settings

Profile · Security (change password, active sessions list with revoke) · Provider key management (rotate) · Notification preferences (per-kind toggles mapped to `Notification.kind`) · **Danger zone** (red-bordered card; delete confirm uses type-to-confirm "delete").

---

## 7. Interaction design

### 7.1 Keyboard map

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl K` | Command palette (from anywhere) |
| `g d` dashboard · `g c` chat · `g a` agents · `g t` tasks · `g r` runs · `g i` inbox · `g s` skills · `g e` events/schedules | navigation (matching key within 2s; inactive while an input is focused) |
| `Esc` | Close drawer/modal/palette; second press clears selection |
| `↑ ↓ Enter` | Navigate + execute in palette, menus, lists |
| `Tab / Shift+Tab` | Roving focus through tabs and step wizards |

### 7.2 Notifications policy (bell vs toast — strict)

- **Toast** = transient feedback for *your own* actions + SSE events needing attention (run failed, run waiting approval). Max 3 stacked; errors persist until acted on.
- **Bell** = everything persisted, unread count badge; panel list with read/unread + "Mark all read"; each notification deep-links to the exact entity (`linkRoute`).
- Rule: if it's toast-only and the user misses it, that's a bug — attention events also land in the bell.

### 7.3 Destructive actions & undo

Delete (agent/goal/task/skill) → confirm modal naming the object ("Delete **Researcher**? Its 12 runs remain visible.") → soft delete → toast with **Undo** (6s window). Cancel run → inline confirm popover: "Cancel this run? Completed steps are kept."

---

## 8. Onboarding & first-run journey

The acceptance journey — *signup → add provider → create agent → create goal → create task → run → approve → verify → view receipt* — is the onboarding, made visible:

1. **Setup checklist card** (Dashboard right column) with progress ring; steps mirror the journey exactly. Each step links to its destination.
2. **Contextual hint banners** on each destination page while setup is incomplete (dismissible, one per page, real copy only): e.g., Models page: *"Add your first provider to start running agents."*
3. Checklist auto-completes from real state (no manual "mark done"); disappears when all steps satisfied or after 7 days.
4. **Starter skills are seeded server-side at signup** (no extra step) — the Skills page shows them ready; the checklist never asks the user to install anything.
5. No forced tour, no modals-on-load. The product teaches by being honest: empty states point at the next action.

---

## 9. State catalog (required on every page)

| State | Pattern |
|---|---|
| **Empty** | EmptyState (§4.7) with a real CTA into the next journey step. Never lorem cards |
| **Loading** | Skeletons shaped like the final layout; spinners only for <1s actions; no full-page loaders |
| **Live** | SSE patches in place (§5); running dots pulse; timers tick; "● Live" chip where applicable |
| **Error** | Inline field errors; panel ErrorState with code + Retry; global 5xx banner. `401` → login preserving return path. `409` → server message verbatim in toast |
| **Success** | Toast (transient) or signature beats: receipt card (§6.5), "Connected — N models found" (§6.10), replay video ready (§6.8) |

---

## 10. Accessibility (WCAG 2.1 AA)

- **Contrast:** all token pairings meet AA (§2.1 values). `--text-muted` never below body size.
- **Focus:** visible 2px `accent-400` ring on every interactive element; focus order = DOM order = visual order.
- **Status:** color + label + icon always (§4.4). Failed rows include an icon, not just red.
- **Screen readers:** `aria-live="polite"` announces run status changes ("Run *Summarize Q3* completed"); streaming announces on completion, never per-delta; toasts use `role="status"`/`role="alert"`.
- **Overlays:** focus trap + `aria-modal`; focus returns to trigger on close.
- **Forms:** labels always present; errors linked via `aria-describedby`; wizards show an error summary listing all failing fields on submit.
- **Tables:** captions + `scope="col"`; sortable headers announce sort state.
- **Motion:** `prefers-reduced-motion` → pulse becomes static dot, shimmer static blocks, drawers/modals fade only.
- **Targets:** ≥24px hit areas (desktop), 44px touch (mobile).

---

## 11. Motion system

| Token | Value | Use |
|---|---|---|
| `duration-fast` | 120ms | Hover, toggles, chip states |
| `duration-base` | 180ms | Dropdowns, toasts, collapses, modals |
| `duration-slow` | 260ms | Drawers, large panel swaps |
| `easing` | `cubic-bezier(0.2, 0, 0, 1)` | Everything — one easing, no bounces |

- **Pulse dot (running):** opacity `.4→1`, scale `.8→1`, 1.6s infinite — the signature "alive" signal; stops exactly at run end.
- **Streaming caret:** 1s blink at end of live text.
- **Shimmer skeleton:** gradient sweep, 1.8s linear infinite.
- **Running tool-call card:** accent→transparent border sweep, 1.4s loop.
- **Screenshot crossfade:** 200ms opacity per Browser update.
- **Receipt stamp (goal verified):** one-time fade-in + scale `1.02→1`, 300ms — never repeats.
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
| Expiry | "Expires in 4h 12m" → clock format under 60min |
| Running row | "Running · 2m 14s" |
| Failed row | "Failed" + error code caption + Retry |
| Provider connected | "Connected — 12 models found" |
| Key entry | "Key shown once — you can't see it again." |
| Sandbox indicator | "In-process worker — development isolation" |
| Delete confirm | "Delete **{name}? {consequence sentence}." |
| Undo toast | "{Name} deleted. [Undo]" |
| Skill test (new) | "Running skill creates a real run — it will appear in Runs and count against limits." |
| Starter pack (new) | "Install 9 starter skills? They are instructions + your existing tools — no new services." |
| Overnight digest (new) | "Overnight research finished — {n} sources, {m} verified claims, {k} awaiting approval." |
| Replay ready (new) | "Run replay is ready. {duration} of execution, start to finish." |
| Credibility tooltip (new) | "Scored from domain authority, corroboration across sources, and citation checks." |

**Rules:** durations and IDs in mono; relative time <7 days, absolute beyond; every button label is a verb ("Test connection", "Sync models" — never "Submit"); error messages state what happened + what to do next, with raw `error.code` one level deeper.

---

## 13. Anti-patterns (what this product never does)

- ❌ Gradient blobs, aurora backgrounds, glassmorphism
- ❌ Fake canvas graphs / node editors (workflows are a readable list; knowledge-graph artifacts are *real generated data*, not decoration)
- ❌ Lorem cards, placeholder avatars, fake sparklines
- ❌ Full-page spinners; spinners over 1 second anywhere
- ❌ Color-only status signals
- ❌ More than one accent color in any view; accent used as a status color
- ❌ `alert()`/`confirm()` dialogs
- ❌ Auto-scroll that fights the user
- ❌ Progress bars without a real denominator
- ❌ Confetti, bounces, or anything that animates layout
- ❌ (new) Fake "AI" badges on skills — a skill is instructions + tools, and the UI says so

---

## 14. Design QA & acceptance checklist

Run after Phase 13, before Phase 14:

- ☐ Contrast pass: every token pairing meets WCAG AA (§2.1)
- ☐ Full user journey (signup → … → view receipt) completable **keyboard-only**
- ☐ SSE kill test: kill a run mid-flight → UI reflects `failed` within 1s, no manual refresh
- ☐ Reconnect banner appears on SSE drop, auto-dismisses on resume; stale data dimmed
- ☐ No lorem/placeholder data anywhere; every number traces to a DB row (spot-check dashboard vs SQL)
- ☐ All five states present on all pages + auth (incl. new Skills, Schedules & Events)
- ☐ Command palette opens from any page via `⌘K`; covers navigation + top actions + skills
- ☐ Decision Inbox fully keyboard-usable; approvals work with optimistic update + SSE confirm
- ☐ Failed steps auto-expand in Timeline with the exact error visible
- ☐ No layout shift during streaming or SSE updates (height reserved)
- ☐ Every destructive action confirmed and undoable (soft delete + Undo toast)
- ☐ `prefers-reduced-motion` tested (static dots, no shimmer)
- ☐ Mobile 390px: Chat (with session rail collapsed), Dashboard summary, Decision Inbox fully usable
- ☐ Focus returns to trigger after every modal/drawer close
- ☐ Zero color-only status signals anywhere
- ☐ Setup checklist appears on fresh tenant, auto-completes from real state, disappears when done
- ☐ (new) Skill test-run creates a visible Run with receipts; Skills page empty → starter pack → installed states all designed
- ☐ (new) Research run shows credibility badges with tooltips and per-finding verification; artifact exports (JSON/MD/slides/explainer) all work
- ☐ (new) Run replay video: "Generate" → real job state (queued/running/done via SSE) → playable with step scrubber; never a fake preview
- ☐ (new) Overnight flow: schedule fires unattended → side effect parks (not fails) → morning digest deep-links inbox + run

---

## 15. Hermes cross-check — adoption map (what this spec added, and why)

| Inspiration | NEXS surface in this spec | Section |
|---|---|---|
| Deep Research (199-bio) | Research protocol preset; **CredibilityBadge** on sources; per-finding verification | §4.5, §6.18 |
| Last30Days | `last30days` research preset chip (recency window + platform sources) | §6.18 |
| User Research (cookiy) | `user-research` protocol preset | §6.18 |
| ARIS / Auto-Research-in-Sleep | **Unattended runs mode**: overnight parking policy, reviewer-model verdict, morning digest copy | §6.9, §6.18, §12, D8 |
| QMD Search | Hybrid search (vector + FTS) with match-type chips in Memory | §6.17 |
| FFmpeg Skill | **Run replay video** artifact + media capability chip | §4.8, §6.8, §12 |
| Fireworks Tech Graph / Graphify / Understand Anything | Diagram + knowledge-graph artifact types in ArtifactViewer; "real generated data" anti-pattern guard | §4.8, §6.8, §13 |
| Frontend Slides / Visual Explainer | Slides export + run explainer page artifacts | §4.8, §6.18 |
| Ponytail / Tech Debt Audit / Humanizer / Napkin / UI-UX Pro Max / Claude SEO | **Skills page** with starter pack (9 seeded skills incl. runbook-keeper lessons convention) | §6.14, §6.17, §8 |
| Agent-Reach | `reach` connector preset family in Connectors | §6.13 |
| Scroll World / Video Shotcraft | Deferred (P4) — creative media pipeline after replay video lands | — |

**Invariant preserved:** every one of these surfaces renders rows from the database (`Skill`, `ResearchSource.credibility`, `Artifact` refs, `ModelUsage`, `Notification`) — the two honesty rules still hold with all Hermes-inspired features added.
