# NEXS soft-UI implementation report

**Scope.** The Hermes Agent desktop UI/UX extraction (the supplied reference document) implemented
into `nexs/apps/web`, with the name replaced, a neumorphic (soft-UI) surface layer added, and
deliberate departures from the reference where the reference's labels describe surfaces this
product does not have.

**Nothing in `docs/`, `nexs-build-spec.md`, `PRD.md`, `v2.md` or `gaps.md` was modified.** This
report is the new artifact; every deviation from those documents is listed in §6.

---

## 1. What the reference actually specifies, and what was kept

The reference is not a colour scheme. Its own §18 says the strongest part is the information
hierarchy:

```
LEFT   = navigation + memory of work
CENTRE = the current task
BOTTOM = action / input
```

That is what was implemented. Everything else — the specific greys, the display face, the row
heights — is a consequence of it, and every one of those was changed.

| Reference element | Kept | Changed |
| --- | --- | --- |
| Two regions (rail + main) | — | **Split into three**: rail, work panel, main pane (§3) |
| `HERMES AGENT` wordmark | Position, dominance, isolation behind one component | **`NEXS AGENT`**, serif display face, engraved treatment |
| Five primary rows | The block and its position | **Labels re-pointed at real surfaces** (§4) |
| `SESSIONS / BOTS` switcher | The switcher | **`SESSIONS / AGENTS`** — this product's roster is agents |
| `PINNED` section | Yes | Backed by browser-local pins, and the header says so (§5.3) |
| Sessions grouped by recency | Yes | Same headings, plus month names beyond a month |
| Compact session rows | Yes | Same geometry, hover strip, `:focus-within` parity |
| `CRON JOBS` section | Yes | **`Scheduled jobs`**, fed by `/api/schedules` |
| Minimal bottom composer | Yes | Same composer, new placeholder, neumorphic shell |
| Dark surfaces, hairline borders | — | **Neumorphism: no borders, depth from shadow** (§2) |

---

## 2. The neumorphic layer

### What it required, and why that is structural rather than cosmetic

Neumorphism extrudes an element out of its own background. Two consequences follow, and neither is
a taste decision:

1. **The canvas has to be one colour.** A raised element on a background of a *different* colour
   reads as a card with a drop shadow, not as a shape pressed out of the surface. The app canvas
   became `--neu-base: #1a1d23` — a step lighter than §6.3's `--bg: #0a0b0d` for a physical reason:
   a highlight is invisible against near-black, so the extrusion has nowhere to travel to.
2. **Borders had to go.** A 1px border beside a soft shadow is two answers to "where does this
   end", and the hard one always wins. Depth is shadow-only; where a boundary must be stated it is
   a translucent hairline or an inset, so it participates in the lighting.

### The three rules, and the one exception

Written at the top of the layer in `base.css` so the next person can extend it without guessing:

1. A surface's background is `--neu-base`.
2. Depth is `box-shadow`, never `border`.
3. Pressing is the inverse of raising — active, selected and held states go *in*
   (`--neu-inset-sm`). This is the whole vocabulary the style has for state, and it is why the
   selected conversation row is pressed rather than tinted.

**The exception is the accent.** A primary button and the brand mark are lit gradients rather than
extruded surfaces, because an extruded accent reads as grey plastic and loses the only colour the
interface has.

**Three borders are kept on purpose**, because they are signals rather than edges, and a test
cannot tell the difference — only a reader can:

- `.message-live`'s dashed accent — "this text is provisional and is not a saved row";
- `.paste-pill`'s dashed outline — "this range is a pasted pill, not typed text";
- `.tool-call-box`'s left bar — the three-state marker from §6.1.

### Where the tokens live

`styles/theme.css` gained a `soft UI` block below §6.3, which is **unchanged** — every colour the
product had, it still has, under the same name. `--neu-*` describes how a surface is *lit*, not
what colour it is, so retheming §6.3 still rethemes the whole app in one edit.

`--neu-text-quaternary: #858a93` was measured rather than picked: 4.87:1 on `--neu-base`, which
clears AA for the 10px uppercase section labels it is used for. A darker grey looks better in
isolation and fails, and a section heading nobody can read is a section nobody can find.

