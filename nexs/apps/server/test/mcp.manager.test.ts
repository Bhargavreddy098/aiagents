import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServer } from '@prisma/client';
import { ApiError, type McpToolDescriptor } from '@nexs/shared';
import {
  MCPToolRepository,
  McpServerRepository,
  ToolRepository,
  type McpServerCreateInput,
} from '../src/repositories/mcp.repo.js';
import {
  MCPManager,
  canonicalToolName,
  parseEnvBlock,
  type McpManagerOptions,
} from '../src/services/mcp/mcp-manager.js';
import type { ProcessReaper } from '../src/services/mcp/orphans.js';
import { LocalStorageService, readText } from '../src/services/storage/storage.service.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';
import {
  FakeMcpSessionFactory,
  createRecordingLogger,
  deferred,
  flush,
  type FakeSessionFactoryOptions,
} from './helpers/mcp-harness.js';

/**
 * `MCPManager`.
 *
 * The plan's acceptance test for Phase 4 is:
 *
 * > crash an MCP server mid-run → step marked failed, no zombie process, no double-fired
 * > side effect on resume; a 10 MB tool result is capped and the run continues.
 *
 * Both halves are here. "No double-fired side effect" is the half that is easy to claim and
 * hard to prove, so it is asserted the only way that means anything: by counting how many
 * times the request actually reached the wire, on both sides of the crash.
 */

const TENANT = 'tnt_mcp';
const OTHER_TENANT = 'tnt_other';

/** `read_file` declares itself harmless; `write_file` declares nothing, so it is assumed effectful. */
const READ_TOOL: McpToolDescriptor = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};

const WRITE_TOOL: McpToolDescriptor = {
  name: 'write_file',
  description: 'Write a file',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};

const TOOLS: McpToolDescriptor[] = [READ_TOOL, WRITE_TOOL];

// ── rig ───────────────────────────────────────────────────────────────────────

interface FakeReaper extends ProcessReaper {
  killed: number[];
  live: Record<number, string | null>;
}

interface Rig {
  db: FakeDb;
  manager: MCPManager;
  factory: FakeMcpSessionFactory;
  servers: McpServerRepository;
  mcpTools: MCPToolRepository;
  tools: ToolRepository;
  storage: LocalStorageService;
  records: Array<Record<string, unknown>>;
  events: Array<{ name: string; payload: unknown }>;
  reaper: FakeReaper;
  envCalls: Array<{ tenantId: string; envRef: string | null }>;
  envValue: Record<string, string>;
  /** Point the reaper at a different set of live processes. */
  setProcesses(live: Record<number, string | null>): void;
}

let storageRoot: string;

function makeRig(
  overrides: Partial<McpManagerOptions> = {},
  factoryOptions: FakeSessionFactoryOptions = {},
): Rig {
  const db = createFakeDb();
  const { logger, records } = createRecordingLogger();

  const factory = new FakeMcpSessionFactory({
    session: { tools: TOOLS },
    ...factoryOptions,
  });

  const reaper: FakeReaper = {
    killed: [],
    live: {},
    async inspect(pid: number) {
      if (!(pid in reaper.live)) return { alive: false, commandLine: null };
      return { alive: true, commandLine: reaper.live[pid] ?? null };
    },
    async kill(pid: number) {
      reaper.killed.push(pid);
      delete reaper.live[pid];
    },
  };

  const servers = new McpServerRepository(db.client);
  const mcpTools = new MCPToolRepository(db.client);
  const tools = new ToolRepository(db.client);
  const storage = new LocalStorageService(storageRoot);
  const events: Array<{ name: string; payload: unknown }> = [];
  const envCalls: Array<{ tenantId: string; envRef: string | null }> = [];

  const rig: Rig = {
    db,
    factory,
    servers,
    mcpTools,
    tools,
    storage,
    records,
    events,
    reaper,
    envCalls,
    envValue: { GITHUB_TOKEN: 'ghp_supersecret' },
    setProcesses(live) {
      reaper.live = live;
      reaper.killed.length = 0;
    },
    manager: new MCPManager({
      servers,
      mcpTools,
      tools,
      storage,
      sessionFactory: factory,
      resolveEnv: async (tenantId, envRef) => {
        envCalls.push({ tenantId, envRef });
        return envRef === null ? {} : rig.envValue;
      },
      logger,
      options: {
        maxStdioServers: 10,
        callTimeoutMs: 1_000,
        connectTimeoutMs: 1_000,
        toolResultMaxBytes: 64 * 1024,
        ...overrides,
      },
      emit: (_tenantId, event) => {
        events.push(event);
      },
      reaper,
    }),
  };

  return rig;
}

