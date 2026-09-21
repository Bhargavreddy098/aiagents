import type { Connector, ConnectorAccount } from '@prisma/client';
import type {
  ConnectorAccountSummary,
  ConnectorCapability,
  ConnectorDetail,
  ConnectorSummary,
  ConnectorTestResult,
} from '@nexs/shared';
import type { ConnectorConfig } from '../services/connectors/types.js';

/**
 * Row-to-wire mapping for connectors.
 *
 * Two jobs, and the second is the one worth stating.
 *
 * The first is ordinary: dates to ISO strings, nullable columns to nullable fields.
 *
 * The second is **lifting `lastError` out of `metadata` without exposing `metadata`.** The metadata
 * blob holds the adapter config and the last failure reason; a page needs the reason and has no use
 * for the rest, and handing over the blob would mean every future adapter adding a field to it is
 * adding a field to a public response by default. The same decision `toProviderDetail` makes.
 */

/** Metadata, as an object, whatever the column actually holds. */
function readMetadata(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/** The stored failure reason, or null. A non-string is not a reason, so it reads as absent. */
export function readLastError(raw: unknown): string | null {
  const value = readMetadata(raw).lastError;
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The adapter config out of `metadata`.
 *
 * Returned as a loose object rather than validated here. The request schema already validated it on
 * the way in, and re-validating on the way out would mean a row written before a schema change
 * becomes unreadable — an adapter should be able to read what it wrote and report its own problem
 * with it. A non-object config reads as an empty one, which every adapter handles.
 */
export function readConnectorConfig(raw: unknown): ConnectorConfig {
  const config = readMetadata(raw).config;
  return readMetadata(config) as ConnectorConfig;
}

/**
 * The stored capability snapshot.
 *
 * Every entry is re-shaped defensively: this column is JSON, so a row could hold anything, and a
 * malformed entry should drop out rather than crash the detail page. An entry with no `action` is
 * dropped because `action` is the dispatch key — a capability without one cannot be invoked, so
 * showing it would be showing an action that does not exist.
 */
export function readCapabilities(raw: unknown): ConnectorCapability[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry): ConnectorCapability[] => {
    if (entry === null || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const action = record.action;
    if (typeof action !== 'string' || action === '') return [];

    return [
      {
        action,
        name: typeof record.name === 'string' && record.name !== '' ? record.name : action,
        description: typeof record.description === 'string' ? record.description : null,
        inputSchema: record.inputSchema ?? {},
        capabilities: Array.isArray(record.capabilities)
          ? record.capabilities.filter((value): value is string => typeof value === 'string')
          : [],
        toolId: null,
      },
    ];
  });
}

export function toConnectorAccountSummary(account: ConnectorAccount): ConnectorAccountSummary {
  return {
    id: account.id,
    connectorId: account.connectorId,
    label: account.label,
    accountId: account.accountId,
    scopes: [...account.scopes],
    status: account.status,
    // The id is deliberately not on the wire — see `ConnectorAccountSummary`.
    hasCredential: account.credentialId !== null,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

export function toConnectorSummary(
  connector: Connector,
  counts: { accountCount: number },
): ConnectorSummary {
  return {
    id: connector.id,
    type: connector.type,
    name: connector.name,
    status: connector.status,
    accountCount: counts.accountCount,
    capabilityCount: readCapabilities(connector.capabilityDiscovery).length,
    lastError: readLastError(connector.metadata),
    createdAt: connector.createdAt.toISOString(),
    updatedAt: connector.updatedAt.toISOString(),
  };
}

/**
 * One connector, with its capabilities and accounts.
 *
 * `capabilities` takes the tool ids as a map rather than looking them up, because the service has
 * already read the connector's canonical tools — and the join key is the adapter's `action`, which
 * is stored in `Tool.metadata.externalId`. The *canonical* tool name is a slugged, length-capped
 * label for a model's benefit and is explicitly never parsed back, so matching on it would be
 * exactly the mistake that comment warns about.
 */
export function toConnectorDetail(
  connector: Connector,
  counts: { accountCount: number },
  accounts: ConnectorAccount[],
  toolIdByAction: ReadonlyMap<string, string>,
): ConnectorDetail {
  const capabilities = readCapabilities(connector.capabilityDiscovery).map((capability) => ({
    ...capability,
    toolId: toolIdByAction.get(capability.action) ?? null,
  }));

  return {
    ...toConnectorSummary(connector, counts),
    capabilities,
    accounts: accounts.map(toConnectorAccountSummary),
  };
}

export function toConnectorTestResult(
  connectorId: string,
  input: {
    ok: boolean;
    status: string;
    discovered: number;
    registered: number;
    error: string | null;
  },
): ConnectorTestResult {
  return { connectorId, ...input };
}
