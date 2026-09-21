/**
 * The `@` picker's text logic.
 *
 * The cases that matter here are the ones where a naive `lastIndexOf('@')` gets it wrong: an
 * email address, a caret placed in the middle of a finished word, and the double space that
 * appears when the range boundary and the separator disagree.
 */

import { describe, expect, it } from 'vitest';
import type { MentionItem } from '@nexs/shared';
import {
  activeMentionQuery,
  applyCompletion,
  groupByKind,
  mentionInsertion,
} from './mentions';

const item = (over: Partial<MentionItem> & Pick<MentionItem, 'kind' | 'id' | 'name'>): MentionItem => over;

describe('activeMentionQuery', () => {
  it('opens at the start of the message', () => {
    expect(activeMentionQuery('@ag', 3)).toEqual({ query: 'ag', start: 0, end: 3 });
  });

  it('opens after whitespace, because a mention can appear anywhere', () => {
    expect(activeMentionQuery('ask @ag', 7)).toEqual({ query: 'ag', start: 4, end: 7 });
  });

  it('does not open inside an email address', () => {
    // The `@` does not begin a word here, so this is not a mention.
    expect(activeMentionQuery('mail someone@example.com', 24)).toBeNull();
  });

  it('closes once whitespace follows the token', () => {
    expect(activeMentionQuery('@agent and more', 15)).toBeNull();
  });

  it('returns null when there is no at-sign', () => {
    expect(activeMentionQuery('hello', 5)).toBeNull();
  });

  it('covers the whole word when the caret is in the middle of it', () => {
    // Completing must replace what was typed, not insert into the middle of it.
    expect(activeMentionQuery('@agent rest', 4)).toEqual({ query: 'age', start: 0, end: 6 });
  });

  it('ends the range at the end of the text when nothing follows', () => {
    expect(activeMentionQuery('@agent', 6)).toEqual({ query: 'agent', start: 0, end: 6 });
  });
});

describe('mentionInsertion', () => {
  it('inserts the display name, not the id', () => {
    // The server does not resolve `@` in a message body, so an opaque `@kind:id` token would
    // look like a binding while being no more resolvable than the name.
    expect(mentionInsertion(item({ kind: 'agent', id: 'agt_123', name: 'Scout' }))).toBe('@Scout');
  });

  it('leaves spaces in a name alone, because the token is prose', () => {
    expect(mentionInsertion(item({ kind: 'agent', id: 'a', name: 'Hacker News Scout' }))).toBe(
      '@Hacker News Scout',
    );
  });
});

describe('applyCompletion', () => {
  it('adds a separator when the range reaches the end of the text', () => {
    expect(applyCompletion('/he', { start: 0, end: 3 }, '/help')).toEqual({
      text: '/help ',
      caret: 6,
    });
  });

  it('does not double the space when the range stops before one', () => {
    // A mention range ends *before* the whitespace that terminated it, so the remainder already
    // begins with a space. Appending another would yield `@Scout  and`.
    expect(applyCompletion('@sc and the rest', { start: 0, end: 3 }, '@Scout')).toEqual({
      text: '@Scout and the rest',
      caret: 6,
    });
  });

  it('replaces only the range, keeping text on both sides', () => {
    expect(applyCompletion('ask @sc now', { start: 4, end: 7 }, '@Scout')).toEqual({
      text: 'ask @Scout now',
      caret: 10,
    });
  });

  it('places the caret after the insertion', () => {
    const result = applyCompletion('@a', { start: 0, end: 2 }, '@Alpha');
    expect(result.text.slice(0, result.caret)).toBe('@Alpha ');
  });
});

describe('groupByKind', () => {
  it('groups by kind and preserves the server order within each group', () => {
    const items = [
      item({ kind: 'agent', id: 'a1', name: 'One' }),
      item({ kind: 'model', id: 'm1', name: 'Two' }),
      item({ kind: 'agent', id: 'a2', name: 'Three' }),
    ];
    const groups = groupByKind(items);
    expect(groups.map((group) => group.kind)).toEqual(['agent', 'model']);
    expect(groups[0]?.items.map((entry) => entry.name)).toEqual(['One', 'Three']);
    expect(groups[1]?.items.map((entry) => entry.name)).toEqual(['Two']);
  });

  it('returns nothing for nothing', () => {
    expect(groupByKind([])).toEqual([]);
  });
});
