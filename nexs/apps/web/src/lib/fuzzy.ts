/**
 * Subsequence matching, for the command palette and the chat slash menu.
 *
 * A pure function in its own module rather than a closure inside a component, because it is
 * the one piece of the palette with a right answer — `"agn"` must match "Agents" and must
 * not match "Runs" — and a rule with a right answer belongs somewhere it can be asserted
 * without rendering anything.
 *
 * The scoring is deliberately legible rather than clever. Every bonus below corresponds to
 * something a person would call "a better match":
 *
 *   - **Consecutive characters** (`gnt` in "Agents") beat scattered ones (`g` … `n` … `t`).
 *   - **A match at a word start** (`a` in "**A**gents") beats one in the middle.
 *   - **A match at the very beginning** beats a word start further in, which is what makes
 *     typing `r` put "Runs" above "Browser".
 *   - **An exact-case match** breaks ties, so `S` prefers "Settings" over "sandbox".
 *
 * There is no fuzzy *threshold*. A subsequence either exists or it does not, and a threshold
 * would mean a query that "should" match silently returning nothing — the failure mode this
 * codebase avoids everywhere else.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices in `target` that matched, for highlighting. */
  indices: number[];
}

const BONUS_CONSECUTIVE = 8;
const BONUS_WORD_START = 6;
const BONUS_FIRST_CHAR = 10;
const BONUS_EXACT_CASE = 1;
/** Charged once per character skipped before the first match, so a later start ranks lower. */
const PENALTY_LEADING_GAP = 1;

/** A separator for "start of word": whitespace, or any of the punctuation these labels use. */
function isSeparator(char: string): boolean {
  return char === ' ' || char === '-' || char === '_' || char === '/' || char === '.';
}

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return { score: 0, indices: [] };
  if (needle.length > target.length) return null;

  const haystack = target.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let cursor = 0;
  let previousIndex = -1;

  for (const char of needle) {
    // `indexOf` from the cursor keeps this greedy and linear, which is right: a
    // non-greedy match would find a *lower*-scoring alignment, and the bonuses already
    // reward the early-and-tight case that greedy produces.
    const found = haystack.indexOf(char, cursor);
    if (found === -1) return null;

    if (indices.length === 0) {
      score -= found * PENALTY_LEADING_GAP;
      if (found === 0) score += BONUS_FIRST_CHAR;
    }

    if (found === previousIndex + 1) score += BONUS_CONSECUTIVE;

    const before = found > 0 ? haystack[found - 1] : undefined;
    if (found === 0 || (before !== undefined && isSeparator(before))) score += BONUS_WORD_START;

    // `target[found]` is the original casing; `char` is the query's, lowercased. Equal
    // originals mean the user typed the capital.
    if (target[found] === query[indices.length] || target[found] === char) score += BONUS_EXACT_CASE;

    indices.push(found);
    previousIndex = found;
    cursor = found + 1;
  }

  // Shorter targets win ties: `agn` matching "Agents" should beat it matching
  // "Agent Settings", which also contains the subsequence.
  score -= Math.floor(target.length / 4);

  return { score, indices };
}

export interface FuzzyResult<T> {
  item: T;
  score: number;
  indices: number[];
}

/**
 * Filter and rank `items`.
 *
 * The sort is by score descending, and **stable within equal scores** — `Array.prototype.sort`
 * is required to be stable, so an empty query returns the input order untouched. That is
 * what lets the palette show the full list before anything is typed.
 */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  key: (item: T) => string,
): FuzzyResult<T>[] {
  const results: FuzzyResult<T>[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (match !== null) results.push({ item, score: match.score, indices: match.indices });
  }
  return results.sort((a, b) => b.score - a.score);
}
