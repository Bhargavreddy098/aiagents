/**
 * Reading the configuration block a run describes for itself.
 *
 * A run's configuration comes from one of two places: the `AgentVersion` it pinned, or —
 * for an ad-hoc, chat or agent-less run — a `context` block in `Run.input`. This module is
 * the single place that knows how to read the second one.
 *
 * ## Why this is a module and not three private helpers
 *
 * Three services needed the same two questions answered — "is there a context block?" and
 * "does it name a model?" — and each answered them with its own copy of the same six lines.
 * That is how a rule drifts: one copy learns that `modelId` must be a non-empty string and
 * the others keep accepting `''`, and then a run that one path accepts fails on another.
 * The rule is stated once here.
 *
 * The check that matters is `readModelId`, because `RunContext.modelId` is required and the
 * resolver throws without one. A service that can create a run which is *guaranteed* to fail
 * — because there is no agent to supply a model and no model in the input — should say so
 * while the caller is still there to fix it, rather than handing back a 201 and a run that
 * dies moments later.
 */

/** The caller's `input.context` block, or `{}` if the input does not carry one. */
export function readContextBlock(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {};
  const context = (input as Record<string, unknown>)['context'];
  if (context === null || typeof context !== 'object' || Array.isArray(context)) return {};
  return context as Record<string, unknown>;
}

/**
 * The model the run names for itself, if any.
 *
 * An empty string counts as absent. The resolver treats it the same way (`modelId.length
 * === 0` throws), and a service that accepted `''` here would wave through exactly the run
 * the resolver is about to reject.
 */
export function readModelId(input: unknown): string | undefined {
  const modelId = readContextBlock(input)['modelId'];
  return typeof modelId === 'string' && modelId.length > 0 ? modelId : undefined;
}

/**
 * Whether a run created with this input can resolve a model at all.
 *
 * True when the run names an agent — the agent's pinned version supplies the model — or
 * names a model itself.
 */
export function canResolveModel(input: {
  agentId?: string | null;
  input?: unknown;
}): boolean {
  if (input.agentId !== undefined && input.agentId !== null) return true;
  return readModelId(input.input) !== undefined;
}
