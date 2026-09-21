import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ApiError } from '@nexs/shared';
import type { Logger } from '../../logger.js';

/**
 * [gap #25] Tenant-scoped filesystem access.
 *
 * The only module allowed to hand a path to `node:fs`. Two rules it exists to enforce:
 *
 *  1. **A tenant cannot name a path outside its own workdir.** Every path is resolved
 *     and then checked to be inside a root the caller was granted — never string-matched,
 *     because `..`, absolute paths and symlinks all defeat a prefix comparison.
 *  2. **Symlinks are resolved before the check, not after.** A grant for `/work/data`
 *     must not become access to `/etc` because somebody put a symlink in the way.
 *
 * `FolderGrant.resolvedPath` is the schema's own record of the second rule: the path
 * stored at grant time is the realpath, so a later symlink swap is detectable.
 */

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'directory';
  sizeBytes: number;
  modifiedAt: Date;
}

export interface FileAccess {
  read: boolean;
  write: boolean;
}

export interface FolderGrantRecord {
  rootPath: string;
  resolvedPath: string;
  read: boolean;
  write: boolean;
}

export interface FileServiceDeps {
  /** Base directory for tenant workdirs. */
  root: string;
  logger: Logger;
}

export class FileService {
  private readonly root: string;
  private readonly logger: Logger;

  constructor(deps: FileServiceDeps) {
    this.root = resolve(deps.root);
    this.logger = deps.logger;
  }

  /** `<root>/tenants/<tenantId>` — created on first use, not at startup. */
  workdir(tenantId: string): string {
    assertSafeSegment(tenantId, 'tenantId');
    return join(this.root, 'tenants', tenantId);
  }

