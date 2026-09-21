import { ApiError, type CreateProviderInput, type ListProvidersQuery, type ProviderDetail, type ProviderSyncResult, type ProviderTestResult, type UpdateProviderInput } from '@nexs/shared';
import type { CredentialRepository } from '../../repositories/credential.repo.js';
import type { ModelProviderRepository } from '../../repositories/model-provider.repo.js';
import type { ModelRepository } from '../../repositories/model.repo.js';
import type { Logger } from '../../logger.js';
import type { VaultService } from '../vault/vault.service.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import type { ProviderHealthService } from './provider-health.service.js';
import type { EngineEmitter } from '../engine/execution-engine.js';
import { isUniqueViolation } from '../../db-errors.js';
import { toProviderDetail, toProviderSummary } from '../../mappers/providers.js';

/**
 * `/api/providers` — the door an operator uses to give the system a key.
 *
 * ## The three rules this service enforces
 *
 * **1. A key goes in once and never comes out.** `create` and `update` accept `apiKey`; nothing
 * returns it. It is encrypted by the vault and stored as a `Credential` row, and the provider
 * row keeps only `apiKeyRef`. A rotation writes a *new* credential and repoints the reference,
 * leaving the old row in place — overwriting the ciphertext would destroy the only record that
 * a key ever existed, which is exactly what an incident review needs to see.
 *
 * **2. A provider type with no adapter is refused at creation.** `ModelGateway.canRoute` is the
 * check, and it is here rather than in the schema because the registry is a runtime fact: the
 * schema knows the vocabulary, the gateway knows the capability. Letting one through would create
 * a row that lists, accepts a key, and fails every request — a failure an operator would
 * reasonably read as "my key is wrong".
 *
 * **3. A probe failing is not a create failing.** `create` returns the row *and* the outcome of
 * the verification it ran. A vendor that is briefly unreachable must not leave the operator with
 * an error and no provider to look at; the row is real either way, and the response says which
 * parts of the verification succeeded. This is the same "warn and degrade" rule the search
 * provider seam follows — refusing to make progress over a half-configured optional integration
 * trades a missing feature for a blocked operator.
 *
 * ## Why sync lives here rather than in a model service
 *
 * A sync is triggered by, scoped to, and reported against one provider. It writes `Model` rows,
 * which is the only reason this file touches `ModelRepository` at all — and the direction is
 * one-way: the model catalogue service reads models and never writes a provider.
 */

export interface ProviderServiceDeps {
  providers: ModelProviderRepository;
  credentials: CredentialRepository;
  models: ModelRepository;
  vault: VaultService;
  gateway: ModelGateway;
  health: ProviderHealthService;
  logger: Logger;
  emit?: EngineEmitter;
}

/**
 * The masked form of a key, e.g. `sk-a…wxyz`.
 *
 * The ellipsis is a single character and the fragment is short on purpose: this is rendered on a
 * page and is meant to let someone recognise *which* key is installed, not to be a fingerprint.
 * A key shorter than twelve characters is masked entirely rather than having most of itself
 * shown — the shorter a key is, the more of it a prefix/suffix would give away.
 */
export function maskKey(plain: string): string {
  if (plain.length < 12) return '…';
  return `${plain.slice(0, 4)}…${plain.slice(-4)}`;
}

