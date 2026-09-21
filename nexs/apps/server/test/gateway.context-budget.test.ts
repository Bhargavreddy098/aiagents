import { describe, expect, it, vi } from 'vitest';
import type { ApiError, ChatMessage } from '@nexs/shared';
import {
  estimateMessageTokens,
  estimateTokens,
  fitToContext,
} from '../src/services/gateway/context-budget.js';

/**
 * The context-budgeting ladder.
 *
 * The rule this file protects: **never silently truncate mid-request.** Dropping the
 * oldest turns is a deliberate, visible act (`droppedCount` is reported), and when even
 * that is not enough the call fails with CONTEXT_WINDOW_EXCEEDED rather than sending a
 * prompt that has quietly lost its middle.
 */

/** `content` of `n` characters estimates to `n / 4` tokens, plus 4 per message. */
function filler(chars: number): string {
  return 'x'.repeat(chars);
}

function user(chars: number): ChatMessage {
  return { role: 'user', content: filler(chars) };
}

function system(chars: number): ChatMessage {
  return { role: 'system', content: filler(chars) };
}

describe('estimateTokens', () => {
  it('uses roughly four characters per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens(filler(400))).toBe(100);
  });

  it('rounds up, so the estimate is conservative rather than optimistic', () => {
    expect(estimateTokens('a')).toBe(1);
  });
});

describe('estimateMessageTokens', () => {
  it('charges a per-message envelope on top of the content', () => {
    // The role marker and delimiters cost tokens too; ignoring them under-budgets a long
    // conversation by four tokens per turn.
    expect(estimateMessageTokens([{ role: 'user', content: 'abcd' }])).toBe(5);
    expect(estimateMessageTokens([])).toBe(0);
    expect(estimateMessageTokens([user(4), user(4)])).toBe(10);
  });
});

