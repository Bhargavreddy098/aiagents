import {
  ApiError,
  type ChatMessageDto,
  type ChatSessionDetail,
  type ChatSessionDto,
  type ChatSessionSummary,
  type ToolDefinition,
} from '@nexs/shared';
import type { ChatMessage as ChatMessageRow, Run as RunRow } from '@prisma/client';
import type { AgentRepository } from '../../repositories/agent.repo.js';
import type { ChatMessageRepository, ChatSessionRepository } from '../../repositories/chat.repo.js';
import type { ToolRepository } from '../../repositories/mcp.repo.js';
import type { RunRepository } from '../../repositories/run.repo.js';
import type { Logger } from '../../logger.js';
import { toChatMessageDto, toChatSessionDto, toChatSessionSummary } from '../../mappers/chat.js';

/**
 * Chat: the conversation, not the generation.
 *
 * This service owns sessions and messages and the *creation* of a turn's run. It deliberately
 * does not run anything — `ChatTurnRunner` does, and it is a separate module because the two
 * have different failure modes. Persistence failures are the caller's problem and belong in a
 * response; generation failures happen after the response is sent, on a stream, and must be
 * reported as frames.
 *
 * ## The ordering that makes disconnect handling work
 *
 * `sendMessage` persists the **user message before anything else happens**. That single
 * ordering decision is what makes the Phase 7 acceptance test pass: when a client dies
 * mid-response, the question is already durable, so reopening the conversation shows it. If
 * the user message were written at the end — or only after a successful generation — a
 * disconnect would silently swallow what the user typed, which is the one outcome a chat
 * product must never produce.
 *
 * ## A chat run is not enqueued
 *
 * `sendMessage` creates the run and **does not** hand it to the run queue. A chat turn is
 * claimed by the stream connection that is going to render it, so a run nobody is watching
 * generates nothing rather than burning a model call into the void. This is also what makes
 * the assistant message unique: the claim is a compare-and-swap, so of N tabs open on the
 * same run exactly one generates and the rest tail.
 *
 * The consequence, stated plainly because it is a real trade-off: a message sent by a client
 * that then never opens a stream leaves a `queued` run. That is visible in the run list, which
 * is the honest outcome — the answer really was never generated.
 */

export interface ChatServiceDeps {
  sessions: ChatSessionRepository;
  messages: ChatMessageRepository;
  runs: RunRepository;
  agents: AgentRepository;
  logger: Logger;
  /**
   * The tools a turn may offer, read through the same tenant-scoped repository the planner
   * uses. The shared type rather than a hand-written port: the planner and the chat loop must
   * agree about what is runnable, and two structurally-similar declarations would be free to
   * drift apart one field at a time.
   */
  tools: ToolRepository;
  /**
   * Resolves a run's configuration — instructions, model, tool allowlist — from its pinned
   * agent version. Injected as the engine's own resolver so a chat turn and a step cannot
   * disagree about what an agent is configured to do.
   */
  resolver: (run: RunRow) => Promise<{ instructions: string; modelId: string; allowedToolIds: string[] }>;
  /**
   * How many prior messages a turn is built from.
   *
   * A window rather than the whole conversation: the gateway has its own context budgeting,
   * but handing it an unbounded history would mean paying to tokenise thousands of messages
   * on every turn only to have most of them trimmed.
   */
  promptWindow?: number;
}

export interface SendMessageInput {
  content: string;
  attachmentIds?: string[];
  /** Required only when the session has no agent. */
  modelId?: string;
}

export interface SendMessageResult {
  userMessage: ChatMessageDto;
  runId: string;
}

/**
 * Everything the turn runner needs, resolved before the response is committed.
 *
 * Handed over as one object rather than looked up inside the runner, because every field here
 * can fail in a way that deserves a status code — an unknown session, a missing model, a
 * deleted agent. Resolving them *before* the SSE headers are flushed is what keeps those as
 * 400s and 404s instead of frames. See `ChatController.send`.
 */
export interface PreparedTurn {
  tenantId: string;
  runId: string;
  sessionId: string;
  modelId: string;
  history: ChatMessageRow[];
  instructions?: string;
  toolDefinitions?: ToolDefinition[];
  /** The user's own message, so the caller can echo it without a second read. */
  userMessage: ChatMessageDto;
}

