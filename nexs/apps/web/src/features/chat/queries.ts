/**
 * Chat queries.
 *
 * ## Three different envelope shapes, from three endpoints in one feature
 *
 * This is the one feature where the server is not internally consistent, and it is worth
 * naming because it is the reason three different helpers appear below:
 *
 *  - `GET /chat/sessions` answers `{ data: [...] }` — the §5 envelope.
 *  - `GET /chat/sessions/:id` answers the `ChatSessionDetail` **bare** — no key at all.
 *  - `GET /chat/mentions` answers `{ items: [...] }` — a named key.
 *
 * `api` unwraps `body.data ?? body`, which is correct for the first and the second. `apiOf`
 * takes the key explicitly, which is correct for the third and would *throw* on the first.
 * Using the wrong one is not a crash — it is an empty list on a successful request, which is
 * the failure this client exists to prevent. So each call below says which shape it expects.
 *
 * ## The conversation read, and the reconnect contract
 *
 * The conversation comes from the **session detail** endpoint rather than `/chat/messages`.
 * They serve the same rows, but the detail response also carries `session` and `hasMore`, and
 * `hasMore` is what drives the "load older" cursor. Reading it in one request means the
 * message list and its own pagination state can never disagree.
 *
 * Paging back uses `before`, a cursor on `createdAt` rather than an offset. A conversation
 * grows at the *new* end, so an offset would shift under a client that is paging — the spec
 * chose the cursor for that reason and this client follows it.
 */

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChatSessionDetail,
  ChatSessionDto,
  ChatSessionSummary,
  MentionKind,
  MentionList,
} from '@nexs/shared';
import { api, apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

/** How many messages a read returns. The server bounds this; we ask for the default page. */
export const CHAT_PAGE_SIZE = 50;

/**
 * The session list.
 *
 * `GET /api/chat/sessions` answers `{ data: [...] }`, so this is the plain `api` unwrap. The
 * key is `chat.sessions`, a child of `chat.messages` — see `query-keys.ts` for why.
 */
export function useChatSessions() {
  return useQuery({
    queryKey: queryKeys.chat.sessions,
    queryFn: () => api<ChatSessionSummary[]>('/chat/sessions'),
  });
}

/**
 * One conversation, newest page first, accumulating backwards.
 *
 * ## Why this is an infinite query rather than a query with a `before` cursor
 *
 * The obvious shape — `useQuery` keyed on `before` — is wrong in a way that is easy to miss:
 * changing the key replaces the data instead of extending it, so "load older" would *swap* the
 * visible page rather than adding to it. The user would lose their place, and the transcript
 * would appear to jump.
 *
 * ## Why the pages are reversed before rendering
 *
 * `ChatSessionDetail.messages` is oldest-first — the order a conversation is read in — and
 * `hasMore` means "older messages exist before `messages[0]`". So page 1 is the newest page and
 * page 2 is the page before it. Concatenating pages in arrival order would put older messages
 * *after* newer ones, so the array is reversed first and each page is already in reading order.
 */
export function useChatConversation(sessionId: string | null) {
  const query = useInfiniteQuery({
    queryKey: [...queryKeys.chat.messages, sessionId ?? ''] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<ChatSessionDetail>(
        `/chat/sessions/${sessionId ?? ''}${qs({ limit: CHAT_PAGE_SIZE, before: pageParam })}`,
      ),
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) return undefined;
      // The cursor is the oldest message this page returned. A page that claims `hasMore` but
      // carries no messages would loop forever, so it terminates instead.
      return lastPage.messages[0]?.createdAt;
    },
    // A session id is required; without one there is nothing to read and the query stays idle
    // rather than requesting `/chat/sessions/` and getting a 404 the UI would have to explain.
    enabled: sessionId !== null && sessionId !== '',
    staleTime: 5_000,
  });

  const pages = query.data?.pages ?? [];
  const messages = [...pages].reverse().flatMap((page) => page.messages);

  return { ...query, messages, hasMore: pages.length > 0 && query.hasNextPage };
}

/**
 * `@` autocomplete. Every entry is a live row — see `mentions.ts`.
 *
 * `enabled` exists because the composer can only have one completion open at a time: when the
 * user is typing a slash command the `@` query is not merely unused, it is meaningless, and
 * firing it on mount would put a request on every visit to the chat page that nothing reads.
 */
export function useMentions(query: string, kind: MentionKind | null, enabled = true) {
  return useQuery({
    queryKey: queryKeys.chat.mentions(query, kind ?? 'any'),
    queryFn: () => apiOf<MentionList['items']>(`/chat/mentions${qs({ q: query, kind })}`, 'items'),
    enabled,
    // The picker answers per keystroke, and the resolver already bounds each source to its
    // newest 200 rows. A short stale window means typing back to a prefix you just typed
    // reuses the answer instead of issuing the same query again.
    staleTime: 15_000,
  });
}

/**
 * Chat-scoped attachments, for the composer's picker.
 *
 * `ATTACHMENT_SCOPES` is `chat | agent | task` and there is no run-scoped list, so a run's
 * files are found through the tool calls that produced them — see the run workspace. Here the
 * scope is `chat`, which is what the composer can actually attach.
 *
 * `scopeId` is deliberately omitted: a session that has not been created yet has no id, and
 * the picker has to work in the composer before the first message. Omitting it lists every
 * chat attachment in the workspace, which is the honest superset of what can be attached.
 */
export function useChatAttachments() {
  return useQuery({
    queryKey: [...queryKeys.files, 'chat'] as const,
    queryFn: () =>
      apiOf<{ id: string; name: string; kind: string; readAccess: boolean; writeAccess: boolean }[]>(
        `/files${qs({ scope: 'chat', limit: 100 })}`,
        'attachments',
      ),
  });
}

/**
 * Open a conversation.
 *
 * `POST /chat/sessions` with a body that may be empty, per the route's own note: "a client that
 * would rather not pre-create can omit `sessionId` on `POST /api/chat` instead and get one
 * back". This client pre-creates, because the created id is **not** reported in any stream
 * frame — `chat.started` carries only `runId` — so a client that let the server create the
 * session would have to find it by diffing the session list.
 *
 * `agentId: null` is an ad-hoc conversation, which then has to name a model on every message.
 */
export function useCreateChatSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string | null } = { agentId: null }) =>
      apiOf<ChatSessionDto>('/chat/sessions', 'session', {
        method: 'POST',
        body: { agentId: input.agentId },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.chat.sessions }),
  });
}

export function useRenameChatSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      apiOf<ChatSessionDto>(`/chat/sessions/${id}`, 'session', {
        method: 'PATCH',
        body: { title },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.chat.messages }),
  });
}

export function useDeleteChatSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/chat/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.chat.messages }),
  });
}
