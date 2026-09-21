import type { Logger } from '../../logger.js';

/**
 * The connector adapter contract (spec §4.3).
 *
 * `ConnectorAdapter { connect(creds), disconnect(), discoverCapabilities(), execute(action, args,
 * account), subscribeEvents?(handler) }` is the spec's shape. What follows keeps all five methods
 * and changes only how the context reaches them: every method takes a `ConnectorContext` instead
 * of the adapter holding state.
 *
 * That is a deliberate deviation, and it is the same one the gateway adapters already make. An
 * adapter that closed over its credentials would be a per-tenant singleton, so the registry would
 * have to key instances by tenant, and every call would have to find the right one before it could
 * start. Passing the context in makes an adapter a pure function of (config, credentials, args) —
 * which means the registry holds exactly one instance per type, and a test can drive a complete
 * connector with no server, no vault and no database.
 *
 * `fetch` is injected for the same reason `AdapterContext.fetch` is: a test asserts what the
 * adapter *sent* by handing it a recorder, not by standing up a network.
 */

export type FetchLike = typeof globalThis.fetch;

/** Adapter configuration, as stored in `Connector.metadata.config`. */
export interface ConnectorConfig {
  baseUrl?: string;
  actions?: ConnectorActionConfig[];
  /** Header the token is sent in. Absent means `authorization`. */
  authHeader?: string;
  /** Prefix before the token. Absent means `Bearer`; an empty string sends the bare token. */
  authScheme?: string;
}

/** One config-driven action, used by the `rest` adapter. */
export interface ConnectorActionConfig {
  action: string;
  name: string;
  description?: string | null;
  method: string;
  path: string;
  inputSchema?: Record<string, unknown>;
  capabilities?: string[];
}

/**
 * What a connector needs in order to make a call. Decrypted at the last possible moment.
 *
 * Deliberately not a header map. `Connector.metadata` is plaintext, so anything placed there is
 * readable by the detail endpoint — which is why the shape of the credential's *transport* is
 * configuration (`authHeader`, `authScheme`) while the credential itself stays in the vault. See
 * `schemas/connectors.ts` for the full reasoning.
 */
export interface ConnectorCredentials {
  /**
   * The decrypted token, or an empty string when the account carries none.
   *
   * Empty string rather than null so an adapter can write `${scheme} ${token}` without a branch — an
   * adapter that needs a token must check for itself, because only it knows whether its vendor
   * allows anonymous calls.
   */
  token: string;
  /** Lower-cased already: header names are case-insensitive and normalizing once avoids a branch. */
  authHeader: string;
  /** `Bearer` by default. The empty string means the token is sent with no prefix. */
  authScheme: string;
}

export interface ConnectorContext {
  connectorId: string;
  connectorType: string;
  connectorName: string;
  /** Resolved from config, or the adapter's default when config has none. */
  baseUrl: string;
  config: ConnectorConfig;
  credentials: ConnectorCredentials;
  fetch: FetchLike;
  logger: Logger;
  signal?: AbortSignal;
}

/**
 * The remote identity a connector resolved during `connect`.
 *
 * This is what makes an account row meaningful: `ConnectorAccount.accountId` is the *vendor's*
 * identifier (a GitHub login, a Slack team), and it can only be learned by asking. Returning it
 * from `connect` rather than leaving it null is what turns "an account called work" into "the
 * account `octocat`".
 */
export interface ConnectorIdentity {
  accountId: string | null;
  label: string | null;
  /** Scopes the vendor reports for this credential. Empty when it does not report any. */
  scopes: string[];
}

/**
 * One action, as the adapter advertises it.
 *
 * `capabilities` is not optional here even though it is optional in the config schema. An adapter
 * must decide, because the alternative is the service guessing — and a guess that said
 * `read_only` about something that writes would put the action outside the approval policy. The
 * `rest` adapter derives it from the HTTP method when the config omits it; see that file.
 */
export interface DiscoveredCapability {
  action: string;
  name: string;
  description: string | null;
  inputSchema: unknown;
  capabilities: string[];
}

/** The account a call is made as. Null when the connector has no accounts yet. */
export interface ConnectorAccountRef {
  id: string;
  accountId: string | null;
  label: string;
  scopes: string[];
}

export interface ConnectorActionResult {
  payload: unknown;
  /**
   * The call *happened* and the vendor reported a failure — a 404, a validation rejection.
   *
   * This is not the same as the adapter throwing. A throw means the call could not be performed
   * (no credentials, an unreachable host, an unknown action); `isError` means it was performed and
   * answered. The invoker preserves the difference because the retry treatment differs.
   */
  isError?: boolean;
}

/** A normalized event from a vendor. Written as an `Event` row by the service. */
export interface ConnectorEvent {
  type: string;
  payload: unknown;
}

export interface ConnectorAdapter {
  readonly type: string;

  /**
   * Where this connector talks to when config names nowhere.
   *
   * Null for an adapter whose endpoint cannot be defaulted — a `rest` connector must be told its
   * base URL, and inventing one would be a request to a host the tenant never chose.
   */
  readonly defaultBaseUrl: string | null;

  /**
   * Prove the credentials work, and learn who they belong to.
   *
   * Must throw when the vendor rejects the credential: the service reports that as a failed probe
   * with the vendor's own reason, and a `connect` that swallowed a 401 would report a connector as
   * healthy while every subsequent call failed.
   */
  connect(
    ctx: ConnectorContext,
    account: ConnectorAccountRef | null,
  ): Promise<ConnectorIdentity | null>;

  /**
   * Release anything held open.
   *
   * A no-op for every adapter in this file, because every one of them is stateless HTTP. It stays
   * on the interface because the spec has it and because an adapter for a socket- or
   * session-based vendor would need it — and adding a method to an interface after three adapters
   * implement it is how one of them ends up without it.
   */
  disconnect(): Promise<void>;

  /**
   * The actions this connector can perform.
   *
   * Absence of a discovery endpoint is a real answer, not a failure: GitHub publishes no
   * machine-readable action catalogue, so its adapter returns a declared list. See that file for
   * why that is the honest implementation rather than a shortcut.
   */
  discoverCapabilities(ctx: ConnectorContext): Promise<DiscoveredCapability[]>;

  execute(
    action: string,
    args: Record<string, unknown>,
    ctx: ConnectorContext,
    account: ConnectorAccountRef | null,
  ): Promise<ConnectorActionResult>;

  /** Vendor push events. Unimplemented by every adapter here; all of them are poll-only. */
  subscribeEvents?(handler: (event: ConnectorEvent) => void): void;
}
