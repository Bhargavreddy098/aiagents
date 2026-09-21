/**
 * Chat contracts.
 *
 * Chat looks like the simplest feature in the product and is the one most likely to grow a
 * duplicate-message bug, so the shape here is chosen to make that bug unrepresentable rather
 * than merely unlikely.
 *
 * ## One assistant message per run
 *
 * A `ChatMessage` with `role: 'assistant'` is written **exactly once per run**, by the single
 * client that won the claim on that run. Everything that could otherwise write a second one —
 * a reconnect, a second browser tab, a retry — loses the compare-and-swap and therefore tails
 * the existing generation instead of starting another. "No duplicated assistant messages" is
 * not a behaviour this module hopes for; it is the consequence of there being exactly one
 * writer, and the reason `ChatMessageDto.runId` is part of the contract at all.
 *
 * ## `interrupted` is a fact, not a status
 *
 * A message is `interrupted: true` when the generation that produced it was aborted
 * mid-stream — the user closed the tab. The flag is on the *message* rather than on the run
 * because it describes the artefact: this text is a fragment. A resumed conversation must be
 * able to render "…" after it honestly, and a client cannot infer that from the run's status,
 * which is a lifecycle fact that may have moved on.
 */

export const CHAT_MESSAGE_ROLES = ['user', 'assistant', 'tool'] as const;

/**
 * The role of a **persisted** message row.
 *
 * Named `ChatMessageRole` rather than `ChatRole` on purpose: `types/gateway.ts` already owns
 * `ChatRole`, which is the role of a message *in a provider prompt* and includes `'system'`.
 * The two are not the same thing and must not be merged — a `ChatMessage` row is never a
 * system prompt, because a system prompt is the agent's instructions, which are resolved from
 * the pinned `AgentVersion` at run time and are not part of the conversation the user sees.
 * Sharing one type would let a `'system'` message be written to the table.
 */
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

/**
 * One entry in a message's tool transcript.
 *
 * Stored on the message rather than reconstructed from `ToolCall` rows because the transcript
 * is what the *conversation* showed, and it must survive the run rows being pruned. It is a
 * rendering record, not an audit record — the audit lives in `ToolCall` and `ExecutionReceipt`.
 */
export interface ChatToolCall {
  name: string;
  args: unknown;
  result?: unknown;
  ok: boolean;
}

export interface ChatMessageDto {
  id: string;
  sessionId: string | null;
  /** The run that produced this message. Null for a message typed by a user. */
  runId: string | null;
  role: ChatMessageRole;
  content: string;
  toolCalls: ChatToolCall[];
  attachmentIds: string[];
  /** True when the generation behind this message was cut short. */
  interrupted: boolean;
  createdAt: string;
}

export interface ChatSessionDto {
  id: string;
  title: string | null;
  agentId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A session as it appears in a list.
 *
 * ## Why there is no message preview here
 *
 * A preview is the obvious thing to want, and it is deliberately absent. Getting the *last*
 * message of each session correctly requires one of three things, and all three are worse than
 * not having it:
 *
 *  - a denormalised `preview` column, which the data model does not define and which would
 *    have to be kept in step with every message write;
 *  - a `distinct` query, which the in-memory test database does not implement — so the one
 *    query shape that makes it cheap would also make it untestable;
 *  - one query per session, which turns a list call into an N+1 on the hot path.
 *
 * `messageCount` and `updatedAt` give a list enough to be useful — how long the conversation
 * is and when it last moved — and the conversation itself is one click away.
 */
export interface ChatSessionSummary extends ChatSessionDto {
  messageCount: number;
  /** When the newest message arrived, or null for a session with none. */
  lastMessageAt: string | null;
}

/**
 * What `GET /api/chat/sessions/:id` returns — **the REST refetch**.
 *
 * This is the endpoint the reconnect contract is built on: a client that lost its stream
 * calls this, gets the whole conversation as it exists in the database, and only then
 * reopens the stream. That ordering is what makes a missing replay buffer a non-issue, and
 * it is why this response carries messages rather than a count.
 */
export interface ChatSessionDetail {
  session: ChatSessionDto;
  /** Oldest first — the order a conversation is read in. */
  messages: ChatMessageDto[];
  /** True when older messages exist before `messages[0]`. */
  hasMore: boolean;
}

/** Longest message a client may send. Bounds the row and the first prompt. */
export const CHAT_MESSAGE_MAX_CHARS = 32_000;

/** How many messages a session read returns when the caller does not say. */
export const CHAT_MESSAGES_DEFAULT_LIMIT = 50;

/**
 * The kinds of thing `@` can refer to (§3.9).
 *
 * A closed list rather than a free string, because the picker's groups and the resolver's
 * branches have to be the same set: adding a kind here without teaching the resolver about it
 * would produce an autocomplete entry that inserts a token nothing can resolve.
 */
export const MENTION_KINDS = [
  'agent',
  'model',
  'tool',
  'mcp',
  'skill',
  'goal',
  'workflow',
  'connector',
  'run',
  'file',
] as const;

export type MentionKind = (typeof MENTION_KINDS)[number];

/**
 * One autocomplete entry.
 *
 * `id` is what gets inserted into the message and what the resolver keys on, so it is the
 * stable identifier rather than the display name — two agents may share a name and a rename
 * must not break a reference that was already inserted.
 */
export interface MentionItem {
  kind: MentionKind;
  id: string;
  name: string;
  /** Secondary line in the picker — a model's provider, a run's status. */
  subtitle?: string;
}

/** The response body of `GET /api/chat/mentions`. */
export interface MentionList {
  items: MentionItem[];
}

/** How many autocomplete entries a query returns (§3.9 fixes this at 20). */
export const MENTION_LIMIT = 20;