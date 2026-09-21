import { Worker } from 'node:worker_threads';
import type { SandboxRunRequest, SandboxRunResult } from '@nexs/shared';

/**
 * [gap #24] JavaScript isolation via `worker_threads`.
 *
 * This is the fix for the documentation bug recorded as C3: `child_process` has **no**
 * `resourceLimits` option — it is a `worker_threads` constructor argument. The two
 * mechanisms are not interchangeable:
 *
 *   - `worker_threads` + `resourceLimits` bounds the V8 heap and lets us kill a runaway
 *     computation. It shares the process, so it is a **resource** boundary.
 *   - `child_process` + ulimit + a cwd jail is a **process** boundary, and is what you
 *     need for genuinely untrusted code.
 *
 * What this provider therefore claims: a memory ceiling, a wall-clock ceiling, no
 * `require`, no module resolution, and no way to observe or corrupt another worker's
 * state. What it explicitly does **not** claim: security against hostile code. A worker
 * shares `globalThis` semantics and the filesystem, so untrusted input belongs in the
 * Docker provider (`SandboxSession.provider = 'docker'`), which is deliberately stubbed
 * for now rather than half-built.
 */

export interface SandboxProvider {
  readonly name: string;
  run(request: SandboxRunRequest): Promise<SandboxRunResult>;
  /** Kill every worker this provider has in flight. Called on shutdown. */
  dispose(): Promise<void>;
}

export interface NodeWorkerProviderOptions {
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
  stackSizeMb: number;
  defaultTimeoutMs: number;
  defaultMaxOutputBytes: number;
}

export const DEFAULT_WORKER_LIMITS: NodeWorkerProviderOptions = {
  maxOldGenerationSizeMb: 128,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
  defaultTimeoutMs: 30_000,
  defaultMaxOutputBytes: 256 * 1024,
};

/**
 * The program every worker runs.
 *
 * Built as a string and started with `eval: true` rather than shipped as a separate file:
 * a sibling `.js` would have to be copied into `dist` by a build step that `tsc` does not
 * provide, and a missing bootstrap file is a runtime failure in production only.
 *
 * The wrapper's job is to capture console output, run the user's code with its dangerous
 * globals shadowed, and post exactly one message back.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const util = require('node:util');

const stdout = [];
const stderr = [];

function record(sink) {
  return function (...parts) {
    sink.push(parts.map((p) => (typeof p === 'string' ? p : util.inspect(p))).join(' '));
  };
}

const sandboxConsole = {
  log: record(stdout),
  info: record(stdout),
  debug: record(stdout),
  trace: record(stdout),
  warn: record(stderr),
  error: record(stderr),
};

// Shadowed so the snippet cannot reach the module system or terminate the host process.
// This is convenience, not a security boundary: a determined snippet could still reach
// the real globals through \`globalThis\`.
const blocked = () => {
  throw new Error('Not available inside the sandbox');
};

(async () => {
  let exitCode = 0;
  let value;
  let error;

  try {
    // An async function constructor, not the plain Function constructor. A plain Function
    // body is not an async context, so any snippet containing await is a syntax error —
    // which would rule out almost every useful transform, since they routinely await a
    // fetch or a delay.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

    const fn = new AsyncFunction(
      'input',
      'console',
      'require',
      'module',
      'exports',
      '__dirname',
      '__filename',
      'process',
      '"use strict";\\n' + workerData.code,
    );

    value = await fn(
      workerData.input,
      sandboxConsole,
      blocked,
      undefined,
      undefined,
      undefined,
      undefined,
      { env: {}, argv: [], exit: blocked },
    );
  } catch (err) {
    exitCode = 1;
    error = err && err.message ? String(err.message) : String(err);
    stderr.push(error);
  }

  parentPort.postMessage({ exitCode, value, error, stdout, stderr });
})();
`;

interface WorkerMessage {
  exitCode: number;
  value?: unknown;
  error?: string;
  stdout: string[];
  stderr: string[];
}

/** Per-worker state the exit handler needs in order to classify how the run ended. */
interface WorkerState {
  disposed: boolean;
}

export class NodeWorkerProvider implements SandboxProvider {
  readonly name = 'worker-thread';

  private readonly options: NodeWorkerProviderOptions;
  private readonly live = new Map<Worker, WorkerState>();

  constructor(options: Partial<NodeWorkerProviderOptions> = {}) {
    this.options = { ...DEFAULT_WORKER_LIMITS, ...options };
  }

