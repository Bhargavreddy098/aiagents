import { ApiError, type CreateFolderGrantInput, type ListAttachmentsQuery, type ListFolderGrantsQuery, type UploadAttachmentInput } from '@nexs/shared';
import type { Attachment, FolderGrant } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { AttachmentRepository, FolderGrantRepository } from '../../repositories/files.repo.js';
import type { FileService } from './file.service.js';
import type { Logger } from '../../logger.js';

/**
 * `/api/files` — uploads, folder grants, and reading through a grant.
 *
 * ## What this service is responsible for, in order of how much it matters
 *
 * **1. It is the only caller of `FileService` from the HTTP layer.** `FileService` is the single
 * module allowed to hand a path to `node:fs`, and every method here goes through it. A route that
 * reached for `node:fs` directly would be the second place the path jail could be bypassed, which
 * is exactly what gap #25 exists to prevent.
 *
 * **2. A stored attachment path is relative to the workdir, and that is what makes preview safe.**
 * The path is written by the upload and read back by `FileService.readFile`, which re-resolves and
 * re-checks containment *on every access*. So a row whose path was somehow tampered with still
 * cannot read outside the tenant's directory — the check does not trust the row.
 *
 * **3. The filename a client sends never becomes a path.** `originalname` is stripped to a
 * basename and prefixed with a fresh uuid. Without that, an upload named `../../etc/passwd` would
 * be a write outside the workdir — and `basename()` alone is not enough, because two clients
 * uploading `report.pdf` would overwrite each other.
 *
 * **4. A grant with no permissions is refused.** `read: false, write: false` is a grant that
 * permits nothing and reads as "access granted" on a page. The schema cannot express the
 * cross-field rule, and the service can, so it does — the same reasoning the phase-build rules give
 * for repeating a schema's check in a service.
 */

export interface FilesServiceDeps {
  attachments: AttachmentRepository;
  grants: FolderGrantRepository;
  files: FileService;
  logger: Logger;
  /** The per-file ceiling, from config. Applied before anything is written. */
  maxUploadBytes: number;
}

/** The workdir subdirectory uploads land in, alongside `sandbox/` and whatever else appears. */
const UPLOAD_DIR = 'uploads';

export class FilesService {
  constructor(private readonly deps: FilesServiceDeps) {}

  // ── attachments ─────────────────────────────────────────────────────────────

  /**
   * Store an uploaded file.
   *
   * The bytes go to the filesystem first and the row second, which is the safe order: a failed row
   * write leaves an orphaned file (invisible, and reclaimable by the orphan sweep), whereas the
   * reverse would leave a row pointing at a file that does not exist — and every preview of it
   * would be a 404 that looks like data loss.
   */
  async upload(
    tenantId: string,
    file: { originalname: string; mimetype: string; buffer: Buffer; size: number },
    input: UploadAttachmentInput,
  ): Promise<Attachment> {
    if (file.size > this.deps.maxUploadBytes) {
      throw new ApiError('VALIDATION_ERROR', 'The uploaded file exceeds the permitted size', {
        sizeBytes: file.size,
        maxBytes: this.deps.maxUploadBytes,
      });
    }

    const safeName = sanitiseFilename(file.originalname);
    // A uuid prefix rather than a suffix: it keeps the extension intact for anything that
    // inspects it, and it makes two uploads of the same name two files rather than one overwrite.
    const relativePath = `${UPLOAD_DIR}/${randomUUID()}-${safeName}`;

    await this.deps.files.writeFile(tenantId, relativePath, file.buffer);

    return this.deps.attachments.create({
      tenantId,
      kind: 'file',
      name: safeName,
      path: relativePath,
      sizeBytes: file.size,
      mimeType: file.mimetype,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      ...(input.readAccess === undefined ? {} : { readAccess: input.readAccess }),
      ...(input.writeAccess === undefined ? {} : { writeAccess: input.writeAccess }),
      grantedToAgentId: input.grantedToAgentId ?? null,
    });
  }

  async list(tenantId: string, query: ListAttachmentsQuery): Promise<Attachment[]> {
    const rows = await this.deps.attachments.list(tenantId, {
      ...(query.scope === undefined ? {} : { scope: query.scope }),
      ...(query.scopeId === undefined ? {} : { scopeId: query.scopeId }),
    });

    const offset = query.offset ?? 0;
    const end = query.limit === undefined ? undefined : offset + query.limit;
    return rows.slice(offset, end);
  }

  async getAttachment(tenantId: string, id: string): Promise<Attachment> {
    const attachment = await this.deps.attachments.findById(tenantId, id);
    if (attachment === null) {
      throw new ApiError('NOT_FOUND', 'Attachment not found', { attachmentId: id });
    }
    return attachment;
  }

  /**
   * The bytes of an attachment, for the preview route.
   *
   * Read through `FileService.readFile`, which resolves the stored relative path against the
   * tenant's workdir and refuses anything that escapes. The row is not trusted to be safe — the
   * check is re-run on every read, which is what makes a tampered path a 403 rather than a leak.
   */
  async preview(
    tenantId: string,
    id: string,
  ): Promise<{ attachment: Attachment; bytes: Buffer }> {
    const attachment = await this.getAttachment(tenantId, id);
    const bytes = await this.deps.files.readFile(tenantId, attachment.path, {
      maxBytes: this.deps.maxUploadBytes,
    });
    return { attachment, bytes };
  }

