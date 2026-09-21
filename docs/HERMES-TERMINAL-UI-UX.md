# Hermes Agent — Terminal UI/UX Complete Architecture & Design Specification

> **Deep-dive architectural analysis of Nous Research's Hermes Agent terminal user interface (`--cli` and `--tui`).**  
> Covers interface geometry, visual anatomy, ASCII layout wireframes, Bots & Personas, Session lifecycle, Capabilities & Tool execution, Schedulers & Cron routines, slash commands, keybindings, and terminal ergonomics.

---

## 1. Terminal UI/UX Overview & Architecture

Hermes Agent delivers a specialized terminal-first experience for operators who spend their working days inside shells, terminal multiplexers (`tmux`, `zellij`), and SSH environments. It is not an afterthought text REPL; it is an interactive Terminal User Interface (TUI) with rich modal overlays, mouse interactivity, non-blocking composition, and background subagent monitoring.

### 1.1 The Dual-Mode Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                          USER TERMINAL                                 │
│        (xterm-256color / truecolor / Ghostty / iTerm2 / Alacritty)     │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
                 ┌───────────────────┴───────────────────┐
                 ▼                                       ▼
  ┌──────────────────────────────┐       ┌───────────────────────────────┐
  │      Classic CLI Mode        │       │       Modern TUI Mode         │
  │      (`hermes --cli`)        │       │       (`hermes --tui`)        │
  │                              │       │                               │
  │ • Python readline / Prompt   │       │ • Ink (React for terminals)   │
  │   Toolkit REPL               │       │ • TypeScript/Node.js frontend │
  │ • Inline streaming output    │       │ • Alternate-screen buffer     │
  │ • Inline slash autocomplete  │       │ • Floating modal overlays     │
  │ • Minimal dependencies       │       │ • Mouse selection & scroll    │
  └──────────────┬───────────────┘       └───────────────┬───────────────┘
                 │                                       │
                 │ JSON-RPC 2.0 (IPC / stdio pipes)      │
                 └───────────────────┬───────────────────┘
                                     ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │                 Hermes Python Runtime Backend                        │
  │                                                                      │
  │ • Central COMMAND_REGISTRY (`hermes_cli/commands.py`)                │
  │ • Agent Loop & Subagent Delegation Engine                            │
  │ • Model Gateway (OpenRouter, Anthropic, Nous Portal, Local)          │
  │ • Tool Calling Engine, Native Tools & MCP Server Manager             │
  │ • Session Persistence (SQLite under `~/.hermes/`)                     │
  │ • Gateway Cron Daemon (`~/.hermes/cron/jobs.json`)                   │
  └──────────────────────────────────────────────────────────────────────┘
