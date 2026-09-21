import type { ChatMessage, ChatSession, PrismaClient } from '@prisma/client';
import { CHAT_MESSAGES_DEFAULT_LIMIT, type ChatMessageRole, type ChatToolCall } from '@nexs/shared';
import { toJson } from './json.js';

/**
 * Chat sessions and messages.
 *
 * `tenantId` is the first argument of every method and appears in every `where`, per the
 * structural rule the rest of the repositories follow. `ChatMessage` carries its own
 * `tenantId` even though it also has a `sessionId`, and that is not redundancy: a message can
 * belong to no session (`sessionId` is nullable — an ad-hoc chat run), and a tenant predicate
 * that had to go through a nullable parent would silently stop filtering for exactly those
 * rows.
 *
 * ## One assistant message per run
 *
 * `findAssistantForRun` exists so the writer can ask "has this run already produced its
 * answer?" before writing one. It is not the primary guard — that is the compare-and-swap on
 * the run that decides which client generates at all — but it is what makes the write
 * idempotent if the same generation is somehow finalized twice, and idempotence is cheaper to
 * test than to reason about.
 */

export interface CreateChatSessionRow {
  tenantId: string;
  userId: string;
  agentId: string | null;
  title: string | null;
}

export interface ChatSessionListFilters {
  agentId?: string;
  limit?: number;
}

export interface CreateChatMessageRow {
  tenantId: string;
  sessionId: string | null;
  runId: string | null;
  role: ChatMessageRole;
  content: string;
  toolCalls: ChatToolCall[] | null;
  attachmentIds: string[];
  interrupted: boolean;
}

export interface ChatMessagePage {
  /** Oldest first — the order a conversation is read in. */
  messages: ChatMessage[];
  /** True when older messages exist before the first one returned. */
  hasMore: boolean;
}

export class ChatSessionRepository {
  constructor(private readonly db: PrismaClient) {}

  async findById(tenantId: string, id: string): Promise<ChatSession | null> {
    return this.db.chatSession.findFirst({ where: { id, tenantId } });
  }

