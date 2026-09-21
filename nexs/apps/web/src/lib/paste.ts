/**
 * Paste collapsing (§3.3).
 *
 * The spec: *"Long pasted snippets (e.g. 500-line stack trace) collapse into a visual pill:
 * `[Pasted text: 512 lines (click or /expand to view)]`."*
 *
 * ## The rule this module is built around
 *
 * **The pill is a rendering of the real text, never a replacement for it.** The composer's value
 * is still the full 512 lines; what collapses is the *display* of them. That distinction is the
 * whole reason this is a pure function over a range rather than a "store the paste elsewhere"
 * mechanism: a composer that swapped the text for a token would send the token to the model, and
 * the user's stack trace would never reach it.
 *
 * ## What "long" means, and why the threshold is a constant here
 *
 * The spec gives no number. `PASTE_COLLAPSE_LINES` is 8 and `PASTE_COLLAPSE_CHARS` is 600 — a
 * paste is worth collapsing when it is more than a few lines *or* one very long line, because a
 * minified JS bundle is a single line and would otherwise never collapse. Both numbers are
 * exported so the composer's behaviour is inspectable rather than magic.
 */

/** More lines than this and the paste collapses. */
export const PASTE_COLLAPSE_LINES = 8;

/** Or more characters than this on any single line. */
export const PASTE_COLLAPSE_CHARS = 600;

/** A collapsed region of the composer's text. */
export interface PasteRegion {
  /** Absolute offset in the draft where the paste begins. */
  start: number;
  /** Absolute offset just past it. */
  end: number;
  /** How many lines it spans, for the pill's label. */
  lines: number;
}

/**
 * Is this pasted text long enough to be worth collapsing?
 *
 * Counted rather than estimated: `split('\n').length` allocates, and a 500-line paste is not a
 * hot path — it happens once per paste, not once per keystroke.
 */
export function isCollapsiblePaste(text: string): boolean {
  if (text === '') return false;
  if (text.split('\n').length > PASTE_COLLAPSE_LINES) return true;
  return text.length > PASTE_COLLAPSE_CHARS;
}

/**
 * The pill's label.
 *
 * The spec's own wording, with the line count filled in. A single-line paste reports its length
 * in characters instead, because "1 line" says nothing about a 4000-character minified file —
 * and the spec's example is a multi-line one, so it never had to answer this. Being specific
 * about which happened is cheaper than pretending both are line counts.
 */
export function pasteLabel(text: string): string {
  const lines = text.split('\n').length;
  if (lines > 1) return `Pasted text: ${lines} lines`;
  return `Pasted text: ${text.length} characters`;
}

/**
 * Collapse a pasted region into a single-line token **for display only**.
 *
 * ## Why this returns an offset rather than a transformed string
 *
 * The caller is a `<textarea>` whose `value` must remain the real text. So the collapsing is done
 * by a *backdrop* — a styled element behind the transparent textarea that renders the pill where
 * the region is — and this function's job is only to say **where** the region starts and ends so
 * the backdrop can place the pill and the textarea can stay untouched.
 *
 * That is why the return is a range and not a string: a caller building a display string would
 * have to map offsets back through it to keep the caret honest, and getting that mapping wrong is
 * how a paste-collapse feature ends up moving the cursor.
 *
 * A region is discarded when the draft no longer contains it — a deletion that shortened the text
 * past the region's end invalidates it, and re-clamping would collapse a *different* span than
 * the one the user pasted.
 */
export function pasteRegions(
  text: string,
  regions: readonly PasteRegion[],
): PasteRegion[] {
  return regions.filter((region) => region.end <= text.length && region.start < region.end);
}

/** Record a paste over `[start, end)` in a draft, if it is long enough to be worth it. */
export function registerPaste(
  pasted: string,
  start: number,
  end: number,
  regions: readonly PasteRegion[],
): PasteRegion[] {
  if (!isCollapsiblePaste(pasted)) return [...regions];
  return [...regions, { start, end, lines: pasted.split('\n').length }];
}

/**
 * Drop any region the caret has moved *into*.
 *
 * The pill is a display affordance for text the user is not editing. The moment the caret lands
 * inside the region the user is editing it — so the collapse is lifted and the real lines show.
 * Without this, typing inside a collapsed paste would insert characters into text that is not
 * where it appears to be, which is the single worst failure this feature can have.
 */
export function regionsForCaret(
  regions: readonly PasteRegion[],
  caret: number,
): PasteRegion[] {
  return regions.filter((region) => caret < region.start || caret > region.end);
}
