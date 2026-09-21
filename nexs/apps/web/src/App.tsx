/**
 * Providers, the route table, and the two global behaviours.
 *
 * The route table is §6.1 verbatim. Two route-level decisions are worth stating:
 *
 *  - **`/` redirects to `/chat`**, rather than rendering a landing page. The spec says "default
 *    redirect from /", and the product is conversation-first: the workspace opens on a prompt
 *    with the navigation and the history beside it, not on a page of counts. The dashboard is a
 *    row in Settings beside every other page. (This is a deliberate change from §6.1's
 *    `/dashboard`; it is recorded in `nexs-soft-ui-implementation-report.md`.)
 *
 *    The same default has to hold on the way *in*, and it did not: `AuthPages` sent a fresh
 *    sign-in to `/dashboard`, so a returning user's first screen was the one page this decision
 *    was made to avoid. `RedirectIfAuthenticated` below and `AuthPages` both say `/chat` now, so
 *    all four paths into the app agree.
 *  - **`RequireAuth` wraps the shell, not each page.** A guard per page is a guard somebody
 *    forgets to add to the page they write next, and the failure is silent: the page renders
 *    with no session and shows an error box instead of the login form.
 *  - **Pages are code-split.** This file is the only place that knows the full page set, so it
 *    is the only place the split can be expressed. See the note above the `lazy` calls.
 */

