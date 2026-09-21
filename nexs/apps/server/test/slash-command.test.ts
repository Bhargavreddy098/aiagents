import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { SlashCommandService } from '../src/services/chat/slash-command.service.js';
import type { CommandServices } from '../src/services/chat/commands/types.js';
import type { AgentDetail } from '@nexs/shared';

/**
 * The slash-command dispatcher.
 *
 * ## What this file is actually defending
 *
 * Two behaviours, both of which fail silently if they break:
 *
 *  1. **Recognition.** `isCommand` decides whether a turn reaches the model. Get it wrong in
 *     one direction and a user's question beginning with a slash is answered by a canned reply;
 *     wrong in the other and `/runs` is sent to a model, which will invent a run list.
 *  2. **Containment.** A command that throws must not break the turn. It runs on a stream, where
 *     a throw has no status code to become, so a failure has to arrive as a sentence.
 *
 * The services are a hand-written fake rather than a fake database, because what is under test
 * is the *dispatch* — which service method gets called with what — not the queries behind it.
 */

function fakeServices(overrides: Partial<CommandServices> = {}): CommandServices {
  const notImplemented = async (): Promise<never> => {
    throw new Error('this service was not expected to be called by this test');
  };

  const base: CommandServices = {
    agents: {
      list: async () => [],
      create: notImplemented,
      get: notImplemented,
    },
    goals: { list: async () => [], create: notImplemented },
    tasks: { create: notImplemented },
    runs: {
      list: async () => ({ runs: [], total: 0 }),
      get: notImplemented,
      cancel: notImplemented,
      pause: notImplemented,
      resume: notImplemented,
    },
    approvals: {
      list: async () => [],
      decide: notImplemented,
      countPending: async () => 0,
    },
    notifications: { unreadCount: async () => 0 },
    models: { list: async () => [] },
    tools: { list: async () => [] },
    mcp: { list: async () => [] },
    providers: { list: async () => [] },
    browser: { open: notImplemented, act: notImplemented, close: async () => undefined },
  };

  return { ...base, ...overrides };
}

function dispatcher(services: CommandServices): SlashCommandService {
  return new SlashCommandService({ services, logger: pino({ level: 'silent' }) });
}

/**
 * A complete `AgentDetail`.
 *
 * Built in full rather than as a partial object literal, because the command reads only a few
 * fields and a hand-written stub tends to keep only those — which means the test would keep
 * passing after the service started returning something the real `AgentDetail` cannot be. The
 * defaults here are the boring ones an agent created by `/agent` actually has.
 */
function agentDetail(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    id: 'agt_new',
    name: 'Scout',
    description: null,
    status: 'active',
    version: 1,
    activeVersionId: null,
    modelId: null,
    toolIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    instructions: '',
    fallbackModelId: null,
    mcpServerIds: [],
    connectorAccountIds: [],
    memoryEnabled: false,
    browserAccess: false,
    sandboxAccess: false,
    approvalPolicy: null,
    executionLimits: null,
    archivedAt: null,
    versions: [],
    counts: { goals: 0, tasks: 0, runs: 0 },
    ...overrides,
  };
}

const ctx = { tenantId: 'tnt_a', userId: 'usr_1', sessionId: 'ses_1' };

describe('SlashCommandService.isCommand', () => {
  it('recognises a command', () => {
    expect(SlashCommandService.isCommand('/runs')).toBe(true);
  });

  it('recognises a command with arguments', () => {
    expect(SlashCommandService.isCommand('/runs --status failed')).toBe(true);
  });

  it('recognises an unknown command', () => {
    // Deliberate: `/typo` must be *dispatched* so it can be answered with the real command
    // list. Treating it as ordinary text would send the word "typo" to the model as a question.
    expect(SlashCommandService.isCommand('/typo')).toBe(true);
  });

  it('ignores a bare slash', () => {
    // A user who has typed `/` and nothing else has not sent a command.
    expect(SlashCommandService.isCommand('/')).toBe(false);
  });

  it('ignores ordinary text', () => {
    expect(SlashCommandService.isCommand('what is 2+2')).toBe(false);
  });

  it('ignores a slash that is not leading', () => {
    expect(SlashCommandService.isCommand('what is a/b')).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(SlashCommandService.isCommand('  /runs  ')).toBe(true);
  });
});

