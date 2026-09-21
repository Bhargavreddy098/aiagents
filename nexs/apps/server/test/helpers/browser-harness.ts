import { Buffer } from 'node:buffer';
import type {
  BrowserCallOptions,
  BrowserContextHandle,
  BrowserDownloadHandle,
  BrowserHandle,
  BrowserLauncher,
  BrowserNavigation,
  BrowserPage,
  BrowserWaitUntil,
} from '../../src/services/browser/launcher.js';

/**
 * Test doubles for the browser layer.
 *
 * The build plan's browser acceptance test is *"open example.com, screenshot, extract
 * `<title>`"*. Driving that against a real Chromium would make the suite depend on a browser
 * binary, a network, and a system-dependency install — and a browser test that hangs leaves
 * a real Chromium process behind, which is the one thing the whole phase is about avoiding.
 * Injecting the launcher instead means the assertions are about the manager's decisions:
 * isolation, ordering, the screenshot cap, and what lands in the session row.
 */

export interface FakeDownloadSpec {
  filename: string;
  bytes?: number;
}

export interface FakePageSpec {
  url?: string;
  title?: string;
  /** Bytes returned by a screenshot. Either one size, or per-capture-mode sizes. */
  screenshotBytes?: number | { fullPage: number; viewport: number };
  /** `textContent` / `allTextContents` results, keyed by selector. */
  text?: Record<string, string | null>;
  lists?: Record<string, string[]>;
  /** `getAttribute` / `allAttributes` results: selector → attribute → value. */
  attributes?: Record<string, Record<string, string | null>>;
  listAttributes?: Record<string, Array<string | null>>;
  download?: FakeDownloadSpec;
}

export class FakeDownload implements BrowserDownloadHandle {
  constructor(
    private readonly filename: string,
    private readonly size: number,
  ) {}

  suggestedFilename(): string {
    return this.filename;
  }

  async bytes(): Promise<Buffer> {
    return Buffer.alloc(this.size, 0x44);
  }
}

export class FakeBrowserPage implements BrowserPage {
  /**
   * When set, every operation awaits this before completing.
   *
   * This is how the serialisation test observes the gap between "the manager accepted two
   * actions" and "the page saw two actions" — the only place where an interleaving bug
   * would be visible.
   */
  hold: Promise<void> | null = null;

  /** `kind:enter` / `kind:exit`, in the order the page actually experienced them. */
  readonly events: string[] = [];
  readonly navigations: Array<{ url: string; waitUntil: BrowserWaitUntil; timeout: number }> = [];
  readonly clicks: Array<{ selector: string; timeout: number }> = [];
  readonly fills: Array<{ selector: string; value: string; timeout: number }> = [];
  readonly presses: Array<{ selector: string; key: string; timeout: number }> = [];
  readonly selects: Array<{ selector: string; values: string[]; timeout: number }> = [];
  readonly uploads: Array<{ selector: string; files: string[]; timeout: number }> = [];
  readonly screenshots: Array<{ fullPage: boolean; bytes: number }> = [];
  readonly waits: Array<{ selector?: string; ms?: number }> = [];
  readonly textReads: string[] = [];

  closed = false;
  /** Fail the next call with this. Consumed once. */
  failNextWith: Error | null = null;
  /** Fail every call with this. */
  failAllWith: Error | null = null;
  /** Mutable, so a test can change what a page returns mid-session. */
  screenshotBytes: FakePageSpec['screenshotBytes'];

  private readonly spec: FakePageSpec;
  private currentUrl: string;
  private currentTitle: string;

  constructor(spec: FakePageSpec = {}) {
    this.spec = spec;
    this.currentUrl = spec.url ?? 'about:blank';
    this.currentTitle = spec.title ?? '';
    this.screenshotBytes = spec.screenshotBytes;
  }

  // ── the seam ────────────────────────────────────────────────────────────────