  /**
   * Remove an attachment and its file.
   *
   * The row goes first, deliberately. `FileService.delete` returns `false` for a file that is
   * already gone, so a row-first order means a failed file delete leaves an orphan (invisible)
   * rather than a row pointing at nothing. The file delete is attempted regardless and its failure
   * is logged rather than thrown: the operator asked for the attachment to be gone, and it is.
   */
  async removeAttachment(tenantId: string, id: string): Promise<void> {
    const attachment = await this.getAttachment(tenantId, id);

    const count = await this.deps.attachments.delete(tenantId, id);
    if (count !== 1) {
      throw new ApiError('NOT_FOUND', 'Attachment not found', { attachmentId: id });
    }

    try {
      await this.deps.files.delete(tenantId, attachment.path);
    } catch (err) {
      this.deps.logger.warn(
        { attachmentId: id, path: attachment.path, err: err instanceof Error ? err.message : String(err) },
        'attachment row removed but its file could not be deleted',
      );
    }
  }

  // ── folder grants ───────────────────────────────────────────────────────────

  /**
   * Approve a folder.
   *
   * Idempotent on the resolved path: re-attaching the same folder returns the grant that already
   * exists rather than creating a second row for it. Two rows granting one folder is how an
   * operator revokes one, sees it disappear from the list, and believes the folder is closed.
   *
   * The realpath is produced by `FileService.canonicaliseGrantRoot`, which is the only place that
   * knows how a grant root is meant to be resolved — and storing a realpath is what makes the
   * later symlink check meaningful.
   */
  async createGrant(tenantId: string, input: CreateFolderGrantInput): Promise<FolderGrant> {
    const read = input.read ?? true;
    const write = input.write ?? false;

    if (!read && !write) {
      // See the class header, point 4. A grant that permits nothing is a row that reads as access.
      throw new ApiError(
        'VALIDATION_ERROR',
        'A folder grant must permit reading, writing, or both',
        { field: 'read' },
      );
    }

    const resolvedPath = await this.deps.files.canonicaliseGrantRoot(input.rootPath);

    const existing = await this.deps.grants.findByResolvedPath(tenantId, resolvedPath);
    if (existing !== null) {
      this.deps.logger.info({ grantId: existing.id }, 'folder is already granted to this tenant');
      return existing;
    }

    return this.deps.grants.create({
      tenantId,
      rootPath: input.rootPath,
      resolvedPath,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      read,
      write,
    });
  }

  async listGrants(tenantId: string, query: ListFolderGrantsQuery): Promise<FolderGrant[]> {
    return this.deps.grants.list(tenantId, {
      ...(query.agentId === undefined ? {} : { agentId: query.agentId }),
      ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
    });
  }

  async removeGrant(tenantId: string, id: string): Promise<void> {
    const count = await this.deps.grants.delete(tenantId, id);
    if (count !== 1) {
      throw new ApiError('NOT_FOUND', 'Folder grant not found', { grantId: id });
    }
    // The folder itself is untouched, obviously — revoking access must never delete what access
    // was granted to. Nothing to do beyond the row.
  }

  /**
   * List a granted folder.
   *
   * The grant is read tenant-scoped first and then handed to `FileService`, which is what enforces
   * both the containment check and the grant's own read permission. Passing the row straight
   * through without the first read would be a cross-tenant grant the moment someone guessed an id.
   */
  async listGrantedEntries(tenantId: string, grantId: string, relativePath = '.') {
    const grant = await this.requireGrant(tenantId, grantId);
    return this.deps.files.listGranted(tenantId, grant, relativePath);
  }

  /** Read one file inside a granted folder. Same two-step ownership proof as above. */
  async readGranted(tenantId: string, grantId: string, relativePath: string) {
    const grant = await this.requireGrant(tenantId, grantId);
    const bytes = await this.deps.files.readGrantedFile(tenantId, grant, relativePath, {
      maxBytes: this.deps.maxUploadBytes,
    });
    return { grant, bytes };
  }

  private async requireGrant(tenantId: string, id: string): Promise<FolderGrant> {
    const grant = await this.deps.grants.findById(tenantId, id);
    if (grant === null) {
      throw new ApiError('NOT_FOUND', 'Folder grant not found', { grantId: id });
    }
    return grant;
  }
}

/**
 * A filename safe to put in a path.
 *
 * `basename()` first, so `../../etc/passwd` becomes `passwd`; then anything that is not a letter,
 * digit, dot, dash or underscore is replaced. The second step is not paranoia — a filename with a
 * NUL or a newline is a filename that produces a confusing `fs` error much further away from the
 * request that caused it, and on Windows a name like `CON` or `AUX` is not a file at all.
 *
 * An empty result (a name that was entirely punctuation) falls back to `upload`, because a path
 * ending in `-` is a file nobody can identify in a listing.
 */
export function sanitiseFilename(original: string): string {
  const base = basename(original).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
  return base.length === 0 || base === '.' || base === '..' ? 'upload' : base;
}
