/**
 * The prompt stash stack (§3.3).
 *
 * The spec's mechanic, restated as rules because each one is a decision:
 *
 *  - `Ctrl+S` with text in the composer **stashes** it and clears the input, so an urgent
 *    command can be typed without losing the draft.
 *  - `Ctrl+S` on an **empty** composer **pops** the most recent draft back in.
 *  - More than one stash opens a **browse overlay** (↑/↓ to move, Enter to restore, D to
 *    discard) rather than popping blindly, because popping the wrong draft is the kind of
 *    loss a user cannot undo.
 *
 * ## Why this is a stack and not an array with an index
 *
 * The spec calls it a stack and the operations are push and pop, but the browse overlay needs
 * random access — restore the *third* one. So the structure is an array with the **newest at
 * the end**, which is both a stack (`push`/`pop`) and a list the overlay can index. Modelling it
 * as an array with the newest at the *front* would make the overlay's cursor mean "offset from
 * newest", which reads backwards in the UI.
 *
 * ## Why the items carry an id
 *
 * React needs a stable key, and a draft's text is not stable — two stashes of the same text are
 * possible, and the overlay's cursor would jump between them. The id is generated here rather
 * than derived, so reordering or discarding cannot make two items collide.
 *
 * ## Bounded
 *
 * `STASH_LIMIT` is enforced on push by dropping the **oldest**. A user who stashes fifty drafts
 * has lost track of them anyway, and an unbounded in-memory list is a leak with extra steps.
 */

export interface StashedPrompt {
  id: string;
  text: string;
  /** When it was stashed, for the overlay's ordering and its "5 minutes ago". */
  stashedAt: number;
  /** Caret position at the moment of stashing, so restoring puts the cursor back. */
  caret: number;
}

/** How many drafts are kept. Older ones are dropped on push, and the overlay says so. */
export const STASH_LIMIT = 20;

/**
 * A counter rather than `crypto.randomUUID`.
 *
 * The id is used as a React key inside one component's list, never on the wire and never as a
 * persistence key — so the only requirement is uniqueness within a session. A counter is
 * cheaper, deterministic, and does not depend on a secure-context API that jsdom does not
 * always expose.
 */
let sequence = 0;

function nextId(): string {
  sequence += 1;
  return `stash-${sequence}`;
}

/**
 * Push a draft, returning the new stack.
 *
 * A blank draft is **not** stashed. `Ctrl+S` on empty is the *pop* gesture, and stashing an
 * empty string would make the two gestures indistinguishable — the user would press it once to
 * clear their input and find they had pushed nothing and popped nothing.
 */
export function stash(
  stack: readonly StashedPrompt[],
  text: string,
  caret: number,
  now: number = Date.now(),
): StashedPrompt[] {
  if (text.trim() === '') return [...stack];
  const next = [...stack, { id: nextId(), text, caret, stashedAt: now }];
  // Drop from the front — the oldest — so the newest `STASH_LIMIT` survive.
  return next.length > STASH_LIMIT ? next.slice(next.length - STASH_LIMIT) : next;
}

/**
 * Pop the most recent draft.
 *
 * Returns the stack *without* it and the item itself, or the stack unchanged and `null`. The
 * caller cannot pop and keep the item by mistake, because the only way to get the item is to
 * accept the reduced stack in the same return.
 */
export function popStash(stack: readonly StashedPrompt[]): {
  stack: StashedPrompt[];
  item: StashedPrompt | null;
} {
  if (stack.length === 0) return { stack: [...stack], item: null };
  const item = stack[stack.length - 1] ?? null;
  if (item === null) return { stack: [...stack], item: null };
  return { stack: stack.slice(0, stack.length - 1), item };
}

/** Discard one by id — the overlay's `D`. A miss is a no-op rather than an error. */
export function discardStash(
  stack: readonly StashedPrompt[],
  id: string,
): StashedPrompt[] {
  return stack.filter((item) => item.id !== id);
}

/**
 * Take one out by id, for the overlay's `Enter`.
 *
 * Different from `discardStash` in the obvious way and in one subtle one: the item is returned,
 * so the caller restores it to the composer. Returning only the reduced stack would leave the
 * caller to find the text itself — and the text it found would be the *newest*, not the selected
 * one, which is exactly the bug the browse overlay exists to prevent.
 */
export function takeStash(
  stack: readonly StashedPrompt[],
  id: string,
): { stack: StashedPrompt[]; item: StashedPrompt | null } {
  const item = stack.find((entry) => entry.id === id) ?? null;
  if (item === null) return { stack: [...stack], item: null };
  return { stack: discardStash(stack, id), item };
}

/**
 * What `Ctrl+S` should do, given the composer's state.
 *
 * Exported as a decision function rather than left as an `if` in the handler because the rule
 * has three cases and one of them is subtle: with **exactly one** stash and an empty composer,
 * the spec says pop — the browse overlay is for *multiple*, and opening it for a single item
 * makes the common case (stash, run a command, restore) cost a keypress more than it should.
 */
export type StashIntent =
  | { kind: 'stash'; text: string; caret: number }
  | { kind: 'pop' }
  | { kind: 'browse' }
  | { kind: 'noop' };

export function stashIntent(
  text: string,
  stack: readonly StashedPrompt[],
): StashIntent {
  if (text.trim() !== '') return { kind: 'stash', text, caret: text.length };
  if (stack.length === 0) {
    // Nothing to stash and nothing to pop. `noop` rather than a silent success, so a caller can
    // show a hint ("nothing stashed") instead of appearing to do nothing.
    return { kind: 'noop' };
  }
  if (stack.length === 1) return { kind: 'pop' };
  return { kind: 'browse' };
}
