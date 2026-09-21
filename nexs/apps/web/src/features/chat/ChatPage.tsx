/**
 * Chat — the flagship page (§PHASE13.2).
 *
 * ## The conversation lives in the URL
 *
 * `?session=<id>` rather than component state, so a conversation is linkable and survives a
 * reload. That also gives the reconnect contract somewhere to stand: a client that lost its
 * stream reloads, and the URL is what tells it which conversation to refetch. There is no
 * replay buffer on the server, so this is the whole recovery story.
 *
 * ## `/chat` with no `?session=` is a *fresh draft*, not an empty pane
 *
 * This is the behaviour the reference design is built around: the workspace opens on a prompt,
 * not on a list you have to choose from. So the page no longer auto-selects the newest
 * conversation — the hero, the wordmark and the composer are what `/chat` is until you pick
 * something in the work panel or send a message.
 *
 * **The session row is created on the first send, not when the draft opens.** Clicking "New
 * session" five times while thinking should not leave five empty conversations in the sidebar
 * for the next person to tidy up. The cost is one extra request before the first turn, and the
 * benefit is that every row in the panel is a conversation somebody actually had.
 *
 * The agent the draft will run as is chosen in the hero, because an ad-hoc conversation has no
 * agent and therefore has to name a model on every message — a consequence the composer states
 * rather than one the user meets later as a validation error.
 *
 * ## The hero renders for a fresh draft, not for "no session"
 *
 * A conversation that exists and has no messages is the same screen to the person looking at
 * it. Gating the hero on `activeId === null` would show the wordmark until the first click and a
 * blank transcript forever after, which is the state it exists to avoid.
 *
 * ## What "streaming" does and does not mean
 *
 * Deltas render as they arrive, and that text is provisional. On `chat.completed` the hook
 * refetches and drops it, so what stays on screen is always a row. A stopped turn is not an
 * error: the message is written with `interrupted: true`, which the transcript shows.
 *
 * ## The four terminal surfaces, and where each one lives
 *
 * The page used to render all four around the transcript, permanently. It now renders the
 * conversation and one control:
 *
 *  - `StartupBanner` (§3.1) and `StatusBar` (§3.2) are inside `SessionInfoCard`, opened from
 *    **Info** in the header. Together they were a box of system-prompt sections above every
 *    conversation and a seven-cell bar below it — most of what a reader saw, around an answer
 *    that was two lines long. Nothing was dropped; the card is where they live now, and the
 *    banner still reads the session's own agent, because showing a *different* agent's
 *    instructions would be worse than showing none.
 *  - `SubagentDock` (§4.3) stays on the page, above the composer, because it renders **nothing**
 *    when no run is live — it is only ever present during a turn, which is exactly when the
 *    information is wanted. `Ctrl+T`/`F6`/`F7` keep working for the same reason.
 *  - `SessionSwitcher` (§5.1) is a modal over `Ctrl+X`, over the same list the work panel shows.
 *
 * ## The header is a title, a model and two buttons
 *
 * The title, the model the conversation runs on, **Info** and **Sessions**. The "Open run" link
 * moved into the Info card — a run link is about the turn, and the turn is what the card
 * describes. The ad-hoc note moved there too: it is a consequence of the session's
 * configuration, which is what the card is for, and it was reading as a permanent caveat under
 * every title.
 *
 * ## What the status bar can and cannot say
 *
 * Token and cost figures are summed from the session's run usage rows, so they are a
 * **lower bound** rather than a context occupancy — the spec's `18.2K/200K` is a live context
 * measurement and no endpoint reports one. `session-metrics.ts` labels them `derived` and the
 * bar prints `~`; the denominator is the model's own context window when one is known. Three
 * of the bar's cells (`🗜️ compressions`, `▶ background tasks`, `⚠ YOLO`) have no column behind
 * them at all, so they render as "not recorded" with the reason rather than as a zero.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, ErrorState, Loading } from '../../components/ui';
import { HeroWordmark } from '../../components/chat/HeroWordmark';
import { ContextModal } from '../../components/terminal/Reference';
import {
  SubagentDock,
  RosterOverlay,
  useDockShortcuts,
  useLiveActivities,
  type AgentActivity,
} from '../../components/terminal/SubagentDock';
import { SessionSwitcher } from '../../components/terminal/Overlays';
import { useAuth } from '../auth/auth-context';
import { useAgents } from '../agents/queries';
import { useModels } from '../catalog/queries';
import { useRuns } from '../runs/queries';
import { readContext } from '../../lib/context';
import { contextOccupancy, sessionMetrics } from '../../lib/session-metrics';
import { useChatConversation, useChatSessions, useCreateChatSession, useDeleteChatSession, useRenameChatSession } from './queries';
import { useChatTurn } from './useChatTurn';
import { Composer } from './components/Composer';
import { MessageList } from './components/MessageList';
import { SessionInfoCard } from './components/SessionInfoCard';

/** The supporting sentence under the wordmark. A prop on the hero so a personality can change it. */
const HERO_BODY =
  "Describe the task in your own words. I'll pick the right tools, explain my plan, and check in before risky steps.";

