/**
 * The context meter's boundaries, which are the whole reason this module has tests.
 *
 * §3.2 gives four bands as half-open ranges. A test that only checked the middle of each band
 * would pass against an implementation with every boundary off by one — so every case below is
 * either a boundary or one step away from one.
 */

import { describe, expect, it } from 'vitest';
import {
  CONTEXT_BANDS,
  contextBand,
  contextBar,
  contextPercent,
  formatTokens,
  readContext,
  shouldSuggestCompress,
} from './context';

describe('formatTokens', () => {
  it('renders under a thousand as a plain count', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('keeps one decimal only when it carries information', () => {
    // The spec's own example.
    expect(formatTokens(18_200)).toBe('18.2K');
    // A round ten-thousand drops the pointless `.0` — the spec writes `200K`, not `200.0K`.
    expect(formatTokens(200_000)).toBe('200K');
  });

  it('switches to millions at a million, not before', () => {
    expect(formatTokens(999_000)).toBe('999K');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_500_000)).toBe('1.5M');
  });

  it('uses an em dash for a missing or impossible value', () => {
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(-1)).toBe('—');
    expect(formatTokens(Number.NaN)).toBe('—');
  });
});

describe('contextPercent', () => {
  it('computes the plain ratio', () => {
    expect(contextPercent(50, 200)).toBe(25);
    expect(contextPercent(182_000, 200_000)).toBeCloseTo(91, 5);
  });

  it('refuses a denominator that cannot be one', () => {
    // Zero would be `Infinity`, and `Infinity` clamped to 100 renders a *full* bar for a model
    // that can hold nothing. Refusing is the honest answer.
    expect(contextPercent(10, 0)).toBeNull();
    expect(contextPercent(10, -5)).toBeNull();
  });

  it('refuses a missing numerator or denominator', () => {
    expect(contextPercent(null, 100)).toBeNull();
    expect(contextPercent(10, null)).toBeNull();
    expect(contextPercent(undefined, undefined)).toBeNull();
  });

  it('refuses a negative usage rather than rendering it as empty', () => {
    expect(contextPercent(-1, 100)).toBeNull();
  });
});

describe('contextBand', () => {
  it('places each boundary on the side the spec puts it', () => {
    // `< 50` green, `[50, 80)` yellow, `[80, 95)` orange, `>= 95` red.
    expect(contextBand(49.9)).toBe('green');
    expect(contextBand(50)).toBe('yellow');
    expect(contextBand(79.9)).toBe('yellow');
    expect(contextBand(80)).toBe('orange');
    expect(contextBand(94.9)).toBe('orange');
    expect(contextBand(95)).toBe('red');
    expect(contextBand(100)).toBe('red');
  });

  it('covers the whole range with no gap and no overlap', () => {
    // Every point from 0 to 100 inclusive lands in exactly one band, and the bands' declared
    // ranges agree with `contextBand`. A gap here would be a percentage with no colour.
    for (let percent = 0; percent <= 100; percent += 0.5) {
      const band = contextBand(percent);
      expect(band).not.toBeNull();
      const declared = CONTEXT_BANDS.find((entry) => entry.band === band);
      expect(declared).toBeDefined();
      expect(percent).toBeGreaterThanOrEqual(declared!.from);
      if (declared!.to !== null) expect(percent).toBeLessThan(declared!.to);
    }
  });

  it('is null for a value it cannot classify', () => {
    expect(contextBand(null)).toBeNull();
    expect(contextBand(Number.NaN)).toBeNull();
  });
});

describe('contextBar', () => {
  it('draws the spec’s ten cells', () => {
    expect(contextBar(0)).toHaveLength(10);
    expect(contextBar(9)).toBe('█' + '░'.repeat(9));
  });

  it('gives any non-zero reading at least one cell', () => {
    // 4% of ten cells rounds to zero, and an empty bar beside "4%" reads as "nothing used" —
    // the opposite of the measurement. The floor is a rendering rule.
    expect(contextBar(4)).toBe('█' + '░'.repeat(9));
    expect(contextBar(0.1)).toBe('█' + '░'.repeat(9));
  });

  it('fills completely at 100 and never overflows', () => {
    expect(contextBar(100)).toBe('█'.repeat(10));
    expect(contextBar(150)).toBe('█'.repeat(10));
  });

  it('renders an empty bar only when there is no reading', () => {
    expect(contextBar(null)).toBe('░'.repeat(10));
  });
});

describe('readContext', () => {
  it('produces one consistent reading', () => {
    const reading = readContext(18_200, 200_000);
    expect(reading).not.toBeNull();
    expect(reading!.label).toBe('18.2K/200K');
    expect(reading!.band).toBe('green');
    expect(reading!.bar).toHaveLength(10);
    expect(reading!.percent).toBeCloseTo(9.1, 5);
  });

  it('is null when either number is missing, rather than reporting zero', () => {
    // `0/0` on screen reads as "the context is empty", which is a claim. There is no claim here.
    expect(readContext(null, 200_000)).toBeNull();
    expect(readContext(18_200, null)).toBeNull();
    expect(readContext(0, 0)).toBeNull();
  });

  it('accepts a genuine zero usage against a real window', () => {
    const reading = readContext(0, 200_000);
    expect(reading).not.toBeNull();
    expect(reading!.percent).toBe(0);
    expect(reading!.band).toBe('green');
  });
});

describe('shouldSuggestCompress', () => {
  it('fires only in the red band, which is the spec’s own wording', () => {
    expect(shouldSuggestCompress('orange')).toBe(false);
    expect(shouldSuggestCompress('red')).toBe(true);
    expect(shouldSuggestCompress(null)).toBe(false);
  });
});
