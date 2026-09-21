/**
 * The colour theme, and why it is a preference rather than a constant.
 *
 * ## Light is the default, and the dark palette still exists
 *
 * `theme.css` declares the light palette on `:root` and the specification's dark palette on
 * `[data-theme='dark']`. Light is therefore what a browser renders with no JavaScript at all,
 * which matters: the app is usable while the bundle is still arriving, and a theme that had to
 * be applied *by* the bundle would show the wrong colours for as long as it took to load.
 *
 * ## The one thing that is duplicated on purpose
 *
 * `index.html` carries a six-line inline script that reads this same storage key and sets the
 * attribute before the first paint. It cannot import this module — it runs before any module
 * does — so the key appears in two places. The duplication is guarded rather than hoped about:
 * `theme.test.tsx` reads `index.html` and fails if the two ever disagree, because the failure
 * mode is a preference that silently stops being honoured on a cold load.
 *
 * Without that script a person who chose dark would get a white flash on every navigation to a
 * fresh document. That is the entire reason it exists.
 *
 * ## Why a module-level store rather than context
 *
 * The same argument as `pins.ts`: the value is read in the panel's settings tab and written
 * there, and threading a provider through the shell to reach one toggle would put a provider
 * between the shell and every page for one string.
 */

import { useCallback, useSyncExternalStore } from 'react';

/** Both themes, in the order a control should offer them. */
export type Theme = 'light' | 'dark';

export const THEMES: readonly Theme[] = ['light', 'dark'];

/** What a visitor with no stored preference gets. */
export const DEFAULT_THEME: Theme = 'light';

const STORAGE_KEY = 'nexs.theme';

/**
 * The storage key, exported for the same two reasons as `PIN_STORAGE_KEY`: the test that seeds a
 * preference before rendering, and the test that keeps `index.html`'s inline script in step.
 */
export const THEME_STORAGE_KEY = STORAGE_KEY;

/**
 * Read a stored preference, refusing anything that is not one of the two themes.
 *
 * Exported for its own test. Storage is shared with every other script on the origin and
 * survives upgrades, so the value found here is untrusted input — and the specific failure this
 * prevents is an unknown string being written to `data-theme`, which matches no CSS block and
 * leaves the page on whatever `:root` says while the control claims otherwise.
 */
export function parseTheme(raw: string | null): Theme {
  return raw === 'dark' ? 'dark' : DEFAULT_THEME;
}

/** The theme after a toggle. Exported so the rule is testable without a DOM. */
export function nextTheme(current: Theme): Theme {
  return current === 'dark' ? 'light' : 'dark';
}

/**
 * Write the theme onto the document element.
 *
 * The attribute is set even for light, rather than removed. Light is what `:root` already says,
 * so the two are equivalent to a browser — but an explicit `data-theme="light"` is what lets a
 * test (and a person with devtools open) read the current theme off the DOM instead of inferring
 * it from computed colours.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
}

/** `localStorage` throws in some privacy modes, and a failed preference must not break a page. */
function safeRead(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

let cache: Theme | null = null;
const listeners = new Set<() => void>();

function snapshot(): Theme {
  cache ??= parseTheme(safeRead());
  return cache;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: Theme): void {
  cache = next;
  applyTheme(next);
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The theme is still live for this session; only persistence was lost.
  }
  for (const listener of listeners) listener();
}

/**
 * Another tab changed the theme.
 *
 * A `storage` event fires in every *other* document on the origin and never in the one that
 * wrote. Registered at module scope for the same reason as `pins.ts`: the listener has to
 * outlive every component that subscribes, and one handler per hook call would add and remove a
 * global on every render of the panel.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    cache = null;
    applyTheme(snapshot());
    for (const listener of listeners) listener();
  });
}

export interface ThemeControl {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggle: () => void;
}

export function useTheme(): ThemeControl {
  const theme = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_THEME);

  const setTheme = useCallback((next: Theme): void => {
    commit(next);
  }, []);

  const toggle = useCallback((): void => {
    commit(nextTheme(snapshot()));
  }, []);

  return { theme, setTheme, toggle };
}
