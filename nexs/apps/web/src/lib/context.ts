/**
 * Context-window accounting, for the status bar's context meter.
 *
 * §3.2 of `docs/HERMES-TERMINAL-UI-ANS-SPEC` describes a bracketed ASCII bar with four colour
 * thresholds and a `18.2K/200K` reading beside it. This module is the pure half of that: given a
 * token count and a window size, what does the bar say and what colour is it.
 *
 * ## Why this is a module rather than four lines in a component
 *
 * Two reasons, and the second is the real one.
 *
 *  1. The thresholds are stated in the spec as *half-open* ranges that have to agree at the
 *     boundaries — `< 50` green, `50–80` yellow, `80–95` orange, `>= 95` red. Getting those
 *     wrong by one is invisible in review and produces a bar that is orange at 94.9% on one
 *     render and yellow at 95% on the next. Writing them once with tests is how that is
 *     prevented rather than noticed.
 *  2. The reading is **derived**, never stored — the same rule the rest of this codebase
 *     follows. A component that computed its own percentage would be a second opinion about a
 *     number the server already sent, and the two would disagree the moment one of them
 *     rounded differently.
 *
 * ## What `null` means
 *
 * A session that has not sent a message yet has no token count, and a model whose catalogue row
 * has no `contextWindow` has no denominator. Neither is zero: `0/0` on screen reads as "the
 * context is empty", which is a claim, whereas "no reading yet" is the truth. Both are modelled
 * as `null` and rendered as an em dash by the caller.
 */

/** The four bands, in the spec's own vocabulary. */
export type ContextBand = 'green' | 'yellow' | 'orange' | 'red';

/**
 * A token count rendered in the spec's compact form: `18.2K`, `200K`, `1.5M`.
 *
 * The spec shows one decimal for thousands (`18.2K`) and none for a round ten-thousand
 * (`200K`). That is not an arbitrary pair: `200.0K` is noise, and dropping the decimal from
 * `18.2K` to `18K` hides a difference the operator is watching. So a tenth is kept when it
 * carries information and dropped when it does not.
 */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) {
    const thousands = value / 1000;
    // A whole number of thousands loses the decimal; anything else keeps one.
    const rendered = Number.isInteger(Math.round(thousands * 10) / 10)
      ? String(Math.round(thousands))
      : thousands.toFixed(1);
    return `${rendered}K`;
  }
  const millions = value / 1_000_000;
  return `${Number.isInteger(Math.round(millions * 10) / 10) ? String(Math.round(millions)) : millions.toFixed(1)}M`;
}

/**
 * The percentage used, or `null` when it cannot be computed.
 *
 * `null` for a missing numerator, a missing denominator, or a non-positive denominator. That
 * last case matters: `contextWindow: 0` in a half-written model row would otherwise produce
 * `Infinity`, and `Infinity` clamped to 100 would render a *full* bar for a model that can hold
 * nothing. Refusing to answer is the honest response to a denominator that cannot be a
 * denominator.
 */
export function contextPercent(
  used: number | null | undefined,
  max: number | null | undefined,
): number | null {
  if (used === null || used === undefined || !Number.isFinite(used)) return null;
  if (max === null || max === undefined || !Number.isFinite(max) || max <= 0) return null;
  if (used < 0) return null;
  return (used / max) * 100;
}

/**
 * Which band a percentage falls in.
 *
 * The boundaries are the spec's: `< 50`, `[50, 80)`, `[80, 95)`, `>= 95`. The comment on each
 * branch says which side of the boundary it took, because "why is 80 yellow" is the question a
 * reader will have and the answer is not self-evident from the comparison alone.
 */
export function contextBand(percent: number | null): ContextBand | null {
  if (percent === null || !Number.isFinite(percent)) return null;
  if (percent < 50) return 'green';
  if (percent < 80) return 'yellow';
  if (percent < 95) return 'orange';
  return 'red';
}

/**
 * The bar itself: a fixed-width run of filled and empty cells.
 *
 * The spec draws ten cells (`[██████░░░░]`) at 9%. Ten is kept rather than made responsive: a
 * bar whose width changed with the viewport would make two screenshots of the same session
 * look like different readings.
 *
 * A non-zero reading always gets at least one cell. `Math.round(9 / 10)` is 1, but a reading of
 * 4% rounds to 0 — and an empty bar next to "4%" reads as "nothing has been used", which is the
 * opposite of what was measured. The floor is a rendering rule, not an arithmetic one.
 */
export function contextBar(percent: number | null, width = 10): string {
  if (percent === null || !Number.isFinite(percent) || width <= 0) return '░'.repeat(Math.max(0, width));
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = clamped > 0 ? Math.max(1, Math.round((clamped / 100) * width)) : 0;
  return '█'.repeat(Math.min(filled, width)) + '░'.repeat(Math.max(0, width - filled));
}

/** Everything the status bar's context meter renders, in one value. */
export interface ContextReading {
  used: number;
  max: number;
  percent: number;
  band: ContextBand;
  bar: string;
  /** `18.2K/200K` — the spec's compact pair. */
  label: string;
}

/**
 * The whole reading, or `null` when either number is missing.
 *
 * Returning one object rather than four separate helpers means a caller cannot render a bar from
 * one reading and a label from another — the class of bug this project treats as the honesty
 * problem rather than a formatting problem.
 */
export function readContext(
  used: number | null | undefined,
  max: number | null | undefined,
  barWidth = 10,
): ContextReading | null {
  const percent = contextPercent(used, max);
  const band = contextBand(percent);
  if (percent === null || band === null || used === null || used === undefined || max === null || max === undefined) {
    return null;
  }
  return {
    used,
    max,
    percent,
    band,
    bar: contextBar(percent, barWidth),
    label: `${formatTokens(used)}/${formatTokens(max)}`,
  };
}

/**
 * Whether the context is full enough that the spec says to prompt for `/compress`.
 *
 * The spec's own wording: red is *"a warning to trigger `/compress`"*. Exported as a predicate
 * rather than left as `band === 'red'` at the call site so the rule has one name, and so a
 * later change to the threshold does not have to find every comparison.
 */
export function shouldSuggestCompress(band: ContextBand | null): boolean {
  return band === 'red';
}

/** §3.2's threshold table as data, for the legend and for the tests to enumerate. */
export const CONTEXT_BANDS: readonly { band: ContextBand; from: number; to: number | null }[] = [
  { band: 'green', from: 0, to: 50 },
  { band: 'yellow', from: 50, to: 80 },
  { band: 'orange', from: 80, to: 95 },
  { band: 'red', from: 95, to: null },
];
