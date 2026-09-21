import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const validEnv = {
  DATABASE_URL: 'postgresql://nexs:nexs@localhost:5432/nexs',
  JWT_SECRET: 'a'.repeat(32),
} as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a minimal valid environment and applies defaults', () => {
    const config = loadConfig({ ...validEnv });

    expect(config.PORT).toBe(4000);
    expect(config.NODE_ENV).toBe('development');
    expect(config.TENANT_CONCURRENCY).toBe(5);
    expect(config.STORAGE_ROOT).toBe('./data/storage');
    expect(config.WORKER_ENABLED).toBe(true);
  });

  it('returns a frozen object', () => {
    const config = loadConfig({ ...validEnv });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('coerces numeric strings', () => {
    const config = loadConfig({ ...validEnv, PORT: '8080', MAX_UPLOAD_MB: '50' });
    expect(config.PORT).toBe(8080);
    expect(config.MAX_UPLOAD_MB).toBe(50);
  });

  // The bug this guards against: `z.coerce.boolean()` is `Boolean(value)`, so the
  // STRING "false" becomes true. Env vars are always strings, so that would make
  // every flag impossible to turn off.
  it('parses "false" as false, not as a truthy string', () => {
    const config = loadConfig({
      ...validEnv,
      WORKER_ENABLED: 'false',
      FEATURE_MCP: 'false',
      FEATURE_SANDBOX: '0',
    });

    expect(config.WORKER_ENABLED).toBe(false);
    expect(config.FEATURE_MCP).toBe(false);
    expect(config.FEATURE_SANDBOX).toBe(false);
  });

  it('parses "true" and "1" as true', () => {
    const config = loadConfig({ ...validEnv, FEATURE_CONNECTORS: 'true', FEATURE_BROWSER: '1' });
    expect(config.FEATURE_CONNECTORS).toBe(true);
    expect(config.FEATURE_BROWSER).toBe(true);
  });

  it('rejects a JWT_SECRET shorter than 32 characters', () => {
    expect(() => loadConfig({ ...validEnv, JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
  });

  it('does not require a master key, because the vault key is derived', () => {
    // The regression this pins: `NEXS_MASTER_KEY` was a required env var, so a fresh checkout
    // could not boot without inventing one. `JWT_SECRET` alone must now be enough.
    expect(() => loadConfig({ ...validEnv })).not.toThrow();
    expect('NEXS_MASTER_KEY' in loadConfig({ ...validEnv })).toBe(false);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadConfig({ JWT_SECRET: 'a'.repeat(32) })).toThrow(/DATABASE_URL/);
  });
});
