# NEXS light theme, panel settings, and the terminal

What changed in `apps/web` for the request that produced this file:

> make this into light theme i don't like dark one — and there is one extra sidebar under the logo,
> shift that into settings; there is session and agents, put settings in that section in last; on the
> top right, live and logo and notifications icon, remove those; and implement sandbox and browser
> related things, and localhost CLI put there.

Six asks, six sections below, plus a seventh for the bugs the work uncovered — which are the part
worth reading. `apps/web/src/styles/theme.css` promised this file in its header, so it exists.

---

## 1. Light is now the default theme

`theme.css` used to be the spec's §6.3 palette, which is dark. It is now **light-first**: the light
palette sits on `:root`, and §6.3's dark palette is kept **verbatim** under `[data-theme='dark']`.
No token was renamed and none was deleted, so a reader comparing the file with §6.3 still finds every
name they expect.

| token | light (`:root`) | §6.3 (dark) |
| --- | --- | --- |
| `--bg` | `#eef1f6` | `#0a0b0d` |
| `--surface` | `#f6f8fc` | — |
| `--border` | `#d8dee8` | — |
| `--text` | `#23272e` | — |
| `--muted` | `#5c6673` | — |
| `--accent` | `#2f6fe0` | `#4f8cff` |
| `--surface-raised` | `#ffffff` | — |

### The two values that had to move, and why

A palette is not theme-neutral. Two of §6.3's values cannot be carried onto a light ground
unchanged, and both are recorded here rather than applied quietly:

- **`--accent`** is `#4f8cff`, which is **2.6:1** on `#eef1f6`. That is a fine *fill* and an
  unreadable *link*, and this app uses it for both. The light value is `#2f6fe0` — **4.6:1**.
- **The status colours** are tuned for a dark ground: `#22c55e` on `#eef1f6` is **2.1:1**. The light
  values are the same hues one step darker, which keeps "green means ok" while making the badge
  legible — `--status-ok: #15803d`, `--status-waiting: #a15c07`, `--status-failed: #c62828`,
  `--status-running: #1d4ed8`.

Everything else is §6.3's value, or a transparency/lightness step of one, so the palette stays closed.

### Neumorphism on light is the harder case

The soft-UI layer reads `--neu-*` tokens, so the flip was mostly one edit — but every *dimension*
inverts, and two of them are not symmetric:

- **The canvas goes darker than `--bg`**, not lighter. On dark it had to be raised (`#1a1d23`) to give
  the highlight somewhere to travel; on light it has to be recessed (`#e4e9f1`), because the
  highlight already sits at the top of the range.
- **The highlight must be opaque.** `--neu-light: rgba(255, 255, 255, 0.95)` — a translucent white
  over a pale canvas is invisible, so on light it carries no information at all and the whole
  extrusion rests on the shadow.
- **The shadow must be a colour, not darkness.** `--neu-dark: rgba(163, 177, 198, 0.62)` — a
  desaturated blue-grey. Black at low alpha on a pale ground does not read as a shadow; it reads as
  dirt. This is the single change that makes the light theme look intentional.

### No flash, and no JavaScript needed for the common case

Light is what `:root` says, so the app is correct with no script at all. A small **inline,
synchronous** script in `index.html` handles the one case that needs to run before first paint — a
dark preference — because a module import is too late and the user sees a white flash. That script
cannot import the TS module, so the storage key is written twice; `theme.test.tsx` reads
`index.html` and **fails if the two copies drift**.

### The audit that made the flip one edit

Seven places hard-coded a dark-only literal instead of a token — the scrollbar thumb, the table rule,
the row hover, the wordmark's engraving, the scrim, and the search-cancel icon's `invert()` filter.
Each became a per-theme token. A dead `.nav-badge` rule was deleted with them.

`lib/theme.ts` is a `useSyncExternalStore` store, the same shape as `pins.ts`, with a `storage`
listener so two tabs agree. `applyTheme` sets `data-theme` **even for light**, so the current theme is
always readable off the DOM rather than inferred from an absent attribute. 11 tests.

---

## 2. Settings is the third panel tab

`WorkPanel`'s tabs are `'sessions' | 'agents' | 'settings'`, and a single `PANEL_TABS` array is the
only place the three labels are spelled — the tab list, the keyboard order and the test all read from
it, so a fourth tab cannot be half-added.

The new `SettingsTab` holds what the "extra sidebar under the logo" was:

- **Account** — avatar, name, email, tenant.
- **Notifications** — the topbar bell's list, moved intact: unread tint, a real mark-all-read action,
  and `Could not load notifications.` on failure rather than an empty list.
