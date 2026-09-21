import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type { SseFrame } from '@nexs/shared';
import {
  CONTROL_TENANT,
  OTHER_TENANT,
  createControlHarness,
  type ControlHarness,
} from './helpers/control-harness.js';
import { CredentialRepository } from '../src/repositories/credential.repo.js';
import { ModelProviderRepository } from '../src/repositories/model-provider.repo.js';
import { VaultService } from '../src/services/vault/vault.service.js';
import {
  ProviderHealthService,
  type FetchLike,
} from '../src/services/providers/provider-health.service.js';

/**
 * `provider.health` — what the ten-minute sweep actually measures.
 *
 * ## The claim under test is deliberately narrow
 *
 * The spec says "testConnection each enabled provider". There is no `testConnection` in the
 * gateway, and the only call the adapters expose is `chat` — so the obvious implementation is
 * a minimal completion per provider, which **spends the tenant's money** every ten minutes on
 * a schedule they did not ask for. This service probes *reachability* instead: a `GET` at the
 * provider's models endpoint, judged on the HTTP status.
 *
 * So the tests below assert the claim that is actually being made — "the provider answered",
 * "the credential was rejected", "the provider is not reachable" — and the one that is *not*
 * made, which is "this provider would answer a completion correctly". The distinction is the
 * whole reason this file exists, and a future change that quietly swapped the probe for a
 * billed call would have to delete a test that says so in its name.
 *
 * ## Why a rejected key is not `degraded`
 *
 * `degraded` means "reachable, but something is wrong" — a rate limit, a server error. A 401
 * is a credential that will not work for anything, which is a different problem with a
 * different fix. Collapsing the two would send an operator hunting a network fault when they
 * need to rotate a key.
 */

const logger = pino({ level: 'silent' });

/** At least 32 characters — what `VaultService` needs to derive a key from. */
const SIGNING_SECRET = 'provider-health-test-signing-secret-32+';

let harness: ControlHarness;

beforeEach(async () => {
  harness = await createControlHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

/** A fetch stub that answers with one status and records what it was asked. */
function respondingWith(status: number) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve({ ok: status >= 200 && status < 300, status } as Response);
  }) as unknown as FetchLike;
  return { fetchImpl, calls };
}

/** A fetch stub that rejects, as an unreachable host does. */
function failingWith(message: string) {
  const fetchImpl = (() => Promise.reject(new Error(message))) as unknown as FetchLike;
  return { fetchImpl };
}

async function seedProvider(input: {
  tenantId?: string;
  slug?: string;
  baseUrl?: string | null;
  credential?: 'valid' | 'none' | 'dangling' | 'corrupt';
  enabled?: boolean;
  type?: string;
}) {
  const tenantId = input.tenantId ?? CONTROL_TENANT;
  const vault = new VaultService(SIGNING_SECRET);
  const credentials = new CredentialRepository(harness.db);

  let apiKeyRef: string | null = null;
  if (input.credential === 'valid') {
    const credential = await credentials.create({
      tenantId,
      label: 'key',
      kind: 'api_key',
      encrypted: vault.encrypt('sk-live-secret'),
      keyPrefix: 'sk-live',
    });
    apiKeyRef = credential.id;
  } else if (input.credential === 'dangling') {
    // A reference to a credential that is not there — a row deleted out from under the
    // provider, which is a state the schema permits.
    apiKeyRef = 'cred_missing';
  } else if (input.credential === 'corrupt') {
    const credential = await credentials.create({
      tenantId,
      label: 'key',
      kind: 'api_key',
      // A ciphertext the vault will refuse: the master key was rotated and this row was not.
      encrypted: 'v1:not-base64:also-not-base64',
      keyPrefix: 'sk-live',
    });
    apiKeyRef = credential.id;
  }

  return harness.db.modelProvider.create({
    data: {
      tenantId,
      name: 'Provider',
      slug: input.slug ?? `p-${Math.random().toString(36).slice(2, 10)}`,
      type: input.type ?? 'openai',
      enabled: input.enabled ?? true,
      status: 'unknown',
      baseUrl: input.baseUrl === undefined ? 'https://api.example.test/v1' : input.baseUrl,
      apiKeyRef,
    },
  });
}

function buildService(
  overrides: { fetch?: FetchLike; resolveBaseUrl?: (type: string) => string | null } = {},
) {
  const frames: SseFrame[] = [];
  const service = new ProviderHealthService({
    providers: new ModelProviderRepository(harness.db),
    credentials: new CredentialRepository(harness.db),
    vault: new VaultService(SIGNING_SECRET),
    logger,
    emit: (_tenantId, frame) => frames.push(frame),
    ...(overrides.fetch === undefined ? {} : { fetch: overrides.fetch }),
    ...(overrides.resolveBaseUrl === undefined ? {} : { resolveBaseUrl: overrides.resolveBaseUrl }),
    timeoutMs: 1_000,
  });
  return { service, frames };
}

