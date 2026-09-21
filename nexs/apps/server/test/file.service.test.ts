import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiError } from '@nexs/shared';
import { FileService } from '../src/services/files/file.service.js';

/**
 * The tenant filesystem jail.
 *
 * `FileService` is the only module that hands a path to `node:fs`, so these are the tests
 * that stand between an HTTP-supplied path and arbitrary disk access. The interesting
 * cases are not `../` (which any implementation blocks) but symlinks — a link created
 * *inside* the permitted root that points outside it defeats every string comparison.
 */

const logger = pino({ level: 'silent' });

let root: string;
let outside: string;
let files: FileService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexs-files-'));
  outside = await mkdtemp(join(tmpdir(), 'nexs-outside-'));
  files = new FileService({ root, logger });
});

afterEach(async () => {
  // Best-effort, deliberately. A cleanup failure must never be reported as a test failure:
  // under a sandbox whose deletes route through a bulk-delete guard, a refused `rm` here
  // would turn a passing assertion into a red test and the real signal would be lost. Each
  // test gets a fresh `mkdtemp`, so a leaked directory cannot contaminate the next one.
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
  await rm(outside, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * Which symlink flavour this machine actually lets an unelevated process create, or `null`.
 *
 * Two deliberate choices, both learned the hard way.
 *
 * **It returns the link type, not a boolean.** The tests below must create the *same* kind
 * of link the probe proved, because `'junction'` is Windows-only: on Linux, passing it to
 * `symlink` throws `EINVAL`. A boolean probe plus a hard-coded `'junction'` in the tests
 * means the symlink-escape coverage fails on macOS and Linux — and a security test that
 * fails on a platform is a security test that gets deleted from that platform.
 *
 * **It runs lazily, inside the first test that needs it.** A probe at module scope runs
 * during *collection*, so if its cleanup throws, the module never finishes loading and the
 * whole file is reported as a failed suite — every test in it silently never runs. The
 * cleanup below is therefore also non-fatal and non-recursive: a recursive walk of a tree
 * containing a reparse point is exactly what a delete guard is most likely to refuse, and a
 * skipped test is a survivable outcome where a lost file is not.
 */
let probedLinkType: 'junction' | 'dir' | null | undefined;

async function symlinkType(): Promise<'junction' | 'dir' | null> {
  if (probedLinkType !== undefined) return probedLinkType;

  const probeRoot = await mkdtemp(join(tmpdir(), 'nexs-symlink-probe-'));
  const target = join(probeRoot, 'target');
  const link = join(probeRoot, 'link');
  // `junction` is the link type Windows allows without elevation; POSIX has only one.
  const candidate = process.platform === 'win32' ? 'junction' : 'dir';

  try {
    await mkdir(target, { recursive: true });
    await symlink(target, link, candidate);
    probedLinkType = candidate;
  } catch {
    probedLinkType = null;
  } finally {
    // Three single-entry removals rather than one recursive walk. Each is individually
    // ignored so that a refused delete degrades to a skipped test, never a broken suite.
    await rm(link, { force: true }).catch(() => undefined);
    await rmdir(target).catch(() => undefined);
    await rmdir(probeRoot).catch(() => undefined);
  }

  return probedLinkType;
}

// ── workdirs ──────────────────────────────────────────────────────────────────

describe('workdirs', () => {
  it('gives each tenant its own directory', async () => {
    const a = await files.ensureWorkdir('t1');
    const b = await files.ensureWorkdir('t2');

    expect(a).not.toBe(b);
    expect(a.endsWith(join('tenants', 't1'))).toBe(true);
  });

  it('is created on first use, so startup does not need every tenant', async () => {
    const dir = await files.ensureWorkdir('brand-new');
    await expect(writeFile(join(dir, 'probe'), 'x')).resolves.toBeUndefined();
  });

  it('rejects a tenant id that could act as a path', () => {
    for (const bad of ['../escape', 'a/b', 'a\\b', '..', '']) {
      expect(() => files.workdir(bad), bad).toThrow();
    }
  });
});

// ── reading and writing ───────────────────────────────────────────────────────

describe('read and write', () => {
  it('round-trips a file', async () => {
    await files.writeFile('t1', 'notes/todo.md', 'buy milk');
    expect((await files.readFile('t1', 'notes/todo.md')).toString('utf8')).toBe('buy milk');
  });

  it('refuses to read past a byte cap', async () => {
    await files.writeFile('t1', 'big.txt', 'x'.repeat(1_000));

    const error = (await files
      .readFile('t1', 'big.txt', { maxBytes: 100 })
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toMatchObject({ sizeBytes: 1_000, maxBytes: 100 });
  });

  it('reports a missing file as NOT_FOUND', async () => {
    const error = (await files.readFile('t1', 'nope.txt').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('NOT_FOUND');
  });

  it('refuses to read a directory as a file', async () => {
    await files.ensureWorkdir('t1');
    await files.writeFile('t1', 'dir/child.txt', 'x');

    const error = (await files.readFile('t1', 'dir').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('NOT_FOUND');
  });

  it('keeps tenants apart', async () => {
    await files.writeFile('t1', 'shared.txt', 'tenant one');
    await files.writeFile('t2', 'shared.txt', 'tenant two');

    expect((await files.readFile('t1', 'shared.txt')).toString()).toBe('tenant one');
    expect((await files.readFile('t2', 'shared.txt')).toString()).toBe('tenant two');
  });
});

// ── the jail ──────────────────────────────────────────────────────────────────

describe('path traversal', () => {
  it('blocks a relative escape', async () => {
    const error = (await files
      .writeFile('t1', '../escaped.txt', 'x')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('FORBIDDEN');
  });

  it('blocks an escape buried in the middle of a path', async () => {
    const error = (await files
      .writeFile('t1', 'a/b/../../../escaped.txt', 'x')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('FORBIDDEN');
  });

  it('blocks an absolute path', async () => {
    const target = join(outside, 'absolute.txt');

    // `path.resolve(root, '/x')` yields `/x`, which is outside the root — the same check
    // that stops `../` stops this.
    const error = (await files.writeFile('t1', target, 'x').catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('FORBIDDEN');
  });

  it('blocks a sibling tenant', async () => {
    await files.writeFile('t2', 'secret.txt', 'not yours');

    const error = (await files
      .readFile('t1', '../t2/secret.txt')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('FORBIDDEN');
  });

  it('allows a benign path that merely contains dots', async () => {
    // `.env` and `a..b` are legitimate names; only whole `..` segments are traversal.
    await files.writeFile('t1', '.env', 'SECRET=1');
    await files.writeFile('t1', 'a..b', 'x');

    expect((await files.readFile('t1', '.env')).toString()).toBe('SECRET=1');
    expect((await files.readFile('t1', 'a..b')).toString()).toBe('x');
  });

  it('blocks a symlink that points outside the workdir', async (ctx) => {
    const type = await symlinkType();
    if (type === null) return ctx.skip();

    // The case a prefix comparison cannot catch: the key is innocent, the *resolved*
    // path is not.
    await writeFile(join(outside, 'target.txt'), 'outside data');
    const workdir = await files.ensureWorkdir('t1');
    await symlink(outside, join(workdir, 'escape'), type);

    const error = (await files
      .readFile('t1', 'escape/target.txt')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('FORBIDDEN');
  });

  it('blocks a symlink created in a parent directory', async (ctx) => {
    const type = await symlinkType();
    if (type === null) return ctx.skip();

    await writeFile(join(outside, 'target.txt'), 'outside data');
    const workdir = await files.ensureWorkdir('t1');
    await symlink(outside, join(workdir, 'link'), type);

    const error = (await files
      .writeFile('t1', 'link/new.txt', 'x')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('FORBIDDEN');
  });
});

// ── listing ───────────────────────────────────────────────────────────────────

describe('list', () => {
  it('reports workdir-relative paths, never absolute host paths', async () => {
    await files.writeFile('t1', 'a/one.txt', 'x');
    await files.writeFile('t1', 'a/two.txt', 'yy');

    const entries = await files.list('t1', 'a');
    const names = entries.map((entry) => entry.name).sort();

    expect(names).toEqual(['one.txt', 'two.txt']);
    // A leak here would hand a caller the host layout to probe with.
    for (const entry of entries) {
      expect(entry.path.startsWith('a/')).toBe(true);
      expect(entry.path).not.toContain(root);
    }
  });

  it('distinguishes files from directories and reports sizes', async () => {
    await files.writeFile('t1', 'sub/file.txt', '12345');

    const entries = await files.list('t1');
    const sub = entries.find((entry) => entry.name === 'sub')!;
    expect(sub.kind).toBe('directory');

    const file = (await files.list('t1', 'sub')).find((entry) => entry.name === 'file.txt')!;
    expect(file.kind).toBe('file');
    expect(file.sizeBytes).toBe(5);
    expect(file.modifiedAt).toBeInstanceOf(Date);
  });

  it('lists an empty workdir without failing', async () => {
    expect(await files.list('t1')).toEqual([]);
  });
});

// ── deletion ──────────────────────────────────────────────────────────────────

describe('delete', () => {
  it('deletes a file and reports whether it existed', async () => {
    await files.writeFile('t1', 'temp.txt', 'x');

    expect(await files.delete('t1', 'temp.txt')).toBe(true);
    expect(await files.delete('t1', 'temp.txt')).toBe(false);
  });

  it('deletes a directory recursively', async () => {
    await files.writeFile('t1', 'dir/a.txt', 'x');
    await files.writeFile('t1', 'dir/nested/b.txt', 'x');

    expect(await files.delete('t1', 'dir')).toBe(true);
    expect(await files.list('t1')).toEqual([]);
  });

  it('refuses to delete the workdir itself', async () => {
    // One call must not be able to wipe a tenant's whole sandbox; that is a separate,
    // deliberate operation with its own authorisation.
    await files.ensureWorkdir('t1');

    const error = (await files.delete('t1', '.').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('VALIDATION_ERROR');
  });
});

// ── folder grants ─────────────────────────────────────────────────────────────

describe('folder grants', () => {
  it('reads inside a granted folder', async () => {
    await writeFile(join(outside, 'granted.txt'), 'shared');

    const grant = { rootPath: outside, resolvedPath: outside, read: true, write: false };

    expect((await files.readGrantedFile('t1', grant, 'granted.txt')).toString()).toBe('shared');
  });

  it('writes inside a granted folder when the grant allows it', async () => {
    const grant = { rootPath: outside, resolvedPath: outside, read: true, write: true };

    const path = await files.writeGrantedFile('t1', grant, 'out.txt', 'written');
    expect((await readFile(path)).toString()).toBe('written');
  });

  it('refuses a write to a read-only grant', async () => {
    const grant = { rootPath: outside, resolvedPath: outside, read: true, write: false };

    const error = (await files
      .writeGrantedFile('t1', grant, 'out.txt', 'nope')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toContain('Write access');
  });

  it('lists a granted folder relative to the grant root', async () => {
    await mkdir(join(outside, 'sub'), { recursive: true });
    await writeFile(join(outside, 'sub', 'a.txt'), 'x');

    const grant = { rootPath: outside, resolvedPath: outside, read: true, write: false };
    const entries = await files.listGranted('t1', grant, 'sub');

    expect(entries.map((entry) => entry.path)).toEqual(['sub/a.txt']);
  });

  it('refuses a path outside the granted folder', async () => {
    const grant = { rootPath: outside, resolvedPath: outside, read: true, write: false };

    const error = (await files
      .resolveInGrant('t1', grant, '../elsewhere/secret.txt')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('FORBIDDEN');
  });

  it('refuses a read-only grant for a write target', async () => {
    const grant = { rootPath: outside, resolvedPath: outside, read: true, write: false };

    const access = await files.checkAccess('t1', grant, join(outside, 'new.txt'));
    expect(access.read).toBe(true);
    // The engine checks `write` before asking the tool to write; the grant itself is the
    // only thing that knows.
    expect(access.write).toBe(false);
  });

  it('trusts the stored resolvedPath over the rootPath', async () => {
    // If `rootPath` were re-resolved at call time, swapping a symlink after approval
    // would silently widen the grant. The stored realpath is what was approved.
    const grant = {
      rootPath: '/some/original/path',
      resolvedPath: outside,
      read: true,
      write: false,
    };

    const path = await files.resolveInGrant('t1', grant, 'granted.txt');
    expect(path.startsWith(outside)).toBe(true);
  });

  it('reports a grant whose directory has since disappeared', async () => {
    const gone = join(outside, 'removed');
    const grant = { rootPath: gone, resolvedPath: gone, read: true, write: false };

    const error = (await files
      .resolveInGrant('t1', grant, 'x.txt')
      .catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('NOT_FOUND');
  });
});