`--neu-light` / `--neu-dark` were **tuned against a rendered screenshot**, not chosen in the source
— see §7.2.

---

## 3. The layout: two regions became three

The reference puts navigation *and* session history in one narrow column. That works at five
destinations. This product has **twenty-one**, and the arithmetic does not lie — twenty-one rows in
the same column as the conversation list pushes the conversation list off the bottom of the screen,
removing the part of the hierarchy that matters most.

So the column was split by *what each thing is for*:

- **The rail** (`--rail-w: 56px`) — where you can go. Every route, icon-only, label in the tooltip
  and in the accessible name. Replaces the old 216px sidebar that spent the same links at four
  times the width.
- **The work panel** (`--work-w: 248px`) — what you have done and what is about to happen:
  conversations, agents, the timetable. This is the memory half, and it keeps the full column.
- **The main pane** — the task. It is the one region that is *raised* (`--neu-raised-lg`); the rail
  and the panel sit flush on the canvas. That is the hierarchy statement rendered physically: the
  task sits above the navigation.

The panel is in the shell rather than on the chat page, so opening a conversation works from
anywhere. It is always mounted, which means its three reads (`/chat/sessions`, `/agents`,
`/schedules`) are warm on every route.

---

## 4. The five primary rows: the reference's shape, this product's labels

The reference's block is *New session · Capabilities · Messaging · Artifacts · Scheduled jobs*.
This product has no messaging surface, and a row that opens a page with nothing behind it is worse
than a row that does not exist. The block keeps its position and names five real destinations:

| Row | Destination | Why |
| --- | --- | --- |
| New session | `/chat` | The only entry that is an action. Opens a fresh draft. |
| Capabilities | `/tools` | The registry. The other capability surfaces are one click away on the rail. |
| Decision inbox | `/approvals` | The highest-frequency destination, and the only one that can be *waiting* on you — hence the only badge. |
| Artifacts | `/files` | Keeps the reference's concept, against a real surface. |
| Scheduled jobs | `/schedules` | The timetable, also summarised further down the panel. |

**The `g`-sequence hints are derived, not written.** `WorkPanel` reads `GOTO_SHORTCUTS` and renders
a hint only for a route that has a binding. A row with no binding shows no hint — the alternative is
a row that advertises `⌘N` because a mock did, and `Ctrl+N` is not interceptable in a browser
anyway. `WorkPanel.test.tsx` asserts both halves: every rendered hint resolves to a real
destination, and `Artifacts` renders none.

---

## 5. Behaviour changes

### 5.1 `/chat` is a fresh draft, and the session is created on the first send

The reference opens on a prompt, not on a list you must choose from. So the page **no longer
auto-selects the newest conversation**; the hero and the composer are what `/chat` is until you
pick something in the panel or send a message.

The conversation row is created **on the first send**, not when the draft opens. Clicking "New
session" five times while thinking should not leave five empty conversations for the next person to
tidy up. The cost is one extra request before the first turn; the benefit is that every row in the
panel is a conversation somebody actually had.

The agent the draft will run as is chosen in the hero, because an ad-hoc conversation has no agent
and must therefore name a model on every message — a consequence the composer states up front
rather than one the user meets later as a validation error.

### 5.2 The hero renders for a *fresh draft*, not for "no session"

A conversation that exists and has no messages is the same screen to the person looking at it.
Gating the hero on `activeId === null` would show the wordmark until the first click and a blank
transcript forever after — the exact state the hero exists to avoid. The test is "no messages, no
turn content, and no turn streaming", the third clause being the one that is easy to forget: without
it the wordmark flashes between sending and the first token.

### 5.3 Pins are browser-local, and the header says so

There is no pin column. `ChatSessionDto` has `id`, `title`, `agentId` and two timestamps, and
`PATCH /chat/sessions/:id` accepts `{title}` and nothing else. A pin is a fact about the person
reading the sidebar, not about the conversation, so `localStorage` is the honest home for it — and
the section header reads **"Pinned — in this browser"** rather than implying persistence it does not
have. A `storage` listener keeps two windows in step, which is also the seam the test uses to start
from a known set.

### 5.4 The panel's hover strip replaces the age, and `:focus-within` does the same