async function seedServer(
  rig: Rig,
  overrides: Partial<McpServerCreateInput> = {},
): Promise<McpServer> {
  return rig.servers.create({
    tenantId: TENANT,
    name: 'filesystem',
    transport: 'stdio',
    command: 'node',
    args: ['/srv/mcp-fs.js'],
    ...overrides,
  });
}

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'nexs-mcp-'));
});

afterEach(async () => {
  // Best-effort: a refused delete must never be reported as a test failure.
  await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
});

// ── connect & discovery ───────────────────────────────────────────────────────

describe('connecting and discovering', () => {
  it('records the child pid and registers canonical tools', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);

    const summary = await rig.manager.connect(TENANT, server.id);

    expect(summary).toMatchObject({
      id: server.id,
      name: 'filesystem',
      transport: 'stdio',
      status: 'connected',
      pid: 4242,
      toolCount: 2,
    });

    const row = await rig.servers.findById(TENANT, server.id);
    expect(row?.pid).toBe(4242);
    expect(row?.lastConnectedAt).toBeInstanceOf(Date);

    const canonical = await rig.tools.list(TENANT);
    expect(canonical).toHaveLength(2);
    for (const tool of canonical) {
      expect(tool.type).toBe('mcp');
      // Agents reference the canonical Tool.id; the provider/source pair is how the
      // invoker finds its way back to the server without the agent naming it.
      expect(tool.provider).toBe(server.id);
      expect(tool.source).toBe(`mcp:${server.id}`);
      expect(tool.mcpServerId).toBe(server.id);
      expect(tool.status).toBe('enabled');
    }

    const read = canonical.find((tool) => tool.name === 'filesystem__read_file');
    expect(read?.capabilities).toEqual(['read_only']);
    expect((read?.metadata as Record<string, unknown>)['externalId']).toBe('read_file');

    const write = canonical.find((tool) => tool.name === 'filesystem__write_file');
    expect(write?.capabilities).toEqual(['external_side_effect']);

    // Every discovery-cache row points at its canonical tool, which is how `callTool`
    // recovers the capability set it has to enforce.
    const links = await rig.mcpTools.listForServer(server.id);
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.toolId !== null)).toBe(true);
  });

  it('announces the connection with a tool count', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);

    await rig.manager.connect(TENANT, server.id);

    expect(rig.events).toEqual([
      { name: 'mcp.connected', payload: { serverId: server.id, toolCount: 2 } },
    ]);
  });

  it('is idempotent — a second connect does not spawn a second child', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);

    await rig.manager.connect(TENANT, server.id);
    await rig.manager.connect(TENANT, server.id);

    expect(rig.factory.openCount).toBe(1);
    expect(rig.manager.liveSessionCount).toBe(1);
  });

  it('shares one in-flight connect between concurrent callers', async () => {
    // Two steps of one run both reaching for the same server must not race into two
    // children; the loser of the race waits for the winner's handshake.
    const gate = deferred();
    const rig = makeRig({}, { gate: gate.promise });
    const server = await seedServer(rig);

    const first = rig.manager.connect(TENANT, server.id);
    const second = rig.manager.connect(TENANT, server.id);
    await flush();
    gate.resolve();

    await Promise.all([first, second]);

    expect(rig.factory.openCount).toBe(1);
    expect(rig.manager.liveSessionCount).toBe(1);
  });

  it('skips the tool list for a server that does not declare the capability', async () => {
    const rig = makeRig({}, { session: { tools: TOOLS, capabilities: { tools: false } } });
    const server = await seedServer(rig);

    const summary = await rig.manager.connect(TENANT, server.id);

    // `tools/list` against a server without the capability is a protocol error, not an
    // empty result — so it is never sent.
    expect(rig.factory.latest.invocations).toEqual([]);
    expect(summary.toolCount).toBe(0);
  });

  it('keeps the decrypted env out of every row and every log line', async () => {
    const rig = makeRig({}, { failAllOpensWith: new Error('spawn node ENOENT') });
    const server = await seedServer(rig, { name: 'github', envRef: 'cred_1' });

    await expect(rig.manager.connect(TENANT, server.id)).rejects.toThrow(/ENOENT/);

    // The plaintext did reach the child — otherwise the feature is decorative.
    expect(rig.envCalls).toEqual([{ tenantId: TENANT, envRef: 'cred_1' }]);
    expect(rig.factory.specs[0]?.env).toEqual({ GITHUB_TOKEN: 'ghp_supersecret' });

    // …and nowhere else. A secret in a `lastError` is a secret in the dashboard.
    const row = await rig.servers.findById(TENANT, server.id);
    expect(row?.lastError).not.toContain('ghp_supersecret');
    expect(JSON.stringify(rig.records)).not.toContain('ghp_supersecret');
  });

  it('marks the server errored and returns the permit when the handshake fails', async () => {
    const rig = makeRig({}, { failAllOpensWith: new Error('spawn node ENOENT') });
    const server = await seedServer(rig);

    await expect(rig.manager.connect(TENANT, server.id)).rejects.toThrow(/ENOENT/);

    const row = await rig.servers.findById(TENANT, server.id);
    expect(row?.status).toBe('error');
    expect(row?.pid).toBeNull();
    expect(row?.lastError).toContain('ENOENT');

    expect(rig.manager.liveSessionCount).toBe(0);
    // The permit must come back, or ten failed handshakes would wedge the pool forever.
    expect(rig.manager.stdioSlots.inUse).toBe(0);
  });

  it('does not serve a server that belongs to another tenant', async () => {
    const rig = makeRig();
    const server = await seedServer(rig, { tenantId: OTHER_TENANT });

    await expect(rig.manager.connect(TENANT, server.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(rig.manager.callTool(TENANT, server.id, 'read_file', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    // Nothing was spawned on the strength of an id alone.
    expect(rig.factory.openCount).toBe(0);
  });
});

// ── discovery changes ─────────────────────────────────────────────────────────

describe('rediscovery', () => {
  it('disables a tool the server stopped advertising instead of deleting it', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    rig.factory.options.session = { tools: [READ_TOOL] };
    await rig.manager.reconnect(TENANT, server.id);

    const links = await rig.mcpTools.listForServer(server.id);
    expect(links.find((link) => link.externalId === 'write_file')?.enabled).toBe(false);
    expect(links.find((link) => link.externalId === 'read_file')?.enabled).toBe(true);

    const canonical = await rig.tools.list(TENANT);
    // Still two rows: a run that referenced `write_file` must still render its history.
    expect(canonical).toHaveLength(2);
    expect(canonical.find((tool) => tool.name === 'filesystem__write_file')?.status).toBe(
      'disabled',
    );
    expect(canonical.find((tool) => tool.name === 'filesystem__read_file')?.status).toBe('enabled');
  });

  it('re-enables a tool the server advertises again', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    rig.factory.options.session = { tools: [READ_TOOL] };
    await rig.manager.reconnect(TENANT, server.id);

    rig.factory.options.session = { tools: TOOLS };
    await rig.manager.reconnect(TENANT, server.id);

    const links = await rig.mcpTools.listForServer(server.id);
    expect(links.every((link) => link.enabled)).toBe(true);
    expect((await rig.tools.list(TENANT)).every((tool) => tool.status === 'enabled')).toBe(true);
  });

  it('refuses to let a server widen a tool it already recorded as effectful', async () => {
    // The escalation this blocks: a server that flips its own tool to `readOnlyHint: true`
    // would be opting itself out of the approval policy and into automatic replay.
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);
    await rig.manager.disconnect(TENANT, server.id);

    rig.factory.options.session = { tools: [WRITE_TOOL] };
    await rig.manager.reconnect(TENANT, server.id);

    rig.factory.options.session = {
      tools: [{ ...WRITE_TOOL, annotations: { readOnlyHint: true } }],
    };
    await rig.manager.reconnect(TENANT, server.id);

    const tool = (await rig.tools.list(TENANT)).find(
      (candidate) => candidate.name === 'filesystem__write_file',
    );
    expect(tool?.capabilities).toEqual(['external_side_effect']);
    expect(
      rig.records.some((record) =>
        String(record['msg']).includes('widened a tool capability'),
      ),
    ).toBe(true);
  });

  it('accepts a server narrowing its own claim', async () => {
    // The other direction is always allowed: a tool that stops promising it is harmless is
    // a tool we should stop replaying.
    const rig = makeRig();
    const server = await seedServer(rig);
    rig.factory.options.session = { tools: [READ_TOOL] };
    await rig.manager.connect(TENANT, server.id);

    rig.factory.options.session = { tools: [{ ...READ_TOOL, annotations: undefined }] };
    await rig.manager.reconnect(TENANT, server.id);

    const tool = (await rig.tools.list(TENANT)).find(
      (candidate) => candidate.name === 'filesystem__read_file',
    );
    expect(tool?.capabilities).toEqual(['external_side_effect']);
  });
});