```

### 1.2 Execution Paradigms

1. **Launch Flags & Environment Controls:**
   * `hermes` (default interactive session)
   * `hermes --tui` (launches modern React/Ink TUI)
   * `hermes --cli` (forces classic prompt-toolkit REPL)
   * `hermes -c` / `hermes --continue` / `hermes --resume latest` (resumes most recent session)
   * `hermes -r <session_id>` (resumes specific session by UUID or slug)
   * `hermes -p <profile>` (launches with dedicated Bot profile)
   * `hermes -w` (launches inside an isolated ephemeral git worktree)
   * `export HERMES_TUI=1` or `~/.hermes/config.yaml` (`display.interface: tui`)
2. **Alternate-Screen Rendering:**
   * Uses terminal alternate screen buffer (`smcup`/`rmcup`).
   * When exiting the TUI, the terminal viewport is restored cleanly with zero scrollback pollution.
3. **Non-Blocking Composition:**
   * The input composer renders instantly on the first frame before the backend completes initialization.
   * Prompts can be typed and queued immediately while models and MCP servers connect in the background.

---

## 2. Terminal Layout & Visual Anatomy (ASCII Wireframe)

### 2.1 Full-Screen Terminal Layout

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│  ☤ HERMES AGENT v0.9.4  [Profile: Default]  [Dir: ~/projects/agent-core]               │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  Model: anthropic/claude-sonnet-4  │  Provider: Nous Portal  │  Backend: PTY           │
│                                                                                        │
│  ▾ Tools (5 active)                                                                    │
│    • bash (terminal execution)        • file_read (disk read)                          │
│    • file_write (disk write)          • web_search (searxng/brave)                     │
│    • browser (playwright headless)                                                     │
│                                                                                        │
│  ▸ Skills (12 installed - collapsed, click or Enter to expand)                         │
│  ▸ System Prompt (Custom SOUL active - collapsed)                                      │
│  ▸ MCP Servers (3 connected: github, postgres, filesystem - collapsed)                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                        │
│  User: @researcher audit the authentication logic in src/auth/jwt.ts                  │
│                                                                                        │
│  Hermes:                                                                               │
│  I will inspect the JWT implementation, verify signature verification, and check       │
│  for token family rotation handling.                                                   │
│                                                                                        │
│  ┌─ ⚙ bash · npm test test/auth.test.ts ───────────────────────── [0.8s] [✓] ┐        │
│  │ > auth@0.1.0 test                                                         │        │
│  │ > vitest run test/auth.test.ts                                            │        │
│  │                                                                           │        │
│  │ ✓ test/auth.test.ts (4 tests) 12ms                                        │        │
│  └───────────────────────────────────────────────────────────────────────────┘        │
│                                                                                        │
│  The tests pass, but I identified that the secret key falls back to a default value... │
│  ▌                                                                                     │
│                                                                                        │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  [Subagents Dock: 2 active]                                                    [F7] ✕  │
│  ▶ #1 Code-Scanner: scanning dependencies (step 3/5 · 42s)                    [Enter]  │
│  ▶ #2 Test-Runner: running fuzzing suite (step 1/8 · 12s)                     [Enter]  │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  ☤ claude-sonnet-4 │ 18.2K/200K │ [██████░░░░░░░░░░] 9% │ $0.08 │ 🗜️ 1 │ ▶ 2 │ 12m 45s │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  ❯ Refactor the token refresh rotation to use sha256 family hashing_                   │
│                                                                                        │
│  [Ctrl+G: Editor]  [Ctrl+S: Stash (1)]  [Ctrl+T: Agents]  [Ctrl+X: Sessions]  [/: Cmd]│
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Component Breakdown

### 3.1 Collapsible Startup Banner
The startup banner groups environment status into four collapsible, mouse- and keyboard-interactive sections:

| Section | Default State | Content Rendered |
|---|---|---|
| **Tools** | **Open** | List of loaded tool primitives (built-in + MCP tools) with capability descriptions. |
| **Skills** | **Collapsed** | List of loaded prompt packs, domain procedures, and dynamic `/skill <name>` handles. |
| **System Prompt** | **Collapsed** | Active system prompt preview, active `SOUL.md` summary, and injected directives. |
| **MCP Servers** | **Collapsed** | Stdio and SSE/HTTP connected Model Context Protocol servers with connection status. |

*Interaction:* Click with mouse on `▸` or `▾`, or use key navigation to toggle. Collapsing keeps terminal vertical space clean for conversation history.

---

### 3.2 Persistent Two-Column Status Bar
The status bar (`ui-tui/src/components/appChrome.tsx`) sits directly above the input composer and dynamically updates via differential renders:

```
 ☤ claude-sonnet-4 │ 18.2K/200K │ [██████░░░░] 9% │ $0.08 │ 🗜️ 1 │ ▶ 2 │ 📌 1 │ 12m 45s │ ⚠ YOLO
