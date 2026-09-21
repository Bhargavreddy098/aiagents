/**
 * Connectors, as the UI sees them.
 *
 * A connector is a *service the tenant has authorised* — GitHub, a generic REST endpoint, a
 * webhook receiver. It is deliberately not an MCP server: MCP is a protocol a server speaks, and
 * a connector is a vendor's API plus the credentials to call it. Both funnel into the same
 * canonical `Tool` rows, which is why an agent cannot tell them apart and does not need to.
 *
 * Two rules shape this file, and both are about not leaking a secret.
 *
 * **No shape here can carry a credential.** An account reports `hasCredential`, never the token,
 * and never the `credentialId` — the id is a handle into the vault, and handing it out invites a
 * caller to go looking for a second endpoint that will decrypt it.
 *
 * **`lastError` is lifted out of `metadata` rather than exposing `metadata`.** The same decision
 * as `ProviderDetail`: the metadata blob holds whatever the adapter needed to remember, and a page
 * that rendered it wholesale would eventually render something it should not.
 */

// ── vocabularies ──────────────────────────────────────────────────────────────

/**
 * The connector types the framework ships adapters for.
 *
 * `rest` is the important one. It is config-driven — the tenant declares its own base URL and
 * action list — and its existence is the proof that the connector framework is not a set of
 * hard-coded vendor integrations wearing a common interface. `github` is the second, and it is
 * the one the spec's acceptance criterion names.
 */
export const CONNECTOR_TYPES = [
  'rest',
  'webhook',
  'github',
  'slack',
  'gmail',
  'google_calendar',
  'notion',
  'drive',
] as const;

export type ConnectorTypeName = (typeof CONNECTOR_TYPES)[number];

/** Connector-level status. Mirrors `Connector.status`. */
export const CONNECTOR_STATUSES = ['connected', 'disconnected', 'error'] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/** Per-account status. One connector can hold several accounts, each independently revoked. */
export const CONNECTOR_ACCOUNT_STATUSES = ['active', 'revoked', 'error'] as const;
export type ConnectorAccountStatus = (typeof CONNECTOR_ACCOUNT_STATUSES)[number];

// ── accounts ──────────────────────────────────────────────────────────────────

/**
 * One authorised account on a connector.
 *
 * `accountId` is the *remote* identity — a GitHub login, a Slack team id — and is what makes
 * "which account will this run as" answerable. It is null until a probe has told us, which is a
 * real state and not an error: an account can be stored before the vendor is reachable.
 */
export interface ConnectorAccountSummary {
  id: string;
  connectorId: string;
  label: string;
  accountId: string | null;
  scopes: string[];
  status: string;
  /**
   * Whether a vault entry is attached — not which one, and certainly not what is in it.
   *
   * A boolean rather than the id, because the id is a handle. `ConnectorAccount.credentialId` is
   * a nullable column and this is the only fact about it the UI has any use for.
   */
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── capabilities ──────────────────────────────────────────────────────────────

/**
 * One action a connector can perform.
 *
 * This is what discovery produces, and it is stored verbatim in `Connector.capabilityDiscovery`
 * because it is *the provider's advertisement* — evidence, not configuration. Re-running discovery
 * overwrites it, which is the point: an action the vendor withdrew must stop being claimed.
 *
 * `capabilities` is the side-effect vocabulary from §3.6 (`read_only`, `external_side_effect`, …)
 * and it travels with the capability because only the adapter knows whether `create_issue` writes
 * anything. The canonical `Tool` row inherits it, which is what puts the action under the approval
 * policy without anyone maintaining a second list.
 */
export interface ConnectorCapability {
  /** The action name the adapter dispatches on. Stable; never derived from `name`. */
  action: string;
  /** Human label for the picker. */
  name: string;
  description: string | null;
  /** Raw JSON Schema for the action's arguments, passed through unchanged. */
  inputSchema: unknown;
  capabilities: string[];
  /**
   * The canonical `Tool` row this capability is registered as, or null if discovery has not run.
   *
   * Resolved by joining the connector's `Tool` rows on the adapter's `action` — not stored, so it
   * cannot drift out of agreement with the rows it claims to point at.
   */
  toolId: string | null;
}

// ── connectors ────────────────────────────────────────────────────────────────

export interface ConnectorSummary {
  id: string;
  type: string;
  name: string;
  status: string;
  accountCount: number;
  /** How many capabilities the last discovery recorded. Zero means discovery has not run. */
  capabilityCount: number;
  /** The stored failure reason, lifted out of `metadata`. Null when the last operation worked. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One connector, with its accounts and everything the last discovery found.
 *
 * Accounts are inlined rather than paginated because a connector with enough accounts to need
 * pagination is a connector nobody has. Capabilities are inlined for the same reason, and because
 * the add-connector flow renders them immediately after discovery.
 */
export interface ConnectorDetail extends ConnectorSummary {
  capabilities: ConnectorCapability[];
  accounts: ConnectorAccountSummary[];
}

/**
 * The outcome of `POST /api/connectors/:id/test`.
 *
 * `ok` describes the *probe*, and a failed probe is still a `200` — the request was performed and
 * its answer is "this connector does not work". That is the same distinction `ProviderTestResult`
 * draws, and it matters here for the same reason: an operator testing a connector they suspect is
 * broken must get the diagnosis, not a transport error about the diagnosis.
 */
export interface ConnectorTestResult {
  connectorId: string;
  ok: boolean;
  status: string;
  /** How many capabilities the connector advertised on this probe. */
  discovered: number;
  /**
   * How many canonical `Tool` rows were created or refreshed.
   *
   * Reported separately from `discovered` because they can legitimately differ: two actions may
   * collide on the same canonical name after slugging, in which case one row serves both and the
   * counts disagree. A single number would have to lie about one of them.
   */
  registered: number;
  /** The verbatim failure, when there was one. Never a credential, even on failure. */
  error: string | null;
}
