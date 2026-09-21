import type { ChatMessage, ChatSession } from '@prisma/client';
import type { ChatMessageDto, ChatMessageRole, ChatSessionDto, ChatSessionSummary, ChatToolCall } from '@nexs/shared';

/**
 * Chat rows to wire shapes.
 *
 * Same rule as the other mappers — the wire shape is narrower than the row, and `tenantId`
 * never appears in a response. Chat adds one wrinkle the others do not have: `toolCalls` is a
 * `Json` column, so its contents are whatever was last written there. It is narrowed here
 * rather than trusted, because a JSON column is the one place in the schema where the
 * database cannot enforce the shape and a hand-edited row would otherwise reach the client
 * as an arbitrary value.
 */

function iso(value: Date): string {
  return value.toISOString();
}

/**
 * Narrow a `toolCalls` column to the transcript shape.
 *
 * Drops entries that are not objects with a string `name`, rather than passing them through:
 * the column is rendered directly by the UI, and one malformed entry would break the whole
 * transcript instead of one line of it. `ok` defaults to false, because an entry whose
 * outcome was not recorded has not been shown to have succeeded.
 */
export function readToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];

  const out: ChatToolCall[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const name = record['name'];
    if (typeof name !== 'string' || name.length === 0) continue;

    out.push({
      name,
      args: record['args'],
      ...(record['result'] === undefined ? {} : { result: record['result'] }),
      ok: record['ok'] === true,
    });
  }
  return out;
}

export function toChatMessageDto(row: ChatMessage): ChatMessageDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    runId: row.runId,
    // The column is a free string; the only values this codebase writes are the three roles.
    role: row.role as ChatMessageRole,
    content: row.content,
    toolCalls: readToolCalls(row.toolCalls),
    attachmentIds: row.attachmentIds,
    interrupted: row.interrupted,
    createdAt: iso(row.createdAt),
  };
}

export function toChatSessionDto(row: ChatSession): ChatSessionDto {
  return {
    id: row.id,
    title: row.title,
    agentId: row.agentId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toChatSessionSummary(
  row: ChatSession,
  stats: { messageCount: number; lastMessageAt: Date | null },
): ChatSessionSummary {
  return {
    ...toChatSessionDto(row),
    messageCount: stats.messageCount,
    lastMessageAt: stats.lastMessageAt === null ? null : iso(stats.lastMessageAt),
  };
}
