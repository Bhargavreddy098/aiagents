/**
 * The `⌘K` palette — §6.6, *"fuzzy over routes + actions"*.
 *
 * Routes come from `NAV_ITEMS` — every destination in the product, the same array the sidebar's
 * link groups and the Settings directory are derived from — so a section cannot be reachable in
 * one and missing from the other. The palette is the one surface that lists *all* of them,
 * including the two that no list renders (`/chat` and `/dashboard`, which are reached by a
 * control rather than a row). Actions are a short list of things that
 * genuinely do something today — each entry's `run` is a real call, not a placeholder. An
 * action that opens a dialog that does not exist yet is worse than an absent action: it
 * teaches the operator that the palette lies.
 *
 * Keyboard handling is inline rather than reusing a list component, because the palette has
 * one behaviour a general list does not: **the highlighted row must stay visible as the
 * arrow keys move it**, which means scrolling the active element into view on every change.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { NAV_ITEMS } from '../../lib/navigation';
import { fuzzyFilter } from '../../lib/fuzzy';
import { KEY_BINDINGS } from '../../lib/keybindings';
import { useAuth } from '../../features/auth/auth-context';
import { useMarkAllNotificationsRead } from '../../features/notifications/queries';
import { Button } from '../ui';

interface PaletteEntry {
  id: string;
  label: string;
  hint: string;
  kind: 'route' | 'action';
  run: () => void;
}

export interface CommandPaletteProps {
  onClose: () => void;
  /**
   * Open §8's keybinding table.
   *
   * The overlay is also bound to `?`, but it is listed here as well because *the palette is
   * where people look for it*: a user who wants to know what the interface can do opens `⌘K`,
   * and a shortcut reference that is absent from that list is a reference they will conclude
   * does not exist.
   */
  onOpenHelp: () => void;
}

export function CommandPalette({ onClose, onOpenHelp }: CommandPaletteProps): ReactNode {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { logout } = useAuth();
  const markAllRead = useMarkAllNotificationsRead();

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo<PaletteEntry[]>(() => {
    const routes: PaletteEntry[] = NAV_ITEMS.map((item) => ({
      id: `route:${item.path}`,
      label: item.label,
      hint: item.hint,
      kind: 'route',
      run: () => navigate(item.path),
    }));

    const actions: PaletteEntry[] = [
      {
        id: 'action:keybindings',
        label: 'Keyboard shortcuts',
        hint: `${KEY_BINDINGS.length} bindings, including the ones this surface cannot honour`,
        kind: 'action',
        run: () => onOpenHelp(),
      },
      {
        id: 'action:refresh',
        label: 'Refresh this page',
        hint: 'Refetch every query currently mounted',
        kind: 'action',
        run: () => void client.invalidateQueries(),
      },
      {
        id: 'action:mark-all-read',
        label: 'Mark all notifications read',
        hint: 'Clear the unread badge',
        kind: 'action',
        run: () => markAllRead.mutate(),
      },
      {
        id: 'action:sign-out',
        label: 'Sign out',
        hint: 'End this session on this device',
        kind: 'action',
        run: () => void logout(),
      },
    ];

    return [...routes, ...actions];
  }, [navigate, client, markAllRead, logout, onOpenHelp]);

  const results = useMemo(
    () => fuzzyFilter(query, entries, (entry) => `${entry.label} ${entry.hint}`),
    [query, entries],
  );

  // A new query re-ranks everything, so a cursor left at index 4 would point at a different
  // row — or past the end.
  useEffect(() => setCursor(0), [query]);

  const active = results[cursor];

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((value) => (results.length === 0 ? 0 : (value + 1) % results.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((value) =>
        results.length === 0 ? 0 : (value - 1 + results.length) % results.length,
      );
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active !== undefined) {
        onClose();
        active.item.run();
      }
    }
  };

  useEffect(() => {
    const node = listRef.current?.children[cursor];
    if (node instanceof HTMLElement) node.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <>
      <div className="scrim" onClick={onClose} role="presentation" />
      <div
        className="modal"
        style={{ top: '18%', transform: 'translate(-50%, 0)', maxHeight: '60vh' }}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
          <input
            className="input"
            // Deliberate, and the `jsx-a11y/no-autofocus` directive that used to sit here was
            // dead: that plugin is not installed, so the comment suppressed nothing and eslint
            // reported it as an unused directive. The autofocus itself is right — a palette
            // opened by an explicit keystroke is unusable if the user then has to click into it.
            autoFocus
            placeholder="Jump to a section, or run a command…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label="Search sections and commands"
          />
        </div>

        <div className="drawer-body" style={{ padding: 0 }}>
          {results.length === 0 ? (
            <div className="empty small">No match for “{query}”.</div>
          ) : (
            <ul ref={listRef} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {results.map((result, index) => (
                <li key={result.item.id}>
                  <button
                    type="button"
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => {
                      onClose();
                      result.item.run();
                    }}
                    style={{
                      all: 'unset',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 12,
                      width: '100%',
                      padding: '8px 12px',
                      cursor: 'pointer',
                      background: index === cursor ? 'var(--surface-hover)' : undefined,
                    }}
                  >
                    <span className="row">
                      <span className="muted small mono" style={{ width: 52 }}>
                        {result.item.kind === 'route' ? 'go' : 'run'}
                      </span>
                      <span>{result.item.label}</span>
                    </span>
                    <span className="muted small truncate">{result.item.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="drawer-foot">
          <span className="muted small">↑↓ to move · ⏎ to run · esc to close</span>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </footer>
      </div>
    </>
  );
}