  async goto(
    url: string,
    options: { waitUntil: BrowserWaitUntil; timeout: number },
  ): Promise<BrowserNavigation> {
    await this.enter('navigate');
    this.throwIfFailing();

    this.navigations.push({ url, waitUntil: options.waitUntil, timeout: options.timeout });
    this.currentUrl = url;
    // A realistic touch: a page's title is whatever the document says, so a navigation
    // replaces it rather than leaving the previous page's title attached to a new URL.
    this.currentTitle = this.spec.title ?? url;

    this.exit('navigate');
    return { url, status: 200 };
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return this.currentTitle;
  }

  async click(selector: string, options: BrowserCallOptions): Promise<void> {
    await this.enter('click');
    this.throwIfFailing();
    this.clicks.push({ selector, timeout: options.timeout });
    this.exit('click');
  }

  async fill(selector: string, value: string, options: BrowserCallOptions): Promise<void> {
    await this.enter('type');
    this.throwIfFailing();
    this.fills.push({ selector, value, timeout: options.timeout });
    this.exit('type');
  }

  async press(selector: string, key: string, options: BrowserCallOptions): Promise<void> {
    await this.enter('press');
    this.throwIfFailing();
    this.presses.push({ selector, key, timeout: options.timeout });
    this.exit('press');
  }

  async selectOption(
    selector: string,
    values: string[],
    options: BrowserCallOptions,
  ): Promise<string[]> {
    await this.enter('select');
    this.throwIfFailing();
    this.selects.push({ selector, values, timeout: options.timeout });
    this.exit('select');
    return values;
  }

  async textContent(selector: string, _options: BrowserCallOptions): Promise<string | null> {
    await this.enter('extract');
    this.throwIfFailing();
    this.textReads.push(selector);
    this.exit('extract');
    return this.spec.text?.[selector] ?? null;
  }

  async getAttribute(
    selector: string,
    name: string,
    _options: BrowserCallOptions,
  ): Promise<string | null> {
    await this.enter('extract');
    this.throwIfFailing();
    this.textReads.push(`${selector}@${name}`);
    this.exit('extract');
    return this.spec.attributes?.[selector]?.[name] ?? null;
  }

  async allTextContents(selector: string, _options: BrowserCallOptions): Promise<string[]> {
    await this.enter('extract');
    this.throwIfFailing();
    this.textReads.push(`${selector}*`);
    this.exit('extract');
    return this.spec.lists?.[selector] ?? [];
  }

  async allAttributes(
    selector: string,
    name: string,
    _options: BrowserCallOptions,
  ): Promise<Array<string | null>> {
    await this.enter('extract');
    this.throwIfFailing();
    this.textReads.push(`${selector}*@${name}`);
    this.exit('extract');
    return this.spec.listAttributes?.[selector] ?? [];
  }

  async setInputFiles(
    selector: string,
    files: string[],
    options: BrowserCallOptions,
  ): Promise<void> {
    await this.enter('upload');
    this.throwIfFailing();
    this.uploads.push({ selector, files, timeout: options.timeout });
    this.exit('upload');
  }

  async waitForSelector(
    selector: string,
    _options: { timeout: number; state: 'attached' | 'detached' | 'visible' | 'hidden' },
  ): Promise<void> {
    await this.enter('wait');
    this.throwIfFailing();
    this.waits.push({ selector });
    this.exit('wait');
  }

  async waitForTimeout(ms: number): Promise<void> {
    await this.enter('wait');
    this.throwIfFailing();
    this.waits.push({ ms });
    this.exit('wait');
  }

  async screenshot(options: { fullPage: boolean; type: 'png' }): Promise<Buffer> {
    await this.enter('screenshot');
    this.throwIfFailing();

    const size = this.screenshotBytes;
    const bytes =
      typeof size === 'number'
        ? size
        : options.fullPage
          ? (size?.fullPage ?? 1_024)
          : (size?.viewport ?? 1_024);

    this.screenshots.push({ fullPage: options.fullPage, bytes });
    this.exit('screenshot');
    return Buffer.alloc(bytes, 0x89);
  }

