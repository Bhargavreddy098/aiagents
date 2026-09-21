import pino from 'pino';
import type { Model, ModelProvider } from '@prisma/client';
import type { ModelPricing, ProviderType, StructuredOutputMode } from '@nexs/shared';
import { CircuitBreaker } from '../../src/services/gateway/circuit-breaker.js';
import { ModelGateway } from '../../src/services/gateway/model-gateway.js';
import type { AdapterContext } from '../../src/services/gateway/adapters/types.js';
import { VaultService } from '../../src/services/vault/vault.service.js';
import { CredentialRepository } from '../../src/repositories/credential.repo.js';
import { ModelProviderRepository } from '../../src/repositories/model-provider.repo.js';
import { ModelUsageRepository } from '../../src/repositories/model-usage.repo.js';
import { ModelRepository } from '../../src/repositories/model.repo.js';
import { createFakeDb, type FakeDb } from './fake-db.js';

/**
 * Wires a real `ModelGateway` over the in-memory database with a stubbed `fetch`.
 *
 * The fetch stub returns genuine `Response` objects (including real `ReadableStream`
 * bodies) rather than a hand-rolled object. That matters: the adapters read
 * `response.headers.get('retry-after')`, `response.body` and `response.ok`, and a fake
 * that only implements the three fields a test happens to think about would let a
 * wrong implementation pass.
 */

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export type FetchHandler = (call: FetchCall) => Response | Promise<Response>;

export interface SeedProviderInput {
  tenantId?: string;
  type?: ProviderType;
  slug?: string;
  name?: string;
  baseUrl?: string;
  /** Stored encrypted in the vault; the harness never sees the plaintext again. */
  apiKey?: string;
  enabled?: boolean;
}

export interface SeedModelInput {
  tenantId?: string;
  providerId: string;
  externalModelId: string;
  name?: string;
  type?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: ModelPricing;
  embeddingDimension?: number;
  /** Per-model override of the provider's default structured-output mechanism. */
  structuredOutputMode?: StructuredOutputMode;
  fallbackOf?: string | null;
  enabled?: boolean;
}

export interface Harness {
  gateway: ModelGateway;
  fake: FakeDb;
  breaker: CircuitBreaker;
  usage: ModelUsageRepository;
  calls: FetchCall[];
  /** Every delay the gateway asked for, in order — retry timing without real waiting. */
  sleeps: number[];
  /** Replace the fetch behaviour; the default rejects, so a test must opt in. */
  onFetch(handler: FetchHandler): void;
  seedProvider(input: SeedProviderInput): Promise<ModelProvider>;
  seedModel(input: SeedModelInput): Promise<Model>;
  /** Advance the injected clock, which is what `latencyMs` is measured against. */
  advance(ms: number): void;
}

const TENANT = 'tnt_test';

/** Build a real JSON `Response`. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** Build a real SSE `Response` from raw frames. */
export function sseResponse(frames: string[], init: ResponseInit = {}): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    ...init,
  });
}

/**
 * A stream that emits the given frames and then fails — the "provider died mid-stream"
 * case. The failure surfaces as a rejected `reader.read()`, exactly like a dropped
 * socket, rather than as a clean close.
 */
