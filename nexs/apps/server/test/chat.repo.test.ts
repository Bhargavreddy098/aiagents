import { beforeEach, describe, expect, it } from 'vitest';
import { ChatMessageRepository, ChatSessionRepository } from '../src/repositories/chat.repo.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';

/**
 * Chat persistence, against the real repositories.
 *
 * The two things this file exists to defend are the ones a chat feature gets wrong quietly:
 * a conversation that is only ever readable by the tenant that wrote it, and a paging cursor
 * that either skips a message or shows one twice while a user scrolls. Both are properties of
 * the queries, so both are tested here rather than through the service.
 */

const T_A = 'tnt_a';
const T_B = 'tnt_b';

let fake: FakeDb;
let sessions: ChatSessionRepository;
let messages: ChatMessageRepository;

beforeEach(() => {
  fake = createFakeDb();
  const at = new Date('2026-01-01T00:00:00.000Z');
  fake.tenants.push(
    { id: T_A, name: 'Tenant A', createdAt: at, updatedAt: at },
    { id: T_B, name: 'Tenant B', createdAt: at, updatedAt: at },
  );
  sessions = new ChatSessionRepository(fake.client);
  messages = new ChatMessageRepository(fake.client);
});

async function seedSession(tenantId = T_A, overrides: { agentId?: string | null; title?: string | null } = {}) {
  return sessions.create({
    tenantId,
    userId: 'usr_1',
    agentId: overrides.agentId ?? null,
    title: overrides.title ?? null,
  });
}

/**
 * Messages are seeded through the client rather than the repository so `createdAt` can be
 * pinned. Ordering is the thing under test, and an ordering test that depends on how fast
 * the loop ran is not a test.
 */
async function seedMessage(options: {
  tenantId?: string;
  sessionId: string | null;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  at: string;
  runId?: string | null;
  interrupted?: boolean;
}) {
  return fake.client.chatMessage.create({
    data: {
      tenantId: options.tenantId ?? T_A,
      sessionId: options.sessionId,
      runId: options.runId ?? null,
      role: options.role,
      content: options.content,
      attachmentIds: [],
      interrupted: options.interrupted ?? false,
      createdAt: new Date(options.at),
    },
  });
}

describe('ChatSessionRepository — tenancy', () => {
  it('does not return another tenant’s session', async () => {
    const mine = await seedSession(T_A);
    await seedSession(T_B);

    expect(await sessions.findById(T_A, mine.id)).not.toBeNull();
    // The id is a cuid and globally unique, so possessing one must not be a capability.
    expect(await sessions.findById(T_B, mine.id)).toBeNull();
  });

  it('lists only the caller’s sessions', async () => {
    await seedSession(T_A);
    await seedSession(T_A);
    await seedSession(T_B);

    expect(await sessions.list(T_A)).toHaveLength(2);
    expect(await sessions.list(T_B)).toHaveLength(1);
  });

  it('refuses a cross-tenant rename', async () => {
    const theirs = await seedSession(T_B);

    // `updateMany` with both predicates: a mismatch is a no-op returning null, not a write.
    expect(await sessions.update(T_A, theirs.id, { title: 'hijacked' })).toBeNull();
    expect((await sessions.findById(T_B, theirs.id))!.title).toBeNull();
  });

  it('refuses a cross-tenant delete', async () => {
    const theirs = await seedSession(T_B);

    expect(await sessions.delete(T_A, theirs.id)).toBe(false);
    expect(await sessions.findById(T_B, theirs.id)).not.toBeNull();
  });

  it('scopes message counts to the caller’s tenant', async () => {
    const mine = await seedSession(T_A);
    await seedMessage({ sessionId: mine.id, role: 'user', content: 'a', at: '2026-01-01T00:00:01Z' });
    // Same session id, different tenant: the count must not include it.
    await seedMessage({
      tenantId: T_B,
      sessionId: mine.id,
      role: 'user',
      content: 'b',
      at: '2026-01-01T00:00:02Z',
    });

    const counts = await sessions.messageCounts(T_A, [mine.id]);
    expect(counts.get(mine.id)).toBe(1);
  });
});