// ── the crash path ────────────────────────────────────────────────────────────

describe('a server that dies mid-call', () => {
  it('marks the step failed, the server crashed, and the tools errored', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    rig.factory.latest.crashSilently(new Error('ECONNRESET'));

    await expect(
      rig.manager.callTool(TENANT, server.id, 'write_file', { path: '/tmp/x' }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });

    const row = await rig.servers.findById(TENANT, server.id);
    expect(row?.status).toBe('crashed');
    // The pid is cleared so the next boot does not try to reap a process the transport
    // has already killed.
    expect(row?.pid).toBeNull();
    expect(row?.lastError).toContain('ECONNRESET');

    const canonical = await rig.tools.list(TENANT);
    expect(canonical.every((tool) => tool.status === 'error')).toBe(true);

    // No zombie: the session is gone and its stdio permit is back in the pool.
    expect(rig.manager.liveSessionCount).toBe(0);
    expect(rig.manager.stdioSlots.inUse).toBe(0);
  });

  it('does not retry by default, and says the outcome is unknown', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    const session = rig.factory.latest;
    session.crashOnNextCall = new Error('ECONNRESET');

    const error = await rig.manager
      .callTool(TENANT, server.id, 'read_file', { path: '/etc/hosts' })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PROVIDER_ERROR');
    expect((error as ApiError).details).toMatchObject({
      crashed: true,
      // The flag the engine reads: the request was written, so it may or may not have been
      // applied, and replaying it is not obviously safe.
      outcomeUnknown: true,
    });

    // Exactly one attempt reached the wire.
    expect(rig.factory.sessions).toHaveLength(1);
    expect(session.calls).toHaveLength(1);
  });

  it('refuses to replay a side-effecting tool even when the caller asks', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    const session = rig.factory.latest;
    session.crashOnNextCall = new Error('ECONNRESET');

    await expect(
      rig.manager.callTool(
        TENANT,
        server.id,
        'write_file',
        { path: '/tmp/x' },
        { allowReconnectOnCrash: true },
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });

    // The assertion that matters: the request was sent once and only once, so the effect
    // cannot have been applied twice.
    expect(rig.factory.sessions).toHaveLength(1);
    expect(session.calls).toHaveLength(1);
  });

  it('replays a read-only tool, because replaying it cannot change anything', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    const first = rig.factory.latest;
    first.crashOnNextCall = new Error('ECONNRESET');

    const result = await rig.manager.callTool(
      TENANT,
      server.id,
      'read_file',
      { path: '/etc/hosts' },
      { allowReconnectOnCrash: true },
    );

    expect(result.content).toBe('ok');
    expect(rig.factory.sessions).toHaveLength(2);
    expect(first.calls).toHaveLength(1);
    expect(rig.factory.sessions[1]?.calls).toHaveLength(1);

    // And the server is back up, not left in the crashed state the first attempt wrote.
    const row = await rig.servers.findById(TENANT, server.id);
    expect(row?.status).toBe('connected');
    expect(row?.pid).toBe(4242);
  });

  it('opens a fresh session on the next call after a crash', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    rig.factory.latest.crashSilently(new Error('dead'));
    await expect(rig.manager.callTool(TENANT, server.id, 'read_file', {})).rejects.toThrow();

    const result = await rig.manager.callTool(TENANT, server.id, 'read_file', {});

    expect(result.content).toBe('ok');
    expect(rig.factory.sessions).toHaveLength(2);
    expect(rig.factory.sessions[0]?.calls).toHaveLength(1);
    expect(rig.factory.sessions[1]?.calls).toHaveLength(1);
  });

  it('records a crash once even when the transport reports it twice', async () => {
    // A real transport fires `onerror` and then `onclose`. Two teardowns would mean two
    // `crashed` writes and two permits returned — a leak dressed up as a log line.
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    const session = rig.factory.latest;
    session.crash(new Error('boom'));
    session.crash(new Error('boom'));
    await flush();

    const crashes = rig.records.filter((record) => record['msg'] === 'mcp: server crashed');
    expect(crashes).toHaveLength(1);
    expect(rig.manager.stdioSlots.inUse).toBe(0);
    expect(rig.manager.liveSessionCount).toBe(0);
  });
});

