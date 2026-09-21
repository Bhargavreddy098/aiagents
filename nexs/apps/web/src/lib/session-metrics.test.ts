/**
 * The sigil guess and the metric honesty split.
 *
 * Two small modules, one file: both are "a pure function decides what the UI claims", which is
 * the property worth pinning down.
 */

import { describe, expect, it } from 'vitest';
import { SIGILS, activityLine, sigilFor } from './sigils';
import { contextOccupancy, formatCost, formatSessionDuration, sessionMetrics } from './session-metrics';

describe('sigilFor', () => {
  it('matches the spec’s four roles from what the agent says about itself', () => {
    expect(sigilFor('Code Execution Specialist').glyph).toBe('⚡');
    expect(sigilFor('Research Scout').glyph).toBe('⌕');
    expect(sigilFor('Security Auditor').glyph).toBe('⛨');
    expect(sigilFor('Hermes Core').glyph).toBe('☤');
  });

  it('is case-insensitive and matches inside a longer name', () => {
    expect(sigilFor('the SECURITY review bot').glyph).toBe('⛨');
    expect(sigilFor('dependency vulnerability scanner').glyph).toBe('⛨');
  });

  it('falls back to the general sigil rather than failing', () => {
    // An agent with no obvious role is a normal thing. `◆` is exactly the right amount of
    // information about it.
    const sigil = sigilFor('Bob');
    expect(sigil.glyph).toBe('◆');
    expect(sigil.role).toBe('General');
  });

  it('honours an explicit sigil over the guess', () => {
    // The escape hatch for an agent whose name is misleading.
    expect(sigilFor('Security Auditor', '☤').glyph).toBe('☤');
  });

  it('labels an unrecognised explicit sigil as custom rather than claiming a role', () => {
    const sigil = sigilFor('anything', '✦');
    expect(sigil.glyph).toBe('✦');
    expect(sigil.role).toBe('Custom');
  });

  it('ignores a blank explicit sigil and falls back to the guess', () => {
    expect(sigilFor('Research Scout', '   ').glyph).toBe('⌕');
    expect(sigilFor('Research Scout', null).glyph).toBe('⌕');
  });

  it('orders security before code, so a security coder is a security auditor', () => {
    // "code security auditor" contains both keywords; the more specific role wins.
    expect(sigilFor('code security auditor').glyph).toBe('⛨');
  });

  it('gives every sigil in the table a distinct glyph', () => {
    const glyphs = SIGILS.map((sigil) => sigil.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe('activityLine', () => {
  it('names the tool when one is running', () => {
    expect(activityLine({ glyph: '⚡', role: 'Code Execution' }, 'Code-Auditor', 'read_file')).toBe(
      '⚡ Code-Auditor is running read_file…',
    );
  });

  it('says "thinking" when no tool has started yet', () => {
    expect(activityLine({ glyph: '☤', role: 'Hermes Core' }, 'Hermes')).toBe('☤ Hermes is thinking…');
    expect(activityLine({ glyph: '☤', role: 'Hermes Core' }, 'Hermes', '')).toBe(
      '☤ Hermes is thinking…',
    );
    expect(activityLine({ glyph: '☤', role: 'Hermes Core' }, 'Hermes', null)).toBe(
      '☤ Hermes is thinking…',
    );
  });
});

describe('sessionMetrics', () => {
  const session = {
    id: 's1',
    title: null,
    agentId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    messageCount: 3,
    lastMessageAt: null,
  };

  it('reports the three numbers this build does not record as absent, not zero', () => {
    // `🗜️ 0` next to a `18.2K/200K` would be read as a fact. There is no compaction column,
    // no `/bg` queue and no auto-approval toggle — so each says so.
    const metrics = sessionMetrics({ session, runs: [], usage: [], now: 60_000 });
    expect(metrics.compressions.kind).toBe('absent');
    expect(metrics.backgroundTasks.kind).toBe('absent');
    expect(metrics.yolo.kind).toBe('absent');
    expect(metrics.compressions.reason.length).toBeGreaterThan(0);
  });

  it('reports usage as absent when no row has been read, rather than as zero tokens', () => {
    const metrics = sessionMetrics({ session, runs: [], usage: [], now: 0 });
    expect(metrics.tokens.kind).toBe('absent');
    expect(metrics.cost.kind).toBe('absent');
  });

  it('labels a token total derived, with the caveat that makes it honest', () => {
    // The sum is over the runs the client fetched, so it can be too low. That is the difference
    // between a measured number and a derived one, and it is why the UI puts a `~` on it.
    const metrics = sessionMetrics({
      session,
      runs: [],
      usage: [
        { totalTokens: 100, costEstimate: 0.01 },
        { totalTokens: 50, costEstimate: 0.02 },
      ] as never,
      now: 0,
    });
    expect(metrics.tokens).toMatchObject({ kind: 'derived', value: 150 });
    expect(metrics.cost).toMatchObject({ kind: 'derived' });
    if (metrics.cost.kind === 'derived') {
      expect(metrics.cost.value).toBeCloseTo(0.03, 8);
      expect(metrics.cost.caveat).toContain('estimate');
    }
  });

  it('measures the duration from the session row, which is a column', () => {
    const metrics = sessionMetrics({ session, runs: [], usage: [], now: 45_000 });
    expect(metrics.durationMs).toMatchObject({ kind: 'measured', value: 45_000 });
  });

  it('reports no duration when no session is open', () => {
    const metrics = sessionMetrics({ session: null, runs: [], usage: [], now: 0 });
    expect(metrics.durationMs.kind).toBe('absent');
  });
});

describe('formatSessionDuration', () => {
  it('renders the spec’s shapes', () => {
    expect(formatSessionDuration(45_000)).toBe('45s');
    expect(formatSessionDuration(765_000)).toBe('12m 45s');
    expect(formatSessionDuration(3_840_000)).toBe('1h 04m');
  });

  it('is an em dash for a value it cannot render', () => {
    expect(formatSessionDuration(null)).toBe('—');
    expect(formatSessionDuration(-1)).toBe('—');
  });
});

describe('formatCost', () => {
  it('keeps four decimals below a cent, because two would round a real cost to $0.00', () => {
    expect(formatCost(0.0012)).toBe('$0.0012');
  });

  it('uses two decimals at or above a cent', () => {
    expect(formatCost(0.08)).toBe('$0.08');
    expect(formatCost(1.5)).toBe('$1.50');
  });

  it('renders a genuine zero as $0.00 rather than as missing', () => {
    // A free or local model really does cost nothing, and that is a fact worth showing.
    expect(formatCost(0)).toBe('$0.00');
  });

  it('is an em dash for a missing value', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(Number.NaN)).toBe('—');
  });
});

describe('contextOccupancy', () => {
  it('pairs the session total against the model window and says it is approximate', () => {
    const occupancy = contextOccupancy(18_200, { contextWindow: 200_000, name: 'claude-sonnet-4' });
    expect(occupancy).toMatchObject({ used: 18_200, max: 200_000, approximate: true });
    expect(occupancy!.note).toContain('Cumulative');
  });

  it('is null when the model has no window recorded', () => {
    // A model row with `contextWindow: null` gives no denominator, and inventing one would be
    // the invented number the honesty rule forbids.
    expect(contextOccupancy(18_200, { contextWindow: null, name: 'local' })).toBeNull();
  });

  it('is null with no model or no tokens', () => {
    expect(contextOccupancy(18_200, null)).toBeNull();
    expect(contextOccupancy(null, { contextWindow: 200_000, name: 'x' })).toBeNull();
  });
});