describe('ChatSessionRepository — listing', () => {
  it('orders by most recently updated', async () => {
    const first = await seedSession(T_A, { title: 'first' });
    const second = await seedSession(T_A, { title: 'second' });

    // `touch` is what makes this work: adding a message writes a ChatMessage row and leaves
    // the session untouched, so without it the order would silently become "last renamed".
    await sessions.touch(T_A, first.id);

    const listed = await sessions.list(T_A);
    expect(listed[0]!.id).toBe(first.id);
    expect(listed[1]!.id).toBe(second.id);
  });

  it('filters by agent', async () => {
    await seedSession(T_A, { agentId: 'agt_1' });
    await seedSession(T_A, { agentId: null });

    expect(await sessions.list(T_A, { agentId: 'agt_1' })).toHaveLength(1);
  });

  it('honours the limit', async () => {
    await seedSession(T_A);
    await seedSession(T_A);
    await seedSession(T_A);

    expect(await sessions.list(T_A, { limit: 2 })).toHaveLength(2);
  });

  it('reports the newest message time per session', async () => {
    const mine = await seedSession(T_A);
    await seedMessage({ sessionId: mine.id, role: 'user', content: 'a', at: '2026-01-01T00:00:01Z' });
    await seedMessage({ sessionId: mine.id, role: 'user', content: 'b', at: '2026-01-01T00:00:09Z' });

    const times = await sessions.lastMessageTimes(T_A, [mine.id]);
    expect(times.get(mine.id)?.toISOString()).toBe('2026-01-01T00:00:09.000Z');
  });

  it('returns empty maps for an empty page without querying', async () => {
    expect((await sessions.messageCounts(T_A, [])).size).toBe(0);
    expect((await sessions.lastMessageTimes(T_A, [])).size).toBe(0);
  });
});

describe('ChatMessageRepository — creating', () => {
  it('stores a message with its tool transcript', async () => {
    const session = await seedSession();
    const created = await messages.create({
      tenantId: T_A,
      sessionId: session.id,
      runId: null,
      role: 'assistant',
      content: 'hello',
      toolCalls: [{ name: 'web_search', args: { q: 'x' }, ok: true, result: { n: 1 } }],
      attachmentIds: ['att_1'],
      interrupted: false,
    });

    expect(created.content).toBe('hello');
    expect(created.interrupted).toBe(false);
    expect(created.attachmentIds).toEqual(['att_1']);
    expect((created.toolCalls as unknown[])[0]).toMatchObject({ name: 'web_search', ok: true });
  });

  it('leaves toolCalls null when there is no transcript', async () => {
    const session = await seedSession();
    const created = await messages.create({
      tenantId: T_A,
      sessionId: session.id,
      runId: null,
      role: 'user',
      content: 'hi',
      toolCalls: null,
      attachmentIds: [],
      interrupted: false,
    });

    expect(created.toolCalls).toBeNull();
  });

  it('accepts a message with no session — an ad-hoc chat run', async () => {
    const created = await messages.create({
      tenantId: T_A,
      sessionId: null,
      runId: 'run_1',
      role: 'assistant',
      content: 'ad hoc',
      toolCalls: null,
      attachmentIds: [],
      interrupted: false,
    });

    expect(created.sessionId).toBeNull();
    // The tenant predicate still applies, which is the whole reason `ChatMessage` carries
    // its own `tenantId` instead of reaching it through the nullable session.
    expect(await messages.findById(T_A, created.id)).not.toBeNull();
    expect(await messages.findById(T_B, created.id)).toBeNull();
  });
});

