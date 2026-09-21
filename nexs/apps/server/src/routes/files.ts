import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { ApiError, createFolderGrantSchema, uploadAttachmentSchema } from '@nexs/shared';
import { validateBody } from '../http/middleware/validate.js';
import type { FilesController } from '../controllers/files.controller.js';

export interface FilesRouterDeps {
  controller: FilesController;
  authRequired: RequestHandler;
  /** The same ceiling the service enforces, applied here so an oversized body is never buffered. */
  maxUploadBytes: number;
}

export function createFilesRouter(deps: FilesRouterDeps): Router {
  const router = Router();
  const { controller } = deps;

  /**
   * Uploads are buffered in memory, not written to a temp file.
   *
   * `diskStorage` would put the bytes somewhere before the tenant is known and before the size
   * ceiling has been applied by anything but multer itself — a temp directory full of untrusted
   * files is a second thing to clean up and a second thing to get wrong. With `memoryStorage` the
   * buffer goes straight to `FileService.writeFile`, which is the only module allowed to touch the
   * filesystem, so there is exactly one place a file is created.
   *
   * `limits.fileSize` is the same number the service checks. Both are needed: multer's stops an
   * oversized body being buffered at all, and the service's is the one that holds when the service
   * is called from somewhere that is not this route.
   */
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: deps.maxUploadBytes, files: 1 },
  });

  /**
   * Translate multer's errors into the API's vocabulary.
   *
   * Without this, an oversized upload surfaces as a `MulterError` that the generic error handler
   * renders as a 500 — an operator whose file is too big would be told the server broke. Only the
   * two codes a caller can act on are translated; anything else is a genuine fault and is passed
   * through to be logged as one.
   */
  const uploadSingle: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err === undefined || err === null) {
        next();
        return;
      }

      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(
            new ApiError('VALIDATION_ERROR', 'The uploaded file exceeds the permitted size', {
              maxBytes: deps.maxUploadBytes,
            }),
          );
          return;
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE') {
          next(
            new ApiError('VALIDATION_ERROR', 'Send exactly one file, under the field name "file"', {
              field: 'file',
              code: err.code,
            }),
          );
          return;
        }
      }

      next(err);
    });
  };

  router.use(deps.authRequired);

  router.get('/', controller.list);
  router.post('/', uploadSingle, validateBody(uploadAttachmentSchema), controller.upload);

  /**
   * `/grants` is declared before `/:id`, and that ordering is load-bearing.
   *
   * Express matches in declaration order, so a later `GET /:id` would capture `grants` as an
   * attachment id and every grants listing would 404 with "the attachment does not exist". The same
   * trap `routes/memory.ts` documents for `/search` and `routes/notifications.ts` for
   * `/unread-count` — this is the third instance, which is why it is called out rather than assumed.
   */
  router.get('/grants', controller.listGrants);
  router.post('/grants', validateBody(createFolderGrantSchema), controller.createGrant);

  // Two segments, so these cannot collide with `/:id` — but they are still declared with the other
  // grant routes so the whole `/grants` surface reads as one block.
  router.get('/grants/:id/entries', controller.listGrantEntries);
  router.get('/grants/:id/file', controller.readGranted);
  router.delete('/grants/:id', controller.removeGrant);

  router.get('/:id', controller.get);
  router.get('/:id/preview', controller.preview);
  router.delete('/:id', controller.remove);

  return router;
}
