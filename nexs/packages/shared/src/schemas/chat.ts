import { z } from 'zod';
import { CHAT_MESSAGE_MAX_CHARS, MENTION_KINDS } from '../types/chat.js';

/**
 * Chat input schemas.
 *
 * Same two conventions as `control.ts` — every schema `.strict()`, and nothing `.default()`-ed
 * — with one addition that is specific to chat: **`content` is required and non-empty after
 * trimming.**
 *
 * An empty message is not a small message, it is a request that would start a run, bill a
 * model call, and produce an answer to nothing. Rejecting it at the boundary is cheaper than
 * detecting it in the engine, and it is the one place where a client bug becomes a 400 rather
 * than a confusing empty assistant reply.
 */

const id = z.string().trim().min(1);

export const createChatSessionSchema = z
  .object({
    /** Null or absent means an ad-hoc session, which must name a model per message. */
    agentId: id.nullable().optional(),
    title: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

export const updateChatSessionSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
  })
  .strict();

export const listChatSessionsSchema = z
  .object({
    agentId: id.optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
  })
  .strict();

/**
 * Sending a message.
 *
 * `modelId` is the same escape hatch the task and workflow schemas have: a session with an
 * agent resolves its model from the pinned version, and a session without one has to say
 * which model to use, because there is nothing else to read it from. The service rejects the
 * combination that can never run — no agent *and* no model — rather than letting it become a
 * run that fails a second later with a message about the engine's internals.
 */
export const sendChatMessageSchema = z
  .object({
    content: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_CHARS),
    attachmentIds: z.array(id).max(20).optional(),
    /** Required only when the session has no agent. */
    modelId: id.optional(),
  })
  .strict();

export const listChatMessagesSchema = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    /**
     * Return messages created strictly before this instant — the cursor for scrolling back
     * through a long conversation. A cursor rather than an offset because a conversation
     * grows at the *new* end, so an offset would shift under a client that is paging.
     */
    before: z.coerce.date().optional(),
    /**
     * Which conversation to read.
     *
     * Present because the spec's own path is `GET /api/chat/messages?sessionId=…` (§PHASE-8.4)
     * rather than the nested form. The nested route carries it in the path instead; the
     * controller accepts either, so this stays optional at the schema level and the *service*
     * is what refuses a read with no session at all.
     */
    sessionId: id.optional(),
  })
  .strict();

/**
 * The autocomplete query (§3.9).
 *
 * There is deliberately no `limit`: the spec fixes it at 20, so a parameter would only be a
 * way for a client to ask for a bigger response than the contract promises. `q` is optional so
 * an empty `@` can list what exists — which is what a user who has not typed anything expects.
 */
export const listMentionsSchema = z
  .object({
    q: z.string().trim().max(200).optional(),
    kind: z.enum(MENTION_KINDS).optional(),
  })
  .strict();
