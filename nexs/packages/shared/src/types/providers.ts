/**
 * The provider and model surfaces, as the UI sees them.
 *
 * These are **view** shapes, not row shapes. Three rules shape them, and all three exist
 * because of what the alternative would let the screen say:
 *
 *  1. **No shape here can carry a plaintext key, because no shape here carries a key at all.**
 *     A provider row holds `apiKeyRef` — a pointer into the vault — and the only thing derived
 *     from it that crosses this boundary is `keyPrefix`, the masked fragment the vault already
 *     stored when the credential was written. There is deliberately no `apiKey` field for a
 *     careless mapper to fill.
 *  2. **`lastError` is surfaced as its own field rather than by exposing `metadata`.** The
 *     repository stashes provider failure detail under `metadata.lastError` because the schema
 *     revision has no `lastError` column. Returning the whole blob would put whatever an
 *     operator once wrote into `metadata` onto a page; naming the one key that has a meaning
 *     keeps the page's vocabulary closed.
 *  3. **Health is reported as the stored reading plus the moment it was taken.** A provider's
 *     `status` is written by the `provider.health` sweep, not computed on read — so a client
 *     that rendered it without `lastHealthCheck` would be showing a stale fact as a live one.
 */

/** The provider kinds the gateway can actually route to. */
export const PROVIDER_TYPES = [
  'openai',
  'azure-openai',
  'anthropic',
  'google',
  'groq',
  'mistral',
  'deepseek',
  'xai',
  'together',
  'openrouter',
  'openai-compatible',
  'local',
  'ollama',
] as const;

export type ProviderTypeName = (typeof PROVIDER_TYPES)[number];

/**
 * The stored health reading.
 *
 * `unverified` is a real state and not a synonym for "down": it means the sweep could not
 * form an opinion — no `baseUrl` to probe, or no usable credential — and collapsing it into
 * `error` would send an operator chasing a network fault that does not exist.
 */
export const PROVIDER_STATUSES = ['unverified', 'healthy', 'degraded', 'error'] as const;
export type ProviderStatusName = (typeof PROVIDER_STATUSES)[number];

export const MODEL_TYPES = ['chat', 'embedding', 'image'] as const;
export type ModelTypeName = (typeof MODEL_TYPES)[number];

export const MODEL_STATUSES = ['available', 'unavailable', 'deprecated'] as const;
export type ModelStatusName = (typeof MODEL_STATUSES)[number];

/**
 * A provider, without its credential.
 *
 * `keyPrefix` is the masked fragment (the schema's `Credential.keyPrefix`, e.g. `sk-a…wxyz`);
 * `hasCredential` is separate from it because a credential row can exist with an empty prefix,
 * and "is there a key at all" is the question the page actually asks.
 */
export interface ProviderSummary {
  id: string;
  name: string;
  slug: string;
  type: string;
  baseUrl: string | null;
  enabled: boolean;
  status: string;
  /** Masked, never the key. `null` when the provider has no credential. */
  keyPrefix: string | null;
  hasCredential: boolean;
  /** How many `Model` rows the last sync left behind — a stored count, not a live one. */
  modelCount: number;
  lastHealthCheck: string | null;
  lastModelSync: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One provider, in full. Everything on `ProviderSummary` plus the detail the edit form needs. */
export interface ProviderDetail extends ProviderSummary {
  organizationId: string | null;
  projectId: string | null;
  capabilities: string[];
  /** Extracted from `metadata.lastError`; the rest of `metadata` is not exposed. */
  lastError: string | null;
}

/**
 * The outcome of `POST /api/providers/:id/test`.
 *
 * `httpStatus` is carried alongside `status` so the page can distinguish "the key was rejected"
 * from "the host did not answer" — the two have different fixes and the same red dot.
 */
export interface ProviderTestResult {
  providerId: string;
  status: ProviderStatusName;
  httpStatus: number | null;
  reason: string | null;
}

/**
 * The outcome of `POST /api/providers/:id/sync`.
 *
 * ## Why a sync creates and never overwrites
 *
 * The obvious implementation refreshes every discovered model's `name` and `type` on each run.
 * That would silently revert every correction an operator made — and corrections are *expected*
 * here, because the discovered type is a guess from the model's id (see `guessModelType`). An
 * operator who fixes `text-embedding-3-small` back to `embedding` would have it undone by the
 * next sync, with nothing on screen to say why. A sync that quietly reverts a fix is a wrong
 * number on a page, which the honesty rule forbids.
 *
 * So the sync is **additive**: it creates rows for models it has not seen, reports the ones it
 * already knew, and writes nothing else. `existing` is therefore not "rows I updated" — it is
 * "rows I deliberately left alone", which is the more useful thing to show.
 *
 * `total` is read back from the catalogue after the sync rather than computed as
 * `created + existing`, so the number on screen traces to a real count of rows.
 */
export interface ProviderSyncResult {
  providerId: string;
  created: number;
  /** Rows that were already in the catalogue and were left untouched. */
  existing: number;
  /** The catalogue's size after the sync — a real count, not a sum of the two above. */
  total: number;
  /** Non-null when the sync was partial: the vendor answered, but some entries were unusable. */
  warning: string | null;
}

/**
 * A model in the catalogue.
 *
 * `externalModelId` is the *exact* provider-side id and is the thing that gets sent on the wire;
 * `name` is only a label. A page that showed one without the other would make it impossible to
 * tell why a request 404s after someone renamed a row.
 */
export interface ModelSummary {
  id: string;
  providerId: string;
  providerName: string;
  providerType: string;
  name: string;
  externalModelId: string;
  type: string;
  status: string;
  capabilities: string[];
  contextWindow: number | null;
  maxOutputTokens: number | null;
  fallbackOf: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * One model, plus the chain it participates in.
 *
 * `fallbacks` reads in the same direction as the column: each entry is a model that names this
 * one as `fallbackOf`, i.e. a thing the gateway would try *after* this model fails. Presenting
 * it the other way round is the single easiest way to render a fallback chain backwards.
 */
export interface ModelDetail extends ModelSummary {
  fallbacks: Array<{ id: string; name: string; externalModelId: string; enabled: boolean }>;
}
