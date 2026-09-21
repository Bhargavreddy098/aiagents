import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, posix, resolve, sep } from 'node:path';
import { ApiError } from '@nexs/shared';

/**
 * [gap #25] Where large payloads live.
 *
 * `screenshotRef`, overflowed tool results and attachments are all *opaque keys* into
 * this store — never filesystem paths. That is what makes the local-FS implementation
 * replaceable with S3 without touching a single caller, and it is why every `*Ref`
 * column in the schema is a `String` rather than something path-shaped.
 */

export interface StoredObject {
  key: string;
  sizeBytes: number;
  contentType?: string;
}

export interface StorageService {
  put(key: string, data: Buffer | string, options?: { contentType?: string }): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  /** Absolute location, for the local backend only. Used by the cleanup job and tests. */
  resolvePath?(key: string): string;
}

/**
 * A key is a `/`-separated relative path with no traversal, no absolute root and no
 * empty segments.
 *
 * Validated rather than sanitised: a key that needed cleaning up is a caller bug, and
 * silently rewriting it would let a tenant id with a `..` in it reach another tenant's
 * directory. Rejecting is the only safe response.
 */
const KEY_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function assertValidStorageKey(key: string): void {
  if (key.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Storage key must not be empty');
  }
  if (key.length > 512) {
    throw new ApiError('VALIDATION_ERROR', 'Storage key is too long');
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ApiError('VALIDATION_ERROR', 'Storage key contains unsupported characters', { key });
  }
  // Belt and braces: the pattern already excludes `..` as a whole segment, but a key of
  // exactly `..` or `.` would otherwise slip through as a single segment.
  if (key.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new ApiError('VALIDATION_ERROR', 'Storage key must not contain a traversal segment', {
      key,
    });
  }
}

/** One path segment: no separators, no traversal, no whitespace. */
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Validate a single segment *before* it is joined.
 *
 * Validating only the joined key is not enough: `posix.join('..', 'c')` normalises to `c`,
 * so a tenant id of `..` would quietly place the object outside every tenant's namespace —
 * and `posix.join('t1', '..', 'c')` would move it into a *different* tenant's tree. Checking
 * the inputs is what makes the result trustworthy.
 */
function assertSafeSegment(segment: string, label: string): void {
  if (segment.length > 0 && segment !== '.' && segment !== '..' && SEGMENT_PATTERN.test(segment)) {
    return;
  }
  throw new ApiError('VALIDATION_ERROR', `${label} is not a safe path segment`, { [label]: segment });
}

/**
 * Build a key for a tenant-owned object.
 *
 * The layout is the one the spec documents under `STORAGE_ROOT` — `<tenantId>/uploads/…`,
 * `<tenantId>/screenshots/…`, `<tenantId>/sandbox/…`, `<tenantId>/research/…` — so tenant id
 * is the first segment. That makes per-tenant cleanup a prefix delete, and it means a key
 * leaked into a log is at least attributable. An extra `tenants/` namespace above it would
 * have been defensible on its own terms, but the layout is a documented contract and a
 * divergent one is a bug in waiting.
 */
export function storageKey(
  tenantId: string,
  category: string,
  ...parts: readonly string[]
): string {
  assertSafeSegment(tenantId, 'tenantId');
  assertSafeSegment(category, 'category');
  for (const part of parts) assertSafeSegment(part, 'keyPart');

  const key = posix.join(tenantId, category, ...parts);
  assertValidStorageKey(key);
  return key;
}

/** Stable, collision-free name for a payload whose natural id we do not have. */
export function contentKey(tenantId: string, category: string, content: Buffer | string): string {
  const hash = createHash('sha256').update(content).digest('hex');
  // Two-level fan-out keeps a directory from accumulating millions of entries, which
  // makes `readdir`-based cleanup jobs unusable on ext4.
  return storageKey(tenantId, category, hash.slice(0, 2), hash);
}

export class LocalStorageService implements StorageService {
  private readonly root: string;

  constructor(root: string) {
    // Resolved once at construction: a relative root would otherwise be interpreted
    // against whatever the process's cwd happens to be at call time.
    this.root = resolve(root);
  }

  resolvePath(key: string): string {
    assertValidStorageKey(key);
    const full = resolve(this.root, key);

    // The guard that matters. `assertValidStorageKey` already rejects `..`, but a
    // resolved path is the only thing that can prove it — a symlinked segment inside the
    // root would otherwise escape without the key ever looking suspicious.
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new ApiError('VALIDATION_ERROR', 'Storage key resolves outside the storage root', {
        key,
      });
    }

    return full;
  }

  async put(
    key: string,
    data: Buffer | string,
    options: { contentType?: string } = {},
  ): Promise<StoredObject> {
    const path = this.resolvePath(key);
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, buffer);

    return {
      key,
      sizeBytes: buffer.byteLength,
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolvePath(key));
    } catch (cause) {
      throw new ApiError('NOT_FOUND', 'Stored object not found', { key, cause: String(cause) });
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<boolean> {
    const path = this.resolvePath(key);
    try {
      await stat(path);
    } catch {
      return false;
    }
    await rm(path, { force: true });
    return true;
  }

  /** Where the root actually is, for logging and for the orphan-cleanup job. */
  get rootPath(): string {
    return this.root;
  }
}

/** Read a stored object back as text, for the engine's prompt assembly. */
export async function readText(storage: StorageService, key: string): Promise<string> {
  return (await storage.get(key)).toString('utf8');
}
