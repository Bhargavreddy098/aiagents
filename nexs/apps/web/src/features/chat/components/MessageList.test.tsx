/**
 * The transcript's two claims about itself.
 *
 * ## There is no "Assistant" and no clock
 *
 * Every assistant turn used to be headed `Assistant` and a timestamp — the first names the one
 * thing the reader already knows, and the second is a fact about the row rather than about the
 * answer. Both were replaced by a **Thinking** disclosure. Asserting the absence is the only way
 * to keep them from drifting back in one at a time, so the first block below is mostly negative.
 *
 * ## "Thinking" is real activity, and the disclosure must not imply otherwise
 *
 * The word promises a trace, and the honest trace for a chat turn is its tool calls — they are
 * persisted rows. A turn that called none must say so rather than render an empty box, because
 * an empty "Thinking" panel is an invitation to imagine what is missing.
 *
 * The other half of the claim is *when*: the live bubble's disclosure is open while the turn
 * runs, so a reader watches the activity rather than a spinner, and the durable one is closed,
 * so the transcript reads as answers.
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ChatMessageDto } from '@nexs/shared';
import { MessageList, type MessageListProps } from './MessageList';

const AT = new Date(2026, 8, 21, 9, 30).toISOString();

function message(over: Partial<ChatMessageDto> = {}): ChatMessageDto {
  return {
    id: 'm1',
    sessionId: 's1',
    runId: 'r1',
    role: 'assistant',
    content: 'The answer.',
    toolCalls: [],
    attachmentIds: [],
    interrupted: false,
    createdAt: AT,
    ...over,
  };
}

function renderList(over: Partial<MessageListProps> = {}): void {
  render(
    <MessageList
      messages={[]}
      live={{ content: '', toolCalls: [], status: 'idle', limit: null }}
      hasMore={false}
      loadingOlder={false}
      onLoadOlder={() => undefined}
      {...over}
    />,
  );
}

/** The `<details>` a durable assistant turn is wrapped in. */
function thinking(): HTMLDetailsElement {
  const node = document.querySelector('details.message-thinking');
  if (node === null) throw new Error('no thinking disclosure');
  return node as HTMLDetailsElement;
}

describe('an assistant turn is headed "Thinking"', () => {
  it('does not label the answer "Assistant"', () => {
    renderList({ messages: [message()] });

    expect(screen.getByText('Thinking')).toBeTruthy();
    expect(screen.queryByText('Assistant')).toBeNull();
  });

  it('does not print a clock, but keeps the exact time on the row', () => {
    renderList({ messages: [message()] });

    // The formatted time is what the old header rendered. It is now a tooltip on the article,
    // so a reader who wants it has it and a reader who does not is not shown it every time.
    const article = document.querySelector('article.message');
    expect(article?.getAttribute('title')).toBeTruthy();
    expect(screen.queryByText(/2026/)).toBeNull();
  });

  it('keeps the label on a user turn, because alignment alone is not a label', () => {
    renderList({ messages: [message({ role: 'user', content: 'A question.' })] });

    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.queryByText('Thinking')).toBeNull();
  });
});

describe('the Thinking disclosure shows the real activity', () => {
  it('says a turn called no tool rather than rendering an empty trace', () => {
    renderList({ messages: [message()] });

    expect(screen.getByText('no tools called')).toBeTruthy();
    expect(screen.getByText('Answered directly, without calling a tool.')).toBeTruthy();
  });

  it('puts the tool calls inside the disclosure, not under the answer', () => {
    renderList({
      messages: [
        message({
          toolCalls: [
            { name: 'tool_search', args: { q: 'cats' }, result: { hits: 2 }, ok: true },
          ],
        }),
      ],
    });

    expect(screen.getByText('1 tool call')).toBeTruthy();
    const disclosure = thinking();
    expect(disclosure.querySelector('.tool-call-name')?.textContent).toBe('tool_search');
  });

  it('is collapsed on a durable message, so the transcript reads as answers', () => {
    renderList({ messages: [message({ content: 'Done.' })] });

    expect(thinking().open).toBe(false);
    expect(screen.getByText('Done.')).toBeTruthy();
  });

  it('is open while a turn is streaming, so the activity is watched rather than waited on', () => {
    renderList({
      live: {
        content: 'Half an ans',
        status: 'streaming',
        limit: null,
        toolCalls: [
          { key: 'tool_search:0', name: 'tool_search', args: {}, ok: false, startedAt: 1 },
        ],
      },
    });

    const disclosure = thinking();
    expect(disclosure.open).toBe(true);
    expect(disclosure.querySelector('.tool-call-name')?.textContent).toBe('tool_search');
    // The provisional text is still rendered, so the answer arrives as it is written.
    expect(screen.getByText('Half an ans')).toBeTruthy();
  });

  it('names the wait instead of showing an empty box before the first frame', () => {
    renderList({ live: { content: '', toolCalls: [], status: 'streaming', limit: null } });

    expect(screen.getByText('reading your message')).toBeTruthy();
    expect(screen.getByText('Waiting for the model to answer.')).toBeTruthy();
  });

  it('reports an interrupted turn as stopped early rather than as a finished trace', () => {
    renderList({ messages: [message({ interrupted: true, content: 'half' })] });

    expect(screen.getByText('stopped early')).toBeTruthy();
    expect(screen.getByText('This turn was stopped before it called a tool.')).toBeTruthy();
  });
});
