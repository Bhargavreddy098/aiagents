import { ApiError } from '@nexs/shared';
import type {
  ConnectorActionConfig,
  ConnectorAdapter,
  ConnectorContext,
  ConnectorIdentity,
  ConnectorActionResult,
  ConnectorAccountRef,
  DiscoveredCapability,
} from '../types.js';
import { carriesBody, fillPath, joinUrl, probe, queryString, sendJson } from '../http.js';

/**
 * The config-driven connector.
 *
 * This adapter exists to answer one question about the whole framework: **is a connector a set of
 * hard-coded vendor integrations wearing a shared interface, or is it actually a framework?** A
 * `rest` connector is described entirely by tenant-supplied configuration — a base URL and a list
 * of actions, each a method and a relative path — and nothing in this file mentions any vendor.
 * Adding a new HTTP API to a tenant's workspace is a POST, not a release.
 *
 * `github` is the second adapter, and it exists for the opposite reason: to show that a vendor with
 * its own conventions still fits. Two adapters, one interface, no shared code beyond the HTTP
 * mechanics in `../http.js`.
 *
 * ## Where the side-effect classification comes from
 *
 * A declared `capabilities` set wins. Without one, the adapter reads the **HTTP method** — `GET` is
 * `read_only`, everything else is `external_side_effect`. That is a derivation from evidence rather
 * than a guess: a `POST` is a write because that is what `POST` means, and no configuration can
 * make it not be. The safe direction matters here — defaulting an undeclared `POST` to `read_only`
 * would put it outside the approval policy, and the failure mode of over-approving is a prompt
 * where under-approving is an unintended write.
 */
export class RestConnectorAdapter implements ConnectorAdapter {
  readonly type = 'rest';

  /**
   * Null: a generic REST connector has no default host.
   *
   * The schema requires `config.baseUrl` for exactly this reason. Inventing a default would mean
   * sending a tenant's credential to a host they never chose.
   */
  readonly defaultBaseUrl: string | null = null;

  /**
   * Establish that the configured host is reachable.
   *
   * **Any HTTP answer counts as reachable, including a 404.** A generic REST endpoint has no
   * `whoami`, so there is no request that proves the credential is valid — and pretending
   * otherwise would be worse than admitting it. What this *can* establish is that DNS resolves,
   * TLS completes and something is listening, which is where the overwhelming majority of
   * misconfigured connectors fail.
   *
   * It returns `null` rather than an identity because it genuinely does not know one. The service
   * reports that as "no identity endpoint", which is a fact about the connector type, not an error.
   */
  async connect(ctx: ConnectorContext): Promise<ConnectorIdentity | null> {
    await probe(ctx, ctx.baseUrl, { method: 'GET' });
    return null;
  }

  /** Stateless HTTP; there is nothing held open. See the interface for why this is still here. */
  async disconnect(): Promise<void> {
    // Intentionally empty.
  }

  async discoverCapabilities(ctx: ConnectorContext): Promise<DiscoveredCapability[]> {
    return actionsOf(ctx).map((config) => ({
      action: config.action,
      name: config.name,
      description: config.description ?? null,
      inputSchema: config.inputSchema ?? schemaFromPath(config.path),
      capabilities: capabilitiesOf(config),
    }));
  }

  async execute(
    action: string,
    args: Record<string, unknown>,
    ctx: ConnectorContext,
    _account: ConnectorAccountRef | null,
  ): Promise<ConnectorActionResult> {
    const config = actionsOf(ctx).find((candidate) => candidate.action === action);

    if (config === undefined) {
      // The `available` list is not decoration: this error surfaces to a model that just picked a
      // name that does not exist, and giving it the real ones is the difference between a
      // self-correcting retry and a loop.
      throw new ApiError('NOT_FOUND', `This connector has no action "${action}"`, {
        action,
        available: actionsOf(ctx).map((candidate) => candidate.action),
      });
    }

    const { path, rest } = fillPath(config.path, args);
    const body = carriesBody(config.method);
    const url = `${joinUrl(ctx.baseUrl, path)}${queryString(body ? {} : rest)}`;

    return sendJson(ctx, url, {
      method: config.method.toUpperCase(),
      ...(body ? { body: rest } : {}),
    });
  }
}

/**
 * The connector's declared actions.
 *
 * A `rest` connector with none is rejected by the request schema, so this is only reachable if a
 * row was written before that rule existed or edited outside the API. Throwing beats returning an
 * empty list: an empty list reads as "this connector has no actions", and the truth is "this row is
 * not a valid rest connector".
 */
function actionsOf(ctx: ConnectorContext): ConnectorActionConfig[] {
  const actions = ctx.config.actions ?? [];
  if (actions.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'This rest connector declares no actions', {
      connectorId: ctx.connectorId,
    });
  }
  return actions;
}

/** A declared set, or one derived from the method. See the class comment for the direction. */
function capabilitiesOf(config: ConnectorActionConfig): string[] {
  if (config.capabilities !== undefined && config.capabilities.length > 0) {
    return [...config.capabilities];
  }
  return config.method.toUpperCase() === 'GET' ? ['read_only'] : ['external_side_effect'];
}

/**
 * The most that can be honestly said about an action's arguments.
 *
 * Every `{placeholder}` in the path is an argument the action cannot run without — the adapter will
 * throw if it is absent — so each becomes a required string property. Nothing else is claimed:
 * `additionalProperties` stays open, because a query parameter or a body field is equally likely
 * and this adapter has no way to know which.
 *
 * A declared `inputSchema` replaces this entirely. The point of the fallback is to give a model
 * something true to work with when the tenant has not written a schema, not to be a good schema.
 */
export function schemaFromPath(path: string): Record<string, unknown> {
  const names = [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!);

  if (names.length === 0) {
    return { type: 'object', properties: {}, additionalProperties: true };
  }

  return {
    type: 'object',
    properties: Object.fromEntries(names.map((name) => [name, { type: 'string' }])),
    required: names,
    additionalProperties: true,
  };
}
