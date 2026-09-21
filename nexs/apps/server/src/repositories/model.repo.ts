import type { GatewayRoute, Model, ModelProvider, Prisma, PrismaClient } from '@prisma/client';
import { isUniqueViolation } from '../db-errors.js';

/** Prisma's Json columns are `InputJsonValue`, not `Record<string, unknown>`. */
export type JsonInput = Prisma.InputJsonValue;

/** The gateway always needs the provider alongside the model (base URL, type, credential). */
export type ModelWithProvider = Model & { provider: ModelProvider };

export interface ModelListFilters {
  type?: string;
  providerId?: string;
  enabledOnly?: boolean;
  status?: string;
}

export interface ModelCatalogEntry {
  tenantId: string;
  providerId: string;
  name: string;
  externalModelId: string;
  type: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  capabilities?: string[];
  metadata?: JsonInput;
  fallbackOf?: string | null;
}

export class ModelRepository {
  constructor(private readonly db: PrismaClient) {}

  async findById(tenantId: string, id: string): Promise<ModelWithProvider | null> {
    return this.db.model.findFirst({
      where: { id, tenantId },
      include: { provider: true },
    });
  }

  async findByExternalId(
    tenantId: string,
    providerId: string,
    externalModelId: string,
  ): Promise<ModelWithProvider | null> {
    return this.db.model.findFirst({
      where: { tenantId, providerId, externalModelId },
      include: { provider: true },
    });
  }

  async list(tenantId: string, filters: ModelListFilters = {}): Promise<ModelWithProvider[]> {
    return this.db.model.findMany({
      where: {
        tenantId,
        ...(filters.type === undefined ? {} : { type: filters.type }),
        ...(filters.providerId === undefined ? {} : { providerId: filters.providerId }),
        ...(filters.status === undefined ? {} : { status: filters.status }),
        ...(filters.enabledOnly === true ? { enabled: true } : {}),
      },
      include: { provider: true },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Models that name `modelId` as the thing they fall back for — i.e. the next links in
   * the chain.
   *
   * Reading of `Model.fallbackOf`: "this model is a fallback *of* the referenced model".
   * The alternative reading ("this model's fallback is X") only allows one successor per
   * model, which cannot express a chain of three. This direction can, and matches the
   * schema comment's phrase "fallback chain".
   */
  async findFallbacks(tenantId: string, modelId: string): Promise<ModelWithProvider[]> {
    return this.db.model.findMany({
      where: { tenantId, fallbackOf: modelId, enabled: true, status: 'available' },
      include: { provider: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(data: ModelCatalogEntry): Promise<Model> {
    return this.db.model.create({ data });
  }

  /**
   * Add a discovered model, or report that the catalogue already had it.
   *
   * ## Why this is not `upsert`
   *
   * `upsert` above refreshes `name` and `type` on conflict, which is right for a *re-seed* and
   * wrong for a *sync*. Discovery guesses a model's type from its id, so operators correct those
   * guesses — and an upserting sync would revert every correction on the next run, silently. See
   * `ProviderSyncResult` for the full argument.
   *
   * The race between the read and the write is real but harmless: two concurrent syncs can both
   * see "absent" and both try to insert, and `@@unique([providerId, externalModelId])` makes the
   * loser fail with `P2002`. That is translated to `false` here rather than propagated, because
   * losing a race to insert a row that now exists is exactly the outcome the caller wanted.
   */
  async createIfAbsent(data: ModelCatalogEntry): Promise<boolean> {
    const existing = await this.findByExternalId(data.tenantId, data.providerId, data.externalModelId);
    if (existing !== null) return false;

    try {
      await this.create(data);
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  /** Model catalogues are synced from providers, so this is an upsert by natural key. */
  async upsert(data: ModelCatalogEntry): Promise<Model> {
    return this.db.model.upsert({
      where: {
        providerId_externalModelId: {
          providerId: data.providerId,
          externalModelId: data.externalModelId,
        },
      },
      create: data,
      update: {
        name: data.name,
        type: data.type,
        contextWindow: data.contextWindow ?? null,
        maxOutputTokens: data.maxOutputTokens ?? null,
        ...(data.capabilities === undefined ? {} : { capabilities: data.capabilities }),
        ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
      },
    });
  }

  async update(
    tenantId: string,
    id: string,
    data: {
      name?: string;
      enabled?: boolean;
      status?: string;
      fallbackOf?: string | null;
      capabilities?: string[];
      metadata?: JsonInput;
    },
  ): Promise<number> {
    const { count } = await this.db.model.updateMany({ where: { id, tenantId }, data });
    return count;
  }

  async countForProvider(tenantId: string, providerId: string): Promise<number> {
    return this.db.model.count({ where: { tenantId, providerId } });
  }

  /**
   * Tenant-level routing override for this model.
   *
   * An explicit operator decision outranks the catalogue default in `Model.fallbackOf`,
   * because an operator who configured "when gpt-4o is down, use claude-sonnet" means it
   * more than a seeded row does.
   */
  async findRoute(tenantId: string, modelId: string): Promise<GatewayRoute | null> {
    return this.db.gatewayRoute.findFirst({
      where: { tenantId, modelId, enabled: true },
      orderBy: { priority: 'desc' },
    });
  }
}
