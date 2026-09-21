import type { Tool } from '@prisma/client';
import type { Logger } from '../../logger.js';
import type { ToolRepository } from '../../repositories/mcp.repo.js';
import { toJson } from '../../repositories/json.js';
import type { NativeToolRegistry } from './native-tools.js';

/**
 * The built-in tools, as `Tool` rows.
 *
 * ## Why this exists
 *
 * The registry in `native-tools.ts` is what *runs* a built-in tool, but nothing runs by name: the
 * planner offers the model the rows in `Tool` filtered by the agent's allowlist, and the invoker
 * looks a row up before dispatching. A tool with a handler and no row is therefore invisible — it
 * works perfectly and no agent can ever call it.
 *
 * That gap is easy to leave open, because both halves look finished on their own. `ensure` closes
 * it by deriving the rows from the registry itself, so the two can never disagree about which
 * tools exist: the registry is the single source of truth and a row is a projection of it.
 *
 * ## Why it is idempotent rather than a migration
 *
 * A row is created only when it is missing. `ToolRepository.upsert` would otherwise rewrite
 * `status: 'enabled'` on every call, so an operator who disabled `http_request` would find it
 * switched back on the next time anybody created an agent — a setting that silently reverts is
 * worse than one that is missing, because the operator has already stopped looking.
 *
 * ## Why `capabilities` is left empty
 *
 * For a native tool the authoritative capability set is derived from the *arguments* at invocation
 * time — a `GET` is read-only and a `POST` is not — and `ToolInvoker.capabilitiesFor` reads the
 * registry rather than the row for exactly that reason. Writing a set here would be a second,
 * weaker declaration that could disagree with the derivation, and the disagreement would be
 * invisible until something trusted the row. An empty array says "ask the registry", which is
 * what every consumer does.
 */

/** The `source` every built-in row carries (`Tool.source`: "builtin" | "mcp:<id>" | "connector:<id>"). */
export const BUILTIN_SOURCE = 'builtin';

export interface BuiltinToolServiceDeps {
  tools: ToolRepository;
  native: NativeToolRegistry;
  logger: Logger;
}

export class BuiltinToolService {
  constructor(private readonly deps: BuiltinToolServiceDeps) {}

  /**
   * Create any missing built-in tool rows for this tenant, and return the tenant's tools.
   *
   * Returns the full list rather than only what it created, because every caller's next move is
   * to look a tool up by name and it would otherwise have to list again — a second query that
   * could observe a different set than the one just written.
   */
  async ensure(tenantId: string): Promise<Tool[]> {
    const existing = await this.deps.tools.list(tenantId);
    const present = new Set(
      existing.filter((row) => row.source === BUILTIN_SOURCE).map((row) => row.name),
    );

    let created = 0;
    for (const descriptor of this.deps.native.list()) {
      if (present.has(descriptor.name)) continue;
      await this.deps.tools.upsert({
        tenantId,
        source: BUILTIN_SOURCE,
        name: descriptor.name,
        description: descriptor.description,
        type: 'native',
        provider: 'native',
        inputSchema: toJson(descriptor.inputSchema),
        metadata: toJson({ builtin: true }),
      });
      created += 1;
    }

    if (created > 0) {
      this.deps.logger.info({ tenantId, created }, 'provisioned built-in tool rows');
      return this.deps.tools.list(tenantId);
    }
    return existing;
  }

  /**
   * The ids of the named built-in tools, creating the rows if they are missing.
   *
   * Ids rather than rows because the only thing a caller does with the answer is put it in an
   * agent's `toolIds`. A name that the registry does not expose is simply absent from the result
   * rather than an error: the caller asked "which of these exist", and the honest answer to "none
   * of them" is an empty array — `memory_search` genuinely does not exist in a deployment with no
   * memory service, and that is not a failure.
   */
  async idsFor(tenantId: string, names: readonly string[]): Promise<string[]> {
    const rows = await this.ensure(tenantId);
    const wanted = new Set(names);
    return rows
      .filter((row) => row.source === BUILTIN_SOURCE && wanted.has(row.name))
      .map((row) => row.id);
  }
}
