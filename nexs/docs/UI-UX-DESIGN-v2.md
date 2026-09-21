# NEXS - UI/UX Design Specification v2 - Chat-first & Multi-surface

**Status:** the canonical UI/UX specification for `nexs/`. Supersedes `docs/UI-UX-DESIGN.md` sections 0-14 wherever they conflict.

> Rendered from `v2.md` at the workspace root. That file is unmodified. This rendering differs only mechanically: the process preamble is dropped, tab-separated tables are re-rendered as markdown tables, numbered section headings are promoted to `##`, list lines are bulleted, and ASCII box diagrams are fenced. All wording is `v2.md`'s own.

**Canonical colour tokens:** the Experience-Guide set (section 3 below). The second draft inside `docs/UI-UX-DESIGN.md` that used `#8B5CF6` / `#0B0B10` is **retired** - do not implement it.

**Where this stands in the build:** see `README.md`. Almost all of this document is frontend work (spec Phase 13, not started). The section-20 schema plus `Schedule.deliveryTarget`, `Approval.kind` and the `ChatSession` surface fields are already applied to the database.

Supersedes UI-UX-DESIGN.md §0–§14 where they conflict; extends the locked design system and stack (Vite + React + Tailwind 4 + shadcn/ui + TanStack Query + Zustand; SSE stays SSE; pg‑boss stays pg‑boss; Postgres/Prisma only). Saves to docs/UI-UX-DESIGN.md (v2). The two honesty rules still hold: every number traces to a DB row; only ModelGateway / MCPManager / FileService touch providers/MCP/disk.

## 0. Feature coverage — "all exact features," mapped
Every Hermes Agent + OpenClaw capability lands on a named NEXS v2 surface. Nothing is left as "later."

| # | Reference feature (product) | NEXS v2 location | Status |
|---|---|---|---|
| H1 | Chat‑first: the conversation is the interface (Hermes) | Chat = home route (§4); Dashboard demoted to a monitor (§12) | Upgraded |
| H2 | CLI + TUI + web all on one gateway (Hermes/OpenClaw) | Surfaces model — Web Control UI is the "Control UI"; CLI/TUI/mobile are paired Devices that hit the same API+EventBus (§5.4, §20) | New framing |
| H3 | Messaging gateway: Telegram, Discord, Slack, WhatsApp, Signal, Matrix, Mattermost, Email, SMS, iMessage, Teams… (Hermes 20+; OpenClaw list) | Channels page + per‑channel adapters (§5.1) | New |
| H4 | "Talk to it from Telegram while it's working on a cloud VM" — remote control mid‑run over a channel | In‑chat run status + /steer//queue//stop delivered to bound channels; in‑channel approvals (§4.3, §11) | New |
| H5 | Slash commands shared across every interface (one COMMAND_REGISTRY) | Commands page = single registry; composer menu, CLI/TUI autocomplete, and channel menus all render from it (§9) | New |
| H6 | Tool/command approval happens inside the chat channel (agent asks in chat) | ApprovalCard rendered inline in web chat and as native button‑messages on bound channels; same row resolves in Decision Inbox (§4.3, §11) | New |
| H7 | Browser tool — "cloud browser via Browser Use" | Existing Browser page (Playwright); copy option "Cloud browser (isolated context)" (§5.1 note) | Reuse + copy |
| H8 | Terminal / sandboxed exec | Existing Sandbox/Terminal page; exec approval variant for owner‑only commands (§11) | Reuse + upgrade |
| H9 | Skills, incl. skills created from experience (/refine) | Skills Hub (ClawHub‑style) + installed skills as dynamic /skill <name> commands (§7) | New |
| H10 | Memory | Existing Memory page (pgvector + keyword fallback) | Reuse |
| H11 | Cron scheduling with delivery to any platform | Schedules gain a delivery target (channel/account); output posted to that channel (§10) | Upgraded |
| H12 | Cross‑platform handoff (/handoff <platform>, transcript replays) | HandoffAction on any session → rebinds destination, replays role‑aware transcript (§4.5) | New |
| H13 | Mid‑run controls: /steer, /queue, /stop, /btw, /bg; persistent goals / heartbeats / loops | Composer affordances while a run is live; map to Runs + Schedules + Goals (§4.3, §10) | New framing |
| H14 | Personas / personalities (SOUL.md as a context file) | Persona tab → soul.md editor (SOUL/IDENTITY/USER) with voice test (§6) | New |
| H15 | Admin/user command split per platform (allow_admin_from, user_allowed_commands) | Channel config + Commands reference badges (§5.2, §9) | New |
| O1 | "On your own device, in your chat" — channels you already use + native apps (Discord, iMessage, Slack, Teams, Telegram, WhatsApp) | Channels (§5.1) + Devices incl. iOS/Android native apps (§5.4) | New |
| O2 | Gateway = local control plane for sessions, tools, events, channel connections | NEXS API+Worker is the gateway; EventBus/SSE hub is the fan‑out; §20 keeps it Postgres‑native | Framing |
| O3 | Control UI + CLI + TUI connect to the gateway | Surfaces model (§2, §5.4) | New framing |
| O4 | Command approval — "approve pairing requests" | Pairing page: DM access‑request queue, Approve/Dismiss, notify + make‑first‑owner (§5.3) | New |
| O5 | Tool approvals via allowlist; exec approval prompts | Existing approvalPolicy + tool allowlist; exec/command approval kind with allow‑once/always/deny (§11) | Upgraded |
| O6 | DM pairing (codes, 1h expiry, cap 3/account, open/allowlist/pairing policies) | Pairing page + per‑channel DM policy selector (§5.1, §5.3) | New |
| O7 | Node/device pairing (Full/Limited access, setup code/QR, scopes operator.*, trusted‑CIDR auto‑approve)* | Devices page: pair, setup‑code modal, pending queue, scope chips (§5.4)* | New |
| O8* | SOUL.md persona (+ IDENTITY.md, USER.md) — "an actual voice, not generic assistant sludge"* | soul.md editor (§6)* | New |
| O9* | Skills via ClawHub (versioned SKILL.md packs)* | Skills Hub install flow, versioned (§7)* | New |
| O10* | Plugins (bundled + external; A2A JSON‑RPC, device‑pair, channel plugins)* | Plugins page; a plugin can add channels + support pairing (§8)* | New |
| O11* | Multi‑agent routing / bindings (channel/account/peer → agent)* | Bindings page (§5.5)* | New |
| O12* | Owner (commands.ownerAllowFrom) — privileged commands + exec approvals* | Owner identity in Settings; gates owner‑only commands + exec approvals (§5.6, §11)* | New |