describe('provider health: what the probe measures', () => {
  it('reports healthy when the provider answers, and records the check on the row', async () => {
    const provider = await seedProvider({ credential: 'valid' });
    const { fetchImpl, calls } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    const check = await service.checkOne(provider);

    expect(check.status).toBe('healthy');
    expect(check.httpStatus).toBe(200);
    expect(check.reason).toBeNull();

    // Recorded, not merely returned: the dashboard reads the row, and a check that only
    // existed in a return value would leave the UI showing whatever it showed before.
    const stored = await new ModelProviderRepository(harness.db).findById(
      CONTROL_TENANT,
      provider.id,
    );
    expect(stored!.status).toBe('healthy');
    expect(stored!.lastHealthCheck).not.toBeNull();

    // A reachability probe, not a completion: one GET, and it is the models endpoint.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.example.test/v1/models');
  });

  it('sends the provider’s own decrypted key', async () => {
    const provider = await seedProvider({ credential: 'valid' });
    const { fetchImpl, calls } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    await service.checkOne(provider);

    // Without the key the probe measures only that the host is up, which is a different and
    // much weaker claim than "this provider is usable with this credential".
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-live-secret');
  });

  it('normalises a trailing slash rather than producing a doubled path', async () => {
    const provider = await seedProvider({ credential: 'valid', baseUrl: 'https://api.example.test/v1/' });
    const { fetchImpl, calls } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    await service.checkOne(provider);

    expect(calls[0]!.url).toBe('https://api.example.test/v1/models');
  });

  it('treats a rejected credential as an error, not as degraded', async () => {
    // The distinction is the point: a 401 needs a key rotated, not a network investigated.
    for (const status of [401, 403]) {
      const provider = await seedProvider({ credential: 'valid' });
      const { fetchImpl } = respondingWith(status);
      const { service } = buildService({ fetch: fetchImpl });

      const check = await service.checkOne(provider);

      expect(check.status).toBe('error');
      expect(check.httpStatus).toBe(status);
      expect(check.reason).toMatch(/rejected the credential/);
    }
  });

  it('treats a server error as degraded, because the provider was reached', async () => {
    const provider = await seedProvider({ credential: 'valid' });
    const { fetchImpl } = respondingWith(503);
    const { service } = buildService({ fetch: fetchImpl });

    const check = await service.checkOne(provider);

    expect(check.status).toBe('degraded');
    expect(check.httpStatus).toBe(503);
  });

  it('treats an unreachable provider as an error', async () => {
    const provider = await seedProvider({ credential: 'valid' });
    const { fetchImpl } = failingWith('getaddrinfo ENOTFOUND');
    const { service } = buildService({ fetch: fetchImpl });

    const check = await service.checkOne(provider);

    expect(check.status).toBe('error');
    expect(check.httpStatus).toBeNull();
    expect(check.reason).toMatch(/could not reach/);
  });
});

describe('provider health: what it refuses to guess at', () => {
  it('reports unverified, and probes nothing, when the provider has no baseUrl', async () => {
    // Inventing a default would mean guessing which vendor's URL belongs to a free-form
    // `type` string, and a wrong guess would report a healthy provider that does not exist.
    const provider = await seedProvider({ credential: 'valid', baseUrl: null });
    const { fetchImpl, calls } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    const check = await service.checkOne(provider);

    expect(check.status).toBe('unverified');
    expect(calls).toHaveLength(0);
    expect(check.reason).toMatch(/no baseUrl/);
  });

  it('reports unverified when the provider references no credential', async () => {
    const provider = await seedProvider({ credential: 'none' });
    const { fetchImpl, calls } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    const check = await service.checkOne(provider);

    expect(check.status).toBe('unverified');
    expect(calls).toHaveLength(0);
  });

  it('reports unverified when the credential it references is gone', async () => {
    // A dangling reference is a finding about that provider, not a reason to abort the sweep.
    const provider = await seedProvider({ credential: 'dangling' });
    const { fetchImpl, calls } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    const check = await service.checkOne(provider);

    expect(check.status).toBe('unverified');
    expect(calls).toHaveLength(0);
  });

  it('reports unverified when the credential cannot be decrypted', async () => {
    // A rotated master key or a corrupted row. The sweep continues: one unusable credential
    // must not stop every later provider from being checked.
    const provider = await seedProvider({ credential: 'corrupt' });
    const { fetchImpl } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    const check = await service.checkOne(provider);

    expect(check.status).toBe('unverified');
    expect(check.reason).toMatch(/no usable credential/);
  });
});

