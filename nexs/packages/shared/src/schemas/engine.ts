import { z } from 'zod';
import { PLAN_STEP_TYPES } from '../types/engine.js';

/**
 * The plan schema — the first rung of the validation ladder.
 *
 * Two decisions worth stating, because both are load-bearing:
 *
 * **`.strict()` on the step.** The planner is a language model, and the most common way
 * for it to get this wrong is not to omit a field but to rename one — `type` instead of
 * `stepType`, `depends_on` instead of `dependsOn`. Under the default (strip) behaviour
 * that arrives as a *missing* required field, and the correction retry is told "required"
 * when what actually happened is a naming mistake it could fix. Strict mode turns it into
 * "unrecognized key `type`", which is an instruction the model can follow. The cost is
 * that a harmless extra key fails the plan; the ladder's single correction retry is the
 * budget for exactly that.
 *
 * **No `.min(1)` on the plan array here.** Emptiness is a *ladder* rung, not a schema
 * rung, because "you returned zero steps" deserves a different correction message than
 * "step 0 is malformed", and folding them together would lose that distinction.
 */

const idSchema = z
  .string()
  .trim()
  .min(1, 'step id must not be empty')
  .max(64, 'step id must be at most 64 characters');

export const planStepSchema = z
  .object({
    id: idSchema,
    description: z.string().trim().min(1, 'description must not be empty').max(500),
    stepType: z.enum(PLAN_STEP_TYPES),
    toolId: z.string().trim().min(1).max(64).optional(),
    config: z.record(z.string(), z.unknown()).default({}),
    dependsOn: z.array(idSchema).optional(),
  })
  .strict();

export const planSchema = z.array(planStepSchema);

export type PlanStepInput = z.infer<typeof planStepSchema>;
