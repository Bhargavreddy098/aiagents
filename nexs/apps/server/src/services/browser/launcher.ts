import { chromium, type Browser, type BrowserContext, type Download, type Page } from 'playwright';

/**
 * The seam between `BrowserManager` and Playwright.
 *
 * Same reasoning as `services/mcp/session.ts`: the vision doc says the browser is one of the
 * few things allowed to reach outside the process, so the reach is confined to this file and
 * everything above it talks to structural interfaces. That is what lets the manager's tests
 * assert on navigation, isolation and the screenshot cap without launching Chromium — which
 * matters more here than anywhere else, because a browser test that hangs leaves a real
 * browser process behind.
 *
 * The interfaces are deliberately shaped like Playwright's own API so the adapter below is a
 * near-passthrough. A seam that renames everything makes the adapter a place where bugs hide.
 */

export type BrowserWaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit';

export interface BrowserNavigation {
  url: string;
  /** HTTP status of the main resource, or `null` for a non-HTTP navigation. */
  status: number | null;
}

export interface BrowserDownloadHandle {
  suggestedFilename(): string;
  bytes(): Promise<Buffer>;
}

/** Per-call options. Every method takes the same shape so a caller can pass one object. */
export interface BrowserCallOptions {
  timeout: number;
}

export interface BrowserPage {
  goto(url: string, options: { waitUntil: BrowserWaitUntil; timeout: number }): Promise<BrowserNavigation>;
  url(): string;
  title(): Promise<string>;
  click(selector: string, options: BrowserCallOptions): Promise<void>;
  fill(selector: string, value: string, options: BrowserCallOptions): Promise<void>;
  press(selector: string, key: string, options: BrowserCallOptions): Promise<void>;
  selectOption(selector: string, values: string[], options: BrowserCallOptions): Promise<string[]>;
  textContent(selector: string, options: BrowserCallOptions): Promise<string | null>;
  getAttribute(selector: string, name: string, options: BrowserCallOptions): Promise<string | null>;
  allTextContents(selector: string, options: BrowserCallOptions): Promise<string[]>;
  allAttributes(
    selector: string,
    name: string,
    options: BrowserCallOptions,
  ): Promise<Array<string | null>>;
  setInputFiles(selector: string, files: string[], options: BrowserCallOptions): Promise<void>;
  waitForSelector(
    selector: string,
    options: { timeout: number; state: 'attached' | 'detached' | 'visible' | 'hidden' },
  ): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { fullPage: boolean; type: 'png' }): Promise<Buffer>;
  /** Runs `trigger` and resolves with the download it started. */
  waitForDownload(trigger: () => Promise<void>): Promise<BrowserDownloadHandle>;
  close(): Promise<void>;
}

export interface BrowserContextHandle {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserHandle {
  newContext(): Promise<BrowserContextHandle>;
  close(): Promise<void>;
  /** False once Chromium has exited, which is how the manager notices it must relaunch. */
  isConnected(): boolean;
}

export interface BrowserLauncher {
  /**
   * The shared Chromium, launched on first use.
   *
   * Deliberately lazy: the process must not pay for a browser it never needs, and a
   * deployment with `FEATURE_BROWSER=false` must not fail to boot because Chromium is not
   * installed.
   */
  browser(): Promise<BrowserHandle>;
  /** Tear the shared browser down. Called from the shutdown hook. */
  dispose(): Promise<void>;
}

// ── the real implementation ───────────────────────────────────────────────────

class PlaywrightDownload implements BrowserDownloadHandle {
  constructor(private readonly download: Download) {}

  suggestedFilename(): string {
    return this.download.suggestedFilename();
  }

  async bytes(): Promise<Buffer> {
    // `path()` is null when the download was streamed from a remote driver, so the stream is
    // the portable way to read the bytes. `path()` is also deleted when the context closes,
    // which makes it a trap for anything that defers reading.
    const stream = await this.download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks);
  }
}

class PlaywrightPage implements BrowserPage {
  constructor(private readonly page: Page) {}

  async goto(
    url: string,
    options: { waitUntil: BrowserWaitUntil; timeout: number },
  ): Promise<BrowserNavigation> {
    const response = await this.page.goto(url, options);
    return { url: this.page.url(), status: response === null ? null : response.status() };
  }

  url(): string {
    return this.page.url();
  }

  title(): Promise<string> {
    return this.page.title();
  }

  async click(selector: string, options: BrowserCallOptions): Promise<void> {
    await this.page.click(selector, options);
  }

  async fill(selector: string, value: string, options: BrowserCallOptions): Promise<void> {
    await this.page.fill(selector, value, options);
  }

