import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@nexs/shared';
import { BrowserSessionRepository } from '../src/repositories/browser.repo.js';
import {
  BrowserManager,
  type BrowserManagerOptions,
} from '../src/services/browser/browser-manager.js';
import type { PlaywrightLauncher } from '../src/services/browser/launcher.js';
import { LocalStorageService } from '../src/services/storage/storage.service.js';
import { createFakeDb, type FakeDb } from './helpers/fake-db.js';
import {
  FakeBrowserLauncher,
  type FakeBrowserLauncherOptions,
} from './helpers/browser-harness.js';
import { deferred, flush } from './helpers/async.js';
import { createRecordingLogger } from './helpers/mcp-harness.js';

/**
 * `BrowserManager`.
 *
 * The build plan's browser acceptance test is *"open example.com, screenshot, extract
 * `<title>`"*, and the isolation requirement is *"one isolated `BrowserContext` per
 * session — no cookie leakage between sessions"*. Both are here, along with the parts that
 * are easy to get wrong and expensive to notice: action ordering on one page, the screenshot
 * cap's degradation behaviour, and what happens to the session row when a browser dies.
 */

const TENANT = 'tnt_browser';
const OTHER_TENANT = 'tnt_other';

// ── rig ───────────────────────────────────────────────────────────────────────

interface Rig {
  db: FakeDb;
  manager: BrowserManager;
  launcher: FakeBrowserLauncher;
  sessions: BrowserSessionRepository;
  storage: LocalStorageService;
  events: Array<{ name: string; payload: unknown }>;
  records: Array<Record<string, unknown>>;
}

let storageRoot: string;

function makeRig(
  overrides: Partial<BrowserManagerOptions> = {},
  launcherOptions: FakeBrowserLauncherOptions = {},
): Rig {
  const db = createFakeDb();
  const { logger, records } = createRecordingLogger();
  const launcher = new FakeBrowserLauncher({
    ...launcherOptions,
    // Merged rather than spread over: a caller passing `{ page: { screenshotBytes } }` would
    // otherwise silently drop the default title and URL, and the test would be asserting
    // against a page nobody configured.
    page: { title: 'Example Domain', url: 'about:blank', ...launcherOptions.page },
  });
  const sessions = new BrowserSessionRepository(db.client);
  const storage = new LocalStorageService(storageRoot);
  const events: Array<{ name: string; payload: unknown }> = [];

  return {
    db,
    launcher,
    sessions,
    storage,
    events,
    records,
    manager: new BrowserManager({
      sessions,
      storage,
      // Structurally compatible with the real launcher; the manager cannot tell them apart,
      // which is the whole point of the seam.
      launcher: launcher as unknown as PlaywrightLauncher,
      logger,
      options: {
        timeoutMs: 30_000,
        screenshotMaxBytes: 2_048 * 1_024,
        inlineTextMaxBytes: 8 * 1_024,
        ...overrides,
      },
      emit: (_tenantId, event) => {
        events.push(event);
      },
    }),
  };
}

beforeEach(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'nexs-browser-'));
});

afterEach(async () => {
  // Best-effort: a refused delete must never be reported as a test failure.
  await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
});

// ── lifecycle ─────────────────────────────────────────────────────────────────

