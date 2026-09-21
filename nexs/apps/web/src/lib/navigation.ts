/**
 * The navigation tree, and the command palette's index.
 *
 * ## One array, three lists
 *
 * Every route the product has is declared once, below, and the three surfaces that need a list
 * are *derived* from it:
 *
 *  - **The sidebar** renders the groups whose destinations say `home: 'sidebar'` — Capabilities
 *    and Schedulings. Its third block is not a list at all: it is the conversation list, which is
 *    data rather than navigation.
 *  - **Settings** renders the directory — the destinations that say `home: 'settings'`. These
 *    moved out of the sidebar because the sidebar is for *where you can go to do the work*, and
 *    these are the work itself.
 *  - **The command palette** reads `NAV_ITEMS`, which is all of them.
 *
 * Deriving rather than copying is the point. A route cannot be reachable from the sidebar but
 * missing from `⌘K`, or present in the palette but unlisted anywhere, because there is no second
 * place to register it.
 *
 * ## The two destinations no list renders
 *
 * Neither is a row in a list, and giving either one a row would be a lie about how it is reached:
 *
 *  - **Chat** is the session list. The sidebar's Sessions block *is* the way in, and a "Chat" row
 *    above it would be a second door to the same room that says nothing about which conversation
 *    you would land in. `+ New session` is the honest control, and it is there.
 *  - **Settings** is the sidebar's footer button. It cannot be a row inside the list of things it
 *    contains, for the same reason the old card could not live inside itself.
 *
 * Both stay in `NAV_ITEMS` — which is why `⌘K` finds them, and the only surface that lists all
 * seventeen destinations rather than the ten in one column.
 *
 * ## The spec's ordering
 *
 * §4-PHASE13.1 names the tree exactly — *"Dashboard, Chat, Agents, Goals, Tasks, Workflows, Runs,
 * Decision Inbox, Models, Tools, MCP, Connectors, Browser, Sandbox, Memory, Research, Settings —
 * no Traffic/Impact/Audit"*. The exclusion is as much a part of the contract as the inclusion:
 * Traffic, Impact and Audit are screens from an earlier design that this system has no data for,
 * and adding one would mean a page of invented numbers.
 *
 * The order below keeps the spec's relative order inside each group, so nothing was reordered —
 * it was re-filed. `/dashboard`, `/skills`, `/events` and `/files` are the four since-mounted
 * prefixes the spec's list predates; they are grouped where they belong rather than dropped.
 *
 * **Dashboard is a directory row, not a palette-only route**, and that was a correction rather
 * than a first guess. It started as `home: 'palette'` on the reasoning that a page of counts is
 * neither the work nor a way to do it — and that reasoning is fine, but it left the dashboard
 * reachable only by someone who already knew it existed and knew the palette. It is a page, so it
 * is a row in the Pages group with every other page.
 */

export interface NavItem {
  path: string;
  label: string;
  /** A glyph rather than an icon font, so there is no asset pipeline to go wrong. */
  icon: string;
  /** A short line for the command palette, since a bare label is ambiguous out of context. */
  hint: string;
}

/**
 * A group of destinations with a heading.
 *
 * `title` is a plain `string`, not `string | null`. There used to be a `NavSection` with a
 * nullable title for the ungrouped rows at the top of the old tree, and `SIDEBAR_GROUPS` inherited
 * the nullable type even though its builder can only ever produce a heading — which is how
 * `label={section.title}` reached a `string` prop as `string | null`. A type that admits a case
 * the code cannot produce is a type that pushes a null check onto every consumer for nothing.
 */
export interface NavGroup {
  title: string;
  items: readonly NavItem[];
}

/**
 * Where a destination is listed.
 *
 *  - `sidebar`   — a row in one of the sidebar's link groups (see `group`).
 *  - `settings`  — a row in the Settings directory.
 *  - `palette`   — the command palette only; no list renders it. See the header.
 */
export type NavHome = 'sidebar' | 'settings' | 'palette';

interface Destination extends NavItem {
  home: NavHome;
  /** The sidebar group. Read only when `home` is `sidebar`. */
  group?: string;
}

/**
 * Every destination, once.
 *
 * `icon` values are BMP glyphs that render as a single monochrome shape — `sigils.ts` states the
 * rule and the sidebar applies `font-variant-emoji: text` on top of it, because a few of these
 * (`⚡`, `⚙`, `⏱`) sit in the range where the platform decides and one of them rendering in
 * colour is the difference between a sidebar and a bag of stickers.
 */
