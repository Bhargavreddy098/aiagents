import type { Prisma, PrismaClient, Workflow, WorkflowStep, WorkflowVersion } from '@prisma/client';
import {
  toPlanStepType,
  workflowStepRequiresTool,
  type PlanStep,
  type WorkflowStatus,
  type WorkflowStepType,
} from '@nexs/shared';
import { toJson } from './json.js';

/**
 * Workflows: stored, versioned step graphs.
 *
 * A workflow is a program a human wrote, which is why running one **presets** the plan
 * rather than asking a model to invent one. The engine's `presetPlan` path validates the
 * result through the same ladder a generated plan goes through, so a workflow cannot
 * smuggle in a step the engine would refuse.
 *
 * ## Why steps are validated here as well
 *
 * `validateWorkflowSteps` is not redundant with the engine's ladder. The ladder runs when
 * the workflow is *run*; this runs when it is *saved*. A workflow whose third step
 * references a deleted tool would otherwise be accepted today and fail weeks later, at 3am,
 * in a scheduled run — and the operator would have to read a run's structured error to
 * discover a mistake they made in the editor. Refusing at write time is the difference
 * between a validation message and an incident.
 *
 * ## Tenant isolation, and the second exception
 *
 * `WorkflowVersion` and `WorkflowStep` have **no `tenantId` column** — they are scoped by
 * `workflowId` and `versionId` respectively, the same documented exception as `AgentVersion`
 * and `Step`. Every read of them goes through a guard that re-reads the owning `Workflow`
 * with the tenant in the `where`, so possessing a version or step id is not a capability.
 */

export interface WorkflowStepRow {
  name: string;
  stepType: WorkflowStepType;
  config: Prisma.InputJsonValue;
  toolId?: string | undefined;
  dependsOn?: string[] | undefined;
  retryPolicy?: { maxRetries: number; backoffMs: number } | undefined;
  timeoutMs?: number | null | undefined;
  onFail?: string | undefined;
}

export interface WorkflowListFilters {
  status?: WorkflowStatus;
  limit?: number;
}

/** A problem with a step, phrased so an editor can point at the offending row. */
export interface WorkflowStepIssue {
  /** Zero-based index into the submitted step array. */
  index: number;
  /** The step's `name`, echoed back so the message reads naturally. */
  name: string;
  message: string;
}

export class WorkflowRepository {
  constructor(private readonly db: PrismaClient) {}

  // ── reads ───────────────────────────────────────────────────────────────────

  async findById(tenantId: string, id: string): Promise<Workflow | null> {
    return this.db.workflow.findFirst({ where: { id, tenantId } });
  }

