// Diagnostic only: real NEXS services/repositories, in-memory DB, simulated provider responses.
// No production DB, real credentials, or external provider calls are used.
// Run from nexs/apps/server with managed Node + node_modules/tsx/dist/cli.mjs.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { createHarness, jsonResponse, sseResponse } from '../apps/server/test/helpers/gateway-harness.ts';
import { ChatService } from '../apps/server/src/services/chat/chat.service.ts';
import { ChatTurnRunner } from '../apps/server/src/services/chat/chat-turn.runner.ts';
import { ChatSessionRepository, ChatMessageRepository } from '../apps/server/src/repositories/chat.repo.ts';
import { RunRepository } from '../apps/server/src/repositories/run.repo.ts';
import { AgentRepository } from '../apps/server/src/repositories/agent.repo.ts';
import { GoalRepository } from '../apps/server/src/repositories/goal.repo.ts';
import { ToolRepository } from '../apps/server/src/repositories/mcp.repo.ts';
import { CredentialRepository } from '../apps/server/src/repositories/credential.repo.ts';
import { ModelProviderRepository } from '../apps/server/src/repositories/model-provider.repo.ts';
import { VaultService } from '../apps/server/src/services/vault/vault.service.ts';
import { ProviderHealthService } from '../apps/server/src/services/providers/provider-health.service.ts';
import { createAgentContextResolver } from '../apps/server/src/services/engine/agent-context.ts';
import { createChatRouter } from '../apps/server/src/routes/chat.ts';
import { createChatController } from '../apps/server/src/controllers/chat.controller.ts';

const req = createRequire('C:/Users/bharg/OneDrive/Desktop/agents/nexs/apps/server/package.json');
const express = req('express');
const pino = req('pino');
const logger = pino({ level: 'silent' });
const results: Record<string, unknown> = { scope: 'isolated real services + fake DB + synthetic provider; NOT a live inference certification', checkedAt: new Date().toISOString() };