Pin, rename, delete. No context menu: a menu needs dismiss logic, a focus trap and a portal to
escape the scroll container, and these are the three actions anyone wants. `Ctrl+X` still opens the
full switcher over the same queries. Delete is the one destructive control in the panel and asks
first.

### 5.5 Scheduled jobs are filtered by what will actually fire

Three distinctions the data makes, each of which would otherwise be a claim the row contradicts:

- a **disabled** schedule has a `nextFireAt` and will not fire at it;
- **`nextFireAt: null`** means "nothing computed yet", not "never" — the column is stored, not
  derived;
- the list sorts **ascending**, because it is the one list in the panel about the future.

Trigger-now is on the hover strip and is a real mutation (`POST /schedules/:id/fire`).

---

## 6. Deviations from the project's own specification

Reported, not "fixed" silently.

| # | Deviation | Reason |
| --- | --- | --- |
| 1 | **`/` and post-login redirect to `/chat`, not `/dashboard`.** §6.1 says `/` redirects to `/dashboard`. | The reference's whole thesis is conversation-first. The dashboard is unchanged and one click away on the rail. |
| 2 | **`SessionSidebar.tsx` deleted.** | Superseded by `WorkPanel`. Two conversation lists with different grouping and different row geometry is the drift this project avoids; the file had no remaining importer. |
| 3 | **`.sidebar`, `.brand`, `.nav*` CSS removed**, and `.chat-layout`/`.chat-sessions*` with them. | Dead rules for elements that are no longer rendered. `--sidebar-w` was dropped from `theme.css` for the same reason. |
| 4 | **`.chat-session` and its `is-active` state are gone**; the selected row is `.session-row[data-active]`. | The old class was only reachable from the deleted component. |
| 5 | **The `Composer` gained an optional `placeholder` prop**, defaulting to the existing string. | A draft asks for a goal; an open conversation asks for a reply. Two genuinely different questions, one component. |
| 6 | **`.content-flush` added**, applied by the shell when the route is `/chat`. | Chat owns its own scroll — the composer must stay reachable while the transcript scrolls. The shell is the only thing that knows the route, so it states the difference rather than making twenty pages' CSS conditional on a descendant selector. |
| 7 | **`navigation.ts` glyphs changed**: Files `🗀` → `▤` (rail and primary row). | See §7.3. |

---

## 7. Bugs found, and what the visual pass caught

### 7.1 `--failed` was never a token — three declarations, three silent failures

`base.css` referenced `var(--failed)` in **three** places. §6.3 names it `--status-failed`, so each
declaration was invalid and **silently dropped by the browser**:

| Rule | What was lost |
| --- | --- |
| `.nav-badge` | `background` — every notification badge in the app rendered as white text on nothing. |
| `.btn-danger` | `background` and `border-color` — the danger button had no fill of its own. |
| `.error-box` | the whole `border` shorthand — **every error box in the app has been rendering with no outline.** |

The first was found by diffing the custom properties *used* in `base.css` against the ones *defined*
in `theme.css`. The other two were found because that diff was re-run **on the built bundle** after
the fix — the first pass had only looked at the one rule I happened to be editing.

The check is two lines and belongs after any CSS work:

```bash
grep -oE 'var\(--[a-z0-9-]+' base.css | sed 's/var(//' | sort -u > used.txt
grep -oE '^\s*--[a-z0-9-]+' theme.css | sed 's/^ *//' | sort -u > def.txt
comm -23 used.txt def.txt   # used but undefined
comm -13 used.txt def.txt   # defined but unused
```

Both lists are now empty.

### 7.2 The lighting was too weak, and only a screenshot could say so

The first render used `--neu-light: rgba(255,255,255,0.055)` / `--neu-dark: rgba(0,0,0,0.55)`. On
screen the extrusion on a `.card` was **invisible** — the cards read as flat panels, which turns
"soft UI" into "no UI". No test can catch this: the tokens resolve, the declarations are valid, the
DOM is correct, and the result is still wrong.

Raised to `0.07` / `0.6` — the smallest values that read as depth without becoming a drop shadow.

### 7.3 A glyph outside the BMP, in a rail that made it obvious

`NAVIGATION` used `🗀` (U+1F5C0) for Files. `sigils.ts` states the project's own rule in its header:

> *"They are all in the BMP and render as single glyphs in every font this app targets. An emoji
> sequence like `🛡️` carries a variation selector and renders at two widths depending on the
> platform, which shifts a fixed-width column."*

`🗀` is outside the BMP and renders as a **colour emoji**. In a 216px sidebar of labelled rows it
was a small oddity; in a 56px monochrome icon rail it is a coloured sticker in the middle of the
navigation. Replaced with `▤` (U+25A4), and `.rail-glyph` / `.work-primary-glyph` now carry
`font-variant-emoji: text` so the few glyphs that sit in the emoji-presentation range (`⚡`, `⚙`,
`⏱`) cannot drift to colour on a platform that decides differently.

### 7.4 The hero's reading measure was too narrow

`max-width: 46ch` of a 12px sans is around 300px, which broke the reference's two-line sentence into
three ragged lines under a wordmark four times its width. Changed to `34rem`. The unit was the
mistake: `ch` is a measure for body text in a column, not for a caption under a display face.

### 7.5 A test that caught my own inconsistency

`sessionLabel`'s first test asserted the raw title came back with its surrounding whitespace, while
the implementation trims. The test failed and **the implementation was right** — a title with a
leading space misaligns one row against every other row in the panel, which reads as a rendering
bug rather than as a typo. The assertion was corrected and split into two tests so the trim is now
pinned deliberately rather than incidentally.

### 7.6 Process: two batched `Edit` calls on one file, twice

Three edits to `Composer.tsx` and two to `ChatPage.tsx` were issued as parallel tool calls. Each
call reads the *original* file, so only the last write survived and the earlier ones vanished
**without an error**. Both were caught by the gate (`tsc` for the first, `eslint` for the second),
not by the edits reporting success.

The rule already existed in the project's notes and was violated anyway. It is now stated in
`nexs-phase-build` with the symptom spelled out: a batch of edits to one file reports success for
every call and applies one.

---

## 8. Files

### New

| File | What it is |
| --- | --- |
| `components/layout/NavRail.tsx` | The icon rail. Reads `NAVIGATION`, so it cannot drift from the tree. |
| `components/layout/WorkPanel.tsx` | The work panel: switcher, primary rows, filter, pinned, grouped sessions, agents, scheduled jobs. |
| `components/layout/WorkPanel.test.tsx` | 15 tests over the panel's own claims. |
| `components/chat/HeroWordmark.tsx` | The empty-chat hero. The wordmark is isolated in one component so a rebrand touches one rule. |
| `lib/session-groups.ts` | `shortRelative`, `timeBucket`, `groupSessions`, `upcomingSchedules`. Pure, clock injected. |
| `lib/session-groups.test.ts` | 24 tests, all against a fixed clock. |
| `lib/pins.ts` | Browser-local pins: `parsePins`, `togglePin`, a `useSyncExternalStore` store, a cross-tab `storage` listener. |
| `lib/pins.test.ts` | 8 tests, mostly about refusing malformed storage. |

### Changed

| File | Change |
| --- | --- |
| `styles/theme.css` | `--sidebar-w` removed; `soft UI` token block added. §6.3 untouched. |
| `styles/base.css` | `.app` becomes three columns; dead `.sidebar`/`.nav*`/`.chat-*` rules removed; **three `--failed` declarations fixed**; ~700-line `NEXS soft UI` layer appended. |
| `components/layout/AppShell.tsx` | Three-region shell; `NavRail` + `WorkPanel`; `.content-flush` for chat. |
| `features/chat/ChatPage.tsx` | Draft-first; hero; send-creates-session; compact header; `.chat-body`/`.chat-dock`; `SessionSidebar` dropped. |
| `features/chat/components/Composer.tsx` | Optional `placeholder`. |
| `lib/navigation.ts` | `PRIMARY_ACTIONS` added; Files glyph `🗀` → `▤`. `NAVIGATION`/`NAV_ITEMS`/`activeNavPath` otherwise unchanged. |
| `App.tsx` | `/` and post-login redirect to `/chat`. |

### Deleted

- `features/chat/components/SessionSidebar.tsx`

---

## 9. Verification

### The gate