const DEFAULT_PROMPT_WINDOW = 40;

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  async createSession(
    tenantId: string,
    userId: string,
    input: { agentId?: string | null; title?: string },
  ): Promise<ChatSessionDto> {
    const agentId = input.agentId ?? null;
    if (agentId !== null) await this.requireAgent(tenantId, agentId);

    const session = await this.deps.sessions.create({
      tenantId,
      userId,
      agentId,
      title: input.title ?? null,
    });

    this.deps.logger.info({ tenantId, sessionId: session.id, agentId }, 'chat session created');
    return toChatSessionDto(session);
  }

  async listSessions(
    tenantId: string,
    query: { agentId?: string; limit?: number } = {},
  ): Promise<ChatSessionSummary[]> {
    const sessions = await this.deps.sessions.list(tenantId, query);
    const ids = sessions.map((s) => s.id);

    // Two grouped queries for the whole page rather than two per session — see
    // `ChatSessionRepository.messageCounts`.
    const [counts, times] = await Promise.all([
      this.deps.sessions.messageCounts(tenantId, ids),
      this.deps.sessions.lastMessageTimes(tenantId, ids),
    ]);

    return sessions.map((session) =>
      toChatSessionSummary(session, {
        messageCount: counts.get(session.id) ?? 0,
        lastMessageAt: times.get(session.id) ?? null,
      }),
    );
  }

  /**
   * The conversation, oldest first — **the REST refetch**.
   *
   * A client calls this after losing a stream and before reopening one. That order matters:
   * the stream is a tail of state that is already durable, so refetching first means a client
   * can never end up with a gap it has no way to fill.
   */
  async getSession(
    tenantId: string,
    id: string,
    query: { limit?: number; before?: Date } = {},
  ): Promise<ChatSessionDetail> {
    const session = await this.requireSession(tenantId, id);

    const page = await this.deps.messages.pageBySession(tenantId, id, query);
    return {
      session: toChatSessionDto(session),
      messages: page.messages.map(toChatMessageDto),
      hasMore: page.hasMore,
    };
  }

  async renameSession(tenantId: string, id: string, title: string): Promise<ChatSessionDto> {
    const updated = await this.deps.sessions.update(tenantId, id, { title });
    if (updated === null) throw notFound(id);

    this.deps.logger.info({ tenantId, sessionId: id }, 'chat session renamed');
    return toChatSessionDto(updated);
  }

  /**
   * Delete a session and its messages.
   *
   * The messages go with it via the schema's `onDelete: Cascade`, which is the right call for
   * a conversation: a message with no session is not history, it is orphaned text. Note this
   * does **not** delete the runs the conversation produced — a run is an audit record of work
   * that actually happened, and deleting the chat must not erase the evidence that a model was
   * called and a tool ran.
   */
  async deleteSession(tenantId: string, id: string): Promise<void> {
    const deleted = await this.deps.sessions.delete(tenantId, id);
    if (!deleted) throw notFound(id);

    this.deps.logger.info({ tenantId, sessionId: id }, 'chat session deleted');
  }

  /**
   * Record the user's message and open a run for the reply.
   *
   * See the class comment for why the user message is written first and why the run is not
   * enqueued. The `idempotencyKey` is derived from the user message's own id, so a retried
   * send — a double-click, a client retry after a timeout — attaches to the run that already
   * exists instead of starting a second generation.
   */
  async sendMessage(
    tenantId: string,
    sessionId: string,
    input: SendMessageInput,
  ): Promise<SendMessageResult> {
    const session = await this.requireSession(tenantId, sessionId);

    const modelId = await this.resolveModel(tenantId, session.agentId, input.modelId);

    // 1. The user's message, before anything can fail. If the process dies one line from now,
    //    the question is still in the database.
    const userMessage = await this.deps.messages.create({
      tenantId,
      sessionId,
      runId: null,
      role: 'user',
      content: input.content,
      toolCalls: null,
      attachmentIds: input.attachmentIds ?? [],
      interrupted: false,
    });

    // 2. The run. `kind: 'chat'` is what keeps it out of the engine's claim path.
    const run = await this.deps.runs.create({
      tenantId,
      kind: 'chat',
      agentId: session.agentId,
      input: {
        context: {
          ...(modelId === undefined ? {} : { modelId }),
          // The prompt is rebuilt from the session at generation time rather than frozen
          // here, so the assistant answers the conversation as it stands — including any
          // message that arrived between this write and the claim.
          promptWindow: this.deps.promptWindow ?? DEFAULT_PROMPT_WINDOW,
        },
      },
      idempotencyKey: `chat:${userMessage.id}`,
    });

    // 3. Link the message to its run, and move the session to the top of the list. These two
    //    touch different rows and neither result is read, so they are one round-trip instead of
    //    two — on the path where the user is waiting for the first token.
    await Promise.all([
      this.deps.messages.attachRun(tenantId, userMessage.id, run.id),
      this.deps.sessions.touch(tenantId, sessionId),
    ]);

    this.deps.logger.info(
      { tenantId, sessionId, runId: run.id, messageId: userMessage.id },
      'chat turn opened',
    );

    return {
      userMessage: { ...toChatMessageDto(userMessage), runId: run.id },
      runId: run.id,
    };
  }

  /**
   * Record a user message and its canned assistant reply, with no model call.
   *
   * ## Why this exists alongside `prepareTurn`
   *
   * A slash command is answered by the server, not the model — see `SlashCommandService`. It
   * still needs to become a real conversation: the user's line and the reply are both persisted
   * so a reload shows them, and they are what the *next* turn's prompt will include. So the
   * write path is identical; what differs is that no run is created and nothing is enqueued.
   *
   * Deliberately no `Run` row: a command is not work the engine performed, and inventing one
   * would put a row in the run list that no model ever touched. The two honesty rules this
   * codebase runs on both point the same way — a run must trace to something that ran.
   */
  async recordCommand(
    tenantId: string,
    sessionId: string,
    input: { userText: string; reply: string },
  ): Promise<{ userMessage: ChatMessageDto; assistantMessage: ChatMessageDto }> {
    await this.requireSession(tenantId, sessionId);

    const userMessage = await this.deps.messages.create({
      tenantId,
      sessionId,
      runId: null,
      role: 'user',
      content: input.userText,
      toolCalls: null,
      attachmentIds: [],
      interrupted: false,
    });

    const assistantMessage = await this.deps.messages.create({
      tenantId,
      sessionId,
      runId: null,
      role: 'assistant',
      content: input.reply,
      toolCalls: [],
      attachmentIds: [],
      interrupted: false,
    });

    await this.deps.sessions.touch(tenantId, sessionId);

    this.deps.logger.info(
      { tenantId, sessionId, userMessageId: userMessage.id },
      'slash command recorded',
    );

    return {
      userMessage: toChatMessageDto(userMessage),
      assistantMessage: toChatMessageDto(assistantMessage),
    };
  }

  /**
   * The conversation so far, oldest first, as the prompt for a turn.
   *
   * Public because the turn runner needs it and it must read through the same tenant-scoped
   * repository rather than reaching for the client.
   */
  async promptHistory(tenantId: string, sessionId: string, limit?: number): Promise<ChatMessageDto[]> {
    const rows = await this.deps.messages.recentBySession(
      tenantId,
      sessionId,
      limit ?? this.deps.promptWindow ?? DEFAULT_PROMPT_WINDOW,
    );
    return rows.map(toChatMessageDto);
  }

  /**
   * Persist the turn and resolve everything generation needs — the pre-stream half of `send`.
   *
   * ## Why this is separate from the runner
   *
   * Every lookup here can fail for a reason that deserves a status code: no such session, an
   * agent deleted since the session was created, a session with neither agent nor model. Once
   * the response is `text/event-stream` there is no status code left to send, so all of it has
   * to happen first. The runner therefore receives values that are already known-good and has
   * only one class of failure left — the generation itself.
   *
   * ## Which configuration a turn runs under
   *
   * The agent's instructions, model and tool allowlist come from the run that was just created,
   * through the same pinned-version resolver the engine uses (`agentVersionId`, gap #15). A
   * chat turn is not a special case that gets to read the live agent row: an agent edited
   * mid-conversation must not change what an in-flight turn is allowed to do, for the same
   * reason a half-executed plan must not.
   *
   * ## Why there is no `userId` parameter
   *
   * A run records its tenant, agent, goal and task — but not a person: work is attributed to a
   * tenant, and the only place a human is named is an approval decision, which is a different
   * path (`/approve`). Taking a `userId` here and discarding it would suggest the turn is
   * attributed to someone, which is exactly the kind of implied-but-absent fact this codebase
   * refuses to leave lying around.
   */
  async prepareTurn(
    tenantId: string,
    sessionId: string,
    input: SendMessageInput,
  ): Promise<PreparedTurn> {
    // No `requireSession` here. There used to be one, justified as "fail before writing
    // anything" — but `sendMessage`'s own first statement is the same check, so it was a second
    // identical read of the same row for every turn, and the justification did not hold:
    // nothing was written before it either way. The 404 still arrives before any write.
    const sent = await this.sendMessage(tenantId, sessionId, input);
    const run = await this.deps.runs.findById(tenantId, sent.runId);
    if (run === null) {
      // Unreachable: `sendMessage` just created it inside the same transaction of work. Kept
      // as a guard rather than a non-null assertion, so a future refactor that made the create
      // conditional fails loudly instead of generating against a phantom run.
      throw new ApiError('INTERNAL_ERROR', 'The chat run vanished immediately after creation', {
        runId: sent.runId,
      });
    }

    // The two reads are independent — the pinned agent config and the conversation — so they go
    // out together. Sequentially they were two round-trips of dead time before the first byte,
    // on the path where the user is watching a blank screen.
    const [context, history] = await Promise.all([
      this.deps.resolver(run),
      this.deps.messages.recentBySession(
        tenantId,
        sessionId,
        this.deps.promptWindow ?? DEFAULT_PROMPT_WINDOW,
      ),
    ]);

    // The allowlist is intersected with the tools that actually exist and are enabled, and the
    // result is both the prompt's tool list *and* the set the invoker will honour — they must
    // be one set, or the model is offered something the runner would refuse to run.
    //
    // This one does depend on the resolver, so it stays sequential: `allowedToolIds` is what
    // decides whether there is anything to look up at all, and it short-circuits to `[]` for a
    // tool-less agent without touching the tool table.
    const definitions = await this.resolveToolDefinitions(tenantId, context.allowedToolIds);

    return {
      tenantId,
      runId: sent.runId,
      sessionId,
      modelId: context.modelId,
      history,
      ...(context.instructions.length === 0 ? {} : { instructions: context.instructions }),
      ...(definitions.length === 0 ? {} : { toolDefinitions: definitions }),
      userMessage: sent.userMessage,
    };
  }

  /**
   * The provider-facing tool list for a turn.
   *
   * A disabled or errored tool is never offered — the invoker refuses it anyway, so offering
   * one would only produce a call that fails. This is the same rule `planner.resolveTools`
   * applies, kept in step deliberately: the planner and the chat loop must agree about what is
   * runnable, or a plan and a conversation would disagree about the same agent's capabilities.
   */
  private async resolveToolDefinitions(
    tenantId: string,
    allowedToolIds: string[],
  ): Promise<ToolDefinition[]> {
    if (allowedToolIds.length === 0) return [];

    const rows = await this.deps.tools.list(tenantId);
    const wanted = new Set(allowedToolIds);
    const definitions: ToolDefinition[] = [];

    for (const row of rows) {
      if (!wanted.has(row.id)) continue;
      if (row.status !== 'enabled') continue;
      definitions.push({
        // The id *is* the name, which is what makes a model's tool call resolvable straight
        // back to a row without a lookup table.
        name: row.id,
        description: `${row.name} — ${row.description ?? row.name}`,
        inputSchema: row.inputSchema,
      });
    }

    return definitions;
  }

  /** The default window, so a caller that omits `limit` gets the same answer as the service. */
  get defaultPromptWindow(): number {
    return this.deps.promptWindow ?? DEFAULT_PROMPT_WINDOW;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Which model this turn runs on, or `undefined` when an agent supplies it.
   *
   * The rule mirrors the task and workflow services — a session with no agent must name a
   * model, because there is nothing else to read it from — with one addition. When an agent
   * *is* present, a supplied `modelId` is **refused rather than ignored**, because the agent's
   * pinned version is authoritative: the resolver reads `snapshot.modelId` and never consults
   * the run's input once a version is pinned. Accepting the field would let a client believe it
   * chose the model while the agent's configuration quietly overruled it, which is the same
   * "silently dropped field" failure the `.strict()` schemas exist to prevent.
   */
  private async resolveModel(
    tenantId: string,
    agentId: string | null,
    requestedModelId: string | undefined,
  ): Promise<string | undefined> {
    if (agentId !== null) {
      if (requestedModelId !== undefined) {
        throw new ApiError(
          'VALIDATION_ERROR',
          'This session has an agent, which supplies the model; "modelId" would be ignored',
          { field: 'modelId', agentId },
        );
      }
      // Re-read rather than trusting the session's stored `agentId`: an agent deleted after
      // the session was created would otherwise produce a run that cannot resolve a config.
      await this.requireAgent(tenantId, agentId);
      return undefined;
    }

    if (requestedModelId === undefined || requestedModelId.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'A chat session with no agent needs "modelId" to run', {
        field: 'modelId',
      });
    }
    return requestedModelId;
  }

  private async requireSession(tenantId: string, id: string) {
    const session = await this.deps.sessions.findById(tenantId, id);
    if (session === null) throw notFound(id);
    return session;
  }

  private async requireAgent(tenantId: string, agentId: string): Promise<void> {
    const agent = await this.deps.agents.findById(tenantId, agentId);
    if (agent === null) {
      throw new ApiError('VALIDATION_ERROR', 'The agent does not exist', { agentId });
    }
  }
}

function notFound(id: string): ApiError {
  return new ApiError('NOT_FOUND', 'The chat session does not exist', { sessionId: id });
}
