/**
 * Connector request schemas.
 *
 * The shape of this file is driven by one question: **which of these fields is a secret, and what
 * happens if it comes back?** `token` appears in create, update and account creation, and is
 * absent from every response schema in `types/connectors.ts`. It is write-only in the strict
 * sense — there is no read path, so there is no route to accidentally widen later.
 */

import { z } from 'zod';
import { TOOL_CAPABILITIES } from '../types/tools.js';
import { CONNECTOR_TYPES } from '../types/connectors.js';
import { httpUrl } from './url.js';

const token = z
  .string()
  .trim()
  .min(8, 'a token shorter than 8 characters is a mistake, not a credential')
  .max(8192);

const name = z.string().trim().min(1).max(120);

const capabilityList = z.array(z.enum(TOOL_CAPABILITIES)).max(12);

/**
 * One action the `rest` adapter can perform.
 *
 * `method` is a closed enum and `path` is a relative path, not a URL. Both restrictions are
 * deliberate: the adapter joins `path` onto the connector's `baseUrl`, so an absolute `path` would
 * be a way to make a connector call a host the tenant never configured. Rejecting it here means
 * the containment rule lives in the schema rather than in a string check someone can forget.
 *
 * `capabilities` is optional and defaults to the safe reading — see the adapter for why an
 * omitted set resolves to `external_side_effect` rather than `read_only`.
 */
const restAction = z
  .object({
    action: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.-]+$/, 'an action name is an identifier, not a sentence'),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).nullable().optional(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^\//, 'a path is relative to the connector base URL and must start with "/"')
      .refine((value) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(value), 'a path must not be an absolute URL'),
    /**
     * A JSON Schema for the action's arguments.
     *
     * Optional, and the fallback is honest rather than empty: the adapter derives a minimal schema
     * from the `{placeholders}` in `path`, because those names are the only arguments it can
     * *prove* the action needs. Declaring one here replaces that guess verbatim.
     */
    inputSchema: z.record(z.unknown()).optional(),
    capabilities: capabilityList.optional(),
  })
  .strict();

/**
 * Adapter configuration, kept in `Connector.metadata`.
 *
 * One object rather than a discriminated union keyed on `type`, because the fields are genuinely
 * independent: a GitHub Enterprise connector wants a `baseUrl` and no actions, a `rest` connector
 * wants both. A union would force every future adapter to add a member to a schema it does not
 * otherwise touch.
 */
const connectorConfig = z
  .object({
    baseUrl: httpUrl.optional(),
    actions: z.array(restAction).max(200).optional(),
    /**
     * Which header carries the credential, and with what scheme prefix.
     *
     * ## Why this is not a `headers` map
     *
     * The obvious design — let a tenant declare arbitrary request headers — was written first and
     * removed, because `Connector.metadata` is **plaintext JSON**. `McpServer` can hold a header
     * map safely: it has a column whose contents are vault-encrypted, and the read path exposes
     * only the names. A connector has no such column, so a header map here would put an API key
     * into a plaintext column that the detail endpoint returns. Adding an encrypted column is a
     * migration for a feature nothing needs yet.
     *
     * What *is* needed is the ability to reach APIs that do not speak `Authorization: Bearer` —
     * `X-Api-Key`, a bare token, a custom scheme. These two fields cover that without a secret ever
     * leaving the vault, because the credential itself stays in `Credential.encrypted` and these
     * only say where to put it.
     */
    authHeader: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9-]+$/, 'a header name is letters, digits and hyphens')
      .optional(),
    /**
     * The prefix before the token. Defaults to `Bearer`.
     *
     * An empty string is meaningful and allowed — it sends the bare token, which is what
     * `X-Api-Key` style APIs expect. It is not the same as omitting the field, which means "use the
     * default".
     */
    authScheme: z.string().trim().max(40).optional(),
  })
  .strict();

export const createConnectorSchema = z
  .object({
    type: z.enum(CONNECTOR_TYPES),
    name,
    /** The credential. Optional at create time so a connector row can exist before it is usable. */
    token: token.optional(),
    config: connectorConfig.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A `rest` connector with no base URL has nowhere to send anything, and discovery would
    // report zero capabilities with `ok: true` — a success that means "misconfigured".
    if (value.type === 'rest' && value.config?.baseUrl === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'baseUrl'],
        message: 'a rest connector needs a base URL',
      });
    }
    // Same reasoning: a REST connector with no declared actions is a name and a URL.
    if (value.type === 'rest' && (value.config?.actions?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['config', 'actions'],
        message: 'a rest connector needs at least one action, or it has nothing to do',
      });
    }
  });

/**
 * Edit a connector.
 *
 * `type` is absent, for the same reason `transport` is absent from `updateMcpServerSchema`: a
 * `rest` connector and a `github` one share no configuration at all, so a PATCH that switched
 * types would have to guess which fields to clear. Deleting and re-adding is the honest operation.
 *
 * A present `token` is a **rotation**, not an edit — it writes a new vault entry and leaves the old
 * one in place, because the old entry is the record of what was in use.
 */
export const updateConnectorSchema = z
  .object({
    name: name.optional(),
    token: token.optional(),
    config: connectorConfig.optional(),
  })
  .strict();

export const listConnectorsSchema = z
  .object({
    type: z.enum(CONNECTOR_TYPES).optional(),
    status: z.enum(['connected', 'disconnected', 'error']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

/**
 * Attach an account to a connector.
 *
 * `token` is optional: an account may reuse the connector's own credential — the common case for a
 * single-tenant integration — in which case it inherits `credentialId` and no second vault entry is
 * written. Supplying one creates an account-specific entry, which is how two GitHub logins live on
 * one connector.
 */
export const createConnectorAccountSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    accountId: z.string().trim().min(1).max(200).nullable().optional(),
    token: token.optional(),
    scopes: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  })
  .strict();

export const listConnectorAccountsSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type CreateConnectorInput = z.infer<typeof createConnectorSchema>;
export type UpdateConnectorInput = z.infer<typeof updateConnectorSchema>;
export type ListConnectorsQuery = z.infer<typeof listConnectorsSchema>;
export type CreateConnectorAccountInput = z.infer<typeof createConnectorAccountSchema>;
export type ListConnectorAccountsQuery = z.infer<typeof listConnectorAccountsSchema>;
export type RestActionInput = z.infer<typeof restAction>;
export type ConnectorConfigInput = z.infer<typeof connectorConfig>;
