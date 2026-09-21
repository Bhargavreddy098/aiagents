# Terminal UI/UX spec → `apps/web` — implementation report

**Source spec:** `docs/HERMES-TERMINAL-UI-UX.md` (428 lines, repo root `docs/`).
**Target:** `nexs/apps/web`.
**Date:** 2026-09-20.

Read-only inputs throughout: the spec, `nexs-build-spec.md`, `PRD.md`, `message-*.md`, `gaps.md`,
`v2.md`. Nothing in `docs/` was modified. This file is a *new* root artifact, as the project's rule
requires.

The brief was two things: implement the spec's UI/UX, and *finish the half-done backend→frontend
wiring*. Both are done, and the second is where most of the work turned out to be — eight whole API
prefixes were live on the server and unreachable from the browser.

---

## 1. What was built

### §3.3 — the composer
The largest single piece. What the spec describes, and what each part actually is:

| Spec | Implementation | The non-obvious part |
|---|---|---|
| `Ctrl+S` stash / restore | A **stack** (`lib/stash.ts`), `takeStash` pops; `StashBrowser` overlay browses | `stashIntent(text, stack)` decides stash/pop/browse/noop as a pure function, so the key handling is one call |
| Paste collapse | A **pill rendered behind the textarea**, `registerPaste` records the region | The textarea's value is never rewritten. Editing it would move the caret and destroy the browser's own undo stack |
| Hint rail | `.composer-hints` — `⌘/Ctrl+S stash\|restore (N)`, `⌘X sessions`, `⌘K palette` | Each hint is struck through and titled with the reason when unavailable |
| `!command` | **Refused before send**, with the sentence from `unsupportedReasonFor('!command')` | Not "unimplemented" — unavailable by design. This deployment has no operator shell |
| `Ctrl+J` / `Alt+Enter` newline | Handled in `onKeyDown` | The spec's own terminal-safe alias of `Shift+Enter` |
| `/clear` | Handled client-side (`chooseSlashCommand`) | Clearing the composer is not a server concern; the round trip produced a reply about it |

### §6.1 — the three-state tool box
`running | ok | failed`, drawn as `⚙ / ✓ / ✕` with a colour and a `visually-hidden` label.

The bug this fixed: the previous code read `LiveToolCall.ok`, which **starts `false`** — so a call
that was still streaming was drawn in the failure colour. The state is now derived:
`result === undefined && endedAt === undefined ? 'running' : ok ? 'ok' : 'failed'`.

### §6.2 — exec approvals vs tool approvals
**One Decision Inbox, two vocabularies.** The `Kind` column decides which surface opens:

- **`command`** → the `ApprovalOverlay`: allow once / allow always / deny, plus the standing rule the
  decision would create.
- **`tool`** → the existing drawer: approve / reject.

Plus `ExecRulePanel` — the standing-permission table with a Revoke button, "never used" for a null
`lastUsedAt`, and a note that revoked rules are deliberately not listed.

The split itself is `exec-queries.ts`'s `isExecApproval` / `splitApprovalsByKind`, now pinned by 8
tests. It is worth pinning because it rests on an **indirection**: `ApprovalSummary` carries no `kind`
field, so the split reads `requiredPermissions.includes('exec')`. If the server ever stopped emitting
that permission the two surfaces would quietly merge and every test would still pass — so the rule is
tested directly, including the case that must *not* match: `exec_readonly` is a different permission
and belongs in the tool drawer.

### §3.2 / §4.3 / §5.1 — the terminal chrome
`StatusBar`, `StartupBanner`, `SubagentDock` + `RosterOverlay`, `SessionSwitcher` — all mounted on
`ChatPage`, opened by `Ctrl+X`, `Ctrl+T`/`F6`, `F7`.

### §8 — the keybinding table
`lib/keybindings.ts` holds 16 rows; **7 are `unsupported` with a readable reason**, rendered *in the
row* rather than in a tooltip. Reached by `?`, by a topbar button, and from the palette.

The design decision worth stating: omitting the seven would make the overlay silently disagree with
the spec it is derived from, and a user who read §8 would conclude they had pressed the key wrong.

### §9.3 — the context grid
`ContextGrid` + `ContextModal`, opened from the status bar's meter. The meter is a **button only
where a modal is mounted** (`onOpenContext?`), so no page gets a control that leads nowhere.

It renders **nothing** when the reading is absent, rather than an empty grid: a blank chart beside
`0/0` reads as "the context is empty", which is a different claim from "nobody measured it".

### Four pages that did not exist
`/skills`, `/events`, `/files`, `/schedules` — routes, `lazy()` shims and nav entries. Four whole
API prefixes had been live and unreachable.