// ── the concurrency cap ───────────────────────────────────────────────────────

describe('the stdio concurrency cap', () => {
  it('queues a server beyond the cap and admits it when a slot frees', async () => {
    const gate = deferred();
    const rig = makeRig({ maxStdioServers: 1 }, { gate: gate.promise });
    const first = await seedServer(rig, { name: 'first' });
    const second = await seedServer(rig, { name: 'second' });

    const connectingFirst = rig.manager.connect(TENANT, first.id);
    await flush();
    expect(rig.factory.openCount).toBe(1);
    expect(rig.manager.stdioSlots.inUse).toBe(1);

    const connectingSecond = rig.manager.connect(TENANT, second.id);
    await flush();

    // The second server's child was never spawned — that is the leak the cap prevents.
    expect(rig.factory.openCount).toBe(1);
    expect(rig.manager.stdioSlots.queued).toBe(1);

    gate.resolve();
    await connectingFirst;
    expect(rig.manager.liveSessionCount).toBe(1);

    await rig.manager.disconnect(TENANT, first.id);
    await connectingSecond;

    expect(rig.factory.openCount).toBe(2);
    expect(rig.manager.liveSessionCount).toBe(1);
    expect(rig.manager.isConnected(second.id)).toBe(true);
    expect(rig.manager.stdioSlots.inUse).toBe(1);
  });

  it('does not count HTTP servers against the process cap', async () => {
    // The cap bounds processes. A streamable-http server owns a socket, not a pid.
    const rig = makeRig({ maxStdioServers: 1 });
    const first = await seedServer(rig, {
      name: 'a',
      transport: 'streamable-http',
      command: null,
      url: 'https://a.example/mcp',
    });
    const second = await seedServer(rig, {
      name: 'b',
      transport: 'streamable-http',
      command: null,
      url: 'https://b.example/mcp',
    });

    await rig.manager.connect(TENANT, first.id);
    await rig.manager.connect(TENANT, second.id);

    expect(rig.factory.openCount).toBe(2);
    expect(rig.manager.liveSessionCount).toBe(2);
    expect(rig.manager.stdioSlots.inUse).toBe(0);
    expect(rig.factory.specs[0]?.transport).toBe('streamable-http');
    expect(rig.factory.specs[0]?.url).toBe('https://a.example/mcp');
    // No command means no child: the spec carries the URL and nothing to spawn.
    expect(rig.factory.specs[0]?.command).toBeUndefined();
    expect(rig.factory.latest.pid).toBeNull();
  });

  it('does not leak a permit across repeated connect and disconnect cycles', async () => {
    const rig = makeRig({ maxStdioServers: 1 });
    const server = await seedServer(rig);

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await rig.manager.connect(TENANT, server.id);
      await rig.manager.disconnect(TENANT, server.id);
    }

    expect(rig.factory.openCount).toBe(5);
    expect(rig.manager.stdioSlots.inUse).toBe(0);

    // A sixth connect still works: the cap has not silently closed on itself.
    await rig.manager.connect(TENANT, server.id);
    expect(rig.manager.isConnected(server.id)).toBe(true);
  });
});

