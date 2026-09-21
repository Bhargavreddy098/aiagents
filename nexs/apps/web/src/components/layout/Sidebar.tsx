/**
 * The sidebar — where you can go and what you have been doing, in one column.
 *
 * ## One column instead of three
 *
 * The shell used to be three regions: a 56px rail of unlabelled glyphs, a 248px panel, and the
 * task. The rail was the problem. A destination list this long cannot be a row of icons — an icon with
 * no label is not navigation, it is a key you have to memorise, and the label only existed on
 * hover. So the destinations migrated into `SettingsCard`, and the shell ended up with a *modal*
 * holding the whole product's navigation while the column beside it held a conversation list.
 * That is the shape that was wrong: the way to anywhere was behind a dialog, and the column that
 * was always on screen held the least.
 *
 * The fix is not a fourth region. It is to stop treating "where you can go" and "what you have
 * done" as different kinds of thing — both are *the index of the work*, and an index belongs in
 * one column with the search box at the top of it.
 *
 * So: one sidebar, `--sidebar-w` wide, three blocks and a footer.
 *
 *  - **Sessions** — the conversation list, filter above it. This is data.
 *  - **Capabilities** and **Schedulings** — the link groups from `SIDEBAR_GROUPS`. This is
 *    navigation. Two groups rather than eight sibling rows because a heading labels a *kind* of
 *    thing, and eight unlabelled rows is a list you read rather than scan.
 *  - **Settings** — the footer button. Everything else — Agents, Goals, Tasks, Workflows, Runs,
 *    Decision Inbox, Memory, Research, Files — is a row *inside* Settings, because those are the
 *    work itself rather than the way to it. `lib/navigation.ts` states the split and derives the
 *    three lists from one array, so this file never names a destination.
 *
 * ## What left, and why the loss is not a loss
 *
 * The panel also held an **Agents** tab and a **Scheduled jobs** preview. Neither is in the
 * sidebar. Agents is a Settings row now. The jobs preview was three upcoming runs with a
 * fire-now button, which duplicated `/schedules` inside the column that is meant to be an index —
 * and a control that *starts work* is not an index entry. The full timetable is one click away,
 * in the Schedulings group just above the footer.
 *
 * ## The filter narrows the whole column, not half of it
 *
 * The input sits above both the conversation list and the link groups, so it narrows both. A box
 * that silently ignored the eight rows underneath it would be a lie about its own scope. It is
 * `fuzzyMatch` used to *test* each row, never `fuzzyFilter` to rank them: the list's order is
 * time, and reordering it under the person typing destroys the one thing that makes a
 * conversation findable — where it sits.
 *
 * `⌘K` remains the palette, and it searches the same `NAV_ITEMS` this column is built from.
 *
 * ## Rows, and what their controls are allowed to do
 *
 * Unchanged from the panel. The hover strip replaces the timestamp — pin, rename, delete — and
 * nothing else: no context menu, because the three actions here are the three anyone wants and a
 * menu would need dismiss logic, a focus trap and a portal to escape this scroll container.
 * Deleting asks first, and deleting the conversation you are reading leaves it.
 */

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate, useSearchParams } from 'react-router-dom';
import type { ChatSessionSummary } from '@nexs/shared';
import { fuzzyMatch } from '../../lib/fuzzy';
import { formatDateTime } from '../../lib/format';
import { usePins } from '../../lib/pins';
import { SIDEBAR_GROUPS } from '../../lib/navigation';
import {
  groupSessions,
  sessionActivityAt,
  sessionLabel,
  shortRelative,
} from '../../lib/session-groups';
import {
  useChatSessions,
  useDeleteChatSession,
  useRenameChatSession,
} from '../../features/chat/queries';

// ── section shell ─────────────────────────────────────────────────────────────

interface PanelSectionProps {
  id: string;
  label: string;
  /** A small right-aligned note — a count, or a caveat like "in this browser". */
  meta?: string;
  collapsed: boolean;
  onToggle: (id: string) => void;
  children: ReactNode;
}

