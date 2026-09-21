import { z } from 'zod';
import { MODEL_STATUSES, MODEL_TYPES, PROVIDER_TYPES } from '../types/providers.js';
import { httpUrl } from './url.js';

/**
 * Provider and model input schemas.
 *
 * Same conventions as the rest of `schemas/`: `.strict()` everywhere, nothing `.default()`-ed.
 * The defaults live in `ProviderService`, which can see context a schema cannot — and, more to
 * the point, a service is reachable from places a route schema is not (the container, a test,
 * a future seed script), so a default that only exists in the schema is a default that silently
 * does not apply on those paths.
 *
 * Four rules are specific to this file:
 *
 *  1. **`apiKey` is accepted, never returned.** It is write-only by construction: it appears on
 *     `createProviderSchema` and `updateProviderSchema` and on no response type in
 *     `types/providers.ts`. Its presence is what turns into a `Credential` row; after that the
 *     only trace is a masked prefix.
 *  2. **`baseUrl` is validated as a URL when present.** A provider with `baseUrl: "api.openai.com"`
 *     would build the request URL `api.openai.com/models`, which fails as a DNS error at probe
 *     time rather than as a 400 at write time — a much worse place to learn about a typo.
 *  3. **`type` is a closed enum.** The gateway routes by adapter lookup keyed on this string, so
 *     an unrecognised value is a provider that can never serve a request. Letting it through
 *     would create a row that is permanently, silently dead.
 *  4. **`google` (Gemini) has a dedicated adapter.** Its wire format (contents, parts,
 *     functionDeclarations) is structurally different from OpenAI, handled by `GoogleAdapter`.
 */

const id = z.string().trim().min(1);

/**
 * A query-string boolean.
 *
 * `z.coerce.boolean()` is wrong here for the same reason `schemas/memory.ts` documents: it is
 * `Boolean(value)`, so the *string* `'false'` becomes `true` — a filter that turns itself on
 * when the client explicitly turned it off.
 */
const queryBoolean = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

/**
 * A provider base URL.
 *
 * No trailing slash is required or forbidden — the health probe strips trailing slashes itself
 * rather than making the operator care.
 */
const baseUrl = httpUrl;

/**
 * The one-time plaintext key.
 *
 * Trimmed, because a pasted key very often arrives with a trailing newline and a key that is
 * *almost* right produces a 401 that looks like a permissions problem. Not length-checked
 * beyond a floor of 8: providers do not agree on key formats and a cleverer rule would reject a
 * legitimate one. The ceiling is there so a mistaken paste of a whole file is a 400 rather than
 * a vault row nobody can explain.
 */
const apiKey = z.string().trim().min(8).max(8192);

/**
 * A provider slug.
 *
 * Constrained to the shape that can appear in a URL path unescaped, because `slug` is the
 * human-readable handle an operator will use in conversation ("the openai provider") and the
 * tenant-unique index is on it.
 */
const slug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase letters, digits and hyphens');

/**
 * Adding a provider.
 *
 * `verify` is the switch that controls the probe-and-sync that follows a create. It is optional
 * and the service defaults it to "yes, when a key was supplied" — but the field exists because
 * a caller importing a list of providers should be able to skip a network round trip per row.
 *
 * The create **does not fail when the probe fails**. The row is real either way; the response
 * reports what the probe found. Failing the request would leave the operator with an error and
 * no way to see the provider they just added, and would make an unreachable vendor the same
 * outcome as an invalid request.
 */
export const createProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: slug.optional(),
    type: z.enum(PROVIDER_TYPES),
    baseUrl: baseUrl.nullable().optional(),
    /** Write-only. Never echoed back, never logged. */
    apiKey: apiKey.optional(),
    organizationId: z.string().trim().max(200).nullable().optional(),
    projectId: z.string().trim().max(200).nullable().optional(),
    capabilities: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    enabled: z.boolean().optional(),
    verify: z.boolean().optional(),
  })
  .strict();

/**
 * Editing a provider.
 *
 * `apiKey` here is a **rotation**, not an edit: the service writes a new `Credential` row and
 * repoints `apiKeyRef` at it, leaving the old row in place. Overwriting the ciphertext in place
 * would destroy the only record that a key ever existed, which is exactly what an incident
 * review needs.
 */
export const updateProviderSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    baseUrl: baseUrl.nullable().optional(),
    apiKey: apiKey.optional(),
    organizationId: z.string().trim().max(200).nullable().optional(),
    projectId: z.string().trim().max(200).nullable().optional(),
    capabilities: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    enabled: z.boolean().optional(),
    verify: z.boolean().optional(),
  })
  .strict();

export const listProvidersSchema = z
  .object({
    enabledOnly: queryBoolean,
    type: z.enum(PROVIDER_TYPES).optional(),
  })
  .strict();

/**
 * The model catalogue's filters.
 *
 * `providerId` is the one the spec names (`GET /api/models?providerId=`). `enabledOnly` defaults
 * to off in the service rather than on: an operator opening the Models page needs to see the
 * disabled rows too, or they cannot turn one back on.
 */
export const listModelsSchema = z
  .object({
    providerId: id.optional(),
    type: z.enum(MODEL_TYPES).optional(),
    status: z.enum(MODEL_STATUSES).optional(),
    enabledOnly: queryBoolean,
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/**
 * Editing a model.
 *
 * `status` is operator-settable because a sync will not notice that a vendor retired a model —
 * the vendor keeps listing it — and someone has to be able to mark it `deprecated` by hand.
 *
 * `fallbackOf` is nullable rather than optional-only: `null` means "detach this model from the
 * chain", which is a different instruction from omitting the field ("leave the chain alone").
 * A schema that could not express the difference would make a model impossible to un-chain.
 */
export const updateModelSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    status: z.enum(MODEL_STATUSES).optional(),
    capabilities: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    fallbackOf: id.nullable().optional(),
  })
  .strict();

export type CreateProviderInput = z.infer<typeof createProviderSchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderSchema>;
export type ListProvidersQuery = z.infer<typeof listProvidersSchema>;
export type ListModelsQuery = z.infer<typeof listModelsSchema>;
export type UpdateModelInput = z.infer<typeof updateModelSchema>;
