/**
 * The theme preference.
 *
 * ## What is worth testing here, and what is not
 *
 * The colours themselves are not testable — jsdom does not resolve custom properties, so no
 * assertion in this file can prove the light palette *looks* right. That was checked by looking
 * at a rendered screenshot, which is the only thing that can.
 *
 * What is testable is everything around the colour: that an unknown stored value cannot reach
 * `data-theme`, that the attribute is actually written, and that the two copies of the storage
 * key — one here, one in an inline script that runs before any module loads — stay in step.
 * That last one is the reason this file exists: the failure it guards against is a preference
 * that silently stops being honoured on a cold load, which is invisible in every other test and
 * in normal use of a warm tab.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import {
  DEFAULT_THEME,
  THEMES,
  THEME_STORAGE_KEY,
  applyTheme,
  nextTheme,
  parseTheme,
  useTheme,
} from './theme';

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('parseTheme', () => {
  it('accepts the two themes', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
  });

  it('falls back to the default for anything else', () => {
    // An unknown string written to `data-theme` matches no CSS block, which leaves the page on
    // whatever `:root` says while a control claims otherwise — the bug this refuses.
    for (const raw of [null, '', 'Dark', 'LIGHT', 'sepia', '{}', 'true']) {
      expect(parseTheme(raw)).toBe(DEFAULT_THEME);
    }
  });

  it('defaults to light, which is the palette `:root` declares', () => {
    expect(DEFAULT_THEME).toBe('light');
    expect(THEMES[0]).toBe('light');
  });
});

describe('nextTheme', () => {
  it('toggles between exactly the two themes', () => {
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('light');
    // The round trip is the property that matters: a toggle that could land on a third value
    // would be a state the CSS has no block for.
    expect(nextTheme(nextTheme('dark'))).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('writes the attribute onto the document element', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('useTheme', () => {
  function Probe(): ReactNode {
    const { theme, setTheme, toggle } = useTheme();
    return (
      <div>
        <span data-testid="current">{theme}</span>
        <button type="button" onClick={() => setTheme('dark')}>
          set dark
        </button>
        <button type="button" onClick={() => toggle()}>
          toggle
        </button>
      </div>
    );
  }

  it('starts on light with nothing stored', () => {
    render(<Probe />);
    expect(screen.getByTestId('current').textContent).toBe('light');
  });

  it('applies and persists the theme when it changes', async () => {
    render(<Probe />);

    await act(async () => {
      screen.getByText('set dark').click();
    });

    expect(screen.getByTestId('current').textContent).toBe('dark');
    // Both halves matter: the attribute is what the browser reads, the stored value is what the
    // next cold load reads.
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('toggles back to light', async () => {
    render(<Probe />);

    await act(async () => {
      screen.getByText('set dark').click();
    });
    await act(async () => {
      screen.getByText('toggle').click();
    });

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });
});

describe('index.html', () => {
  /**
   * The inline script in `index.html` sets the theme before the first paint so that a person who
   * chose dark does not get a white flash on a cold load. It cannot import this module, so the
   * key and the default are written out twice. This is the assertion that keeps them equal.
   *
   * The file is found relative to the working directory rather than to `import.meta.url`,
   * because under jsdom that URL is `http://…` and cannot be turned into a path. Both roots are
   * tried, so the test behaves the same whether vitest is started from the package (turbo,
   * `pnpm --filter`) or from the repository root.
   */
  const html = readFileSync(
    [resolve(process.cwd(), 'index.html'), resolve(process.cwd(), 'apps/web/index.html')].find(
      (candidate) => existsSync(candidate),
    ) ?? resolve(process.cwd(), 'index.html'),
    'utf8',
  );

  it('reads the same storage key this module writes', () => {
    expect(html).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  it('defaults to the same theme this module does', () => {
    expect(html).toContain(`<html lang="en" data-theme="${DEFAULT_THEME}">`);
    expect(html).toContain(`dataset.theme = '${DEFAULT_THEME}'`);
  });

  it('only ever assigns one of the two themes', () => {
    // Each assignment is the script's own guard — `stored === 'dark' ? 'dark' : 'light'`, and
    // the catch block's bare `'light'`. Every literal in every one of them has to name a theme
    // the CSS actually declares, because a third value is a block that does not exist.
    const assignments = [...html.matchAll(/dataset\.theme = ([^;]+);/g)];
    expect(assignments.length).toBeGreaterThan(0);
    for (const assignment of assignments) {
      const literals = [...assignment[1]!.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
      expect(literals.length).toBeGreaterThan(0);
      for (const literal of literals) {
        expect(THEMES).toContain(literal);
      }
    }
  });
});