  async list(tenantId: string, filters: WorkflowListFilters = {}): Promise<Workflow[]> {
    return this.db.workflow.findMany({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
      },
      orderBy: { createdAt: 'desc' },
      ...(filters.limit === undefined ? {} : { take: filters.limit }),
    });
  }

  async count(tenantId: string, filters: { status?: WorkflowStatus } = {}): Promise<number> {
    return this.db.workflow.count({
      where: {
        tenantId,
        ...(filters.status === undefined ? {} : { status: filters.status }),
      },
    });
  }

  /** The composed detail view: the workflow and its versions with their steps. */
  async findByIdWithVersions(
    tenantId: string,
    id: string,
  ): Promise<(Workflow & { versions: (WorkflowVersion & { steps: WorkflowStep[] })[] }) | null> {
    return this.db.workflow.findFirst({
      where: { id, tenantId },
      include: {
        versions: {
          orderBy: { version: 'desc' },
          include: { steps: { orderBy: { position: 'asc' } } },
        },
      },
    });
  }

  async listVersions(
    tenantId: string,
    workflowId: string,
  ): Promise<(WorkflowVersion & { steps: WorkflowStep[] })[]> {
    if (!(await this.assertOwnedBy(tenantId, workflowId))) return [];
    return this.db.workflowVersion.findMany({
      where: { workflowId },
      orderBy: { version: 'desc' },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
  }

  async findVersionById(
    tenantId: string,
    versionId: string,
  ): Promise<(WorkflowVersion & { steps: WorkflowStep[] }) | null> {
    const version = await this.db.workflowVersion.findFirst({
      where: { id: versionId },
      include: { steps: { orderBy: { position: 'asc' } } },
    });
    if (version === null) return null;
    if (!(await this.assertOwnedBy(tenantId, version.workflowId))) return null;
    return version;
  }

  async findActiveVersion(
    tenantId: string,
    workflowId: string,
  ): Promise<(WorkflowVersion & { steps: WorkflowStep[] }) | null> {
    const workflow = await this.findById(tenantId, workflowId);
    if (workflow === null || workflow.activeVersionId === null) return null;
    return this.findVersionById(tenantId, workflow.activeVersionId);
  }

  // ── writes ──────────────────────────────────────────────────────────────────

  /**
   * Create a workflow and its version 1.
   *
   * Created in `draft` with no `activeVersionId`, so a workflow is never accidentally
   * runnable before someone has looked at it. The caller passes the status explicitly so
   * this method does not have to encode that policy.
   */
  async create(data: {
    tenantId: string;
    name: string;
    description: string | null;
    status: WorkflowStatus;
    steps: WorkflowStepRow[];
  }): Promise<{ workflow: Workflow; version: WorkflowVersion & { steps: WorkflowStep[] } }> {
    return this.db.$transaction(async (tx) => {
      const workflow = await tx.workflow.create({
        data: {
          tenantId: data.tenantId,
          name: data.name,
          description: data.description,
          status: data.status,
        },
      });

      const version = await tx.workflowVersion.create({
        data: { workflowId: workflow.id, version: 1 },
      });

      await this.writeSteps(tx, version.id, data.steps);

      // Pointing at version 1 immediately is right even in `draft`: the pointer says
      // "this is the current program", and `status` is what says whether it may run.
      const pointed = await tx.workflow.update({
        where: { id: workflow.id },
        data: { activeVersionId: version.id },
      });

      const steps = await tx.workflowStep.findMany({
        where: { versionId: version.id },
        orderBy: { position: 'asc' },
      });

      return { workflow: pointed, version: { ...version, steps } };
    });
  }

  /**
   * Publish a new version of an existing workflow.
   *
   * The version number is derived from the current maximum rather than from a counter on
   * `Workflow` — there is no counter column, and adding one would create a second source of
   * truth that a failed transaction could desynchronise from the rows it counts. The
   * `(workflowId, version)` unique constraint catches the race.
   */
  async addVersion(
    tenantId: string,
    workflowId: string,
    data: { name?: string; description?: string | null; steps: WorkflowStepRow[] },
  ): Promise<{ workflow: Workflow; version: WorkflowVersion & { steps: WorkflowStep[] } } | null> {
    return this.db.$transaction(async (tx) => {
      const workflow = await tx.workflow.findFirst({ where: { id: workflowId, tenantId } });
      if (workflow === null) return null;

      const latest = await tx.workflowVersion.findFirst({
        where: { workflowId },
        orderBy: { version: 'desc' },
      });
      const nextVersion = (latest?.version ?? 0) + 1;

      const version = await tx.workflowVersion.create({
        data: { workflowId, version: nextVersion },
      });

      await this.writeSteps(tx, version.id, data.steps);

      const pointed = await tx.workflow.update({
        where: { id: workflowId },
        data: {
          activeVersionId: version.id,
          ...(data.name === undefined ? {} : { name: data.name }),
          ...(data.description === undefined ? {} : { description: data.description }),
        },
      });

      const steps = await tx.workflowStep.findMany({
        where: { versionId: version.id },
        orderBy: { position: 'asc' },
      });

      return { workflow: pointed, version: { ...version, steps } };
    });
  }

  async setStatus(
    tenantId: string,
    id: string,
    status: WorkflowStatus,
  ): Promise<Workflow | null> {
    const { count } = await this.db.workflow.updateMany({
      where: { id, tenantId },
      data: { status },
    });
    if (count !== 1) return null;
    return this.findById(tenantId, id);
  }

  private async writeSteps(
    tx: Prisma.TransactionClient,
    versionId: string,
    steps: WorkflowStepRow[],
  ): Promise<void> {
    for (const [position, step] of steps.entries()) {
      await tx.workflowStep.create({
        data: {
          versionId,
          position,
          name: step.name,
          stepType: step.stepType,
          config: toJson(withToolId(step)),
          dependsOn: step.dependsOn ?? [],
          retryPolicy: toJson(step.retryPolicy ?? { maxRetries: 2, backoffMs: 1000 }),
          timeoutMs: step.timeoutMs ?? null,
          onFail: step.onFail ?? 'stop',
        },
      });
    }
  }

  private async assertOwnedBy(tenantId: string, workflowId: string): Promise<boolean> {
    const workflow = await this.db.workflow.findFirst({
      where: { id: workflowId, tenantId },
      select: { id: true },
    });
    return workflow !== null;
  }
}

/**
 * Validate a submitted step list before it is written.
 *
 * Checks only what can be known without the engine: that a tool step names a tool, that
 * step names are unique (they are how `dependsOn` and the UI address a step), and that
 * dependencies refer to steps that exist. Tool *existence* and the dependency graph's
 * acyclicity are checked by the caller, which has the tool repository — this function
 * deliberately has no dependencies so it can be called from anywhere.
 */
export function validateWorkflowSteps(
  steps: readonly WorkflowStepRow[],
): WorkflowStepIssue[] {
  const issues: WorkflowStepIssue[] = [];
  const seen = new Set<string>();

  for (const [index, step] of steps.entries()) {
    if (workflowStepRequiresTool(step.stepType) && step.toolId === undefined) {
      issues.push({
        index,
        name: step.name,
        message: `a "${step.stepType}" step must name a "toolId" — it resolves to an engine tool step`,
      });
    }

    if (seen.has(step.name)) {
      // Step names are the identity `dependsOn` uses. Two steps with the same name make
      // every reference to that name ambiguous, and the engine would silently pick one.
      issues.push({ index, name: step.name, message: 'step names must be unique within a version' });
    }
    seen.add(step.name);
  }

  for (const [index, step] of steps.entries()) {
    for (const dependency of step.dependsOn ?? []) {
      if (!seen.has(dependency)) {
        issues.push({
          index,
          name: step.name,
          message: `depends on "${dependency}", which is not a step in this version`,
        });
      }
    }
  }

  return issues;
}

/**
 * Fold an author's `toolId` into the step's stored `config`.
 *
 * `WorkflowStep` has **no `toolId` column** — the schema gives a step a free-form `config`
 * and nothing else to hold a reference. So the tool id is stored *inside* `config`, and
 * this function is the single place that happens. Doing it here rather than asking every
 * author to write `config: { toolId }` themselves keeps the input schema honest: a step
 * names its tool at the top level, the same way `PlanStep` does, and the storage detail
 * stays a storage detail.
 *
 * The consequence worth stating: a tool step's config is *not* purely the tool's arguments.
 * It carries one reserved key, and `toPlanSteps` is what takes it back out again.
 */
function withToolId(step: PlanInputStep): Record<string, unknown> {
  const config = asRecord(step.config);
  if (step.toolId !== undefined) config['toolId'] = step.toolId;
  return config;
}

/**
 * A Json column as a plain object.
 *
 * Narrowing `Prisma.JsonValue` with a type predicate leaves a union that still refuses to
 * be indexed, so this returns a fresh record instead. A non-object (a string, an array, a
 * null) becomes `{}` rather than throwing: a step whose config is malformed should fail
 * validation with a message about the step, not crash the reader.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
}

/**
 * The fields the translation reads.
 *
 * Structural so the same function serves a stored `WorkflowStep` and a step that has not
 * been written yet. Validation happens *before* the write, so it has to translate the
 * submitted form — and a second translation written for that purpose would be free to
 * disagree with the one used at execution time, which is exactly how a workflow passes
 * validation and then fails to run.
 */
export interface PlanStepSource {
  name: string;
  stepType: string;
  /** Already carrying the tool reference, for an input step; the raw config for a row. */
  config: unknown;
  dependsOn: readonly string[];
}

/**
 * Turn steps into the plan the engine executes.
 *
 * The translation happens in one place, and it is a translation rather than a pass-through
 * because a workflow's vocabulary is wider than a plan's: `browser`, `mcp`, `connector` and
 * `sandbox` all become `tool`. `toPlanStepType` holds the mapping and the reasoning.
 *
 * `id` is the step's **name**, not its row id. That is deliberate: `dependsOn` in the
 * workflow refers to names, so using the name as the plan-step id means the dependency
 * graph survives the translation untouched and needs no second rewrite.
 */
export function toPlanSteps(steps: readonly PlanStepSource[]): PlanStep[] {
  return steps.map((step) => {
    const config = asRecord(step.config);
    const toolId = typeof config['toolId'] === 'string' ? config['toolId'] : undefined;

    return {
      id: step.name,
      description: step.name,
      stepType: toPlanStepType(step.stepType as WorkflowStepType),
      ...(toolId === undefined ? {} : { toolId }),
      config,
      dependsOn: [...step.dependsOn],
    };
  });
}

/**
 * A step as the translator sees it.
 *
 * `config` is `unknown` rather than a Prisma JSON type so both a submitted row
 * (`InputJsonValue`, which cannot be null) and a stored row (`JsonValue`, which can) fit.
 * The translator only ever reads the four fields below, and stating that is more useful
 * than naming a Prisma type that happens to be narrower than the requirement.
 */
export interface PlanInputStep {
  name: string;
  stepType: string;
  config: unknown;
  dependsOn?: readonly string[];
  toolId?: string | undefined;
}

/** Translate stored rows — the execution-time path. */
export function planFromStoredSteps(steps: readonly WorkflowStep[]): PlanStep[] {
  return toPlanSteps(
    steps.map((step) => ({
      name: step.name,
      stepType: step.stepType,
      config: step.config,
      dependsOn: step.dependsOn,
    })),
  );
}

/** Translate submitted or stored rows — the validation-before-write path. */
export function planFromInputSteps(steps: readonly PlanInputStep[]): PlanStep[] {
  return toPlanSteps(
    steps.map((step) => ({
      name: step.name,
      stepType: step.stepType,
      config: withToolId(step),
      dependsOn: step.dependsOn ?? [],
    })),
  );
}
