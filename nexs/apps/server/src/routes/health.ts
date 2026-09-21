import { Router } from 'express';
import type { Config } from '../config.js';
import type { Db } from '../db.js';

export type QueueStatus = 'up' | 'down' | 'not_initialized';

export interface HealthDeps {
  db: Db;
  config: Config;
  /**
   * Whether the queue connection is established. A thunk rather than a value, because the
   * service it reads can be stopped after the app is built, and `up`/`down` is a claim
   * about the connection that must be evaluated at request time to stay honest.
   */
  queueStatus: () => QueueStatus;
  version: string;
}

async function checkDb(db: Db): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();
  const startedAt = Date.now();

  router.get('/', async (_req, res) => {
    const dbUp = await checkDb(deps.db);
    const queue = deps.queueStatus();
    const healthy = dbUp && queue !== 'down';

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      db: dbUp ? 'up' : 'down',
      queue,
      version: deps.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      // the web shell hides nav entries for disabled features (no separate config endpoint)
      features: {
        mcp: deps.config.FEATURE_MCP,
        connectors: deps.config.FEATURE_CONNECTORS,
        sandbox: deps.config.FEATURE_SANDBOX,
        browser: deps.config.FEATURE_BROWSER,
        research: deps.config.FEATURE_RESEARCH,
      },
    });
  });

  return router;
}
