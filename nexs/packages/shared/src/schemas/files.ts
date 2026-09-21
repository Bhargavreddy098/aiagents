import { z } from 'zod';
import { ATTACHMENT_SCOPES } from '../types/files.js';

/**
 * File and folder-grant input schemas.
 *
 * ## Why the upload schema's fields are strings
 *
 * An upload is `multipart/form-data`, and a multipart body has no types — every non-file field
 * arrives as a string. `z.boolean()` would therefore reject `'true'`, and `z.coerce.boolean()`
 * would accept `'false'` as `true`. So booleans are enumerated and transformed, exactly as the
 * query-string helper does elsewhere, and the reason is stated here because it looks like a
 * mistake otherwise.
 *
 * ## Why a grant's root is a path and not a URL
 *
 * `rootPath` is a filesystem path, so it is a plain non-empty string — `httpUrl` and the `url()`
 * check would both reject a legitimate one. What keeps it safe is not a pattern here but
 * `FileService`, which resolves it to a realpath and refuses a symlink that escapes. A regex
 * pretending to validate a path would be theatre; the realpath check is the actual control.
 */

const id = z.string().trim().min(1);

/**
 * A multipart boolean.
 *
 * Absent means "not specified", which is different from `false` — the service applies the column
 * default for an absent value and the explicit one for a present value.
 */
const formBoolean = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === 'true'));

/**
 * The upload's non-file fields.
 *
 * `scope` is required, because the column decides which page renders the attachment and a row
 * with a guess in it would be one nobody can find. `scopeId` is optional but *should* be supplied
 * for `agent` and `task` scopes; the service cannot enforce that without knowing whether the id
 * names a real row, so it is stated in the service's documentation instead of faked here.
 */
export const uploadAttachmentSchema = z
  .object({
    scope: z.enum(ATTACHMENT_SCOPES),
    scopeId: z.string().trim().min(1).max(200).optional(),
    readAccess: formBoolean,
    writeAccess: formBoolean,
    grantedToAgentId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const listAttachmentsSchema = z
  .object({
    scope: z.enum(ATTACHMENT_SCOPES).optional(),
    scopeId: id.optional(),
    limit: z.coerce.number().int().positive().max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/**
 * Attaching a folder.
 *
 * `read` defaults to true and `write` to false on the column, and the service leaves an absent
 * value to the database rather than restating the default here — a default that exists in two
 * places is a default that can disagree with itself.
 *
 * A grant with neither permission is refused by the service rather than by this schema: it is a
 * cross-field rule, and the service is reachable without the schema.
 */
export const createFolderGrantSchema = z
  .object({
    rootPath: z.string().trim().min(1).max(4096),
    agentId: z.string().trim().min(1).max(200).nullable().optional(),
    taskId: z.string().trim().min(1).max(200).nullable().optional(),
    read: z.boolean().optional(),
    write: z.boolean().optional(),
  })
  .strict();

export const listFolderGrantsSchema = z
  .object({
    agentId: id.optional(),
    taskId: id.optional(),
  })
  .strict();

export const listGrantEntriesSchema = z
  .object({
    path: z.string().trim().max(2048).optional(),
  })
  .strict();

export const readGrantedFileSchema = z
  .object({
    path: z.string().trim().min(1).max(2048),
  })
  .strict();

export type UploadAttachmentInput = z.infer<typeof uploadAttachmentSchema>;
export type ListAttachmentsQuery = z.infer<typeof listAttachmentsSchema>;
export type CreateFolderGrantInput = z.infer<typeof createFolderGrantSchema>;
export type ListFolderGrantsQuery = z.infer<typeof listFolderGrantsSchema>;
export type ListGrantEntriesQuery = z.infer<typeof listGrantEntriesSchema>;
export type ReadGrantedFileQuery = z.infer<typeof readGrantedFileSchema>;
