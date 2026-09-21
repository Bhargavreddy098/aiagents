import { describe, expect, it } from 'vitest';
import { PLAN_STEP_TYPES, type PlanStep } from '@nexs/shared';
import {
  extractJsonValue,
  findCycle,
  formatIssuesForRetry,
  validatePlanText,
  validatePlanValue,
} from '../src/services/engine/plan.js';
import { planJsonSchema } from '../src/services/engine/planner.js';

const TOOL_A = 'tool_a';
const TOOL_B = 'tool_b';

const options = (overrides: Partial<{ allowedToolIds: Set<string>; maxSteps: number }> = {}) => ({
  allowedToolIds: new Set([TOOL_A, TOOL_B]),
  maxSteps: 10,
  ...overrides,
});

const step = (overrides: Partial<PlanStep> = {}): PlanStep => ({
  id: 's1',
  description: 'do the thing',
  stepType: 'transform',
  config: {},
  ...overrides,
});

/** The issue codes, in order — most assertions care about the set, not the prose. */
const codes = (result: ReturnType<typeof validatePlanValue>): string[] =>
  result.ok ? [] : result.issues.map((issue) => issue.code);

describe('extractJsonValue', () => {
  it('returns a bare JSON array unchanged', () => {
    expect(extractJsonValue('[{"a":1}]')).toBe('[{"a":1}]');
  });

  it('pulls the array out of a fenced code block', () => {
    expect(extractJsonValue('```json\n[{"a":1}]\n```')).toBe('[{"a":1}]');
  });

  it('ignores prose before and after the value', () => {
    expect(extractJsonValue('Here is the plan:\n[{"a":1}]\nHope that helps!')).toBe('[{"a":1}]');
  });

  it('stops at the end of the outermost value, not at the first closing bracket', () => {
    const text = '[{"a":[1,2,{"b":3}]}] trailing junk';
    expect(extractJsonValue(text)).toBe('[{"a":[1,2,{"b":3}]}]');
  });

  it('is not confused by brackets inside strings', () => {
    const text = '[{"a":"a ] bracket and a } brace"}]';
    expect(extractJsonValue(text)).toBe(text);
  });

  it('is not confused by an escaped quote inside a string', () => {
    const text = '[{"a":"he said \\"}\\" loudly"}]';
    expect(extractJsonValue(text)).toBe(text);
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJsonValue('I could not produce a plan.')).toBeNull();
  });

  it('returns null for an unbalanced value', () => {
    expect(extractJsonValue('[{"a":1}')).toBeNull();
  });

  it('returns null for an empty reply', () => {
    expect(extractJsonValue('   ')).toBeNull();
  });
});

describe('validatePlanText', () => {
  it('rejects a reply with no JSON, as not_json', () => {
    const result = validatePlanText('sorry, I cannot help with that', options());
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['not_json']);
  });

  it('rejects malformed JSON, as not_json', () => {
    const result = validatePlanText('[{"id": "a",}]', options());
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['not_json']);
  });

  it('accepts a valid plan wrapped in a code fence', () => {
    const result = validatePlanText(`\`\`\`json\n${JSON.stringify([step()])}\n\`\`\``, options());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan).toHaveLength(1);
  });
});

describe('validatePlanValue — the schema rung', () => {
  it('reports a missing required field', () => {
    const result = validatePlanValue([{ id: 'a', stepType: 'transform', config: {} }], options());
    expect(codes(result)).toEqual(['schema']);
    if (!result.ok) expect(result.issues[0]!.path).toBe('0.description');
  });

  it('rejects an unknown key rather than silently dropping it', () => {
    // The whole point of `.strict()`: `type` instead of `stepType` must be reported as an
    // unrecognised key, because that is an instruction the model can follow, whereas the
    // default strip behaviour would report it as a *missing* field and send the correction
    // retry looking in the wrong place.
    //
    // Two issues are expected — "unrecognized key" and "required" — and the first is the
    // one that names the actual mistake.
    const result = validatePlanValue(
      [{ id: 'a', description: 'x', type: 'transform', config: {} }],
      options(),
    );
    expect(codes(result)).toEqual(['schema', 'schema']);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/unrecognized key/i);
    }
  });

  it('rejects a stepType outside the vocabulary', () => {
    const result = validatePlanValue(
      [{ id: 'a', description: 'x', stepType: 'teleport', config: {} }],
      options(),
    );
    expect(codes(result)).toEqual(['schema']);
  });

  it('collects every schema issue in one pass', () => {
    const result = validatePlanValue(
      [{ id: '', description: '', stepType: 'transform', config: {} }],
      options(),
    );
    expect(codes(result).filter((code) => code === 'schema').length).toBeGreaterThan(1);
  });

  it('defaults a missing config to an empty object', () => {
    const result = validatePlanValue([{ id: 'a', description: 'x', stepType: 'transform' }], options());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan[0]!.config).toEqual({});
  });

  it('rejects a bare object where an array is required', () => {
    const result = validatePlanValue({ steps: [step()] }, options());
    expect(codes(result)).toEqual(['schema']);
  });
});

