import {
  PLAN_STEP_TYPES,
  type ChatMessage,
  type PlanStep,
  type PlanValidationIssue,
  type ToolDefinition,
} from '@nexs/shared';
import type { Logger } from '../../logger.js';
import type { ToolRepository } from '../../repositories/mcp.repo.js';
import type { ModelGateway } from '../gateway/model-gateway.js';
import { formatIssuesForRetry, validatePlanText } from './plan.js';

/**
 * The planner — one gateway call, one validated plan.
 *
 * The shape of this class is a consequence of two constraints that pull in opposite
 * directions. The plan has to be *valid* (the engine will execute it against real
 * systems), and it is produced by a model that will sometimes get it wrong. The
 * resolution in §5.3 is a single correction retry carrying the exact validation error, and
 * that budget of exactly one is what most of the decisions here are about.
 *
 * **One retry, not a loop.** A model that has been told precisely what is wrong and gets
 * it wrong again is not going to be helped by a third attempt; it is more likely to be
 * producing something the ladder will never accept, and every extra attempt is another
 * paid call and another thirty seconds of a user watching a spinner. Failing the run with
 * a structured error is the honest outcome, and it is the one an operator can act on.
 *
 * **The retry carries the model's own output back to it.** Sending only "that was wrong,
 * try again" makes the second attempt a fresh sample from the same distribution, which is
 * roughly a coin flip on the same mistake. Sending the rejected reply as an assistant turn
 * followed by the specific issues turns it into an edit.
 *
 * **Tools are only offered if they exist.** The allowlist is intersected with the tools
 * that are actually rows for this tenant, and the *intersection* is what both the model
 * sees and the ladder enforces. Offering a tool the ladder will reject would guarantee a
 * wasted retry; enforcing an allowlist wider than what was offered would let a
 * hallucinated tool id through if it happened to match an allowed-but-missing one.
 */

/**
 * A tool as the planner presents it to the model.
 *
 * The identifier handed to the provider is the `Tool` row's **id**, not its name, and the
 * human name goes into the description. That is a deliberate trade and it is worth being
 * explicit about, because the alternative looks more natural.
 *
 * Using the name as the identifier would read better to a model — `http_request` is a more
 * legible token than `clx8f2a9b0001`. But then the plan's `toolId` holds a *name*, and the
 * engine needs the *id*, so a translation has to happen between validation and execution.
 * That translation is where this would go wrong: a name is only unique per
 * `(tenantId, source)` in the schema, so two sources can offer the same name, and the
 * resolution would silently pick one. Keeping a single identifier from the prompt through
 * to the `ToolCall` row means there is nothing to resolve and nothing to get wrong.
 *
 * The cost is that a model has to copy a longer opaque string, which it will occasionally
 * fumble. That is what the correction retry is for, and the retry message re-lists the
 * valid ids precisely so the fix is mechanical.
 */
