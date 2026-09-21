/**
 * The browser surface, as the UI sees it.
 *
 * The Browser tab's whole claim is that it shows where the agent actually is — so these shapes
 * carry the *live* state of a session (current URL, title, latest screenshot) rather than only its
 * identity. That is the difference between "the agent says it navigated" and "you can see the
 * page", and it is why `GET /api/browser/:id` is worth having at all when `browser.updated` frames
 * already stream the same fields.
 */

export const BROWSER_SESSION_STATUSES = ['idle', 'active', 'closed', 'error'] as const;
export type BrowserSessionStatus = (typeof BROWSER_SESSION_STATUSES)[number];

/**
 * The action vocabulary, mirrored from the manager.
 *
 * Held here as a value rather than imported from the server because this package is what the
 * browser bundle consumes — the client needs the same list to build the action form, and a
 * client that offered an action the server rejects is a 422 the user cannot act on.
 */
export const BROWSER_ACTION_TYPES = [
  'navigate',
  'click',
  'type',
  'select',
  'extract',
  'upload',
  'download',
  'screenshot',
  'wait',
  'inspect',
  'close',
] as const;

export type BrowserActionTypeName = (typeof BROWSER_ACTION_TYPES)[number];

export interface BrowserSessionSummary {
  id: string;
  runId: string | null;
  agentId: string | null;
  status: string;
  currentUrl: string | null;
  title: string | null;
  /** Opaque storage key, not a path. Resolved through the file preview route. */
  screenshotRef: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The outcome of one action.
 *
 * `output` is action-specific and deliberately untyped: a navigation reports a status code, an
 * extraction reports text, a screenshot reports its size and whether it was downscaled. Narrowing
 * it here would mean this package owning a copy of the manager's per-action result shapes, which
 * would drift the first time one changed.
 *
 * `screenshotRef` is on the outcome because most actions replace it — the field is what makes a
 * sequence of actions renderable as a filmstrip rather than only the last frame.
 */
export interface BrowserActionOutcome {
  sessionId: string;
  action: string;
  status: string;
  currentUrl: string | null;
  title: string | null;
  screenshotRef: string | null;
  output?: unknown;
  durationMs: number;
}
