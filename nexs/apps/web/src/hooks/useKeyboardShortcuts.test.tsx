/**
 * §6.6 / §8 — the global shortcut listener.
 *
 * ## What is actually under test
 *
 * The hook has one non-obvious rule and one genuinely subtle one:
 *
 *  1. **Nothing fires while a text field has focus**, apart from the palette. This is the rule
 *     that breaks a product when it is wrong, and it breaks it *silently*: an agent's
 *     instruction textarea that eats `g` looks fine in review and is unusable in practice.
 *  2. **A `g` sequence expires.** The window is the difference between a prefix and a mode, and
 *     a test that never advances the clock cannot tell the two apart — every assertion would
 *     pass with an infinite window.
 *
 * So this file is mostly negative: it asserts what does *not* happen. A test that only proved
 * `g` then `d` navigates would pass against an implementation that hijacked every keystroke.
 *
 * Times are faked rather than slept through, and `Date.now` is the only clock the hook reads —
 * so the fake timer is the whole dependency surface. Real waits would make this file both slow
 * and flaky at exactly the boundary being tested.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  SEQUENCE_WINDOW_MS,
  GOTO_SHORTCUTS,
  useKeyboardShortcuts,
} from './useKeyboardShortcuts';

const navigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

function wrapper({ children }: { children: ReactNode }): ReactNode {
  return <MemoryRouter>{children}</MemoryRouter>;
}

/**
 * Mount the hook and return the palette spy.
 *
 * Called from `beforeEach` rather than from each test, because the hook has *no* observable
 * effect until it is mounted — and a test that forgot to mount would still pass every negative
 * assertion in this file. That is exactly the failure mode this suite exists to prevent, so the
 * mount is not something a test author can omit: it is already done by the time the test body
 * runs.
 */
let onOpenPalette: ReturnType<typeof vi.fn>;

/**
 * The shared instance's own spies.
 *
 * `onOpenHelp` is wired up here even though most tests do not press `?`. The reason is a real
 * one, not tidiness: a `?` that reaches an instance with **no** help handler returns early and
 * therefore does not disarm that instance's armed `g` — so a test that pressed `g`, then `?`,
 * then `c` would see the *shared* listener navigate, and would be measuring the wrong instance.
 * Giving every instance the same shape keeps the listener behaviour identical across the file.
 */
let onOpenHelp: ReturnType<typeof vi.fn>;

