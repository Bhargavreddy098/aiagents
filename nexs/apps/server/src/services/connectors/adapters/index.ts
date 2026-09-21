import { ApiError } from '@nexs/shared';
import type { ConnectorAdapter } from '../types.js';
import { RestConnectorAdapter } from './rest.js';
import { GitHubConnectorAdapter } from './github.js';

/**
 * The adapter registry.
 *
 * ## Two vocabularies, and the gap between them is the point
 *
 * `CONNECTOR_TYPES` in `@nexs/shared` is what the *schema* accepts — the eight types the spec
 * names. This registry is what the *process* implements. They are deliberately not the same list,
 * and the difference is not a TODO comment: a tenant that creates a `slack` connector gets a clear
 * 422 naming the types that do work, rather than a row that saves successfully and then fails at
 * every call.
 *
 * That is the same rule `ProviderService` applies with `ModelGateway.canRoute`, and it is the same
 * rule the tool registry applies with conditional registration: **an unimplemented capability must
 * be absent, not present-and-broken.** A row that exists is a row an operator will grant to an
 * agent, and the failure will surface as a failed run rather than as a validation error.
 *
 * ## Why the instances are shared
 *
 * Every adapter is stateless — all four of its methods take their context as an argument, and
 * `disconnect` is a no-op. One instance per type is therefore safe, and it keeps the registry a
 * plain map rather than a per-tenant cache that would need eviction.
 */

const ADAPTERS: ReadonlyMap<string, ConnectorAdapter> = new Map<string, ConnectorAdapter>(
  [new RestConnectorAdapter(), new GitHubConnectorAdapter()].map((adapter) => [adapter.type, adapter]),
);

/** The types this process can actually serve. */
export function implementedConnectorTypes(): string[] {
  return [...ADAPTERS.keys()].sort();
}

/**
 * Whether an adapter exists for a type — a predicate, not a `getAdapter`.
 *
 * A caller asking "can we do this" must not be handed the thing that does it, or the check becomes
 * something that can be skipped. `ConnectorService` calls this before writing a row.
 */
export function hasConnectorAdapter(type: string): boolean {
  return ADAPTERS.has(type);
}

export function createConnectorAdapter(type: string): ConnectorAdapter {
  const adapter = ADAPTERS.get(type);
  if (adapter === undefined) {
    throw new ApiError('UNSUPPORTED_CAPABILITY', `No adapter implements the "${type}" connector`, {
      type,
      implemented: implementedConnectorTypes(),
    });
  }
  return adapter;
}

export { RestConnectorAdapter, GitHubConnectorAdapter };
