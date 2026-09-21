import { ApiError, type ListModelsQuery, type ModelDetail, type ModelSummary, type UpdateModelInput } from '@nexs/shared';
import type { ModelRepository } from '../../repositories/model.repo.js';
import { toModelDetail, toModelSummary } from '../../mappers/providers.js';

/**
 * `/api/models` — the catalogue the planner offers models from.
 *
 * Read-mostly, and the one write it performs is an operator correction. That shapes everything
 * here:
 *
 * **A sync creates rows; this service is the only thing that edits them.** Discovery cannot tell
 * a chat model from an embedding model except by guessing at its id, so corrections are expected
 * rather than exceptional — which is why `ProviderService.sync` is additive and why this file
 * exists to own the edits. The two must not both write the same column.
 *
 * **The fallback chain is validated here, not in the schema.** `fallbackOf` is a plain string
 * column, so the schema can only check that it looks like an id. Whether it names a model in
 * *this tenant* is a question about the database, and whether it names *this* model is a question
 * the schema could check but the service must too — a service is reachable without a route schema
 * (the container, a test, a seed script), and a self-referencing fallback would make the
 * gateway's chain resolution loop.
 */

export interface ModelServiceDeps {
  models: ModelRepository;
}

export class ModelService {
  constructor(private readonly deps: ModelServiceDeps) {}

  /**
   * The catalogue.
   *
   * `limit`/`offset` are applied after the read rather than in the query, because
   * `ModelRepository.list` takes structured filters and adding pagination to it would mean
   * changing a signature the dashboard also uses. A tenant's catalogue is bounded by what its
   * providers offer — tens to low thousands of rows — so this is a real trade and not a
   * careless one. It is stated here so that a catalogue that ever grows past that gets the
   * query-level fix rather than a mysterious slowdown.
   */
  async list(tenantId: string, query: ListModelsQuery): Promise<ModelSummary[]> {
    const rows = await this.deps.models.list(tenantId, {
      ...(query.providerId === undefined ? {} : { providerId: query.providerId }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.enabledOnly === undefined ? {} : { enabledOnly: query.enabledOnly }),
    });

    const offset = query.offset ?? 0;
    const end = query.limit === undefined ? undefined : offset + query.limit;

    return rows.slice(offset, end).map(toModelSummary);
  }

  async get(tenantId: string, id: string): Promise<ModelDetail> {
    const model = await this.requireModel(tenantId, id);
    // The successors in the chain, read in the direction the column means. See
    // `ModelRepository.findFallbacks` and `toModelDetail`.
    const fallbacks = await this.deps.models.findFallbacks(tenantId, id);
    return toModelDetail(model, fallbacks);
  }

  async update(tenantId: string, id: string, input: UpdateModelInput): Promise<ModelDetail> {
    await this.requireModel(tenantId, id);

    if (input.fallbackOf !== undefined && input.fallbackOf !== null) {
      if (input.fallbackOf === id) {
        throw new ApiError('VALIDATION_ERROR', 'A model cannot fall back to itself', {
          field: 'fallbackOf',
          modelId: id,
        });
      }
      // Tenant-scoped: a fallback naming another tenant's model would be a cross-tenant read at
      // call time, and the gateway would resolve it without ever noticing.
      if ((await this.deps.models.findById(tenantId, input.fallbackOf)) === null) {
        throw new ApiError('VALIDATION_ERROR', 'The fallback model does not exist', {
          field: 'fallbackOf',
          fallbackOf: input.fallbackOf,
        });
      }
    }

    const count = await this.deps.models.update(tenantId, id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
      ...(input.fallbackOf === undefined ? {} : { fallbackOf: input.fallbackOf }),
    });

    if (count !== 1) {
      throw new ApiError('NOT_FOUND', 'Model not found', { modelId: id });
    }

    return this.get(tenantId, id);
  }

  private async requireModel(tenantId: string, id: string) {
    const model = await this.deps.models.findById(tenantId, id);
    if (model === null) {
      throw new ApiError('NOT_FOUND', 'Model not found', { modelId: id });
    }
    return model;
  }
}