async function main() {
  const h = createHarness();
  const tenantId = 'tnt_test';
  const db = h.fake.client;
  const provider = await h.seedProvider({ type: 'openai', apiKey: 'audit-synthetic-key', baseUrl: 'http://audit.invalid/v1' });
  const model = await h.seedModel({ providerId: provider.id, externalModelId: 'audit-chat' });
  const messages = new ChatMessageRepository(db);
  const sessions = new ChatSessionRepository(db);
  const runs = new RunRepository(db);
  const agents = new AgentRepository(db);
  const resolver = createAgentContextResolver({ agents, goals: new GoalRepository(db), logger });
  const chat = new ChatService({ sessions, messages, runs, agents, tools: new ToolRepository(db), logger, resolver });
  const frames: unknown[] = [];
  const runner = new ChatTurnRunner({ gateway: h.gateway, messages, runs, logger, tools: { invoke: async () => { throw new Error('not a tool test'); } } as never, hub: { publish: (frame: unknown) => frames.push(frame) } as never });
  const userId = 'usr_audit';

  h.onFetch(() => jsonResponse({ choices: [{ message: { role: 'assistant', content: 'AUDIT_JSON_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
  const direct = await h.gateway.chat({ tenantId, modelId: model.id, messages: [{ role: 'user', content: 'Synthetic audit ping' }], fallbackModelIds: [] });
  results.gatewayJson = { content: direct.content, modelId: direct.modelId, outboundModel: h.calls.at(-1)?.body.model };

  h.onFetch(() => sseResponse([
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'AUDIT_STREAM_OK' }, finish_reason: null }] }) + '\n\n',
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }) + '\n\n',
    'data: [DONE]\n\n',
  ]));

  const app = express();
  app.use(express.json());
  const controller = createChatController({ chat, runner, hub: { publish: (frame: unknown) => frames.push(frame) } as never, mentions: {} as never, commands: { run: () => { throw new Error('not a slash command test'); } } as never });
  app.use('/api/chat', createChatRouter({ controller, authRequired: (request, _res, next) => { request.auth = { tenantId, userId, tokenVersion: 1 }; next(); }, rateLimitPerMinute: 10000 }));
  app.use((err: Error, _request: unknown, response: { status(n: number): { json(x: unknown): void } }, _next: unknown) => response.status(500).json({ diagnosticError: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  const base = 'http://127.0.0.1:' + address.port;
  async function send(sessionId: string, body: unknown) {
    const res = await fetch(base + '/api/chat?sessionId=' + sessionId, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return { status: res.status, contentType: res.headers.get('content-type'), text: await res.text() };
  }
  try {
    const adHoc = await chat.createSession(tenantId, userId, { title: 'Isolated audit ad-hoc' });
    const success = await send(adHoc.id, { content: 'Synthetic test', modelId: model.id });
    const detail = await chat.getSession(tenantId, adHoc.id);
    results.adHocHttp = { status: success.status, contentType: success.contentType, hasDelta: success.text.includes('AUDIT_STREAM_OK'), hasCompleted: success.text.includes('chat.completed'), messages: detail.messages.map(m => ({ role: m.role, content: m.content })), runStatus: h.fake.runs.at(-1)?.status };

    const agentResult = await agents.create({ tenantId, name: 'Audit active agent', instructions: 'Respond briefly.', modelId: model.id, fallbackModelId: null, toolIds: [], mcpServerIds: [], connectorAccountIds: [], memoryEnabled: false, browserAccess: false, sandboxAccess: false, approvalPolicy: {}, executionLimits: {}, status: 'active' });
    const agent = 'agent' in agentResult ? agentResult.agent : agentResult;
    const bound = await chat.createSession(tenantId, userId, { agentId: agent.id, title: 'Isolated audit agent' });
    const beforeCalls = h.calls.length;
    const failed = await send(bound.id, { content: 'Synthetic test' });
    const stranded = h.fake.runs.at(-1);
    results.agentHttp = { ...failed, providerCalls: h.calls.length - beforeCalls, runStatus: stranded?.status, agentVersionId: stranded?.agentVersionId, userMessages: (await chat.getSession(tenantId, bound.id)).messages.length };

    const duplicate = await chat.createSession(tenantId, userId, { title: 'Isolated audit repeat delivery' });
    const first = await chat.sendMessage(tenantId, duplicate.id, { content: 'Same request', modelId: model.id });
    const second = await chat.sendMessage(tenantId, duplicate.id, { content: 'Same request', modelId: model.id });
    results.repeatDelivery = { differentRunIds: first.runId !== second.runId, differentMessageIds: first.userMessage.id !== second.userMessage.id, persistedMessages: (await chat.getSession(tenantId, duplicate.id)).messages.length, caveat: 'No client idempotency key exists; identical text alone does not define a retry.' };

    const concurrentSession = await chat.createSession(tenantId, userId, { title: 'Isolated audit double claim' });
    const prepared = await chat.prepareTurn(tenantId, concurrentSession.id, { content: 'Synthetic concurrency test', modelId: model.id });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let firstEntered!: () => void;
    const entered = new Promise<void>(r => { firstEntered = r; });
    let n = 0;
    const duplicateRunner = new ChatTurnRunner({ messages, runs, logger, tools: {} as never, hub: { publish() {} } as never, gateway: { async *stream() { n++; firstEntered(); await gate; yield { type: 'text', text: 'synthetic' }; yield { type: 'done', finishReason: 'stop' }; } } as never });
    const one = duplicateRunner.run(prepared);
    await entered;
    const two = duplicateRunner.run(prepared);
    // Allow DB promises to settle; no external polling or real provider involved.
    await new Promise<void>(r => setImmediate(r));
    const callsBeforeRelease = n;
    release();
    const returns = await Promise.all([one, two]);
    results.doubleClaim = { concurrentGatewayEntries: callsBeforeRelease, nonNullResults: returns.filter(x => x !== null).length, assistantRows: (await chat.getSession(tenantId, concurrentSession.id)).messages.filter(m => m.role === 'assistant').length, scope: 'same PreparedTurn passed to runner twice; not proof of public same-run HTTP replay' };

    const local = await h.seedProvider({ type: 'ollama', baseUrl: 'http://audit.invalid/v1' });
    let probeCalls = 0;
    const health = new ProviderHealthService({ providers: new ModelProviderRepository(db), credentials: new CredentialRepository(db), vault: new VaultService('harness-signing-secret-at-least-32-chars'), logger, timeoutMs: 500, resolveBaseUrl: () => 'http://audit.invalid/v1', fetch: async () => { probeCalls++; return jsonResponse({ data: [] }); } });
    const check = await health.checkOne(local);
    h.onFetch(() => jsonResponse({ data: [{ id: 'audit-local' }] }));
    const discovered = await h.gateway.discoverModels(tenantId, local.id);
    results.keylessLocalHealth = { status: check.status, reason: check.reason, healthFetchCalls: probeCalls, gatewayDiscoveryCount: discovered.length };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(resolve));
  }
  await writeFile('C:/Users/bharg/OneDrive/Desktop/agents/nexs/outputs/gateway-chat-audit-results.json', JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
}
main().catch(err => { console.error(err); process.exitCode = 1; });
