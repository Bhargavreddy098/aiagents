import type { ModelProvider } from '@prisma/client';
import type { ModelProviderRepository } from '../../repositories/model-provider.repo.js';
import type { CredentialRepository } from '../../repositories/credential.repo.js';
import type { VaultService } from '../vault/vault.service.js';
import type { Logger } from '../../logger.js';
import type { EngineEmitter } from '../engine/execution-engine.js';

/**
 * `provider.health` — keep each provider's reachability current.
 *
 * ## What this measures, and what it deliberately does not
 *
 * The spec says "testConnection each enabled provider". There is no `testConnection` in the
 * gateway, and the only call the adapters expose is `chat` — so the obvious implementation
 * is a minimal completion per provider every ten minutes, which **spends the tenant's
 * money** on a schedule they did not ask for and cannot see. A health check that bills is
 * worse than no health check.
 *
 * So this probes **reachability**: a `GET` against the provider's models endpoint, with the
 * provider's own key, judged on the HTTP status. That distinguishes the thing the dashboard
 * actually needs to show — "this provider is unreachable", "this key is rejected", "this
 * provider is fine" — from the thing it cannot show without spending money, which is
 * "this provider would answer a completion correctly".
 *
 * The distinction is stated in the code and in `metadata.lastError` rather than implied,
 * because "healthy" on a dashboard is a claim and it should be the claim that was tested.
 *
 * ## Why a rejected key is `error` and not `degraded`
 *
 * `degraded` means "reachable, but something is wrong" — a rate limit, a slow response, a
 * provider that answered with a server error. A 401 or 403 means the credential will not
 * work for anything, which is a different problem with a different fix, and collapsing the
 * two would send an operator looking for a network fault when they need to rotate a key.
 */

export type FetchLike = typeof globalThis.fetch;

export interface ProviderHealthServiceDeps {
  providers: ModelProviderRepository;
  credentials: CredentialRepository;
  vault: VaultService;
  logger: Logger;
  emit?: EngineEmitter;
  fetch?: FetchLike;
  timeoutMs: number;
  now?: () => number;
  resolveBaseUrl?: (type: string) => string | null;
}

export interface ProviderHealthCheck {
  providerId: string;
  tenantId: string;
  status: 'healthy' | 'degraded' | 'error' | 'unverified';
  httpStatus: number | null;
  reason: string | null;
}

export interface ProviderHealthResult {
  checked: number;
  healthy: number;
  degraded: number;
  error: number;
  unverified: number;
}

export class ProviderHealthService {
  constructor(private readonly deps: ProviderHealthServiceDeps) {}

  /** Probe every enabled provider across every tenant. The cron's entry point. */
  async checkAll(): Promise<ProviderHealthResult> {
    const providers = await this.deps.providers.listAllEnabled();

    const result: ProviderHealthResult = {
      checked: 0,
      healthy: 0,
      degraded: 0,
      error: 0,
      unverified: 0,
    };

    for (const provider of providers) {
      const check = await this.checkOne(provider);
      result.checked += 1;
      result[check.status] += 1;
    }

    this.deps.logger.info({ ...result }, 'provider health sweep complete');
    return result;
  }

  /**
   * Probe one provider and record the outcome.
   *
   * Never throws: a provider that is unreachable is the finding, not an error, and letting
   * one bad provider abort the sweep would leave every later one unchecked.
   */
  async checkOne(provider: ModelProvider): Promise<ProviderHealthCheck> {
    const outcome = await this.probe(provider);

    await this.deps.providers.updateStatus(
      provider.tenantId,
      provider.id,
      outcome.status,
      outcome.reason ?? undefined,
    );

    this.deps.emit?.(provider.tenantId, {
      name: 'provider.health',
      payload: { providerId: provider.id, ok: outcome.status === 'healthy', status: outcome.status },
    });

    return {
      providerId: provider.id,
      tenantId: provider.tenantId,
      status: outcome.status,
      httpStatus: outcome.httpStatus,
      reason: outcome.reason,
    };
  }

