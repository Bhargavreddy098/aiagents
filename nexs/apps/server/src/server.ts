/**
 * Composition root.
 * This is the only place that constructs concrete implementations and wires them
 * together. Nothing else in the codebase reads process.env or builds a client.
 */
import { createApp } from './http/app.js';
import { wireRuntime } from './runtime.js';
import type { QueueStatus } from './routes/health.js';

async function main(): Promise<void> {
  const runtime = await wireRuntime();
  const { container, logger, config, db, queue } = runtime;

  // The queue is connected by the time this runs — `wireRuntime` awaits it, because
  // pg-boss `start()` migrates its schema and a job sent before that is refused. So
  // "up" here is a statement about a connection that was actually established, not a
  // hopeful constant. The endpoint still reports honestly if nothing consumes the queue:
  // see the `consumeRuns` field in the worker's own startup log.
  const queueStatus = (): QueueStatus => (queue.connected ? 'up' : 'down');

  const app = createApp({
    config,
    logger,
    db,
    container,
    queueStatus,
    version: '0.1.0',
  });

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV, workerEnabled: config.WORKER_ENABLED },
      'nexs api listening',
    );
  });

  // The heartbeat is driven from the composition root rather than owned by the hub, so the
  // hub stays a pure function of its inputs and is testable by calling `beat()` directly —
  // no fake timers, and no interval left running in a test process.
  const heartbeat = setInterval(() => {
    container.sseHub.beat();
  }, config.SSE_HEARTBEAT_MS);
  // `unref` so a pending heartbeat never keeps the process alive on its own.
  heartbeat.unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 30_000);
    force.unref();

    clearInterval(heartbeat);

    // Streams are told the server is going away *before* the socket closes, so a client can
    // tell "shut down" apart from "your network died" and not reconnect into a closing server.
    container.sseHub.closeAll('server_shutdown');

    server.close(() => logger.info('http server closed'));

    // The queue stops before the database closes, so a consumer mid-job is not left holding
    // a pool that is being torn down. `graceful: false` is deliberate — see the worker.
    await runtime.stop();

    // Ordered deliberately. The MCP manager owns child processes and the browser manager
    // owns a Chromium, so they go first and their failures are swallowed: a wedged external
    // resource must not stop the database from closing cleanly. `shutdown()` clears each
    // MCP row's pid, which is what makes the next boot's orphan reconciliation a no-op for a
    // shutdown that went to plan.
    await container.mcp.shutdown().catch((err: unknown) => {
      logger.warn({ err }, 'mcp shutdown did not complete cleanly');
    });
    await container.browser.shutdown().catch((err: unknown) => {
      logger.warn({ err }, 'browser shutdown did not complete cleanly');
    });
    await container.sandbox.dispose().catch((err: unknown) => {
      logger.warn({ err }, 'sandbox workers did not all stop');
    });

    await db.$disconnect();
    clearTimeout(force);
    process.exit(0);
  };

  // Startup reconciliation, before the server accepts traffic: reaping a leaked MCP child
  // before it can be re-adopted, and closing browser sessions whose Chromium died with the
  // previous process.
  await container.mcp
    .reapOrphans()
    .then((outcomes) => {
      if (outcomes.length > 0) {
        logger.info({ outcomes }, 'reconciled MCP servers left by a previous run');
      }
    })
    .catch((err: unknown) => {
      logger.warn({ err }, 'MCP orphan reconciliation failed; continuing');
    });

  await container.browser
    .reconcile()
    .then((closed) => {
      if (closed > 0) logger.info({ closed }, 'closed browser sessions left active by a previous run');
    })
    .catch((err: unknown) => {
      logger.warn({ err }, 'browser session reconciliation failed; continuing');
    });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const fatal = (err: unknown): void => {
    logger.fatal({ err }, 'fatal error');
    process.exit(1);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
}

main().catch((err: unknown) => {
  // config/DB failures happen before the logger exists — use stderr directly
  console.error('failed to start:', err);
  process.exit(1);
});