describe('fitToContext', () => {
  it('passes a conversation that fits through untouched', async () => {
    const messages = [system(12), user(20)];

    const fitted = await fitToContext(messages, { maxContextTokens: 1_000, maxOutputTokens: 100 });

    expect(fitted.messages).toEqual(messages);
    expect(fitted.droppedCount).toBe(0);
    expect(fitted.summarized).toBe(false);
    // system: 12/4 = 3, plus the 4-token envelope = 7. user: 20/4 = 5, plus 4 = 9.
    expect(fitted.estimatedTokens).toBe(7 + 9);
  });

  it('keeps system messages first even if they were supplied last', async () => {
    const fitted = await fitToContext([user(20), system(12)], {
      maxContextTokens: 1_000,
      maxOutputTokens: 100,
    });

    expect(fitted.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('reserves the output budget, so a prompt never fills the whole window', async () => {
    // 100 available, 90 used, 10 reserved for the reply.
    const error = (await fitToContext([system(8), user(352)], {
      maxContextTokens: 100,
      maxOutputTokens: 10,
    }).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('CONTEXT_WINDOW_EXCEEDED');
  });

  it('drops the oldest turns until the rest fits', async () => {
    // 90 available: system 5, then four 24-token turns = 101.
    const messages = [system(4), user(80), user(80), user(80), user(80)];

    const fitted = await fitToContext(messages, { maxContextTokens: 100, maxOutputTokens: 10 });

    expect(fitted.droppedCount).toBe(1);
    expect(fitted.messages).toHaveLength(4);
    expect(fitted.messages[0]!.role).toBe('system');
    expect(fitted.estimatedTokens).toBe(77);
  });

  it('counts tool definitions against the budget', async () => {
    const messages = [system(4), user(80), user(80), user(80), user(80)];

    // Reserving 50 for tools leaves 40, so three turns have to go.
    const fitted = await fitToContext(messages, {
      maxContextTokens: 100,
      maxOutputTokens: 10,
      reserveForTools: 50,
    });

    expect(fitted.droppedCount).toBe(3);
    expect(fitted.messages).toHaveLength(2);
  });

  it('never separates a tool result from the assistant turn that requested it', async () => {
    // Some providers reject a transcript where a `tool` message has no parent, so dropping
    // is done in whole turns rather than message by message.
    const messages: ChatMessage[] = [
      system(4),
      { role: 'assistant', content: filler(200) },
      { role: 'tool', content: filler(200), toolCallId: 'call_1' },
      user(200),
    ];

    const fitted = await fitToContext(messages, { maxContextTokens: 100, maxOutputTokens: 10 });

    expect(fitted.droppedCount).toBe(2);
    expect(fitted.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('never leaves an orphaned tool message behind', async () => {
    const messages: ChatMessage[] = [
      system(4),
      { role: 'assistant', content: filler(80) },
      { role: 'tool', content: filler(80), toolCallId: 'call_1' },
      user(80),
      user(80),
    ];

    const fitted = await fitToContext(messages, { maxContextTokens: 100, maxOutputTokens: 10 });

    for (const [index, message] of fitted.messages.entries()) {
      if (message.role !== 'tool') continue;
      expect(fitted.messages[index - 1]?.role, 'tool message lost its parent').toBe('assistant');
    }
  });

  it('always keeps at least the newest turn', async () => {
    const error = (await fitToContext([system(4), user(400)], {
      maxContextTokens: 100,
      maxOutputTokens: 10,
    }).catch((e: unknown) => e)) as ApiError;

    // Dropping the last turn would leave a prompt with no question in it.
    expect(error.code).toBe('CONTEXT_WINDOW_EXCEEDED');
  });

  it('replaces what it dropped with a summary when one is available', async () => {
    const summarize = vi.fn(async () => 'sum');
    const messages: ChatMessage[] = [
      system(4),
      { role: 'assistant', content: filler(200) },
      { role: 'tool', content: filler(200), toolCallId: 'call_1' },
      user(200),
    ];

    const fitted = await fitToContext(messages, {
      maxContextTokens: 100,
      maxOutputTokens: 10,
      summarize,
    });

    expect(fitted.summarized).toBe(true);
    expect(fitted.messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
    expect(fitted.messages[1]!.content).toBe('sum');
    expect(fitted.droppedCount).toBe(2);
  });

  it('hands the summariser exactly the turns that were dropped', async () => {
    const summarize = vi.fn(async () => 'sum');
    const droppedAssistant: ChatMessage = { role: 'assistant', content: filler(200) };
    const droppedTool: ChatMessage = { role: 'tool', content: filler(200), toolCallId: 'c' };

    await fitToContext([system(4), droppedAssistant, droppedTool, user(200)], {
      maxContextTokens: 100,
      maxOutputTokens: 10,
      summarize,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledWith([droppedAssistant, droppedTool]);
  });

  it('drops a summary that does not fit rather than failing the call', async () => {
    // A summary costs tokens, so it only helps if it is shorter than what it replaced.
    // When it is not, the ladder degrades to "no summary" instead of looping.
    const messages: ChatMessage[] = [
      system(4),
      { role: 'assistant', content: filler(200) },
      { role: 'tool', content: filler(200), toolCallId: 'call_1' },
      user(200),
    ];

    const fitted = await fitToContext(messages, {
      maxContextTokens: 100,
      maxOutputTokens: 10,
      summarize: async () => filler(1_000),
    });

    expect(fitted.summarized).toBe(false);
    expect(fitted.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });

  it('does not call the summariser when nothing had to be dropped', async () => {
    const summarize = vi.fn(async () => 'sum');

    await fitToContext([system(4), user(20)], {
      maxContextTokens: 1_000,
      maxOutputTokens: 100,
      summarize,
    });

    expect(summarize).not.toHaveBeenCalled();
  });

  it('rejects a model whose window is smaller than its own output reservation', async () => {
    const error = (await fitToContext([user(4)], {
      maxContextTokens: 50,
      maxOutputTokens: 60,
    }).catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('CONTEXT_WINDOW_EXCEEDED');
    expect(error.message).toContain('reserved output budget');
  });

  it('reports how much the trimmed prompt actually costs', async () => {
    const fitted = await fitToContext([system(4), user(80), user(80), user(80), user(80)], {
      maxContextTokens: 100,
      maxOutputTokens: 10,
    });

    // The reported estimate must describe the prompt that will be sent, not the one that
    // was proposed — the dashboard shows this number.
    expect(fitted.estimatedTokens).toBe(estimateMessageTokens(fitted.messages));
    expect(fitted.estimatedTokens).toBeLessThanOrEqual(90);
  });
});