interface PlannerTool {
  id: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * The gateway as the planner uses it: one method.
 *
 * A `Pick`-derived port rather than the concrete class, matching `repositories/ports.ts`.
 * The planner calls `chat` and nothing else, so depending on the whole gateway would mean
 * a test had to construct a circuit breaker, a vault and four repositories to plan one
 * step — and would let the planner start reaching for `embed` or `stream` without anyone
 * noticing the dependency had grown.
 */
export type PlannerGateway = Pick<ModelGateway, 'chat'>;

export interface PlannerDeps {
  gateway: PlannerGateway;
  tools: ToolRepository;
  logger: Logger;
}

export interface PlanRequest {
  tenantId: string;
  runId: string;
  /** The model that will plan. Chosen by the agent, not by the planner. */
  modelId: string;
  /** The agent's standing instructions. */
  instructions: string;
  goal?: string | null;
  task?: string | null;
  /** The run's input payload, rendered into the prompt. */
  input: unknown;
  /** Tool ids the agent is permitted to use. */
  allowedToolIds: readonly string[];
  maxSteps: number;
}

/**
 * Thrown when the ladder rejects the plan on both attempts.
 *
 * A domain error rather than an `ApiError`: this never crosses HTTP, and the engine needs
 * the issue list itself in order to write a structured `Run.error` that the UI can render.
 */
export class PlanValidationError extends Error {
  constructor(
    message: string,
    readonly issues: readonly PlanValidationIssue[],
    readonly attempts: number,
  ) {
    super(message);
    this.name = 'PlanValidationError';
  }
}

/**
 * Raised when the agent has no tools to plan with.
 *
 * This **fails the run** with `PLAN_FAILED` — it does not complete it. A run that was asked
 * to do something and did nothing has not succeeded, and reporting `completed` for it would
 * put a status on screen that does not trace to what actually happened. The condition is
 * not an internal fault either: it is a configuration the operator can fix, so it must not
 * be reported as one.
 *
 * It is thrown before the model is asked anything. Spending a model call to have it plan
 * around an empty tool list would only produce a plan that fails on its first step, and the
 * operator would have to read the model's output to discover a fact the engine already knew.
 */
export class EmptyPlanError extends Error {
  constructor() {
    super(
      'The agent has no tools available, so there is nothing to plan. ' +
        'Grant it at least one enabled tool, or supply a preset plan.',
    );
    this.name = 'EmptyPlanError';
  }
}

export class Planner {
  constructor(private readonly deps: PlannerDeps) {}

  async plan(request: PlanRequest): Promise<PlanStep[]> {
    const { tools, allowed } = await this.resolveTools(request);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(request, tools) },
      { role: 'user', content: userPrompt(request) },
    ];

    const options = {
      tenantId: request.tenantId,
      runId: request.runId,
      stepId: null,
      modelId: request.modelId,
      messages,
      tools: toToolDefinitions(tools),
      // Planning must be reproducible: the same task planned twice should produce the same
      // plan, so that a crash-resume that re-plans does not silently execute a different
      // program than the one the operator approved.
      temperature: 0,
      responseFormat: {
        name: 'execution_plan',
        schema: planJsonSchema(),
        strict: true,
      },
    };

    const first = await this.deps.gateway.chat(options);
    const firstAttempt = validatePlanText(first.content, {
      allowedToolIds: allowed,
      maxSteps: request.maxSteps,
    });
    if (firstAttempt.ok) {
      this.deps.logger.debug({ runId: request.runId, steps: firstAttempt.plan.length }, 'plan accepted');
      return firstAttempt.plan;
    }

    this.deps.logger.warn(
      { runId: request.runId, issues: firstAttempt.issues.length },
      'plan rejected, attempting one correction',
    );

    // The correction retry. `messages` is extended rather than rebuilt so the model sees
    // its own output in context; `assistant` + `user` is the transcript of a review.
    const retryMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: first.content },
      { role: 'user', content: formatIssuesForRetry(firstAttempt.issues, tools) },
    ];

    const second = await this.deps.gateway.chat({ ...options, messages: retryMessages });
    const secondAttempt = validatePlanText(second.content, {
      allowedToolIds: allowed,
      maxSteps: request.maxSteps,
    });
    if (secondAttempt.ok) {
      this.deps.logger.info({ runId: request.runId }, 'plan accepted on correction');
      return secondAttempt.plan;
    }

    throw new PlanValidationError(
      'The planner did not produce a valid plan after one correction.',
      secondAttempt.issues,
      2,
    );
  }

  /**
   * The tools the model may choose from, and the allowlist the ladder will enforce.
   *
   * Returned together on purpose. They have to be the same set, and computing them in one
   * place is what makes that true by construction rather than by remembering.
   */
  private async resolveTools(
    request: PlanRequest,
  ): Promise<{ tools: PlannerTool[]; allowed: Set<string> }> {
    if (request.allowedToolIds.length === 0) throw new EmptyPlanError();

    const rows = await this.deps.tools.list(request.tenantId);
    const wanted = new Set(request.allowedToolIds);

    const tools: PlannerTool[] = [];
    const allowed = new Set<string>();

    for (const row of rows) {
      if (!wanted.has(row.id)) continue;
      // A disabled or errored tool is not offered. The engine would refuse to run it
      // anyway, so offering it would only produce a plan that fails at execution.
      if (row.status !== 'enabled') continue;

      allowed.add(row.id);
      tools.push({
        id: row.id,
        name: row.name,
        description: row.description ?? row.name,
        inputSchema: row.inputSchema,
      });
    }

    if (allowed.size === 0) throw new EmptyPlanError();
    return { tools, allowed };
  }
}

