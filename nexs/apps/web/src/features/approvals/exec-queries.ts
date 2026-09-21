/**
 * The exec half of the approval surface (§4.4 / UI-UX v2 §4.4).
 *
 * ## Why this is a separate module from `queries.ts`
 *
 * Same table, different question, and the server already said so: `routes/approvals.ts` mounts
 * `POST /exec`, `POST /exec/check`, `GET /exec/rules` and `POST /exec/rules/:id/revoke` from a
 * *different controller* than the inbox routes, and `POST /:id/decide-exec` from a different
 * schema. The vocabularies genuinely differ: a plan step is approved or rejected, whereas a shell
 * command may be **always** allowed, which writes a standing permission that outlives the request.
 *
 * Keeping them in one module would mean an `ExecAllowlistRuleSummary` and an `ApprovalSummary`
 * living under one heading with a comment explaining which is which. Two modules, one per
 * vocabulary, is what the server's own file split already models.
 *
 * ## The rule that makes `allow_always` legible
 *
 * A standing rule is granted for a command **and its args as a prefix** in a specific `cwd`, and
 * `execCommandMatches` on the server compares args element-wise — a rule for `['test']` covers
 * `['test','--watch']` and refuses `['test-evil']`. The rules list therefore renders all three
 * fields rather than the command alone: a rule shown as `npm` without its `cwd` is a permission
 * the operator cannot evaluate.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApprovalDetail,
  ApprovalSummary,
  DecideExecApprovalInput,
  ExecAllowlistRuleSummary,
} from '@nexs/shared';
import { apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

/**
 * The answer to "is this already permitted?".
 *
 * `reason` is prose for a log line, never a substitute for `allowed` — the server says the same
 * thing in its own doc comment, and a client that branched on the sentence would break the moment
 * it was reworded. So callers read `allowed` and render `reason` as the explanation.
 */
export interface ExecCheckResult {
  allowed: boolean;
  rule: ExecAllowlistRuleSummary | null;
  reason: string;
}

/** What deciding an exec approval did — and whether it left a standing rule behind. */
export interface ExecDecisionResult {
  approval: ApprovalDetail;
  /** The run the command belonged to, or null when it belonged to none. */
  runOutcome: { status: string; runId: string } | null;
  /** The rule `allow_always` created. Null for `allow_once` and `deny`. */
  createdRule: ExecAllowlistRuleSummary | null;
}

/**
 * The exec approvals in the inbox.
 *
 * There is no separate list route: an exec approval is an `Approval` row with `kind: 'exec'`, and
 * it comes back from `GET /approvals` like any other. What this filters is the *shape* — a
 * `tool` approval has no command to show and no "Allow always" to offer, and rendering the exec
 * card for one would put a three-option control over a two-option decision.
 *
 * The inbox query itself is `useApprovals` in `queries.ts`; this narrows it rather than fetching
 * again, so the sidebar's pending badge and this list can never disagree.
 */
export function splitApprovalsByKind(approvals: readonly ApprovalSummary[]): {
  tool: ApprovalSummary[];
  exec: ApprovalSummary[];
} {
  const tool: ApprovalSummary[] = [];
  const exec: ApprovalSummary[] = [];
  for (const approval of approvals) {
    // `kind` is not on `ApprovalSummary` — the summary carries the decision fields and the
    // `requestedAction` that distinguishes them lives on the detail. So the split is by the
    // detail's `action.kind`, and callers that have only summaries treat every row as `tool`.
    if (isExecApproval(approval)) exec.push(approval);
    else tool.push(approval);
  }
  return { tool, exec };
}

/**
 * Does this summary describe an exec approval?
 *
 * `ApprovalSummary` does not carry `kind` — that is a real property of the contract, not an
 * oversight here. The one field that distinguishes them on the summary is `action.kind`, which
 * the server fills from the `Action` row's own vocabulary (`exec`, `tool_call`, …). Reading it
 * is cheaper than fetching every detail, and it is the same field the server branched on.
 */
export function isExecApproval(approval: ApprovalSummary): boolean {
  return approval.requiredPermissions.includes('exec');
}

/**
 * Decide an exec approval: allow once, allow always, or deny.
 *
 * Hits `POST /:id/decide-exec`, **not** `/:id/decide`. The two schemas differ in kind and the
 * server refuses a cross-call explicitly (`decideExec` throws when the approval is a plan-step
 * gate rather than recording `allow_always` against one) — so sending the wrong vocabulary here
 * is a loud 400, not a wrong row.
 */
export function useDecideExecApproval() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: DecideExecApprovalInput & { id: string }) =>
      apiOf<ExecDecisionResult>(`/approvals/${id}/decide-exec`, 'result', {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => {
      // An `allow_always` writes a rule, so the rules list is stale too. `approval.resolved`
      // also arrives on the stream, but invalidating here means the UI is correct even when the
      // frame is still in flight.
      void client.invalidateQueries({ queryKey: queryKeys.approvals.all });
      void client.invalidateQueries({ queryKey: queryKeys.exec.rules });
      void client.invalidateQueries({ queryKey: queryKeys.runs.all });
      void client.invalidateQueries({ queryKey: queryKeys.dashboard });
    },
  });
}

/**
 * The standing permissions.
 *
 * `includeInactive` is off by default, matching the server: revoked and lapsed rules are excluded
 * unless asked for. The page offers the toggle because "what did I revoke?" is a real question,
 * and the only place it can be answered is here.
 */
export function useExecRules(options: { includeInactive?: boolean; limit?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.exec.rules_(
      options.includeInactive === true ? 'inactive' : 'active',
    ),
    queryFn: () =>
      apiOf<ExecAllowlistRuleSummary[]>(
        `/approvals/exec/rules${qs({
          includeInactive: options.includeInactive,
          limit: options.limit ?? 200,
        })}`,
        'rules',
      ),
  });
}

/**
 * Revoke a standing permission.
 *
 * Revocation is permanent and wins over expiry — the server states that a revoked rule stays
 * revoked even if its expiry is in the future, because revoking is a deliberate act and expiring
 * is only the clock running out. The UI confirms before calling this for that reason.
 */
export function useRevokeExecRule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/approvals/exec/rules/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.exec.all }),
  });
}