## 1. Design principles (v1's seven rules, plus two)
- [ ] Live first. Every execution‑state page is SSE‑driven; nothing needs a manual refresh.
- [ ] Honest rendering. Real data or nothing; hidden panels instead of faked ones.
- [ ] Density with breathing room. Compact 40px rows; 24–32px air between sections.
- [ ] Keyboard‑first power path. ⌘K, g‑keys, Esc; fully usable without a mouse.
- [ ] Status = color + label + icon, never color alone.
- [ ] One accent, four status colors — nothing else.
- [ ] Every state is designed: empty / loading / live / error / success.
- [ ] Chat‑first (new). The conversation is the interface; the dashboard is a monitor, not the home. A static NEXS opens on a moving chat, not a grid of cards.
- [ ] Approvals & pairing meet you where you are (new). An approval or a pairing request is actionable in web chat, on the bound channel(s), and the Control UI — never trapped in one surface.
- [ ] Positioning line: NEXS is mission control for agents that live in your chat — it should feel like a live instrument panel you can also drive from Telegram.
- [ ] 
## 2. Information architecture & navigation
- [ ] 2.1 Shell (updated)
```
┌───────────────────────────────────────────────────────────────┐
│ ⌘K search        [● Live · web + telegram]        🔔(3)   👤   │ topbar 52px, sticky
```
- [ ] ├──────────────┬────────────────────────────────────────────────┤
- [ ] │ sidebar 240  │  content (max‑w 1440, px 24/32)                │
- [ ] │ ──────────── │                                                │
- [ ] │ ◆ Chat       │   ← HOME (default redirect from /)             │
- [ ] │ ▸ Channels   │   NEW: messaging channels + pairing + devices  │
- [ ] │ ▸ Skills     │   NEW: hub + installed                         │
- [ ] │   Plugins    │   NEW                                          │
- [ ] │   Commands   │   NEW: unified slash registry                  │
- [ ] │ ──────────── │                                                │
- [ ] │ Agents       │   (adds Persona/soul.md tab)                   │
- [ ] │ Goals        │                                                │
- [ ] │ Tasks        │                                                │
- [ ] │ Workflows    │                                                │
- [ ] │ Runs         │   Agent Workspace (unchanged, flagship detail) │
- [ ] │ ⚠ Decisions  │   approvals anywhere + exec approvals          │
- [ ] │ Schedules    │   delivery‑to‑channel                          │
- [ ] │ ──────────── │                                                │
- [ ] │ Models Tools │                                                │
- [ ] │ MCP Conn     │                                                │
- [ ] │ Browser Sand │                                                │
- [ ] │ Memory Res   │                                                │
- [ ] │ Pulse        │   (was Dashboard — now a monitor)              │
- [ ] │ Settings     │   owner · security · prefs · danger            │
- [ ] └──────────────┴────────────────────────────────────────────────┘
- [ ] 
- [ ] 
- [ ] Sidebar groups: Converse (Chat) · Surfaces (Channels, Skills, Plugins, Commands) · Build (Agents, Goals, Tasks, Workflows, Runs, Decisions, Schedules) · System (Models, Tools, MCP, Connectors, Browser, Sandbox, Memory, Research, Pulse, Settings). Pending Decisions renders an amber pill on its row; pending pairing/device requests render a waiting pill on the Channels row.
- [ ] 
- [ ] 2.2 Routes (updated)
- [ ] /login /signup
- [ ] /chat                      # HOME
- [ ] /channels                  /channels/:id           # channel detail: policies, allowlists, cmd split, delivery
- [ ] /pairing                   # DM access‑request queue (Settings → Channels → DM access requests)
- [ ] /devices                   # node/device pairing + paired clients + scopes
- [ ] /bindings                  # multi‑agent routing (channel/account/peer → agent)
- [ ] /skills                    /skills/:id             # hub + installed
- [ ] /plugins                   /plugins/:id
- [ ] /commands                  # unified slash registry reference
- [ ] /agents                    /agents/:id             # tabs incl. Persona (soul.md)
- [ ] /goals  /tasks  /workflows /runs                   # unchanged
- [ ] /runs/:id                  # Agent Workspace (9 tabs, live via SSE) — unchanged
- [ ] /approvals                 # Decision Inbox: approvals anywhere + exec approvals
- [ ] /schedules                 # delivery target per schedule
- [ ] /models /tools /mcp /connectors /browser /sandbox /memory /research
- [ ] /pulse                     # monitor (was /dashboard)
- [ ] /settings                  # owner · security · keys · notifications · danger zone
- [ ] 
- [ ] 
- [ ] 2.3 The Surfaces strip (new, persistent)
- [ ] A slim live indicator under the topbar (and in the Chat header): connected surfaces as mono glyphs with status dots — web ● telegram ● discord ○(stale) ios ● — plus active cross‑surface sessions ("Researcher · running on web + telegram"). Data source: Channel.status, Device.status, live Run rows. It's the visual proof that "one gateway, many surfaces" is real.
- [ ] 
## 3. Design system (canonical tokens)
- [ ] v2 consolidates your two conflicting drafts into one source of truth — the Experience‑Guide token set (it carries the full chip pattern + contrast ratios). The second draft's #8B5CF6 / #0B0B10 values are retired.
- [ ] 
- [ ] css
- [ ] /* Surfaces */ --bg #0B0C10 · --surface-1 #101218 · --surface-2 #151820 · --surface-3 #1B1F29
- [ ]               --border #262B36 · --border-subtle #1D222C
- [ ] /* Text */     --text-primary #EDEFF4 · --text-secondary #A6ADB9 · --text-muted #78808F (body size only)
- [ ] /* Accent */   300 #A78BFF · 400 #8F72FF · 500 #7C5CFC · 600 #6641EC (white text on 600 = AA)
- [ ] /* Status chips: 12% bg + 300‑level text */
- [ ]    ok/success --success #34D399 → bg rgba(52,211,153,.12) text #6EE7B7
- [ ]    waiting    --waiting #FBBF24 → bg rgba(251,191,36,.12)  text #FCD34D
- [ ]    failed     --failed  #F87171 → bg rgba(248,113,113,.12) text #FCA5A5
- [ ]    running    --running #60A5FA → bg rgba(96,165,250,.12) text #93C5FD
- [ ] 
- [ ] 
- [ ] Fonts: Inter (variable) 400/500/600 for UI; JetBrains Mono for every machine string — JSON, IDs, args, results, URLs, timestamps, model names, durations, countdowns, setup codes. This one rule is what reads as "serious tooling."
- [ ] Radii: controls 8 · cards 12 · chips/pills 999. Elevation = surface steps + borders; real shadows only for overlays (0 8px 32px rgba(0,0,0,.6)).
- [ ] Motion: 120/180/260ms, cubic-bezier(0.2,0,0,1). Pulse dot (running) opacity .4→1 scale .8→1 1.6s; streaming caret 1s blink; shimmer 1.8s. Never animate layout; reserve height on SSE/streaming updates. prefers-reduced-motion collapses pulse→static, shimmer→static blocks, slide→fade.
- [ ] New semantic additions (no new hues):
- [ ] Surface status reuses the four colors: connected=ok, live/active=running, stale/reconnecting=waiting, disconnected/error=failed.
- [ ] Pairing / pending‑approval = waiting (amber). Device "Limited access" = a neutral capability chip, not a status color.
- [ ] Channel brand glyphs render monochrome (Lucide‑style outline at 16/18px) so the one‑accent rule survives; the channel's real brand color is allowed only inside the glyph at ≤40% as a subtle tint on hover. Every glyph carries aria-label + tooltip.
## 4. Chat (home, upgraded) — the flagship
- [ ] Layout unchanged from v1 (full‑height, message column max 760 centered, composer pinned). What changes:
- [ ] 
- [ ] 4.1 Surface context chip
- [ ] Header shows where this conversation is live: ● web · telegram + a Handoff action (§4.5). If the session was started on a channel and you're in the Control UI, it reads "Started on Telegram · DM you."
- [ ] 
- [ ] 4.2 Composer (v1 + mid‑run controls)
- [ ] Auto‑size textarea (max 8 rows), ↵ send / ⇧↵ newline; / slash menu (§9); @ registry mentions (+ channel/agent for routing); attachment/folder picker with permission badges. While a run is live, the composer exposes Hermes' mid‑run controls as ghost chips: /steer <note> (arrives after next tool call, no interrupt), /queue <prompt>, /stop. Send becomes Stop (square) while streaming.
- [ ] 
- [ ] 4.3 ApprovalCard — approvals in the conversation (the signature new interaction)
- [ ] When an agent needs approval, it posts an inline card in this chat and pushes a native button‑message to every bound channel:
- [ ] 
```
┌───────────────────────────────────────────────┐
│ [high]  Researcher wants to run http_request   │
```
- [ ] │         GET https://api.example.com/checkout   │
- [ ] │         reason: "step 3 of plan — place order" │
- [ ] │         perms: network_external · side_effect  │
- [ ] │         expires in 14m 02s        [▾ action JSON]│
- [ ] │        [ Approve ]  [ Reject ]                  │
- [ ] └───────────────────────────────────────────────┘
- [ ] 
- [ ] 
- [ ] RiskBadge (low=ok outline, medium=waiting outline, high=failed outline+dot) · plain‑language "what will happen" · requested‑action JSON collapsed (JSONViewer) · permission chips · expiry Countdown (amber <1h, red <10min) · Approve / Reject inline.
- [ ] Optimistic: click → card settles to Approved by you · 09:41 instantly; SSE approval.resolved confirms or reverts with a failed note. The same row in the Decision Inbox and on the channel update from the same event — one decision, every surface.
- [ ] On a channel, Approve/Reject are native inline buttons (Telegram/Discord/Slack) that call the same POST /api/approvals/:id/approve|reject; no web session required. This is H6/O4 made real.
- [ ] 4.4 Exec/command approval variant
- [ ] For owner‑only commands (OpenClaw exec approval): card reads Operator wants to run: \npm test`` with Allow once / Allow always / Deny. "Allow always" writes a tool allowlist rule; only the configured owner (§5.6) can grant it.
- [ ] 
- [ ] 4.5 Handoff
- [ ] Any session row + header has Send to [channel] → /handoff <platform>: gateway rebinds the destination, creates a thread where supported (Telegram topics, Discord threads, Slack/Matrix anchored), replays the role‑aware transcript, and forges a synthetic confirmation turn. In the Control UI the source session shows "Handed off to Telegram · resume anytime."
- [ ] 
- [ ] 4.6 Scheduled‑delivery receipts
- [ ] When a schedule fires (§10) and delivers to a channel, the chat that owns it shows a delivery receipt line: ↗ Delivered to Telegram · DM you · 09:00 linking into the run. Absence of rows = no fake activity.
- [ ] 
- [ ] Empty state: "Ask, or type /help" + 3 runnable example chips referencing agents that actually exist (else CTA Create your first agent).
- [ ] 
## 5. Channels & Surfaces (NEW domain) — where all the multi‑surface features live
- [ ] This is NEXS's biggest addition and the direct port of Hermes' gateway + OpenClaw's pairing/devices/bindings.
- [ ] 
- [ ] 5.1 Channels page
- [ ] Grid of ChannelCards — one per supported channel: Telegram, Discord, Slack, WhatsApp, iMessage, Teams, Signal, Matrix, Mattermost, Email, SMS, Google Chat, … (+ any plugin‑added channels). Card: mono brand glyph · status dot (connected/live/stale/disconnected/error) · account(s) · DM policy badge (open / allowlist / pairing) · group policy · last message relative time · routing → agent (binding). Actions: Connect (per‑channel flow — Telegram/Discord bot token, WhatsApp QR login, Slack OAuth, iMessage/macOS bridge), Configure, Test send.
- [ ] 
- [ ] Copy note for the browser tool surface: Browser page header may read "Cloud browser — isolated context per session" to match Hermes' "cloud browser via Browser Use" while staying honest about Playwright.
- [ ] 
- [ ] 5.2 Channel detail
- [ ] Accounts (multi‑account channels, e.g. WhatsApp QR‑linked accounts).
- [ ] DM policy segmented control: open (only if allowlist includes *) · allowlist · pairing. Group policy + groupAllowFrom / per‑group & per‑topic overrides.
- [ ] Allowlist editor with access groups (accessGroups, type: "message.senders", referenced as accessGroup:<name>) so one trusted set spans channels and DM+group lists.
- [ ] Slash‑command split (H15): allow_admin_from + user_allowed_commands (and per‑group equivalents). Admins get every command; regular users get the listed floor (/help, /whoami always). Unset = unrestricted backward‑compat, surfaced with a hint.
- [ ] Delivery defaults: default reply routing + voice‑message toggle.
- [ ] 5.3 Pairing page (Settings → Channels → DM access requests) — O4/O6 exactly
- [ ] Queue of pending DM pairing requests across all pairing‑policy channel accounts. PairingRequestRow: channel/account glyph · sender ID + metadata · 8‑char code (mono, no ambiguous chars) · expiry countdown (1h) · cap indicator (max 3 pending/account). Filter by channel/account.
- [ ] 
- [ ] Approve dialog: Notify the requester after approval (checkbox) + Make this sender the first command owner (shown only when no owner exists and session has operator.admin). Approving grants DM access only (not group).
- [ ] Dismiss removes without blocking (sender can re‑request).
- [ ] CLI parity: nexs pairing list <channel> / nexs pairing approve <channel> <CODE> --notify — the UI and CLI mutate the same rows.
- [ ] 5.4 Devices page (node/device pairing) — O1/O7 exactly
- [ ] Paired nodes/devices: Web Control UI, iOS app, Android app, macOS, CLI, TUI, headless.
- [ ] 
- [ ] Pair device → choose Full access (recommended) or Limited access (omits operator.admin) → Create setup code → modal with QR + copyable base64 setup code (contains gateway URL/urls + single‑use bootstrap token, 10‑min expiry). Accessible: the code is selectable text, not image‑only.
- [ ] Pending approval queue: role + requested scopes; approve/reject. Re‑request with broader scopes creates a fresh pending upgrade request (never silently widens).
- [ ] Scope chips per device: operator.admin · operator.approvals · operator.read · operator.write · operator.talk.secrets.
- [ ] Trusted‑CIDR auto‑approve config for tightly‑controlled node networks (opt‑in, fresh no‑scope role: node only).
- [ ] Telegram /pair flow supported when the device‑pair plugin is enabled (§8).
- [ ] 5.5 Bindings page (multi‑agent routing) — O11
- [ ] Route table: channel / account / peer → agent. "One account per agent on your preferred channels." Each row editable; Test routing sends a probe and shows which agent answers. This is what lets one gateway host many agents, each with its own channels (and its own soul.md, §6).
- [ ] 
- [ ] 5.6 Owner
- [ ] The command owner / operator.admin identity (from first pairing bootstrap or set in Settings). Gates: privileged/owner‑only slash commands, exec approvals (§4.4), device "Full access." Shown in Settings → Security; ownership does not grant chat access (channel/group rules still apply) — stated in copy.
- [ ] 
## 6. Agents (upgraded) — soul.md persona · H14/O8
- [ ] Keep v1 list / create wizard / detail tabs. Add a Persona tab (and surface it in Overview):
- [ ] 
- [ ] soul.md editor: markdown editor + live preview, token estimate, and a "Test the voice" button that sends a probe prompt through ModelGateway and shows the agent's reply in its voice. Plain‑language header: "This is your agent's voice — not generic assistant sludge."
- [ ] Sub‑docs: SOUL.md (personality/tone/boundaries), IDENTITY.md (name/role/avatar), USER.md (who it serves). All are context files loaded in priority order; the editor shows each file's token cost and whether it was loaded/truncated/shadowed (mirrors Hermes /context "why is my file ignored?").
- [ ] soul.md is part of the immutable AgentVersion snapshot — a run pins the version at start, so editing mid‑run doesn't change behavior.
- [ ] Approval policy + exec‑approval toggle (owner‑only commands require approval) live here alongside capability toggles (browser/sandbox/memory).
## 7. Skills Hub (NEW) — ClawHub‑style · H9/O9
- [ ] Two tabs: Installed / Hub.
- [ ] 
- [ ] Installed: SkillCard — name · version · description · source (hub/local) · enabled toggle · "exposed as /skill <name>" chip · last used. Edit args schema; uninstall (soft).
- [ ] Hub: search/browse the registry (ClawHub / skills.sh‑compatible SKILL.md packs). Detail = readme, version list, args schema, Install → toast + SSE skill.installed → creates a local Skill row pinned to that version.
- [ ] Skills are dynamic slash commands on every surface. The unified COMMAND_REGISTRY (§9) merges built‑ins + installed skills. Name‑collision rule (verbatim from Hermes): a skill whose name matches a built‑in never gets its own /<name> — the built‑in wins and the skill stays loadable via /skill <name>; the palette marks it "slash command unavailable — name taken by built‑in."
- [ ] Maps to existing Skill/SkillVersion models + a read‑only hub catalog cache (§20).
## 8. Plugins (NEW) · O10
- [ ] Plugins page: bundled + external plugins — channels, A2A JSON‑RPC, device‑pair, transport/capability plugins. PluginCard: name · kind · version · enabled toggle · status · Configure. Install from registry / enable‑disable. A plugin can add new channels (which then appear on the Channels page) and support DM pairing if it implements the pairing API — stated in its card. This is what keeps the channel list open rather than hard‑coded.
- [ ] 
## 9. Commands reference (NEW) — unified slash registry · H5/H15
- [ ] The single source of truth for COMMAND_REGISTRY, grouped Session / Create / Control / System / Skills. Each row: command · one‑line description · args hint (mono) · surface availability (web/CLI/TUI/channel glyphs) · admin‑only badge.
- [ ] 
- [ ] The composer's slash menu, CLI/TUI autocomplete, and every channel's platform menu all render from this one registry — that is "slash commands shared across interfaces." The admin/user split per channel (§5.2) is documented here with the exact config keys. Representative set (built‑ins map to real NEXS services; no canned listings): /help /status /models /agents /goals /runs /tools /mcp /skills · /agent /goal /run /schedule /research /browser /connect · /approve /reject /stop /pause /resume · /new /clear /history /save /retry /undo /title /compress /rollback /diff /snapshot · /steer /queue /btw /bg /branch /handoff · /goal status|pause|resume|clear · /heartbeat /loop /refine /review /moa · /context /egress /config · + installed /skill <name>.
- [ ] 
## 10. Schedules (upgraded) — delivery to a platform · H11
- [ ] Keep v1 (cron/one‑time/recurring, pg‑boss, IANA timezone, nextFireAt in UTC, enable/disable). Add a delivery target to every schedule: "Deliver results to → [channel / account]" (e.g. Telegram → DM you, or Discord → #ops). The scheduled run's output is posted to that channel as a message with a link back into NEXS; the owning chat shows the delivery receipt (§4.6). Copy distinguishes durable schedules (pg‑boss, survive restart) from Hermes' session‑scoped /heartbeat and /loop (in‑session, in‑process).
- [ ] 
## 11. Decision Inbox (upgraded) — approvals anywhere · H6/O4/O5
- [ ] Keep v1 Pending/Decided + drawer. Add:
- [ ] 
- [ ] Source chip per approval: the surface it was requested from / delivered to (web chat · Telegram · Discord…).
- [ ] Exec/command approvals as a distinct kind (§4.4) with allow‑once/always/deny.
- [ ] Approving here resolves the in‑chat card and the channel message from the same SSE approval.resolved. Optimistic update + SSE confirm unchanged; on mismatch, revert with a failed note.
- [ ] The ApprovalCard component is shared across Chat (web), this drawer, and native channel button‑messages — one decision, every surface.
## 12. Pulse (repositioned) — was Dashboard · H1
- [ ] No longer the home; it's a monitor. Keep v1 layout (active runs, recent failures, provider health, usage‑only‑if‑rows‑exist). Add:
- [ ] 
- [ ] Surfaces status panel: which channels/devices are live (from Channel.status / Device.status).
- [ ] Pairing / device pending counts linking to their queues.
- [ ] Cross‑surface activity feed: run/step/approval events over SSE, each tagged with its surface glyph ("Researcher · step 3 · via telegram").
## 13. New component specs (each ships the full state matrix: default/hover/focus/active/disabled/loading/error)
- [ ] 
- [ ] 
- [ ] 
| Component | Spec |
|---|---|
| ApprovalCard | In‑chat + drawer + channel‑native variant. RiskBadge · plain‑language action · collapsible JSONViewer · permission chips · Countdown · Approve/Reject (exec: Allow once/always/Deny). Optimistic; settle on SSE. Focusable, keyboard‑operable; aria-live announces resolution. |
| PairingRequestRow + dialog | Channel/account glyph · sender ID+metadata · mono code · 1h expiry countdown · cap indicator. Approve (notify / make‑first‑owner) · Dismiss. |
| DevicePairCard + setup‑code modal | Full/Limited access · Create setup code → QR + selectable base64 code (10‑min expiry, accessible text). Pending queue with role+scopes; scope chips (operator.*). |
| ChannelCard / policy controls | Mono brand glyph · status dot · account(s) · DM/group policy segmented control · allowlist editor + access‑group picker · cmd admin/user split · delivery defaults. |
| BindingRow | channel/account/peer → agent; editable; Test routing probe. |
| SoulEditor | markdown + live preview + token estimate + per‑file load state (loaded/truncated/shadowed) + Test the voice (probe via gateway). Part of AgentVersion. |
| SkillCard* | Installed + hub variants · version · source · enabled toggle · /skill <name> chip · Install (hub) → toast + SSE. |
| PluginCard* | name · kind · version · enabled · status · Configure; note "may add channels / support pairing." |
| SlashMenu | Unified registry; grouped; surface‑availability glyphs; admin badge; Skills section; fuzzy; ↑↓↵; skills marked if name taken by built‑in. |
| ScheduleDeliveryPicker* | channel/account target for scheduled output; "deliver to" affordance on every schedule. |
| SurfaceStatusStrip* | Persistent live connected surfaces + active cross‑surface sessions (mono glyphs + status dots). |
| HandoffAction | "Send to [channel]" on session row/header; shows rebind + transcript‑replay confirmation. |
## 14. Motion & micro‑interactions (extend v1*
- [ ] Add: approval card resolve crossfade (200ms, icon+tint); channel connect pulse (one‑time ok dot); pairing/device expiry countdown color shift (amber→red); setup‑code reveal (fade, no bounce); skill install toast + row insert (fade+translate‑y 4px, 200ms); in‑channel approval button press → instant settle. Durations only {120/160/200/300ms}; cubic-bezier(0.2,0,0,1*; respect prefers-reduced-motion.
- [ ] 
## 15. Keyboard map (extend v1)
- [ ] Keep ⌘K, g d/c/a/t/r/i, Esc. Add: g h Channels · g p Pairing/Devices · g s Skills · g m Memory. Shortcuts inactive while an input is focused; palette + lists fully arrow‑key navigable.
- [ ] 
## 16. States catalog (add surfaces)
- [ ] channel connecting / live / stale / disconnected; pairing pending (waiting); device pending approval; skill installing; soul editor voice‑testing. Every new page implements empty/loading/live/error/success with real data only.
- [ ] 
## 17. Accessibility (extend v1, WCAG 2.1 AA)
- [ ] In‑channel ApprovalCards focusable + keyboard‑operable; QR/setup‑code has a selectable text alternative; every channel glyph has aria-label+tooltip; countdowns announce on expiry via aria-live="polite"; status never color‑only; focus returns to trigger after every modal/drawer; ≥24px (desktop) / 44px (touch) targets.
- [ ] 
## 18. Voice & microcopy (add)
- [ ] Channel connect: "Connect Telegram — paste your bot token." / on success "Connected — Telegram live."
- [ ] Pairing: "Approve this person? They'll be able to DM your agent." · "Code expires in 58m."
- [ ] Device: "Full access (recommended)" / "Limited access." · "Setup code expires in 10m. Treat it like a password."
- [ ] Soul editor: "This is your agent's voice — not generic assistant sludge."
- [ ] Skills: "Install 'deploy' v2.3?" · "Now available as /skill deploy on every surface."
- [ ] Delivery: "Deliver results to → Telegram · DM you."
## 19. Anti‑patterns (extend v1)
- [ ] ❌ Dashboard as the home · ❌ approvals/pairing trapped in web‑only · ❌ channel brand colors used as accents (mono glyphs only) · ❌ faking a "connected" surface · ❌ image‑only QR/setup codes · ❌ one command list per surface.
- [ ] 
## 20. Schema additions (buildable inside the locked stack — no new DBs; SSE stays SSE; pg‑boss stays pg‑oss→pg‑boss)
- [ ] Additive Prisma models/fields, all tenantId‑scoped, repositories take tenantId first:
- [ ] 
- [ ] Channel { type, name, status(unverified|healthy|degraded|error|disconnected), dmPolicy(open|allowlist|pairing), groupPolicy, deliveryDefault, voiceEnabled, metadata } + ChannelAccount { channelType, label, credentialId→Credential, allowFrom String[], groupAllowFrom String[] }.
- [ ] AccessGroup { name, type="message.senders", members Json } (referenced as accessGroup:<name>).
- [ ] PairingRequest { channelType, accountId, senderId, code(8), metadata, status(pending|approved|dismissed|expired), expiresAt, notifyOnApprove, madeOwner } — cap 3 pending/account enforced in service.
- [ ] Device { role(node|operator|browser|webchat), name, access(full|limited), scopes String[], publicKey?, status(pending|paired|revoked), lastSeenAt } + DeviceToken { deviceId, tokenHash, scopes, expiresAt, revokedAt } (bootstrap tokens single‑use, 10‑min).
- [ ] Binding { channelType?, accountId?, peerId?, agentId } (route match, most‑specific wins).
- [ ] Plugin { kind(channel|transport|capability), name, version, enabled, status, metadata }.
- [ ] SkillHubEntry { slug, latestVersion, readme, sourceUrl, cachedAt } (read‑only catalog cache; install creates a local Skill/SkillVersion).
- [ ] Schedule.deliveryTarget Json? → { channelType, accountId?, peerRef? }; on fire, post output to that channel + write delivery receipt.
- [ ] Exec approval: reuse Approval with kind: 'exec' + requestedAction { command, args, cwd } + decision options (once/always/deny); "always" writes a tool allowlist rule. Owner = the operator.admin device/user identity.
- [ ] The gateway is unchanged in substance: NEXS API + Worker is the local control plane; EventBus (InMemoryBus dev / PgNotifyBus prod) is the fan‑out to SSE; channels/devices are clients of that same API+stream. This keeps O2 true without new infra.
- [ ] 
## 21. Design QA & acceptance checklist (extend v1 §14)
- [ ] Full journey over a real channel: pair a Telegram DM → chat with the agent from Telegram while a run executes on the "cloud VM" → an approval is posted in‑chat and as a Telegram button message → Approve from Telegram → run resumes; the same row settles in web Decision Inbox.
- [ ] Approval requested in web chat is approvable from a bound channel and vice‑versa (one decision, every surface).
- [ ] DM pairing end‑to‑end: unknown sender gets an 8‑char code (1h expiry, cap 3/account) → Approve with notify + make first owner → sender can now DM; Dismiss path works.
- [ ] Device pairing: Pair device → Full/Limited → setup code/QR → approve pending request with correct scopes; re‑request for broader scopes creates a fresh pending (no silent widening).
- [ ] soul.md Test the voice returns an in‑voice reply via ModelGateway; editing mid‑run doesn't change a pinned run.
- [ ] Skill installed from Hub appears as /skill <name> in web composer, CLI/TUI autocomplete, and channel menus; name‑collision rule enforced.
- [ ] Schedule with a delivery target posts its output to the bound channel + shows a delivery receipt in chat.
- [ ] Handoff: session handed off to Telegram replays the role‑aware transcript and confirms in the new place.
- [ ] All v1 checks still pass (keyboard‑only journey, SSE kill test, reconnect banner, no lorem, five states on all pages, prefers-reduced-motion, 390px mobile for Chat/Decisions/Pulse).
## 22. The "wow" moments (updated)
- [ ] The running dot pulses — and stops the second the run finishes, on every surface at once.
- [ ] Streaming answers with a live caret; tool calls collapse inline as they happen.
- [ ] ⌘K palette with fuzzy results from real registry data + real actions.
- [ ] An approval arrives in Telegram while you're on your phone — one tap, the run resumes. (new)
- [ ] The Surfaces strip lights up as channels/devices connect — one gateway, many live endpoints. (new)
- [ ] soul.md "Test the voice" — type a probe, get back an answer in your agent's voice. (new)
- [ ] Approval countdowns turn amber under 1h, red under 10m — urgency without pressure.
- [ ] The receipt moment: goal completion shows a verification summary + View receipt — proof, not confetti.
- [ ] Browser tab live screenshot crossfading as the agent navigates.
- [ ] Failed steps auto‑expand with the exact error; optimistic Approve/Reject everywhere.