/** The provider-facing shape. The id is the name; the human name leads the description. */
function toToolDefinitions(tools: readonly PlannerTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.id,
    description: `${tool.name} — ${tool.description}`,
    inputSchema: tool.inputSchema,
  }));
}

// ── prompts ───────────────────────────────────────────────────────────────────

function systemPrompt(request: PlanRequest, tools: readonly PlannerTool[]): string {
  const toolLines = tools.map(
    (tool) =>
      `- toolId "${tool.id}" — ${tool.name}: ${tool.description}\n  input schema: ${JSON.stringify(tool.inputSchema)}`,
  );

  return [
    request.instructions.trim().length === 0
      ? 'You are an execution planner for an autonomous agent.'
      : request.instructions.trim(),
    '',
    'You produce a plan: an ordered list of steps that achieves the goal. The steps are',
    'executed by a runtime that supports these step types:',
    '',
    '- "tool": call one of the tools listed below. Requires "toolId".',
    '- "model": ask the language model to reason over the outputs so far.',
    '- "transform": reshape data with a deterministic operation, no model and no tools.',
    '- "condition": branch on a value from a previous step.',
    '- "verification": assert something is true, so the run can prove it succeeded.',
    '- "approval": stop and wait for a human to approve before continuing.',
    '',
    'Available tools:',
    ...toolLines,
    '',
    'Rules:',
    `- Produce at most ${request.maxSteps} steps. Fewer is better; do not pad.`,
    '- Every step needs a unique "id" (a short slug), a "description" in plain language,',
    '  a "stepType", and a "config" object.',
    '- A "tool" step\'s "config" holds that tool\'s arguments, matching its input schema,',
    '  and its "toolId" must be one of the ids listed above.',
    '- Use "dependsOn" to list the ids of steps that must finish first. Do not create cycles.',
    '- Use a "verification" step whenever the goal names a condition that can be checked.',
    '- The "description" is shown to a human operator. Write it for them, not for yourself.',
    '- Do not narrate. Reply with the JSON array and nothing else.',
  ].join('\n');
}

function userPrompt(request: PlanRequest): string {
  const parts: string[] = [];
  if (request.goal !== undefined && request.goal !== null && request.goal.length > 0) {
    parts.push(`Goal: ${request.goal}`);
  }
  if (request.task !== undefined && request.task !== null && request.task.length > 0) {
    parts.push(`Task: ${request.task}`);
  }
  parts.push(`Input: ${renderInput(request.input)}`);
  return parts.join('\n\n');
}

function renderInput(input: unknown): string {
  if (input === undefined || input === null) return '(none)';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * The JSON Schema handed to the provider for structured output.
 *
 * Built from `PLAN_STEP_TYPES` rather than written out, so the enum cannot drift from the
 * one the ladder enforces. The rest of the shape is a hand-written mirror of
 * `planSchema`, and that duplication is real: deriving it from zod would mean adding
 * `zod-to-json-schema` as a dependency for one schema. The two are kept in step by the
 * plan tests, which assert that a value the schema accepts is a value the ladder accepts
 * and that a `stepType` outside the enum is rejected by both.
 */
export function planJsonSchema(): unknown {
  return {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique slug for this step.' },
        description: { type: 'string' },
        stepType: { type: 'string', enum: [...PLAN_STEP_TYPES] },
        toolId: { type: 'string', description: 'Required when stepType is "tool".' },
        config: { type: 'object' },
        dependsOn: { type: 'array', items: { type: 'string' } },
      },
      required: ['id', 'description', 'stepType', 'config'],
      additionalProperties: false,
    },
  };
}