  private async probe(provider: ModelProvider): Promise<{
    status: ProviderHealthCheck['status'];
    httpStatus: number | null;
    reason: string | null;
  }> {
    const effectiveBaseUrl =
      provider.baseUrl !== null && provider.baseUrl.trim().length > 0
        ? provider.baseUrl.trim()
        : (this.deps.resolveBaseUrl?.(provider.type) ?? null);

    if (effectiveBaseUrl === null || effectiveBaseUrl.length === 0) {
      // No base URL means there is nothing to probe. Reporting `unverified` rather than
      // guessing at a default is the honest answer: the default would belong to whichever
      // provider type this is, and the type is a free-form string in the schema.
      return {
        status: 'unverified',
        httpStatus: null,
        reason: 'the provider has no baseUrl, so there is nothing to probe',
      };
    }

    const apiKey = await this.resolveKey(provider);
    if (apiKey === null) {
      return {
        status: 'unverified',
        httpStatus: null,
        reason: 'the provider has no usable credential',
      };
    }

    const url = `${effectiveBaseUrl.replace(/\/+$/, '')}/models`;
    const fetchImpl = this.deps.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);

    const headers: Record<string, string> = {
      accept: 'application/json',
    };

    if (provider.type === 'google') {
      headers['x-goog-api-key'] = apiKey;
    } else if (provider.type === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (provider.type === 'azure-openai') {
      headers['api-key'] = apiKey;
    } else {
      headers['authorization'] = `Bearer ${apiKey}`;
    }

    if (provider.organizationId) {
      headers['openai-organization'] = provider.organizationId;
    }
    if (provider.projectId) {
      headers['openai-project'] = provider.projectId;
    }

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (response.ok) {
        return { status: 'healthy', httpStatus: response.status, reason: null };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          status: 'error',
          httpStatus: response.status,
          reason: `the provider rejected the credential (HTTP ${response.status})`,
        };
      }
      if (response.status === 400 && typeof response.text === 'function') {
        const text = await response.text().catch(() => '');
        if (
          text.toLowerCase().includes('api key') ||
          text.toLowerCase().includes('credential')
        ) {
          return {
            status: 'error',
            httpStatus: response.status,
            reason: `the provider rejected the credential (HTTP ${response.status})`,
          };
        }
      }
      return {
        status: 'degraded',
        httpStatus: response.status,
        reason: `the provider answered HTTP ${response.status}`,
      };
    } catch (err) {
      // A timeout and a DNS failure are the same finding from here — the provider could not
      // be reached — and the message says which happened.
      const reason = err instanceof Error ? err.message : String(err);
      return { status: 'error', httpStatus: null, reason: `could not reach the provider: ${reason}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The provider's plaintext key, or null when there is none to use.
   *
   * The decrypted value is held only for the length of the request and never logged. A
   * decryption failure is reported as "no usable credential" rather than rethrown: a
   * credential that cannot be decrypted (a rotated master key, a corrupted row) is a finding
   * about that provider, not a reason to abort the sweep.
   */
  private async resolveKey(provider: ModelProvider): Promise<string | null> {
    if (provider.apiKeyRef === null || provider.apiKeyRef.length === 0) return null;

    const credential = await this.deps.credentials.findById(provider.tenantId, provider.apiKeyRef);
    if (credential === null) {
      this.deps.logger.warn(
        { providerId: provider.id, credentialId: provider.apiKeyRef },
        'provider references a credential that does not exist',
      );
      return null;
    }

    try {
      return this.deps.vault.decrypt(credential.encrypted);
    } catch (err) {
      this.deps.logger.error(
        { providerId: provider.id, credentialId: credential.id, err: describe(err) },
        'provider credential could not be decrypted',
      );
      return null;
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