// ── results ───────────────────────────────────────────────────────────────────

describe('tool results', () => {
  it('caps a 10 MB result, keeps the payload retrievable, and lets the run continue', async () => {
    // The second half of the phase's acceptance test.
    const payload = 'x'.repeat(10 * 1024 * 1024);
    const rig = makeRig(
      { toolResultMaxBytes: 64 * 1024 },
      { session: { tools: TOOLS, respond: () => ({ content: payload, isError: false }) } },
    );
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    const result = await rig.manager.callTool(TENANT, server.id, 'read_file', {});

    expect(result.truncated).toBe(true);
    expect(result.originalBytes).toBe(10 * 1024 * 1024);
    expect(result.ref).toBeDefined();
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(result.content).toContain('result truncated');
    // The summary is a bounded excerpt, not a re-print of the payload.
    expect(result.content.length).toBeLessThan(payload.length);

    // Nothing was lost: the whole payload is addressable through the ref, which is what
    // makes the cap a resource limit rather than a silent data loss.
    expect(await readText(rig.storage, result.ref!)).toBe(payload);

    // …and the run is still alive afterwards.
    expect(rig.manager.liveSessionCount).toBe(1);
    expect((await rig.servers.findById(TENANT, server.id))?.status).toBe('connected');
  });

  it('passes a small result through untouched', async () => {
    const rig = makeRig({}, { session: { tools: TOOLS, respond: () => ({ content: 'hello', isError: false }) } });
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    const result = await rig.manager.callTool(TENANT, server.id, 'read_file', {});

    expect(result).toEqual({ content: 'hello', truncated: false, originalBytes: 5 });
    expect(result.ref).toBeUndefined();
  });

  it('returns a tool-reported failure as a result rather than an exception', async () => {
    // A tool saying "no such file" is a successful call with a negative answer. Throwing
    // here would make the engine retry a deterministic failure.
    const rig = makeRig(
      {},
      { session: { tools: TOOLS, respond: () => ({ content: 'ENOENT: no such file', isError: true }) } },
    );
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    const result = await rig.manager.callTool(TENANT, server.id, 'read_file', {});

    expect(result.isError).toBe(true);
    expect(result.content).toBe('ENOENT: no such file');
  });

  it('refuses a tool the server does not expose', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    await expect(rig.manager.callTool(TENANT, server.id, 'rm_rf', {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(rig.factory.latest.calls).toHaveLength(0);
  });

  it('refuses a tool the server has withdrawn', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    rig.factory.options.session = { tools: [READ_TOOL] };
    await rig.manager.reconnect(TENANT, server.id);

    await expect(rig.manager.callTool(TENANT, server.id, 'write_file', {})).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(rig.factory.latest.calls).toHaveLength(0);
  });
});

// ── disconnect, delete, shutdown ──────────────────────────────────────────────

describe('teardown', () => {
  it('disconnects without deleting the canonical tools', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    await rig.manager.disconnect(TENANT, server.id);

    const row = await rig.servers.findById(TENANT, server.id);
    expect(row?.status).toBe('disconnected');
    expect(row?.pid).toBeNull();

    const canonical = await rig.tools.list(TENANT);
    expect(canonical).toHaveLength(2);
    expect(canonical.every((tool) => tool.status === 'disabled')).toBe(true);
    expect(rig.manager.liveSessionCount).toBe(0);
  });

  it('unregisters canonical tools on delete rather than dropping them', async () => {
    // `ToolCall.toolId` is a foreign key; deleting the tool would break run history.
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    await rig.manager.deleteServer(TENANT, server.id);

    expect(await rig.servers.findById(TENANT, server.id)).toBeNull();
    const canonical = await rig.tools.list(TENANT);
    expect(canonical).toHaveLength(2);
    expect(canonical.every((tool) => tool.status === 'disabled')).toBe(true);
    expect(rig.manager.liveSessionCount).toBe(0);
  });

  it('closes every session and clears the pids on shutdown', async () => {
    const rig = makeRig();
    const first = await seedServer(rig, { name: 'first' });
    const second = await seedServer(rig, { name: 'second' });
    await rig.manager.connect(TENANT, first.id);
    await rig.manager.connect(TENANT, second.id);

    const sessions = [...rig.factory.sessions];
    await rig.manager.shutdown();

    expect(sessions.every((session) => session.closed)).toBe(true);
    expect(rig.manager.liveSessionCount).toBe(0);
    expect(rig.manager.stdioSlots.inUse).toBe(0);

    for (const server of [first, second]) {
      const row = await rig.servers.findById(TENANT, server.id);
      expect(row?.pid).toBeNull();
      // A planned shutdown is not a crash. Writing `crashed` here would be a lie the health
      // dashboard repeats on every restart.
      expect(row?.status).toBe('disconnected');
    }
  });
});