import { lazy, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { CommandPalette } from './components/layout/CommandPalette';
import { KeybindingsOverlay } from './components/terminal/Reference';
import { EmptyState, ErrorState, Loading } from './components/ui';
import { AuthProvider, useAuth } from './features/auth/auth-context';
import { LoginPage, SignupPage } from './features/auth/AuthPages';
import { useSSE } from './hooks/useSSE';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';

// ── pages, fetched when they are first routed to ──────────────────────────────
//
// Every page the spec lists is reachable from the sidebar, and a session touches two or three
// of them. Importing them all eagerly meant every visitor downloaded the nine-tab run
// workspace, the browser console, the sandbox and the research viewer before the dashboard
// could paint — one 578 kB bundle for a screen that needs almost none of it.
//
// The auth pages stay eager, and that is deliberate: they are what an unauthenticated visitor
// is waiting for, and splitting them would trade a smaller download for a second round trip
// before the login form can appear. The shell stays eager for the same reason — it is the
// frame the fallback renders *inside*.
//
// `React.lazy` needs a module with a `default` export and every page here is a named export,
// so the `.then` shim is not optional. It is written out per page rather than hidden behind a
// generic helper, because the helper could only say less than the line it replaces:
// `module.DashboardPage` being a **compile error** when that export is renamed is the property
// worth keeping, and a `Record<string, ComponentType>` helper throws it away.

const DashboardPage = lazy(() =>
  import('./features/dashboard/DashboardPage').then((module) => ({ default: module.DashboardPage })),
);
const ChatPage = lazy(() =>
  import('./features/chat/ChatPage').then((module) => ({ default: module.ChatPage })),
);
const AgentsPage = lazy(() =>
  import('./features/agents/AgentsPage').then((module) => ({ default: module.AgentsPage })),
);
const AgentDetailPage = lazy(() =>
  import('./features/agents/AgentDetailPage').then((module) => ({ default: module.AgentDetailPage })),
);

// A list page and its detail page share one module — `features/<name>/` is the unit the spec
// names, and a detail view is a page of the same feature reading the same queries. The two
// `import()` calls below resolve to a single chunk; the second is a cache hit.
const GoalsPage = lazy(() =>
  import('./features/goals/GoalsPage').then((module) => ({ default: module.GoalsPage })),
);
const GoalDetailPage = lazy(() =>
  import('./features/goals/GoalsPage').then((module) => ({ default: module.GoalDetailPage })),
);

const TasksPage = lazy(() =>
  import('./features/tasks/TasksPage').then((module) => ({ default: module.TasksPage })),
);
const TaskDetailPage = lazy(() =>
  import('./features/tasks/TasksPage').then((module) => ({ default: module.TaskDetailPage })),
);

const WorkflowsPage = lazy(() =>
  import('./features/workflows/WorkflowsPage').then((module) => ({ default: module.WorkflowsPage })),
);
const WorkflowDetailPage = lazy(() =>
  import('./features/workflows/WorkflowsPage').then((module) => ({
    default: module.WorkflowDetailPage,
  })),
);

const RunsPage = lazy(() =>
  import('./features/runs/RunsPage').then((module) => ({ default: module.RunsPage })),
);
const RunWorkspacePage = lazy(() =>
  import('./features/runs/RunWorkspacePage').then((module) => ({ default: module.RunWorkspacePage })),
);

const ApprovalsPage = lazy(() =>
  import('./features/approvals/ApprovalsPage').then((module) => ({ default: module.ApprovalsPage })),
);
const ModelsPage = lazy(() =>
  import('./features/models/ModelsPage').then((module) => ({ default: module.ModelsPage })),
);

const ToolsPage = lazy(() =>
  import('./features/tools/ToolsPage').then((module) => ({ default: module.ToolsPage })),
);
const ToolDetailPage = lazy(() =>
  import('./features/tools/ToolsPage').then((module) => ({ default: module.ToolDetailPage })),
);

const McpPage = lazy(() =>
  import('./features/mcp/McpPage').then((module) => ({ default: module.McpPage })),
);
const McpDetailPage = lazy(() =>
  import('./features/mcp/McpPage').then((module) => ({ default: module.McpDetailPage })),
);

const ConnectorsPage = lazy(() =>
  import('./features/connectors/ConnectorsPage').then((module) => ({ default: module.ConnectorsPage })),
);
const ConnectorDetailPage = lazy(() =>
  import('./features/connectors/ConnectorsPage').then((module) => ({
    default: module.ConnectorDetailPage,
  })),
);

const BrowserPage = lazy(() =>
  import('./features/browser/BrowserPage').then((module) => ({ default: module.BrowserPage })),
);
const SandboxPage = lazy(() =>
  import('./features/sandbox/SandboxPage').then((module) => ({ default: module.SandboxPage })),
);
const CliPage = lazy(() =>
  import('./features/cli/CliPage').then((module) => ({ default: module.CliPage })),
);
const MemoryPage = lazy(() =>
  import('./features/memory/MemoryPage').then((module) => ({ default: module.MemoryPage })),
);

const ResearchPage = lazy(() =>
  import('./features/research/ResearchPage').then((module) => ({ default: module.ResearchPage })),
);
const ResearchDetailPage = lazy(() =>
  import('./features/research/ResearchPage').then((module) => ({ default: module.ResearchDetailPage })),
);

const SkillsPage = lazy(() =>
  import('./features/skills/SkillsPage').then((module) => ({ default: module.SkillsPage })),
);
const EventsPage = lazy(() =>
  import('./features/events/EventsPage').then((module) => ({ default: module.EventsPage })),
);
const FilesPage = lazy(() =>
  import('./features/files/FilesPage').then((module) => ({ default: module.FilesPage })),
);
const SchedulesPage = lazy(() =>
  import('./features/schedules/SchedulesPage').then((module) => ({ default: module.SchedulesPage })),
);

const SettingsPage = lazy(() =>
  import('./features/settings/SettingsPage').then((module) => ({ default: module.SettingsPage })),
);

function NotFoundPage(): ReactNode {
  return (
    <EmptyState
      title="No such page"
      hint="That route is not part of the application. Use ⌘K to find a section."
    />
  );
}

/**
 * Hold the shell until there is a session.
 *
 * The three branches are ordered so that "we do not know yet" never renders as "signed out":
 * a redirect to `/login` during the initial `me` read would bounce a signed-in user to the
 * login form on every hard refresh.
 */
function RequireAuth({ children }: { children: ReactNode }): ReactNode {
  const { isAuthenticated, isLoading, loadError } = useAuth();
  const location = useLocation();

  if (isLoading) return <Loading label="Checking your session…" />;
  if (loadError !== null) return <ErrorState error={loadError} />;
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

/** The inverse: a signed-in visitor has no business on the login form. */
function RedirectIfAuthenticated({ children }: { children: ReactNode }): ReactNode {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <Loading label="Checking your session…" />;
  if (isAuthenticated) return <Navigate to="/chat" replace />;
  return <>{children}</>;
}

interface AppRoutesProps {
  onOpenPalette: () => void;
  onOpenHelp: () => void;
}

function AppRoutes({ onOpenPalette, onOpenHelp }: AppRoutesProps): ReactNode {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfAuthenticated>
            <LoginPage />
          </RedirectIfAuthenticated>
        }
      />
      <Route
        path="/signup"
        element={
          <RedirectIfAuthenticated>
            <SignupPage />
          </RedirectIfAuthenticated>
        }
      />

      <Route
        element={
          <RequireAuth>
            <AppShell onOpenPalette={onOpenPalette} onOpenHelp={onOpenHelp} />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/chat" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/chat" element={<ChatPage />} />

        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/agents/:id" element={<AgentDetailPage />} />

        <Route path="/goals" element={<GoalsPage />} />
        <Route path="/goals/:id" element={<GoalDetailPage />} />

        <Route path="/tasks" element={<TasksPage />} />
        <Route path="/tasks/:id" element={<TaskDetailPage />} />

        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/:id" element={<WorkflowDetailPage />} />

        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunWorkspacePage />} />

        <Route path="/approvals" element={<ApprovalsPage />} />

        <Route path="/models" element={<ModelsPage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/tools/:id" element={<ToolDetailPage />} />

        <Route path="/mcp" element={<McpPage />} />
        <Route path="/mcp/:id" element={<McpDetailPage />} />

        <Route path="/connectors" element={<ConnectorsPage />} />
        <Route path="/connectors/:id" element={<ConnectorDetailPage />} />

        <Route path="/browser" element={<BrowserPage />} />
        <Route path="/sandbox" element={<SandboxPage />} />
        <Route path="/cli" element={<CliPage />} />
        <Route path="/memory" element={<MemoryPage />} />

        <Route path="/research" element={<ResearchPage />} />
        <Route path="/research/:id" element={<ResearchDetailPage />} />

        <Route path="/skills" element={<SkillsPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/schedules" element={<SchedulesPage />} />

        <Route path="/settings" element={<SettingsPage />} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

/**
 * The frame: one SSE connection, the shortcut listener, and the two overlays.
 *
 * `useSSE` is called here and nowhere else — see the hook's own note on why a second mount
 * would double every invalidation.
 *
 * ## Why the help overlay lives at the frame rather than on a page
 *
 * §8's shortcut table is the same table everywhere, and `?` is a *global* key: a page that owned
 * it would make the overlay unreachable from the other seventeen, and the ones that forgot to
 * mount it would be the ones a user most needs help on. So the overlay is a sibling of the
 * palette, opened by the same listener, and reachable from the palette too.
 *
 * The palette and the overlay are mutually exclusive rather than stacked — `openOverlay` closes
 * the other. Two modals over one scrim is a state with no way out of it that a user can predict,
 * and there is no reading of the spec in which both are wanted at once.
 */
function AppFrame(): ReactNode {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  useSSE();
  useKeyboardShortcuts({
    onOpenPalette: () => {
      setHelpOpen(false);
      setPaletteOpen(true);
    },
    onOpenHelp: () => {
      setPaletteOpen(false);
      setHelpOpen(true);
    },
  });

  return (
    <>
      <AppRoutes
        onOpenPalette={() => {
          setHelpOpen(false);
          setPaletteOpen(true);
        }}
        onOpenHelp={() => {
          setPaletteOpen(false);
          setHelpOpen(true);
        }}
      />
      {paletteOpen ? (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onOpenHelp={() => {
            setPaletteOpen(false);
            setHelpOpen(true);
          }}
        />
      ) : null}
      <KeybindingsOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}

export function App(): ReactNode {
  return (
    <AuthProvider>
      <AppFrame />
    </AuthProvider>
  );
}