describe('ChatMessageRepository — paging', () => {
  it('returns a short conversation oldest-first with no more to fetch', async () => {
    const session = await seedSession();
    await seedMessage({ sessionId: session.id, role: 'user', content: 'one', at: '2026-01-01T00:00:01Z' });
    await seedMessage({ sessionId: session.id, role: 'assistant', content: 'two', at: '2026-01-01T00:00:02Z' });

    const page = await messages.pageBySession(T_A, session.id);
    expect(page.messages.map((m) => m.content)).toEqual(['one', 'two']);
    expect(page.hasMore).toBe(false);
  });

  it('returns the NEWEST messages when the conversation is longer than the page', async () => {
    const session = await seedSession();
    for (let i = 1; i <= 5; i += 1) {
      await seedMessage({
        sessionId: session.id,
        role: 'user',
        content: `m${i}`,
        at: `2026-01-01T00:00:0${i}Z`,
      });
    }

    const page = await messages.pageBySession(T_A, session.id, { limit: 2 });
    // The newest two, still oldest-first — a chat read starts at the end, not the beginning.
    expect(page.messages.map((m) => m.content)).toEqual(['m4', 'm5']);
    expect(page.hasMore).toBe(true);
  });

  it('walks backwards with `before` without repeating or skipping a message', async () => {
    const session = await seedSession();
    for (let i = 1; i <= 5; i += 1) {
      await seedMessage({
        sessionId: session.id,
        role: 'user',
        content: `m${i}`,
        at: `2026-01-01T00:00:0${i}Z`,
      });
    }

    const newest = await messages.pageBySession(T_A, session.id, { limit: 2 });
    const older = await messages.pageBySession(T_A, session.id, {
      limit: 2,
      before: newest.messages[0]!.createdAt,
    });
    const oldest = await messages.pageBySession(T_A, session.id, {
      limit: 2,
      before: older.messages[0]!.createdAt,
    });

    // Concatenating the pages must reproduce the conversation exactly once — the property a
    // cursor exists to provide, and the one an offset would break as new messages arrive.
    const walked = [...oldest.messages, ...older.messages, ...newest.messages].map((m) => m.content);
    expect(walked).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(oldest.hasMore).toBe(false);
    expect(older.hasMore).toBe(true);
  });

  it('does not page across sessions', async () => {
    const one = await seedSession();
    const two = await seedSession();
    await seedMessage({ sessionId: one.id, role: 'user', content: 'a', at: '2026-01-01T00:00:01Z' });
    await seedMessage({ sessionId: two.id, role: 'user', content: 'b', at: '2026-01-01T00:00:02Z' });

    const page = await messages.pageBySession(T_A, one.id);
    expect(page.messages.map((m) => m.content)).toEqual(['a']);
  });

  it('does not page across tenants', async () => {
    const session = await seedSession(T_A);
    await seedMessage({ sessionId: session.id, role: 'user', content: 'mine', at: '2026-01-01T00:00:01Z' });
    await seedMessage({
      tenantId: T_B,
      sessionId: session.id,
      role: 'user',
      content: 'theirs',
      at: '2026-01-01T00:00:02Z',
    });

    const page = await messages.pageBySession(T_A, session.id);
    expect(page.messages.map((m) => m.content)).toEqual(['mine']);
  });

  it('reads the prompt window oldest-first', async () => {
    const session = await seedSession();
    for (let i = 1; i <= 5; i += 1) {
      await seedMessage({
        sessionId: session.id,
        role: 'user',
        content: `m${i}`,
        at: `2026-01-01T00:00:0${i}Z`,
      });
    }

    const recent = await messages.recentBySession(T_A, session.id, 3);
    // The last three turns, in the order a model should read them.
    expect(recent.map((m) => m.content)).toEqual(['m3', 'm4', 'm5']);
  });

  it('counts a session', async () => {
    const session = await seedSession();
    await seedMessage({ sessionId: session.id, role: 'user', content: 'a', at: '2026-01-01T00:00:01Z' });
    await seedMessage({ sessionId: session.id, role: 'user', content: 'b', at: '2026-01-01T00:00:02Z' });

    expect(await messages.countBySession(T_A, session.id)).toBe(2);
  });
});

describe('ChatMessageRepository — one assistant message per run', () => {
  it('finds the assistant message a run produced', async () => {
    const session = await seedSession();
    await seedMessage({
      sessionId: session.id,
      role: 'user',
      content: 'ask',
      at: '2026-01-01T00:00:01Z',
      runId: 'run_1',
    });
    await seedMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'answer',
      at: '2026-01-01T00:00:02Z',
      runId: 'run_1',
    });

    const found = await messages.findAssistantForRun(T_A, 'run_1');
    // The user message shares the runId, so a lookup that did not filter on role would
    // return the question as the answer.
    expect(found?.content).toBe('answer');
  });

  it('returns null when the run has no assistant message yet', async () => {
    const session = await seedSession();
    await seedMessage({
      sessionId: session.id,
      role: 'user',
      content: 'ask',
      at: '2026-01-01T00:00:01Z',
      runId: 'run_1',
    });

    expect(await messages.findAssistantForRun(T_A, 'run_1')).toBeNull();
  });

  it('does not find another tenant’s assistant message', async () => {
    await seedMessage({
      tenantId: T_B,
      sessionId: null,
      role: 'assistant',
      content: 'theirs',
      at: '2026-01-01T00:00:02Z',
      runId: 'run_1',
    });

    expect(await messages.findAssistantForRun(T_A, 'run_1')).toBeNull();
  });

  it('rewrites a message in place rather than adding a second one', async () => {
    const session = await seedSession();
    const created = await seedMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'partial…',
      at: '2026-01-01T00:00:02Z',
      runId: 'run_1',
      interrupted: true,
    });

    const updated = await messages.updateContent(T_A, created.id, {
      content: 'partial… and more',
      interrupted: false,
    });

    expect(updated?.content).toBe('partial… and more');
    expect(updated?.interrupted).toBe(false);
    expect(await messages.countBySession(T_A, session.id)).toBe(1);
  });

  it('refuses a cross-tenant rewrite', async () => {
    const theirs = await seedMessage({
      tenantId: T_B,
      sessionId: null,
      role: 'assistant',
      content: 'theirs',
      at: '2026-01-01T00:00:02Z',
      runId: 'run_1',
    });

    expect(await messages.updateContent(T_A, theirs.id, { content: 'x', interrupted: true })).toBeNull();
    expect((await messages.findById(T_B, theirs.id))!.content).toBe('theirs');
  });
});
