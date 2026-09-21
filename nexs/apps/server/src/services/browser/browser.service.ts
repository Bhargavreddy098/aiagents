import type { ActOnBrowserSessionInput, ListBrowserSessionsQuery, OpenBrowserSessionInput } from '@nexs/shared';
import type { BrowserManager, BrowserSessionView } from './browser-manager.js';

/**
 * `/api/browser` — the live view of what the agent's browser is doing.
 *
 * ## Why this is a thin delegation and that is the right size for it
 *
 * `BrowserManager` already owns everything that could go wrong here: the session registry, the
 * per-session action queue that stops two actions overlapping, the screenshot cap, and the
 * `browser.*` frames. A service that reimplemented any of it would be a second place a session
 * could be opened, and two places that can open a browser is two places that can leak one.
 *
 * So this file's job is narrower and worth stating: it is the **serialisation boundary**. The
 * manager's `BrowserSessionView` carries `Date` objects and its `BrowserActionResult` carries a
 * `BrowserActionType`; both are fine in-process and neither is JSON. Converting here rather than
 * in the controller keeps the controller what it should be — a parse-and-delegate shell.
 *
 * ## Why opening a session is exposed at all
 *
 * The spec's row for this prefix is "sessions list · `GET /:id` · `POST /:id/actions`", and a page
 * that could list sessions but never create one would be a page where the only sessions are ones
 * the engine happened to open. `BrowserManager.open` already exists and is already what the engine
 * calls, so exposing it adds no new capability — it adds a way to reach the existing one.
 */

export interface BrowserServiceDeps {
  browser: BrowserManager;
}

function toSummary(view: BrowserSessionView) {
  return {
    id: view.id,
    runId: view.runId,
    agentId: view.agentId,
    status: view.status,
    currentUrl: view.currentUrl,
    title: view.title,
    screenshotRef: view.screenshotRef,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}

export class BrowserService {
  constructor(private readonly deps: BrowserServiceDeps) {}

  async list(tenantId: string, query: ListBrowserSessionsQuery) {
    const views = await this.deps.browser.list(tenantId, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.runId === undefined ? {} : { runId: query.runId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });

    return views.map(toSummary);
  }

  async get(tenantId: string, id: string) {
    return toSummary(await this.deps.browser.get(tenantId, id));
  }

  async open(tenantId: string, input: OpenBrowserSessionInput) {
    return toSummary(
      await this.deps.browser.open(tenantId, {
        runId: input.runId ?? null,
        agentId: input.agentId ?? null,
        ...(input.url === undefined ? {} : { url: input.url }),
      }),
    );
  }

  /**
   * Run one action.
   *
   * The action body is already a discriminated union by the time it arrives, so the cast to the
   * manager's `BrowserAction` is a shape-for-shape correspondence rather than a hope: every member
   * of `browserActionSchema` mirrors a member of `BrowserAction`, and `routes/browser.ts` rejects
   * anything else with a 400 before this runs.
   *
   * `status` is passed through rather than asserted. An action that ran and left the page in an
   * unexpected state reports that state; collapsing it to "ok" would make the Browser tab lie
   * about where the agent is, which is the one thing it exists to show.
   */
  async act(tenantId: string, id: string, input: ActOnBrowserSessionInput) {
    const result = await this.deps.browser.act(
      tenantId,
      id,
      input.action as Parameters<BrowserManager['act']>[2],
    );

    return {
      sessionId: result.sessionId,
      action: result.action,
      status: result.status,
      currentUrl: result.currentUrl,
      title: result.title,
      screenshotRef: result.screenshotRef,
      ...(result.output === undefined ? {} : { output: result.output }),
      durationMs: result.durationMs,
    };
  }

  /** Idempotent, so a double close is not an error — the manager documents that. */
  async close(tenantId: string, id: string): Promise<void> {
    await this.deps.browser.close(tenantId, id);
  }
}
