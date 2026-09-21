# Phase 4 — Tool Registry, MCP, Browser & Sandbox (spec numbering)

**Status: ✅ done — and this phase absorbed Phase 9's work** (browser & sandbox). `v2.md` adds an
**exec approval** flow on top of the sandbox.

## What is built

| Piece | Detail |
|---|---|
| `MCPManager` | Full lifecycle: `initialize` handshake → capability exchange → `tools/list` → `tools/call`. Discovered tools become canonical `Tool` rows |
| MCP process lifecycle | Tracks the child pid, kills on disconnect, reaps zombies (gap #22). A crash mid-run marks the step failed with **no auto-restart** unless the tool is `read_only` |
| Tool capabilities | `read_only` / `side_effect` flags (gap #14) — the vocabulary the approval policy is keyed on |
| Tool result cap | Max bytes per result before truncate + summarise (gap #18) |
| Native tools | Full arg/return schemas (gap #12) |
| `BrowserManager` | Playwright, headless by default, screenshot size cap, per-session **ephemeral** storage; `reconcile()` sweeps sessions whose process died |
| `SandboxManager` | **`worker_threads` with `resourceLimits`** for JS isolation (gap #24), plus a wall-clock ceiling that kills an infinite loop |
| `FileService` | Tenant workdirs; `resolve` does normalize → `realpath` → `startsWith(root + sep)` → symlink re-check → 403. `storage.service` abstracts the backend (gap #25) |
| `ToolInvoker` | The single call path, with the allowlist enforced |

Proven by `mcp.manager.test.ts`, `mcp.session.test.ts`, `mcp.orphans.test.ts` (14),
`browser.manager.test.ts` (31), `sandbox.provider.test.ts` (26), `tools.native.test.ts`,
`tool-result.test.ts`, `file.service.test.ts`, `storage.service.test.ts` (17).

## What `v2.md` adds

### §4.4 / §11 — the exec approval (owner-only commands)

`v2.md` §0 maps H8 ("Terminal / sandboxed exec") onto this phase and asks for one thing: an
**exec approval variant** for owner-only commands. Concretely (tracked as `SURFACES-BUILD-PLAN.md`
S6, because the owner identity and the approval surface are Surfaces concepts):

| Element | Requirement |
|---|---|
| Kind | `Approval.kind = 'exec'` — the column exists; the flow does not |
| Payload | `requestedAction: ExecRequestedAction` = `{ command, args, cwd }` |
| Outcomes | `allow_once` / `allow_always` / `deny` — **different in kind** from approve/reject |
| `allow_always` | Writes a **tool allowlist rule** for that command in that directory |
| Authority | Only the owner (`operator.admin`) may grant; anyone else gets `FORBIDDEN`, not a silent no-op |
| Schema | A separate `decideExecApprovalSchema` — merging it with `decideApprovalSchema` would let `allow_always` reach a tool approval, where it means nothing |

**Why `cwd` is in the payload.** `npm test` in two repositories is two different actions. An
approval that omitted the directory would ask the operator to authorise a command they cannot
actually see — which is the failure mode the whole approval system exists to prevent.

**Why it is not "just another approval".** "Approve step 3 of the plan" and "allow `npm test` in
`~/work/api` forever" are different decisions with different consequences, and the second one
outlives the run that triggered it. Collapsing them into one kind would put an "Allow always"
button on a plan step.

### §0 H7 — the browser copy

The Browser page's option reads **"Cloud browser (isolated context)"**, matching Hermes' "cloud
browser via Browser Use" while staying honest: today's context is local and ephemeral, so
"isolated context" is true and "cloud" alone would not be. This is a Phase 13 label, not a Phase 4
capability.

Note the one v1 decision `v2.md` does **not** override: `/browser` stays **read-only**
(`screenshot | title | text`). `click`, `type` and `upload` are side-effecting and belong in the
approval flow, not in a text box.

## Acceptance test

Unchanged and passing: crash an MCP server mid-run → the step is marked failed, no zombie process,
and no double-fired side effect on resume; a 10 MB tool result is capped rather than pasted through.

The v2 extension to add with the exec work:

1. An unapproved command parks; `allow_once` resumes and the same command parks again next time.
2. `allow_always` writes exactly one allowlist rule; that command no longer parks, a **different**
   command still does.
3. A non-owner deciding an exec approval → `FORBIDDEN`, approval still `pending`.
4. An approved command that loops forever is **still** killed by the wall-clock ceiling — an
   approval authorises running something, not running it forever.

## Traps to keep out

- **`resourceLimits` does not exist on `child_process`.** If exec support ever reaches for a
  subprocess, the isolation story has to be stated again explicitly rather than assumed to carry
  over from `worker_threads`.
- **Never re-open a resolved approval.** The state machine is terminal by design; a re-run is a new
  run, not an edit.
- **The `FileService` guard chain is not negotiable.** Any new path a command can write to goes
  through `resolve`, because the symlink re-check is what catches a grant escaping its root.