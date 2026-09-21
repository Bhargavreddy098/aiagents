import PgBoss from 'pg-boss';
import type { Logger } from '../../logger.js';
import type { QueueClient } from './queue.service.js';

/**
 * The one place a real `PgBoss` is constructed.
 *
 * Isolating it here is what lets every other queue module be a pure declaration: nothing
 * else imports the transport, so nothing else has to be stubbed to test the lifecycle.
 *
 * ## Resolution hazard (worth remembering)
 *
 * pg-boss 10 is CommonJS with `export = PgBoss`. Under this project's NodeNext/ESM
 * resolution the value must be imported as a **default** (`import PgBoss from 'pg-boss'`),
 * unlike `pino-http` in this same codebase, which must be imported by its **named** export.
 * The two differ because pg-boss uses `export =` while pino-http uses a dual named/default
 * export. Getting this wrong is not a type error under `esModuleInterop` — it fails at
 * runtime with "PgBoss is not a constructor".
 */
export function createBoss(config: {
  connectionString: string;
  schema: string;
  logger: Logger;
}): QueueClient {
  const boss = new PgBoss({
    connectionString: config.connectionString,
    schema: config.schema,
    /**
     * Keep the pool small.
     *
     * The API process already holds a Prisma pool; pg-boss opens its own. Two generous
     * pools against one Postgres is how a modest deployment discovers `max_connections`
     * the hard way. The queue's work is occasional (a run handoff, a sweep), so it does
     * not need concurrency of its own.
     */
    max: 4,
  });

  // pg-boss emits `error` for background failures — a lost connection, a failed
  // maintenance run. Without a listener these are Node's "unhandled error event" and take
  // the process down, turning a recoverable transport hiccup into an outage.
  boss.on('error', (err: Error) => {
    config.logger.error({ err }, 'pg-boss reported an error');
  });

  return boss as unknown as QueueClient;
}
