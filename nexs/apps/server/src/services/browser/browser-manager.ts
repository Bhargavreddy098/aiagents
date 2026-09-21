import type { BrowserSession } from '@prisma/client';
import { ApiError, type BrowserScreenshot } from '@nexs/shared';
import type { Logger } from '../../logger.js';
import type { BrowserSessionRepository } from '../../repositories/browser.repo.js';
import type { EngineEmitter } from '../engine/execution-engine.js';
import { storageKey, type StorageService } from '../storage/storage.service.js';
import { sliceUtf8 } from '../tools/tool-result.js';
import type {
  BrowserContextHandle,
  BrowserLauncher,
  BrowserPage,
  BrowserWaitUntil,
} from './launcher.js';

/**
 * `BrowserManager` — the only module that drives a browser.
 *
 * The shape of the thing, and why:
 *
 * **One Chromium, one context per session.** Launching a browser per agent would cost a
 * process each and still leak cookies between them if the contexts were shared. A context is
 * Playwright's isolation unit — cookies, `localStorage`, the HTTP cache all live there — so
 * one context per `BrowserSession` is what makes "two agents browse at once" mean two
 * separate logged-in states rather than one confused one.
 *
 * **Actions on a session are serialised.** Playwright calls on one page are not safe to
 * interleave: a `click` racing a `goto` navigates out from under itself, and the failure is
 * intermittent rather than loud. Each session owns a promise chain, so the second action
 * waits for the first to finish rather than racing it.
 *
 * **Screenshots are capped, and the cap degrades rather than fails.** A full-page capture of
 * a heavy page runs to tens of megabytes; storing one per navigation is a disk leak with a
 * screenshot-shaped alibi. Over the cap, the capture falls back to the viewport — bounded by
 * the window size — and says so in the result. Only if even that exceeds the cap is nothing
 * stored, and then the previous screenshot is deliberately left in place rather than
 * replaced by a broken reference.
 *
 * **The upgrade path to persistent contexts.** Every session is ephemeral today: a fresh
 * `newContext()` and a fresh page, discarded on close. Making a session survive a restart
 * means `browser.newContext({ storageState })` on open and
 * `context.storageState({ path })` before close, plus a `storageStateRef` column to remember
 * where it went. Nothing else changes — which is why `openSession` takes the context from a
 * single call and nothing above it knows how the context was configured.
 */

// ── public shapes ─────────────────────────────────────────────────────────────

export type BrowserActionType =
  | 'navigate'
  | 'click'
  | 'type'
  | 'select'
  | 'extract'
  | 'upload'
  | 'download'
  | 'screenshot'
  | 'wait'
  | 'inspect'
  | 'close';

export type BrowserAction =
  | { type: 'navigate'; url: string; waitUntil?: BrowserWaitUntil }
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

export interface BrowserSessionView {
  id: string;
  runId: string | null;
  agentId: string | null;
  status: string;
  currentUrl: string | null;
  title: string | null;
  screenshotRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BrowserActionResult {
  sessionId: string;
  action: BrowserActionType;
  status: string;
  currentUrl: string | null;
  title: string | null;
  /** The session's current screenshot, which an action may have just replaced. */
  screenshotRef: string | null;
  /** Action-specific payload: navigation status, extracted text, download ref, screenshot detail. */
  output?: unknown;
  durationMs: number;
}

export interface BrowserManagerOptions {
  timeoutMs: number;
  screenshotMaxBytes: number;
  /** Ceiling for inline `inspect`/`extract` text, which goes into a prompt rather than storage. */
  inlineTextMaxBytes: number;
}

export interface BrowserManagerDeps {
  sessions: BrowserSessionRepository;
  storage: StorageService;
  launcher: BrowserLauncher;
  logger: Logger;
  options: BrowserManagerOptions;
  /**
   * The shared emitter — the same two-argument shape every other service takes.
   *
   * Typed as `EngineEmitter` rather than a structural lookalike so there is exactly one
   * emitter signature in the codebase. The tenant argument is not decoration: it is what
   * lets the hub route a frame to the clients of the tenant it belongs to, and a manager
   * that emitted without it would have its frames dropped rather than misdelivered.
   */
  emit?: EngineEmitter;
}

interface LiveSession {
  tenantId: string;
  sessionId: string;
  context: BrowserContextHandle;
  page: BrowserPage;
  /**
   * The tail of this session's action chain. Every action appends to it, so actions run in
   * the order they were requested and never overlap.
   */
  queue: Promise<unknown>;
  /** Guards the documented `<sessionId>-<ts>.png` key against a same-millisecond collision. */
  lastScreenshotAt: number;
}

const DEFAULT_WAIT_UNTIL: BrowserWaitUntil = 'load';
/** A `wait` with neither selector nor duration would return instantly and mean nothing. */
const DEFAULT_WAIT_MS = 1_000;

export class BrowserManager {
  private readonly deps: BrowserManagerDeps;
  private readonly logger: Logger;
  private readonly live = new Map<string, LiveSession>();