// ── orphan reconciliation ─────────────────────────────────────────────────────

describe('startup reconciliation', () => {
  it('kills a child left behind by a hard kill and clears the row', async () => {
    const rig = makeRig();
    const server = await seedServer(rig, { name: 'fs', command: 'node' });
    // What a previous process left behind: a row that still claims a live pid.
    await rig.servers.markConnected(TENANT, server.id, 9090);
    rig.setProcesses({ 9090: 'node /srv/mcp-fs.js' });

    const outcomes = await rig.manager.reapOrphans();

    expect(rig.reaper.killed).toEqual([9090]);
    expect(outcomes).toEqual([
      { serverId: server.id, verdict: { action: 'killed', pid: 9090 } },
    ]);

    const row = await rig.servers.findById(TENANT, server.id);
    expect(row?.pid).toBeNull();
    expect(row?.status).toBe('disconnected');
    expect(row?.lastError).toContain('reaped');
  });

  it('leaves an unattributable pid alone and records why', async () => {
    // The dangerous case: alive, but the platform will not tell us what it is. Killing it
    // could kill an unrelated process that inherited the pid, so we do not.
    const rig = makeRig();
    const server = await seedServer(rig, { command: 'node' });
    await rig.servers.markConnected(TENANT, server.id, 9090);
    rig.setProcesses({ 9090: null });

    const outcomes = await rig.manager.reapOrphans();

    expect(rig.reaper.killed).toEqual([]);
    expect(outcomes[0]?.verdict).toMatchObject({ action: 'skipped', reason: 'unverifiable' });

    const row = await rig.servers.findById(TENANT, server.id);
    expect(row?.pid).toBeNull();
    expect(row?.lastError).toContain('could not be verified');

    // Logged at warn: this is a decision a human has to finish.
    expect(rig.records.some((record) => String(record['msg']).includes('refusing to kill'))).toBe(
      true,
    );
  });

  it('leaves a pid that now belongs to a different program alone', async () => {
    const rig = makeRig();
    const server = await seedServer(rig, { command: 'node' });
    await rig.servers.markConnected(TENANT, server.id, 9090);
    rig.setProcesses({ 9090: '/usr/sbin/nginx -g daemon off;' });

    const outcomes = await rig.manager.reapOrphans();

    expect(rig.reaper.killed).toEqual([]);
    expect(outcomes[0]?.verdict).toMatchObject({ action: 'skipped', reason: 'not-our-process' });
  });

  it('reports a pid that is already gone without signalling it', async () => {
    const rig = makeRig();
    const server = await seedServer(rig, { command: 'node' });
    await rig.servers.markConnected(TENANT, server.id, 9090);
    rig.setProcesses({});

    const outcomes = await rig.manager.reapOrphans();

    expect(rig.reaper.killed).toEqual([]);
    expect(outcomes[0]?.verdict).toEqual({ action: 'gone', pid: 9090 });
    expect((await rig.servers.findById(TENANT, server.id))?.lastError).toBeNull();
  });

  it('is a no-op after a clean shutdown, because the pids were cleared', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);
    await rig.manager.shutdown();

    rig.setProcesses({ 4242: 'node /srv/mcp-fs.js' });
    const outcomes = await rig.manager.reapOrphans();

    expect(outcomes).toEqual([]);
    expect(rig.reaper.killed).toEqual([]);
  });
});

