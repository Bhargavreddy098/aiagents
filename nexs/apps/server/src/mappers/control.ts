import type {
  Agent,
  AgentVersion,
  Goal,
  Task,
  Workflow,
  WorkflowStep,
  WorkflowVersion,
} from '@prisma/client';
import type {
  AgentDetail,
  AgentStatus,
  AgentSummary,
  AgentVersionSummary,
  GoalDetail,
  GoalStatus,
  GoalSummary,
  TaskDetail,
  TaskStatus,
  TaskSummary,
  TaskTriggerType,
  WorkflowDetail,
  WorkflowOnFail,
  WorkflowStatus,
  WorkflowStepDetail,
  WorkflowStepType,
  WorkflowSummary,
  WorkflowVersionDetail,
} from '@nexs/shared';

/**
 * The single place a control-plane row becomes a wire shape.
 *
 * Same rule as `mappers/user.ts`, and it earns its keep here for a second reason beyond
 * leak prevention: the wire shapes are **narrower** than the rows. A `Task` row carries
 * `tenantId`, which no response needs; an `Agent` row carries `instructions`, which the
 * list view does not ship. Mapping explicitly means the difference between "the list" and
 * "the detail" is a decision rather than whatever the row happened to contain.
 */

/** `Date | null` → ISO string or null. Declared once so no mapper invents its own rule. */
function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

/** `Date` → ISO string, for columns that cannot be null. */
function isoRequired(value: Date): string {
  return value.toISOString();
}

export function toAgentSummary(agent: Agent): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    status: agent.status as AgentStatus,
    version: agent.version,
    activeVersionId: agent.activeVersionId,
    modelId: agent.modelId,
    toolIds: [...agent.toolIds],
    createdAt: isoRequired(agent.createdAt),
    updatedAt: isoRequired(agent.updatedAt),
  };
}

export function toAgentVersionSummary(version: AgentVersion): AgentVersionSummary {
  return {
    id: version.id,
    version: version.version,
    createdAt: isoRequired(version.createdAt),
  };
}

export function toAgentDetail(
  agent: Agent,
  versions: AgentVersion[],
  counts: { goals: number; tasks: number; runs: number },
): AgentDetail {
  return {
    ...toAgentSummary(agent),
    instructions: agent.instructions,
    fallbackModelId: agent.fallbackModelId,
    mcpServerIds: [...agent.mcpServerIds],
    connectorAccountIds: [...agent.connectorAccountIds],
    memoryEnabled: agent.memoryEnabled,
    browserAccess: agent.browserAccess,
    sandboxAccess: agent.sandboxAccess,
    approvalPolicy: agent.approvalPolicy,
    executionLimits: agent.executionLimits,
    archivedAt: iso(agent.archivedAt),
    versions: versions.map(toAgentVersionSummary),
    counts,
  };
}

export function toGoalSummary(goal: Goal): GoalSummary {
  return {
    id: goal.id,
    title: goal.title,
    description: goal.description,
    agentId: goal.agentId,
    status: goal.status as GoalStatus,
    priority: goal.priority,
    deadline: iso(goal.deadline),
    completedVerificationId: goal.completedVerificationId,
    createdAt: isoRequired(goal.createdAt),
    updatedAt: isoRequired(goal.updatedAt),
    completedAt: iso(goal.completedAt),
  };
}

export function toGoalDetail(goal: Goal, counts: { tasks: number }): GoalDetail {
  return {
    ...toGoalSummary(goal),
    criteria: goal.criteria,
    constraints: goal.constraints,
    counts,
  };
}

export function toTaskSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    goalId: task.goalId,
    agentId: task.agentId,
    workflowId: task.workflowId,
    status: task.status as TaskStatus,
    priority: task.priority,
    triggerType: task.triggerType as TaskTriggerType,
    scheduledAt: iso(task.scheduledAt),
    scheduleId: task.scheduleId,
    eventSubscriptionId: task.eventSubscriptionId,
    retryCount: task.retryCount,
    error: task.error,
    startedAt: iso(task.startedAt),
    completedAt: iso(task.completedAt),
    createdAt: isoRequired(task.createdAt),
    updatedAt: isoRequired(task.updatedAt),
  };
}

export function toTaskDetail(task: Task, runIds: string[]): TaskDetail {
  return {
    ...toTaskSummary(task),
    input: task.input,
    output: task.output,
    runIds,
  };
}

export function toWorkflowStepDetail(step: WorkflowStep): WorkflowStepDetail {
  return {
    id: step.id,
    position: step.position,
    name: step.name,
    stepType: step.stepType as WorkflowStepType,
    config: step.config,
    dependsOn: [...step.dependsOn],
    retryPolicy: step.retryPolicy,
    timeoutMs: step.timeoutMs,
    onFail: step.onFail as WorkflowOnFail,
  };
}

export function toWorkflowVersionDetail(
  version: WorkflowVersion & { steps: WorkflowStep[] },
): WorkflowVersionDetail {
  return {
    id: version.id,
    version: version.version,
    createdAt: isoRequired(version.createdAt),
    steps: version.steps.map(toWorkflowStepDetail),
  };
}

export function toWorkflowSummary(workflow: Workflow): WorkflowSummary {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    status: workflow.status as WorkflowStatus,
    activeVersionId: workflow.activeVersionId,
    createdAt: isoRequired(workflow.createdAt),
    updatedAt: isoRequired(workflow.updatedAt),
  };
}

export function toWorkflowDetail(
  workflow: Workflow,
  versions: (WorkflowVersion & { steps: WorkflowStep[] })[],
): WorkflowDetail {
  return {
    ...toWorkflowSummary(workflow),
    versions: versions.map(toWorkflowVersionDetail),
  };
}
