/**
 * Small pure rules the newer pages need, gathered in one place so they are testable.
 *
 * ## Why these are a module rather than three local functions
 *
 * Each of these was a local helper inside a page component: a JSON validator in `SkillsPage`, the
 * same validator again in `EventsPage`, and a path-parent in `FilesPage`. Two problems, and the
 * second is why they moved.
 *
 *  1. **A local function cannot be tested without rendering the page.** The project's rule — the
 *     one `slash.ts`, `context.ts` and `session-metrics.ts` all follow — is that logic lives where
 *     it can be exercised directly. A validator that only runs through a mounted form is a
 *     validator whose edge cases nobody has ever checked.
 *  2. **The two JSON validators were the same function with two different sentences.** They had
 *     already drifted in wording and would have drifted in behaviour the moment one of them learned
 *     a new rule. One implementation, one caller-supplied message.
 *
 * Nothing here imports React, and nothing reads a clock or the network.
 */

/**
 * Whether a text field holding JSON is acceptable, or the reason it is not.
 *
 * An empty field returns `null` — every caller treats the field as optional, so "absent" is valid
 * and the *server* decides whether the field was required. Returning an error for an empty box
 * would make a correct submission impossible.
 *
 * `null` is returned for validity rather than `true`, so the call site reads
 * `const error = ...; if (error !== null) show(error)` — a shape with no room for the inverted-
 * condition bug that `Boolean` validators attract.
 */
export function jsonErrorFor(text: string, message: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  try {
    JSON.parse(trimmed);
    return null;
  } catch {
    return message;
  }
}

/**
 * The containing directory of a slash-separated relative path.
 *
 * The root's parent is the root — `''`, the same value the API uses for the root — rather than
 * `null` or `/`. The distinction matters because the caller uses the result as the *next* path to
 * list: returning `/` would ask the server for an absolute path it does not accept, and returning
 * `null` would turn "go up one level" into a special case at every call site.
 *
 * Deliberately string-based rather than a path library: these are server-relative POSIX paths from
 * the files API, and `node:path` on Windows would rewrite the separators.
 */
export function parentOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/**
 * A cron expression's plausibility, or the reason it is not plausible.
 *
 * **This is a shape check, not a parser.** It counts fields and rejects the two mistakes that are
 * actually common — a five-field expression pasted where six are wanted, and prose. It does not
 * validate ranges (`99 * * * * *` passes) because the scheduler owns that judgement and a second
 * opinion here would either be wrong or duplicate it. The UI says so rather than implying the field
 * is validated.
 */
export function cronShapeErrorFor(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'A schedule needs a cron expression.';
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 6) {
    return `Cron takes six fields (second minute hour day month weekday); this has ${fields.length}.`;
  }
  return null;
}
