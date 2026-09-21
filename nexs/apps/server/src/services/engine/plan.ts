import {
  planSchema,
  type PlanStep,
  type PlanValidationIssue,
  type PlanValidationResult,
} from '@nexs/shared';

/**
 * The validation ladder — §5.3's five rungs, plus the ones that turned out to be necessary.
 *
 * A plan is a *program*. It is produced by a language model, it decides what tools run and
 * in what order, and the engine will execute it against real systems. So it is treated the
 * way a compiler treats source: nothing runs until every rung has been passed, and a
 * failure produces a message specific enough to act on.
 *
 * The rungs, in order, and why each one is where it is:
 *
 *  1. **Extract and parse.** Fail fast, one issue. Every later rung needs a value to
 *     inspect, and "this is not JSON" is the only thing worth saying when it is not.
 *  2. **Schema.** Fail fast after collecting *all* zod issues, because a plan that does not
 *     match the shape has no reliable ids to check dependencies against.
 *  3. **Semantics.** Collect everything: emptiness, the step budget, duplicate ids,
 *     `tool` steps without a tool, tool ids outside the allowlist, and the dependency
 *     graph. These are mutually independent once the array is well-formed, so a plan with
 *     three problems reports three problems and the single correction retry gets to fix
 *     all of them at once. Failing fast here would burn the retry on the first issue.
 *
 * The order inside rung 3 is cheapest-first only by accident; what matters is that the
 * *allowlist* check happens before the graph check, because "you used a tool you do not
 * have" is a more useful thing to lead with than a downstream consequence of it.
 */

export interface PlanValidationOptions {
  /** Tool ids the agent is allowed to use. Anything outside this set is rejected. */
  allowedToolIds: ReadonlySet<string>;
  maxSteps: number;
}

// ── rung 1: extraction ────────────────────────────────────────────────────────

/**
 * Pull the first complete JSON value out of a model's reply.
 *
 * A model asked for JSON will usually give JSON, and will sometimes give a fenced code
 * block, a sentence of preamble, or both. Rejecting those outright would spend the single
 * correction retry on a formatting difference that has no bearing on whether the plan is
 * safe, so the extraction is forgiving about *packaging* and strict about *content*.
 *
 * It is not forgiving about structure: a reply containing two JSON values yields the
 * first one, and the second is ignored rather than merged. Merging would be a way for a
 * model to append steps that the schema rung never sees as a whole.
 */
export function extractJsonValue(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const start = findFirstDelimiter(trimmed);
  if (start === -1) return null;

  // Only the opener is needed. The scan below counts depth and treats `}` and `]` alike,
  // because a well-formed value's depth returns to zero only at its own closing delimiter —
  // so there is nothing to gain from remembering which closer this particular opener wants.
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      // Depth can only return to zero at the delimiter that opened this value, so the
      // first time it does is the end of the outermost value.
      if (depth === 0) return trimmed.slice(start, index + 1);
      if (depth < 0) return null; // unbalanced — the reply is malformed
    }
  }

  return null;
}

function findFirstDelimiter(text: string): number {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '[' || char === '{') return index;
  }
  return -1;
}

// ── rungs 2–3 ─────────────────────────────────────────────────────────────────

