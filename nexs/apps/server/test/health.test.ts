import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createApp } from '../src/http/app.js';
import type { Db } from '../src/db.js';
import type { QueueStatus } from '../src/routes/health.js';

/** Health must be testable without a live Postgres — stub only what it touches. */
function fakeDb(behaviour: 'up' | 'down'): Db {
  return {
    $queryRaw: async () => {
      if (behaviour === 'down') throw new Error('connection refused');
      return [{ ok: 1 }];
    },
  } as unknown as Db;
}

const config = loadConfig();
const logger = createLogger(config);

function appWith(db: Db, queue: QueueStatus) {
  return createApp({ config, logger, db, queueStatus: () => queue });
}

describe('GET /api/health', () => {
  it('returns 200 with db and queue status when the database answers', async () => {
    const res = await request(appWith(fakeDb('up'), 'not_initialized')).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      db: 'up',
      queue: 'not_initialized',
      version: '0.1.0',
    });
    expect(res.body.features).toBeDefined();
  });

  it('returns 503 and reports db down when the database is unreachable', async () => {
    const res = await request(appWith(fakeDb('down'), 'up')).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'down' });
  });

  it('returns 503 when the queue is down even though the database is up', async () => {
    const res = await request(appWith(fakeDb('up'), 'down')).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'up', queue: 'down' });
  });

  it('echoes a correlation id and honours an inbound one', async () => {
    const generated = await request(appWith(fakeDb('up'), 'up')).get('/api/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await request(appWith(fakeDb('up'), 'up'))
      .get('/api/health')
      .set('x-request-id', 'trace-me-123');
    expect(echoed.headers['x-request-id']).toBe('trace-me-123');
  });

  it('ignores an absurdly long inbound correlation id', async () => {
    const res = await request(appWith(fakeDb('up'), 'up'))
      .get('/api/health')
      .set('x-request-id', 'x'.repeat(500));

    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('error handling', () => {
  it('returns the standard error envelope for an unknown route', async () => {
    const res = await request(appWith(fakeDb('up'), 'up')).get('/api/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });
});