  async ensureWorkdir(tenantId: string): Promise<string> {
    const dir = this.workdir(tenantId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Resolve a caller-supplied path against a tenant's workdir and prove it stays inside.
   *
   * `followSymlinks` is off for paths that do not exist yet — `realpath` fails on those,
   * and a write target is checked on its parent instead, which is the directory an
   * escape would have to traverse.
   */
  async resolveInWorkdir(tenantId: string, relativePath: string): Promise<string> {
    const root = await this.ensureWorkdir(tenantId);
    return this.resolveWithin(root, relativePath, tenantId);
  }

  /**
   * Resolve a folder an operator is asking to grant, and return the realpath to store.
   *
   * This is the **write** side of the grant model, and it exists because a grant is only as safe as
   * the path recorded in it. `FolderGrant.resolvedPath` is authoritative — `resolveGranted` reads it
   * rather than re-deriving it from `rootPath`, so that a symlink swapped in *after* the grant was
   * approved does not silently widen it. That guarantee only holds if the value stored at grant time
   * was a realpath, which is what this produces.
   *
   * Three refusals, each for a distinct reason:
   *
   *  - **A path that does not exist** is `NOT_FOUND`. There is no realpath to store, and storing the
   *    un-resolved path would defeat the whole point.
   *  - **A path that is not a directory** is a `VALIDATION_ERROR`. A grant on a file is a grant that
   *    every `listGranted` call fails on.
   *  - **A path outside the tenant's own workdir is *not* refused.** That is the entire purpose of a
   *    grant — reaching somewhere the sandbox cannot — and refusing it here would make the feature
   *    meaningless. What constrains it is that the grant must be created by an authenticated
   *    operator of this tenant, and that every later access re-checks containment against the
   *    stored realpath.
   */
  async canonicaliseGrantRoot(rootPath: string): Promise<string> {
    const absolute = resolve(rootPath);

    let real: string;
    try {
      real = await realpath(absolute);
    } catch {
      throw new ApiError('NOT_FOUND', 'That folder does not exist', { rootPath });
    }

    const info = await stat(real).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new ApiError('VALIDATION_ERROR', 'That path is not a folder', { rootPath });
    }

    return real;
  }

  /**
   * Resolve against an arbitrary granted root. The caller is responsible for having
   * checked the grant; this only enforces containment.
   */
  async resolveInGrant(
    tenantId: string,
    grant: FolderGrantRecord,
    relativePath: string,
  ): Promise<string> {
    return this.resolveGranted(tenantId, grant, relativePath, 'read');
  }

  /**
   * Read a file inside an approved folder grant.
   *
   * This is the method the engine's file tools call. Without it, `resolveInGrant` would
   * hand back an absolute path that only `node:fs` could open — i.e. the path jail would
   * be bypassed by the very caller it exists to constrain.
   */
  async readGrantedFile(
    tenantId: string,
    grant: FolderGrantRecord,
    relativePath: string,
    options: { maxBytes?: number } = {},
  ): Promise<Buffer> {
    const path = await this.resolveGranted(tenantId, grant, relativePath, 'read');
    const info = await stat(path).catch(() => null);

    if (info === null || !info.isFile()) {
      throw new ApiError('NOT_FOUND', 'File not found', { path: relativePath });
    }
    if (options.maxBytes !== undefined && info.size > options.maxBytes) {
      throw new ApiError('VALIDATION_ERROR', 'File exceeds the permitted size', {
        sizeBytes: info.size,
        maxBytes: options.maxBytes,
      });
    }

    return readFile(path);
  }

  async writeGrantedFile(
    tenantId: string,
    grant: FolderGrantRecord,
    relativePath: string,
    data: Buffer | string,
  ): Promise<string> {
    const path = await this.resolveGranted(tenantId, grant, relativePath, 'write');
    await writeFile(path, data);
    return path;
  }

  async listGranted(
    tenantId: string,
    grant: FolderGrantRecord,
    relativePath = '.',
  ): Promise<FileEntry[]> {
    const dir = await this.resolveGranted(tenantId, grant, relativePath, 'read');
    const root = await this.canonicalise(grant.resolvedPath);
    const entries = await readdir(dir, { withFileTypes: true });

    return Promise.all(
      entries.map(async (entry) => {
        const full = join(dir, entry.name);
        const info = await stat(full);
        return {
          name: entry.name,
          // Relative to the grant root, so a caller never receives the host layout.
          path: relative(root, full).split(sep).join('/'),
          kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
          sizeBytes: info.size,
          modifiedAt: info.mtime,
        };
      }),
    );
  }

  /** True when `target` is inside the grant and the grant permits the requested access. */
  async checkAccess(
    tenantId: string,
    grant: FolderGrantRecord,
    target: string,
  ): Promise<FileAccess> {
    const root = await this.canonicalise(grant.resolvedPath);
    const inside = target === root || target.startsWith(root + sep);

    if (!inside) {
      this.logger.warn({ tenantId, target }, 'path escapes its folder grant');
      return { read: false, write: false };
    }

    return { read: grant.read, write: grant.write };
  }

  async readFile(tenantId: string, relativePath: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
    const path = await this.resolveInWorkdir(tenantId, relativePath);
    const info = await stat(path).catch(() => null);

    if (info === null || !info.isFile()) {
      throw new ApiError('NOT_FOUND', 'File not found', { path: relativePath });
    }
    if (options.maxBytes !== undefined && info.size > options.maxBytes) {
      throw new ApiError('VALIDATION_ERROR', 'File exceeds the permitted size', {
        sizeBytes: info.size,
        maxBytes: options.maxBytes,
      });
    }

    return readFile(path);
  }

  async writeFile(tenantId: string, relativePath: string, data: Buffer | string): Promise<string> {
    const path = await this.resolveInWorkdir(tenantId, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return path;
  }

  async list(tenantId: string, relativePath = '.'): Promise<FileEntry[]> {
    const dir = await this.resolveInWorkdir(tenantId, relativePath);
    const entries = await readdir(dir, { withFileTypes: true });

    return Promise.all(
      entries.map(async (entry) => {
        const full = join(dir, entry.name);
        const info = await stat(full);
        return {
          name: entry.name,
          // Reported relative to the workdir so a caller never receives an absolute
          // host path — that is the kind of leak that turns into a directory traversal.
          path: relative(this.workdir(tenantId), full).split(sep).join('/'),
          kind: entry.isDirectory() ? ('directory' as const) : ('file' as const),
          sizeBytes: info.size,
          modifiedAt: info.mtime,
        };
      }),
    );
  }

  async delete(tenantId: string, relativePath: string): Promise<boolean> {
    const path = await this.resolveInWorkdir(tenantId, relativePath);

    // Refusing to delete the workdir itself keeps a single call from wiping a tenant's
    // whole sandbox; that is a separate, deliberate operation.
    if (path === this.workdir(tenantId)) {
      throw new ApiError('VALIDATION_ERROR', 'Refusing to delete the tenant workdir itself');
    }

    const info = await stat(path).catch(() => null);
    if (info === null) return false;

    await rm(path, { recursive: info.isDirectory(), force: true });
    return true;
  }

  /** Used by the orphan-cleanup job (Phase 12). */
  async removeWorkdir(tenantId: string): Promise<void> {
    await rm(this.workdir(tenantId), { recursive: true, force: true });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Resolve inside a grant and enforce the grant's own permissions.
   *
   * The stored `resolvedPath` is authoritative: re-deriving it from `rootPath` would
   * silently follow a symlink that was swapped in after the grant was approved.
   */
  private async resolveGranted(
    tenantId: string,
    grant: FolderGrantRecord,
    relativePath: string,
    need: 'read' | 'write',
  ): Promise<string> {
    const root = await this.canonicalise(grant.resolvedPath);
    const target = await this.resolveWithin(root, relativePath, tenantId);

    const access = await this.checkAccess(tenantId, grant, target);
    if (need === 'read' && !access.read) {
      throw new ApiError('FORBIDDEN', 'Read access is not granted for this folder', {
        path: relativePath,
      });
    }
    if (need === 'write' && !access.write) {
      throw new ApiError('FORBIDDEN', 'Write access is not granted for this folder', {
        path: relativePath,
      });
    }

    return target;
  }

  private async resolveWithin(root: string, relativePath: string, tenantId: string): Promise<string> {
    const canonicalRoot = await this.canonicalise(root);
    const candidate = resolve(canonicalRoot, relativePath);

    // The prefix check happens on the *resolved* path. A string test on the input would
    // miss `foo/../../etc`, and a check before `realpath` would miss a symlinked parent.
    if (candidate !== canonicalRoot && !candidate.startsWith(canonicalRoot + sep)) {
      this.logger.warn({ tenantId, relativePath }, 'path traversal attempt blocked');
      throw new ApiError('FORBIDDEN', 'Path escapes the permitted directory', {
        path: relativePath,
      });
    }

    // Re-check through symlinks for the part that already exists. Without this, a
    // symlink created *inside* the root would still pass the prefix test above.
    const existing = await this.existingAncestor(candidate);
    if (existing !== null) {
      const realExisting = await realpath(existing);
      if (realExisting !== canonicalRoot && !realExisting.startsWith(canonicalRoot + sep)) {
        this.logger.warn({ tenantId, relativePath, realExisting }, 'symlink escape blocked');
        throw new ApiError('FORBIDDEN', 'Path escapes the permitted directory via a symlink', {
          path: relativePath,
        });
      }
    }

    return candidate;
  }

  /** The deepest ancestor of `path` that exists, or null when nothing does. */
  private async existingAncestor(path: string): Promise<string | null> {
    let current = path;
    for (;;) {
      const info = await stat(current).catch(() => null);
      if (info !== null) return current;

      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  /** `realpath` for a directory that must exist, with a clear error when it does not. */
  private async canonicalise(path: string): Promise<string> {
    try {
      return await realpath(resolve(path));
    } catch {
      throw new ApiError('NOT_FOUND', 'Directory does not exist', { path });
    }
  }
}

/** Reject anything that could act as a path segment rather than an identifier. */
function assertSafeSegment(value: string, label: string): void {
  if (value.length === 0 || value.includes('/') || value.includes('\\') || value.includes('..')) {
    throw new ApiError('VALIDATION_ERROR', `${label} contains unsupported characters`);
  }
}