describe('validatePlanValue — the semantic rungs', () => {
  it('rejects an empty plan', () => {
    expect(codes(validatePlanValue([], options()))).toEqual(['empty_plan']);
  });

  it('rejects a plan over the step budget', () => {
    const plan = Array.from({ length: 4 }, (_unused, index) => step({ id: `s${index}` }));
    expect(codes(validatePlanValue(plan, options({ maxSteps: 3 })))).toEqual(['too_many_steps']);
  });

  it('rejects duplicate step ids', () => {
    const plan = [step({ id: 'dup' }), step({ id: 'dup' })];
    expect(codes(validatePlanValue(plan, options()))).toEqual(['duplicate_id']);
  });

  it('does not report dependency problems when ids are duplicated', () => {
    // The graph is not well-defined while ids collide, so follow-on errors would be
    // artefacts of the duplication and would mislead the correction retry.
    const plan = [step({ id: 'dup', dependsOn: ['nope'] }), step({ id: 'dup' })];
    expect(codes(validatePlanValue(plan, options()))).toEqual(['duplicate_id']);
  });

  it('rejects a tool step with no toolId', () => {
    const plan = [step({ stepType: 'tool' })];
    expect(codes(validatePlanValue(plan, options()))).toEqual(['missing_tool_id']);
  });

  it('rejects a toolId outside the allowlist', () => {
    const plan = [step({ stepType: 'tool', toolId: 'tool_elsewhere' })];
    expect(codes(validatePlanValue(plan, options()))).toEqual(['unknown_tool']);
  });

  it('accepts a toolId inside the allowlist', () => {
    const plan = [step({ stepType: 'tool', toolId: TOOL_A })];
    expect(validatePlanValue(plan, options()).ok).toBe(true);
  });

  it('rejects a self-dependency', () => {
    const plan = [step({ id: 'a', dependsOn: ['a'] })];
    expect(codes(validatePlanValue(plan, options()))).toEqual(['self_dependency']);
  });

  it('rejects a dependency on a step that is not in the plan', () => {
    const plan = [step({ id: 'a', dependsOn: ['ghost'] })];
    expect(codes(validatePlanValue(plan, options()))).toEqual(['unknown_dependency']);
  });

  it('rejects a two-step cycle', () => {
    const plan = [
      step({ id: 'a', dependsOn: ['b'] }),
      step({ id: 'b', dependsOn: ['a'] }),
    ];
    expect(codes(validatePlanValue(plan, options()))).toEqual(['cyclic']);
  });

  it('names the cycle in the message so the retry can act on it', () => {
    const plan = [
      step({ id: 'a', dependsOn: ['c'] }),
      step({ id: 'b', dependsOn: ['a'] }),
      step({ id: 'c', dependsOn: ['b'] }),
    ];
    const result = validatePlanValue(plan, options());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cyclic = result.issues.find((issue) => issue.code === 'cyclic');
      expect(cyclic?.message).toMatch(/a → c → b → a|c → b → a → c|b → a → c → b/);
    }
  });

  it('reports independent problems together rather than one at a time', () => {
    // The single correction retry has to fix everything at once, so the ladder must not
    // stop at the first issue it finds.
    const plan = [
      step({ id: 'a', stepType: 'tool' }),
      step({ id: 'b', stepType: 'tool', toolId: 'tool_ghost' }),
      step({ id: 'c', dependsOn: ['nowhere'] }),
    ];
    expect(codes(validatePlanValue(plan, options())).sort()).toEqual([
      'missing_tool_id',
      'unknown_dependency',
      'unknown_tool',
    ]);
  });

  it('accepts a well-formed plan with a valid dependency chain', () => {
    const plan = [
      step({ id: 'fetch', stepType: 'tool', toolId: TOOL_A }),
      step({ id: 'check', dependsOn: ['fetch'], stepType: 'verification', config: { type: 'content' } }),
    ];
    const result = validatePlanValue(plan, options());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.map((entry) => entry.id)).toEqual(['fetch', 'check']);
  });
});

