import { PrismaClient } from '@prisma/client';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export function createDb(config: Config, logger: Logger): PrismaClient {
  const db = new PrismaClient({
    datasources: { db: { url: config.DATABASE_URL } },
    log: [
      { level: 'warn', emit: 'event' },
      { level: 'error', emit: 'event' },
    ],
  });

  db.$on('warn' as never, (e: unknown) => logger.warn({ prisma: e }, 'prisma warning'));
  db.$on('error' as never, (e: unknown) => logger.error({ prisma: e }, 'prisma error'));

  return db;
}

export type Db = PrismaClient;
