/**
 * The keybinding table (§8), as data.
 *
 * ## What this file is, and what it is not
 *
 * It is the **reference** — the table the help overlay renders and the tests enumerate. It is
 * *not* the dispatcher: `useKeyboardShortcuts` and the composer own their own handling, because
 * the two have different guards (the composer's keys only mean anything while its textarea has
 * focus, the global ones must not fire there at all) and routing them through one table would
 * mean a table that also had to encode "which element has focus".
 *
 * ## Why the spec's table is not copied wholesale
 *
 * A browser tab cannot do several of these honestly, and shipping the row anyway would be a
 * documented key that does nothing:
 *
 *  - `Ctrl+Z` (SIGTSTP) and `Ctrl+D` (EOF on a tty) are terminal signals. A page cannot suspend
 *    itself or close its own tab without lying about what happened.
 *  - `Ctrl+V` reading the *system* clipboard as an image is a permission prompt, not a read, and
 *    OSC 52 has no meaning outside a terminal.
 *
 * So those rows carry `supported: false` with the reason, and the help overlay renders them
 * under a heading that says they are terminal-only. The alternative — omitting them — would make
 * the overlay disagree with the spec it is derived from, which is worse than a labelled gap.
 */

/** Where a binding applies. The composer's keys are inert unless its textarea has focus. */
export type BindingScope = 'composer' | 'global' | 'modal';

/**
 * Why a binding is not available here.
 *
 * `null` means it is implemented. A string is the **reason it is not**, phrased as something a
 * user can read — the overlay shows it verbatim rather than as a tooltip, because a disabled row
 * with no explanation is the thing this project refuses to ship.
 */
export type UnsupportedReason = string | null;

export interface KeyBinding {
  /** How it is written on screen. `⌘` vs `Ctrl` is resolved at render time by `primaryModifier`. */
  keys: string;
  /** Additional accepted spellings, e.g. the spec's `Ctrl+X Ctrl+E` for the editor bridge. */
  aliases?: readonly string[];
  scope: BindingScope;
  label: string;
  /** The section of §8 it came from, for the overlay's grouping. */
  group: string;
  /** `null` when implemented; the reason string when this surface cannot do it. */
  unsupported: UnsupportedReason;
}

/**
 * The primary modifier's name for this platform.
 *
 * Read once at module load rather than per render: `navigator.platform` does not change, and a
 * function that re-derived it would return a different string in a jsdom test than in a browser
 * for no benefit. `undefined` navigator (a non-DOM context) falls back to `Ctrl`.
 */
export const PRIMARY_MODIFIER: string =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform ?? '')
    ? '⌘'
    : 'Ctrl';

