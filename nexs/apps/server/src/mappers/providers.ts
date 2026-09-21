import type { Credential, Model, ModelProvider } from '@prisma/client';
import type { ModelDetail, ModelSummary, ProviderDetail, ProviderSummary } from '@nexs/shared';

/**
 * Row → wire for providers and the model catalogue.
 *
 * ## The rule this file exists to enforce
 *
 * **A provider's key never crosses this boundary.** `ModelProvider.apiKeyRef` is a pointer into
 * the vault; the only thing derived from it that appears on the wire is `keyPrefix`, the masked
 * fragment the vault already stored when the credential was written. There is no `apiKey` field
 * on any output type, so a careless spread cannot produce one — the shape itself is the guard.
 *
 * Two smaller decisions are stated rather than left to be discovered:
 *
 *  - **`lastError` is lifted out of `metadata`, and `metadata` is not returned.** The repository
 *    stashes failure detail under `metadata.lastError` because this schema revision has no
 *    `lastError` column on `ModelProvider`. Returning the whole blob would put whatever an
 *    operator once wrote into `metadata` onto a page, and would let a future internal key leak
 *    into a public response the moment someone added one. Naming the single key with a meaning
 *    keeps the page's vocabulary closed.
 *  - **`hasCredential` is separate from `keyPrefix`.** A credential row can exist with an empty
 *    prefix, and "is there a key at all" is the question the page actually asks. Deriving it from
 *    a non-empty `keyPrefix` would answer a different one.
 */

function toIso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

/**
 * Read `metadata.lastError` without assuming the column holds an object.
 *
 * A Json column can hold anything — an array, a string, `null` — and this build has been
 * writing objects into it. A row written by something else must not make the provider list
 * throw, so an unrecognised shape reads as "no recorded error" rather than as a crash.
 */
function readLastError(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)['lastError'];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function toProviderSummary(row: ModelProvider, credential?: Credential | null): ProviderSummary {
  const hasCredential = row.apiKeyRef !== null && row.apiKeyRef.length > 0;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    status: row.status,
    // Masked, never the key. `null` when there is no credential row to read a prefix from.
    keyPrefix: credential?.keyPrefix ?? null,
    hasCredential,
    modelCount: row.modelCount,
    lastHealthCheck: toIso(row.lastHealthCheck),
    lastModelSync: toIso(row.lastModelSync),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toProviderDetail(row: ModelProvider, credential?: Credential | null): ProviderDetail {
  return {
    ...toProviderSummary(row, credential),
    organizationId: row.organizationId,
    projectId: row.projectId,
    capabilities: [...row.capabilities],
    lastError: readLastError(row.metadata),
  };
}

/**
 * A model, joined to its provider.
 *
 * The provider's name and type ride along because a catalogue row is meaningless without them —
 * "gpt-4o-2024-08-06" tells a reader nothing about where it is served from, and a client that had
 * to fetch the provider separately would either N+1 or show a bare id.
 */
export function toModelSummary(row: Model & { provider: ModelProvider }): ModelSummary {
  return {
    id: row.id,
    providerId: row.providerId,
    providerName: row.provider.name,
    providerType: row.provider.type,
    name: row.name,
    externalModelId: row.externalModelId,
    type: row.type,
    status: row.status,
    capabilities: [...row.capabilities],
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    fallbackOf: row.fallbackOf,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * A model plus its successors in the fallback chain.
 *
 * `fallbacks` reads in the same direction as the column: each entry names *this* model as its
 * `fallbackOf`, so it is something the gateway would try **after** this one fails. The repository
 * documents that direction at length because the opposite reading is the easy mistake, and a
 * detail view that rendered the chain backwards would be confidently wrong about failover order.
 */
export function toModelDetail(
  row: Model & { provider: ModelProvider },
  fallbacks: readonly Model[],
): ModelDetail {
  return {
    ...toModelSummary(row),
    fallbacks: fallbacks.map((model) => ({
      id: model.id,
      name: model.name,
      externalModelId: model.externalModelId,
      enabled: model.enabled,
    })),
  };
}
