/**
 * The stash stack's rules, including the one that is easy to get wrong.
 *
 * That one is the `Ctrl+S` decision: with **exactly one** stash and an empty composer the spec
 * says pop, not browse. An implementation that opened the overlay for a single item would make
 * the common gesture (stash, run a command, restore) cost an extra keypress — and the bug would
 * be invisible in review because the overlay *does* eventually restore the right text.
 */

import { describe, expect, it } from 'vitest';
import {
  STASH_LIMIT,
  discardStash,
  popStash,
  stash,
  stashIntent,
  takeStash,
} from './stash';

const T0 = 1_700_000_000_000;

describe('stash', () => {
  it('pushes a draft onto the end, newest last', () => {
    let stack = stash([], 'first', 5, T0);
    stack = stash(stack, 'second', 6, T0 + 1);
    expect(stack.map((item) => item.text)).toEqual(['first', 'second']);
  });

  it('gives every item a distinct id even for identical text', () => {
    // React keys off the id, and two stashes of the same text are possible — deriving the id
    // from the text would make the overlay's cursor jump between them.
    let stack = stash([], 'same', 4, T0);
    stack = stash(stack, 'same', 4, T0 + 1);
    expect(stack).toHaveLength(2);
    expect(stack[0]!.id).not.toBe(stack[1]!.id);
  });

  it('refuses to stash a blank draft', () => {
    // `Ctrl+S` on empty is the *pop* gesture. Stashing an empty string would make the two
    // indistinguishable — press it once and you have pushed nothing and popped nothing.
    expect(stash([], '', 0, T0)).toHaveLength(0);
    expect(stash([], '   \n  ', 4, T0)).toHaveLength(0);
  });

  it('keeps the caret so restoring can put the cursor back', () => {
    const stack = stash([], 'hello', 3, T0);
    expect(stack[0]!.caret).toBe(3);
  });

  it('drops the oldest at the limit rather than growing forever', () => {
    let stack: ReturnType<typeof stash> = [];
    for (let i = 0; i < STASH_LIMIT + 5; i += 1) {
      stack = stash(stack, `draft-${i}`, 0, T0 + i);
    }
    expect(stack).toHaveLength(STASH_LIMIT);
    // The five oldest are gone; the newest is last.
    expect(stack[0]!.text).toBe('draft-5');
    expect(stack[stack.length - 1]!.text).toBe(`draft-${STASH_LIMIT + 4}`);
  });
});

describe('popStash', () => {
  it('returns the newest and the reduced stack together', () => {
    // The only way to get the item is to accept the reduced stack in the same return, so a
    // caller cannot pop and keep the item by mistake.
    const stack = stash(stash([], 'a', 0, T0), 'b', 0, T0 + 1);
    const result = popStash(stack);
    expect(result.item?.text).toBe('b');
    expect(result.stack.map((item) => item.text)).toEqual(['a']);
  });

  it('reports nothing to pop on an empty stack, without changing it', () => {
    const result = popStash([]);
    expect(result.item).toBeNull();
    expect(result.stack).toEqual([]);
  });

  it('returns a fresh array, so the caller cannot mutate the source in place', () => {
    const stack = stash([], 'a', 0, T0);
    const result = popStash(stack);
    expect(result.stack).not.toBe(stack);
  });
});

describe('discardStash and takeStash', () => {
  it('discards by id and treats a miss as a no-op', () => {
    const stack = stash(stash([], 'a', 0, T0), 'b', 0, T0 + 1);
    const kept = discardStash(stack, stack[0]!.id);
    expect(kept.map((item) => item.text)).toEqual(['b']);
    expect(discardStash(kept, 'does-not-exist')).toHaveLength(1);
  });

  it('takes the *selected* item, not the newest', () => {
    // This is the bug the browse overlay exists to prevent: restoring by position would hand
    // back the newest draft when the user picked an older one.
    const stack = stash(stash(stash([], 'a', 0, T0), 'b', 0, T0 + 1), 'c', 0, T0 + 2);
    const oldest = stack[0]!;
    const result = takeStash(stack, oldest.id);
    expect(result.item?.text).toBe('a');
    expect(result.stack.map((item) => item.text)).toEqual(['b', 'c']);
  });

  it('reports a miss without emptying the stack', () => {
    const stack = stash([], 'a', 0, T0);
    const result = takeStash(stack, 'nope');
    expect(result.item).toBeNull();
    expect(result.stack).toHaveLength(1);
  });
});

describe('stashIntent', () => {
  it('stashes when there is text', () => {
    expect(stashIntent('hello', [])).toEqual({ kind: 'stash', text: 'hello', caret: 5 });
  });

  it('pops when the composer is empty and exactly one draft is held', () => {
    // The case the spec's wording leaves implicit, and the one worth a test.
    const stack = stash([], 'only', 0, T0);
    expect(stashIntent('', stack)).toEqual({ kind: 'pop' });
  });

  it('browses when several drafts are held', () => {
    const stack = stash(stash([], 'a', 0, T0), 'b', 0, T0 + 1);
    expect(stashIntent('', stack)).toEqual({ kind: 'browse' });
  });

  it('is a no-op when there is nothing to stash and nothing to pop', () => {
    // `noop` rather than a silent success, so the caller can say "nothing stashed" instead of
    // appearing to ignore the keypress.
    expect(stashIntent('', [])).toEqual({ kind: 'noop' });
    expect(stashIntent('   ', [])).toEqual({ kind: 'noop' });
  });

  it('prefers stashing over everything else when there is text', () => {
    const stack = stash(stash([], 'a', 0, T0), 'b', 0, T0 + 1);
    expect(stashIntent('urgent', stack).kind).toBe('stash');
  });
});