/** The spec's table, with each row's availability stated. */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  // ── composer ────────────────────────────────────────────────────────────────
  {
    keys: 'Enter',
    scope: 'composer',
    label: 'Send the message, or accept the open completion',
    group: 'Composer',
    unsupported: null,
  },
  {
    keys: 'Shift+Enter',
    aliases: ['Alt+Enter', 'Ctrl+J'],
    scope: 'composer',
    label: 'Insert a newline',
    group: 'Composer',
    unsupported: null,
  },
  {
    keys: 'Ctrl+G',
    scope: 'composer',
    label: 'Open the draft in an external editor',
    group: 'Composer',
    // There is no external editor to hand a browser's textarea to, and `$EDITOR` does not exist
    // on the client. The editor bridge is a real affordance for a *terminal*; in a tab the
    // equivalent is "the textarea is already a full editor", which is what the overlay says.
    unsupported: 'No external editor: the draft is already a text area in the page',
  },
  {
    keys: 'Ctrl+S',
    scope: 'composer',
    label: 'Stash the draft, or restore the last one',
    group: 'Composer',
    unsupported: null,
  },
  {
    keys: 'Ctrl+J',
    scope: 'composer',
    label: 'Insert a newline (terminal-safe alias of Shift+Enter)',
    group: 'Composer',
    unsupported: null,
  },
  {
    keys: '!command',
    scope: 'composer',
    label: 'Run a shell command without an LLM turn',
    group: 'Composer',
    // Not just unimplemented — *unavailable by design*. This page has no shell, and the only
    // shell it could reach is the sandbox, which is a run-scoped worker rather than the operator's
    // own machine. Offering it would be the single most dangerous affordance in the product.
    unsupported: 'This deployment has no operator shell; use a Sandbox session',
  },
  {
    keys: 'Tab',
    scope: 'composer',
    label: 'Accept the highlighted completion',
    group: 'Composer',
    unsupported: null,
  },
  {
    keys: 'Ctrl+V',
    scope: 'composer',
    label: 'Paste, including an image from the clipboard',
    group: 'Composer',
    // `paste` events do carry clipboard images in a browser, and the composer handles files. What
    // is *not* available is the terminal path (OSC 52), which the spec names in the same row.
    unsupported: null,
  },

  // ── global ──────────────────────────────────────────────────────────────────
  {
    keys: 'Ctrl+K',
    aliases: ['⌘K'],
    scope: 'global',
    label: 'Open the command palette',
    group: 'Global',
    unsupported: null,
  },
  {
    keys: 'Ctrl+X',
    aliases: ['Ctrl+K'],
    scope: 'global',
    label: 'Open the session switcher',
    group: 'Global',
    unsupported: null,
  },
  {
    keys: 'Ctrl+T',
    aliases: ['F6'],
    scope: 'global',
    label: 'Open the subagent roster',
    group: 'Global',
    unsupported: null,
  },
  {
    keys: 'F7',
    scope: 'global',
    label: 'Condense or expand the subagent dock',
    group: 'Global',
    unsupported: null,
  },
  {
    keys: 'Ctrl+C',
    scope: 'global',
    label: 'Stop the streaming turn (press twice to force)',
    group: 'Global',
    // A *global* `Ctrl+C` is copy in a browser, and intercepting it would break the one key every
    // user already knows. The stop affordance is the Send button becoming Stop, plus `Esc`.
    unsupported: 'Ctrl+C is the browser’s copy key; use the Stop button or Esc',
  },
  {
    keys: 'Ctrl+D',
    scope: 'global',
    label: 'Exit the session',
    group: 'Global',
    unsupported: 'A page cannot close its own tab; sign out from the user menu',
  },
  {
    keys: 'Ctrl+Z',
    scope: 'global',
    label: 'Suspend to the background',
    group: 'Global',
    unsupported: 'Suspending a process is a terminal signal a page cannot send',
  },
  {
    keys: 'Esc',
    scope: 'modal',
    label: 'Dismiss the open overlay',
    group: 'Global',
    unsupported: null,
  },
];

/** Everything implemented here, for the overlay's default view. */
export function supportedBindings(): KeyBinding[] {
  return KEY_BINDINGS.filter((binding) => binding.unsupported === null);
}

/** Everything this surface cannot do, with the reasons — shown rather than hidden. */
export function unsupportedBindings(): KeyBinding[] {
  return KEY_BINDINGS.filter((binding) => binding.unsupported !== null);
}

/**
 * The reason a key does nothing here, or `null` when it works.
 *
 * The composer and the help overlay both need this sentence. Reading it out of the table —
 * rather than each writing its own — is what stops the two from disagreeing: a `!command`
 * refused in the composer with one sentence and listed in the overlay with another would be
 * two answers to the same question, and the user has no way to tell which is true.
 *
 * Matched on `keys` exactly, including the leading `!` in the spec's own spelling. A miss
 * returns `null`, so an unimplemented key cannot accidentally inherit a neighbour's excuse.
 */
export function unsupportedReasonFor(keys: string): UnsupportedReason {
  const binding = KEY_BINDINGS.find((entry) => entry.keys === keys);
  return binding?.unsupported ?? null;
}

/** The bindings grouped in the spec's own order, for the overlay. */
export function bindingsByGroup(
  bindings: readonly KeyBinding[] = KEY_BINDINGS,
): { group: string; bindings: KeyBinding[] }[] {
  const groups: { group: string; bindings: KeyBinding[] }[] = [];
  for (const binding of bindings) {
    const existing = groups.find((entry) => entry.group === binding.group);
    if (existing === undefined) groups.push({ group: binding.group, bindings: [binding] });
    else existing.bindings.push(binding);
  }
  return groups;
}