```

#### Left Column (Resource Metrics)
1. **Model Glyph & Identifier:** Active LLM (truncated intelligently if $>26$ characters).
2. **Context Window Metric:** Exact tokens used vs. max token window (e.g., `18.2K/200K`). A leading `~` indicates local token estimation.
3. **Context Color Bar:** ASCII bracketed bar with dynamic color-coding:
   * **Green:** `< 50%` context used.
   * **Yellow:** `50% - 80%` context used.
   * **Orange:** `80% - 95%` context used.
   * **Red:** `≥ 95%` context used (warning to trigger `/compress`).
4. **Session Cost:** Accumulated USD cost calculated from token catalog (or `n/a` for free/local models).

#### Right Column (State Badges & Indicators)
1. **Compression Counter (`🗜️ N`):** Shows how many times auto-compaction has fired on this session.
2. **Background Tasks (`▶ N`):** Number of running background tasks spawned via `/bg`.
3. **Stashed Prompts (`📌 N`):** Count of prompts stored in the prompt memory stack via `Ctrl+S`.
4. **Session Duration:** Wall-clock elapsed time (e.g., `12m 45s`).
5. **Session Title Badge:** Pinned title badge when session is named via `/title`.
6. **YOLO Mode Flag (`⚠ YOLO`):** Bright yellow/red badge when auto-approval is toggled on (`--yolo` or `/yolo`).

---

### 3.3 Composer & Input Mechanics
* **Multiline Editing:** Native multiline composition using `Alt+Enter`, `Ctrl+J`, or `Shift+Enter`.
* **External Editor Bridge (`Ctrl+G` / `Ctrl+X Ctrl+E`):** Dumps current buffer to `$EDITOR` (e.g., `nvim`, `vim`, `nano`, `code`) and reads back saved content as prompt.
* **Prompt Stash Stack (`Ctrl+S`):**
  * Pressing `Ctrl+S` stashes current draft and clears input for urgent commands.
  * Pressing `Ctrl+S` on empty prompt pops the last draft back into the composer.
  * Multiple stashes build an in-memory stack (`📌 N`); pressing `Ctrl+S` with multiple items opens an interactive browsing overlay (`↑`/`↓` browse, `Enter` restore, `D` discard).
* **Terminal Paste Safeguards:**
  * **Paste Collapse:** Long pasted snippets (e.g., 500-line stack trace) collapse into a visual pill: `[Pasted text: 512 lines (click or /expand to view)]`.
  * **Clipboard Images:** `Ctrl+V` or `Alt+V` reads terminal OSC 52 or local system clipboard to attach images directly in terminal mode.
* **Shell Direct Bypass (`!<command>`):**
  * Prefacing prompt with `!` runs local shell directly without an LLM turn (e.g., `!git status`, `!cargo check`).

---

## 4. Bots, Personas & Profiles in the Terminal

In Hermes Agent, **a Bot is a Profile**. There are no separate confusing concepts. A Bot has its own dedicated directory at:
```
~/.hermes/profiles/<profile_name>/
├── config.yaml          # Profile-specific model, provider, temperature
├── credentials.json     # Encrypted API keys unique to this bot
├── SOUL.md              # Persona, tone, boundaries, and standing orders
├── IDENTITY.md          # Name, role, ASCII avatar, terminal color
├── USER.md              # Target user context and preferences
├── memory/              # Dedicated vector database & SQLite memory store
├── skills/              # Bot-specific skills and custom tools
└── sessions/            # Conversation history and checkpoints
```

### 4.1 Invoking and Switching Bots
```bash
# Launch default bot
hermes

# Launch named specialist bot
hermes -p code-auditor
hermes -p research-scout chat

