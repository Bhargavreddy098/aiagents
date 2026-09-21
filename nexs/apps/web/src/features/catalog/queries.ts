/**
 * Queries for the shared catalogs.
 *
 * Providers, models, tools, MCP servers, connectors and schedules are read by several pages
 * — the agent wizard needs all five of the first group, the models page needs two, the
 * dashboard-adjacent pages need schedules. Declaring them once means the agent wizard's
 * model picker and the models page are looking at the same rows from the same cache, so
 * "enable a model" cannot leave the wizard offering a disabled one.
 *
 * Keys come from `queryKeys`, so the SSE map invalidates these too: `provider.synced`
 * refreshes `['providers']` and `['models']`, `mcp.connected` refreshes `['mcp']` and
 * `['tools']`.
 *
 * ## Filter names are the server's names
 *
 * Each filter interface below mirrors its query schema in `@nexs/shared` field for field,
 * including the field *names*. That is not tidiness: every one of those schemas is `.strict()`,
 * so a key the server does not recognise is a `400 VALIDATION_ERROR`, not an ignored parameter.
 *
 * This file used to send `?enabled=true` to `/api/models` and `?search=…` to `/api/tools`. Both
 * are real names in other schemas — `listSchedulesSchema` does take `enabled`, and a search box
 * is a natural thing to call `search` — so neither looked wrong at the call site. Both 400'd on
 * every mount: the chat composer's model picker and the Tools page's search box were asking a
 * question the server refused to parse, and both rendered their empty state, which is
 * indistinguishable from "no rows".
 *
 * `queries.test.ts` parses every query string these hooks build against the real schema, so a
 * rename on either side now fails a test rather than a page.
 */

import { useQuery } from '@tanstack/react-query';
import type {
  ConnectorSummary,
  McpServerSummary,
  ModelSummary,
  ProviderSummary,
  ScheduleListResult,
  ToolSummary,
} from '@nexs/shared';
import { api, apiOf, qs } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers,
    queryFn: () => apiOf<ProviderSummary[]>('/providers', 'providers'),
  });
}

/** Mirrors `listModelsSchema`. `enabledOnly` is the server's name — see the file header. */
export interface ModelFilters {
  providerId?: string;
  type?: string;
  status?: string;
  enabledOnly?: boolean;
  limit?: number;
  offset?: number;
}

export function useModels(filters: ModelFilters = {}) {
  return useQuery({
    queryKey: [...queryKeys.models, filters] as const,
    queryFn: () => apiOf<ModelSummary[]>(`/models${qs({ ...filters })}`, 'models'),
  });
}

/** Mirrors `listToolsSchema`. The text filter is `q`, not `search` — see the file header. */
export interface ToolFilters {
  type?: string;
  source?: string;
  status?: string;
  mcpServerId?: string;
  q?: string;
}

export function useTools(filters: ToolFilters = {}) {
  return useQuery({
    queryKey: [...queryKeys.tools.all, filters] as const,
    queryFn: () => apiOf<ToolSummary[]>(`/tools${qs({ ...filters })}`, 'tools'),
  });
}

export function useMcpServers() {
  return useQuery({
    queryKey: queryKeys.mcp.all,
    queryFn: () => apiOf<McpServerSummary[]>('/mcp', 'servers'),
  });
}

export function useConnectors() {
  return useQuery({
    queryKey: queryKeys.connectors.all,
    queryFn: () => apiOf<ConnectorSummary[]>('/connectors', 'connectors'),
  });
}

export function useSchedules() {
  return useQuery({
    queryKey: queryKeys.schedules,
    queryFn: () => api<ScheduleListResult>('/schedules'),
  });
}