/**
 * One collapsible group.
 *
 * The disclosure control is the label itself rather than a caret beside it: at this size two
 * targets 8px apart is one target with a coin flip attached. The caret is decoration and follows
 * the label's own hover.
 */
function PanelSection({
  id,
  label,
  meta,
  collapsed,
  onToggle,
  children,
}: PanelSectionProps): ReactNode {
  return (
    <section className="work-section">
      <div className="work-section-head">
        <button
          type="button"
          className="work-section-toggle"
          aria-expanded={!collapsed}
          onClick={() => onToggle(id)}
        >
          <span className="work-section-caret" aria-hidden="true">
            {collapsed ? '›' : '⌄'}
          </span>
          <span className="work-section-label">{label}</span>
          {meta === undefined ? null : <span className="work-section-meta">{meta}</span>}
        </button>
      </div>

      {collapsed ? null : <div className="work-section-body">{children}</div>}
    </section>
  );
}

/** Three placeholder rows, so the column does not jump when the list arrives. */
function PanelSkeleton(): ReactNode {
  return (
    <div className="work-skeleton" aria-hidden="true">
      <span className="skeleton work-skel-row" />
      <span className="skeleton work-skel-row" />
      <span className="skeleton work-skel-row" />
    </div>
  );
}

// ── rows ──────────────────────────────────────────────────────────────────────

interface SessionRowProps {
  session: ChatSessionSummary;
  active: boolean;
  pinned: boolean;
  onOpen: (id: string) => void;
  onTogglePin: (id: string) => void;
  onRename: (session: ChatSessionSummary) => void;
  onDelete: (session: ChatSessionSummary) => void;
}

/**
 * A conversation, one line tall.
 *
 * The row is a container and the title is a button inside it, rather than the row being the
 * button. Three controls cannot live inside a fourth — nested interactive elements are invalid
 * HTML, and a browser resolves the ambiguity by dropping one of them.
 */
function SessionRow({
  session,
  active,
  pinned,
  onOpen,
  onTogglePin,
  onRename,
  onDelete,
}: SessionRowProps): ReactNode {
  const activity = sessionActivityAt(session);

  return (
    <div className="session-row" data-active={active ? 'true' : undefined}>
      <button type="button" className="session-open" onClick={() => onOpen(session.id)}>
        <span className="session-dot" aria-hidden="true" />
        <span className="session-title">{sessionLabel(session)}</span>
      </button>

      <span className="session-age" title={formatDateTime(activity)}>
        {shortRelative(activity)}
      </span>

      <span className="session-actions">
        <button
          type="button"
          className="session-action"
          aria-label={pinned ? `Unpin ${sessionLabel(session)}` : `Pin ${sessionLabel(session)}`}
          aria-pressed={pinned}
          title={pinned ? 'Unpin' : 'Pin'}
          onClick={() => onTogglePin(session.id)}
        >
          {pinned ? '◆' : '◇'}
        </button>
        <button
          type="button"
          className="session-action"
          aria-label={`Rename ${sessionLabel(session)}`}
          title="Rename"
          onClick={() => onRename(session)}
        >
          ✎
        </button>
        <button
          type="button"
          className="session-action session-action-danger"
          aria-label={`Delete ${sessionLabel(session)}`}
          title="Delete"
          onClick={() => onDelete(session)}
        >
          ✕
        </button>
      </span>
    </div>
  );
}

/**
 * One destination.
 *
 * `NavLink`, so `aria-current="page"` is set by the router rather than by a hand-rolled
 * longest-prefix comparison. The router already matches `/runs/abc` to `/runs` at a segment
 * boundary and picks the most specific match, which is exactly the rule this used to implement
 * itself — one fewer place for the highlight to disagree with the route table.
 */
