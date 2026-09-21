import type { Attachment, FolderGrant, PrismaClient } from '@prisma/client';

/**
 * Persistence for attachments and folder grants.
 *
 * ## Why these two are in one file
 *
 * They are the two halves of the same question — "what may this tenant read and write?" — and
 * they are read together on the same page. Splitting them would mean two files each documenting
 * half of the permission model.
 *
 * ## The difference between them, which is the whole point
 *
 * An `Attachment` is a file **the system already has**: it was uploaded into the tenant's workdir,
 * and its `path` is workdir-relative. A `FolderGrant` is a folder **the system may reach**: it
 * points at a location outside the workdir entirely, which is why it stores both what the operator
 * typed (`rootPath`) and what it resolved to (`resolvedPath`), and why every access through it
 * re-checks containment.
 *
 * ## On `resolvedPath` and the wire
 *
 * `resolvedPath` is read by `FileService` on every granted access and is **never** put on a
 * response — see `types/files.ts`. It is the host path, and knowing it is most of what a traversal
 * needs.
 */

export interface AttachmentCreateInput {
  tenantId: string;
  kind: string;
  name: string;
  path: string;
  sizeBytes?: number | null;
  mimeType?: string | null;
  scope: string;
  scopeId?: string | null;
  readAccess?: boolean;
  writeAccess?: boolean;
  grantedToAgentId?: string | null;
}

export class AttachmentRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: AttachmentCreateInput): Promise<Attachment> {
    return this.db.attachment.create({ data });
  }

  /** Tenant-scoped: the tenant is the first argument and is always in the where. */
  async findById(tenantId: string, id: string): Promise<Attachment | null> {
    return this.db.attachment.findFirst({ where: { id, tenantId } });
  }

  /**
   * The tenant's attachments, newest first.
   *
   * `scopeId` without a `scope` is accepted and filtered on alone — an operator looking for
   * everything attached to one agent should not have to remember that it is the `agent` scope.
   */
  async list(
    tenantId: string,
    filters: { scope?: string; scopeId?: string } = {},
  ): Promise<Attachment[]> {
    return this.db.attachment.findMany({
      where: {
        tenantId,
        ...(filters.scope === undefined ? {} : { scope: filters.scope }),
        ...(filters.scopeId === undefined ? {} : { scopeId: filters.scopeId }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async delete(tenantId: string, id: string): Promise<number> {
    const { count } = await this.db.attachment.deleteMany({ where: { id, tenantId } });
    return count;
  }
}

export interface FolderGrantCreateInput {
  tenantId: string;
  rootPath: string;
  /** The realpath. Read by `FileService`, never returned. */
  resolvedPath: string;
  agentId?: string | null;
  taskId?: string | null;
  read?: boolean;
  write?: boolean;
}

export class FolderGrantRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: FolderGrantCreateInput): Promise<FolderGrant> {
    return this.db.folderGrant.create({ data });
  }

  /** Tenant-scoped: the tenant is the first argument and is always in the where. */
  async findById(tenantId: string, id: string): Promise<FolderGrant | null> {
    return this.db.folderGrant.findFirst({ where: { id, tenantId } });
  }

  async list(
    tenantId: string,
    filters: { agentId?: string; taskId?: string } = {},
  ): Promise<FolderGrant[]> {
    return this.db.folderGrant.findMany({
      where: {
        tenantId,
        ...(filters.agentId === undefined ? {} : { agentId: filters.agentId }),
        ...(filters.taskId === undefined ? {} : { taskId: filters.taskId }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The same folder, already granted to this tenant.
   *
   * Used to make attaching a folder idempotent: re-attaching the same path should return the grant
   * that already exists rather than creating a second row that grants the same thing. Two rows for
   * one folder is how an operator revokes one of them and believes the folder is closed.
   */
  async findByResolvedPath(
    tenantId: string,
    resolvedPath: string,
  ): Promise<FolderGrant | null> {
    return this.db.folderGrant.findFirst({ where: { tenantId, resolvedPath } });
  }

  async delete(tenantId: string, id: string): Promise<number> {
    const { count } = await this.db.folderGrant.deleteMany({ where: { id, tenantId } });
    return count;
  }
}
