/**
 * The application shell — two regions, and the topbar.
 *
 * ## From three regions back to two
 *
 * This was three: a 56px rail of unlabelled glyphs, a 248px panel, and the task. The arithmetic
 * that produced it was real — twenty-one destinations and a conversation list do not fit in one
 * column — but the answer was wrong. Twenty-one unlabelled icons is not navigation; it is a key
 * you have to memorise. So the destinations moved into a modal, and the shell ended up with the
 * product's entire navigation behind a dialog and a conversation list in the column that was
 * always on screen.
 *
 * The mistake was treating *where you can go* and *what you have done* as different kinds of
 * thing. They are both the index of the work, and an index is one column with a search box at the
 * top of it. That column is `Sidebar`, and it is one region rather than two.
 *
 * So the shell is what it should always have been:
 *
 *  - **The sidebar** — conversations, the Capabilities and Schedulings groups, and the way into
 *    Settings. Every destination that is not in it is a row *inside* Settings, which is why the
 *    column can be this narrow and still be complete.
 *  - **The main pane** — the task. The topbar and the routed page.
 *
 * ## The topbar is deliberately almost empty
 *
 * It carries two things, both about the work: the command palette and the shortcut reference.
 * Three more used to live here — a connection dot, a notification bell and an account square —
 * and all three were state *about you* rather than about what you are reading. The bell is a
 * panel in Settings now, the account is the Profile panel, and the dot was deleted rather than
 * moved: the app already says "Offline" where it matters, and a light that is green all day is
 * decoration wearing the clothes of information.
 *
 * ## The content boundary sits inside the shell, not around it
 *
 * A boundary wrapping `<AppShell />` would replace the sidebar and the topbar with a spinner and
 * then bring them back — the whole frame blinking every time you open a section you have not
 * opened yet.
 */

import { Suspense, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Button, Loading } from '../ui';
import { Sidebar } from './Sidebar';

/**
 * The routes that fill the pane and scroll inside it rather than being a scrolling document.
 *
 * Three, for three different reasons and one mechanism:
 *
 *  - **Chat** — the composer has to stay reachable while a long transcript scrolls behind it, so
 *    the transcript is the scroller and the page is not.
 *  - **The terminal** — a command line pinned to the bottom of a scrolling document scrolls away
 *    from its own output.
 *  - **Settings** — it is a master-detail view: the section list and the panel each scroll, and
 *    the pane as a whole does not. A scrolling document around a two-column layout gives you two
 *    scrollbars fighting over one gesture.
 *
 * The shell is the only thing that knows the route, so it states the difference here rather than
 * making every page's CSS conditional on a descendant selector.
 */
const FLUSH_ROUTES = ['/chat', '/cli', '/settings'] as const;

export interface AppShellProps {
  onOpenPalette: () => void;
  /** Open §8's keybinding table. The topbar button and the `?` key reach the same overlay. */
  onOpenHelp: () => void;
}

export function AppShell({ onOpenPalette, onOpenHelp }: AppShellProps): ReactNode {
  const { pathname } = useLocation();

  const flush = FLUSH_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );

  return (
    <div className="app">
      {/* Keyboard users land here first; without it the sidebar's controls come before the page
          content in tab order on every navigation. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <Sidebar />

      <div className="main">
        <header className="topbar">
          <Button variant="ghost" onClick={onOpenPalette} title="Open the command palette">
            <span aria-hidden="true">⌘K</span>
            <span className="muted small">Search</span>
          </Button>

          <div className="grow" />

          <Button
            variant="ghost"
            onClick={onOpenHelp}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <span aria-hidden="true">?</span>
          </Button>
        </header>

        <main className={flush ? 'content content-flush' : 'content'} id="main">
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