describe('provider health: the sweep', () => {
  it('checks every enabled provider and counts by outcome', async () => {
    await seedProvider({ credential: 'valid' });
    await seedProvider({ credential: 'valid' });
    await seedProvider({ credential: 'none' });
    const { fetchImpl } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    const result = await service.checkAll();

    expect(result.checked).toBe(3);
    expect(result.healthy).toBe(2);
    expect(result.unverified).toBe(1);
    expect(result.degraded).toBe(0);
    expect(result.error).toBe(0);
  });

  it('skips a disabled provider', async () => {
    await seedProvider({ credential: 'valid' });
    await seedProvider({ credential: 'valid', enabled: false });
    const { fetchImpl } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    expect((await service.checkAll()).checked).toBe(1);
  });

  it('spans tenants, because there is no request to derive one from', async () => {
    // The unscoped read. A sweep that only saw one workspace would leave every other
    // workspace's providers permanently at whatever status they were last left in.
    await seedProvider({ tenantId: CONTROL_TENANT, credential: 'valid' });
    await seedProvider({ tenantId: OTHER_TENANT, credential: 'valid' });
    const { fetchImpl } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    expect((await service.checkAll()).checked).toBe(2);
  });

  it('completes the sweep even when one provider is unreachable', async () => {
    // "Never throws" is the contract: an unreachable provider *is* the finding. Letting it
    // abort would leave every later provider unchecked, so one outage would blind the
    // dashboard to everything after it in the list.
    await seedProvider({ credential: 'valid' });
    await seedProvider({ credential: 'valid' });
    const { fetchImpl } = failingWith('ECONNREFUSED');
    const { service } = buildService({ fetch: fetchImpl });

    const result = await service.checkAll();

    expect(result.checked).toBe(2);
    expect(result.error).toBe(2);
  });

  it('emits a frame per provider, so a dashboard can react without polling', async () => {
    const provider = await seedProvider({ credential: 'valid' });
    const { fetchImpl } = respondingWith(200);
    const { service, frames } = buildService({ fetch: fetchImpl });

    await service.checkAll();

    const frame = frames.find((f) => f.name === 'provider.health');
    expect(frame).toBeDefined();
    expect(frame!.payload).toMatchObject({ providerId: provider.id, ok: true, status: 'healthy' });
  });

  it('is silent when there is nothing to check', async () => {
    const { fetchImpl, calls } = respondingWith(200);
    const { service, frames } = buildService({ fetch: fetchImpl });

    expect(await service.checkAll()).toEqual({
      checked: 0,
      healthy: 0,
      degraded: 0,
      error: 0,
      unverified: 0,
    });
    expect(calls).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });
});

describe('provider health: provider-aware probing', () => {
  it('falls back to resolved base URL when provider has no explicit baseUrl', async () => {
    const provider = await seedProvider({ credential: 'valid', baseUrl: null, type: 'google' });
    const { fetchImpl, calls } = respondingWith(200);
    const { service } = buildService({
      fetch: fetchImpl,
      resolveBaseUrl: (type) => (type === 'google' ? 'https://generativelanguage.googleapis.com/v1beta' : null),
    });

    const check = await service.checkOne(provider);

    expect(check.status).toBe('healthy');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
  });

  it('sends x-goog-api-key for google provider', async () => {
    const provider = await seedProvider({ credential: 'valid', baseUrl: 'https://gemini.test/v1beta', type: 'google' });
    const { fetchImpl, calls } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    const check = await service.checkOne(provider);

    expect(check.status).toBe('healthy');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-goog-api-key']).toBe('sk-live-secret');
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('sends x-api-key and anthropic-version for anthropic provider', async () => {
    const provider = await seedProvider({ credential: 'valid', baseUrl: 'https://anthropic.test/v1', type: 'anthropic' });
    const { fetchImpl, calls } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    const check = await service.checkOne(provider);

    expect(check.status).toBe('healthy');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-api-key']).toBe('sk-live-secret');
    expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('sends api-key for azure-openai provider', async () => {
    const provider = await seedProvider({ credential: 'valid', baseUrl: 'https://azure.test', type: 'azure-openai' });
    const { fetchImpl, calls } = respondingWith(200);
    const { service } = buildService({ fetch: fetchImpl });

    const check = await service.checkOne(provider);

    expect(check.status).toBe('healthy');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['api-key']).toBe('sk-live-secret');
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });
});
