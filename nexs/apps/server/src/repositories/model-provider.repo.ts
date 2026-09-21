import type { ModelProvider, Prisma, PrismaClient } from '@prisma/client';

/**
 * Note on `metadata`: Prisma's Json columns are typed `InputJsonValue`, which
 * `Record<string, unknown>` does not satisfy (an `unknown` value might not be
 * JSON-serialisable). Every Json parameter in this layer is therefore declared as
 * `Prisma.InputJsonValue` — the constraint is real and worth keeping rather than
 * casting past it.
 */
export type JsonInput = Prisma.InputJsonValue;

/**
 * `ModelProvider` has no `lastError` column in this schema revision (only `McpServer`
 * does). Provider failure detail is stored under `metadata.lastError` instead, so the
 * dashboard can answer "why is this provider red?" without a schema change.
 */
function withLastError(metadata: unknown, lastError: string | undefined): Record<string, unknown> {
  const base =
    typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};

  if (lastError === undefined) {
    delete base['lastError'];
  } else {
    base['lastError'] = lastError;
  }

  return base;
}

export class ModelProviderRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: {
    tenantId: string;
    name: string;
    slug: string;
    type: string;
    baseUrl?: string | null;
    apiKeyRef?: string | null;
    organizationId?: string | null;
    projectId?: string | null;
    capabilities?: string[];
    metadata?: JsonInput;
  }): Promise<ModelProvider> {
    return this.db.modelProvider.create({ data });
  }

  async findById(tenantId: string, id: string): Promise<ModelProvider | null> {
    return this.db.modelProvider.findFirst({ where: { id, tenantId } });
  }

  async findBySlug(tenantId: string, slug: string): Promise<ModelProvider | null> {
    return this.db.modelProvider.findFirst({ where: { tenantId, slug } });
  }

  async list(tenantId: string, options: { enabledOnly?: boolean } = {}): Promise<ModelProvider[]> {
    return this.db.modelProvider.findMany({
      where: {
        tenantId,
        ...(options.enabledOnly === true ? { enabled: true } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Every enabled provider, across all tenants.
   *
   * **The one unscoped read in this file**, and the same documented exception as
   * `RunRepository.listStale` and `ScheduleRepository.listAllEnabled`. Its caller is the
   * `provider.health` cron, which is a maintenance sweep with no request context to derive a
   * tenant from — it has to see every tenant's providers or it would check only whichever
   * one happened to be first. Not reachable from any HTTP route.
   */
  async listAllEnabled(): Promise<ModelProvider[]> {
    return this.db.modelProvider.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Health state lives on the row, not in memory, so the dashboard can show it and a
   * restart does not forget that a provider was failing.
   */
  async updateStatus(
    tenantId: string,
    id: string,
    status: string,
    lastError?: string,
  ): Promise<number> {
    const existing = await this.findById(tenantId, id);
    if (existing === null) return 0;

    const { count } = await this.db.modelProvider.updateMany({
      where: { id, tenantId },
      data: {
        status,
        lastHealthCheck: new Date(),
        metadata: withLastError(existing.metadata, lastError) as JsonInput,
      },
    });
    return count;
  }

  async update(
    tenantId: string,
    id: string,
    data: {
      name?: string;
      baseUrl?: string | null;
      apiKeyRef?: string | null;
      enabled?: boolean;
      capabilities?: string[];
      metadata?: JsonInput;
    },
  ): Promise<number> {
    const { count } = await this.db.modelProvider.updateMany({ where: { id, tenantId }, data });
    return count;
  }

  /** Called after a model sync so the dashboard count traces to real rows. */
  async setModelCount(tenantId: string, id: string, modelCount: number): Promise<number> {
    const { count } = await this.db.modelProvider.updateMany({
      where: { id, tenantId },
      data: { modelCount, lastModelSync: new Date() },
    });
    return count;
  }

  async delete(tenantId: string, id: string): Promise<number> {
    const { count } = await this.db.modelProvider.deleteMany({ where: { id, tenantId } });
    return count;
  }
}