const DESTINATIONS: readonly Destination[] = [
  // ── reached by a control rather than a row ────────────────────────────────
  { path: '/chat', label: 'Chat', icon: '✦', hint: 'Talk to an agent', home: 'palette' },
  { path: '/settings', label: 'Settings', icon: '⚙', hint: 'Your account, and every other page', home: 'palette' },

  // ── the sidebar: where you go to do the work ──────────────────────────────
  { path: '/models', label: 'Models', icon: '◈', hint: 'Providers and models', home: 'sidebar', group: 'Capabilities' },
  { path: '/tools', label: 'Tools', icon: '⚒', hint: 'The tool registry', home: 'sidebar', group: 'Capabilities' },
  { path: '/skills', label: 'Skills', icon: '❯', hint: 'Versioned prompt templates', home: 'sidebar', group: 'Capabilities' },
  { path: '/mcp', label: 'MCP', icon: '⬡', hint: 'Model Context Protocol servers', home: 'sidebar', group: 'Capabilities' },
  { path: '/connectors', label: 'Connectors', icon: '⚭', hint: 'External service accounts', home: 'sidebar', group: 'Capabilities' },
  { path: '/browser', label: 'Browser', icon: '◐', hint: 'Browser sessions', home: 'sidebar', group: 'Capabilities' },
  { path: '/sandbox', label: 'Sandbox', icon: '▣', hint: 'Code execution sessions', home: 'sidebar', group: 'Capabilities' },
  { path: '/cli', label: 'Terminal', icon: '»', hint: 'Run code on this machine', home: 'sidebar', group: 'Capabilities' },

  { path: '/schedules', label: 'Schedules', icon: '⏱', hint: 'Work that starts on a timetable', home: 'sidebar', group: 'Schedulings' },
  { path: '/events', label: 'Events', icon: '⚡', hint: 'Webhooks and what reacts to them', home: 'sidebar', group: 'Schedulings' },

  // ── the Settings directory: the work itself ───────────────────────────────
  { path: '/dashboard', label: 'Dashboard', icon: '▦', hint: 'Live workspace state', home: 'settings' },
  { path: '/agents', label: 'Agents', icon: '◆', hint: 'Configured agents', home: 'settings' },
  { path: '/goals', label: 'Goals', icon: '◎', hint: 'Outcomes with success criteria', home: 'settings' },
  { path: '/tasks', label: 'Tasks', icon: '☑', hint: 'Units of work', home: 'settings' },
  { path: '/workflows', label: 'Workflows', icon: '⇉', hint: 'Versioned step programs', home: 'settings' },
  { path: '/runs', label: 'Runs', icon: '▶', hint: 'Every execution, with its steps', home: 'settings' },
  { path: '/approvals', label: 'Decision Inbox', icon: '⚑', hint: 'Waiting on your decision', home: 'settings' },
  { path: '/memory', label: 'Memory', icon: '❖', hint: 'Stored facts, searchable', home: 'settings' },
  { path: '/research', label: 'Research', icon: '⌕', hint: 'Multi-source investigations', home: 'settings' },
  { path: '/files', label: 'Files', icon: '▤', hint: 'Folders an agent may reach', home: 'settings' },
];

/** A destination as a plain list row — `home` and `group` are filing, not presentation. */
function toNavItem(destination: Destination): NavItem {
  return {
    path: destination.path,
    label: destination.label,
    icon: destination.icon,
    hint: destination.hint,
  };
}

/** Every item, flattened, for the palette and the route table. */
export const NAV_ITEMS: readonly NavItem[] = DESTINATIONS.map(toNavItem);

/**
 * The sidebar's link groups, in the order they are declared above.
 *
 * The group order comes from the array rather than a separate constant, so moving a destination
 * between groups is a one-word edit and cannot desynchronise the heading order from the rows.
 */
export const SIDEBAR_GROUPS: readonly NavGroup[] = (() => {
  const sections: { title: string; items: NavItem[] }[] = [];
  for (const destination of DESTINATIONS) {
    if (destination.home !== 'sidebar') continue;
    const title = destination.group ?? 'Other';
    const existing = sections.find((section) => section.title === title);
    if (existing === undefined) {
      sections.push({ title, items: [toNavItem(destination)] });
    } else {
      existing.items.push(toNavItem(destination));
    }
  }
  return sections;
})();

/** The Settings directory, in declaration order. */
export const SETTINGS_DIRECTORY: readonly NavItem[] = DESTINATIONS.filter(
  (destination) => destination.home === 'settings',
).map(toNavItem);

/*
 * `activeNavPath` was here.
 *
 * It computed which row a path belongs to by longest prefix, so `/runs/abc` highlighted **Runs**
 * rather than a hypothetical `/r` and `/agents/new` still highlighted Agents. Nothing called it:
 * the sidebar renders `NavLink`, and the router already matches on segment boundaries and picks
 * the most specific route, which is the same rule. Keeping a second implementation of it beside
 * the first is how the highlight and the route table come to disagree, so it is gone rather than
 * left as an unused export that reads like the source of truth.
 */