  async list(tenantId: string, filters: ChatSessionListFilters = {}): Promise<ChatSession[]> {
    return this.db.chatSession.findMany({
      where: {
        tenantId,
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
      },
      // Most recently active first: a chat list is read as "what was I doing", not as a
      // chronological archive.
      orderBy: { updatedAt: 'desc' },
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
  }

  async create(data: CreateChatSessionRow): Promise<ChatSession> {
    return this.db.chatSession.create({
      data: {
        tenantId: data.tenantId,
        userId: data.userId,
        agentId: data.agentId,
        title: data.title,
      },
    });
  }

  /** `updateMany`, never `update` — see the note in `repositories/ports.ts`. */
  async update(
    tenantId: string,
    id: string,
    patch: { title?: string },
  ): Promise<ChatSession | null> {
    const { count } = await this.db.chatSession.updateMany({ where: { id, tenantId }, data: patch });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  /**
   * Bump `updatedAt` so the session sorts to the top of the list.
   *
   * `updatedAt` is `@updatedAt`, so Prisma only maintains it when the row itself is written.
   * Adding a message writes a `ChatMessage` and leaves the session row untouched, so without
   * this the "most recently active" ordering would silently degrade to "most recently
   * renamed". The empty `data` is the point: the write exists purely to move the timestamp.
   */
  async touch(tenantId: string, id: string): Promise<void> {
    await this.db.chatSession.updateMany({ where: { id, tenantId }, data: {} });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    const { count } = await this.db.chatSession.deleteMany({ where: { id, tenantId } });
    return count === 1;
  }

  /**
   * Message counts for a page of sessions, in one query.
   *
   * `groupBy` rather than a count per session: the list endpoint returns up to 200 sessions
   * and an N+1 there would be the slowest query in the product.
   */
  async messageCounts(tenantId: string, sessionIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (sessionIds.length === 0) return counts;

    const grouped = await this.db.chatMessage.groupBy({
      by: ['sessionId'],
      where: { tenantId, sessionId: { in: sessionIds } },
      _count: true,
    });

    for (const row of grouped) {
      if (row.sessionId !== null) counts.set(row.sessionId, row._count);
    }
    return counts;
  }

  /** The newest message time per session, in one query — see `messageCounts`. */
  async lastMessageTimes(tenantId: string, sessionIds: string[]): Promise<Map<string, Date>> {
    const times = new Map<string, Date>();
    if (sessionIds.length === 0) return times;

    const grouped = await this.db.chatMessage.groupBy({
      by: ['sessionId'],
      where: { tenantId, sessionId: { in: sessionIds } },
      _max: { createdAt: true },
    });

    for (const row of grouped) {
      const at = row._max?.createdAt;
      if (row.sessionId !== null && at !== null && at !== undefined) times.set(row.sessionId, at);
    }
    return times;
  }
}

export class ChatMessageRepository {
  constructor(private readonly db: PrismaClient) {}

  async findById(tenantId: string, id: string): Promise<ChatMessage | null> {
    return this.db.chatMessage.findFirst({ where: { id, tenantId } });
  }

  /**
   * A page of a conversation, oldest first, with a `hasMore` flag.
   *
   * Fetches `limit + 1` rows and trims the extra: the presence of that one extra row is what
   * answers "is there older history?" without a second `count` query that could disagree with
   * the page it is describing. Reading backwards from `before` and then reversing means the
   * cursor walks the conversation from the newest end, which is the direction a client
   * scrolling up actually moves.
   */
  async pageBySession(
    tenantId: string,
    sessionId: string,
    options: { limit?: number; before?: Date } = {},
  ): Promise<ChatMessagePage> {
    const limit = options.limit ?? CHAT_MESSAGES_DEFAULT_LIMIT;

    const rows = await this.db.chatMessage.findMany({
      where: {
        tenantId,
        sessionId,
        ...(options.before === undefined ? {} : { createdAt: { lt: options.before } }),
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { messages: page.reverse(), hasMore };
  }

  async countBySession(tenantId: string, sessionId: string): Promise<number> {
    return this.db.chatMessage.count({ where: { tenantId, sessionId } });
  }

  /** The conversation so far, oldest first — the prompt a new turn is built from. */
  async recentBySession(tenantId: string, sessionId: string, limit: number): Promise<ChatMessage[]> {
    const rows = await this.db.chatMessage.findMany({
      where: { tenantId, sessionId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.reverse();
  }

  async create(data: CreateChatMessageRow): Promise<ChatMessage> {
    return this.db.chatMessage.create({
      data: {
        tenantId: data.tenantId,
        sessionId: data.sessionId,
        runId: data.runId,
        role: data.role,
        content: data.content,
        ...(data.toolCalls === null ? {} : { toolCalls: toJson(data.toolCalls) }),
        attachmentIds: data.attachmentIds,
        interrupted: data.interrupted,
      },
    });
  }

  /**
   * The assistant message a run already produced, if any.
   *
   * The read half of the one-message-per-run guarantee. A run has at most one assistant
   * message; a caller about to write one asks first, so a double-finalize updates rather than
   * duplicates.
   */
  async findAssistantForRun(tenantId: string, runId: string): Promise<ChatMessage | null> {
    return this.db.chatMessage.findFirst({
      where: { tenantId, runId, role: 'assistant' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Link a message to the run it belongs to.
   *
   * Separate from `create` because of an ordering constraint that cannot be avoided: a user
   * message must be written *before* its run, since the run's idempotency key is derived from
   * the message's id, and the id does not exist until the row does. So the link is made in a
   * second write rather than in the insert.
   */
  async attachRun(tenantId: string, id: string, runId: string): Promise<ChatMessage | null> {
    const { count } = await this.db.chatMessage.updateMany({
      where: { id, tenantId },
      data: { runId },
    });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  /**
   * Rewrite an assistant message in place.
   *
   * Used when a generation that already streamed some text is finalized as interrupted: the
   * row is the same one, so the client that refetches sees one message, not two.
   */
  async updateContent(
    tenantId: string,
    id: string,
    patch: { content: string; interrupted: boolean; toolCalls?: ChatToolCall[] },
  ): Promise<ChatMessage | null> {
    const { count } = await this.db.chatMessage.updateMany({
      where: { id, tenantId },
      data: {
        content: patch.content,
        interrupted: patch.interrupted,
        ...(patch.toolCalls === undefined
          ? {}
          : { toolCalls: toJson(patch.toolCalls) }),
      },
    });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }
}