  /** Workers currently in flight — asserted by the shutdown tests. */
  get activeWorkers(): number {
    return this.live.size;
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunResult> {
    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs;
    const maxOutputBytes = request.maxOutputBytes ?? this.options.defaultMaxOutputBytes;

    const startedAt = Date.now();

    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { code: request.code, input: request.input },
      // The option that does not exist on `child_process`. Without it a snippet can
      // allocate until the whole process is killed, taking every other tenant's run
      // with it.
      resourceLimits: {
        maxOldGenerationSizeMb: this.options.maxOldGenerationSizeMb,
        maxYoungGenerationSizeMb: this.options.maxYoungGenerationSizeMb,
        stackSizeMb: this.options.stackSizeMb,
      },
    });

    const state: WorkerState = { disposed: false };
    this.live.set(worker, state);

    try {
      return await this.awaitWorker(worker, state, { startedAt, timeoutMs, maxOutputBytes });
    } finally {
      this.live.delete(worker);
    }
  }

  async dispose(): Promise<void> {
    const entries = [...this.live.entries()];
    this.live.clear();

    await Promise.all(
      entries.map(([worker, state]) => {
        // Marked before terminating so the exit handler can report "disposed" rather than
        // pretending the snippet failed on its own merits.
        state.disposed = true;
        return worker.terminate().catch(() => undefined);
      }),
    );
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private awaitWorker(
    worker: Worker,
    state: WorkerState,
    context: { startedAt: number; timeoutMs: number; maxOutputBytes: number },
  ): Promise<SandboxRunResult> {
    return new Promise<SandboxRunResult>((resolve) => {
      let settled = false;
      let timedOut = false;
      let messageReceived = false;

      const timer = setTimeout(() => {
        timedOut = true;
        // `terminate` is what makes the timeout real. Racing a promise would leave the
        // worker spinning and burning a core for the rest of the process's life.
        void worker.terminate().catch(() => undefined);
      }, context.timeoutMs);

      const finish = (result: SandboxRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      worker.on('message', (message: WorkerMessage) => {
        messageReceived = true;
        const stdout = capOutput(message.stdout.join('\n'), context.maxOutputBytes);
        const stderr = capOutput(message.stderr.join('\n'), context.maxOutputBytes);

        finish({
          ...(message.value === undefined ? {} : { value: message.value }),
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: message.exitCode,
          status: message.exitCode === 0 ? 'completed' : 'failed',
          durationMs: Date.now() - context.startedAt,
          ...(stdout.truncated || stderr.truncated ? { outputTruncated: true } : {}),
        });
      });

      worker.on('error', (error: Error) => {
        // An OOM inside the worker surfaces here as ERR_WORKER_OUT_OF_MEMORY. The worker
        // is already dead, so there is nothing to terminate.
        const outOfMemory = (error as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY';

        finish({
          stdout: '',
          stderr: error.message,
          exitCode: 1,
          status: 'failed',
          durationMs: Date.now() - context.startedAt,
          terminatedReason: outOfMemory ? 'resource-limit' : 'worker-error',
        });
      });

      worker.on('exit', (code: number) => {
        // A worker killed by us never posts a message, so this is the only place that can
        // report *why* it stopped. Precedence matters: a disposal is not a timeout, and a
        // snippet killed mid-flight did not "complete".
        const terminatedReason = state.disposed
          ? 'disposed'
          : timedOut
            ? 'timeout'
            : messageReceived
              ? undefined
              : // The worker's event loop drained while the snippet was still suspended —
                // `await new Promise(() => {})` is the canonical case. Node exits cleanly
                // because a pending promise does not keep a worker alive, so the exit code
                // is 0 even though the code never produced anything. Reporting `completed`
                // here would hand the caller `undefined` as a successful transform result.
                'no-result';

        // `timeout` is its own status in `SandboxExecution.status`, so it is reported as
        // such rather than flattened into `failed` — the UI distinguishes them.
        const status =
          terminatedReason === 'timeout'
            ? 'timeout'
            : terminatedReason !== undefined
              ? 'failed'
              : code === 0
                ? 'completed'
                : 'failed';

        finish({
          stdout: '',
          stderr:
            terminatedReason === 'no-result'
              ? 'Execution ended without producing a result — the code awaited something that never settled'
              : '',
          exitCode: code,
          status,
          durationMs: Date.now() - context.startedAt,
          ...(terminatedReason === undefined ? {} : { terminatedReason }),
        });
      });
    });
  }
}

/** Bound a captured stream without splitting a character. */
function capOutput(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text, truncated: false };

  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;

  return { text: `${buffer.subarray(0, end).toString('utf8')}\n…output truncated`, truncated: true };
}