/**
 * A URL-safe slug derived from a display name.
 *
 * Used only when the caller does not supply one. Non-ASCII names reduce to whatever ASCII
 * survives — which can be nothing, hence the `provider` fallback — and the tenant-unique index
 * turns a collision into a `CONFLICT` rather than a silent second row.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : 'provider';
}

export class ProviderService {
  constructor(private readonly deps: ProviderServiceDeps) {}

  async list(tenantId: string, query: ListProvidersQuery) {
    const [rows, credentials] = await Promise.all([
      this.deps.providers.list(tenantId, { enabledOnly: query.enabledOnly === true }),
      // One query for every credential in the tenant, then an in-memory join. Fetching per
      // provider would be an N+1 on the page an operator opens most often.
      this.deps.credentials.list(tenantId),
    ]);

    const byId = new Map(credentials.map((credential) => [credential.id, credential]));

    return rows
      .filter((row) => query.type === undefined || row.type === query.type)
      .map((row) => toProviderSummary(row, row.apiKeyRef === null ? null : (byId.get(row.apiKeyRef) ?? null)));
  }

  async get(tenantId: string, id: string): Promise<ProviderDetail> {
    const provider = await this.requireProvider(tenantId, id);
    const credential =
      provider.apiKeyRef === null ? null : await this.deps.credentials.findById(tenantId, provider.apiKeyRef);
    return toProviderDetail(provider, credential);
  }

  /**
   * Add a provider, optionally verifying it.
   *
   * The order matters: the credential is written first, so a failure creating the provider row
   * leaves an orphaned credential (recoverable, and invisible) rather than a provider pointing at
   * a credential that does not exist (which makes every request throw `ENCRYPTION_ERROR`).
   */
  async create(
    tenantId: string,
    input: CreateProviderInput,
  ): Promise<{ provider: ProviderDetail; test: ProviderTestResult | null; sync: ProviderSyncResult | null }> {
    if (!this.deps.gateway.canRoute(input.type)) {
      throw new ApiError(
        'UNSUPPORTED_CAPABILITY',
        `No adapter is registered for provider type "${input.type}"`,
        { providerType: input.type },
      );
    }

    const slug = input.slug ?? slugify(input.name);
    if ((await this.deps.providers.findBySlug(tenantId, slug)) !== null) {
      throw new ApiError('CONFLICT', `A provider with the slug "${slug}" already exists`, { slug });
    }

    const apiKeyRef = await this.storeKey(tenantId, input.name, input.apiKey);

    let provider;
    try {
      provider = await this.deps.providers.create({
        tenantId,
        name: input.name,
        slug,
        type: input.type,
        baseUrl: input.baseUrl ?? null,
        apiKeyRef,
        organizationId: input.organizationId ?? null,
        projectId: input.projectId ?? null,
        ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
        // `enabled` is optional in the schema and defaults to true on the column, so an absent
        // value is left to the database rather than restated here.
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      });
    } catch (err) {
      if (isUniqueViolation(err, 'slug')) {
        throw new ApiError('CONFLICT', `A provider with the slug "${slug}" already exists`, { slug });
      }
      throw err;
    }

    const credential = apiKeyRef === null ? null : await this.deps.credentials.findById(tenantId, apiKeyRef);

    // Default: verify when a key was supplied. A provider added without one has nothing to probe
    // and would come back `unverified` on every create, which is noise rather than information.
    const shouldVerify = input.verify ?? apiKeyRef !== null;

    let test: ProviderTestResult | null = null;
    let sync: ProviderSyncResult | null = null;

    if (shouldVerify) {
      test = await this.test(tenantId, provider.id);
      if (test.status === 'healthy') {
        sync = await this.sync(tenantId, provider.id);
      }
    }

    // Re-read: `test` and `sync` both write to the row (status, lastHealthCheck, modelCount), and
    // returning the pre-verification copy would describe a state the same call had already moved
    // past. The response has to describe the row as it is now.
    const fresh = await this.requireProvider(tenantId, provider.id);
    return { provider: toProviderDetail(fresh, credential), test, sync };
  }

  async update(tenantId: string, id: string, input: UpdateProviderInput): Promise<ProviderDetail> {
    const provider = await this.requireProvider(tenantId, id);

    // `apiKey` is a rotation, not a field write. See the class header.
    let apiKeyRef: string | null | undefined;
    if (input.apiKey !== undefined) {
      apiKeyRef = await this.storeKey(tenantId, provider.name, input.apiKey);
    }

    const count = await this.deps.providers.update(tenantId, id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
    });

    if (count !== 1) {
      throw new ApiError('NOT_FOUND', 'Provider not found', { providerId: id });
    }

    return this.get(tenantId, id);
  }

  /**
   * Remove a provider.
   *
   * Refuses while the catalogue still holds models. `Model.provider` is a required relation with
   * the default `Restrict` behaviour, so the delete would otherwise fail as a raw foreign-key
   * violation and surface as a 500 — and, worse, a cascade would take every `Model` row with it,
   * including the ones agents are pinned to. Disabling the provider is the reversible operation
   * and the error says so.
   */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.requireProvider(tenantId, id);

    const modelCount = await this.deps.models.countForProvider(tenantId, id);
    if (modelCount > 0) {
      throw new ApiError(
        'CONFLICT',
        `This provider still has ${modelCount} models in the catalogue. Disable it instead of deleting it, or delete its models first.`,
        { providerId: id, modelCount },
      );
    }

    const count = await this.deps.providers.delete(tenantId, id);
    if (count !== 1) {
      throw new ApiError('NOT_FOUND', 'Provider not found', { providerId: id });
    }

    // The credential is deliberately left behind. It is the record that a key existed, it is
    // referenced by nothing now, and an operator re-adding the provider can be pointed at it.
    // Deleting it here would destroy evidence for no benefit.
  }

  /**
   * Probe one provider.
   *
   * Delegated to `ProviderHealthService` rather than reimplemented, so the manual button and the
   * ten-minute sweep answer the same question the same way — including the deliberate choice to
   * probe reachability rather than spend the tenant's money on a test completion.
   */
  async test(tenantId: string, id: string): Promise<ProviderTestResult> {
    const provider = await this.requireProvider(tenantId, id);
    const check = await this.deps.health.checkOne(provider);

    return {
      providerId: check.providerId,
      status: check.status,
      httpStatus: check.httpStatus,
      reason: check.reason,
    };
  }

  /**
   * Read the provider's catalogue and add whatever is new.
   *
   * Additive by design — see `ProviderSyncResult` for why overwriting would revert operator
   * corrections.
   *
   * ## The one warning this can honestly raise
   *
   * The adapters drop catalogue entries with no usable id, because an entry with no id cannot be
   * addressed on the wire and a row built from it would be a model that can never be called. That
   * means the service never learns *how many* were dropped, and inventing a number for the
   * response would be worse than not reporting it.
   *
   * What the service can see is an empty result, and that is the finding worth surfacing: a
   * provider that answered successfully with no models almost always means a wrong `baseUrl` or a
   * key without list permission. Silence there would render as "this provider has no models",
   * which is a claim the sync is not in a position to make.
   */
  async sync(tenantId: string, id: string): Promise<ProviderSyncResult> {
    const provider = await this.requireProvider(tenantId, id);

    const discovered = await this.deps.gateway.discoverModels(tenantId, id);

    let created = 0;

    for (const model of discovered) {
      const isNew = await this.deps.models.createIfAbsent({
        tenantId,
        providerId: id,
        name: model.displayName ?? model.externalId,
        externalModelId: model.externalId,
        type: model.type ?? 'chat',
        // No capabilities are recorded, and no context window. The catalogue endpoint does not
        // state either, and a guess here would look like a fact on the Models page. The spec's
        // rule is to default conservatively and let the operator edit.
        capabilities: [],
      });

      if (isNew) created += 1;
    }

    const total = await this.deps.models.countForProvider(tenantId, id);
    await this.deps.providers.setModelCount(tenantId, id, total);

    this.deps.emit?.(tenantId, { name: 'provider.synced', payload: { providerId: id, modelCount: total } });

    this.deps.logger.info(
      { providerId: id, providerType: provider.type, discovered: discovered.length, created, total },
      'provider catalogue synced',
    );

    return {
      providerId: id,
      created,
      existing: discovered.length - created,
      total,
      warning:
        discovered.length === 0
          ? 'the provider answered with an empty catalogue — check its base URL and that the key may list models'
          : null,
    };
  }

  /**
   * Encrypt a key and store it, returning the credential id.
   *
   * Returns `null` for an absent key rather than creating an empty credential — a credential row
   * with no usable plaintext is indistinguishable from a broken one, and the provider would
   * report `unverified` for a reason that does not exist.
   */
  private async storeKey(tenantId: string, label: string, apiKey: string | undefined): Promise<string | null> {
    if (apiKey === undefined) return null;

    const credential = await this.deps.credentials.create({
      tenantId,
      label: `${label} API key`,
      kind: 'api_key',
      encrypted: this.deps.vault.encrypt(apiKey),
      keyPrefix: maskKey(apiKey),
    });

    return credential.id;
  }

  private async requireProvider(tenantId: string, id: string) {
    const provider = await this.deps.providers.findById(tenantId, id);
    if (provider === null) {
      throw new ApiError('NOT_FOUND', 'Provider not found', { providerId: id });
    }
    return provider;
  }
}
