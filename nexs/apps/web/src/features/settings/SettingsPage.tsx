/**
 * Settings, as a master-detail view — §PHASE13.17.
 *
 * ## What was wrong with the two things this replaces
 *
 * There were two settings surfaces and neither was navigation, except that one of them was.
 *
 *  - **`SettingsCard`** was a modal opened from the rail. It held your account, your
 *    notifications, your theme — and also **every destination in the product**, as a
 *    grid of links. That is the bug: the way to anywhere was behind a dialog, and the column that
 *    was on screen the whole time held a conversation list.
 *  - **`SettingsPage`** was a route with five panels stacked on one scrolling document. Nothing
 *    was wrong with the panels; what was wrong was that finding one meant scrolling past four.
 *
 * Both are gone. The navigation is the sidebar, and Settings is a directory with a list on the
 * left and one panel on the right — click a section and it opens *in place*, which is what the
 * old card could not do and what a route per section would have made into a page load.
 *
 * ## Three groups, and the third is derived
 *
 *  - **Account** — Profile, Password, Appearance, Notifications, This session. About you.
 *  - **Workspace** — Command owner, Danger zone. About everyone in the tenant.
 *  - **Pages** — every destination in `SETTINGS_DIRECTORY`, each rendered by
 *    `DirectoryDetail` as a real count and a door.
 *
 * The third group is not written here. It is `SETTINGS_DIRECTORY`, the same array the sidebar and
 * the palette are derived from, so a destination cannot be reachable from `⌘K` and missing from
 * Settings. The first two groups *are* written here, because they are panels rather than routes
 * and there is nothing to derive them from.
 *
 * ## Why the section lives in the URL
 *
 * `?section=appearance`, for the same reason a conversation lives in `?session=`: a reload should
 * not lose your place, and a link to a specific panel should work. It is a query parameter rather
 * than a path segment so the route table does not grow sixteen entries for one screen — and
 * because `NavLink to="/settings"` in the sidebar then stays current on every panel without a
 * rule about which segments count.
 *
 * Switching sections uses `replace`. The section is a view state of one page, not a place: with
 * `push`, pressing back after clicking through three panels would walk backwards through them
 * instead of leaving Settings, which is not what back means.
 */

import { useCallback, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EmptyState } from '../../components/ui';
import { GOTO_SHORTCUTS } from '../../hooks/useKeyboardShortcuts';
import { SETTINGS_DIRECTORY, type NavItem } from '../../lib/navigation';
import { usePendingApprovalCount } from '../approvals/queries';
import { DirectoryDetail } from './DirectoryDetail';
import {
  AppearancePanel,
  DangerPanel,
  NotificationsPanel,
  OwnerPanel,
  PasswordPanel,
  ProfilePanel,
  SessionPanel,
} from './panels';

// ── the two decorations a row may carry ───────────────────────────────────────

/**
 * The `g`-sequence hint for a route, or `null`.
 *
 * Derived from the live binding table rather than written next to the row, so a hint cannot
 * advertise a key that does not navigate. This is the rule the old settings card followed and it
 * is worth keeping: a row that says `g a` because a design mock did is worse than a row with no
 * hint at all.
 *
 * Most directory rows have no binding. The ones that do are simply the entries of
 * `GOTO_SHORTCUTS` that happen to be directory paths — deliberately not restated here, because
 * the previous version of this comment named a count and was wrong within one change. That
 * sparseness is why the hint is optional rather than a column: a column would be mostly empty.
 */
function shortcutHint(path: string): string | null {
  const binding = GOTO_SHORTCUTS.find((entry) => entry.path === path);
  return binding === undefined ? null : `g ${binding.key}`;
}

/**
 * The path whose row carries the pending-decision count.
 *
 * A named constant rather than a bare string in the markup, because it is the one special case in
 * this file and it should read as a decision.
 *
 * **Why this row and not the sidebar.** A pending approval is the one thing in this product that
 * is genuinely blocking — a run is parked until a person decides — and the old rail carried the
 * count for exactly that reason. Decision Inbox now lives here, so the count lives on its row.
 * Putting it back on the sidebar's Settings button was considered and rejected: it would read as
 * "3 settings", and a number whose meaning has to be guessed is not information.
 */
const BADGED_PATH = '/approvals';


// ── the registry ──────────────────────────────────────────────────────────────

interface SettingsEntry {
  /** The `?section=` value. */
  id: string;
  label: string;
  /** A BMP glyph, monochrome — see the note on `DESTINATIONS` in `lib/navigation.ts`. */
  icon: string;
  /** The heading it files under in the list. */
  group: string;
  /** One line under the heading in the detail pane. Says what the panel is for. */
  blurb: string;
  /**
   * A **stable component reference**.
   *
   * Not a render function: calling one inline would put its hooks inside this component, and
   * switching panels would then change the number and order of hooks in one component — which is
   * the one thing React does not survive. A reference mounts and unmounts normally.
   */
  Component: () => ReactNode;
}

/** The group order, and the only place the three headings are spelled. */
const GROUPS = ['Account', 'Workspace', 'Pages'] as const;

const DEFAULT_SECTION_ID = 'profile';

