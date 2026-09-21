import type { ModelUsage, PrismaClient } from '@prisma/client';

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costEstimate: number;
  calls: number;
}

const EMPTY_TOTALS: UsageTotals = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  costEstimate: 0,
  calls: 0,
};

/**
 * [gap #7] Every token and every cent the UI shows comes from a row in this table.
 *
 * There are no in-memory counters anywhere in the model layer, on purpose: a counter
 * would be lost on restart, would differ between worker processes, and could not be
 * reproduced by a SQL query. The dashboard's acceptance test is literally "pick a
 * number and reproduce it with SQL".
 */
export class ModelUsageRepository {
  constructor(private readonly db: PrismaClient) {}

  async record(data: {
    tenantId: string;
    modelId: string;
    providerId: string;
    runId?: string | null;
    stepId?: string | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    latencyMs?: number | null;
    costEstimate?: number;
    cached?: boolean;
  }): Promise<ModelUsage> {
    return this.db.modelUsage.create({ data });
  }

  async totalsForTenant(tenantId: string, since?: Date): Promise<UsageTotals> {
    return this.totals({ tenantId, ...(since === undefined ? {} : { createdAt: { gte: since } }) });
  }

  async totalsForRun(tenantId: string, runId: string): Promise<UsageTotals> {
    return this.totals({ tenantId, runId });
  }

  async totalsForModel(tenantId: string, modelId: string, since?: Date): Promise<UsageTotals> {
    return this.totals({
      tenantId,
      modelId,
      ...(since === undefined ? {} : { createdAt: { gte: since } }),
    });
  }

  /** Per-provider breakdown for the dashboard, aggregated in the database. */
  async totalsByProvider(
    tenantId: string,
    since?: Date,
  ): Promise<Array<{ providerId: string } & UsageTotals>> {
    const rows = await this.db.modelUsage.groupBy({
      by: ['providerId'],
      where: { tenantId, ...(since === undefined ? {} : { createdAt: { gte: since } }) },
      _sum: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        costEstimate: true,
      },
      _count: true,
    });

    return rows.map((row) => {
      const record = row as unknown as {
        providerId: string;
        _sum: Partial<Record<string, number | null>>;
        _count: number;
      };
      return {
        providerId: record.providerId,
        promptTokens: record._sum.promptTokens ?? 0,
        completionTokens: record._sum.completionTokens ?? 0,
        totalTokens: record._sum.totalTokens ?? 0,
        costEstimate: record._sum.costEstimate ?? 0,
        calls: record._count,
      };
    });
  }

  async recent(tenantId: string, limit = 50): Promise<ModelUsage[]> {
    return this.db.modelUsage.findMany({
      where: { tenantId },
      // `createdAt` has millisecond resolution, so two calls in the same tick tie and
      // Postgres is free to return them in any order. The id is a cuid — time-ordered —
      // so it breaks the tie and makes the list stable across reloads.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
  }

  /**
   * Every model call a run made.
   *
   * This is what makes the spend shown against a run a *fact* rather than an estimate: the
   * rows are written by the gateway as each call completes, and this reads them back. A run
   * with no rows spent nothing, which is a different statement from "spend unknown".
   */
  async listByRunId(tenantId: string, runId: string): Promise<ModelUsage[]> {
    return this.db.modelUsage.findMany({
      where: { tenantId, runId },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async totals(where: Record<string, unknown>): Promise<UsageTotals> {
    const result = await this.db.modelUsage.aggregate({
      where,
      _sum: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        costEstimate: true,
      },
      _count: true,
    });

    const record = result as unknown as {
      _sum: Partial<Record<string, number | null>>;
      _count: number;
    };

    return {
      promptTokens: record._sum.promptTokens ?? EMPTY_TOTALS.promptTokens,
      completionTokens: record._sum.completionTokens ?? EMPTY_TOTALS.completionTokens,
      totalTokens: record._sum.totalTokens ?? EMPTY_TOTALS.totalTokens,
      costEstimate: record._sum.costEstimate ?? EMPTY_TOTALS.costEstimate,
      calls: record._count ?? 0,
    };
  }
}