- **Appearance** — Light / Dark chips driving the store above.
- **Sign out**, and a link to the full workspace settings page.

The session filter and the Scheduled jobs section are hidden on this tab, because neither is about
settings.

---

## 3. The topbar is down to two controls

Removed: the **Live** connection indicator, the **logo/account menu**, and the **notification bell**.

Nothing was orphaned. The bell's list and the account card moved into the Settings tab, and the one
deliberate deletion is the connection dot — justified because the composer and the transcript already
say "Offline" at the point where it matters, and `useSseStatus` still drives the Browser page. What
remains is `⌘K Search` and `?` (the keybinding overlay).

The layout change also generalised the flush rule, since the terminal wants the full pane too:

```tsx
const FLUSH_ROUTES = ['/chat', '/cli'] as const;
```

---

## 4. Sandbox and Browser

Both surfaces already existed and are reachable from the rail; the work here was making the terminal
share their vocabulary rather than paraphrase it. `features/sandbox/provider-notes.ts` was extracted
from `SandboxPage.tsx` so the safety sentence about a provider has **one** copy, and the terminal
imports it instead of importing the page.

---

## 5. The terminal — `/cli`

A real terminal: it runs code and prints what came back. The decisions that matter:

**It evaluates JavaScript, and says so before anything else.** The only execution path this product
has is `POST /sandbox/:id/exec`, whose provider evaluates JavaScript in a worker. There is no `ls`, no
`cd`, no pipes — `!command` is already refused by name in the composer. So a terminal that accepted
`ls -la` and printed a plausible directory listing would be the worst kind of lie: not a missing
feature but a **fabricated** one, and one that looks correct until someone relies on it.

The banner says it first, `/help` lists only verbs that exist, and `ls -la` reaches the engine to fail
there with the engine's own message. Verified live:

```
[input] nexs:~$ 1 + 1
[note] Opened session cmuaqg17r003pha2z9ogypx2i · Provider "worker-thread" …
[ok] ⇒ 2
[note] completed · 48 ms · exit 0
[input] nexs:cmuaqg1$ JSON.stringify({ ok: true })
[ok] ⇒ {"ok":true}
[input] nexs:cmuaqg1$ ls -la
[err] ls is not defined
[note] failed · 49 ms · exit 1
```

**The engine evaluates a function body, so a bare expression has to be returned.** `new AsyncFunction(…,
'"use strict";\n' + code)` evaluates `1 + 1` and discards it. Defensible for the agent's tool, where
the snippet is expected to `return`; indefensible for a terminal, where the first thing anyone types is
an expression. `lib/cli.ts:prepareCode` therefore wraps a line that is a **single expression** in
`return (…)` — the implicit print a REPL gives you, and the reason `{ a: 1 }` works here.

The check is a **compile, not a guess**: a constructor compiles a body without running it, so asking it
to compile `return (<line>);` is a side-effect-free syntax test. It uses the **async** constructor, the
same one the sandbox uses, because a plain `Function` body rejects `await` and would silently drop the
value of `await fetch(…)`.

`prepareCode` only ever **adds** a wrapper; it never rewrites the line inside it. That matters, because
`ls -la` is `ls - la` to a JavaScript parser — subtraction — so it *is* wrapped, and it still fails in
the engine with `ReferenceError: ls is not defined`. A wrapper that recognised it as a shell word and
answered it would be the fabricated shell this file exists to refuse; a wrapper that cannot rewrite a
line cannot fabricate an answer for one. `cli.test.ts` asserts that invariant directly, over a list of
inputs including shell words.

**A session is a server row, so it is opened on demand.** The first line that needs one creates it —
not mount. The transcript shows `Opened session …` once, and the prompt changes from `nexs:~$` to
`nexs:cmuaqg1$`, so the second line visibly reuses it. Verified on the wire: one `POST /api/sandbox`
(201), then three `POST /api/sandbox/<id>/exec` (200).

**Errors are the engine's own words.** `submit` appends `messageOf(error)` rather than a rewrite: a
failed evaluation has a real reason, and paraphrasing it here would be a worse answer than the one the
runtime already wrote.

---

## 6. What the work uncovered

Three real defects, all found by driving the running app rather than by reading the code.

### 6.1 Every catalogue filter the chat page sent was a 400

`useModels({ enabled: true })` serialised to `?enabled=true`, and `useTools({ search })` to
`?search=…`. Every list schema in `@nexs/shared` is **`.strict()`**, so an unrecognised key is not an
ignored parameter — it is `400 VALIDATION_ERROR`. Measured against the running server:

| request | status |
| --- | --- |
| `/api/models?enabled=true` | **400** `unrecognized_keys: ["enabled"]` |
| `/api/models?enabledOnly=true` | 200 |
| `/api/tools?search=file` | **400** `unrecognized_keys: ["search"]` |
| `/api/tools?q=file` | 200 |
| `/api/schedules?enabled=true` | **200** — this schema really does take `enabled` |

So the chat composer's model picker and the Tools page's search box were asking a question the server
refused to parse, and both rendered their **empty state**, which is indistinguishable from "no rows".
It survived every test because the names are plausible — `enabled` is correct for schedules, and a
search box is a natural thing to call `search` — and because no test ever asserted the query string.

The filters are now named as the server names them, and `features/catalog/queries.test.tsx` parses
every query string the hooks build against the **real** schema. `ModelFilters` and `ToolFilters` are
also checked as `Required<…>` literals, so adding a field to an interface without teaching the schema
about it breaks at compile time.

### 6.2 The terminal printed its banner twice

The comment above the code read *"printed once, on the first render, rather than in an effect — an
effect would print it a second time under React's development double-invoke"* — and the code was an
effect. The comment was right and the code ignored it.

The fix is initial state, not an effect: a lazy initialiser cannot double-print, because React keeps
one result even when it calls the initialiser twice.

The reason 14 tests missed it is the more useful finding: **`renderCli` did not wrap the page in
`StrictMode`, while `main.tsx` does.** The suite was testing a tree the app never renders. It now
mounts inside `StrictMode`, so anything this page does in an effect is exercised twice, as a user
experiences it.

### 6.3 The value was never printed

`1 + 1` ran successfully and printed `completed · 48 ms · exit 0` — and no `2`. The cause is the
function-body evaluation described in §5: the expression was evaluated and discarded. The fix is
`prepareCode`, and the banner now states which form prints and which does not, because a user cannot
guess it and will otherwise meet it as silence.

### 6.4 An unrelated pre-existing lint failure

`pnpm lint` was failing on `apps/server/src/services/gateway/adapters/google.ts` — `parseJsonArgs` is
defined but never used. It is a copy of `openai.ts`'s helper, which *is* used there because OpenAI
delivers tool-call arguments as a JSON **string**; Gemini delivers `functionCall.args` as a **Struct**,
already an object, so there is nothing to parse. The correct fix was to delete it, not to wire it up.
A note at the call site records why, so it is not copied back.

This is in server code untouched by this work. It is listed because the gate is red without it and
because the reasoning is not obvious from the diff.

---

## 7. Verification

**Gate, after the last edit** — lint **3/3** · typecheck **4/4** · build **3/3** ·
test **3/3** — **web 326 passed / 18 files** (was 302/17; +24) and **server 1527 passed / 73 files**.

**Driven in a real browser** (`%TEMP%\nexs-verify\`, headless Chrome over the DevTools Protocol),
logged in as `dev@nexs.local` through the Vite-proxied API:

- `theme: "light"`, canvas `rgb(238, 241, 246)`, no horizontal overflow on six routes.
- `TABS ["Sessions","Agents","Settings"]` with `aria-selected` correct before and after a real click on
  Settings; the tab body shows account, three unread notifications, and the Light chip pressed.
- The dark toggle drives `data-theme="dark"`, canvas `rgb(26, 29, 35)`, `stored: "dark"`.
- The topbar reads `⌘K Search ?` — two buttons.
- `/api/models?enabledOnly=true` → **200** on the chat page, where it used to be a 400.
- The terminal transcript in §5, with `PROBLEMS []` — no exceptions, no console errors.

Two traps cost time and are worth recording. The first: chaining the gate with `&&` produced a
**phantom green** — an early failure short-circuited the chain, `$OUT` was never assigned, and the
loop ran every command with an empty redirection while still printing "done". The gate is a script
now. The second: clearing `dist` from inside a **background** task hangs, because the safe-delete
guard's prompt cannot be answered there, and a `while` loop that re-`find`s the same files spins
forever. Clear build output in the foreground.

---

## 8. Deliberate deviations and open items

- **Two §6.3 values changed** (`--accent`, the status colours), with the contrast ratios above. This is
  the only place the light palette departs from the spec.
- **The terminal wraps a single expression.** The transcript shows the line as typed; the banner and
  `/help` state the rule; `prepareCode` is the only place a typed line is altered.
- **`/cli` is a route, not a panel.** It sits beside `/sandbox` and `/browser`, and is in the rail's
  Capabilities group and the primary actions.
- **Still open:** Playwright e2e for the approval drawer (Phase 14 item 3, unchanged by this work).