  async press(selector: string, key: string, options: BrowserCallOptions): Promise<void> {
    await this.page.press(selector, key, options);
  }

  async selectOption(
    selector: string,
    values: string[],
    options: BrowserCallOptions,
  ): Promise<string[]> {
    return this.page.selectOption(selector, values, options);
  }

  textContent(selector: string, options: BrowserCallOptions): Promise<string | null> {
    return this.page.textContent(selector, options);
  }

  getAttribute(selector: string, name: string, options: BrowserCallOptions): Promise<string | null> {
    return this.page.getAttribute(selector, name, options);
  }

  async allTextContents(selector: string, options: BrowserCallOptions): Promise<string[]> {
    // `allTextContents` has no timeout of its own, so the wait is explicit — otherwise an
    // extract against a selector that never appears returns `[]` instantly instead of
    // honouring the configured ceiling, and the caller cannot tell "none" from "not yet".
    await this.page.waitForSelector(selector, { timeout: options.timeout, state: 'attached' });
    return this.page.locator(selector).allTextContents();
  }

  async allAttributes(
    selector: string,
    name: string,
    options: BrowserCallOptions,
  ): Promise<Array<string | null>> {
    await this.page.waitForSelector(selector, { timeout: options.timeout, state: 'attached' });
    return this.page.locator(selector).evaluateAll(
      (elements, attribute) => elements.map((element) => element.getAttribute(attribute as string)),
      name,
    );
  }

  async setInputFiles(selector: string, files: string[], options: BrowserCallOptions): Promise<void> {
    await this.page.setInputFiles(selector, files, options);
  }

  async waitForSelector(
    selector: string,
    options: { timeout: number; state: 'attached' | 'detached' | 'visible' | 'hidden' },
  ): Promise<void> {
    await this.page.waitForSelector(selector, options);
  }

  waitForTimeout(ms: number): Promise<void> {
    return this.page.waitForTimeout(ms);
  }

  screenshot(options: { fullPage: boolean; type: 'png' }): Promise<Buffer> {
    return this.page.screenshot(options);
  }

  async waitForDownload(trigger: () => Promise<void>): Promise<BrowserDownloadHandle> {
    // `Promise.all` and not two awaits: the download event fires while the click is still in
    // flight, so waiting for the click first is a race that loses whenever the file is small.
    const [download] = await Promise.all([this.page.waitForEvent('download'), trigger()]);
    return new PlaywrightDownload(download);
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
  }
}

class PlaywrightContext implements BrowserContextHandle {
  constructor(private readonly context: BrowserContext) {}

  async newPage(): Promise<BrowserPage> {
    return new PlaywrightPage(await this.context.newPage());
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
  }
}

class PlaywrightBrowser implements BrowserHandle {
  constructor(private readonly browser: Browser) {}

  async newContext(): Promise<BrowserContextHandle> {
    // A fresh context per session, always. This is the whole isolation story: cookies,
    // localStorage and the HTTP cache live in the context, so two agents browsing at once
    // cannot see each other's logins.
    return new PlaywrightContext(await this.browser.newContext());
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
  }

  isConnected(): boolean {
    return this.browser.isConnected();
  }
}

export interface PlaywrightLauncherOptions {
  headless: boolean;
  /** Applied to every context, so a single configured ceiling governs all actions. */
  timeoutMs: number;
}

export class PlaywrightLauncher implements BrowserLauncher {
  private readonly options: PlaywrightLauncherOptions;
  private handle: Promise<BrowserHandle> | null = null;

  constructor(options: PlaywrightLauncherOptions) {
    this.options = options;
  }

  async browser(): Promise<BrowserHandle> {
    // The promise, not the resolved value, is cached: two callers racing on a cold start
    // must share one launch rather than start two Chromiums.
    if (this.handle !== null) {
      const existing = await this.handle.catch(() => null);
      if (existing !== null && existing.isConnected()) return existing;
      // Chromium died under us. Drop the handle so the next caller relaunches.
      this.handle = null;
    }

    const launch = (async (): Promise<BrowserHandle> => {
      const browser = await chromium.launch({ headless: this.options.headless });
      return new PlaywrightBrowser(browser);
    })();

    this.handle = launch;
    try {
      return await launch;
    } catch (cause) {
      this.handle = null;
      throw cause;
    }
  }

  async dispose(): Promise<void> {
    const pending = this.handle;
    this.handle = null;
    if (pending === null) return;
    const browser = await pending.catch(() => null);
    await browser?.close();
  }
}
