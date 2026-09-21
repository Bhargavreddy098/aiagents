import type { RequestHandler } from 'express';
import {
  listAttachmentsSchema,
  listFolderGrantsSchema,
  listGrantEntriesSchema,
  readGrantedFileSchema,
  type CreateFolderGrantInput,
  type ReadGrantedFileQuery,
  type UploadAttachmentInput,
} from '@nexs/shared';
import type { Attachment, FolderGrant } from '@prisma/client';
import { ApiError } from '@nexs/shared';
import { requireAuth } from '../http/middleware/auth.js';
import { parseQuery, pathParam } from '../http/middleware/validate.js';
import type { FilesService } from '../services/files/files.service.js';

/**
 * `/api/files` — the Files page.
 *
 * Thin by design: authenticate, parse, delegate, serialise. Every rule that could be broken — that
 * a filename cannot become a path, that a stored path is re-checked on every read, that a grant
 * permits something — lives in `FilesService`.
 *
 * The one thing this layer does own is the **serialisation shape**: `resolvedPath` is dropped from
 * every grant response. See `types/files.ts` for why that is not an oversight.
 */
export interface FilesControllerDeps {
  files: FilesService;
}

export interface FilesController {
  upload: RequestHandler;
  list: RequestHandler;
  get: RequestHandler;
  preview: RequestHandler;
  remove: RequestHandler;
  createGrant: RequestHandler;
  listGrants: RequestHandler;
  removeGrant: RequestHandler;
  listGrantEntries: RequestHandler;
  readGranted: RequestHandler;
}

function toAttachmentSummary(row: Attachment) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    path: row.path,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType,
    scope: row.scope,
    scopeId: row.scopeId,
    readAccess: row.readAccess,
    writeAccess: row.writeAccess,
    grantedToAgentId: row.grantedToAgentId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A grant, **without `resolvedPath`**.
 *
 * The field is the host path every containment check is compared against, and handing it to a
 * client gives away most of what a traversal needs. `rootPath` is what the operator typed and is
 * therefore already known to them, which is why it can be returned.
 */
function toGrantSummary(row: FolderGrant) {
  return {
    id: row.id,
    rootPath: row.rootPath,
    agentId: row.agentId,
    taskId: row.taskId,
    read: row.read,
    write: row.write,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createFilesController(deps: FilesControllerDeps): FilesController {
  return {
    /**
     * Upload one file.
     *
     * The metadata fields are parsed out of the multipart body by `validateBody`, which is why the
     * schema's fields are strings and its booleans are enumerated — a multipart body has no types.
     * See `schemas/files.ts`.
     */
    upload: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const file = req.file;

        if (file === undefined) {
          // `multer` leaves `req.file` undefined when no part named `file` was sent. Naming the
          // field is more useful than "bad request", because it is the one thing to change.
          throw new ApiError('VALIDATION_ERROR', 'No file was uploaded under the field name "file"', {
            field: 'file',
          });
        }

        const attachment = await deps.files.upload(
          tenantId,
          {
            originalname: file.originalname,
            mimetype: file.mimetype,
            buffer: file.buffer,
            size: file.size,
          },
          req.body as UploadAttachmentInput,
        );

        res.status(201).json({ attachment: toAttachmentSummary(attachment) });
      } catch (err) {
        next(err);
      }
    },

    list: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const rows = await deps.files.list(tenantId, parseQuery(listAttachmentsSchema, req));
        res.status(200).json({ attachments: rows.map(toAttachmentSummary) });
      } catch (err) {
        next(err);
      }
    },

    get: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const attachment = await deps.files.getAttachment(tenantId, pathParam(req, 'id'));
        res.status(200).json({ attachment: toAttachmentSummary(attachment) });
      } catch (err) {
        next(err);
      }
    },

    /**
     * Stream an attachment's bytes.
     *
     * The content type comes from the stored row, with a `nosniff` header so a browser cannot be
     * talked into treating an uploaded HTML file as script in this origin. An attachment store that
     * serves user content without that header is a stored-XSS vector.
     */
    preview: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const { attachment, bytes } = await deps.files.preview(tenantId, pathParam(req, 'id'));

        res.setHeader('Content-Type', attachment.mimeType ?? 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Length', String(bytes.byteLength));
        res.setHeader(
          'Content-Disposition',
          `inline; filename="${attachment.name.replace(/["\\]/g, '_')}"`,
        );
        res.status(200).end(bytes);
      } catch (err) {
        next(err);
      }
    },

    remove: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.files.removeAttachment(tenantId, pathParam(req, 'id'));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    createGrant: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const grant = await deps.files.createGrant(tenantId, req.body as CreateFolderGrantInput);
        res.status(201).json({ grant: toGrantSummary(grant) });
      } catch (err) {
        next(err);
      }
    },

    listGrants: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const rows = await deps.files.listGrants(tenantId, parseQuery(listFolderGrantsSchema, req));
        res.status(200).json({ grants: rows.map(toGrantSummary) });
      } catch (err) {
        next(err);
      }
    },

    removeGrant: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        await deps.files.removeGrant(tenantId, pathParam(req, 'id'));
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },

    listGrantEntries: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const query = parseQuery(listGrantEntriesSchema, req);
        const entries = await deps.files.listGrantedEntries(
          tenantId,
          pathParam(req, 'id'),
          query.path ?? '.',
        );

        res.status(200).json({
          entries: entries.map((entry) => ({
            name: entry.name,
            path: entry.path,
            kind: entry.kind,
            sizeBytes: entry.sizeBytes,
            modifiedAt: entry.modifiedAt.toISOString(),
          })),
        });
      } catch (err) {
        next(err);
      }
    },

    readGranted: async (req, res, next) => {
      try {
        const { tenantId } = requireAuth(req);
        const query = parseQuery(readGrantedFileSchema, req) as ReadGrantedFileQuery;
        const { bytes } = await deps.files.readGranted(tenantId, pathParam(req, 'id'), query.path);

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Length', String(bytes.byteLength));
        res.status(200).end(bytes);
      } catch (err) {
        next(err);
      }
    },
  };
}