describe('session lifecycle', () => {
  it('opens a session with its own context and marks the row active', async () => {
    const rig = makeRig();

    const view = await rig.manager.open(TENANT, { agentId: 'agent_1' });

    expect(view.status).toBe('active');
    expect(view.agentId).toBe('agent_1');
    expect(rig.launcher.launchCount).toBe(1);
    expect(rig.launcher.contexts).toHaveLength(1);
    expect(rig.manager.liveSessionCount).toBe(1);
    expect(rig.events).toEqual([{ name: 'browser.started', payload: { sessionId: view.id } }]);
  });

  it('lands on the first URL through the ordinary navigation path', async () => {
    // The acceptance test's opening move: "open example.com".
    const rig = makeRig();

    const view = await rig.manager.open(TENANT, { url: 'https://example.com/' });

    expect(view.currentUrl).toBe('https://example.com/');
    expect(view.title).toBe('Example Domain');
    expect(rig.launcher.latestPage.navigations).toEqual([
      { url: 'https://example.com/', waitUntil: 'load', timeout: 30_000 },
    ]);
    // One `started`, then one `updated` — the navigation is not a different code path.
    expect(rig.events.map((event) => event.name)).toEqual(['browser.started', 'browser.updated']);
  });

  it('reuses one Chromium across sessions', async () => {
    const rig = makeRig();

    await rig.manager.open(TENANT, {});
    await rig.manager.open(TENANT, {});

    // Two contexts, one browser: launching per session would cost a process each and still
    // leak cookies if the contexts were shared.
    expect(rig.launcher.launchCount).toBe(1);
    expect(rig.launcher.contexts).toHaveLength(2);
  });

  it('gives each session an isolated context, so cookies cannot cross', async () => {
    const rig = makeRig();
    const first = await rig.manager.open(TENANT, { url: 'https://a.example/' });
    const second = await rig.manager.open(TENANT, { url: 'https://b.example/' });

    const firstPage = rig.launcher.pageAt(0);
    const secondPage = rig.launcher.pageAt(1);

    expect(firstPage).not.toBe(secondPage);
    expect(firstPage.url()).toBe('https://a.example/');
    expect(secondPage.url()).toBe('https://b.example/');

    // Navigating one must not disturb the other — that is what context isolation buys.
    await rig.manager.act(TENANT, first.id, { type: 'navigate', url: 'https://a.example/next' });
    expect(firstPage.url()).toBe('https://a.example/next');
    expect(secondPage.url()).toBe('https://b.example/');
    expect(await rig.manager.get(TENANT, second.id)).toMatchObject({
      currentUrl: 'https://b.example/',
    });
  });

  it('leaves evidence when the browser will not start', async () => {
    const rig = makeRig({}, { failLaunchWith: new Error('Executable doesn\u2019t exist') });

    const error = await rig.manager.open(TENANT, { agentId: 'agent_1' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('BROWSER_ERROR');

    // The row exists and says it failed: an operator can see which agent asked for it,
    // which is exactly what is missing if the row is only written on success.
    const rows = await rig.sessions.list(TENANT);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('error');
    expect(rows[0]?.agentId).toBe('agent_1');
    expect(rig.manager.liveSessionCount).toBe(0);
  });

  it('closes the context and the row, and is idempotent', async () => {
    const rig = makeRig();
    const view = await rig.manager.open(TENANT, {});

    await rig.manager.close(TENANT, view.id);

    expect(rig.launcher.contexts[0]?.closed).toBe(true);
    expect(rig.launcher.pageAt(0).closed).toBe(true);
    expect(rig.manager.liveSessionCount).toBe(0);
    expect((await rig.manager.get(TENANT, view.id)).status).toBe('closed');
    expect(rig.events.at(-1)).toEqual({
      name: 'browser.closed',
      payload: { sessionId: view.id },
    });

    // A second close must not throw — a user pressing the button twice is not an error.
    await rig.manager.close(TENANT, view.id);
    expect((await rig.manager.get(TENANT, view.id)).status).toBe('closed');
  });

  it('closes every context before the shared browser on shutdown', async () => {
    const rig = makeRig();
    await rig.manager.open(TENANT, {});
    await rig.manager.open(TENANT, {});

    const contexts = rig.launcher.contexts;
    await rig.manager.shutdown();

    expect(contexts.every((context) => context.closed)).toBe(true);
    expect(rig.launcher.browsers[0]?.closed).toBe(true);
    expect(rig.launcher.disposeCount).toBe(1);
    expect(rig.manager.liveSessionCount).toBe(0);
  });

  it('closes rows a previous process left marked active', async () => {
    // A context cannot outlive its process, so every `active` row at startup is a lie the
    // Browser tab would otherwise repeat: a session showing a URL nothing is visiting.
    const rig = makeRig();
    const mine = await rig.sessions.create({ tenantId: TENANT });
    const theirs = await rig.sessions.create({ tenantId: OTHER_TENANT });
    await rig.sessions.update(TENANT, mine.id, { status: 'active' });
    await rig.sessions.update(OTHER_TENANT, theirs.id, { status: 'active' });
    expect(await rig.sessions.listLive()).toHaveLength(2);

    const corrected = await rig.manager.reconcile();

    expect(corrected).toBe(2);
    expect(await rig.sessions.listLive()).toHaveLength(0);
    expect((await rig.sessions.findById(TENANT, mine.id))?.status).toBe('closed');
  });

  it('does not serve a session that belongs to another tenant', async () => {
    const rig = makeRig();
    const view = await rig.manager.open(OTHER_TENANT, {});

    await expect(rig.manager.get(TENANT, view.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(rig.manager.act(TENANT, view.id, { type: 'screenshot' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(rig.manager.close(TENANT, view.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Nothing was closed and nothing was navigated on the strength of an id alone.
    expect(rig.launcher.pageAt(0).closed).toBe(false);
  });
});

// ── actions ───────────────────────────────────────────────────────────────────

describe('actions', () => {
  it('runs the acceptance scenario: open, screenshot, extract the title', async () => {
    const rig = makeRig(
      { screenshotMaxBytes: 10_000 },
      { page: { title: 'Example Domain', screenshotBytes: 4_096 } },
    );

    const opened = await rig.manager.open(TENANT, { url: 'https://example.com/' });
    const shot = await rig.manager.act(TENANT, opened.id, { type: 'screenshot' });
    const extracted = await rig.manager.act(TENANT, opened.id, {
      type: 'extract',
      selector: 'h1',
    });

    expect(extracted.output).toMatchObject({ selector: 'h1' });

    // The Browser tab's two facts: a real URL progression and a real screenshot, stored under
    // the documented key `<tenantId>/screenshots/<sessionId>-<ts>.png`.
    const detail = shot.output as { screenshot: { ref: string; bytes: number } };
    expect(detail.screenshot.bytes).toBe(4_096);
    expect(detail.screenshot.ref).toMatch(
      new RegExp(`^${TENANT}/screenshots/${opened.id}-\\d+\\.png$`),
    );
    expect(shot.currentUrl).toBe('https://example.com/');
    expect(shot.title).toBe('Example Domain');
    expect(shot.screenshotRef).toBe(detail.screenshot.ref);
    expect(await rig.storage.exists(detail.screenshot.ref)).toBe(true);
  });

  it('forwards each action with the configured timeout', async () => {
    const rig = makeRig({ timeoutMs: 5_000 });
    const view = await rig.manager.open(TENANT, {});
    const page = rig.launcher.latestPage;

    await rig.manager.act(TENANT, view.id, { type: 'click', selector: '#go' });
    await rig.manager.act(TENANT, view.id, { type: 'type', selector: '#q', text: 'nexs' });
    await rig.manager.act(TENANT, view.id, {
      type: 'type',
      selector: '#q',
      text: 'nexs',
      submit: true,
    });
    await rig.manager.act(TENANT, view.id, {
      type: 'select',
      selector: '#sort',
      values: ['new'],
    });
    await rig.manager.act(TENANT, view.id, {
      type: 'upload',
      selector: 'input[type=file]',
      files: ['/tmp/a.txt'],
    });

    expect(page.clicks).toEqual([{ selector: '#go', timeout: 5_000 }]);
    expect(page.fills).toHaveLength(2);
    expect(page.fills[0]).toEqual({ selector: '#q', value: 'nexs', timeout: 5_000 });
    // `submit` is a fill followed by Enter, not a separate action the caller has to sequence.
    expect(page.presses).toEqual([{ selector: '#q', key: 'Enter', timeout: 5_000 }]);
    expect(page.selects).toEqual([{ selector: '#sort', values: ['new'], timeout: 5_000 }]);
    expect(page.uploads).toEqual([
      { selector: 'input[type=file]', files: ['/tmp/a.txt'], timeout: 5_000 },
    ]);
  });

  it('extracts text, attributes, and whole lists', async () => {
    const rig = makeRig(
      {},
      {
        page: {
          text: { h1: 'Example Domain', missing: null },
          lists: { 'li.item': ['one', 'two'] },
          attributes: { a: { href: 'https://example.com/x' } },
          listAttributes: { 'a.link': ['https://a/', 'https://b/'] },
        },
      },
    );
    const view = await rig.manager.open(TENANT, {});

    expect(await rig.manager.act(TENANT, view.id, { type: 'extract', selector: 'h1' })).toMatchObject(
      { output: { value: 'Example Domain' } },
    );
    expect(
      await rig.manager.act(TENANT, view.id, { type: 'extract', selector: 'missing' }),
    ).toMatchObject({ output: { value: null } });
    expect(
      await rig.manager.act(TENANT, view.id, { type: 'extract', selector: 'a', attribute: 'href' }),
    ).toMatchObject({ output: { attribute: 'href', value: 'https://example.com/x' } });
    expect(
      await rig.manager.act(TENANT, view.id, { type: 'extract', selector: 'li.item', all: true }),
    ).toMatchObject({ output: { values: ['one', 'two'] } });
    expect(
      await rig.manager.act(TENANT, view.id, {
        type: 'extract',
        selector: 'a.link',
        attribute: 'href',
        all: true,
      }),
    ).toMatchObject({ output: { values: ['https://a/', 'https://b/'] } });
  });

  it('bounds extracted text, because it goes into a prompt rather than storage', async () => {
    const huge = 'x'.repeat(50_000);
    const rig = makeRig({ inlineTextMaxBytes: 1_000 }, { page: { text: { body: huge } } });
    const view = await rig.manager.open(TENANT, {});

    const result = await rig.manager.act(TENANT, view.id, { type: 'extract', selector: 'body' });
    const value = (result.output as { value: string }).value;

    expect(Buffer.byteLength(value, 'utf8')).toBeLessThan(1_100);
    expect(value).toContain('text truncated at 1000 bytes');
  });

  it('inspects the page for the verifier', async () => {
    const rig = makeRig({}, { page: { url: 'https://example.com/', title: 'Example', text: { body: 'hello' } } });
    const view = await rig.manager.open(TENANT, {});

    const result = await rig.manager.act(TENANT, view.id, { type: 'inspect' });

    expect(result.output).toEqual({ url: 'https://example.com/', title: 'Example', text: 'hello' });
  });

  it('waits on a selector and on a duration', async () => {
    const rig = makeRig();
    const view = await rig.manager.open(TENANT, {});

    await rig.manager.act(TENANT, view.id, { type: 'wait', selector: '#spinner' });
    await rig.manager.act(TENANT, view.id, { type: 'wait', ms: 250 });
    await rig.manager.act(TENANT, view.id, { type: 'wait' });

    expect(rig.launcher.latestPage.waits).toEqual([
      { selector: '#spinner' },
      { ms: 250 },
      // A wait with neither is a no-op the caller probably did not intend, so it gets a
      // documented default rather than returning instantly.
      { ms: 1_000 },
    ]);
  });

  it('stores a download under the tenant namespace with a sanitised name', async () => {
    const rig = makeRig(
      {},
      { page: { download: { filename: '../../etc/passwd', bytes: 64 } } },
    );
    const view = await rig.manager.open(TENANT, {});

    const result = await rig.manager.act(TENANT, view.id, { type: 'download', selector: '#dl' });
    const output = result.output as { ref: string; filename: string; bytes: number };

    // The suggested filename is attacker-controlled, so it must not become a path.
    expect(output.filename).toBe('passwd');
    expect(output.ref.startsWith(`${TENANT}/downloads/`)).toBe(true);
    expect(output.ref).not.toContain('..');
    expect(output.bytes).toBe(64);
    expect((await rig.storage.get(output.ref)).byteLength).toBe(64);
  });

  it('records the navigation status and URL on the row', async () => {
    const rig = makeRig({}, { page: { title: 'Example Domain' } });
    const view = await rig.manager.open(TENANT, {});

    const result = await rig.manager.act(TENANT, view.id, {
      type: 'navigate',
      url: 'https://example.com/',
      waitUntil: 'networkidle',
    });

    expect(result.output).toEqual({ url: 'https://example.com/', status: 200 });
    expect(result.currentUrl).toBe('https://example.com/');
    expect(rig.launcher.latestPage.navigations[0]?.waitUntil).toBe('networkidle');
  });

  it('emits browser.updated with the live URL, title and screenshot ref', async () => {
    const rig = makeRig({ screenshotMaxBytes: 10_000 }, { page: { screenshotBytes: 512 } });
    const view = await rig.manager.open(TENANT, {});

    await rig.manager.act(TENANT, view.id, { type: 'screenshot' });

    const updated = rig.events.filter((event) => event.name === 'browser.updated');
    const last = updated.at(-1)?.payload as { url?: string; title?: string; screenshotRef?: string };
    expect(last.screenshotRef).toMatch(new RegExp(`^${TENANT}/screenshots/${view.id}-\\d+\\.png$`));
    expect(last.title).toBe('Example Domain');
    expect(last.url).toBe('about:blank');
  });
});

// ── the screenshot cap ────────────────────────────────────────────────────────

describe('the screenshot cap', () => {
  it('stores a capture that fits', async () => {
    const rig = makeRig({ screenshotMaxBytes: 10_000 }, { page: { screenshotBytes: 5_000 } });
    const view = await rig.manager.open(TENANT, {});

    const result = await rig.manager.act(TENANT, view.id, { type: 'screenshot', fullPage: true });
    const output = result.output as { screenshot: { bytes: number; downscaled?: boolean } };

    expect(output.screenshot.bytes).toBe(5_000);
    expect(output.screenshot.downscaled).toBeUndefined();
    expect(rig.launcher.latestPage.screenshots).toEqual([{ fullPage: true, bytes: 5_000 }]);
  });

  it('degrades a full-page capture to the viewport rather than storing nothing', async () => {
    // A full-page capture of a heavy page runs to tens of megabytes. Storing one per
    // navigation is a disk leak with a screenshot-shaped alibi.
    const rig = makeRig(
      { screenshotMaxBytes: 10_000 },
      { page: { screenshotBytes: { fullPage: 900_000, viewport: 4_000 } } },
    );
    const view = await rig.manager.open(TENANT, {});

    const result = await rig.manager.act(TENANT, view.id, { type: 'screenshot', fullPage: true });
    const output = result.output as {
      screenshot: { ref: string; bytes: number; downscaled?: boolean };
    };

    expect(rig.launcher.latestPage.screenshots).toEqual([
      { fullPage: true, bytes: 900_000 },
      { fullPage: false, bytes: 4_000 },
    ]);
    expect(output.screenshot.bytes).toBe(4_000);
    // Reported, not silently applied: a viewer looking at a partial screenshot should know
    // it is partial.
    expect(output.screenshot.downscaled).toBe(true);
    expect(await rig.storage.exists(output.screenshot.ref)).toBe(true);
  });

  it('stores nothing when even the viewport capture is over the cap, and keeps the old ref', async () => {
    const rig = makeRig({ screenshotMaxBytes: 10_000 }, { page: { screenshotBytes: 100 } });
    const view = await rig.manager.open(TENANT, {});

    // Establish a good screenshot first.
    const first = await rig.manager.act(TENANT, view.id, { type: 'screenshot' });
    expect(first.screenshotRef).toMatch(/\.png$/);

    // Now the page becomes one that cannot be captured within the cap at any size.
    rig.launcher.latestPage.screenshotBytes = { fullPage: 900_000, viewport: 500_000 };
    const result = await rig.manager.act(TENANT, view.id, { type: 'screenshot', fullPage: true });
    const output = result.output as { screenshot: null; skippedReason?: string };

    expect(output.screenshot).toBeNull();
    expect(output.skippedReason).toContain('over the 10000-byte cap');

    // The row was not pointed at a key that does not exist — it still shows the last
    // screenshot that was actually captured.
    expect(result.screenshotRef).toBe(first.screenshotRef);
    expect(await rig.storage.exists(first.screenshotRef!)).toBe(true);
  });

  it('does not let two captures collide on the documented key', async () => {
    // The key is `<sessionId>-<ts>.png` at millisecond resolution. Actions on a session are
    // serialised, so a collision needs two captures in one millisecond — the manager makes
    // that impossible rather than merely unlikely.
    const rig = makeRig({ screenshotMaxBytes: 10_000 }, { page: { screenshotBytes: 100 } });
    const view = await rig.manager.open(TENANT, {});

    const refs: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const result = await rig.manager.act(TENANT, view.id, { type: 'screenshot' });
      refs.push(result.screenshotRef!);
    }

    expect(new Set(refs).size).toBe(5);
    expect(refs[0]?.startsWith(`${TENANT}/screenshots/${view.id}-`)).toBe(true);
    for (const ref of refs) expect(ref.endsWith('.png')).toBe(true);
  });
});

// ── ordering ──────────────────────────────────────────────────────────────────

describe('action ordering', () => {
  it('serialises actions on one session instead of interleaving them', async () => {
    // A `click` racing a `goto` navigates out from under itself, and the failure is
    // intermittent rather than loud — so the ordering has to be structural.
    const rig = makeRig();
    const view = await rig.manager.open(TENANT, {});
    const page = rig.launcher.latestPage;

    const hold = deferred();
    page.hold = hold.promise;

    const first = rig.manager.act(TENANT, view.id, { type: 'click', selector: '#a' });
    const second = rig.manager.act(TENANT, view.id, { type: 'navigate', url: 'https://b.example/' });

    await flush();
    // The second action has been accepted but has not touched the page.
    expect(page.events).toEqual(['click:enter']);

    hold.resolve();
    await Promise.all([first, second]);

    expect(page.events).toEqual(['click:enter', 'click:exit', 'navigate:enter', 'navigate:exit']);
  });

  it('lets two sessions work at the same time', async () => {
    // Serialisation is per session, not global: two agents browsing must not queue behind
    // each other.
    const rig = makeRig();
    const first = await rig.manager.open(TENANT, {});
    const second = await rig.manager.open(TENANT, {});

    const holdFirst = deferred();
    rig.launcher.pageAt(0).hold = holdFirst.promise;

    const blocked = rig.manager.act(TENANT, first.id, { type: 'click', selector: '#a' });
    await flush();

    // The second session completes while the first is still held.
    await rig.manager.act(TENANT, second.id, { type: 'click', selector: '#b' });
    expect(rig.launcher.pageAt(1).clicks).toEqual([{ selector: '#b', timeout: 30_000 }]);
    expect(rig.launcher.pageAt(0).events).toEqual(['click:enter']);

    holdFirst.resolve();
    await blocked;
  });
});

// ── failures ──────────────────────────────────────────────────────────────────

describe('failures', () => {
  it('reports a Playwright failure as BROWSER_ERROR and keeps the session usable', async () => {
    const rig = makeRig();
    const view = await rig.manager.open(TENANT, {});
    rig.launcher.latestPage.failNextWith = new Error('Timeout 30000ms exceeded');

    const error = await rig.manager
      .act(TENANT, view.id, { type: 'click', selector: '#missing' })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('BROWSER_ERROR');
    expect((error as ApiError).details).toMatchObject({ sessionId: view.id, action: 'click' });

    // One failed action does not kill the session; the next one works.
    await rig.manager.act(TENANT, view.id, { type: 'click', selector: '#present' });
    expect(rig.launcher.latestPage.clicks).toEqual([{ selector: '#present', timeout: 30_000 }]);
    expect((await rig.manager.get(TENANT, view.id)).status).toBe('active');
  });

  it('does not let one failure poison the queue', async () => {
    const rig = makeRig();
    const view = await rig.manager.open(TENANT, {});
    rig.launcher.latestPage.failNextWith = new Error('boom');

    const failed = rig.manager.act(TENANT, view.id, { type: 'click', selector: '#a' });
    const following = rig.manager.act(TENANT, view.id, { type: 'click', selector: '#b' });

    await expect(failed).rejects.toMatchObject({ code: 'BROWSER_ERROR' });
    await expect(following).resolves.toMatchObject({ action: 'click' });
    expect(rig.launcher.latestPage.clicks).toEqual([{ selector: '#b', timeout: 30_000 }]);
  });

  it('refuses to act on a session that is not open', async () => {
    const rig = makeRig();
    const view = await rig.manager.open(TENANT, {});
    await rig.manager.close(TENANT, view.id);

    await expect(rig.manager.act(TENANT, view.id, { type: 'click', selector: '#a' })).rejects.toMatchObject(
      { code: 'BROWSER_ERROR' },
    );
  });

  it('still closes the session when the close action is used', async () => {
    const rig = makeRig();
    const view = await rig.manager.open(TENANT, {});

    const result = await rig.manager.act(TENANT, view.id, { type: 'close' });

    expect(result.action).toBe('close');
    expect(result.status).toBe('closed');
    expect(rig.launcher.contexts[0]?.closed).toBe(true);
  });

  it('tolerates a page that has no title yet', async () => {
    // A page mid-navigation rejects `title()` rather than returning an empty string. A
    // missing title must not fail an action that otherwise succeeded.
    const rig = makeRig();
    const view = await rig.manager.open(TENANT, {});
    const page = rig.launcher.latestPage;

    const failing = new Error('Execution context was destroyed');
    Object.assign(page, { title: async () => { throw failing; } });

    const result = await rig.manager.act(TENANT, view.id, { type: 'click', selector: '#a' });

    expect(result.title).toBeNull();
    expect(rig.launcher.latestPage.clicks).toHaveLength(1);
  });
});

// ── listing ───────────────────────────────────────────────────────────────────

describe('listing sessions', () => {
  it('lists a tenant’s sessions newest first and filters by status', async () => {
    const rig = makeRig();
    const first = await rig.manager.open(TENANT, {});
    const second = await rig.manager.open(TENANT, {});
    await rig.manager.close(TENANT, first.id);

    const all = await rig.manager.list(TENANT);
    expect(all).toHaveLength(2);

    const active = await rig.manager.list(TENANT, { status: 'active' });
    expect(active.map((view) => view.id)).toEqual([second.id]);

    const byRun = await rig.manager.list(TENANT, { runId: 'run_none' });
    expect(byRun).toEqual([]);
  });

  it('never lists another tenant’s sessions', async () => {
    const rig = makeRig();
    await rig.manager.open(OTHER_TENANT, {});

    expect(await rig.manager.list(TENANT)).toEqual([]);
  });
});
