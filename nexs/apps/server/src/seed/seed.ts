/**
 * `pnpm seed` — the CLI entry.
 *
 * This file is the composition root for the seed, and it is deliberately the only one of the
 * three: it loads configuration, opens the database, calls `runSeed` and closes the connection.
 * `run.ts` holds the logic and takes everything by injection, which is what lets the test suite
 * drive a complete seed over the in-memory database without a Postgres, a network or a key.
 *
 * Configuration comes from `process.env` via `loadConfig`, exactly as `server.ts` does — this is
 * the second and last module allowed to read the environment, and it reads it through the same
 * validator, so a missing or short `JWT_SECRET` stops the seed the same way it stops the server.
 */
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { createLogger } from '../logger.js';
import { SeedAlreadyAppliedError, runSeed } from './run.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = createDb(config, logger);

  try {
    const summary = await runSeed({ config, logger, db });

    // Printed rather than only logged: this is the one line an operator reads, and the counts are
    // what the spec fixes. A number here that disagrees with the spec is a broken fixture, and
    // seeing it on the terminal is how that gets noticed.
    process.stdout.write(
      [
        '',
        'Seed complete.',
        `  tenant      ${summary.tenantId}`,
        `  user        dev@nexs.local / dev-password`,
        '',
        ...Object.entries(summary.counts).map(
          ([name, value]) => `  ${name.padEnd(18)}${String(value)}`,
        ),
        '',
      ].join('\n'),
    );
  } catch (err) {
    if (err instanceof SeedAlreadyAppliedError) {
      // Not an error condition for a developer re-running the command — the database is already in
      // the state they wanted. Exit 0 with an explanation rather than a stack trace.
      process.stdout.write(`\n${err.message}\n\n`);
      return;
    }
    throw err;
  } finally {
    await db.$disconnect();
  }
}

await main();