# Check bot status from terminal
hermes -p code-auditor /status
```

### 4.2 Terminal Visual Representation & Avatars
Because the terminal cannot render PNG/WebP images natively without Kitty/Sixel protocols, Hermes implements:
* **ASCII Sigils & Glyphs:** Unique single-character or multi-character emblems assigned to each Bot:
  * `[☤]` Hermes Core
  * `[⚡]` Code Execution Specialist
  * `[🔍]` Research Scout
  * `[🛡️]` Security Auditor
* **Theme & Accent Tinting:** Each Bot profile can configure its prompt glyph, prompt color, selection color, and banner palette.
* **Live Activity Indicators:** When a Bot or subagent is generating tokens, the glyph pulses or rotates:
  ```
  [⚡] Code-Auditor is thinking... (running tool: read_file)
  ```

### 4.3 Subagent Delegation & Roster (`Ctrl+T` / `/agents`)
Hermes allows the primary agent to spawn autonomous subagents (e.g., via `/review` or automated delegation).

#### The Live Subagent Dock
When background subagents are running, an interactive dock appears directly above the status bar:
```
├────────────────────────────────────────────────────────────────────────────────────────┤
│  [Subagents Dock: 2 active]                                                    [F7] ✕  │
│  ▶ #1 Code-Scanner: scanning dependencies (step 3/5 · 42s)                    [Enter]  │
│  ▶ #2 Test-Runner: running fuzzing suite (step 1/8 · 12s)                     [Enter]  │
├────────────────────────────────────────────────────────────────────────────────────────┤
```
* **Keyboard Navigation:**
  * `F7`: Toggles the dock between expanded multi-row preview and a 1-line condensed summary.
  * `Ctrl+T` or `F6`: Expands into the full-screen **Agents Roster Overlay**.

#### The Full-Screen Agents Roster Overlay
```
┌─ Running Subagents Roster ────────────────────────────────────────────────── [Esc: Close] ─┐
│                                                                                             │
│  ID    Name          Role            Model            Tokens  Cost   Elapsed  Status        │
│  ────────────────────────────────────────────────────────────────────────────────────────   │
│  #1  ● Code-Scan     AST parser      claude-sonnet-4   4.2K   $0.02   1m 12s  Running       │
│  #2  ● Test-Runner   Vitest worker   gpt-4o            8.1K   $0.04   0m 45s  Running       │
│  #3  ✓ Dependency    CVE audit       claude-3-5-haiku  2.1K   $0.01   0m 18s  Completed     │
│                                                                                             │
│  [Enter/t] View Live Transcript   [d] Details & Files   [s/e] Steer Subagent   [x] Stop     │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Sessions Management in the Terminal

Sessions in Hermes are durable, persistent, branchable, and checkpointed.

### 5.1 Interactive Session Switcher (`Ctrl+X` / `/sessions`)
Pressing `Ctrl+X` or typing `/sessions` opens a modal picker directly over the terminal stream:

```
┌─ Active & Recent Sessions ────────────────────────────────────────────────── [Esc: Close] ─┐
│                                                                                             │
│  Search: [ refactor                                    ]                                    │
│                                                                                             │
│  ID               Title                       Updated     Tokens   Cost   Status            │
│  ────────────────────────────────────────────────────────────────────────────────────────   │
│  ▶ 20260409_01    Refactor JWT auth module    2 mins ago  18.2K   $0.08   Active            │
│    20260408_14    Fix postgres connection     1 day ago   42.1K   $0.21   Completed         │
│    20260407_09    Research vector DB options  3 days ago  95.4K   $0.45   Archived          │
│                                                                                             │
│  [Enter] Switch/Resume   [N] New Session   [R] Rename   [D] Delete   [B] Branch Session     │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Session Lifecycle & Control Commands

| Command | Terminal UX Behavior |
|---|---|
| `/new [title]` | Flushes current context, generates a new session UUID, and clears prompt. |
| `/resume [id]` | Resumes session. When resumed, prints a **Previous Conversation Panel** summarizing history. |
| `/branch [title]` | Forks the conversation at the current turn into a new child session branch. |
| `/title <text>` | Renames the session. Updates status bar immediately. |
| `/compress [here]` | Triggers LLM compaction; summarizes history into persistent memory and prunes context. |
| `/rollback [N]` | Restores filesystem and code changes to a previous tool execution checkpoint. |
| `/diff` | Displays an interactive terminal git diff of all changes made during the session. |
| `/snapshot create`| Takes a full SQLite backup snapshot of config, state, and sessions. |
| `/handoff <platform>`| Hands over session to Telegram, Discord, or Slack, continuing seamlessly on mobile. |

---

## 6. Capabilities, Tools, Skills & MCP in Terminal

### 6.1 Inline Tool Calling & Output Formatting
When Hermes executes a tool, it avoids raw JSON dumps. Instead, it renders an animated, structured box:

```
  User: Check if port 5432 is listening and query the users table

  Hermes:
  Checking database connectivity and table schema...

  ┌─ ⚙ bash · pg_isready -p 5432 && psql -c "\dt" ───────────── [0.4s] [✓] ┐
  │ /var/run/postgresql:5432 - accepting connections                       │
  │               List of relations                                         │
  │  Schema | Name  | Type  | Owner                                         │
  │ --------+-------+-------+-------                                        │
  │  public | users | table | postgres                                      │
  └────────────────────────────────────────────────────────────────────────┘