describe('findCycle', () => {
  const graph = (plan: PlanStep[]) => findCycle(plan, new Map(plan.map((entry) => [entry.id, entry])));

  it('returns null for a diamond', () => {
    const plan = [
      step({ id: 'a' }),
      step({ id: 'b', dependsOn: ['a'] }),
      step({ id: 'c', dependsOn: ['a'] }),
      step({ id: 'd', dependsOn: ['b', 'c'] }),
    ];
    expect(graph(plan)).toBeNull();
  });

  it('finds a cycle in a graph that also has acyclic parts', () => {
    const plan = [
      step({ id: 'root' }),
      step({ id: 'x', dependsOn: ['root', 'y'] }),
      step({ id: 'y', dependsOn: ['x'] }),
    ];
    expect(graph(plan)).not.toBeNull();
  });

  it('survives a dependency chain far deeper than the call stack', () => {
    // A recursive DFS would throw a RangeError here. `maxSteps` bounds the *count* of
    // steps, not the depth of a chain, so the traversal has to be iterative.
    const plan = Array.from({ length: 5_000 }, (_unused, index) =>
      step({ id: `s${index}`, dependsOn: index === 0 ? [] : [`s${index - 1}`] }),
    );
    expect(() => graph(plan)).not.toThrow();
    expect(graph(plan)).toBeNull();
  });

  it('ignores self-references, which are reported separately', () => {
    expect(graph([step({ id: 'a', dependsOn: ['a'] })])).toBeNull();
  });
});

describe('the JSON schema and the ladder agree', () => {
  it('uses the same step-type vocabulary', () => {
    const schema = planJsonSchema() as {
      items: { properties: { stepType: { enum: string[] } } };
    };
    expect(schema.items.properties.stepType.enum).toEqual([...PLAN_STEP_TYPES]);
  });

  it('accepts every stepType the ladder accepts', () => {
    for (const stepType of PLAN_STEP_TYPES) {
      // A `tool` step additionally needs a toolId, which is a separate rung's business.
      const candidate = stepType === 'tool' ? step({ stepType, toolId: TOOL_A }) : step({ stepType });
      const result = validatePlanValue([candidate], options());
      expect(result.ok, `stepType ${stepType} should be valid`).toBe(true);
    }
  });

  it('requires the fields the ladder requires', () => {
    const schema = planJsonSchema() as { items: { required: string[] } };
    expect(schema.items.required).toEqual(['id', 'description', 'stepType', 'config']);
  });
});

describe('formatIssuesForRetry', () => {
  const issues = [
    { path: 'steps[0].toolId', code: 'unknown_tool' as const, message: 'no such tool' },
  ];

  it('lists every issue with its code and location', () => {
    const message = formatIssuesForRetry(issues);
    expect(message).toContain('[unknown_tool]');
    expect(message).toContain('steps[0].toolId');
    expect(message).toContain('no such tool');
  });

  it('re-lists the valid tool ids when the failure was a tool reference', () => {
    // The failure is almost always a transcription error on an opaque id, so handing the
    // model the exact strings turns the fix into a substitution rather than a guess.
    const message = formatIssuesForRetry(issues, [{ id: TOOL_A, name: 'http_request' }]);
    expect(message).toContain(TOOL_A);
    expect(message).toContain('http_request');
  });

  it('omits the tool list when it would not help', () => {
    const message = formatIssuesForRetry(
      [{ path: '', code: 'cyclic', message: 'a cycle' }],
      [{ id: TOOL_A, name: 'http_request' }],
    );
    expect(message).not.toContain(TOOL_A);
  });
});
