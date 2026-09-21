/**
 * Paste collapsing, and the caret rule.
 *
 * The load-bearing test here is `regionsForCaret`. A collapse that stayed in place while the
 * caret was inside it would let a user type into text that is not where it appears — the worst
 * failure this feature can have, because the characters land somewhere the screen says they are
 * not.
 */

import { describe, expect, it } from 'vitest';
import {
  PASTE_COLLAPSE_CHARS,
  PASTE_COLLAPSE_LINES,
  isCollapsiblePaste,
  pasteLabel,
  pasteRegions,
  registerPaste,
  regionsForCaret,
} from './paste';

/** A paste of `n` lines, each short. */
function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
}

describe('isCollapsiblePaste', () => {
  it('is false for an empty paste', () => {
    expect(isCollapsiblePaste('')).toBe(false);
  });

  it('switches on the line count', () => {
    expect(isCollapsiblePaste(lines(PASTE_COLLAPSE_LINES))).toBe(false);
    expect(isCollapsiblePaste(lines(PASTE_COLLAPSE_LINES + 1))).toBe(true);
  });

  it('also switches on a single very long line', () => {
    // A minified bundle is one line. Counting lines alone would never collapse it.
    const long = 'x'.repeat(PASTE_COLLAPSE_CHARS + 1);
    expect(long.split('\n')).toHaveLength(1);
    expect(isCollapsiblePaste(long)).toBe(true);
  });

  it('leaves a short paste alone', () => {
    expect(isCollapsiblePaste('two\nlines')).toBe(false);
  });
});

describe('pasteLabel', () => {
  it('reports lines for a multi-line paste, in the spec’s wording', () => {
    expect(pasteLabel(lines(512))).toBe('Pasted text: 512 lines');
  });

  it('reports characters for a single line', () => {
    // "1 line" says nothing about a 4000-character minified file. Being specific about which
    // thing was measured is cheaper than pretending both are line counts.
    expect(pasteLabel('x'.repeat(1234))).toBe('Pasted text: 1234 characters');
  });
});

describe('registerPaste', () => {
  it('records a region for a long paste', () => {
    const pasted = lines(20);
    const regions = registerPaste(pasted, 0, pasted.length, []);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ start: 0, end: pasted.length, lines: 20 });
  });

  it('records nothing for a short paste', () => {
    expect(registerPaste('hi', 0, 2, [])).toHaveLength(0);
  });

  it('appends to existing regions rather than replacing them', () => {
    const first = lines(20);
    const second = lines(30);
    let regions = registerPaste(first, 0, first.length, []);
    regions = registerPaste(second, first.length + 1, first.length + 1 + second.length, regions);
    expect(regions).toHaveLength(2);
  });
});

describe('pasteRegions', () => {
  it('keeps a region the draft still contains', () => {
    const text = lines(20);
    const regions = registerPaste(text, 0, text.length, []);
    expect(pasteRegions(text, regions)).toHaveLength(1);
  });

  it('drops a region a deletion shortened past', () => {
    // Re-clamping would collapse a *different* span than the one the user pasted.
    const text = lines(20);
    const regions = registerPaste(text, 0, text.length, []);
    expect(pasteRegions('short', regions)).toHaveLength(0);
  });

  it('drops a zero-width region', () => {
    expect(pasteRegions('abcdef', [{ start: 2, end: 2, lines: 1 }])).toHaveLength(0);
  });
});

describe('regionsForCaret', () => {
  const region = { start: 10, end: 100, lines: 20 };

  it('lifts the collapse when the caret is inside the region', () => {
    // The user is now editing that text, so it must look like text.
    expect(regionsForCaret([region], 50)).toHaveLength(0);
    expect(regionsForCaret([region], 10)).toHaveLength(0);
    expect(regionsForCaret([region], 100)).toHaveLength(0);
  });

  it('keeps the collapse when the caret is outside it', () => {
    expect(regionsForCaret([region], 0)).toHaveLength(1);
    expect(regionsForCaret([region], 9)).toHaveLength(1);
    expect(regionsForCaret([region], 101)).toHaveLength(1);
  });

  it('filters per region, so an edit in one does not expand the others', () => {
    const other = { start: 200, end: 300, lines: 10 };
    expect(regionsForCaret([region, other], 50)).toEqual([other]);
  });
});
