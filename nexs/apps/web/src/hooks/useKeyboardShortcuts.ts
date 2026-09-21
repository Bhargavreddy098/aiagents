/**
 * Keyboard shortcuts — §6.6.
 *
 * `⌘K` opens the command palette, and a `g`-prefixed sequence jumps to a section. The
 * sequence is the part worth getting right: `g` on its own does nothing, and the *next* key
 * is only read as a destination if it arrives within two seconds. Without the window, `g`
 * would become a mode you can be stuck in — type it, get distracted, and the next letter
 * you press teleports you somewhere.
 *
 * Two guards that are not optional:
 *
 *  - **Nothing fires while a text field has focus**, apart from the palette. A `g` typed
 *    into an agent's instructions must reach the textarea. The palette is exempt because
 *    it is the one shortcut people reach for *while* typing.
 *  - **The sequence is cancelled by any other key.** Pressing `g` then `x` should do
 *    nothing at all, rather than leaving `g` armed for the key after that.
 *
 * `?` opens the help overlay (§8). It is grouped with the palette rather than with the
 * sequence because it is *not* prefix-dependent and it is not a destination: the spec lists it
 * beside `⌘K` as one of the two ways to ask the interface what it can do.
 */

import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

/** The `g`-prefixed destinations, in the order they are documented. */
export const GOTO_SHORTCUTS: readonly { key: string; path: string; label: string }[] = [
  { key: 'd', path: '/dashboard', label: 'Dashboard' },
  { key: 'c', path: '/chat', label: 'Chat' },
  { key: 'a', path: '/agents', label: 'Agents' },
  { key: 'r', path: '/runs', label: 'Runs' },
  { key: 'i', path: '/approvals', label: 'Decision Inbox' },
];

/** How long the `g` prefix stays armed. The spec's own two seconds. */
export const SEQUENCE_WINDOW_MS = 2000;

/** Whether the event came from somewhere text is being typed. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface KeyboardShortcutOptions {
  onOpenPalette: () => void;
  /**
   * Open the keybinding help overlay (§8).
   *
   * Optional so a caller that has no overlay mounted does not have to pass a no-op: the `?` key
   * then simply does nothing, which is the same behaviour as never having bound it.
   */
  onOpenHelp?: () => void;
}

export function useKeyboardShortcuts({
  onOpenPalette,
  onOpenHelp,
}: KeyboardShortcutOptions): void {
  const navigate = useNavigate();
  // The handlers are read from refs so the listener is installed once and never has to be torn
  // down when a parent re-renders with a new callback identity.
  const paletteRef = useRef(onOpenPalette);
  paletteRef.current = onOpenPalette;
  const helpRef = useRef(onOpenHelp);
  helpRef.current = onOpenHelp;

  useEffect(() => {
    let armedUntil = 0;

    const onKeyDown = (event: KeyboardEvent): void => {
      // `metaKey` on macOS, `ctrlKey` elsewhere. Checked before the typing guard, because
      // the palette is the one shortcut that must work from inside an input.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        armedUntil = 0;
        paletteRef.current();
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      // `?` is Shift+/ on most layouts, so the event arrives as the character itself rather than
      // as a modifier chord — which is why this check sits below the modifier guard but still
      // inside the typing guard: a `?` typed into a textarea is a question mark, not a request.
      if (event.key === '?') {
        if (helpRef.current === undefined) return;
        event.preventDefault();
        // Disarms like any other key: someone who pressed `g`, then thought better of it and
        // asked for help, must not find that the next letter they type navigates them.
        armedUntil = 0;
        helpRef.current();
        return;
      }

      if (event.key.length !== 1) return;

      const key = event.key.toLowerCase();

      if (key === 'g') {
        armedUntil = Date.now() + SEQUENCE_WINDOW_MS;
        return;
      }

      if (Date.now() > armedUntil) return;

      // Any key at all consumes the sequence, whether or not it matches — so a mistyped
      // `g` cannot leave the prefix armed for an unrelated keystroke later.
      armedUntil = 0;

      const destination = GOTO_SHORTCUTS.find((entry) => entry.key === key);
      if (destination === undefined) return;

      event.preventDefault();
      navigate(destination.path);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate]);
}
