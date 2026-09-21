import { afterEach, describe, expect, it } from 'vitest';
import { NodeWorkerProvider, type SandboxProvider } from '../src/services/sandbox/node-worker.provider.js';

/**
 * The sandbox provider.
 *
 * [gap #24] The documentation bug this closes: `child_process` has no `resourceLimits`
 * option — it is a `worker_threads` constructor argument. The tests below are the
 * evidence that the limits are real rather than decorative, because a memory ceiling that
 * does not actually stop a memory bomb is worse than none: it is a promise the system
 * makes and then breaks.
 *
 * Every test must leave no worker behind, which is why each one asserts on
 * `activeWorkers` or disposes explicitly.
 */

let provider: SandboxProvider | null = null;

function make(options: ConstructorParameters<typeof NodeWorkerProvider>[0] = {}): NodeWorkerProvider {
  provider = new NodeWorkerProvider(options);
  return provider as NodeWorkerProvider;
}

afterEach(async () => {
  // A leaked worker keeps the process alive and burns a core; disposing here means a
  // failing test cannot hang the suite.
  await provider?.dispose();
  provider = null;
});

// ── the happy path ────────────────────────────────────────────────────────────

describe('running code', () => {
  it('returns the value the code produced', async () => {
    const sandbox = make();
    const result = await sandbox.run({ code: 'return 6 * 7;' });

    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.value).toBe(42);
  });

  it('passes input in and structured data back', async () => {
    const sandbox = make();
    const result = await sandbox.run({
      code: 'return input.rows.map((row) => row * 2);',
      input: { rows: [1, 2, 3] },
    });

    expect(result.value).toEqual([2, 4, 6]);
  });

  it('awaits an async body', async () => {
    const sandbox = make();
    const result = await sandbox.run({
      code: 'const v = await Promise.resolve("later"); return v;',
    });

    expect(result.value).toBe('later');
  });

  it('captures console output separately from the return value', async () => {
    const sandbox = make();
    const result = await sandbox.run({
      code: 'console.log("to stdout"); console.error("to stderr"); return "ok";',
    });

    expect(result.value).toBe('ok');
    expect(result.stdout).toContain('to stdout');
    expect(result.stderr).toContain('to stderr');
    // The streams must not bleed into each other.
    expect(result.stdout).not.toContain('to stderr');
    expect(result.stderr).not.toContain('to stdout');
  });

  it('formats a non-string log argument rather than dropping it', async () => {
    const sandbox = make();
    const result = await sandbox.run({ code: 'console.log({ a: 1 }); return null;' });

    expect(result.stdout).toContain('a');
    expect(result.stdout).toContain('1');
  });

  it('measures its own duration', async () => {
    const sandbox = make();
    const result = await sandbox.run({ code: 'return 1;' });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(30_000);
  });

  it('releases the worker when the code finishes', async () => {
    const sandbox = make();
    await sandbox.run({ code: 'return 1;' });

    // A worker left in the set is a leak even though the call succeeded.
    expect(sandbox.activeWorkers).toBe(0);
  });
});

// ── failures ──────────────────────────────────────────────────────────────────