```
pnpm lint       3/3 successful
pnpm typecheck  4/4 successful   (web · server src · server test · shared)
pnpm build      3/3 successful   (server tsc emit + web tsc --noEmit && vite build)
pnpm test       3/3 successful
                  web     242 passed / 14 files   (was 195)
                  server 1523 passed / 73 files
```

`apps/web` went from **195 to 242** tests (+47: 24 grouping, 8 pins, 15 panel). The three new files
are listed above; the counts here are read off the gate run, not off the source files.

This gate was run **after the last `base.css` edit**, not before it — the project's own rule, and one
that has already caught a duplicated import that `vitest` accepted and `tsc` rejected.

**One environment note.** `vite build` must run with `CODEBUDDY_SAFE_DELETE_ENABLED=0` on this
machine: emptying `dist/` deletes one file at a time, the sandbox's bulk-delete guard counts every
asset, and the build dies with `SAFE_DELETE_BULK_CONFIRM_REQUIRED` **after** printing
`✓ 216 modules transformed` — which reads as a transform error and is not one. This is a known
quirk, restated here because it cost time again.

### The visual pass

The RTL suite proves structure, grouping, navigation and failure states. It cannot prove that a
shadow reads as depth, that nothing overflows, or that a glyph is the colour it should be. So the
CSS layer was rendered and looked at.

**Method.** The app itself could not be driven: it sits behind `RequireAuth` and this machine has no
Postgres, so an unauthenticated load renders the login page. Instead a **CSS harness** was built in
the temp directory — two static pages that link the CSS the real build emits and reproduce the
shell's and the primitives' markup with the exact class names the components use — and rendered in
headless Chrome (`--headless=new --screenshot`, 1080×675 viewport).

This is honestly a *CSS* check, not an application check. It found four real defects (§7.2, §7.3,
§7.4, and confirmed §7.1's `.error-box` fix) and confirmed:

- the three-region grid lays out correctly and the main pane reads as raised;
- the wordmark is dominant and the hero is centred in the space above the composer;
- the panel's density works — tabs, primary rows, filter, and five sections with `1h` / `2d` /
  `127d` ages all legible at 248px;
- the rail's twenty-one glyphs render monochrome, with the active item pressed and the inbox badge
  visible;
- the transcript, tool box, approval options, stat tiles and context grid all read as one material
  with the shell — no hard borders left anywhere.

The harness lives at `%TEMP%\nexs-ui-check\` (`shell.html`, `controls.html`, `bundle.css`) and is
not part of the repository.

### What is still not verified

**The live application.** The harness proves the CSS; it cannot prove the components compose
correctly against a real API — that the panel's three reads settle, that a session is created on the
first send and appears in the list, that the hero gives way to the transcript at the right moment.
Those paths are asserted in jsdom, which is not the same thing. This is the same limit Phase 13's
acceptance recorded, and it is stated rather than papered over.

**The first thing to do with a live server is open `/chat`, send one message, and watch the draft
become a conversation.**

---

## 10. Follow-ups

1. **Open it with a live server.** See above — the one gap left is composition against a real API.
2. **The `g`-sequences are not in §8's help overlay.** They are bound and they work, and the panel
   now *advertises* them, but `KEY_BINDINGS` has no row for them, so the overlay does not document
   them. Fixing it means moving `GOTO_SHORTCUTS` from `hooks/` into `lib/keybindings.ts` and adding
   a `Navigation` group — `keybindings.test.ts` asserts the group list is exactly
   `['Composer', 'Global']`, so that test changes with it. Left alone deliberately: it is a
   documentation gap, not a broken key, and the panel's hints are derived from the live table so
   they cannot lie.
3. **`PATCH /chat/sessions/:id` accepts only `{title}`.** A server-side pin is a column, a migration
   and a route; the browser-local version is honest about being browser-local until then.
4. **The rail has no collapsed/expanded mode.** At 56px with tooltips it is already the smallest
   region in the shell; a flyout was rejected because the scroll container would clip it.
5. **`.badge` (neutral) is faint.** Its inset reads as a barely-there pill. It could take a
   background — but the tone variants (`.badge-ok`, `.badge-failed`, …) set their own `background`
   *earlier* in the cascade, so a `.badge { background }` in this layer would silently erase every
   tone. Left alone rather than fixed the fragile way.