describe('SlashCommandService.run', () => {
  it('answers /help from the real command table', async () => {
    const outcome = await dispatcher(fakeServices()).run(ctx, '/help');

    expect(outcome).not.toBeNull();
    expect(outcome?.command).toBe('help');
    // Every command the spec lists must appear, or `/help` is lying about what exists.
    for (const name of ['help', 'status', 'models', 'agents', 'goals', 'runs', 'tools', 'mcp']) {
      expect(outcome?.reply).toContain(`/${name}`);
    }
  });

  it('says a listing is empty rather than describing what it would contain', async () => {
    const outcome = await dispatcher(fakeServices()).run(ctx, '/agents');

    expect(outcome?.reply).toContain('No agents yet');
    expect(outcome?.reply).toContain('/agent');
  });

  it('renders real rows from the service', async () => {
    const services = fakeServices({
      agents: {
        list: async () => [
          {
            id: 'agt_1',
            name: 'Scout',
            description: 'watches news',
            status: 'active',
            version: 1,
            activeVersionId: 'av_1',
            modelId: 'mdl_1',
            toolIds: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        create: async () => {
          throw new Error('not expected');
        },
        get: async () => {
          throw new Error('not expected');
        },
      },
    });

    const outcome = await dispatcher(services).run(ctx, '/agents');
    expect(outcome?.reply).toContain('Scout');
    expect(outcome?.reply).toContain('agt_1');
  });

  it('filters /runs by a bare positional status', async () => {
    let seen: { status?: string } = {};
    const services = fakeServices({
      runs: {
        list: async (_tenantId, query) => {
          seen = query;
          return { runs: [], total: 0 };
        },
        get: async () => {
          throw new Error('not expected');
        },
        cancel: async () => {
          throw new Error('not expected');
        },
        pause: async () => {
          throw new Error('not expected');
        },
        resume: async () => {
          throw new Error('not expected');
        },
      },
    });

    await dispatcher(services).run(ctx, '/runs failed');
    expect(seen.status).toBe('failed');
  });

  it('filters /runs by the --status flag too', async () => {
    let seen: { status?: string } = {};
    const services = fakeServices({
      runs: {
        list: async (_tenantId, query) => {
          seen = query;
          return { runs: [], total: 0 };
        },
        get: async () => {
          throw new Error('not expected');
        },
        cancel: async () => {
          throw new Error('not expected');
        },
        pause: async () => {
          throw new Error('not expected');
        },
        resume: async () => {
          throw new Error('not expected');
        },
      },
    });

    await dispatcher(services).run(ctx, '/runs --status paused');
    expect(seen.status).toBe('paused');
  });

  it('lists the real commands when the name is unknown', async () => {
    const outcome = await dispatcher(fakeServices()).run(ctx, '/nope');

    expect(outcome?.command).toBe('nope');
    expect(outcome?.reply).toContain('No command called `/nope`');
    expect(outcome?.reply).toContain('`/runs`');
  });

  it('turns a thrown service failure into a reply rather than propagating it', async () => {
    const services = fakeServices({
      runs: {
        list: async () => {
          throw new Error('database is on fire');
        },
        get: async () => {
          throw new Error('not expected');
        },
        cancel: async () => {
          throw new Error('not expected');
        },
        pause: async () => {
          throw new Error('not expected');
        },
        resume: async () => {
          throw new Error('not expected');
        },
      },
    });

    // Must resolve, not reject — the turn is already streaming and has no status code left.
    const outcome = await dispatcher(services).run(ctx, '/runs');
    expect(outcome?.reply).toContain('database is on fire');
    expect(outcome?.reply).toContain('failed');
  });

  it('is case-insensitive about the command name', async () => {
    const outcome = await dispatcher(fakeServices()).run(ctx, '/RUNS');
    expect(outcome?.command).toBe('runs');
  });

  it('refuses /agent with no instructions, and says why', async () => {
    const outcome = await dispatcher(fakeServices()).run(ctx, '/agent Scout');
    expect(outcome?.reply).toContain('instructions');
    expect(outcome?.reply).toContain('Usage');
  });

  it('creates an agent with the whole quoted instruction', async () => {
    let created: { name: string; description?: string } | null = null;
    const services = fakeServices({
      agents: {
        list: async () => [],
        create: async (_tenantId, input) => {
          created = input;
          return agentDetail({ name: input.name, description: input.description ?? null });
        },
        get: async () => {
          throw new Error('not expected');
        },
      },
    });

    const outcome = await dispatcher(services).run(
      ctx,
      '/agent Scout "watch Hacker News for Postgres news"',
    );

    expect(created).toEqual({
      name: 'Scout',
      description: 'watch Hacker News for Postgres news',
    });
    expect(outcome?.reply).toContain('Scout');
    expect(outcome?.reply).toContain('agt_new');
  });

  it('resolves an agent by name for /run', async () => {
    let agentId: string | undefined;
    const services = fakeServices({
      agents: {
        list: async () => [
          {
            id: 'agt_scout',
            name: 'Scout',
            description: null,
            status: 'active',
            version: 1,
            activeVersionId: null,
            modelId: null,
            toolIds: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        create: async () => {
          throw new Error('not expected');
        },
        get: async () => {
          throw new Error('not expected');
        },
      },
      tasks: {
        create: async (_tenantId, input) => {
          agentId = input.agentId;
          return { id: 'tsk_1', title: input.title };
        },
      },
    });

    const outcome = await dispatcher(services).run(ctx, '/run "summarise the news" --agent Scout');
    expect(agentId).toBe('agt_scout');
    expect(outcome?.reply).toContain('tsk_1');
  });

  it('lists known agents when /run names one that does not exist', async () => {
    const services = fakeServices({
      agents: {
        list: async () => [
          {
            id: 'agt_scout',
            name: 'Scout',
            description: null,
            status: 'active',
            version: 1,
            activeVersionId: null,
            modelId: null,
            toolIds: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        create: async () => {
          throw new Error('not expected');
        },
        get: async () => {
          throw new Error('not expected');
        },
      },
    });

    const outcome = await dispatcher(services).run(ctx, '/run "do a thing" --agent Ghost');
    expect(outcome?.reply).toContain('No agent matches');
    expect(outcome?.reply).toContain('Scout');
  });

  it('attributes an approval decision to the calling user', async () => {
    let seenUserId: string | null = null;
    const services = fakeServices({
      approvals: {
        list: async () => [],
        decide: async (_tenantId, _id, userId) => {
          seenUserId = userId;
          return { approval: { id: 'apr_1', status: 'approved' }, runOutcome: null };
        },
        countPending: async () => 0,
      },
    });

    await dispatcher(services).run(ctx, '/approve apr_1');
    // Not anonymous: the inbox's audit trail has to name a person.
    expect(seenUserId).toBe('usr_1');
  });

  it('answers the not-yet-built commands without fabricating anything', async () => {
    const outcome = await dispatcher(fakeServices()).run(ctx, '/research what is new in Postgres');

    expect(outcome?.command).toBe('research');
    expect(outcome?.reply).toContain('not available');
    // No invented project id, and no claim that work was started.
    expect(outcome?.reply).not.toMatch(/prj_|created/i);
  });
});