  async waitForDownload(trigger: () => Promise<void>): Promise<BrowserDownloadHandle> {
    await this.enter('download');
    await trigger();
    this.throwIfFailing();
    this.exit('download');

    const spec = this.spec.download ?? { filename: 'file.bin', bytes: 128 };
    return new FakeDownload(spec.filename, spec.bytes ?? 128);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

  private async enter(kind: string): Promise<void> {
    this.events.push(`${kind}:enter`);
    if (this.hold !== null) await this.hold;
  }

  private exit(kind: string): void {
    this.events.push(`${kind}:exit`);
  }

  private throwIfFailing(): void {
    if (this.failAllWith !== null) throw this.failAllWith;
    if (this.failNextWith !== null) {
      const error = this.failNextWith;
      this.failNextWith = null;
      throw error;
    }
  }
}

export class FakeBrowserContext implements BrowserContextHandle {
  readonly pages: FakeBrowserPage[] = [];
  closed = false;

  constructor(private readonly spec: FakePageSpec) {}

  async newPage(): Promise<BrowserPage> {
    const page = new FakeBrowserPage(this.spec);
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const page of this.pages) page.closed = true;
  }

  get page(): FakeBrowserPage {
    const page = this.pages[0];
    if (page === undefined) throw new Error('no page was created in this context');
    return page;
  }
}

export class FakeBrowser implements BrowserHandle {
  readonly contexts: FakeBrowserContext[] = [];
  closed = false;
  /** Simulates Chromium exiting under us without a `close()`. */
  killed = false;

  constructor(private readonly spec: FakePageSpec) {}

  async newContext(): Promise<BrowserContextHandle> {
    const context = new FakeBrowserContext(this.spec);
    this.contexts.push(context);
    return context;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const context of this.contexts) await context.close();
  }

  isConnected(): boolean {
    return !this.closed && !this.killed;
  }
}

export interface FakeBrowserLauncherOptions {
  page?: FakePageSpec;
  failLaunchWith?: Error | null;
  /** A fresh spec per browser, for tests that want different pages per session. */
  forBrowser?: (index: number) => FakePageSpec;
}

export class FakeBrowserLauncher implements BrowserLauncher {
  readonly browsers: FakeBrowser[] = [];
  launchCount = 0;
  disposeCount = 0;

  private readonly options: FakeBrowserLauncherOptions;
  private handle: Promise<BrowserHandle> | null = null;

  constructor(options: FakeBrowserLauncherOptions = {}) {
    this.options = options;
  }

  async browser(): Promise<BrowserHandle> {
    if (this.options.failLaunchWith !== undefined && this.options.failLaunchWith !== null) {
      throw this.options.failLaunchWith;
    }

    if (this.handle !== null) {
      const existing = await this.handle;
      if (existing.isConnected()) return existing;
      this.handle = null;
    }

    const browser = new FakeBrowser(
      this.options.forBrowser?.(this.browsers.length) ?? this.options.page ?? {},
    );
    this.browsers.push(browser);
    this.launchCount += 1;
    this.handle = Promise.resolve(browser);
    return browser;
  }

  async dispose(): Promise<void> {
    this.disposeCount += 1;
    const pending = this.handle;
    this.handle = null;
    if (pending === null) return;
    await (await pending).close();
  }

  /** Every context created across every browser, in creation order. */
  get contexts(): FakeBrowserContext[] {
    return this.browsers.flatMap((browser) => browser.contexts);
  }

  /** The most recently created page. */
  get latestPage(): FakeBrowserPage {
    const contexts = this.contexts;
    const context = contexts.at(-1);
    if (context === undefined) throw new Error('no context was created');
    return context.page;
  }

  /** The page belonging to the Nth session (0-based). */
  pageAt(index: number): FakeBrowserPage {
    const context = this.contexts[index];
    if (context === undefined) throw new Error(`no context at index ${index}`);
    return context.page;
  }
}