export function ChatPage(): ReactNode {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const activeId = params.get('session');

  const sessions = useChatSessions();
  const conversation = useChatConversation(activeId);
  const createSession = useCreateChatSession();
  const renameSession = useRenameChatSession();
  const deleteSession = useDeleteChatSession();
  const turn = useChatTurn();
  const auth = useAuth();
  const agents = useAgents();

  /** The composer's in-flight send, so the button can show it is working. */
  const [sending, setSending] = useState(false);
  /**
   * The session-info card — the startup banner and the status bar, behind one button.
   *
   * They used to be permanent fixtures around the transcript. See the file header: the card is
   * where they live now, so the conversation is the conversation and nothing else.
   */
  const [infoOpen, setInfoOpen] = useState(false);
  /** §5.1. Opened by `Ctrl+X` and by the header button. */
  const [switcherOpen, setSwitcherOpen] = useState(false);
  /** §4.3's roster, owned here so `Ctrl+T`/`F6` and the dock's header button agree. */
  const [rosterOpen, setRosterOpen] = useState(false);
  const [dockCondensed, setDockCondensed] = useState(false);
  /** The composer reports this upward for the status bar's `📌 N`. */
  const [stashCount, setStashCount] = useState(0);
  /** §9.3's context grid, opened from the status bar's meter. */
  const [contextOpen, setContextOpen] = useState(false);
  /**
   * Which agent the *next* conversation will be bound to.
   *
   * Only read while the draft is open — once a session exists its own `agentId` is the answer,
   * and a picker that could still change it would be a control that silently does nothing.
   */
  const [runAs, setRunAs] = useState('');

  const sessionDetail = conversation.data?.pages[0]?.session;
  const summary = sessions.data?.find((row) => row.id === activeId);
  const sessionAgentId = sessionDetail?.agentId ?? summary?.agentId ?? null;

  /**
   * The agent the composer must behave as if bound to.
   *
   * For a draft that is the hero's picker; for a real session it is the session's own. They are
   * different questions — "what will this become" and "what is this" — and merging them into one
   * variable is how a draft ends up running as the last conversation's agent.
   */
  const effectiveAgentId = activeId === null ? (runAs === '' ? null : runAs) : sessionAgentId;

  // ── the status bar's inputs ───────────────────────────────────────────────
  //
  // Every one of these is read from a real row. Nothing here is estimated: a metric with no
  // source renders as "not recorded", which is what `sessionMetrics` returns for the three
  // cells the schema cannot fill.
  const models = useModels({ enabledOnly: true });
  const sessionRuns = useRuns({ limit: 50 });

  const activeAgent = (agents.data ?? []).find((agent) => agent.id === sessionAgentId) ?? null;
  const activeModel = useMemo(() => {
    // ## Why this is the agent's model and not a run's
    //
    // `RunSummary` has no `modelId` — the model a run used lives on its `RunModelUsage` rows,
    // which are read per run and would be N+1 here. What *is* on the wire is the agent's own
    // `modelId`, and for an agent-bound conversation that is the model every message uses.
    //
    // An ad-hoc conversation has no agent and picks a model per message in the composer, so
    // there is nothing to show until one has been chosen — and the bar says "no model" rather
    // than naming a model the session has not committed to.
    if (activeAgent?.modelId === undefined || activeAgent.modelId === null) return null;
    return (models.data ?? []).find((model) => model.id === activeAgent.modelId) ?? null;
  }, [activeAgent, models.data]);

  const metrics = useMemo(
    () =>
      sessionMetrics({
        // `summary`, not `sessionDetail`: `sessionMetrics` reads `createdAt` and the type it
        // wants is `ChatSessionSummary`, which the *list* endpoint answers. The detail endpoint
        // answers a bare `ChatSessionDto` — the same row minus `messageCount`/`lastMessageAt` —
        // so passing it would be passing less than the summary already has.
        session: summary ?? null,
        // Usage rows live under a run; the API has no session-scoped usage endpoint, so this
        // passes none and the token/cost cells come back `absent` rather than guessed.
        runs: [],
        usage: [],
      }),
    [summary],
  );

  const occupancy = useMemo(() => {
    const tokenTotal = metrics.tokens.kind === 'absent' ? null : metrics.tokens.value;
    return contextOccupancy(tokenTotal, activeModel);
  }, [metrics.tokens, activeModel]);

  const context = readContext(occupancy?.used ?? null, occupancy?.max ?? null);

  // ── §4.3 the dock's inputs ────────────────────────────────────────────────
  //
  // The dock shows *runs*, and the honest label for them is what `SubagentDock` prints. A run
  // is the closest thing this build has to a subagent: the spec's frozen subagent entity does
  // not exist in the schema, and pretending these are separate agents would be a fiction.
  const activities: AgentActivity[] = useMemo(() => {
    const runs = sessionRuns.data?.runs ?? [];
    return runs
      .filter((run) => run.status === 'running' || run.status === 'queued' || run.status === 'waiting')
      .map((run) => ({
        run,
        agentName: (agents.data ?? []).find((agent) => agent.id === run.agentId)?.name ?? null,
        agentDescription:
          (agents.data ?? []).find((agent) => agent.id === run.agentId)?.description ?? null,
        // Step counts are not on `RunSummary` — they live on the run's steps, which are a
        // separate read. `null` makes the dock omit the column rather than print `0/0`.
        stepLabel: null,
        // A run's model is on its usage rows, not on the run. `null` here is the honest answer
        // for a run whose usage the client has not read; the roster says so.
        modelName: null,
        tokens: null,
        cost: null,
      }));
  }, [sessionRuns.data, agents.data]);

  const live = useLiveActivities(activities);
  // Mounted unconditionally: the hook is what makes `Ctrl+T`/`F6`/`F7` work, and the dock's own
  // header button calls the same two handlers. It returns `void`, so there is nothing to read.
  useDockShortcuts({
    onOpenRoster: () => setRosterOpen(true),
    onToggleCondensed: () => setDockCondensed((value) => !value),
  });

  const messages = conversation.data === undefined ? [] : conversation.messages;

  /**
   * Whether the page is showing a draft rather than a transcript.
   *
   * Three conditions, and the third is the one that is easy to forget: a turn that has started
   * but whose first delta has not arrived yet must **not** fall back to the hero, or the screen
   * would flash the wordmark between sending and the first token.
   */
  const isDraft =
    activeId === null ||
    (!conversation.isPending &&
      !conversation.isError &&
      messages.length === 0 &&
      turn.content === '' &&
      turn.status !== 'streaming');

  const selectSession = useCallback(
    (id: string): void => {
      // A turn in flight belongs to the conversation it started in. Switching away aborts it,
      // which stops the generation rather than leaving it running invisibly.
      turn.stop();
      setParams({ session: id }, { replace: true });
    },
    [setParams, turn],
  );

  /** Return to the draft. The session row is created when the first message is sent. */
  const openDraft = useCallback((): void => {
    turn.stop();
    setParams({}, { replace: true });
  }, [setParams, turn]);

  const handleSend = useCallback(
    async (input: { content: string; modelId?: string; attachmentIds?: string[] }): Promise<void> => {
      setSending(true);
      try {
        // The one place a session is created. A draft has no id, so the first send opens the
        // conversation and *then* sends into it — in that order, because `chat.started` carries
        // only a `runId` and a client that let the server create the session would have to find
        // it by diffing the session list.
        let sessionId = activeId;
        if (sessionId === null) {
          const created = await createSession.mutateAsync({
            agentId: runAs === '' ? null : runAs,
          });
          sessionId = created.id;
          setParams({ session: sessionId }, { replace: true });
        }

        await turn.send({
          content: input.content,
          sessionId,
          ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
          ...(input.attachmentIds === undefined ? {} : { attachmentIds: input.attachmentIds }),
        });
      } finally {
        setSending(false);
      }
    },
    [activeId, createSession, runAs, setParams, turn],
  );

  // The picker belongs to the draft. Once the draft becomes a conversation, that conversation's
  // own `agentId` is the answer — and leaving the choice in state would let a stale value be
  // reused the next time a draft opens.
  useEffect(() => {
    setRunAs('');
  }, [activeId]);

  const title =
    sessionDetail?.title ??
    summary?.title ??
    (activeId === null ? 'New session' : 'Untitled conversation');

  return (
    <div className="chat-main">
      <header className="chat-head">
        <div className="chat-head-title">
          <span className="chat-head-name">{title}</span>
          {/*
            The model, in the header, where ChatGPT and Hermes both put it. An ad-hoc session
            that has not picked one yet shows nothing rather than a placeholder: "no model" is a
            real state, and the composer is where it is stated and resolved.
          */}
          {activeModel === null ? null : (
            <span
              className="chat-head-model"
              title={activeModel.externalModelId ?? activeModel.name}
            >
              {activeModel.name}
            </span>
          )}
        </div>

        <div className="chat-head-actions">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setInfoOpen(true)}
            title="What this conversation runs as, and what it has cost"
          >
            Info
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSwitcherOpen(true)}
            title="Switch conversations (Ctrl+X)"
          >
            Sessions
            {live.length > 0 ? ` · ${live.length} live` : ''}
          </Button>
        </div>
      </header>

      {createSession.isError ? <ErrorState error={createSession.error} /> : null}

      <div className="chat-body">
        {activeId !== null && conversation.isPending ? (
          <Loading label="Loading messages…" />
        ) : activeId !== null && conversation.isError ? (
          <ErrorState error={conversation.error} onRetry={() => void conversation.refetch()} />
        ) : isDraft ? (
          <HeroWordmark body={HERO_BODY}>
            <label className="hero-runas">
              <span className="hero-runas-label">Run as</span>
              <select
                className="select select-sm"
                value={runAs}
                onChange={(event) => setRunAs(event.target.value)}
                title="An ad-hoc conversation has no agent, so every message must name a model."
              >
                <option value="">No agent — ad-hoc</option>
                {(agents.data ?? []).map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
          </HeroWordmark>
        ) : (
          <div className="chat-scroll">
            <MessageList
              messages={messages}
              live={{
                content: turn.content,
                toolCalls: turn.toolCalls,
                status: turn.status,
                limit: turn.limit,
              }}
              hasMore={conversation.hasMore}
              loadingOlder={conversation.isFetchingNextPage}
              onLoadOlder={() => void conversation.fetchNextPage()}
            />
          </div>
        )}
      </div>

      {turn.error !== null ? (
        <div className="chat-error">
          <Badge tone="failed">{turn.error.code}</Badge>
          <span>{turn.error.message}</span>
          <Button size="sm" variant="ghost" onClick={turn.reset}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {turn.status === 'error' && turn.error === null ? (
        // The stream ended without a `chat.error` frame and without a failure the client could
        // name — the honest reading is "it stopped", not a diagnosis.
        <p className="muted small chat-stopped">The stream ended before the answer finished.</p>
      ) : null}

      <div className="chat-dock">
        <Composer
          requiresModel={effectiveAgentId === null}
          status={sending ? 'streaming' : turn.status}
          placeholder={
            isDraft
              ? 'Start with a goal'
              : 'Reply, or type / for commands and @ to reference something.'
          }
          onSend={(input) => {
            void handleSend(input);
          }}
          onStop={turn.stop}
          onStashCountChange={setStashCount}
        />
      </div>

      {/* §4.3 — renders nothing at all when no run is live, so it is not clutter: it is present
          exactly while a turn is, which is when the information is wanted. It stays on the page
          for the same reason `Ctrl+T`/`F6`/`F7` do. */}
      <SubagentDock
        activities={live}
        onOpenRoster={() => setRosterOpen(true)}
        condensed={dockCondensed}
        onToggleCondensed={() => setDockCondensed((value) => !value)}
      />

      {/* §3.1 + §3.2 — the startup banner and the status bar, behind one button in the header. */}
      <SessionInfoCard
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        workspace={auth.user?.tenantName ?? 'Workspace'}
        agentId={sessionAgentId}
        title={sessionDetail?.title ?? summary?.title ?? null}
        model={activeModel}
        metrics={metrics}
        context={context}
        approximate={occupancy?.approximate ?? false}
        contextNote={
          occupancy?.note ??
          'No model context window is known for this conversation, so nothing can be shown against one.'
        }
        stashCount={stashCount}
        onOpenContext={() => setContextOpen(true)}
        runId={turn.runId}
        onOpenRun={(runId) => {
          // Navigating from inside a modal would leave the card mounted over the next page.
          setInfoOpen(false);
          navigate(`/runs/${runId}`);
        }}
      />

      {/* §5.1 — the modal switcher. Over the same list the work panel renders, from one cache. */}
      <SessionSwitcher
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        sessions={sessions.data ?? []}
        activeId={activeId}
        onSwitch={(id) => {
          selectSession(id);
          setSwitcherOpen(false);
        }}
        onCreate={() => {
          openDraft();
          setSwitcherOpen(false);
        }}
        onRename={(id) => {
          // `PATCH /chat/sessions/:id` takes `{title}`. The prompt is the browser's own, which is
          // the one modal this app does not draw — and drawing a second one here would be a
          // second place for a title to be edited.
          const current = sessions.data?.find((row) => row.id === id);
          const next = window.prompt('Rename this conversation', current?.title ?? '');
          if (next === null || next.trim() === '') return;
          renameSession.mutate({ id, title: next.trim() });
          setSwitcherOpen(false);
        }}
        onDelete={(id) => {
          deleteSession.mutate(id, {
            onSuccess: () => {
              // Deleting the open conversation must also leave it, or the transcript would keep
              // rendering a session the server no longer has.
              if (id === activeId) openDraft();
            },
          });
          setSwitcherOpen(false);
        }}
      />

      {/* §4.3 — the full-screen roster. */}
      <RosterOverlay open={rosterOpen} onClose={() => setRosterOpen(false)} activities={live} />

      {/* §9.3 — the client's answer to `/context`, reached from the status bar's meter. */}
      <ContextModal
        open={contextOpen}
        onClose={() => setContextOpen(false)}
        reading={context}
        approximate={occupancy?.approximate ?? false}
        note={
          occupancy?.note ??
          'No model context window is known for this conversation, so nothing can be shown against one.'
        }
        modelName={activeModel?.name ?? null}
      />
    </div>
  );
}