/** The panels about you and the workspace. The directory is appended below. */
const CONFIG_ENTRIES: readonly SettingsEntry[] = [
  {
    id: 'profile',
    label: 'Profile',
    icon: '◉',
    group: 'Account',
    blurb: 'Your name, your address, and the workspace you are signed in to.',
    Component: ProfilePanel,
  },
  {
    id: 'password',
    label: 'Password',
    icon: '⚿',
    group: 'Account',
    blurb: 'Change it here. There is no device list — the panel says why.',
    Component: PasswordPanel,
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: '◐',
    group: 'Account',
    blurb: 'Light or dark. Stored in this browser, so it changes nothing for anyone else.',
    Component: AppearancePanel,
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: '◔',
    group: 'Account',
    blurb: 'What the server has told you, and the preferences it cannot be told to honour.',
    Component: NotificationsPanel,
  },
  {
    id: 'session',
    label: 'This session',
    icon: '⏻',
    group: 'Account',
    blurb: 'Sign out of this browser.',
    Component: SessionPanel,
  },
  {
    id: 'owner',
    label: 'Command owner',
    icon: '♛',
    group: 'Workspace',
    blurb: 'The account allowed to run owner-only commands, and how to claim or clear it.',
    Component: OwnerPanel,
  },
  {
    id: 'danger',
    label: 'Danger zone',
    icon: '⚠',
    group: 'Workspace',
    blurb: 'There is no delete button. There is a list of the destructive operations that exist.',
    Component: DangerPanel,
  },
];

/**
 * One directory destination as an entry.
 *
 * The component is created here, once, at module load — not during render. An inline arrow in a
 * `map` inside the component body would be a **new function identity on every render**, and React
 * compares types by identity: every render would unmount the subtree and mount a fresh one. With
 * a query inside it, that is a request per render.
 */
function directoryEntry(item: NavItem): SettingsEntry {
  function DirectorySummary(): ReactNode {
    return <DirectoryDetail item={item} />;
  }

  return {
    id: item.path,
    label: item.label,
    icon: item.icon,
    group: 'Pages',
    blurb: item.hint,
    Component: DirectorySummary,
  };
}

const DIRECTORY_ENTRIES: readonly SettingsEntry[] = SETTINGS_DIRECTORY.map(directoryEntry);

const ENTRIES: readonly SettingsEntry[] = [...CONFIG_ENTRIES, ...DIRECTORY_ENTRIES];

/** By id, or `null` — an unrecognised `?section=` is a miss, not a crash. */
function entryFor(id: string | null): SettingsEntry | null {
  for (const entry of ENTRIES) {
    if (entry.id === id) return entry;
  }
  return null;
}

// ── the page ──────────────────────────────────────────────────────────────────

export function SettingsPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const entry = entryFor(params.get('section')) ?? entryFor(DEFAULT_SECTION_ID);

  // The same query the Decision Inbox pane reads, so TanStack serves both from one request — the
  // badge costs nothing beyond the read that is already happening.
  const pendingApprovals = usePendingApprovalCount();

  const select = useCallback(
    (id: string): void => {
      // The default is spelled as an absent parameter, so `/settings` is the canonical URL for
      // the panel the page opens on and `/settings?section=profile` is not a second address for
      // the same view.
      setParams(id === DEFAULT_SECTION_ID ? {} : { section: id }, { replace: true });
    },
    [setParams],
  );

  if (entry === null) {
    // Unreachable: `DEFAULT_SECTION_ID` names an entry in `CONFIG_ENTRIES`, and
    // `SettingsPage.test.tsx` asserts it. Rendered rather than asserted away, because a blank
    // page is the one failure mode a reader cannot diagnose.
    return (
      <EmptyState
        title="No such settings section"
        hint="That section is not part of Settings. Use the list to pick one."
      />
    );
  }

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label="Settings sections">
        {GROUPS.map((group) => {
          const items = ENTRIES.filter((candidate) => candidate.group === group);
          // A group with nothing in it is not rendered. It cannot happen with the three above,
          // but the alternative is a heading over a gap the day one of them empties.
          if (items.length === 0) return null;

          return (
            <div className="settings-nav-group" key={group}>
              <h2 className="settings-nav-heading">{group}</h2>
              <ul className="settings-nav-list">
                {items.map((item) => {
                  const hint = shortcutHint(item.id);
                  const badge = item.id === BADGED_PATH ? pendingApprovals : 0;

                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="settings-nav-item"
                        // `true` rather than `page`: these are panels of one page, not pages. A
                        // screen reader announces "current" either way, without claiming the
                        // document changed.
                        aria-current={item.id === entry.id ? 'true' : undefined}
                        onClick={() => select(item.id)}
                      >
                        <span className="settings-nav-glyph" aria-hidden="true">
                          {item.icon}
                        </span>
                        <span className="settings-nav-label">{item.label}</span>
                        {badge > 0 ? <span className="work-count">{badge}</span> : null}
                        {hint === null ? null : <span className="work-kbd">{hint}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="settings-pane">
        <header className="settings-pane-head">
          <h1 className="settings-pane-title">{entry.label}</h1>
          <p className="settings-pane-blurb">{entry.blurb}</p>
        </header>

        <div className="settings-pane-body">
          <entry.Component />
        </div>
      </div>
    </div>
  );
}