export function failingSseResponse(frames: string[], failAfterFrames: number): Response {
  const encoder = new TextEncoder();
  let index = 0;

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === failAfterFrames) {
        controller.error(new Error('socket hang up'));
        return;
      }
      if (index >= frames.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(frames[index]!));
      index += 1;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export function createHarness(options: { failureThreshold?: number; openMs?: number } = {}): Harness {
  const fake = createFakeDb();
  const logger = pino({ level: 'silent' });

  // `VaultService` takes the signing secret and derives the key from it.
  const vault = new VaultService('harness-signing-secret-at-least-32-chars');

  const models = new ModelRepository(fake.client);
  const providers = new ModelProviderRepository(fake.client);
  const usage = new ModelUsageRepository(fake.client);
  const credentials = new CredentialRepository(fake.client);

  const calls: FetchCall[] = [];
  let handler: FetchHandler = () => {
    throw new Error('harness: no fetch handler registered — call onFetch() first');
  };

  // The inner arrow reads `handler` at call time, so `onFetch` can be replaced after
  // construction without rebuilding the stub.
  const fetchStub: typeof globalThis.fetch = recordingFetch(calls, (call) => handler(call));

  // A controllable clock: `latencyMs` is measured with it, so a test can assert exact
  // timings without sleeping.
  let clock = 1_000_000;
  const advance = (ms: number): void => {
    clock += ms;
  };

  // Retries must not actually wait, but the *delay the gateway chose* is part of the
  // behaviour under test — so it is recorded rather than discarded.
  const sleeps: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    sleeps.push(ms);
    clock += ms;
    return Promise.resolve();
  };

  const breaker = new CircuitBreaker({
    failureThreshold: options.failureThreshold ?? 3,
    openMs: options.openMs ?? 30_000,
    now: () => clock,
  });

  const gateway = new ModelGateway({
    models,
    providers,
    usage,
    credentials,
    vault,
    logger,
    fetch: fetchStub,
    breaker,
    retryPolicy: { maxAttempts: 3, baseMs: 100, maxMs: 1_000 },
    // Retries must not actually wait; the delay itself is asserted in retry.test.ts.
    sleep,
    now: () => clock,
    random: () => 0.5,
  });

  return {
    gateway,
    fake,
    breaker,
    usage,
    calls,
    sleeps,
    onFetch(next) {
      handler = next;
    },
    advance,

    async seedProvider(input: SeedProviderInput): Promise<ModelProvider> {
      const tenantId = input.tenantId ?? TENANT;

      let apiKeyRef: string | null = null;
      if (input.apiKey !== undefined) {
        const credential = await credentials.create({
          tenantId,
          label: `${input.slug ?? 'provider'} key`,
          kind: 'api_key',
          encrypted: vault.encrypt(input.apiKey),
          keyPrefix: VaultService.mask(input.apiKey),
        });
        apiKeyRef = credential.id;
      }

      return providers.create({
        tenantId,
        name: input.name ?? input.slug ?? 'provider',
        slug: input.slug ?? 'provider',
        type: input.type ?? 'openai',
        baseUrl: input.baseUrl ?? null,
        apiKeyRef,
      });
    },

    async seedModel(input: SeedModelInput): Promise<Model> {
      // Built as an anonymous object type rather than `Record<string, unknown>`:
      // Prisma's `InputJsonValue` is an index-signature type, and only an object-literal
      // type (not an interface, not a `Record`) gets an implicit index signature — so
      // this is what makes it assignable without a cast.
      const metadata = {
        ...(input.pricing === undefined
          ? {}
          : {
              pricing: {
                inputPer1kTokens: input.pricing.inputPer1kTokens,
                outputPer1kTokens: input.pricing.outputPer1kTokens,
              },
            }),
        ...(input.embeddingDimension === undefined
          ? {}
          : { embeddingDimension: input.embeddingDimension }),
        ...(input.structuredOutputMode === undefined
          ? {}
          : { structuredOutputMode: input.structuredOutputMode }),
      };

      return models.create({
        tenantId: input.tenantId ?? TENANT,
        providerId: input.providerId,
        name: input.name ?? input.externalModelId,
        externalModelId: input.externalModelId,
        type: input.type ?? 'chat',
        contextWindow: input.contextWindow ?? 128_000,
        maxOutputTokens: input.maxOutputTokens ?? 4_096,
        metadata,
        fallbackOf: input.fallbackOf ?? null,
      });
    },
  };
}

export const TEST_TENANT = TENANT;

/**
 * A `fetch` that records every call and delegates to `handler`.
 *
 * Shared by the adapter tests, which exercise an adapter directly rather than through
 * the gateway — a failure there must be attributable to the translation layer alone.
 */
export function recordingFetch(calls: FetchCall[], handler: FetchHandler): typeof globalThis.fetch {
  return (input, init) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }

    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = { __unparsed: init.body };
      }
    }

    const call: FetchCall = { url, method: init?.method ?? 'GET', headers, body };
    calls.push(call);
    return Promise.resolve(handler(call));
  };
}

/** An `AdapterContext` wired to a recording fetch, for direct adapter tests. */
export function adapterContext(
  calls: FetchCall[],
  handler: FetchHandler,
  overrides: Partial<AdapterContext> = {},
): AdapterContext {
  return {
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'sk-test-key',
    organizationId: null,
    projectId: null,
    extraHeaders: {},
    fetch: recordingFetch(calls, handler),
    ...overrides,
  };
}

/** A minimal but valid OpenAI chat-completion body. */
export function openAiChatBody(options: {
  content?: string;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
}): Record<string, unknown> {
  const promptTokens = options.promptTokens ?? 10;
  const completionTokens = options.completionTokens ?? 5;

  return {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    model: 'test-model',
    choices: [
      {
        index: 0,
        finish_reason: options.finishReason ?? 'stop',
        message: {
          role: 'assistant',
          content: options.content ?? 'hello',
          ...(options.toolCalls === undefined
            ? {}
            : {
                tool_calls: options.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.args },
                })),
              }),
        },
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

/** One OpenAI streaming frame carrying a text delta. */
export function openAiTextFrame(text: string): string {
  return `data: ${JSON.stringify({
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`;
}

export function openAiFinishFrame(reason = 'stop'): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`;
}

export function openAiUsageFrame(promptTokens: number, completionTokens: number): string {
  return `data: ${JSON.stringify({
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  })}\n\n`;
}

export const OPENAI_DONE = 'data: [DONE]\n\n';