  constructor(deps: BrowserManagerDeps) {
    this.deps = deps;
    this.logger = deps.logger;
  }

  // ── observability for tests and the health sweep ────────────────────────────

  get liveSessionCount(): number {
    return this.live.size;
  }

  isOpen(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Create a session and, optionally, land on a first URL.
   *
   * The row is written before the browser work so that a failure leaves evidence: an
   * operator looking at a session stuck in `error` can see which agent asked for it, which
   * is exactly what is missing if the row is only created on success.
   */
  async open(
    tenantId: string,
    options: { runId?: string | null; agentId?: string | null; url?: string } = {},
  ): Promise<BrowserSessionView> {
    const row = await this.deps.sessions.create({
      tenantId,
      runId: options.runId ?? null,
      agentId: options.agentId ?? null,
    });

    try {
      const session = await this.attach(tenantId, row);
      this.live.set(row.id, session);
    } catch (cause) {
      await this.deps.sessions.update(tenantId, row.id, { status: 'error' });
      throw this.toBrowserError(cause, { sessionId: row.id, phase: 'open' });
    }

    await this.deps.sessions.update(tenantId, row.id, { status: 'active' });
    this.deps.emit?.(tenantId, { name: 'browser.started', payload: { sessionId: row.id } });

    // A first URL is a convenience, not a different code path: it goes through `act` so it
    // produces the same row updates and the same `browser.updated` event as any navigation.
    if (options.url !== undefined) {
      await this.act(tenantId, row.id, { type: 'navigate', url: options.url });
    }

    return this.get(tenantId, row.id);
  }

  async get(tenantId: string, sessionId: string): Promise<BrowserSessionView> {
    const row = await this.requireRow(tenantId, sessionId);
    return this.view(row);
  }

  async list(
    tenantId: string,
    options: { status?: string; runId?: string; limit?: number } = {},
  ): Promise<BrowserSessionView[]> {
    const rows = await this.deps.sessions.list(tenantId, options);
    return rows.map((row) => this.view(row));
  }

  /** Close the session and its context. Idempotent, so a double close is not an error. */
  async close(tenantId: string, sessionId: string): Promise<void> {
    await this.requireRow(tenantId, sessionId);
    const session = this.live.get(sessionId);

    if (session !== undefined) {
      this.live.delete(sessionId);
      // Awaited through the queue so a close cannot cut in front of an action that is still
      // running — that would leave the action writing to a closed page.
      await this.enqueue(session, async () => {
        await session.page.close();
        await session.context.close();
      }).catch((cause: unknown) => {
        this.logger.warn({ sessionId, err: String(cause) }, 'browser: context did not close cleanly');
      });
    }

    await this.deps.sessions.update(tenantId, sessionId, { status: 'closed' });
    this.deps.emit?.(tenantId, { name: 'browser.closed', payload: { sessionId } });
  }

  /**
   * Run one action.
   *
   * Every action updates the session row and emits `browser.updated`, so the Browser tab is
   * a live view of the browser rather than a poll — that is the difference between "the
   * agent says it navigated" and "you can see where it is".
   */
  async act(tenantId: string, sessionId: string, action: BrowserAction): Promise<BrowserActionResult> {
    const startedAt = Date.now();

    if (action.type === 'close') {
      await this.close(tenantId, sessionId);
      const row = await this.requireRow(tenantId, sessionId);
      return {
        sessionId,
        action: 'close',
        status: row.status,
        currentUrl: row.currentUrl,
        title: row.title,
        screenshotRef: row.screenshotRef,
        durationMs: Date.now() - startedAt,
      };
    }

    await this.requireRow(tenantId, sessionId);
    const session = this.live.get(sessionId);
    if (session === undefined) {
      throw new ApiError('BROWSER_ERROR', 'Browser session is not open', { sessionId });
    }

    const outcome = await this.enqueue(session, async () => this.dispatch(session, action)).catch(
      (cause: unknown) => {
        throw this.toBrowserError(cause, { sessionId, action: action.type });
      },
    );

    const row = await this.requireRow(tenantId, sessionId);
    const result: BrowserActionResult = {
      sessionId,
      action: action.type,
      status: row.status,
      currentUrl: row.currentUrl,
      title: row.title,
      screenshotRef: row.screenshotRef,
      durationMs: Date.now() - startedAt,
    };
    if (outcome !== undefined) result.output = outcome;

    this.deps.emit?.(tenantId, {
      name: 'browser.updated',
      payload: {
        sessionId,
        ...(row.currentUrl === null ? {} : { url: row.currentUrl }),
        ...(row.title === null ? {} : { title: row.title }),
        ...(row.screenshotRef === null ? {} : { screenshotRef: row.screenshotRef }),
      },
    });

    return result;
  }

  /**
   * Close every context and stop the shared Chromium. Called from the SIGTERM handler.
   *
   * Order matters: contexts first, browser last. Closing the browser first would orphan the
   * contexts, and Playwright's cleanup on a half-closed browser is where a leaked Chromium
   * comes from.
   */
  async shutdown(): Promise<void> {
    const sessions = [...this.live.values()];
    this.live.clear();

    await Promise.all(
      sessions.map(async (session) => {
        await session.page.close().catch(() => undefined);
        await session.context.close().catch(() => undefined);
      }),
    );

    await this.deps.launcher.dispose().catch((cause: unknown) => {
      this.logger.warn({ err: String(cause) }, 'browser: launcher did not shut down cleanly');
    });
  }

  /**
   * Close rows a previous process left marked `active`.
   *
   * A context cannot outlive its process, so every such row is a lie the Browser tab would
   * otherwise repeat forever — a session showing "active" with a URL that nothing is
   * actually visiting. Returns how many were corrected.
   */
  async reconcile(): Promise<number> {
    const stale = await this.deps.sessions.listLive();
    for (const row of stale) {
      await this.deps.sessions.update(row.tenantId, row.id, { status: 'closed' });
    }
    return stale.length;
  }

  // ── internals: session plumbing ─────────────────────────────────────────────

  private async attach(tenantId: string, row: BrowserSession): Promise<LiveSession> {
    const browser = await this.deps.launcher.browser();
    const context = await browser.newContext();
    const page = await context.newPage();

    this.logger.debug({ sessionId: row.id, tenantId }, 'browser: session attached');
    return { tenantId, sessionId: row.id, context, page, queue: Promise.resolve(), lastScreenshotAt: 0 };
  }

  /** Append to the session's chain, returning a promise for this action's own result. */
  private enqueue<T>(session: LiveSession, work: () => Promise<T>): Promise<T> {
    const run = session.queue.then(work, work);
    // The chain must not accumulate rejections: each link swallows its own failure, and the
    // caller still receives it through `run`.
    session.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * `close` is excluded because it is handled before the queue is entered: closing is what
   * the queue exists to order *against*, and queueing it behind the action it is meant to
   * interrupt would defeat the point.
   */
  private async dispatch(
    session: LiveSession,
    action: Exclude<BrowserAction, { type: 'close' }>,
  ): Promise<unknown> {
    const timeout = this.deps.options.timeoutMs;
    const call = { timeout };
    const page = session.page;

    switch (action.type) {
      case 'navigate': {
        const navigation = await page.goto(action.url, {
          waitUntil: action.waitUntil ?? DEFAULT_WAIT_UNTIL,
          timeout,
        });
        await this.record(session, { currentUrl: navigation.url });
        return navigation;
      }

      case 'click': {
        await page.click(action.selector, call);
        await this.record(session, {});
        return { selector: action.selector };
      }

      case 'type': {
        await page.fill(action.selector, action.text, call);
        if (action.submit === true) await page.press(action.selector, 'Enter', call);
        await this.record(session, {});
        return { selector: action.selector, submitted: action.submit === true };
      }

      case 'select': {
        const selected = await page.selectOption(action.selector, action.values, call);
        await this.record(session, {});
        return { selector: action.selector, selected };
      }

      case 'extract': {
        const attribute = action.attribute;

        if (attribute === undefined) {
          if (action.all === true) {
            const values = await page.allTextContents(action.selector, call);
            return { selector: action.selector, values: values.map((value) => this.bound(value)) };
          }
          const value = await page.textContent(action.selector, call);
          return { selector: action.selector, value: value === null ? null : this.bound(value) };
        }

        if (action.all === true) {
          const values = await page.allAttributes(action.selector, attribute, call);
          return { selector: action.selector, attribute, values };
        }
        const value = await page.getAttribute(action.selector, attribute, call);
        return { selector: action.selector, attribute, value };
      }

      case 'upload': {
        await page.setInputFiles(action.selector, action.files, call);
        await this.record(session, {});
        return { selector: action.selector, files: action.files.length };
      }

      case 'download': {
        const download = await page.waitForDownload(() => page.click(action.selector, call));
        const filename = sanitiseFilename(download.suggestedFilename());
        const bytes = await download.bytes();
        const key = storageKey(session.tenantId, 'downloads', `${session.sessionId}-${Date.now()}-${filename}`);

        await this.deps.storage.put(key, bytes, { contentType: 'application/octet-stream' });
        await this.record(session, {});
        return { ref: key, filename, bytes: bytes.byteLength };
      }

      case 'screenshot': {
        const capture = await this.capture(session, action.fullPage === true);
        if (capture.screenshot !== null) {
          await this.record(session, { screenshotRef: capture.screenshot.ref });
        } else {
          // Nothing was stored. The row keeps whatever ref it already had rather than being
          // pointed at a key that does not exist.
          await this.record(session, {});
        }
        return capture;
      }

      case 'wait': {
        // A selector wait is the wait. Appending the default duration to it would make every
        // "wait for the spinner to go" also cost a second, which is not what the caller asked
        // for — the extra delay only happens when it was explicitly requested.
        if (action.selector !== undefined) {
          await page.waitForSelector(action.selector, { timeout, state: 'visible' });
          if (action.ms !== undefined) await page.waitForTimeout(action.ms);
        } else {
          await page.waitForTimeout(action.ms ?? DEFAULT_WAIT_MS);
        }
        await this.record(session, {});
        return { selector: action.selector ?? null, ms: action.ms ?? null };
      }

      case 'inspect': {
        await this.record(session, {});
        return {
          url: page.url(),
          title: await this.safeTitle(page),
          text: this.bound((await page.textContent('body', call)) ?? ''),
        };
      }

      default: {
        // Exhaustiveness: adding an action to the union without handling it is a compile
        // error here rather than a silent no-op at runtime.
        const unreachable: never = action;
        throw new ApiError('VALIDATION_ERROR', 'Unsupported browser action', {
          action: (unreachable as { type?: string }).type ?? 'unknown',
        });
      }
    }
  }

  /**
   * Refresh the row from the live page and emit nothing — `act` emits once, after the row is
   * current, so the UI never renders a URL that is one action behind.
   */
  private async record(
    session: LiveSession,
    patch: { currentUrl?: string; screenshotRef?: string },
  ): Promise<void> {
    const currentUrl = patch.currentUrl ?? session.page.url();
    const title = await this.safeTitle(session.page);

    await this.deps.sessions.update(session.tenantId, session.sessionId, {
      ...(currentUrl.length === 0 ? {} : { currentUrl }),
      title,
      ...(patch.screenshotRef === undefined ? {} : { screenshotRef: patch.screenshotRef }),
    });
  }

  private async safeTitle(page: BrowserPage): Promise<string | null> {
    // A page mid-navigation has no title yet, and `title()` rejects rather than returning an
    // empty string. A missing title must not fail an action that otherwise succeeded.
    try {
      const title = await page.title();
      return title.length === 0 ? null : title;
    } catch {
      return null;
    }
  }

  private async capture(
    session: LiveSession,
    fullPage: boolean,
  ): Promise<{ screenshot: BrowserScreenshot | null; skippedReason?: string }> {
    const cap = this.deps.options.screenshotMaxBytes;
    let bytes = await session.page.screenshot({ fullPage, type: 'png' });
    let downscaled = false;

    if (bytes.byteLength > cap && fullPage) {
      // Degrade to the viewport, which is bounded by the window size, rather than store
      // nothing. A partial screenshot that says it is partial beats no screenshot at all.
      bytes = await session.page.screenshot({ fullPage: false, type: 'png' });
      downscaled = true;
    }

    if (bytes.byteLength > cap) {
      return {
        screenshot: null,
        skippedReason: `screenshot is ${bytes.byteLength} bytes, over the ${cap}-byte cap`,
      };
    }

    // The documented key is `<tenantId>/screenshots/<sessionId>-<ts>.png`, which has
    // millisecond resolution. Actions on a session are serialised, so a collision would need
    // two captures inside one millisecond; bumping the stamp makes that impossible rather
    // than merely unlikely, and keeps the format the spec asks for.
    const now = Date.now();
    const stamp = now > session.lastScreenshotAt ? now : session.lastScreenshotAt + 1;
    session.lastScreenshotAt = stamp;

    const key = storageKey(session.tenantId, 'screenshots', `${session.sessionId}-${stamp}.png`);
    await this.deps.storage.put(key, bytes, { contentType: 'image/png' });

    const screenshot: BrowserScreenshot = {
      ref: key,
      bytes: bytes.byteLength,
      mimeType: 'image/png',
      ...(downscaled ? { downscaled: true } : {}),
    };
    return { screenshot };
  }

  /** Keep inline text bounded; it goes into a prompt, not into storage. */
  private bound(text: string): string {
    const max = this.deps.options.inlineTextMaxBytes;
    if (Buffer.byteLength(text, 'utf8') <= max) return text;
    return `${sliceUtf8(text, max)}\n…text truncated at ${max} bytes`;
  }

  private async requireRow(tenantId: string, sessionId: string): Promise<BrowserSession> {
    const row = await this.deps.sessions.findById(tenantId, sessionId);
    if (row === null) {
      // 404 for "belongs to another tenant" as well as "does not exist" — the difference is
      // itself information a caller should not be able to extract.
      throw new ApiError('NOT_FOUND', 'Browser session not found', { sessionId });
    }
    return row;
  }

  private toBrowserError(cause: unknown, context: Record<string, unknown>): ApiError {
    if (cause instanceof ApiError) return cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    return new ApiError('BROWSER_ERROR', `Browser action failed: ${message}`, context);
  }

  private view(row: BrowserSession): BrowserSessionView {
    return {
      id: row.id,
      runId: row.runId,
      agentId: row.agentId,
      status: row.status,
      currentUrl: row.currentUrl,
      title: row.title,
      screenshotRef: row.screenshotRef,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/** A download's suggested name is attacker-controlled and must not become a path segment. */
function sanitiseFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'download';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  return cleaned.length === 0 ? 'download' : cleaned.slice(0, 96);
}