```
* **Tool Status Icons:**
  * `[⚙]` Running (animated spinner).
  * `[✓]` Success / zero exit code.
  * `[✕]` Failed / non-zero exit code (auto-expands error output).
  * `[▾]` Collapsible output handle.

### 6.2 Approval Overlays (Human-in-the-Loop)
When a high-risk tool call (file modification, shell command, external API write) requires human confirmation:

```
┌─ Tool Execution Approval Required ──────────────────────────────────────────────────────────┐
│                                                                                             │
│  Tool:     bash                                                                             │
│  Command:  rm -rf ./dist && npm run build                                                   │
│  Risk:     HIGH (Directory deletion & shell script execution)                               │
│                                                                                             │
│  [1] Allow Once (Execute this call only)                                                    │
│  [2] Allow Always (Whitelist 'npm run build' for this session)                             │
│  [3] Deny (Abort tool call and notify agent)                                                │
│                                                                                             │
│  Choice [1-3] or [Esc to Cancel]: _                                                         │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 6.3 Skills & ClawHub Dynamic Registration
* Skills installed in `~/.hermes/skills/` are parsed and dynamically registered in `COMMAND_REGISTRY`.
* If a skill is named `deploy`, it becomes callable as `/skill deploy` or `/deploy`.
* Typing `/` shows all registered skills alongside built-in commands with description hints.

---

## 7. Schedulers, Cron & Routines

Hermes features an integrated **Cron & Routine Engine** running as a local background daemon (`hermes gateway`).

### 7.1 Managing Scheduled Tasks from the Terminal
```bash
# List all scheduled routines and cron jobs
hermes cron list

# Output:
# ID        Schedule         Bot/Profile     Task Prompt                      Last Run    Status
# -----------------------------------------------------------------------------------------------
# c_01a     0 9 * * 1-5      researcher      "Summarize daily GitHub PRs"     Today 09:00 OK (0s)
# c_02b     0 23 * * *       security-bot    "Run dependency vulnerability"   Yesterday   OK (42s)

# Check scheduler health and next ticks
hermes cron status
```

### 7.2 In-Session Loops & Heartbeats
For recurring tasks scoped only to an active terminal session:

* **`/heartbeat every <interval> <prompt>` (`/hb`):**
  * Injects a recurring prompt into the session whenever the session has been idle for the specified interval.
  * Example: `/heartbeat every 10m check if server deployment is finished`
* **`/loop [interval] <prompt> [--until <condition>]`:**
  * Executes a task repeatedly until an LLM judge confirms the condition is met.
  * Example: `/loop 2m cargo test --until "all tests pass"`

---

## 8. Complete Terminal Keybindings Reference