export function validatePlanText(
  text: string,
  options: PlanValidationOptions,
): PlanValidationResult {
  const extracted = extractJsonValue(text);
  if (extracted === null) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          code: 'not_json',
          message:
            'No JSON array was found in the reply. Respond with a single JSON array of step objects and nothing else.',
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (cause) {
    return {
      ok: false,
      issues: [
        {
          path: '',
          code: 'not_json',
          message: `The reply was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      ],
    };
  }

  return validatePlanValue(parsed, options);
}

export function validatePlanValue(
  value: unknown,
  options: PlanValidationOptions,
): PlanValidationResult {
  // ── rung 2: schema ──────────────────────────────────────────────────────────
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: 'schema',
        message: issue.message,
      })),
    };
  }

  const plan = parsed.data;

  // ── rung 3: semantics ───────────────────────────────────────────────────────
  const issues: PlanValidationIssue[] = [];

  if (plan.length === 0) {
    issues.push({
      path: '',
      code: 'empty_plan',
      message: 'The plan has no steps. Return at least one step.',
    });
    // Every check below is vacuous or misleading for an empty plan.
    return { ok: false, issues };
  }

  if (plan.length > options.maxSteps) {
    issues.push({
      path: '',
      code: 'too_many_steps',
      message: `The plan has ${plan.length} steps but at most ${options.maxSteps} are allowed. Combine or remove steps.`,
    });
  }

  // Duplicate ids first: the dependency checks below assume id → step is a function, and
  // a duplicated id would make "unknown dependency" and "cycle" report nonsense.
  const byId = new Map<string, PlanStep>();
  const duplicates = new Set<string>();
  for (const step of plan) {
    if (byId.has(step.id)) duplicates.add(step.id);
    else byId.set(step.id, step);
  }
  for (const id of duplicates) {
    issues.push({
      path: '',
      code: 'duplicate_id',
      message: `Step id "${id}" is used more than once. Every step id must be unique within the plan.`,
    });
  }

  plan.forEach((step, index) => {
    if (step.stepType === 'tool' && (step.toolId === undefined || step.toolId.length === 0)) {
      issues.push({
        path: `steps[${index}].toolId`,
        code: 'missing_tool_id',
        message: `Step "${step.id}" is a tool step but has no toolId.`,
      });
    }
    if (step.toolId !== undefined && !options.allowedToolIds.has(step.toolId)) {
      issues.push({
        path: `steps[${index}].toolId`,
        code: 'unknown_tool',
        message: `Step "${step.id}" uses tool "${step.toolId}", which is not in this agent's allowed tools.`,
      });
    }
  });

  if (duplicates.size > 0) {
    // The graph is only well-defined when ids are unique, so stop rather than emit
    // follow-on errors that are artefacts of the duplication.
    return { ok: false, issues };
  }

  for (const step of plan) {
    for (const dependency of step.dependsOn ?? []) {
      if (dependency === step.id) {
        issues.push({
          path: `steps.${step.id}.dependsOn`,
          code: 'self_dependency',
          message: `Step "${step.id}" depends on itself.`,
        });
        continue;
      }
      if (!byId.has(dependency)) {
        issues.push({
          path: `steps.${step.id}.dependsOn`,
          code: 'unknown_dependency',
          message: `Step "${step.id}" depends on "${dependency}", which is not a step in this plan.`,
        });
      }
    }
  }

  const cycle = findCycle(plan, byId);
  if (cycle !== null) {
    issues.push({
      path: '',
      code: 'cyclic',
      message: `The dependencies form a cycle: ${cycle.join(' → ')}. A plan must be executable in a linear order.`,
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, plan };
}

// ── cycle detection ───────────────────────────────────────────────────────────

/**
 * Iterative depth-first search with the usual three colours.
 *
 * Iterative rather than recursive because the input is model-generated and a plan with a
 * deep dependency chain would otherwise be able to blow the stack — a crash is a much
 * worse failure mode than a rejected plan, and `maxSteps` bounds the *count* of steps, not
 * the depth of a chain.
 *
 * Returns the cycle as a path for the error message, or `null` when the graph is acyclic.
 */
export function findCycle(plan: readonly PlanStep[], byId: Map<string, PlanStep>): string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const step of plan) colour.set(step.id, WHITE);

  for (const root of plan) {
    if (colour.get(root.id) !== WHITE) continue;

    const path: string[] = [];
    const stack: Array<{ id: string; dependencies: string[]; index: number }> = [
      { id: root.id, dependencies: dependenciesOf(root, byId), index: 0 },
    ];
    colour.set(root.id, GREY);
    path.push(root.id);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;

      if (frame.index >= frame.dependencies.length) {
        colour.set(frame.id, BLACK);
        stack.pop();
        path.pop();
        continue;
      }

      const next = frame.dependencies[frame.index]!;
      frame.index += 1;

      const state = colour.get(next);
      if (state === BLACK) continue;
      if (state === GREY) {
        // `next` is on the current path, so the cycle is the path from `next` onwards.
        const start = path.indexOf(next);
        return [...path.slice(start === -1 ? 0 : start), next];
      }

      const step = byId.get(next);
      if (step === undefined) continue; // already reported as an unknown dependency

      colour.set(next, GREY);
      path.push(next);
      stack.push({ id: next, dependencies: dependenciesOf(step, byId), index: 0 });
    }
  }

  return null;
}

function dependenciesOf(step: PlanStep, byId: Map<string, PlanStep>): string[] {
  const declared = step.dependsOn ?? [];
  // Filter out self-references and unknown ids: both are reported separately, and letting
  // them into the graph would produce a cycle message for what is really a typo.
  return declared.filter((id) => id !== step.id && byId.has(id));
}

// ── error rendering ───────────────────────────────────────────────────────────

/**
 * The message handed back to the model on the correction retry.
 *
 * Deliberately a plain list rather than JSON: the model has to *read* this, and the
 * failure mode being corrected is usually that it produced a shape it did not intend.
 * Repeating the structure back in a different serialisation invites it to fix the
 * serialisation instead of the plan.
 *
 * `tools` is re-listed when the plan referenced a tool that is not allowed, because that
 * is almost always a transcription error on an opaque id rather than a misunderstanding,
 * and handing the model the exact strings to copy turns the fix from a guess into a
 * substitution. It is omitted when it would not help, so the message stays short enough
 * to actually be read.
 */
export function formatIssuesForRetry(
  issues: readonly PlanValidationIssue[],
  tools: readonly { id: string; name: string }[] = [],
): string {
  const lines = issues.map((issue, index) => {
    const where = issue.path.length === 0 ? 'plan' : issue.path;
    return `${index + 1}. [${issue.code}] at ${where}: ${issue.message}`;
  });

  const needsToolList = issues.some(
    (issue) => issue.code === 'unknown_tool' || issue.code === 'missing_tool_id',
  );

  return [
    'That plan was rejected. The specific problems were:',
    '',
    ...lines,
    ...(needsToolList && tools.length > 0
      ? [
          '',
          'The only valid toolId values, exactly as written:',
          ...tools.map((tool) => `- ${tool.id}  (${tool.name})`),
        ]
      : []),
    '',
    'Return a corrected JSON array of steps. Keep the same intent, fix only what is listed, and reply with JSON only.',
  ].join('\n');
}
