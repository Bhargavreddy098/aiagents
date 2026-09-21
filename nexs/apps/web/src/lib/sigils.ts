/**
 * §4.2's ASCII sigils, and the rule for assigning one.
 *
 * ## The spec's four, and what they map onto here
 *
 * The spec assigns sigils to *bot profiles*: `[☤]` Hermes Core, `[⚡]` Code Execution,
 * `[🔍]` Research Scout, `[🛡️]` Security Auditor. This build has no profile directories — a
 * tenant's agents are database rows, not folders — so the sigil is **derived from the agent's
 * role text** rather than read out of an `IDENTITY.md`.
 *
 * ## Why derived rather than stored, and why that is stated
 *
 * Storing a sigil would mean a column, a migration, and a picker in the agent wizard for a
 * single character. Deriving it from what the agent already says about itself costs nothing and
 * covers the case the spec actually cares about — that two agents look different at a glance.
 *
 * The honest limit: a derived sigil is a *guess* at the role. So the caller may pass an explicit
 * `sigil` (an agent whose name matches nothing still gets `[◆]`, and the agent detail page lets
 * the operator see which one it got and why). Nothing here claims the guess is authoritative.
 *
 * ## Why these particular characters
 *
 * They are all in the BMP and render as single glyphs in every font this app targets. An emoji
 * sequence like `🛡️` carries a variation selector and renders at two widths depending on the
 * platform, which shifts a fixed-width column.
 */

/** A sigil and the label it stands for, so the UI can say what a glyph means. */
export interface Sigil {
  glyph: string;
  role: string;
}

/** The spec's four, plus a default. Order matters: the first match wins. */
export const SIGILS: readonly Sigil[] = [
  { glyph: '☤', role: 'Hermes Core' },
  { glyph: '⚡', role: 'Code Execution' },
  { glyph: '⌕', role: 'Research' },
  { glyph: '⛨', role: 'Security' },
  { glyph: '◆', role: 'General' },
];

/** Words that select each sigil. Matched case-insensitively against name, role and description. */
const SIGIL_KEYWORDS: readonly { glyph: string; words: readonly string[] }[] = [
  { glyph: '⛨', words: ['security', 'audit', 'auditor', 'vulnerab', 'threat', 'pentest', 'secure'] },
  { glyph: '⌕', words: ['research', 'scout', 'search', 'investigat', 'analyst', 'explore'] },
  { glyph: '⚡', words: ['code', 'coder', 'engineer', 'exec', 'script', 'run', 'build', 'deploy'] },
  { glyph: '☤', words: ['hermes', 'core', 'orchestrat', 'coordinator', 'lead', 'manager'] },
];

/**
 * Pick a sigil for an agent from what it says about itself.
 *
 * `text` is the concatenation the caller chooses — name and description are both reasonable. If
 * nothing matches, `◆` is returned rather than an error: an agent with no obvious role is a
 * normal thing, and `◆` is exactly the right amount of information about it.
 *
 * The explicit `sigil` parameter wins when given, which is what lets a caller stop the guessing
 * for an agent whose name is misleading.
 */
export function sigilFor(text: string, explicit?: string | null): Sigil {
  if (explicit !== undefined && explicit !== null && explicit.trim() !== '') {
    const known = SIGILS.find((sigil) => sigil.glyph === explicit.trim());
    // An unrecognised explicit sigil is still honoured — it is a single character the caller
    // chose — but it is labelled as custom rather than claiming to be one of the four roles.
    return known ?? { glyph: explicit.trim().slice(0, 2), role: 'Custom' };
  }

  const haystack = text.toLowerCase();
  for (const entry of SIGIL_KEYWORDS) {
    if (entry.words.some((word) => haystack.includes(word))) {
      const sigil = SIGILS.find((candidate) => candidate.glyph === entry.glyph);
      if (sigil !== undefined) return sigil;
    }
  }
  return SIGILS[SIGILS.length - 1] ?? { glyph: '◆', role: 'General' };
}

/**
 * §4.2's activity line: `[⚡] Code-Auditor is thinking... (running tool: read_file)`.
 *
 * Exported as a formatter rather than assembled in a component because the two placeholders
 * have different sources — the name is the agent's, the tool comes from the live frame — and
 * a component that built the sentence would have to make the "no tool yet" case read correctly
 * on its own.
 */
export function activityLine(sigil: Sigil, name: string, toolName?: string | null): string {
  const state = toolName !== undefined && toolName !== null && toolName !== ''
    ? `is running ${toolName}`
    : 'is thinking';
  return `${sigil.glyph} ${name} ${state}…`;
}