// ── resources and prompts ─────────────────────────────────────────────────────

describe('resources and prompts', () => {
  it('reads them from a live session', async () => {
    const rig = makeRig(
      {},
      {
        session: {
          tools: TOOLS,
          resources: { resources: [{ uri: 'file:///a.txt', name: 'a.txt' }] },
          prompts: { prompts: [{ name: 'summarise' }] },
        },
      },
    );
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);

    expect(await rig.manager.listResources(TENANT, server.id)).toEqual({
      resources: [{ uri: 'file:///a.txt', name: 'a.txt' }],
    });
    expect(await rig.manager.listPrompts(TENANT, server.id)).toEqual({
      prompts: [{ name: 'summarise' }],
    });
  });

  it('refuses to spawn a process for a GET on a disconnected server', async () => {
    const rig = makeRig();
    const server = await seedServer(rig);

    await expect(rig.manager.listResources(TENANT, server.id)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(rig.factory.openCount).toBe(0);
  });

  it('serves the cached tool list while disconnected', async () => {
    // The discovery cache is the reason `GET /api/mcp/:id` can render at all before the
    // operator reconnects.
    const rig = makeRig();
    const server = await seedServer(rig);
    await rig.manager.connect(TENANT, server.id);
    await rig.manager.disconnect(TENANT, server.id);

    const tools = await rig.manager.listTools(TENANT, server.id);

    expect(tools).toHaveLength(2);
    expect(tools.find((tool) => tool.externalId === 'read_file')?.capabilities).toEqual([
      'read_only',
    ]);
    expect(rig.factory.openCount).toBe(1);
  });
});

