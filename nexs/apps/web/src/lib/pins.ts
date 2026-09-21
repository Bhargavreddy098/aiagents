/**
 * Pinned conversations.
 *
 * ## A pin is a view preference, and it is stored like one
 *
 * There is no pin column. `ChatSessionDto` has `id`, `title`, `agentId` and two timestamps, and
 * `PATCH /chat/sessions/:id` accepts `{title}` and nothing else — so a pin cannot be written to
 * the server, and inventing a client-side pin that *looked* server-backed would be a number on
 * screen with no row behind it.
 *
 * It is not a workaround to keep this in `localStorage`: whether a conversation is pinned is a
 * fact about the person reading the sidebar, not about the conversation. The honest cost is
 * stated where it is visible — the section header says "in this browser" — and the cost is
 * that a pin does not follow you to another machine.
 *
 * ## Stale ids are kept, not pruned
 *
 * Deleting a session leaves its id in the list. Pruning on read would mean writing to storage
 * during a render, and the filter that matters is the one the list already applies: a pin is
 * only ever rendered for a session that is in the loaded list. An id with no session is inert,
 * and keeping it means re-creating a session with the same id restores its pin.
 *
 * ## Why a module-level store rather than context
 *
 * The pinned set is read by the section that renders it and written by a row's own control.
 * Threading a provider through the shell to reach both would put a `PinnedProvider` between the
 * shell and every page for one boolean per row, and `useSyncExternalStore` gives the two
 * subscribers the same value without one.
 */

import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY = 'nexs.pinned-sessions';

/**
 * The storage key, exported.
 *
 * Two callers need it and neither can invent it: the `storage` listener below, which has to
 * recognise its own writes, and a test that wants to seed a pinned set before rendering. A
 * second copy of the string in either place would be a preference that silently stopped
 * persisting the day the key changed.
 */
export const PIN_STORAGE_KEY = STORAGE_KEY;

const EMPTY: readonly string[] = [];

/**
 * Read a stored list, refusing anything that is not one.
 *
 * Exported for its own test. Storage is shared with every other script on the origin and
 * survives upgrades, so the value found here is untrusted input — a `JSON.parse` inside a
 * component without this would take the whole sidebar down with a `SyntaxError` thrown during
 * render.
 */
export function parsePins(raw: string | null): readonly string[] {
  if (raw === null || raw === '') return EMPTY;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!Array.isArray(value)) return EMPTY;
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/** Add or remove, without mutating. Exported so the toggle rule is testable without a DOM. */
export function togglePin(ids: readonly string[], id: string): readonly string[] {
  return ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
}

/** `localStorage` throws in some privacy modes, and a failed preference must not break a page. */
function safeRead(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

// The cached snapshot. `useSyncExternalStore` compares by identity, so returning a fresh array
// from every read would re-render every subscriber on every unrelated event.
let cache: readonly string[] | null = null;
const listeners = new Set<() => void>();

function snapshot(): readonly string[] {
  cache ??= parsePins(safeRead());
  return cache;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: readonly string[]): void {
  cache = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The value is still live in memory for this session; only persistence was lost.
  }
  for (const listener of listeners) listener();
}

/**
 * Another tab changed the pins.
 *
 * The `storage` event fires in *every other* document on the origin and never in the one that
 * wrote, which is exactly the signal wanted: drop the cached snapshot and tell the subscribers.
 * Without it, pinning a conversation in one window would leave a second window showing the old
 * set until it was reloaded — and, because the cache never expires, potentially for the rest of
 * the session.
 *
 * Registering this at module scope is deliberate. The listener has to outlive every component
 * that subscribes, and the alternative — one listener per `usePins` call — would add and remove
 * a global handler on every panel render.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    // A `key` of `null` means `clear()` was called, which affects this key too.
    if (event.key !== null && event.key !== STORAGE_KEY) return;
    cache = null;
    for (const listener of listeners) listener();
  });
}

export interface Pins {
  pinned: readonly string[];
  toggle: (id: string) => void;
  isPinned: (id: string) => boolean;
}

export function usePins(): Pins {
  const pinned = useSyncExternalStore(
    subscribe,
    snapshot,
    () => EMPTY,
  );

  const toggle = useCallback((id: string): void => {
    commit(togglePin(snapshot(), id));
  }, []);

  const isPinned = useCallback((id: string): boolean => pinned.includes(id), [pinned]);

  return { pinned, toggle, isPinned };
}
