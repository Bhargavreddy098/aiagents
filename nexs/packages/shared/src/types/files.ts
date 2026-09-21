/**
 * The file surface, as the UI sees it.
 *
 * ## The one rule that shapes every shape in this file
 *
 * **A host path never crosses this boundary.** `FolderGrant.resolvedPath` is the realpath a grant
 * was resolved to — the absolute location on the machine, and the value every containment check is
 * compared against. Returning it would hand a client the exact string that makes a directory
 * traversal writable: knowing the root is half of escaping it. So `FolderGrantSummary` carries
 * `rootPath` (what the operator typed, which they already know) and not `resolvedPath`.
 *
 * The same reasoning makes `Attachment.path` a **workdir-relative** path rather than an absolute
 * one — it is the key the preview route reads back through `FileService`, which re-resolves and
 * re-checks containment on every access. A stored absolute path would be a second source of truth
 * about where a file lives, and the check would have nothing to compare it to.
 */

export const ATTACHMENT_KINDS = ['file', 'folder'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * What an attachment is attached *to*.
 *
 * A closed vocabulary because it decides which page the attachment appears on. An unrecognised
 * scope is an attachment nothing would ever render — present in the table, invisible in the UI.
 */
export const ATTACHMENT_SCOPES = ['chat', 'agent', 'task'] as const;
export type AttachmentScope = (typeof ATTACHMENT_SCOPES)[number];

export interface AttachmentSummary {
  id: string;
  kind: string;
  name: string;
  /** Relative to the tenant's workdir. Never an absolute host path. See the file header. */
  path: string;
  sizeBytes: number | null;
  mimeType: string | null;
  scope: string;
  scopeId: string | null;
  readAccess: boolean;
  writeAccess: boolean;
  grantedToAgentId: string | null;
  createdAt: string;
}

/**
 * An approved folder.
 *
 * `resolvedPath` is deliberately absent — see the file header. `read`/`write` are what the UI
 * renders as the permission indicator, and they come straight from the grant row rather than being
 * inferred, which is the spec's requirement.
 */
export interface FolderGrantSummary {
  id: string;
  /** What the operator typed. Not the realpath. */
  rootPath: string;
  agentId: string | null;
  taskId: string | null;
  read: boolean;
  write: boolean;
  createdAt: string;
}

/** One entry inside a granted folder, as the file browser lists it. */
export interface GrantedEntry {
  name: string;
  /** Relative to the grant's root, so the host layout is never revealed. */
  path: string;
  kind: 'file' | 'directory';
  sizeBytes: number;
  modifiedAt: string;
}
