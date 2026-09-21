import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@nexs/shared';
import {
  LocalStorageService,
  assertValidStorageKey,
  contentKey,
  readText,
  storageKey,
} from '../src/services/storage/storage.service.js';

/**
 * The storage service and its key rules.
 *
 * Every `*Ref` column in the schema is an opaque key into this store, so a key that can
 * escape the root is not a cosmetic bug — it is arbitrary filesystem write from a value
 * that arrived over HTTP.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexs-storage-'));
});

afterEach(async () => {
  // Best-effort: a refused delete must never be reported as a test failure.
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

// ── key validation ────────────────────────────────────────────────────────────

describe('assertValidStorageKey', () => {
  it('accepts a well-formed key', () => {
    for (const key of ['a', 'tenants/t1/tool-results/ab/hash', 'a.b-c_d/e']) {
      expect(() => assertValidStorageKey(key), key).not.toThrow();
    }
  });

  it('rejects traversal, absolute paths and empty segments', () => {
    for (const key of [
      '',
      '..',
      '.',
      '../escape',
      'a/../../escape',
      'a/..',
      '/absolute',
      'a//b',
      'a/',
      'C:/windows',
      'a\\b',
      'a b',
      'a\u0000b',
    ]) {
      expect(() => assertValidStorageKey(key), `expected "${key}" to be rejected`).toThrow();
    }
  });

  it('rejects an over-long key', () => {
    expect(() => assertValidStorageKey('a'.repeat(513))).toThrow(/too long/);
  });
});

describe('storageKey / contentKey', () => {
  it('puts the tenant first so cleanup can be a prefix delete', () => {
    expect(storageKey('t1', 'tool-results', 'x')).toBe('t1/tool-results/x');
  });

  it('refuses a tenant id that could act as a path', () => {
    expect(() => storageKey('../../etc', 'tool-results', 'x')).toThrow();
    expect(() => storageKey('a/b', 'tool-results', 'x')).toThrow();
    // The one that matters: `posix.join('..', 'c', 'x')` normalises to `c/x`, silently
    // dropping the tenant namespace. Validating the joined key alone misses it.
    expect(() => storageKey('..', 'tool-results', 'x')).toThrow();
    expect(() => storageKey('.', 'tool-results', 'x')).toThrow();
    expect(() => storageKey('t1', '../c', 'x')).toThrow();
    expect(() => storageKey('t1', 'c', '..')).toThrow();
    expect(() => storageKey('', 'c', 'x')).toThrow();
  });

  it('keeps every key inside the tenants namespace', () => {
    expect(storageKey('t1', 'c', 'x').startsWith('t1/')).toBe(true);
  });

  it('is content-addressed, so the same payload is stored once', () => {
    expect(contentKey('t1', 'c', 'same')).toBe(contentKey('t1', 'c', 'same'));
    expect(contentKey('t1', 'c', 'same')).not.toBe(contentKey('t1', 'c', 'other'));
    // Different tenants must never share a key even for identical bytes.
    expect(contentKey('t1', 'c', 'same')).not.toBe(contentKey('t2', 'c', 'same'));
  });

  it('fans out into two levels so one directory does not collect every object', () => {
    const key = contentKey('t1', 'c', 'payload');
    const segments = key.split('/');
    // <tenantId>/<category>/<2-char shard>/<hash>
    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe('t1');
    expect(segments[2]).toHaveLength(2);
  });
});

// ── round trip ────────────────────────────────────────────────────────────────

describe('LocalStorageService', () => {
  it('stores and returns bytes unchanged', async () => {
    const storage = new LocalStorageService(root);
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x80]);

    const stored = await storage.put('a/b/c', payload);
    expect(stored.sizeBytes).toBe(4);
    expect(await storage.get('a/b/c')).toEqual(payload);
  });

  it('stores text as utf-8 and reports the byte count, not the character count', async () => {
    const storage = new LocalStorageService(root);

    // 4 characters, 11 bytes — a cap measured in characters would under-report this.
    const stored = await storage.put('unicode', '日本語テ');

    expect(stored.sizeBytes).toBe(12);
    expect(await readText(storage, 'unicode')).toBe('日本語テ');
  });

  it('creates intermediate directories', async () => {
    const storage = new LocalStorageService(root);
    await storage.put('deeply/nested/path/file', 'x');
    expect(await storage.exists('deeply/nested/path/file')).toBe(true);
  });

  it('reports existence without throwing', async () => {
    const storage = new LocalStorageService(root);
    expect(await storage.exists('nothing')).toBe(false);
    await storage.put('something', 'x');
    expect(await storage.exists('something')).toBe(true);
  });

  it('returns NOT_FOUND rather than an fs error for a missing key', async () => {
    const storage = new LocalStorageService(root);

    const error = (await storage.get('missing').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('NOT_FOUND');
  });

  it('deletes idempotently', async () => {
    const storage = new LocalStorageService(root);
    await storage.put('gone', 'x');

    expect(await storage.delete('gone')).toBe(true);
    expect(await storage.delete('gone')).toBe(false);
    expect(await storage.exists('gone')).toBe(false);
  });

  it('refuses a key that would escape the root', async () => {
    const storage = new LocalStorageService(root);

    // Both of these are already rejected by key validation; the point is that they never
    // reach `writeFile`.
    for (const key of ['../outside', '/etc/passwd']) {
      const error = (await storage.put(key, 'x').catch((e: unknown) => e)) as ApiError;
      expect(error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('anchors the root at construction, not at call time', () => {
    // A relative root interpreted later would depend on the process's cwd, which the
    // engine changes when it runs a sandboxed step.
    const storage = new LocalStorageService('./relative-root');
    expect(storage.rootPath).toMatch(/[\\/]relative-root$/);
  });

  it('exposes an absolute path for the same key', async () => {
    const storage = new LocalStorageService(root);
    await storage.put('a/b', 'x');

    expect(storage.resolvePath('a/b')).toBe(join(root, 'a', 'b'));
  });
});