function NavRow({ path, icon, label, hint }: { path: string; icon: string; label: string; hint: string }): ReactNode {
  return (
    <NavLink className="work-primary-row" to={path} title={hint}>
      <span className="work-primary-glyph" aria-hidden="true">
        {icon}
      </span>
      <span className="work-primary-label">{label}</span>
    </NavLink>
  );
}

// ── the sidebar ───────────────────────────────────────────────────────────────

export function Sidebar(): ReactNode {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const activeSessionId = params.get('session');

  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<readonly string[]>([]);

  const sessions = useChatSessions();

  // Destructured rather than kept as one object: `usePins` returns a fresh object every render,
  // so a `useMemo` that depended on `pins` would recompute on every render and memoise nothing.
  // The members are individually stable.
  const { toggle: togglePin, isPinned } = usePins();
  const rename = useRenameChatSession();
  const remove = useDeleteChatSession();

  const query = filter.trim();

  const toggleSection = useCallback((id: string): void => {
    setCollapsed((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }, []);

  const isCollapsed = useCallback((id: string) => collapsed.includes(id), [collapsed]);

  const openSession = useCallback(
    (id: string): void => {
      // `replace` would make the back button skip the conversation you were reading, and the
      // point of putting the session in the URL is that history is meaningful.
      navigate(`/chat?session=${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  const renameSession = useCallback(
    (session: ChatSessionSummary): void => {
      const next = window.prompt('Rename this conversation', sessionLabel(session));
      if (next === null || next.trim() === '') return;
      rename.mutate({ id: session.id, title: next.trim() });
    },
    [rename],
  );

  const deleteSession = useCallback(
    (session: ChatSessionSummary): void => {
      const confirmed = window.confirm(
        `Delete “${sessionLabel(session)}”? Its messages go with it, and this cannot be undone.`,
      );
      if (!confirmed) return;
      remove.mutate(session.id, {
        onSuccess: () => {
          // Deleting the conversation that is open has to leave it, or the transcript keeps
          // rendering a session the server no longer has.
          if (session.id === activeSessionId) navigate('/chat');
        },
      });
    },
    [remove, activeSessionId, navigate],
  );

  // ── the lists ───────────────────────────────────────────────────────────────

  const visibleSessions = useMemo(() => {
    const all = sessions.data ?? [];
    if (query === '') return all;
    // Tested, not ranked — see the note at the top of the file.
    return all.filter((session) => fuzzyMatch(query, sessionLabel(session)) !== null);
  }, [sessions.data, query]);

  // `isPinned` is rebuilt whenever the pinned set changes, so it is the dependency that makes
  // this correct — not the array itself.
  const pinnedSessions = useMemo(
    () => visibleSessions.filter((session) => isPinned(session.id)),
    [visibleSessions, isPinned],
  );

  const grouped = useMemo(() => groupSessions(visibleSessions), [visibleSessions]);

  /**
   * The link groups, narrowed by the same query.
   *
   * A group whose every row is filtered out is dropped rather than left as a heading over
   * nothing, so an empty sidebar means "nothing here matches" and not "look harder".
   */
  const groups = useMemo(() => {
    if (query === '') return SIDEBAR_GROUPS;
    return SIDEBAR_GROUPS.map((section) => ({
      title: section.title,
      items: section.items.filter((item) => fuzzyMatch(query, item.label) !== null),
    })).filter((section) => section.items.length > 0);
  }, [query]);

  const total = (sessions.data ?? []).length;

  return (
    <aside className="sidebar" aria-label="Navigation and conversations">
      <div className="sidebar-head">
        <Link className="sidebar-brand" to="/chat" title="NEXS">
          {/* The mark is decorative and the wordmark carries the name, so a screen reader hears
              "NEXS" once rather than "N" and then "NEXS". */}
          <span className="sidebar-mark" aria-hidden="true">
            N
          </span>
          <span className="sidebar-wordmark">NEXS</span>
        </Link>

        {/*
          The one control that starts something. It is here rather than inside the Sessions
          section because it stays reachable when that section is collapsed or scrolled, and
          because "new conversation" is the thing this product is for.
        */}
        <button
          type="button"
          className="sidebar-new"
          title="New session"
          aria-label="New session"
          onClick={() => navigate('/chat')}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>

      <label className="work-filter">
        <span className="visually-hidden">Filter sessions and sections</span>
        <input
          className="work-filter-input"
          type="search"
          value={filter}
          placeholder="Filter sessions and sections"
          onChange={(event) => setFilter(event.target.value)}
        />
      </label>

      <div className="work-scroll">
        <PanelSection
          id="sessions"
          label="Sessions"
          meta={sessions.data === undefined ? undefined : String(visibleSessions.length)}
          collapsed={isCollapsed('sessions')}
          onToggle={toggleSection}
        >
          {sessions.isPending ? (
            <PanelSkeleton />
          ) : sessions.isError ? (
            // Not an empty list. A 500 rendered as "no conversations" is the one failure this
            // codebase refuses everywhere else, and the sidebar is not exempt.
            <p className="work-note">Could not load conversations.</p>
          ) : (
            <>
              {pinnedSessions.length > 0 ? (
                <PanelSection
                  id="pinned"
                  label="Pinned"
                  meta="in this browser"
                  collapsed={isCollapsed('pinned')}
                  onToggle={toggleSection}
                >
                  {pinnedSessions.map((session) => (
                    <SessionRow
                      key={`pin-${session.id}`}
                      session={session}
                      active={session.id === activeSessionId}
                      pinned
                      onOpen={openSession}
                      onTogglePin={togglePin}
                      onRename={renameSession}
                      onDelete={deleteSession}
                    />
                  ))}
                </PanelSection>
              ) : null}

              {grouped.length === 0 ? (
                /*
                 * Scoped to conversations, because that is what this block holds.
                 *
                 * The message used to be "Nothing matches" at the bottom of the column, and when
                 * the filter narrowed both halves it appeared twice — once here and once there.
                 * One message, in the block that is actually empty, and precise about what is
                 * empty: a filter that matches no conversation but does match a destination has
                 * not emptied the column, and saying it had would be wrong.
                 */
                <p className="work-note">
                  {total === 0
                    ? 'No conversations yet — send the first message to start one.'
                    : `No conversation matches “${query}”.`}
                </p>
              ) : (
                grouped.map((group) => (
                  <PanelSection
                    key={group.key}
                    id={`group-${group.key}`}
                    label={group.label}
                    meta={String(group.items.length)}
                    collapsed={isCollapsed(`group-${group.key}`)}
                    onToggle={toggleSection}
                  >
                    {group.items.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === activeSessionId}
                        pinned={isPinned(session.id)}
                        onOpen={openSession}
                        onTogglePin={togglePin}
                        onRename={renameSession}
                        onDelete={deleteSession}
                      />
                    ))}
                  </PanelSection>
                ))
              )}
            </>
          )}
        </PanelSection>

        {groups.map((section) => (
          <PanelSection
            key={section.title}
            id={`nav-${section.title}`}
            label={section.title}
            meta={String(section.items.length)}
            collapsed={isCollapsed(`nav-${section.title}`)}
            onToggle={toggleSection}
          >
            {section.items.map((item) => (
              <NavRow
                key={item.path}
                path={item.path}
                icon={item.icon}
                label={item.label}
                hint={item.hint}
              />
            ))}
          </PanelSection>
        ))}
      </div>

      {/*
        The footer, and the only destination that is deliberately not in a group.

        Settings cannot be a row inside the list of things it contains — the same reason the old
        card could not live inside itself. It is pinned to the bottom so it is at a fixed place
        on every screen rather than wherever the conversation list happens to end.
      */}
      <div className="sidebar-foot">
        <NavLink className="work-primary-row" to="/settings" title="Settings">
          <span className="work-primary-glyph" aria-hidden="true">
            ⚙
          </span>
          <span className="work-primary-label">Settings</span>
        </NavLink>
      </div>
    </aside>
  );
}