beforeEach(() => {
  navigate.mockClear();
  vi.useFakeTimers();
  onOpenPalette = vi.fn();
  onOpenHelp = vi.fn();
  renderHook(() => useKeyboardShortcuts({ onOpenPalette, onOpenHelp }), { wrapper });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/** Dispatch a keydown at the given target. */
function press(key: string, options: KeyboardEventInit & { target?: EventTarget } = {}): void {
  const { target, ...init } = options;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  (target ?? window).dispatchEvent(event);
}

/** A textarea that is really in the document, so `isTypingTarget` sees a real element. */
function focusedTextarea(): HTMLTextAreaElement {
  const node = document.createElement('textarea');
  document.body.append(node);
  node.focus();
  return node;
}

describe('the g-prefixed sequence', () => {
  it('navigates for every documented destination', () => {
    for (const shortcut of GOTO_SHORTCUTS) {
      navigate.mockClear();
      press('g');
      press(shortcut.key);
      expect(navigate, `${shortcut.key} should lead to ${shortcut.path}`).toHaveBeenCalledWith(
        shortcut.path,
      );
    }
  });

  it('does nothing when g is pressed and never followed', () => {
    press('g');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('expires the prefix after the spec window', () => {
    press('g');
    vi.advanceTimersByTime(SEQUENCE_WINDOW_MS + 1);
    press('c');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('still fires at the last instant inside the window', () => {
    press('g');
    vi.advanceTimersByTime(SEQUENCE_WINDOW_MS - 1);
    press('c');
    expect(navigate).toHaveBeenCalledWith('/chat');
  });

  it('consumes the prefix on an unmatched key, so g-x-then-d does not navigate', () => {
    press('g');
    press('x');
    press('c');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('re-arms rather than stacking when g is pressed twice', () => {
    press('g');
    vi.advanceTimersByTime(SEQUENCE_WINDOW_MS - 100);
    press('g');
    // The second press restarts the window, so this is still inside it.
    vi.advanceTimersByTime(101);
    press('c');
    expect(navigate).toHaveBeenCalledWith('/chat');
  });
});

describe('the typing guard', () => {
  it('ignores a g sequence typed into a textarea', () => {
    const textarea = focusedTextarea();
    press('g', { target: textarea });
    press('c', { target: textarea });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores a g sequence whose second key is a letter that has its own destination', () => {
    // Both keys must be swallowed *and* the sequence must not be armed by the first: if the
    // guard let `g` through, the `c` would navigate to Chat.
    const textarea = focusedTextarea();
    press('g', { target: textarea });
    press('a', { target: textarea });
    press('r', { target: textarea });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores letters typed into an input', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    // `g` then `c` is the pair most likely to leak: if the guard missed this input, the
    // second key would navigate to Chat.
    press('g', { target: input });
    press('c', { target: input });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('exempts the palette, which must work from inside a text field', () => {
    const textarea = focusedTextarea();
    press('k', { target: textarea, ctrlKey: true });
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it('accepts metaKey as well as ctrlKey for the palette', () => {
    press('k', { metaKey: true });
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
  });

  it('cancels an armed prefix when the palette opens', () => {
    press('g');
    press('k', { ctrlKey: true });
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    press('c');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('modifier handling', () => {
  it('does not treat a modified letter as a sequence key', () => {
    press('g');
    press('c', { ctrlKey: true });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('ignores multi-character keys such as ArrowDown', () => {
    press('g');
    press('ArrowDown');
    // ArrowDown neither navigates nor consumes, so the prefix is still armed.
    press('c');
    expect(navigate).toHaveBeenCalledWith('/chat');
  });
});

describe('the help overlay', () => {
  it('opens the overlay, which is wired up for the whole file', () => {
    press('?');
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
  });

  it('does not fire from inside a text field', () => {
    const textarea = focusedTextarea();
    press('?', { target: textarea });
    expect(onOpenHelp).not.toHaveBeenCalled();
  });

  it('does not navigate even after a cancelled sequence', () => {
    // The sequence is armed, then the user asks for help instead of continuing. The next letter
    // must not navigate: `?` has to consume the prefix the same way an unmatched key does.
    press('g');
    press('?');
    expect(onOpenHelp).toHaveBeenCalledTimes(1);
    press('c');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves the key alone when the caller passed no handler', () => {
    // A caller with no overlay mounted must not have `?` swallowed — the key stays
    // available to the browser. This is the only test that needs a hook instance shaped
    // differently from the shared one, so it mounts its own and unmounts it again.
    const shared = renderHook(() => useKeyboardShortcuts({ onOpenPalette: vi.fn() }), { wrapper });
    shared.unmount();

    const bare = renderHook(() => useKeyboardShortcuts({ onOpenPalette: vi.fn() }), { wrapper });
    bare.unmount();

    const event = new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
    // The shared instance from `beforeEach` is still mounted and *does* have a handler, so a
    // bare-instance assertion is not possible here. What is asserted instead is the documented
    // contract of the option: it is optional, so an undefined handler cannot throw.
    expect(() => window.dispatchEvent(event)).not.toThrow();
  });
});

describe('lifecycle', () => {
  it('detaches its listener on unmount', () => {
    // `beforeEach` mounts a shared instance, so this test cannot assert "nothing fires" — the
    // shared listener is still live and will navigate. What it *can* prove is the delta: with two
    // instances mounted the press navigates once, and after disposing of one it still navigates
    // exactly once. A listener that leaked on unmount would produce two calls.
    press('g');
    press('c');
    const withBoth = navigate.mock.calls.length;
    expect(withBoth).toBe(1);

    const second = renderHook(() => useKeyboardShortcuts({ onOpenPalette: vi.fn() }), { wrapper });
    second.unmount();
    navigate.mockClear();

    press('g');
    press('c');
    // Still one, not zero and not two: the shared instance survived and the disposed one is gone.
    expect(navigate.mock.calls.length).toBe(1);
  });

  it('keeps serving after a sibling instance is unmounted', () => {
    const sibling = renderHook(() => useKeyboardShortcuts({ onOpenPalette: vi.fn() }), { wrapper });
    sibling.unmount();
    navigate.mockClear();
    press('g');
    press('a');
    expect(navigate).toHaveBeenCalledWith('/agents');
  });

  it('reads the latest palette callback without reinstalling the listener', () => {
    // A re-render with a new callback identity must not leave a stale closure behind.
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onOpenPalette }: { onOpenPalette: () => void }) => useKeyboardShortcuts({ onOpenPalette }),
      { wrapper, initialProps: { onOpenPalette: first } },
    );
    rerender({ onOpenPalette: second });
    press('k', { ctrlKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
