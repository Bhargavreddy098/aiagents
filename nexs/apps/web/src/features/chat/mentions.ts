/**
 * The `@` picker's text logic.
 *
 * ## What a mention is in this build, stated plainly
 *
 * The picker is real: `GET /api/chat/mentions` reads live rows — your agents, your enabled
 * models, your tools, your MCP servers, your goals, workflows and runs — and returns up to
 * `MENTION_LIMIT` of them. Every entry a user sees exists.
 *
 * What does **not** exist is server-side resolution. `MentionResolver` is referenced in exactly
 * one place outside its own module: the controller method that answers that endpoint. Nothing
 * parses `@` out of a message body, and `sendChatMessageSchema` carries only `content`,
 * `attachmentIds` and `modelId` — there is no field for a resolved reference.
 *
 * So a mention inserts **text**. `@Scout` goes into the prompt as the characters `@Scout`, and
 * the agent reads it the way it reads any other word. This module therefore inserts the
 * entity's **name** rather than a `@kind:id` token: a name is what a model can act on, and an
 * opaque id would look like a binding while being no more resolvable than the name.
 *
 * The picker's UI says this in one line, because a user who believes they have attached a
 * reference would be wrong, and finding out later is worse than reading it now.
 *
 * ## Why this is a separate module from `slash.ts`
 *
 * They are different grammars — one is anchored to the start of the message, one can appear
 * anywhere — and Phase 14 names them as separate test targets. Sharing a file would mean a test
 * file that imports both and a reader who has to hold both grammars at once.
 */

import type { MentionItem, MentionKind } from '@nexs/shared';

/** The region of the text an `@` completion would replace. */
export interface MentionRange {
  /** The text typed after the `@`, to send as the `q` parameter. */
  query: string;
  /** Index of the `@`. */
  start: number;
  /** Index just past the last typed character. */
  end: number;
}

/**
 * The mention being typed, or `null`.
 *
 * The `@` must begin a word — at the start of the message or after whitespace — so an email
 * address does not open a picker halfway through `someone@example.com`. That single rule is
 * why this is not a one-line `lastIndexOf('@')`.
 *
 * The word ends at the first whitespace after the `@`. A caret anywhere inside that word
 * reports the *whole* word as the range, so completing replaces what was typed rather than
 * appending to it.
 */
export function activeMentionQuery(text: string, caret: number): MentionRange | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;

  if (at > 0) {
    const before = text.charAt(at - 1);
    if (!/\s/.test(before)) return null;
  }

  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;

  // The range ends at the first whitespace *after* the caret, so a caret placed in the middle
  // of a finished word still replaces the whole word.
  const after = text.slice(caret);
  const trailing = after.search(/\s/);
  const end = trailing === -1 ? text.length : caret + trailing;

  return { query, start: at, end };
}

/**
 * What a selected entry inserts.
 *
 * The display name, not the id — see the file header. Spaces in a name are left as they are:
 * the token is prose, so `@Hacker News Scout` reads correctly to a model where
 * `@Hacker_News_Scout` would not.
 */
export function mentionInsertion(item: MentionItem): string {
  return `@${item.name}`;
}

/**
 * Replace a range with an insertion and say where the caret goes.
 *
 * ## Why the separator space is conditional
 *
 * A mention range ends at the first whitespace *after* the caret — exclusive — so the text
 * following the range normally **begins with that whitespace**. Appending a space
 * unconditionally would therefore produce two of them, and `@Scout  and the other one` is the
 * kind of small wrongness that accumulates into a prompt the model reads differently.
 *
 * So a space is added only when what follows does not already start with one, and when the
 * range reaches the end of the text (where the user needs a separator to keep typing).
 *
 * The returned caret is the caller's to apply: a controlled `<textarea>` cannot be told where
 * to put the caret declaratively, so this returns the index and the composer sets it once the
 * new value has rendered.
 */
export function applyCompletion(
  text: string,
  range: { start: number; end: number },
  insertion: string,
): { text: string; caret: number } {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  // No separator only when the remainder already begins with whitespace. An empty remainder
  // needs one — otherwise the user's next word runs straight into the name they just inserted.
  const separator = after.length > 0 && /^\s/.test(after) ? '' : ' ';
  return {
    text: `${before}${insertion}${separator}${after}`,
    caret: before.length + insertion.length + separator.length,
  };
}

/**
 * Group entries by kind, preserving the server's order within each group.
 *
 * The picker renders headings, and the resolver already returns entries grouped — but it
 * groups by *source iteration order*, not by kind, so a `kind` filter would still leave the
 * grouping implicit. Grouping here is display only; it does not reorder the underlying list.
 */
export function groupByKind(items: readonly MentionItem[]): { kind: MentionKind; items: MentionItem[] }[] {
  const groups: { kind: MentionKind; items: MentionItem[] }[] = [];
  for (const item of items) {
    const existing = groups.find((group) => group.kind === item.kind);
    if (existing === undefined) groups.push({ kind: item.kind, items: [item] });
    else existing.items.push(item);
  }
  return groups;
}
