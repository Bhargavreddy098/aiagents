# Phase 8 — Chat (spec numbering)

**Status: ✅ done and verified — and changed in this pass for `v2.md` §9.**

Verified by the full gate: `lint` → `typecheck` (src **and** test) → `test` → `build`, all exit 0,
**921 tests / 43 files**. The spec's acceptance line has four claims; each is traced to code below.

## What is built

| Piece | Where | Notes |
|---|---|---|
| `ChatTurnRunner` | `services/chat/chat-turn.runner.ts` | Streaming turn with a tool loop; provider deltas out over SSE |
| Turn pipeline | `controllers/chat.controller.ts` | `parse → slash? handler : agent-loop`. Branches on `SlashCommandService.isCommand` **before** `prepareTurn`, so a command cannot create a run it would abandon |
| Slash commands | `services/chat/commands/` | Registry, creation, control, identity, unavailable modules |
| Mentions | `services/chat/mention.resolver.ts` | `@` over live rows only |
| Message history | `routes/chat.ts` | `GET /api/chat/messages` → newest-first |
| Attachments & grants | `FileService.resolve` | normalize → `realpath` → `startsWith(root + sep)` → symlink re-check → 403 |
| One context resolver | `services/engine/agent-context.ts` | Built once, shared by the engine and `ChatService`; two would be two answers to "what is this agent allowed to do" |

## Acceptance claims, traced

1. **`POST /api/chat` streams per §3.5.** Live boot: `401` without a cookie, structured error body.
2. **The pipeline is `parse → slash? handler : agent-loop`.** See the controller branch above.
3. **`GET /api/chat/mentions`** resolves live rows only.
4. **`GET /api/chat/messages`** returns `{ data: ChatMessage[] }` newest-first.
5. **Attachments/folder grants.** Covered by `file.service.test.ts` ("refuses a write to a
   read-only grant", "refuses a read-only grant for a write target", "…escapes via a symlink").

## Decisions that are load-bearing

- **A chat run is never enqueued.** `ChatService.sendMessage` creates it and stops; it is claimed
  by the SSE connection that will render it (CAS on `['queued','running']`), so of N tabs exactly
  one generates and the losers stop. Honest trade-off: a message whose client never opens a stream
  leaves a `queued` run, visible in the run list.
- **The user message is persisted before anything else can fail**, which is what makes a
  mid-response disconnect recoverable.
- **`ChatMessageRole` ≠ shared `ChatRole`.** The persisted role is `'user'|'assistant'|'tool'` and
  excludes `'system'`; `buildPrompt` **narrows** rather than casts, so a stored string can never
  masquerade as the agent's instructions.
- **One assistant message per run**, written by the claim winner; `findAssistantForRun` makes
  finalize an update-in-place.
- **A slash command never reaches the model and creates no `Run`.** Both messages are persisted so
  a reload shows them, but a command is not work the engine performed and a run row would claim
  otherwise.

## What `v2.md` changes here — applied in this pass

`v2.md` §9 is explicit: *"The composer's slash menu, CLI/TUI autocomplete, and every channel's
platform menu all render from this one registry."* That is a backend contract, so it was a Phase 8
change rather than a frontend one.

### 1. The registry carries surface availability and the owner split

| Change | Detail |
|---|---|
| `SlashCommand.surfaces` | Which **client classes** may run it — `web \| cli \| tui \| channel` |
| `SlashCommand.adminOnly` | Owner-only (`operator.admin`), §5.2/§5.6 |
| `CommandDraft` | What a module declares; the two new fields are optional |
| `createSlashCommands` | Applies the defaults **once** (`DEFAULT_COMMAND_SURFACES`, `adminOnly: false`) |
| `describeCommands` | Projection for a picker, now including both fields |

**Why surfaces are client classes, not channel names.** A `SurfaceId` names one place
("telegram"). Availability is a property of the *client class*: the Control UI, a CLI and a TUI
all speak the operator API and can run the same commands, while a channel menu is generated from
that same registry and may legitimately be narrower. Declaring a command available "on Telegram,
Discord, Slack, Signal, Matrix, …" is a list that goes stale the moment a plugin adds a channel
type — which `v2.md` §8 explicitly allows.

### 2. The admin/user split is enforceable in one place

`visibleCommands(commands, policy)` applies §5.2's `allow_admin_from` / `user_allowed_commands`,
including the **floor**: `/help` and `/whoami` are always permitted, because `/help` is how a
restricted user discovers what they *may* run. `undefined` means unrestricted; an empty array
means "narrowed to the floor". Those are different states and the code keeps them different.

### 3. `/help` filters by policy and prints §9's badges

An owner-only marker (`· owner`) and — only when a command is *not* available everywhere — its
surface list. "Everywhere" stays silent so the common row is one line. The filter applies at
**render** time as well as dispatch, because a menu that offers `/stop` and then answers "not
allowed" is worse than a menu that omits it.

### 4. `/whoami` added (new module `identity.commands.ts`)

On the always-allowed floor. It reports ids from the already-authenticated context (user,
workspace, conversation) plus the policy in force, and deliberately does **not** look up a display
name — that would be a second read that can fail and leave the command half-answered, and
disagreeing with what the gateway actually enforced.

### 5. The registry is now complete against §9

`unavailable.commands.ts` grew from 3 entries to **28**: the §3.8 three (`/schedule`, `/research`,
`/connect`) plus v2's additions — `/steer`, `/queue`, `/btw`, `/bg`, `/handoff`, `/context`,
`/config`, `/egress`, `/heartbeat`, `/loop`, `/refine`, `/review`, `/moa`, `/new`, `/history`,
`/title`, `/save`, `/retry`, `/undo`, `/compress`, `/snapshot`, `/diff`, `/rollback`, `/branch`,
`/skill`. Each names what will back it and says *"Arrives with …"*, so the palette is complete
without any of it claiming to work. `adminOnly` is set on the three that change the gateway rather
than the workspace (`/config`, `/moa`, `/rollback`) and left off `/approve`, `/reject`, `/stop`,
`/pause`, `/resume` — because §4.3/H4 promise those *from a channel*, and marking them owner-only
would break the one feature `v2.md` treats as the signature interaction.

`/skills` copy was also corrected: it claimed skills were "not a table in this schema", which is
false — `Skill` and `SkillVersion` exist. It now points at §7's Skills Hub.

## An honest gap in this pass

**Dispatch-time enforcement is not wired.** `visibleCommands()` filters what is *listed*, but
`SlashCommandService.run()` does not refuse an `adminOnly` command for a non-owner. This is
deliberate: no channel exists yet, so no caller supplies a `CommandRegistryPolicy` and there is no
policy in force. The enforcement point belongs with the channel adapters, where the policy comes
from; adding it now would be a branch no code path can reach and no test could prove. Tracked as
`SURFACES-BUILD-PLAN.md` S5.

## Still to come from `v2.md` §4 — frontend, Phase 13

The surface context chip (§4.1), the composer's mid-run ghost chips (§4.2), the inline
`ApprovalCard` (§4.3), `/handoff` (§4.5) and delivery receipts (§4.6). The backend halves that
already exist are the `ChatSession.surface` / `channelType` / `peerRef` columns and
`Schedule.deliveryTarget`; the rest waits on Surfaces + Phase 13.