| Key Combination | Scope | Action |
|---|---|---|
| `Enter` | Composer | Send prompt or submit active selection. |
| `Alt+Enter` / `Ctrl+J` / `Shift+Enter` | Composer | Insert newline (multiline prompt). |
| `Ctrl+G` / `Ctrl+X Ctrl+E` | Composer | Open prompt in external `$EDITOR` (vim/nano/code). |
| `Ctrl+S` | Composer | Stash current draft / Browse stash stack (`📌 N`). |
| `Ctrl+C` | Global | Cancel streaming output / Cancel active tool run (double-press to kill). |
| `Ctrl+D` | Composer | Exit session (when prompt is empty). |
| `Ctrl+Z` | Global | Suspend process to background (`fg` to resume). |
| `Ctrl+T` / `F6` | Global | Open full-screen Subagents Roster overlay. |
| `F7` | Global | Toggle subagent dock between multi-row and single-line summary. |
| `Ctrl+X` / `Ctrl+K` | Global | Open interactive Session Switcher modal. |
| `Tab` | Composer | Accept ghost text suggestion or autocomplete slash command. |
| `!<command>` | Composer | Execute native shell command without consuming LLM turn. |
| `Alt+V` / `Ctrl+V` | Composer | Paste text or clipboard image via OSC 52. |
| `Esc` | Modals | Dismiss active overlay, modal, or stash picker. |

---

## 9. Terminal Slash Commands Reference

### 9.1 Session Management
* `/new [name]` (alias `/reset`): Start fresh session with optional title.
* `/resume [id]` (alias `/continue`): Resume previous session by ID or recent history.
* `/sessions` (alias `/switch`): Open interactive session picker modal.
* `/branch [name]` (alias `/fork`): Branch session into independent exploration path.
* `/title <name>`: Assign human-readable title to current session.
* `/clear`: Clear terminal screen and reset viewport.
* `/history`: Print conversation history with optional timestamps.
* `/compress [here]`: Force context window summarization and memory flush.
* `/rollback [N]`: Revert filesystem state to checkpoint baseline.
* `/diff`: Review git changes generated by the agent.
* `/snapshot`: Create or restore SQLite database backup snapshot.
* `/handoff <platform>`: Migrate terminal session to Telegram, Discord, Slack, etc.

### 9.2 Agent & Execution Control
* `/steer <note>`: Inject guidance arriving **after the current tool completes** without interrupting the run.
* `/queue <prompt>` (`/q`): Queue prompt to run immediately after active turn completes.
* `/stop`: Force kill all active background subprocesses and tools.
* `/goal <text>`: Establish persistent goal with auxiliary judge continuation loop.
* `/subgoal <text>`: Add intermediate milestone to active goal.
* `/heartbeat every <int> <msg>`: Set session-scoped idle heartbeat prompt.
* `/loop <int> <msg> [--until <cond>]`: Set recurring in-session loop.
* `/bg <prompt>`: Execute prompt in an independent background worker thread.
* `/btw <question>`: Query side question about session using read-only transcript snapshot.
* `/review [instructions]`: Spawn isolated subagent to review code or diff.
* `/refine`: Trigger self-improving memory distillation loop manually.

### 9.3 System & Configuration
* `/model [model-id]`: Interactive fuzzy model & provider picker.
* `/personality <name>`: Switch active persona / `SOUL.md`.
* `/skin <name>`: Switch TUI theme, ANSI color palette, and border styling.
* `/context` (`/ctx`): Display visual ASCII 5×20 grid context window consumption.
* `/usage`: Display token statistics, cache hits, and USD spend breakdown.
* `/agents` (`/tasks`): Inspect running subagent delegation hierarchy.
* `/status`: Display comprehensive session metadata, working directory, and tool counts.
* `/redraw`: Force terminal screen redraw to repair terminal resize artifacts.
* `/mouse [on|off|wheel|buttons|all]`: Configure terminal mouse tracking mode.