// ── pure helpers ──────────────────────────────────────────────────────────────

describe('canonical tool naming', () => {
  it('namespaces by server so two servers cannot collide', () => {
    expect(canonicalToolName('filesystem', 'read_file')).toBe('filesystem__read_file');
    expect(canonicalToolName('github', 'read_file')).toBe('github__read_file');
  });

  it('produces a name a function-calling API will accept', () => {
    const name = canonicalToolName('My Server!', 'read file (v2)');
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('stays within 64 characters, deterministically and without collisions', () => {
    const long = 'x'.repeat(120);
    const first = canonicalToolName(long, long);
    const second = canonicalToolName(long, `${long}y`);

    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
    // Same input, same name — otherwise every reconnect would create a new Tool row.
    expect(canonicalToolName(long, long)).toBe(first);
    expect(first).not.toBe(second);
  });

  it('survives a name made entirely of punctuation', () => {
    expect(canonicalToolName('!!!', '???')).toBe('tool__tool');
  });
});

describe('parsing an env credential', () => {
  it('reads KEY=value lines', () => {
    expect(parseEnvBlock('A=1\nB=2')).toEqual({ A: '1', B: '2' });
  });

  it('skips blank lines and comments so a .env file can be pasted in', () => {
    expect(parseEnvBlock('# github\n\nGITHUB_TOKEN=abc\n')).toEqual({ GITHUB_TOKEN: 'abc' });
  });

  it('strips one layer of matching quotes', () => {
    expect(parseEnvBlock('A = "quoted value" ')).toEqual({ A: 'quoted value' });
    expect(parseEnvBlock("B='single'")).toEqual({ B: 'single' });
    expect(parseEnvBlock('C="mismatched\'')).toEqual({ C: '"mismatched\'' });
  });

  it('keeps equals signs that appear in the value', () => {
    expect(parseEnvBlock('TOKEN=a=b=c')).toEqual({ TOKEN: 'a=b=c' });
  });

  it('ignores lines with no key', () => {
    expect(parseEnvBlock('novalue\n=orphan\nA=1')).toEqual({ A: '1' });
  });

  it('tolerates CRLF', () => {
    expect(parseEnvBlock('A=1\r\nB=2')).toEqual({ A: '1', B: '2' });
  });
});