describe('failing code', () => {
  it('reports a thrown error as a failed execution, not a rejected promise', async () => {
    const sandbox = make();
    const result = await sandbox.run({ code: 'throw new Error("boom");' });

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('boom');
    expect(result.value).toBeUndefined();
  });

  it('reports a rejected promise as a failure', async () => {
    const sandbox = make();
    const result = await sandbox.run({ code: 'await Promise.reject(new Error("nope"));' });

    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('nope');
  });

  it('reports a syntax error rather than hanging', async () => {
    const sandbox = make();
    const result = await sandbox.run({ code: 'return (((;' });

    expect(result.status).toBe('failed');
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('reports a non-Error throw', async () => {
    const sandbox = make();
    const result = await sandbox.run({ code: 'throw "just a string";' });

    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('just a string');
  });

  it('releases the worker after a failure', async () => {
    const sandbox = make();
    await sandbox.run({ code: 'throw new Error("boom");' });

    expect(sandbox.activeWorkers).toBe(0);
  });
});

// ── the timeout ───────────────────────────────────────────────────────────────

describe('the wall-clock ceiling', () => {
  it('kills an infinite loop instead of waiting for it', async () => {
    const sandbox = make();
    const result = await sandbox.run({ code: 'while (true) {}', timeoutMs: 300 });

    expect(result.status).toBe('timeout');
    expect(result.terminatedReason).toBe('timeout');
    // A promise race would leave this spinning; terminating is what makes it real.
    expect(sandbox.activeWorkers).toBe(0);
  });

  it('reports a promise that never settles as no result, not as success', async () => {
    const sandbox = make();
    const result = await sandbox.run({
      code: 'await new Promise(() => {}); return "never";',
      timeoutMs: 5_000,
    });

    // A pending promise does not keep a worker's event loop alive, so Node exits cleanly
    // with code 0 while the snippet is still suspended. Calling that `completed` would
    // hand the caller `undefined` as a successful transform result.
    expect(result.status).toBe('failed');
    expect(result.terminatedReason).toBe('no-result');
    expect(result.stderr).toContain('never settled');
    expect(sandbox.activeWorkers).toBe(0);
  });

  it('does not kill code that finishes inside the ceiling', async () => {
    const sandbox = make();
    const result = await sandbox.run({
      code: 'await new Promise((r) => setTimeout(r, 50)); return "in time";',
      timeoutMs: 5_000,
    });

    expect(result.status).toBe('completed');
    expect(result.value).toBe('in time');
  });

  it('leaves no worker running after a timeout', async () => {
    const sandbox = make();
    await sandbox.run({ code: 'while (true) {}', timeoutMs: 200 });

    // Give `terminate` a moment to settle, then assert nothing is left behind.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sandbox.activeWorkers).toBe(0);
  });
});

// ── the memory ceiling ────────────────────────────────────────────────────────

describe('the memory ceiling', () => {
  it('stops a memory bomb that would otherwise take the process down', async () => {
    // `maxOldGenerationSizeMb` is the option that has no `child_process` equivalent.
    const sandbox = make({ maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 });

    const result = await sandbox.run({
      code: `
        const held = [];
        for (;;) held.push(new Array(1_000_000).fill('x'));
      `,
      timeoutMs: 20_000,
    });

    // Either the V8 limit fired first (resource-limit) or the timeout did. Both prove the
    // worker could not consume the host's memory, which is the property under test.
    expect(['failed', 'timeout']).toContain(result.status);
    expect(['resource-limit', 'timeout']).toContain(result.terminatedReason);
    expect(sandbox.activeWorkers).toBe(0);
  });

  it('lets code run comfortably inside a generous ceiling', async () => {
    const sandbox = make({ maxOldGenerationSizeMb: 256 });

    const result = await sandbox.run({
      code: 'const big = new Array(100_000).fill(1); return big.length;',
    });

    expect(result.value).toBe(100_000);
  });
});

// ── output cap ────────────────────────────────────────────────────────────────

describe('the output cap', () => {
  it('caps a chatty program rather than buffering all of it', async () => {
    const sandbox = make();

    const result = await sandbox.run({
      code: 'for (let i = 0; i < 20000; i += 1) console.log("line " + i); return "done";',
      maxOutputBytes: 1_024,
    });

    expect(result.value).toBe('done');
    expect(result.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThan(1_200);
  });

  it('leaves small output unmarked', async () => {
    const sandbox = make();
    const result = await sandbox.run({ code: 'console.log("short"); return 1;' });

    expect(result.outputTruncated).toBeUndefined();
  });
});

// ── the module system ─────────────────────────────────────────────────────────

describe('what the snippet cannot reach', () => {
  it('blocks require', async () => {
    const sandbox = make();
    const result = await sandbox.run({ code: 'return typeof require;' });

    // Shadowed with a function that throws, so the snippet cannot pull in `node:fs`.
    expect(result.value).toBe('function');
    expect(result.status).toBe('completed');

    const attempted = await sandbox.run({ code: 'require("node:fs"); return "got in";' });
    expect(attempted.status).toBe('failed');
    expect(attempted.stderr).toContain('Not available inside the sandbox');
  });

  it('does not expose module or __dirname', async () => {
    const sandbox = make();
    const result = await sandbox.run({
      code: 'return { module: typeof module, dirname: typeof __dirname, exports: typeof exports };',
    });

    expect(result.value).toEqual({ module: 'undefined', dirname: 'undefined', exports: 'undefined' });
  });

  it('does not expose the host environment', async () => {
    const sandbox = make();
    const result = await sandbox.run({
      code: 'return { keys: Object.keys(process.env).length, argv: process.argv.length };',
    });

    // A snippet that could read `process.env` would read the master key.
    expect(result.value).toEqual({ keys: 0, argv: 0 });
  });

  it('does not leak one execution into the next', async () => {
    const sandbox = make();
    await sandbox.run({ code: 'globalThis.leaked = "from run one"; return 1;' });

    const second = await sandbox.run({ code: 'return typeof globalThis.leaked;' });
    // A fresh worker per call is what makes this true.
    expect(second.value).toBe('undefined');
  });
});

// ── shutdown ──────────────────────────────────────────────────────────────────

describe('dispose', () => {
  it('kills everything in flight', async () => {
    const sandbox = make();

    // Start a long run and dispose while it is still going.
    const running = sandbox.run({ code: 'while (true) {}', timeoutMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sandbox.activeWorkers).toBe(1);
    await sandbox.dispose();

    const result = await running;
    // Shutting the server down is not the snippet failing on its own merits, and it is
    // certainly not a timeout — the reason is recorded separately from the status.
    expect(result.status).toBe('failed');
    expect(result.terminatedReason).toBe('disposed');
    expect(sandbox.activeWorkers).toBe(0);
  });

  it('is safe to call with nothing running', async () => {
    const sandbox = make();
    await expect(sandbox.dispose()).resolves.toBeUndefined();
  });
});
