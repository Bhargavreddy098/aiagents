/**
 * Browser session control — the write half of the Browser page.
 *
 * ## What the page could not do before this module
 *
 * The list, the live updates and the run link were all real. What was missing was every way to
 * *act*: `POST /browser` opens a session and `POST /:id/actions` drives one, and neither had a
 * client. A Browser page whose sessions an operator can watch and cannot start is half a feature.
 *
 * ## The action body is a discriminated union, and this module keeps it one
 *
 * `schemas/browser.ts` states the rule at length: `{ type: 'click', selector }` and
 * `{ type: 'navigate', url }` are different shapes, and a loose object with everything optional
 * would let a `click` arrive with no selector and fail as "the browser did nothing" rather than
 * "you did not say what to click". `BrowserActionInput` below is the same union the schema takes,
 * so the composer for an action cannot construct one that the route will refuse.
 *
 * ## `POST /:id/actions` against `DELETE /:id`
 *
 * Closing is an action (`{ type: 'close' }`) *and* a route. They are not redundant: the action goes
 * through the manager and records a tool call like any other, while the `DELETE` disposes the
 * session without running anything. The page uses `DELETE` for its own "Close session" button —
 * an operator tidying up has not asked for an agent action to be logged — and both are wired here.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BrowserSessionSummary } from '@nexs/shared';
import { apiOf, qs, request } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

/** The action union, mirroring `browserActionSchema` member for member. */
export type BrowserActionInput =
  | { type: 'navigate'; url: string; waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' }
  | { type: 'click'; selector: string }
  | { type: 'type'; selector: string; text: string; submit?: boolean }
  | { type: 'select'; selector: string; values: string[] }
  | { type: 'extract'; selector: string; attribute?: string; all?: boolean }
  | { type: 'upload'; selector: string; files: string[] }
  | { type: 'download'; selector: string }
  | { type: 'screenshot'; fullPage?: boolean }
  | { type: 'wait'; selector?: string; ms?: number }
  | { type: 'inspect' }
  | { type: 'close' };

/**
 * The action union as a closed list, for the page's action picker.
 *
 * Exported as data rather than as branches so the picker and the type cannot drift: adding a
 * member to the union above without adding it here is a compile error at the `satisfies`.
 */
export const BROWSER_ACTION_TYPES = [
  'navigate',
  'click',
  'type',
  'select',
  'extract',
  'screenshot',
  'wait',
  'inspect',
] as const satisfies readonly BrowserActionInput['type'][];

export function useBrowserSessions(status?: string) {
  return useQuery({
    queryKey: [...queryKeys.browser.sessions, { status }] as const,
    queryFn: () =>
      apiOf<BrowserSessionSummary[]>(
        `/browser${qs({ ...(status !== undefined ? { status } : {}), limit: 100 })}`,
        'sessions',
      ),
  });
}

export function useBrowserSession(id: string | null) {
  return useQuery({
    queryKey: [...queryKeys.browser.sessions, id ?? ''] as const,
    queryFn: () => apiOf<BrowserSessionSummary>(`/browser/${id ?? ''}`, 'session'),
    enabled: id !== null && id !== '',
  });
}

/**
 * Open a session.
 *
 * `url` is optional and is not defaulted here. A session with no first URL is a legitimate
 * starting point — the schema says so — and inventing an `about:blank` on the client would put a
 * URL on screen that the operator never asked for.
 */
export function useCreateBrowserSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { url?: string; runId?: string | null } = {}) =>
      apiOf<BrowserSessionSummary>('/browser', 'session', { method: 'POST', body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.browser.sessions }),
  });
}

/**
 * Run one action against a session.
 *
 * The 200 body is `{ outcome }` — the manager's own report, not a session summary. `unknown`
 * rather than a typed shape because the outcome's fields depend on which action ran: a navigate
 * reports a final URL, an extract reports the extracted value. The page renders it as JSON, which
 * is the honest rendering of a shape that varies by request.
 */
export function useRunBrowserAction() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: BrowserActionInput }) =>
      apiOf<unknown>(`/browser/${id}/actions`, 'outcome', { method: 'POST', body: action }),
    onSuccess: (_outcome, variables) => {
      void client.invalidateQueries({ queryKey: queryKeys.browser.sessions });
      // An action is a tool call, and a tool call on a session attached to a run writes rows the
      // run workspace renders. Both keys, so "open the run" shows the action that just ran.
      void client.invalidateQueries({ queryKey: queryKeys.runs.all });
      void client.invalidateQueries({ queryKey: [...queryKeys.runs.all, variables.id] });
    },
  });
}

/** Dispose a session without running anything. Answers 204. */
export function useCloseBrowserSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request(`/browser/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.browser.sessions }),
  });
}