### Two pages with dead write halves
`/browser` and `/sandbox` could list but not act. Now: create session, run an action, close;
create session, run code. Each page states why only part of the action vocabulary is offered —
the other nine browser action types need a page the operator cannot see.

---

## 2. The bugs found, in the order they were found

1. **`g d` never navigated** — the first `useKeyboardShortcuts` test suite mounted nothing. The hook
   has no observable effect until mounted, so **every negative assertion passed against no listener at
   all** and the suite was green while proving nothing. Mounting moved into `beforeEach`.
2. **`?` did not cancel an armed `g`** — `g`, `?`, `c` navigated to Chat after the user had abandoned
   the sequence and asked for help instead. A branch that acts must disarm the prefix.
3. **The command catalog's sort test caught my insertion** — `skin` must sort after `skills`
   (`'k' < 'n'`). An existing one-line test earned its keep.
4. **Seven unused imports**, one per file, across `Overlays`, `StartupBanner`, `StatusBar`,
   `ChatPage`, `EventsPage`, `SandboxPage`, `SchedulesPage` — plus a genuinely dead `SECTIONS` table
   in `StartupBanner` whose four entries the JSX wrote out inline anyway.
5. **Two duplicate JSON validators.** `SkillsPage` and `EventsPage` had each grown the same function
   with different wording. Both now call `jsonErrorFor(text, message)` from `src/lib/validation.ts`;
   the rule is shared, the sentence is the page's own.

---

## 3. What is honest but incomplete

Stated because the alternative is a UI that implies more than the API can do.

- **Totals are lower bounds, and the bar says so.** The denominator is the model's catalogue window;
  the numerator is summed from the session's run usage rows. `contextOccupancy` marks it
  `approximate`, the status bar prefixes the pair with `~`, and the `title` explains it in a sentence.
- **`@` mentions are not resolved server-side.** The picker inserts the name as text and says so,
  rather than implying the server will bind it to an agent.
- **No `GET /chat/commands`.** The menu mirrors the server's catalog locally. It is marked and never
  a gate: an unknown command still reaches the server, which is the authority.
- **`/context`, `/usage`, `/status`, `/redraw`, `/mouse`, `/skin`, `/personality`** are listed in §9
  and present in the client catalog with `available: false`. `/context` has a real client-side answer
  (the grid); `/redraw` and `/mouse` are unavailable by nature — a page repaints itself and owns its
  own pointer.
- **Seven of the spec's keybindings cannot exist in a browser tab** (`Ctrl+Z`, `Ctrl+D`, `Ctrl+C`,
  the `Ctrl+G` editor bridge, `!command`, …), each with its reason visible in the overlay.

---

## 4. Verification

| Gate | Result |
|---|---|
| `apps/web` lint | 0 problems |
| `apps/web` typecheck | 0 errors |
| `apps/web` tests | **195 passed / 11 files** (+41 this session: 21 for the shortcut listener, 15 new pure-rule cases shared with the pages, 8 for the exec/tool split; the 23-case approvals file includes the 7 that already existed) |
| `apps/web` build | clean; **per-page chunks**, largest page chunk 55 kB (was one 578 kB chunk) |
| `apps/server` tests | **1523 passed / 73 files** |
| `apps/server` typecheck | both configs clean (`tsconfig.json` + `tsconfig.test.json`) |
| root lint / typecheck | 3/3 and 4/4 clean |

All four figures above were re-measured after the last edit rather than carried over, and that
re-run was not ceremony: it caught a **duplicate import** introduced by a scripted append. Two
identical `import { isExecApproval, splitApprovalsByKind }` lines made no difference to vitest — all
23 approvals tests passed — but stopped `tsc` with `TS2300 Duplicate identifier`. Tests green,
typecheck red. If the suite had been trusted as the gate, this would have shipped.

**Not verified:** the spec's acceptance journeys (a killed run reflected as `failed`, the full
signup→…→receipt walk) need a live server and Postgres. Everything above is typecheck, tests, build
and bundle inspection — **not** a browser session.

**Still open:** a Playwright e2e suite (Phase 14 item 3's second half). The approval-drawer RTL test
it also names **already existed** — 7 tests in `ApprovalsPage.test.tsx`, predating this work; an
earlier note of mine calling it outstanding was wrong. It is now 23.

**Known debris:** `apps/web/dist-verify/` is a throwaway build directory from verifying the bundle.
Every attempt to delete it — `rm -rf`, `rmdir`, `find -delete`, sandboxed and escalated — is killed
with `SIGTERM`. It is gitignored and harmless.
