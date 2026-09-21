import { ApiError, type ChatMessage } from '@nexs/shared';

/**
 * Token estimation and the context-budgeting ladder.
 *
 * There is deliberately no tokenizer in the dependency tree. A real BPE tokenizer per
 * provider is a large dependency that still only approximates models we have no
 * vocabulary for, and this number only has to be *conservative* — it decides when to
 * shrink the prompt, not what to bill. Actual usage always comes from the provider's
 * own `usage` block, and that is what `ModelUsage` records.
 *
 * ~4 characters per token is the standard English rule of thumb. Code and CJK are
 * denser, which is why the budget keeps a safety margin rather than filling it exactly.
 */

const CHARS_PER_TOKEN = 4;
/** Per-message envelope cost (role marker, delimiters). */
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

export interface ContextBudget {
  /** The model's full context window. */
  maxContextTokens: number;
  /** Tokens reserved for the completion. */
  maxOutputTokens: number;
  /** Tokens reserved for tool definitions sent alongside the prompt. */
  reserveForTools?: number;
  /**
   * Called with the messages that had to be dropped, returning a replacement summary.
   * Injectable so the ladder can be tested without a model call.
   */
  summarize?: (dropped: ChatMessage[]) => Promise<string>;
}

export interface FittedContext {
  messages: ChatMessage[];
  droppedCount: number;
  summarized: boolean;
  estimatedTokens: number;
}

/**
 * A `tool` message is meaningless without the assistant message that requested the
 * call, and some providers reject a transcript where the two are separated. Dropping
 * is therefore done in whole turns, never message-by-message.
 */
function groupTurns(messages: readonly ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];

  for (const message of messages) {
    const current = groups[groups.length - 1];
    if (message.role === 'tool' && current !== undefined) {
      current.push(message);
    } else {
      groups.push([message]);
    }
  }

  return groups;
}

/**
 * The ladder, in order:
 *   1. it fits — use it unchanged
 *   2. drop the oldest turns, keeping system messages and the newest turn
 *   3. replace what was dropped with a single summary system message
 *   4. still too big → CONTEXT_WINDOW_EXCEEDED (never silently truncate mid-request)
 */
export async function fitToContext(
  messages: readonly ChatMessage[],
  budget: ContextBudget,
): Promise<FittedContext> {
  const available =
    budget.maxContextTokens - budget.maxOutputTokens - (budget.reserveForTools ?? 0);

  if (available <= 0) {
    throw new ApiError(
      'CONTEXT_WINDOW_EXCEEDED',
      'Model context window is smaller than the reserved output budget',
    );
  }

  const system = messages.filter((m) => m.role === 'system');
  const conversation = messages.filter((m) => m.role !== 'system');

  const total = (parts: readonly ChatMessage[]): number => estimateMessageTokens(parts);
  const initial = [...system, ...conversation];

  if (total(initial) <= available) {
    return {
      messages: [...initial],
      droppedCount: 0,
      summarized: false,
      estimatedTokens: total(initial),
    };
  }

  // Step 2 — drop oldest turns. Always keep at least the newest turn.
  const groups = groupTurns(conversation);
  const dropped: ChatMessage[] = [];

  while (groups.length > 1 && total([...system, ...groups.flat()]) > available) {
    dropped.push(...groups.shift()!);
  }

  let summary: ChatMessage | null = null;
  if (dropped.length > 0 && budget.summarize !== undefined) {
    // Step 3 — a summary costs tokens, so it only helps if it is shorter than what it
    // replaced. If the summariser returns something that does not fit, we fall through
    // to the failure below rather than looping.
    const text = await budget.summarize(dropped);
    const candidate: ChatMessage = { role: 'system', content: text };
    if (total([...system, candidate, ...groups.flat()]) <= available) {
      summary = candidate;
    }
  }

  const fitted = [...system, ...(summary === null ? [] : [summary]), ...groups.flat()];
  const estimated = total(fitted);

  if (estimated > available) {
    throw new ApiError(
      'CONTEXT_WINDOW_EXCEEDED',
      `Conversation needs ~${estimated} tokens but only ${available} are available for this model`,
      { estimatedTokens: estimated, availableTokens: available, droppedCount: dropped.length },
    );
  }

  return {
    messages: fitted,
    droppedCount: dropped.length,
    summarized: summary !== null,
    estimatedTokens: estimated,
  };
}
