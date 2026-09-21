/**
 * Pinned conversations — the two pure rules.
 *
 * The store itself is a `localStorage` read and a subscriber set, and neither has a right answer
 * worth rendering a component for. What *does* have one is what to do with a value found in
 * storage, because that value is untrusted input: it is shared with every other script on the
 * origin and it survives upgrades, so a `JSON.parse` in a component without this guard would take
 * the whole sidebar down with a `SyntaxError` thrown during render.
 */

import { describe, expect, it } from 'vitest';
import { parsePins, togglePin } from './pins';

describe('parsePins', () => {
  it('reads a well-formed list', () => {
    expect(parsePins('["a","b"]')).toEqual(['a', 'b']);
  });

  it('returns nothing for a missing value', () => {
    expect(parsePins(null)).toEqual([]);
    expect(parsePins('')).toEqual([]);
  });

  it('returns nothing for malformed JSON rather than throwing', () => {
    expect(parsePins('{not json')).toEqual([]);
  });

  it('returns nothing for a value that is not a list', () => {
    expect(parsePins('{"a":1}')).toEqual([]);
    expect(parsePins('"a"')).toEqual([]);
    expect(parsePins('42')).toEqual([]);
  });

  it('drops entries that are not usable ids, and keeps the ones that are', () => {
    // A partial recovery is right here: one bad entry must not discard a list of good ones.
    expect(parsePins('["a",1,null,"","b",{"id":"c"}]')).toEqual(['a', 'b']);
  });
});

describe('togglePin', () => {
  it('adds an id that is not there', () => {
    expect(togglePin([], 'a')).toEqual(['a']);
    expect(togglePin(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('removes an id that is', () => {
    expect(togglePin(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('does not mutate its input', () => {
    // The caller holds the array that `useSyncExternalStore` handed it, and mutating that in
    // place would change the snapshot without changing its identity — so no subscriber would
    // re-render.
    const original: readonly string[] = ['a'];
    const next = togglePin(original, 'b');
    expect(original).toEqual(['a']);
    expect(next).not.toBe(original);
  });
});
